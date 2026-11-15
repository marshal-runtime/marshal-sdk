import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider } from "@marshal/runtime";
import { googleAccessTokenProvider, modelCredential, type ModelEnv } from "./credentials.js";
import { createDecideService, type DecideConfig, type DecideService } from "./decide.js";
import { createEmbedService, type EmbedConfig, type EmbedDeps, type EmbedService } from "./embed.js";
import { configFromEnv, createSpeech, type Speech, type SpeechConfig } from "./speech/index.js";
import type { SynthesizeResult, TranscribeResult } from "./speech/types.js";
import { adcTokenProvider } from "./speech/http.js";
import type { JevFetch } from "./jev/transport.js";

export { modelCredential, googleAccessTokenProvider } from "./credentials.js";
export { createDecideService, type DecideConfig, type DecideRequest, type DecideResult, type DecideService } from "./decide.js";
export { createEmbedService, EmbedError, formatForGemini, type EmbedConfig, type EmbedRequest, type EmbedResult, type EmbedService, type LocalEmbedder } from "./embed.js";
export { createSpeech, configFromEnv as speechConfigFromEnv, type Speech, type SpeechConfig } from "./speech/index.js";
export type { JevAskRequest, JevAskResult, JevQuestion, JevAnswer } from "./jev/api.js";

/** `models` in marshal-sdk.json: which provider answers each non-chat model service on this host. */
export interface ModelsConfig {
  readonly decide?: DecideConfig;
  readonly embed?: EmbedConfig;
  /** Marley's speech settings (see speech/config.ts); unset fields come from the SPEECH_* / ELEVENLABS_* variables. */
  readonly speech?: Omit<SpeechConfig, "fetch">;
}

export interface ModelServices {
  readonly decide: DecideService;
  readonly embed: EmbedService;
  /** Built on first use, so a host without speech settings or Google credentials pays nothing. */
  speech(): Speech;
  describe(): { decide: { provider: string; model: string }; embed: { provider: string; model: string }; speech: { tts: string; stt: string } };
  dispose(): Promise<void>;
}

export interface ModelServicesDeps extends Omit<EmbedDeps, "fetch"> {
  readonly fetch?: typeof fetch;
  readonly env?: ModelEnv;
}

export function createModelServices(config: ModelsConfig = {}, deps: ModelServicesDeps = {}): ModelServices {
  const env = deps.env ?? process.env;
  const decide = createDecideService(config.decide, { ...(deps.fetch ? { fetch: deps.fetch as JevFetch } : {}), env });
  const googleToken = deps.googleToken ?? googleAccessTokenProvider(env);
  const embed = createEmbedService(config.embed, { ...deps, env, googleToken });
  let speech: Speech | undefined;
  const speechService = () => {
    if (speech) return speech;
    const fromEnv = configFromEnv(env as NodeJS.ProcessEnv);
    const elevenKey = config.speech?.elevenlabs?.apiKey ?? modelCredential("ELEVENLABS_API_KEY", env);
    speech = createSpeech({
      ...fromEnv,
      ...config.speech,
      google: { getAccessToken: adcTokenProvider(googleToken), ...fromEnv.google, ...config.speech?.google },
      elevenlabs: { ...fromEnv.elevenlabs, ...config.speech?.elevenlabs, ...(elevenKey ? { apiKey: elevenKey } : {}) },
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    return speech;
  };
  return {
    decide,
    embed,
    speech: speechService,
    describe: () => {
      const providers = speechService().providers;
      return {
        decide: { provider: decide.provider, model: decide.model },
        embed: { provider: embed.provider, model: embed.model },
        speech: { tts: providers.tts, stt: providers.stt },
      };
    },
    dispose: () => embed.dispose(),
  };
}

const VERSION = "1.0.0";
const result = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["success"],
  properties: { success: { type: "boolean" }, error: { type: "string" }, code: { type: "string" }, ...properties },
});
const PROBABILITIES = { type: "object", additionalProperties: { type: "number" } };

