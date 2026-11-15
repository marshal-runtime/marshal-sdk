// Lifted from packages/speech/src/config.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import type { Converter } from "./convert.js";
import type { FetchLike, TokenProvider } from "./http.js";
import type { SpeechProviderName } from "./types.js";

/** Default longest reply to synthesize, in characters. Hebrew speech runs about 10 characters per second at 33 kbps, so this stays under WhatsApp's 512 KB play-icon limit. */
export const SPEECH_MAX_TEXT_CHARS = 1200;

/** Raised for an invalid setting. The message names the setting, never its value. */
export class SpeechConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechConfigError";
  }
}

/** Largest text piece per Gemini request. Gemini limits one request to 4,000 bytes; Hebrew letters take two. */
export const TTS_CHUNK_CHARS_MIN = 50;
export const TTS_CHUNK_CHARS_MAX = 1000;
export const TTS_RATE_MIN = 0.25;
export const TTS_RATE_MAX = 2;

/** Throws SpeechConfigError when a Gemini setting is out of range or not a finite number. */
export function validateTtsSettings(settings: { ttsChunkChars?: number; ttsSpeakingRate?: number }, names = { chunk: "ttsChunkChars", rate: "ttsSpeakingRate" }): void {
  const { ttsChunkChars: chunk, ttsSpeakingRate: rate } = settings;
  if (chunk !== undefined && !(Number.isInteger(chunk) && chunk >= TTS_CHUNK_CHARS_MIN && chunk <= TTS_CHUNK_CHARS_MAX)) {
    throw new SpeechConfigError(`${names.chunk} must be a whole number from ${TTS_CHUNK_CHARS_MIN} to ${TTS_CHUNK_CHARS_MAX}`);
  }
  if (rate !== undefined && !(Number.isFinite(rate) && rate >= TTS_RATE_MIN && rate <= TTS_RATE_MAX)) {
    throw new SpeechConfigError(`${names.rate} must be a number from ${TTS_RATE_MIN} to ${TTS_RATE_MAX}`);
  }
}

export type SpeechConfig = {
  /**
   * Shortcut that sets both directions. "google" and "elevenlabs" force one provider; "auto" is ElevenLabs when its key
   * exists and Google otherwise. Leave it unset and use the two fields below.
   */
  provider?: SpeechProviderName | "auto";
  /** Voice out. Default "auto": ElevenLabs when its API key is non-empty, otherwise Google. */
  ttsProvider?: SpeechProviderName | "auto";
  /** Voice in. Default "google", the tested path. Set "elevenlabs" or "auto" to use Scribe. */
  sttProvider?: SpeechProviderName | "auto";
  /** When the chosen ElevenLabs call fails, answer with Google instead. Default true. */
  fallbackToGoogle?: boolean;
  google?: GoogleSpeechConfig;
  elevenlabs?: ElevenLabsConfig;
  fetch?: FetchLike;
};

export type GoogleSpeechConfig = {
  /** Default "zyg-ecom-zygstinct". */
  project?: string;
  /** Speech-to-Text v2 location. Chirp 3 runs in the "us" and "eu" multi-regions. Default "us". */
  sttLocation?: string;
  /** Default "chirp_3". */
  sttModel?: string;
  /** "gemini" (default) or "chirp3-hd". */
  ttsEngine?: "gemini" | "chirp3-hd";
  /** Default "gemini-2.5-flash-tts". */
  geminiModel?: string;
  /** Default voice name. Gemini: a prebuilt name such as "Kore". Chirp 3 HD: the part after the model, for example "Kore". */
  ttsVoice?: string;
  /** Optional style prompt for Gemini TTS, for example "Say warmly and calmly". */
  ttsStylePrompt?: string;
  /** Sent as x-goog-user-project. Needed only when calling with user credentials. */
  userProject?: string;
  /** Languages to expect when the caller gives no hints. Default ["he", "en"]. Use ["auto"] for language auto-detection (less reliable on long notes). */
  defaultLanguages?: string[];
  /** Longest audio to transcribe, in seconds. Default 900. */
  maxAudioSec?: number;
  /** Longest reply to synthesize, in characters. Default SPEECH_MAX_TEXT_CHARS (about 2 minutes of speech, under 512 KB). */
  maxTextChars?: number;
  /** Gemini speaking rate, 0.25 to 2. Default unset (1.0). 1.15 shortens a 30 s note by about 4 s. Measured; whether it sounds better is a listening decision. */
  ttsSpeakingRate?: number;
  /** Largest piece of text sent to Gemini in one request. Default 250; a larger piece keeps one voice and rhythm across more words but takes longer. */
  ttsChunkChars?: number;
  /** Path of the ffmpeg binary used for non-Opus audio and video. Default "ffmpeg" from PATH. */
  ffmpegPath?: string;
  /** Replaces ffmpeg, for tests. */
  convert?: Converter;
  getAccessToken?: TokenProvider;
};

