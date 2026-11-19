// OpenAI speech to text (POST /v1/audio/transcriptions, gpt-4o-transcribe): the file path of a page editor's voice
// dictation (src/extension/voice.ts), as a host model service so the key and provider come from the host.
import { modelCredential, type ModelEnv } from "./credentials.js";

export const DEFAULT_OPENAI_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

export interface OpenAiTranscribeConfig {
  readonly model?: string;
  readonly baseUrl?: string;
  /** Name of the variable (or `<name>_FILE`) holding the key. Default OPENAI_API_KEY. */
  readonly keyEnv?: string;
  readonly timeoutMs?: number;
}

export interface OpenAiTranscribeInput {
  readonly audio: Buffer;
  readonly mimeType: string;
  /** ISO-639-1 hint, e.g. "en". */
  readonly language?: string;
  /** Vocabulary hint, e.g. "Landing page editing request: hero, section, button". */
  readonly prompt?: string;
}

export interface OpenAiTranscribeResult {
  readonly text: string;
  readonly provider: "openai";
  readonly model: string;
  readonly latencyMs: number;
  readonly language?: string;
}

export interface OpenAiTranscriber {
  readonly model: string;
  transcribe(input: OpenAiTranscribeInput): Promise<OpenAiTranscribeResult>;
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
};
const MAX_BYTES = 25 * 1024 * 1024;

export function createOpenAiTranscriber(
  config: OpenAiTranscribeConfig & { fetch: (url: string, init: RequestInit) => Promise<Response>; env?: ModelEnv },
): OpenAiTranscriber {
  const model = config.model ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL;
  const baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const keyEnv = config.keyEnv ?? "OPENAI_API_KEY";
  return {
    model,
    async transcribe(input) {
      const key = modelCredential(keyEnv, config.env);
      if (!key) throw Object.assign(new Error(`No key for transcription: set ${keyEnv} or ${keyEnv}_FILE.`), { code: "not-connected" });
      if (!input.audio.length) throw Object.assign(new Error("No audio to transcribe."), { code: "bad-request" });
      if (input.audio.length > MAX_BYTES) throw Object.assign(new Error("Audio is larger than 25 MB."), { code: "bad-request" });
      const mime = input.mimeType.split(";")[0]!.trim().toLowerCase();
      const form = new FormData();
      form.set("model", model);
      form.set("response_format", "json");
      if (input.language) form.set("language", input.language.slice(0, 5));
      if (input.prompt) form.set("prompt", input.prompt);
      form.set("file", new Blob([new Uint8Array(input.audio)], { type: mime }), `speech.${EXTENSIONS[mime] ?? "webm"}`);
      const started = Date.now();
      const response = await config.fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text.slice(0, 200);
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          /* not JSON */
        }
        throw Object.assign(new Error(`OpenAI transcription answered HTTP ${response.status}: ${message}`), {
          code: response.status === 401 || response.status === 403 ? "invalid-key" : response.status === 429 ? "rate-limited" : "unavailable",
        });
      }
      let parsed: { text?: unknown; language?: unknown };
      try {
        parsed = JSON.parse(text) as { text?: unknown; language?: unknown };
      } catch {
        throw Object.assign(new Error("OpenAI transcription answered something that is not JSON."), { code: "invalid-response" });
      }
      return {
        text: String(parsed.text ?? "").trim(),
        provider: "openai",
        model,
        latencyMs: Date.now() - started,
        ...(typeof parsed.language === "string" ? { language: parsed.language } : input.language ? { language: input.language } : {}),
      };
    },
  };
}
