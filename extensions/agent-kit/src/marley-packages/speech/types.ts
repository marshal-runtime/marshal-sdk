export type SpeechProviderName = "google" | "elevenlabs";

export type TranscribeInput = {
  /** Audio bytes, or a gs://bucket/object uri. */
  audio: Buffer | string;
  /** For example audio/ogg; codecs=opus. */
  mimeType: string;
  /** BCP-47 or ISO 639-1 codes the speaker probably uses, for example ["he", "en"]. Omit to auto-detect. */
  languageHints?: string[];
};

export type TranscribeResult = {
  text: string;
  /** ISO 639-1 code of the detected language, for example "he". "und" when unknown. */
  language: string;
  durationSec: number;
  provider: SpeechProviderName;
};

export type SynthesizeInput = {
  text: string;
  /** Explicit output provider; omitted callers retain their configured provider. */
  provider?: SpeechProviderName;
  /** BCP-47 or ISO 639-1 code. Omit to detect Hebrew by script and fall back to English. */
  language?: string;
  /** Provider voice name or id. Omit for the configured default. */
  voice?: string;
};

export type SynthesizeResult = {
  /** Ogg container, Opus codec, mono. WhatsApp shows it as a voice note. */
  audio: Buffer;
  mimeType: "audio/ogg";
  durationSec: number;
  provider: SpeechProviderName;
};

export interface SpeechProvider {
  readonly name: SpeechProviderName;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

export type SpeechErrorCode =
  | "bad-request"
  | "text-too-long"
  | "audio-too-large"
  | "unsupported-audio"
  | "auth"
  | "api-disabled"
  | "provider-error"
  | "not-configured"
  | "timeout";

export class SpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}
