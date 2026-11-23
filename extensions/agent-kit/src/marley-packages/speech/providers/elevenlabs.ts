import { ffmpegConverter, type Converter } from "../convert.js";
import type { ElevenLabsConfig } from "../config.js";
import { failFromResponse, timedFetch, type FetchLike } from "../http.js";
import { detectTextLanguage, shortLanguage } from "../language.js";
import { speakableWithinLimit } from "../speakable.js";
import { assertWhatsAppVoice, inspectOggOpus } from "../ogg.js";
import {
  SpeechError,
  type SpeechProvider,
  type SynthesizeInput,
  type SynthesizeResult,
  type TranscribeInput,
  type TranscribeResult,
} from "../types.js";

/** Rachel, a stock multilingual voice every account has. Pick a better Hebrew voice with ELEVENLABS_VOICE_ID. */
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_TTS_MODEL = "eleven_v3";
const DEFAULT_STT_MODEL = "scribe_v2";
const DEFAULT_MAX_TEXT_CHARS = 1200;
const DEFAULT_MAX_AUDIO_SEC = 15 * 60;
const TTS_TIMEOUT_MS = 30_000;
const STT_TIMEOUT_MS = 90_000;
/** Models that accept the language_code field on text-to-speech. */
const LANGUAGE_CODE_MODELS = /^eleven_(v3|v4|flash|turbo)/;

const EXTENSION: [RegExp, string][] = [
  [/mp4|m4a|aac/i, "audio.mp4"],
  [/mpeg|mp3/i, "audio.mp3"],
  [/wav/i, "audio.wav"],
  [/3gpp/i, "audio.3gp"],
  [/quicktime/i, "audio.mov"],
  [/amr/i, "audio.amr"],
];

export type ElevenLabsDeps = {
  fetch?: FetchLike;
  /** Reads a gs:// object. Needed only when the caller passes a uri instead of bytes. */
  download?: (uri: string) => Promise<Buffer>;
  /** Used when ElevenLabs returns Opus that is not mono Ogg. */
  convert?: Converter;
};

