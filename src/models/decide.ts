import type { JevAnswer, JevAskRequest, JevAskResult, JevQuestion } from "./jev/api.js";
import { DEFAULT_JEV_MODEL } from "./jev/api.js";
import {
  abortedError,
  badRequestError,
  invalidKeyError,
  invalidResponseError,
  notConnectedError,
  rateLimitedError,
  unavailableError,
} from "./jev/errors.js";
import { buildChatRequest, defaultReasoningEffort, openAiErrorMessage, parseChatCompletion, toJevAnswers } from "./jev/openai.js";
import { isAbortError, postJsonWithRetry, type JevFetch } from "./jev/transport.js";
import { validateAnswer } from "./jev/validation.js";
import { modelCredential, type ModelEnv } from "./credentials.js";
import { createDecisionsClient, DEFAULT_DECISIONS_MODEL, judgeWithDecisions } from "./openai-decisions.js";

export type DecideProviderName = "jev" | "openai" | "decisions";

export interface DecideConfig {
  /**
   * `jev` (default): Jev's judgement contract with a full probability distribution, over chat completions.
   * `decisions`: the same contract on OpenAI's Decisions API (`/v1/decisions`, default `gpt-6-luna`), which returns a
   * probability per option natively. `openai`: one structured answer.
   */
  readonly provider?: DecideProviderName;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Any OpenAI-compatible endpoint. */
  readonly baseUrl?: string;
  /** Name of the variable (or `<name>_FILE`) holding the key. Default OPENAI_API_KEY. */
  readonly keyEnv?: string;
}

export interface DecideRequest {
  readonly question: string;
  /** A list of answers, or ids mapped to descriptions. Without options and without a schema the question is yes/no. */
  readonly options?: readonly string[] | Readonly<Record<string, unknown>>;
  /** What the decision is about: any JSON. */
  readonly context?: unknown;
  /** A JSON schema for a free-form structured answer (instead of options). */
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly model?: string;
}