const OPERATIONS: Record<string, { title: string; description: string; risk: "low" | "medium"; input: Record<string, unknown>; output: Record<string, unknown> }> = {
  "marshal.models.decide": {
    title: "Make a fast judgement with the host's decision model",
    description:
      "Answer one question from a context: pick one of `options` (with probabilities), answer yes/no when there are no options, or fill `schema`. Runs on the host's decision provider (Jev contract or OpenAI structured output). For many named choice/score/yes-no questions over one state at once, pass `questions` (Jev's contract) instead.",
    risk: "low",
    input: {
      type: "object",
      properties: {
        question: { type: "string", maxLength: 4000 },
        options: { oneOf: [{ type: "array", items: { type: "string" }, maxItems: 500 }, { type: "object" }] },
        context: {},
        schema: { type: "object" },
        questions: { type: "object" },
        state: {},
        model: { type: "string" },
      },
    },
    output: result({
      choice: {},
      confidence: { type: "number" },
      probabilities: PROBABILITIES,
      reasoning: { type: "string" },
      answers: { type: "object" },
      provider: { type: "string" },
      model: { type: "string" },
      usage: { type: "object" },
      latencyMs: { type: "number" },
    }),
  },
  "marshal.models.embed": {
    title: "Embed texts with the host's embedding model",
    description: "Turn 1-256 texts into L2-normalized vectors (task document or query) on the host's embedding provider: Gemini by default, or the local on-device model.",
    risk: "low",
    input: {
      type: "object",
      required: ["texts", "task"],
      properties: { texts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 256 }, task: { enum: ["document", "query"] }, dimensions: { type: "integer" } },
    },
    output: result({
      vectors: { type: "array", items: { type: "array", items: { type: "number" } } },
      provider: { type: "string" },
      model: { type: "string" },
      dimensions: { type: "integer" },
      tokens: { type: "integer" },
    }),
  },
  "marshal.models.speak": {
    title: "Turn text into a voice note",
    description: "Synthesize speech as mono Ogg Opus (a WhatsApp voice note), returned base64, on the host's voice provider (ElevenLabs when its key is set, else Google Gemini TTS).",
    risk: "low",
    input: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 8000 }, language: { type: "string" }, voice: { type: "string" }, provider: { enum: ["google", "elevenlabs"] } },
    },
    output: result({ audioBase64: { type: "string" }, mimeType: { type: "string" }, durationSec: { type: "number" }, provider: { type: "string" } }),
  },
  "marshal.models.transcribe": {
    title: "Turn audio into text",
    description: "Transcribe audio (base64 bytes, or a gs:// uri) on the host's speech-to-text provider. Returns the text, the detected language and the duration.",
    risk: "low",
    input: {
      type: "object",
      required: ["mimeType"],
      properties: { audioBase64: { type: "string" }, uri: { type: "string" }, mimeType: { type: "string" }, languageHints: { type: "array", items: { type: "string" } } },
    },
    output: result({ text: { type: "string" }, language: { type: "string" }, durationSec: { type: "number" }, provider: { type: "string" } }),
  },
};

export const MODEL_CAPABILITIES = Object.keys(OPERATIONS);

function failure(error: unknown) {
  const code = (error as { code?: string }).code;
  return { output: { success: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code: String(code) } : {}) } };
}

export function createModelsProvider(models: ModelServices): CapabilityProvider {
  const descriptors = Object.entries(OPERATIONS).map(([name, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "models", name.split(".").at(-1)!],
    inputSchema: spec.input,
    outputSchema: spec.output,
    permissions: [{ permission: name, risk: spec.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marshal.models",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown) => {
      const input = (value ?? {}) as Record<string, any>;
      try {
        switch (name) {
          case "marshal.models.decide": {
            if (input.questions && typeof input.questions === "object") {
              const judged = await models.decide.judge({ state: input.state ?? input.context ?? null, questions: input.questions, ...(input.model ? { model: input.model } : {}) });
              return { output: { success: true, answers: judged.answers, provider: models.decide.provider, model: judged.model, usage: judged.usage, latencyMs: judged.latencyMs } };
            }
            const decided = await models.decide.decide({
              question: String(input.question ?? ""),
              ...(input.options ? { options: input.options } : {}),
              ...(input.context !== undefined ? { context: input.context } : {}),
              ...(input.schema ? { schema: input.schema } : {}),
              ...(input.model ? { model: input.model } : {}),
            });
            return { output: { success: true, ...decided } };
          }
          case "marshal.models.embed": {
            const embedded = await models.embed.embed({ texts: input.texts, task: input.task, ...(input.dimensions ? { dimensions: input.dimensions } : {}) });
            return { output: { success: true, ...embedded } };
          }
          case "marshal.models.speak": {
            const spoken: SynthesizeResult = await models.speech().synthesize({
              text: String(input.text ?? ""),
              ...(input.language ? { language: input.language } : {}),
              ...(input.voice ? { voice: input.voice } : {}),
              ...(input.provider ? { provider: input.provider } : {}),
            });
            return { output: { success: true, audioBase64: spoken.audio.toString("base64"), mimeType: spoken.mimeType, durationSec: spoken.durationSec, provider: spoken.provider } };
          }
          case "marshal.models.transcribe": {
            const audio = typeof input.uri === "string" ? input.uri : Buffer.from(String(input.audioBase64 ?? ""), "base64");
            const heard: TranscribeResult = await models.speech().transcribe({
              audio,
              mimeType: String(input.mimeType),
              ...(Array.isArray(input.languageHints) ? { languageHints: input.languageHints } : {}),
            });
            return { output: { success: true, ...heard } };
          }
          default:
            throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
        }
      } catch (error) {
        if ((error as { code?: string }).code === "not-found") throw error;
        return failure(error);
      }
    },
  };
}
