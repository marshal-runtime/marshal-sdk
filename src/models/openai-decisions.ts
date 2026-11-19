// OpenAI Decisions API (POST /v1/decisions): named choice questions answered with a probability per option, the
// endpoint a page editor's instant-edit router, zyg-agents' search judge and zygstinct's channel-gateway emoji picker call.
// Same request and answer shape as that page editor's own decisions client.
import type { JevAnswer, JevAskRequest, JevAskResult, JevQuestion } from "./jev/api.js";
import { abortedError, badRequestError, invalidKeyError, invalidResponseError, notConnectedError, rateLimitedError, unavailableError } from "./jev/errors.js";
import { openAiErrorMessage } from "./jev/openai.js";
import { isAbortError, postJsonWithRetry, type JevFetch } from "./jev/transport.js";

export const DEFAULT_DECISIONS_MODEL = "gpt-6-luna";

export interface DecisionsChoice {
  readonly value: string;
  readonly description: string;
}

export interface DecisionsQuestion {
  readonly type: "choice";
  readonly name: string;
  readonly instructions: string;
  readonly choices: readonly DecisionsChoice[];
}

export interface DecisionsClient {
  ask(
    request: { input: string; questions: readonly DecisionsQuestion[]; model: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ answers: Record<string, Record<string, number>>; model: string; usage: { input_tokens: number; output_tokens: number } }>;
}

const describe = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null));
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

export function createDecisionsClient(deps: { fetch: JevFetch; baseUrl: string; key: () => string | undefined; keyEnv: string }): DecisionsClient {
  return {
    async ask(request, options = {}) {
      const key = deps.key();
      if (!key) throw Object.assign(notConnectedError(), { message: `No key for decisions: set ${deps.keyEnv} or ${deps.keyEnv}_FILE.` });
      let response: Awaited<ReturnType<typeof postJsonWithRetry>>;
      try {
        response = await postJsonWithRetry(deps.fetch, `${deps.baseUrl}/v1/decisions`, key, request, options);
      } catch (error) {
        if (isAbortError(error)) throw abortedError();
        throw unavailableError(undefined, "Could not reach OpenAI Decisions.");
      }
      if (response.status === 401 || response.status === 403) throw invalidKeyError(openAiErrorMessage(response.body));
      if (response.status === 429) throw rateLimitedError(openAiErrorMessage(response.body));
      if (response.status >= 500) throw unavailableError(response.status, openAiErrorMessage(response.body));
      if (response.status < 200 || response.status >= 300) throw badRequestError(openAiErrorMessage(response.body) ?? `HTTP ${response.status}`, response.status);
      const body = response.body as { answers?: unknown; model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | undefined;
      if (!body || !Array.isArray(body.answers)) throw invalidResponseError("OpenAI Decisions returned no answers.");
      const answers: Record<string, Record<string, number>> = {};
      for (const entry of body.answers as { name?: unknown; probabilities?: { value?: unknown; probability?: unknown }[] }[]) {
        if (typeof entry?.name !== "string") continue;
        const probabilities: Record<string, number> = {};
        for (const p of Array.isArray(entry.probabilities) ? entry.probabilities : []) {
          if (typeof p?.value === "string" && typeof p.probability === "number" && Number.isFinite(p.probability)) probabilities[p.value] = p.probability;
        }
        answers[entry.name] = probabilities;
      }
      return {
        answers,
        model: typeof body.model === "string" ? body.model : request.model,
        usage: { input_tokens: finite(body.usage?.input_tokens), output_tokens: finite(body.usage?.output_tokens) },
      };
    },
  };
}

/** Jev's question contract on the Decisions endpoint: choice and score become choice questions, noul a true/false choice. */
export function toDecisionsQuestion(name: string, question: JevQuestion): DecisionsQuestion {
  const instructions = describe(question.instructions ?? name);
  if (question.type === "noul") {
    return {
      type: "choice",
      name,
      instructions,
      choices: [
        { value: "true", description: describe(question.criteria?.true ?? "yes") },
        { value: "false", description: describe(question.criteria?.false ?? "no") },
      ],
    };
  }
  return { type: "choice", name, instructions, choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description: describe(description) })) };
}

function normalized(probabilities: Record<string, number>, allowed: readonly string[]) {
  const kept = Object.fromEntries(allowed.map((value) => [value, probabilities[value] ?? 0]));
  const total = Object.values(kept).reduce((sum, p) => sum + p, 0);
  if (total <= 0) throw invalidResponseError("OpenAI Decisions gave no probability to any option.");
  return Object.fromEntries(Object.entries(kept).map(([value, p]) => [value, p / total]));
}

/** Turns a Decisions probability table into Jev's validated answer shape for each question type. */
export function toJevAnswer(question: JevQuestion, probabilities: Record<string, number>): JevAnswer {
  if (question.type === "noul") {
    const table = normalized(probabilities, ["true", "false"]);
    return { type: "noul", noul: table.true } as JevAnswer;
  }
  const table = normalized(probabilities, Object.keys(question.criteria));
  let best = "";
  let confidence = -1;
  for (const [value, p] of Object.entries(table)) if (p > confidence) [best, confidence] = [value, p];
  if (question.type === "score") return { type: "score", score: Number(best), probabilities: table, confidence } as JevAnswer;
  return { type: "choice", choice: best, probabilities: table, confidence } as JevAnswer;
}

export async function judgeWithDecisions(
  client: DecisionsClient,
  model: string,
  request: JevAskRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JevAskResult> {
  const started = Date.now();
  const entries = Object.entries(request.questions);
  const asked = await client.ask(
    { model, input: typeof request.state === "string" ? request.state : JSON.stringify(request.state ?? null), questions: entries.map(([name, q]) => toDecisionsQuestion(name, q)) },
    options,
  );
  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of entries) {
    const probabilities = asked.answers[name];
    if (!probabilities) throw invalidResponseError(`OpenAI Decisions did not answer "${name}".`);
    answers[name] = toJevAnswer(question, probabilities);
  }
  return { answers, model: asked.model, usage: asked.usage, latencyMs: Date.now() - started };
}
