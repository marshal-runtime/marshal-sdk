// Lifted from packages/speech/src/providers/google.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import { SPEECH_MAX_TEXT_CHARS, validateTtsSettings, type GoogleSpeechConfig } from "../config.js";
import { ffmpegConverter } from "../convert.js";
import { downloadGcs } from "../gcs.js";
import { adcTokenProvider, failFromResponse, timedFetch, type FetchLike, type TokenProvider } from "../http.js";
import { bcp47, detectTextLanguage, shortLanguage } from "../language.js";
import { assertWhatsAppVoice, concatOggOpus, inspectOggOpus, splitOggOpus } from "../ogg.js";
import { speakableWithinLimit } from "../speakable.js";
import { joinOverlappingTranscripts, mapLimit, splitForSpeech } from "../text.js";
import {
  SpeechError,
  type SpeechProvider,
  type SynthesizeInput,
  type SynthesizeResult,
  type TranscribeInput,
  type TranscribeResult,
} from "../types.js";

const DEFAULT_PROJECT = "zyg-ecom-zygstinct";
/** Synchronous recognize takes up to about a minute of audio and 10 MB inline. */
const SYNC_MAX_SECONDS = 55;
const SYNC_MAX_BYTES = 9_000_000;
const MAX_AUDIO_BYTES = 100_000_000;
/** Longer notes are refused. Chunked recognition handles 5 minutes in about 6 s, but nobody dictates 15 minutes to a shop assistant. */
const DEFAULT_MAX_AUDIO_SEC = 15 * 60;
const CHUNK_SECONDS = 50;
const CHUNK_OVERLAP_SECONDS = 3;
const STT_CONCURRENCY = 6;
const DEFAULT_LANGUAGES = ["he", "en"];
/** A chunk at least this long that comes back empty is retried once. */
const EMPTY_RETRY_MIN_SEC = 8;
const PROBE_SECONDS = 10;
/** One request stays well under the 4,000-byte Gemini limit and under about 30 s of audio. */
const CHUNK_CHARS = 250;
const CHUNK_CONCURRENCY = 4;
const STT_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 40_000;

type RecognizeResult = { alternatives?: { transcript?: string }[]; languageCode?: string };