export class ElevenLabsProvider implements SpeechProvider {
  readonly name = "elevenlabs" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: ElevenLabsConfig,
    deps: ElevenLabsDeps | FetchLike = {},
  ) {
    const resolved: ElevenLabsDeps = typeof deps === "function" ? { fetch: deps } : deps;
    if (!config.apiKey?.trim()) throw new SpeechError("not-configured", "ElevenLabs API key is missing");
    this.baseUrl = (config.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
    this.fetchImpl = resolved.fetch ?? fetch;
    this.download = resolved.download;
    this.convert = resolved.convert ?? ffmpegConverter;
  }

  private readonly download?: (uri: string) => Promise<Buffer>;
  private readonly convert: Converter;

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    let audio: Buffer;
    if (typeof input.audio === "string") {
      if (!this.download) throw new SpeechError("bad-request", "ElevenLabs transcription needs audio bytes or a downloader for gs:// uris");
      audio = await this.download(input.audio);
    } else {
      audio = input.audio;
    }
    if (audio.length === 0) throw new SpeechError("bad-request", "audio is empty");
    const maxSec = this.config.maxAudioSec ?? DEFAULT_MAX_AUDIO_SEC;
    let known: number | undefined;
    try {
      known = inspectOggOpus(audio).durationSec;
    } catch {
      known = undefined;
    }
    if (known !== undefined && known > maxSec) throw new SpeechError("audio-too-large", `audio is ${Math.round(known)} s, limit ${maxSec} s`);

    const form = new FormData();
    form.set("model_id", this.config.sttModel ?? DEFAULT_STT_MODEL);
    form.set("tag_audio_events", "false");
    const hint = input.languageHints?.length === 1 ? input.languageHints[0] : undefined;
    if (hint && hint !== "auto") form.set("language_code", shortLanguage(hint));
    const filename = /ogg|opus/i.test(input.mimeType) ? "audio.ogg" : (EXTENSION.find(([re]) => re.test(input.mimeType))?.[1] ?? "audio.bin");
    form.set("file", new Blob([new Uint8Array(audio)], { type: input.mimeType }), filename);
    const res = await timedFetch(
      this.fetchImpl,
      `${this.baseUrl}/v1/speech-to-text`,
      { method: "POST", headers: { "xi-api-key": this.config.apiKey! }, body: form },
      STT_TIMEOUT_MS,
      "ElevenLabs speech-to-text",
    );
    if (!res.ok) return failFromResponse(res, "ElevenLabs speech-to-text");
    const body = (await res.json()) as { text?: string; language_code?: string; words?: { end?: number }[]; audio_duration_secs?: number | null };
    const durationSec = body.audio_duration_secs ?? body.words?.at(-1)?.end ?? known ?? 0;
    if (durationSec > maxSec) throw new SpeechError("audio-too-large", `audio is ${Math.round(durationSec)} s, limit ${maxSec} s`);
    return { text: (body.text ?? "").trim(), language: shortLanguage(body.language_code), durationSec, provider: "elevenlabs" };
  }

  async listVoices(): Promise<{ id: string; name: string }[]> {
    const voices = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ page_size: "100", include_total_count: "false" });
      if (cursor) query.set("next_page_token", cursor);
      const response = await timedFetch(this.fetchImpl, `${this.baseUrl}/v2/voices?${query}`, { headers: { "xi-api-key": this.config.apiKey! } }, 10_000, "ElevenLabs voices");
      if (!response.ok) return failFromResponse(response, "ElevenLabs voices");
      const body = await response.json() as { voices?: unknown; has_more?: unknown; next_page_token?: unknown };
      if (!Array.isArray(body.voices) || body.voices.length > 100 || typeof body.has_more !== "boolean") throw new SpeechError("provider-error", "invalid voice catalog");
      for (const voice of body.voices) {
        if (!voice || typeof voice.voice_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voice.voice_id) || typeof voice.name !== "string" || !voice.name.trim() || voice.name.length > 120 || /[\u0000-\u001f\u007f]/.test(voice.name)) throw new SpeechError("provider-error", "invalid voice catalog entry");
        voices.set(voice.voice_id, voice.name);
      }
      if (!body.has_more) return [...voices].map(([id, name]) => ({ id, name }));
      if (typeof body.next_page_token !== "string" || !body.next_page_token || body.next_page_token.length > 1024 || body.next_page_token === cursor) throw new SpeechError("provider-error", "invalid voice catalog cursor");
      cursor = body.next_page_token;
    }
    throw new SpeechError("provider-error", "voice catalog exceeds the supported size");
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const spoken = speakableWithinLimit(input.text, input.language ?? detectTextLanguage(input.text.trim()), this.config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
    const audio = await this.requestWithRetry(spoken, input);
    const voice = await this.ensureWhatsAppVoice(audio);
    const info = assertWhatsAppVoice(voice);
    return { audio: voice, mimeType: "audio/ogg", durationSec: info.durationSec, provider: "elevenlabs" };
  }

  private async requestWithRetry(text: string, input: SynthesizeInput): Promise<Buffer> {
    try {
      return await this.request(text, input);
    } catch (error) {
      const retryable = error instanceof SpeechError && (error.code === "timeout" || (error.code === "provider-error" && (error.status === 429 || (error.status ?? 0) >= 500)));
      if (!retryable) throw error;
      return this.request(text, input);
    }
  }

  private async request(text: string, input: SynthesizeInput): Promise<Buffer> {
    const voice = input.voice ?? this.config.voiceId ?? DEFAULT_VOICE;
    const format = this.config.outputFormat ?? "opus_48000_32";
    const model = this.config.ttsModel ?? DEFAULT_TTS_MODEL;
    const payload: Record<string, unknown> = { text, model_id: model };
    if (LANGUAGE_CODE_MODELS.test(model)) payload.language_code = shortLanguage(input.language ?? detectTextLanguage(text));
    const res = await timedFetch(
      this.fetchImpl,
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(format)}`,
      { method: "POST", headers: { "xi-api-key": this.config.apiKey!, "content-type": "application/json" }, body: JSON.stringify(payload) },
      TTS_TIMEOUT_MS,
      "ElevenLabs text-to-speech",
    );
    if (!res.ok) return failFromResponse(res, "ElevenLabs text-to-speech");
    return Buffer.from(await res.arrayBuffer());
  }

  /** Accepts mono Ogg Opus as is. Anything else (raw Opus, stereo) is re-encoded when ffmpeg is available. */
  private async ensureWhatsAppVoice(audio: Buffer): Promise<Buffer> {
    try {
      assertWhatsAppVoice(audio);
      return audio;
    } catch (error) {
      if (!(error instanceof SpeechError) || error.code !== "unsupported-audio") throw error;
      const converted = await this.convert(audio, { ffmpegPath: this.config.ffmpegPath, maxSeconds: 300 });
      if (!converted) throw error;
      return converted;
    }
  }
}
