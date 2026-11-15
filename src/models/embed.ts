import { googleAccessTokenProvider, modelCredential, type AccessTokenProvider, type ModelEnv } from "./credentials.js";

export type EmbedProviderName = "gemini" | "local";
export type EmbedTask = "document" | "query";

export interface EmbedConfig {
  /** `gemini` (default) or `local` (the runtime's on-device model, mxbai-embed-xsmall through transformers.js). */
  readonly provider?: EmbedProviderName;
  readonly model?: string;
  readonly dimensions?: number;
  /** Gemini on Vertex (bearer token from ADC): the default when no Gemini API key is set. */
  readonly project?: string;
  readonly location?: string;
  /** Name of the variable (or `<name>_FILE`) holding a Gemini API key. Default GEMINI_API_KEY; when set, the public Gemini API is used. */
  readonly keyEnv?: string;
  /** Parallel requests for a batch (Gemini embedContent takes one text per call). */
  readonly concurrency?: number;
  /** Options handed to the local provider (`configuration` etc. of @quillstone/embedding-runtime). */
  readonly local?: Readonly<Record<string, unknown>>;
}

export interface EmbedRequest {
  readonly texts: readonly string[];
  readonly task: EmbedTask;
  readonly dimensions?: number;
}

export interface EmbedResult {
  /** L2-normalized, in input order. */
  readonly vectors: number[][];
  readonly provider: EmbedProviderName;
  readonly model: string;
  readonly dimensions: number;
  readonly tokens: number;
}

export interface EmbedService {
  readonly provider: EmbedProviderName;
  readonly model: string;
  embed(request: EmbedRequest): Promise<EmbedResult>;
  dispose(): Promise<void>;
}

export interface LocalEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(input: readonly string[]): Promise<readonly (readonly number[])[]>;
  dispose?(): Promise<void>;
}

export class EmbedError extends Error {
  constructor(
    readonly code: "bad-request" | "auth" | "provider-error" | "not-installed" | "invalid-vector",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}

/** Same model and task wording as Zygstinct's embedding proxy (apps/embedding-proxy/src/core.ts), so vectors match the ones it stores. */
export const GEMINI_EMBED_MODEL = "gemini-embedding-2";
export const GEMINI_EMBED_DIMENSIONS = 1536;
const MAX_TEXT_BYTES = 8192;

export function formatForGemini(text: string, task: EmbedTask): string {
  return task === "query" ? `task: code retrieval | query: ${text}` : `title: none | text: ${text}`;
}

function normalize(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new EmbedError("invalid-vector", `Expected a vector of ${dimensions} finite numbers.`);
  }
  const norm = Math.sqrt((vector as number[]).reduce((sum, value) => sum + value * value, 0));
  if (!(norm > 0 && Number.isFinite(norm))) throw new EmbedError("invalid-vector", "The vector has no length.");
  return (vector as number[]).map((value) => value / norm);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let at = next++; at < items.length; at = next++) results[at] = await run(items[at]!);
    }),
  );
  return results;
}

export interface EmbedDeps {
  readonly fetch?: typeof fetch;
  readonly env?: ModelEnv;
  readonly googleToken?: AccessTokenProvider;
  /** Builds the local embedder; defaults to @quillstone/embedding-runtime when the host has it installed. */
  readonly loadLocal?: (options: Readonly<Record<string, unknown>>) => Promise<LocalEmbedder>;
}

async function defaultLoadLocal(options: Readonly<Record<string, unknown>>): Promise<LocalEmbedder> {
  let runtime: { createLocalEmbeddingProvider(options?: unknown): LocalEmbedder };
  try {
    const moduleName = "@quillstone/embedding-runtime";
    runtime = (await import(moduleName)) as typeof runtime;
  } catch {
    throw new EmbedError(
      "not-installed",
      "Local embeddings need @quillstone/embedding-runtime (and its transformers.js / onnxruntime peers) installed next to the SDK.",
    );
  }
  return runtime.createLocalEmbeddingProvider(options);
}