export class GoogleSpeechProvider implements SpeechProvider {
  readonly name = "google" as const;
  private readonly project: string;
  private readonly token: TokenProvider;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: GoogleSpeechConfig = {},
    fetchImpl?: FetchLike,
  ) {
    validateTtsSettings(config);
    this.project = config.project ?? DEFAULT_PROJECT;
    this.token = config.getAccessToken ?? adcTokenProvider();
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** Reads a gs:// object with this provider's credentials. */
  download(uri: string): Promise<Buffer> {
    return downloadGcs(uri, this.token, this.fetchImpl, MAX_AUDIO_BYTES);
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.token()}`,
      "content-type": "application/json",
    };
    if (this.config.userProject) headers["x-goog-user-project"] = this.config.userProject;
    return headers;
  }

  private sttBase(): string {
    const location = this.config.sttLocation ?? "us";
    const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
    return `https://${host}/v2/projects/${this.project}/locations/${location}`;
  }

  private recognitionConfig(hints: string[] | undefined) {
    // Chirp 3 language auto-detection silently returned an empty result for one 50 s chunk of a Hebrew note,
    // losing about 90 words. Explicit candidate languages never did, so they are the default.
    const wanted = hints?.length ? hints : (this.config.defaultLanguages ?? DEFAULT_LANGUAGES);
    const model = this.config.sttModel ?? "chirp_3";
    const codes = wanted.map((code) => sttLanguageCode(code, model));
    return {
      autoDecodingConfig: {},
      languageCodes: codes,
      model,
      features: { enableAutomaticPunctuation: true },
    };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const uri = typeof input.audio === "string" ? input.audio : undefined;
    let buffer = uri ? await downloadGcs(uri, this.token, this.fetchImpl, MAX_AUDIO_BYTES) : (input.audio as Buffer);
    if (buffer.length === 0) throw new SpeechError("bad-request", "audio is empty");
    const maxSec = this.config.maxAudioSec ?? DEFAULT_MAX_AUDIO_SEC;
    const candidates = input.languageHints?.length ? input.languageHints : (this.config.defaultLanguages ?? DEFAULT_LANGUAGES);

    let durationSec = opusDuration(buffer);
    if (durationSec === undefined) {
      // Not Ogg Opus: any other audio file, or a video. Convert its first audio track to mono 16 kHz Ogg Opus.
      let converted: Buffer | null;
      try {
        converted = await (this.config.convert ?? ffmpegConverter)(buffer, { ffmpegPath: this.config.ffmpegPath, maxSeconds: maxSec + 5 });
      } catch (error) {
        if (error instanceof SpeechError && error.code === "not-configured" && buffer.length <= SYNC_MAX_BYTES) {
          // No ffmpeg: Google can still decode a small mp3, wav, flac or amr file directly.
          const results = await this.syncRecognize(buffer, candidates);
          return { text: transcriptOf(results), language: dominantLanguage(results, candidates), durationSec: 0, provider: "google" };
        }
        throw error;
      }
      if (converted === null) return { text: "", language: "und", durationSec: 0, provider: "google" };
      buffer = converted;
      durationSec = opusDuration(buffer);
      if (durationSec === undefined) throw new SpeechError("unsupported-audio", "conversion did not produce Ogg Opus");
    }
    if (durationSec > maxSec) throw new SpeechError("audio-too-large", `audio is ${Math.round(durationSec)} s, limit ${maxSec} s`);
    if (durationSec < 0.2) return { text: "", language: "und", durationSec, provider: "google" };

    // With several candidate languages Chirp 3 sometimes drops words, and a wrong single language returns nothing.
    // A short probe picks the language, then the whole note is recognized with that one language.
    const probed = candidates.length > 1 && durationSec > PROBE_SECONDS ? await this.probeLanguage(buffer, candidates) : undefined;
    const languages = probed ? [probed] : candidates;
    if (durationSec <= SYNC_MAX_SECONDS && buffer.length <= SYNC_MAX_BYTES) {
      const results = await this.syncRecognizeWithRetry(buffer, languages, candidates, durationSec);
      return { text: transcriptOf(results), language: dominantLanguage(results, languages), durationSec, provider: "google" };
    }
    // Longer audio: cut into 50 s pieces and recognize them in parallel. Batch recognition is 3 to 5 times slower, and
    // Chirp 3 can loop on long files.
    const chunks = splitOggOpus(buffer, CHUNK_SECONDS, CHUNK_OVERLAP_SECONDS);
    const parts = await mapLimit(chunks, STT_CONCURRENCY, (chunk) => this.syncRecognizeWithRetry(chunk.audio, languages, candidates, chunk.durationSec));
    const text = joinOverlappingTranscripts(parts.map((part) => transcriptOf(part)));
    return { text, language: dominantLanguage(parts.flat(), languages), durationSec, provider: "google" };
  }

  /** Recognizes the first seconds with all candidates and returns the candidate Google heard, if any. */
  private async probeLanguage(buffer: Buffer, candidates: string[]): Promise<string | undefined> {
    if (candidates.includes("auto")) return undefined;
    try {
      const clip = splitOggOpus(buffer, PROBE_SECONDS, 1)[0];
      if (!clip) return undefined;
      const results = await this.syncRecognize(clip.audio, candidates);
      if (transcriptOf(results) === "") return undefined;
      const heard = shortLanguage(results.find((r) => r.languageCode)?.languageCode);
      return candidates.find((c) => shortLanguage(c) === heard);
    } catch {
      return undefined;
    }
  }

  /** Retries once on a server error, a timeout, or an empty answer for audio that should have speech. */
  private async syncRecognizeWithRetry(audio: Buffer, languages: string[], fallback: string[], durationSec: number): Promise<RecognizeResult[]> {
    try {
      const results = await this.syncRecognize(audio, languages);
      if (transcriptOf(results) === "" && durationSec >= EMPTY_RETRY_MIN_SEC) return await this.syncRecognize(audio, fallback);
      return results;
    } catch (error) {
      const retryable =
        error instanceof SpeechError && (error.code === "timeout" || (error.code === "provider-error" && (error.status === 429 || (error.status ?? 0) >= 500)));
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return this.syncRecognize(audio, languages);
    }
  }

  private async syncRecognize(buffer: Buffer, languages: string[]): Promise<RecognizeResult[]> {
    const res = await timedFetch(
      this.fetchImpl,
      `${this.sttBase()}/recognizers/_:recognize`,
      {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify({ config: this.recognitionConfig(languages), content: buffer.toString("base64") }),
      },
      STT_TIMEOUT_MS,
      "Speech-to-Text recognize",
    );
    if (!res.ok) return failFromResponse(res, "Speech-to-Text recognize");
    const body = (await res.json()) as { results?: RecognizeResult[] };
    return body.results ?? [];
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const language = bcp47(input.language ?? detectTextLanguage(input.text.trim()));
    const spoken = speakableWithinLimit(input.text, language, this.config.maxTextChars ?? SPEECH_MAX_TEXT_CHARS);
    // Gemini TTS time grows with length and stalls past about a minute of audio, so synthesize short chunks in parallel.
    const chunks = splitForSpeech(spoken, this.config.ttsChunkChars ?? CHUNK_CHARS);
    const parts = await mapLimit(chunks, CHUNK_CONCURRENCY, (chunk) => this.synthesizeChunk(chunk, language, input.voice));
    const audio = concatOggOpus(parts);
    const info = assertWhatsAppVoice(audio);
    return { audio, mimeType: "audio/ogg", durationSec: info.durationSec, provider: "google" };
  }

  private async synthesizeChunk(text: string, language: string, voice: string | undefined): Promise<Buffer> {
    try {
      return await this.requestChunk(text, language, voice);
    } catch (error) {
      const retryable = error instanceof SpeechError && (error.code === "timeout" || (error.code === "provider-error" && (error.status ?? 500) >= 500));
      if (!retryable) throw error;
      return this.requestChunk(text, language, voice);
    }
  }

  private async requestChunk(text: string, language: string, voice: string | undefined): Promise<Buffer> {
    const engine = this.config.ttsEngine ?? "gemini";
    const voiceName = voice ?? this.config.ttsVoice ?? "Kore";
    const rate = this.config.ttsSpeakingRate;
    const body =
      engine === "gemini"
        ? {
            input: { text, ...(this.config.ttsStylePrompt ? { prompt: this.config.ttsStylePrompt } : {}) },
            voice: { languageCode: language, name: voiceName, modelName: this.config.geminiModel ?? "gemini-2.5-flash-tts" },
            audioConfig: { audioEncoding: "OGG_OPUS", ...(rate ? { speakingRate: rate } : {}) },
          }
        : {
            input: { text },
            voice: { languageCode: language, name: voiceName.includes("Chirp3-HD") ? voiceName : `${language}-Chirp3-HD-${voiceName}` },
            audioConfig: { audioEncoding: "OGG_OPUS" },
          };
    const res = await timedFetch(
      this.fetchImpl,
      "https://texttospeech.googleapis.com/v1/text:synthesize",
      { method: "POST", headers: await this.headers(), body: JSON.stringify(body) },
      TTS_TIMEOUT_MS,
      "Text-to-Speech synthesize",
    );
    if (!res.ok) return failFromResponse(res, "Text-to-Speech synthesize");
    const json = (await res.json()) as { audioContent?: string };
    if (!json.audioContent) throw new SpeechError("provider-error", "Text-to-Speech returned no audio");
    const audio = Buffer.from(json.audioContent, "base64");
    assertWhatsAppVoice(audio);
    return audio;
  }
}

function transcriptOf(results: RecognizeResult[]): string {
  return results
    .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

/** The language Google reported most often across results, falling back to the first hint. */
function dominantLanguage(results: RecognizeResult[], hints: string[] | undefined): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.languageCode) counts.set(shortLanguage(r.languageCode), (counts.get(shortLanguage(r.languageCode)) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? shortLanguage(hints?.[0]);
}

/** Chirp 3 expects the legacy code iw-IL for Hebrew. Other models use he-IL. */
function sttLanguageCode(code: string, model: string): string {
  if (code === "auto") return "auto";
  const tag = bcp47(code);
  return model === "chirp_3" && tag.toLowerCase().startsWith("he") ? "iw-IL" : tag;
}

/** Duration of an Ogg Opus file, or undefined when the bytes are anything else. */
function opusDuration(buffer: Buffer): number | undefined {
  try {
    return inspectOggOpus(buffer).durationSec;
  } catch {
    return undefined;
  }
}
