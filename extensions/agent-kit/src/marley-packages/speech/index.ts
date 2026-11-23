import { configFromEnv, type SpeechConfig } from "./config.js";
import { ElevenLabsProvider } from "./providers/elevenlabs.js";
import { GoogleSpeechProvider } from "./providers/google.js";
import {
  SpeechError,
  type SpeechErrorCode,
  type SpeechProvider,
  type SpeechProviderName,
  type SynthesizeInput,
  type SynthesizeResult,
  type TranscribeInput,
  type TranscribeResult,
} from "./types.js";

export * from "./types.js";
export { configFromEnv, SpeechConfigError, validateTtsSettings, SPEECH_MAX_TEXT_CHARS, type SpeechConfig, type GoogleSpeechConfig, type ElevenLabsConfig } from "./config.js";
export { inspectOggOpus, assertWhatsAppVoice, concatOggOpus, splitOggOpus, type OggOpusInfo } from "./ogg.js";
export { prepareSpokenText, prepareSpokenTextTraced, speakableWithinLimit, stripNonSpeech, spellHebrewNumbers, spellHebrewNumbersTraced, spellHebrewLoanwords, hebrewCardinal, hebrewNounGender } from "./speakable.js";
export { splitForSpeech, joinOverlappingTranscripts } from "./text.js";
export { ffmpegConverter, type Converter, type ConvertOptions } from "./convert.js";
export { GoogleSpeechProvider } from "./providers/google.js";
export { ElevenLabsProvider } from "./providers/elevenlabs.js";

export interface Speech {
  /** The provider that answers voice out (synthesize). */
  readonly provider: SpeechProvider;
  readonly providers: { stt: SpeechProviderName; tts: SpeechProviderName; elevenlabsKey: boolean };
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
  listVoices(): Promise<{ configured: boolean; voices: { id: string; name: string }[] }>;
}

const FALLBACK_CODES: SpeechErrorCode[] = ["provider-error", "timeout", "auth", "api-disabled", "not-configured", "unsupported-audio"];

/** Tries the primary provider, and answers with the backup when the primary fails in a way the backup could avoid. */
function withFallback(primary: SpeechProvider, backup: SpeechProvider | undefined): SpeechProvider {
  if (!backup) return primary;
  const attempt = async <T>(call: (p: SpeechProvider) => Promise<T>): Promise<T> => {
    try {
      return await call(primary);
    } catch (error) {
      if (error instanceof SpeechError && FALLBACK_CODES.includes(error.code)) return call(backup);
      throw error;
    }
  };
  return {
    name: primary.name,
    transcribe: (input) => attempt((p) => p.transcribe(input)),
    synthesize: async (input) => {
      try { return await primary.synthesize(input); }
      catch (error) {
        if (error instanceof SpeechError && FALLBACK_CODES.includes(error.code)) return backup.synthesize({ ...input, provider: "google", voice: "Charon" });
        throw error;
      }
    },
  };
}

/**
 * Builds the speech service from config.
 *
 * - Voice out uses ElevenLabs when `ELEVENLABS_API_KEY` is non-empty, and Google while it is missing or empty.
 * - Voice in stays on Google unless `SPEECH_STT_PROVIDER` says otherwise.
 * - If an ElevenLabs call fails, the same call is answered by Google (`result.provider` says which one answered).
 */
export function createSpeech(config: SpeechConfig = configFromEnv()): Speech {
  const hasKey = Boolean(config.elevenlabs?.apiKey?.trim());
  const resolve = (specific: SpeechConfig["provider"], whenUnset: "google" | "auto"): SpeechProviderName => {
    const wanted = specific ?? config.provider ?? whenUnset;
    if (wanted === "google") return "google";
    return hasKey ? "elevenlabs" : "google";
  };
  const ttsName = resolve(config.ttsProvider, "auto");
  const sttName = resolve(config.sttProvider, "google");

  const google = new GoogleSpeechProvider(config.google, config.fetch);
  const gemini = config.google?.ttsEngine === "chirp3-hd" ? new GoogleSpeechProvider({ ...config.google, ttsEngine: "gemini" }, config.fetch) : google;
  const backup = config.fallbackToGoogle === false ? undefined : google;
  const eleven = (): ElevenLabsProvider =>
    new ElevenLabsProvider(config.elevenlabs ?? {}, {
      fetch: config.fetch,
      download: (uri) => google.download(uri),
      convert: config.google?.convert,
    });
  const tts = ttsName === "elevenlabs" ? withFallback(eleven(), backup) : google;
  const stt = sttName === "elevenlabs" ? withFallback(eleven(), backup) : google;
  return {
    provider: tts,
    providers: { stt: sttName, tts: ttsName, elevenlabsKey: hasKey },
    transcribe: (input) => stt.transcribe(input),
    synthesize: (input) => {
      if (input.provider === "google") return gemini.synthesize(input);
      if (input.provider === "elevenlabs") return hasKey ? withFallback(eleven(), backup).synthesize(input) : google.synthesize({ ...input, provider: "google", voice: "Charon" });
      return tts.synthesize(input);
    },
    listVoices: async () => ({ configured: hasKey, voices: hasKey ? await eleven().listVoices() : [] }),
  };
}

let shared: Speech | undefined;

/** Transcribes with the provider chosen by environment variables (see configFromEnv). */
export function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  shared ??= createSpeech();
  return shared.transcribe(input);
}

/** Synthesizes an Ogg Opus mono voice note with the provider chosen by environment variables. */
export function synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
  shared ??= createSpeech();
  return shared.synthesize(input);
}