export interface DecideResult {
  /** The chosen option id, true/false for a yes/no question, or the object matching `schema`. */
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
  /** Jev's own contract: named choice / score / noul questions over one state. */
  judge(request: JevAskRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JevAskResult>;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function createDecideService(config: DecideConfig = {}, deps: { fetch?: JevFetch; env?: ModelEnv } = {}): DecideService {
  const provider = config.provider ?? "jev";
  const model = config.model ?? (provider === "decisions" ? DEFAULT_DECISIONS_MODEL : DEFAULT_JEV_MODEL);
  const baseUrl = (config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const keyEnv = config.keyEnv ?? "OPENAI_API_KEY";

  async function complete(body: unknown, options: { signal?: AbortSignal; timeoutMs?: number }) {
    const key = modelCredential(keyEnv, deps.env);
    if (!key) throw Object.assign(notConnectedError(), { message: `No key for decisions: set ${keyEnv} or ${keyEnv}_FILE.` });
    let response: Awaited<ReturnType<typeof postJsonWithRetry>>;
    try {
      response = await postJsonWithRetry(fetchImpl, `${baseUrl}/v1/chat/completions`, key, body, options);
    } catch (error) {
      if (isAbortError(error)) throw abortedError();
      throw unavailableError(undefined, "Could not reach the decision model.");
    }
    if (response.status === 401 || response.status === 403) throw invalidKeyError(openAiErrorMessage(response.body));
    if (response.status === 429) throw rateLimitedError(openAiErrorMessage(response.body));
    if (response.status >= 500) throw unavailableError(response.status, openAiErrorMessage(response.body));
    if (response.status < 200 || response.status >= 300) throw badRequestError(openAiErrorMessage(response.body) ?? `HTTP ${response.status}`, response.status);
    const completion = parseChatCompletion(response.body);
    if (!completion) throw invalidResponseError("The decision model returned a malformed chat completion.");
    if (completion.refusal) throw invalidResponseError(`The decision model refused: ${completion.refusal}`);
    return completion;
  }

  function resolveModel(requested?: string) {
    return !requested || /^jev(-|$)/i.test(requested) ? model : requested;
  }

  const decisions = createDecisionsClient({ fetch: fetchImpl, baseUrl, keyEnv, key: () => modelCredential(keyEnv, deps.env) });

  async function judge(request: JevAskRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JevAskResult> {
    const chosen = resolveModel(request.model);
    if (provider === "decisions") return judgeWithDecisions(decisions, chosen, request, options);
    const started = Date.now();
    const completion = await complete(
      buildChatRequest(chosen, request.state, request.questions, config.reasoningEffort ?? defaultReasoningEffort(chosen)),
      options,
    );
    const raw = toJevAnswers(request.questions, completion.output);
    const answers: Record<string, JevAnswer> = {};
    for (const [name, question] of Object.entries(request.questions)) answers[name] = validateAnswer(name, question, raw[name]);
    return {
      answers,
      model: completion.model ?? chosen,
      usage: { input_tokens: number(completion.usage.input_tokens), output_tokens: number(completion.usage.output_tokens) },
      latencyMs: Date.now() - started,
    };
  }

  function criteriaOf(options: DecideRequest["options"]): Record<string, unknown> | undefined {
    if (!options) return undefined;
    if (Array.isArray(options)) return Object.fromEntries((options as readonly string[]).map((option) => [option, option]));
    return { ...(options as Record<string, unknown>) };
  }

  async function structured(request: DecideRequest, schema: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number }) {
    // The Decisions endpoint only picks among options; a free-form schema answer goes to chat completions.
    const chosen = provider === "decisions" && !request.model ? DEFAULT_JEV_MODEL : resolveModel(request.model);
    const effort = config.reasoningEffort ?? defaultReasoningEffort(chosen);
    const completion = await complete(
      {
        model: chosen,
        messages: [
          { role: "system", content: "Answer the question from the context alone, in the required JSON shape. Keep `reasoning` to one sentence." },
          { role: "user", content: JSON.stringify({ question: request.question, context: request.context ?? null }) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema } },
        ...(/^(gpt-5|o\d)/.test(chosen) ? (effort ? { reasoning_effort: effort } : {}) : { temperature: 0 }),
      },
      options,
    );
    return { completion, chosen };
  }

  async function decide(request: DecideRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DecideResult> {
    if (!request.question?.trim()) throw badRequestError("A decision needs a question.");
    const started = Date.now();
    const criteria = criteriaOf(request.options);
    if (request.schema) {
      const schema = {
        type: "object",
        properties: { answer: request.schema, reasoning: { type: "string" } },
        required: ["answer", "reasoning"],
        additionalProperties: false,
      };
      const { completion, chosen } = await structured(request, schema, options);
      const output = completion.output as { answer?: unknown; reasoning?: unknown } | undefined;
      if (!output || !("answer" in output)) throw invalidResponseError("The decision model returned no answer.");
      return {
        choice: output.answer,
        ...(typeof output.reasoning === "string" ? { reasoning: output.reasoning } : {}),
        provider,
        model: completion.model ?? chosen,
        usage: { inputTokens: number(completion.usage.input_tokens), outputTokens: number(completion.usage.output_tokens) },
        latencyMs: Date.now() - started,
      };
    }
    if (provider === "jev" || provider === "decisions") {
      const question: JevQuestion = criteria
        ? { type: "choice", criteria, instructions: request.question }
        : { type: "noul", instructions: request.question };
      const result = await judge({ state: (request.context ?? null) as JevAskRequest["state"], questions: { decision: question }, ...(request.model ? { model: request.model } : {}) }, options);
      const answer = result.answers.decision;
      const usage = { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens };
      if (answer.type === "noul") {
        return { choice: answer.noul >= 0.5, confidence: Math.max(answer.noul, 1 - answer.noul), probabilities: { true: answer.noul, false: 1 - answer.noul }, provider, model: result.model, usage, latencyMs: Date.now() - started };
      }
      const ranked = answer as Extract<JevAnswer, { probabilities: unknown }>;
      return {
        choice: "choice" in ranked ? ranked.choice : (ranked as { score: number }).score,
        confidence: ranked.confidence,
        probabilities: ranked.probabilities,
        provider,
        model: result.model,
        usage,
        latencyMs: Date.now() - started,
      };
    }
    const ids = criteria ? Object.keys(criteria) : undefined;
    const schema = {
      type: "object",
      properties: {
        choice: ids ? { type: "string", enum: ids } : { type: "boolean" },
        confidence: { type: "number" },
        reasoning: { type: "string" },
      },
      required: ["choice", "confidence", "reasoning"],
      additionalProperties: false,
    };
    const { completion, chosen } = await structured({ ...request, context: { context: request.context ?? null, options: criteria ?? null } }, schema, options);
    const output = completion.output as { choice?: unknown; confidence?: unknown; reasoning?: unknown } | undefined;
    if (!output || (ids ? !ids.includes(String(output.choice)) : typeof output.choice !== "boolean")) throw invalidResponseError("The decision model's answer is not one of the options.");
    return {
      choice: output.choice,
      ...(typeof output.confidence === "number" ? { confidence: Math.min(1, Math.max(0, output.confidence)) } : {}),
      ...(typeof output.reasoning === "string" ? { reasoning: output.reasoning } : {}),
      provider,
      model: completion.model ?? chosen,
      usage: { inputTokens: number(completion.usage.input_tokens), outputTokens: number(completion.usage.output_tokens) },
      latencyMs: Date.now() - started,
    };
  }

  return { provider, model, decide, judge };
}