export function createEmbedService(config: EmbedConfig = {}, deps: EmbedDeps = {}): EmbedService {
  const provider = config.provider ?? "gemini";
  const fetchImpl = deps.fetch ?? fetch;
  if (provider === "local") {
    let loaded: Promise<LocalEmbedder> | undefined;
    const local = () => (loaded ??= (deps.loadLocal ?? defaultLoadLocal)(config.local ?? {}));
    return {
      provider,
      model: config.model ?? "local",
      async embed(request) {
        validate(request);
        const embedder = await local();
        if (request.dimensions !== undefined && request.dimensions !== embedder.dimensions) {
          throw new EmbedError("bad-request", `The local model gives ${embedder.dimensions} dimensions, not ${request.dimensions}.`);
        }
        const vectors = (await embedder.embed(request.texts)).map((vector) => normalize([...vector], embedder.dimensions));
        return { vectors, provider, model: embedder.model, dimensions: embedder.dimensions, tokens: 0 };
      },
      async dispose() {
        if (loaded) await (await loaded).dispose?.();
      },
    };
  }

  const model = config.model ?? GEMINI_EMBED_MODEL;
  const keyEnv = config.keyEnv ?? "GEMINI_API_KEY";
  const token = deps.googleToken ?? googleAccessTokenProvider(deps.env);
  const project = config.project ?? deps.env?.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  const location = config.location ?? "global";

  async function embedOne(text: string, task: EmbedTask, dimensions: number): Promise<{ vector: number[]; tokens: number }> {
    const formatted = formatForGemini(text, task);
    if (Buffer.byteLength(formatted) + 32 > MAX_TEXT_BYTES) throw new EmbedError("bad-request", "A text is too long to embed (8 KB limit).");
    const body = JSON.stringify({ content: { parts: [{ text: formatted }] }, outputDimensionality: dimensions });
    const apiKey = modelCredential(keyEnv, deps.env);
    let response: Response;
    if (apiKey) {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(task === "query" ? 10_000 : 30_000),
      });
    } else {
      if (!project) throw new EmbedError("auth", `Gemini embeddings need ${keyEnv} or a Google Cloud project (embed.project / GOOGLE_CLOUD_PROJECT) with ADC.`);
      const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
      response = await fetchImpl(`https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:embedContent`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(task === "query" ? 10_000 : 30_000),
      });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new EmbedError(response.status === 401 || response.status === 403 ? "auth" : "provider-error", `Gemini embedContent failed (${response.status}): ${detail}`, response.status);
    }
    const payload = (await response.json()) as { embedding?: { values?: unknown }; usageMetadata?: { promptTokenCount?: number } };
    return { vector: normalize(payload.embedding?.values, dimensions), tokens: payload.usageMetadata?.promptTokenCount ?? 0 };
  }

  return {
    provider,
    model,
    async embed(request) {
      validate(request);
      const dimensions = request.dimensions ?? config.dimensions ?? GEMINI_EMBED_DIMENSIONS;
      const results = await mapLimit(request.texts, config.concurrency ?? 8, (text) => embedOne(text, request.task, dimensions));
      return { vectors: results.map((result) => result.vector), provider, model, dimensions, tokens: results.reduce((sum, result) => sum + result.tokens, 0) };
    },
    async dispose() {},
  };
}

function validate(request: EmbedRequest) {
  if (!Array.isArray(request.texts) || request.texts.length === 0 || request.texts.length > 256) throw new EmbedError("bad-request", "Give 1 to 256 texts.");
  if (request.texts.some((text) => typeof text !== "string" || !text.trim())) throw new EmbedError("bad-request", "Every text must be a non-empty string.");
  if (request.task !== "document" && request.task !== "query") throw new EmbedError("bad-request", "task is document or query.");
  if (request.dimensions !== undefined && !(Number.isSafeInteger(request.dimensions) && request.dimensions > 0 && request.dimensions <= 3072)) {
    throw new EmbedError("bad-request", "dimensions must be a whole number from 1 to 3072.");
  }
}
