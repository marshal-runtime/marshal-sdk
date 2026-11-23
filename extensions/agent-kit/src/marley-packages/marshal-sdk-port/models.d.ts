// Declarations of models.js (marshal-sdk src/models/decide.ts at SDK_MODELS_COMMIT), reduced to what Marley calls.
export type DecideProviderName = "jev" | "openai" | "decisions";
export type DecideImage = string | { readonly url: string; readonly detail?: "low" | "high" | "auto" | "original" };

export interface DecideConfig {
  readonly provider?: DecideProviderName;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly baseUrl?: string;
  readonly keyEnv?: string;
}

export type JudgeQuestion =
  | { readonly type: "choice" | "score"; readonly criteria: Readonly<Record<string, unknown>>; readonly instructions?: unknown; readonly images?: readonly DecideImage[] }
  | { readonly type: "noul" | "predicate"; readonly instructions: unknown; readonly criteria?: Readonly<Record<string, unknown>>; readonly images?: readonly DecideImage[] };

export interface JudgeRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
  readonly images?: readonly DecideImage[];
  readonly model?: string;
}

export interface JudgeResult {
  readonly answers: Readonly<Record<string, Record<string, unknown>>>;
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latencyMs: number;
}

export interface DecideRequest {
  readonly question: string;
  readonly options?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly context?: unknown;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly images?: readonly DecideImage[];
  readonly model?: string;
}

export interface DecideResult {
  readonly choice: unknown;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly reasoning?: string;
  readonly provider: DecideProviderName;
  readonly model: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

export interface DecideService {
  readonly provider: DecideProviderName;
  readonly model: string;
  decide(request: DecideRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DecideResult>;
  judge(request: JudgeRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JudgeResult>;
}

/** The SDK's errors carry a typed `code` (JEV_NOT_CONNECTED, JEV_INVALID_KEY, JEV_RATE_LIMITED, JEV_UNAVAILABLE, JEV_BAD_REQUEST, JEV_INVALID_RESPONSE, JEV_UNSUPPORTED, JEV_ABORTED). */
export declare function createDecideService(
  config?: DecideConfig,
  deps?: { fetch?: (url: string, init: RequestInit) => Promise<Response>; env?: Readonly<Record<string, string | undefined>> },
): DecideService;