export type ElevenLabsConfig = {
  apiKey?: string;
  /** Default "https://api.elevenlabs.io". */
  baseUrl?: string;
  /** Default "scribe_v2". */
  sttModel?: string;
  /** Default "eleven_v3", which covers Hebrew. */
  ttsModel?: string;
  /** Default voice id. */
  voiceId?: string;
  /** Default "opus_48000_32". */
  outputFormat?: string;
  /** Longest reply to synthesize, in characters. Default 1200. */
  maxTextChars?: number;
  /** Longest note to transcribe, in seconds. Default 900. */
  maxAudioSec?: number;
  /** ffmpeg binary, used only if ElevenLabs returns Opus that is not mono Ogg. */
  ffmpegPath?: string;
};

/** Reads config from environment variables. The Cloud Run service sets them; ELEVENLABS_API_KEY comes from secret zs-elevenlabs. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  const choice = (value: string | undefined): SpeechConfig["provider"] =>
    value === "google" || value === "elevenlabs" || value === "auto" ? value : undefined;
  const ttsEngine = env.SPEECH_GOOGLE_TTS_ENGINE === "chirp3-hd" ? "chirp3-hd" : undefined;
  const num = (value: string | undefined) => (value ? Number(value) : undefined);
  // Strict: an unset or empty variable means the default, anything else must be a plain number (no "abc", "1e9", " ").
  const strict = (name: string, pattern: RegExp, value: string | undefined): number | undefined => {
    if (value === undefined || value === "") return undefined;
    if (!pattern.test(value)) throw new SpeechConfigError(`${name} is not a valid number`);
    return Number(value);
  };
  const ttsChunkChars = strict("SPEECH_TTS_CHUNK_CHARS", /^\d{1,6}$/, env.SPEECH_TTS_CHUNK_CHARS);
  const ttsSpeakingRate = strict("SPEECH_TTS_RATE", /^\d{1,2}(?:\.\d{1,3})?$/, env.SPEECH_TTS_RATE);
  validateTtsSettings({ ttsChunkChars, ttsSpeakingRate }, { chunk: "SPEECH_TTS_CHUNK_CHARS", rate: "SPEECH_TTS_RATE" });
  return {
    provider: choice(env.SPEECH_PROVIDER),
    ttsProvider: choice(env.SPEECH_TTS_PROVIDER),
    sttProvider: choice(env.SPEECH_STT_PROVIDER),
    fallbackToGoogle: env.SPEECH_FALLBACK === "off" ? false : undefined,
    google: {
      project: env.SPEECH_GOOGLE_PROJECT || env.GOOGLE_CLOUD_PROJECT || undefined,
      sttLocation: env.SPEECH_STT_LOCATION || undefined,
      sttModel: env.SPEECH_STT_MODEL || undefined,
      ttsEngine,
      geminiModel: env.SPEECH_GEMINI_TTS_MODEL || undefined,
      ttsVoice: env.SPEECH_TTS_VOICE || undefined,
      ttsStylePrompt: env.SPEECH_TTS_STYLE_PROMPT || undefined,
      ffmpegPath: env.FFMPEG_PATH || undefined,
      userProject: env.SPEECH_USER_PROJECT || undefined,
      defaultLanguages: env.SPEECH_DEFAULT_LANGUAGES ? env.SPEECH_DEFAULT_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean) : undefined,
      maxAudioSec: num(env.SPEECH_MAX_AUDIO_SEC),
      maxTextChars: num(env.SPEECH_MAX_TEXT_CHARS),
      ttsChunkChars,
      ttsSpeakingRate,
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
      voiceId: env.ELEVENLABS_VOICE_ID || undefined,
      sttModel: env.ELEVENLABS_STT_MODEL || undefined,
      ttsModel: env.ELEVENLABS_TTS_MODEL || undefined,
      outputFormat: env.ELEVENLABS_OUTPUT_FORMAT || undefined,
      ffmpegPath: env.FFMPEG_PATH || undefined,
      maxAudioSec: num(env.SPEECH_MAX_AUDIO_SEC),
      maxTextChars: num(env.SPEECH_MAX_TEXT_CHARS),
    },
  };
}
