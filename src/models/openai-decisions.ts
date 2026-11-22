// OpenAI Decisions API (POST /v1/decisions): named choice and yes/no (predicate) questions answered with a probability,
// the endpoint a page editor's instant-edit router, zyg-agents' search judge and zygstinct's channel-gateway emoji picker
// call. Same request and answer shape as that page editor's own decisions client; images ride as `input_image` parts on the
// state's user message or in one question's `instructions` (developers.openai.com/api/docs/guides/decisions).
import type { JevAnswer, JevQuestion } from "./jev/api.js";
import { abortedError, badRequestError, invalidKeyError, invalidResponseError, notConnectedError, rateLimitedError, unavailableError } from "./jev/errors.js";
import { openAiErrorMessage } from "./jev/openai.js";
import { isAbortError, postJsonWithRetry, type JevFetch } from "./jev/transport.js";
import { normalizeImages, type JudgeAnswer, type JudgeQuestion, type JudgeRequest, type JudgeResult, type NormalizedImage } from "./judge.js";

export const DEFAULT_DECISIONS_MODEL = "gpt-6-luna";

export interface DecisionsChoice {
  readonly value: string;
  readonly description: string;
}

export type DecisionsPart =
  | { readonly type: "input_text"; readonly text: string }
  | { readonly type: "input_image"; readonly image_url: string; readonly detail?: string };

export type DecisionsQuestion =
  | { readonly type: "choice"; readonly name: string; readonly instructions: string | readonly DecisionsPart[]; readonly choices: readonly DecisionsChoice[] }
  | { readonly type: "predicate"; readonly name: string; readonly instructions: string | readonly DecisionsPart[] };

/** The state: plain text, or one user message of text and image parts. */
export type DecisionsInput = string | readonly { readonly role: "user"; readonly content: readonly DecisionsPart[] }[];

export interface DecisionsAnswers {
  /** Per question name: probability per option. A predicate answer is `{ true: p, false: 1 - p }`. */
  readonly answers: Record<string, Record<string, number>>;
  /** Names of the questions the model declined; they have no entry in `answers`. */
  readonly refused: readonly string[];
  readonly model: string;
  readonly usage: { input_tokens: number; output_tokens: number };
}

export interface DecisionsClient {
  ask(
    request: { input: DecisionsInput; questions: readonly DecisionsQuestion[]; model: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DecisionsAnswers>;
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
      const refused: string[] = [];
      for (const entry of body.answers as { type?: unknown; name?: unknown; probability?: unknown; probabilities?: { value?: unknown; probability?: unknown }[] }[]) {
        if (typeof entry?.name !== "string") continue;
        if (entry.type === "refusal") {
          refused.push(entry.name);
          continue;
        }
        if (entry.type === "predicate" || (entry.probabilities === undefined && typeof entry.probability === "number")) {
          const p = entry.probability;
          if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) answers[entry.name] = { true: p, false: 1 - p };
          else answers[entry.name] = {};
          continue;
        }
        const probabilities: Record<string, number> = {};
        for (const p of Array.isArray(entry.probabilities) ? entry.probabilities : []) {
          // Choice values are typed (a boolean `true` and the string "true" differ); this client only offers strings.
          if ((typeof p?.value === "string" || typeof p?.value === "boolean") && typeof p.probability === "number" && Number.isFinite(p.probability)) {
            probabilities[String(p.value)] = p.probability;
          }
        }
        answers[entry.name] = probabilities;
      }
      return {
        answers,
        refused,
        model: typeof body.model === "string" ? body.model : request.model,
        usage: { input_tokens: finite(body.usage?.input_tokens), output_tokens: finite(body.usage?.output_tokens) },
      };
    },
  };
}

const imageParts = (images: readonly NormalizedImage[]): DecisionsPart[] =>
  images.map((image) => ({ type: "input_image", image_url: image.url, ...(image.detail ? { detail: image.detail } : {}) }));

/** Text instructions, or a part list (text, then that question's own images) when the question carries images. */
function instructionsOf(text: string, images: readonly NormalizedImage[]): string | DecisionsPart[] {
  return images.length === 0 ? text : [{ type: "input_text", text }, ...imageParts(images)];
}

/**
 * Jev's question contract on the Decisions endpoint: choice and score become choice questions, noul a true/false choice
 * (its criteria describe each side), and predicate the endpoint's own yes/no question.
 */
export function toDecisionsQuestion(name: string, question: JudgeQuestion): DecisionsQuestion {
  const images = normalizeImages(question.images, `questions.${name}.images`);
  const instructions = instructionsOf(describe(question.instructions ?? name), images);
  if (question.type === "predicate") return { type: "predicate", name, instructions };
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

/** The state as the endpoint's `input`: the old plain string when there are no images, else one user message. */
export function toDecisionsInput(state: unknown, images: readonly NormalizedImage[]): DecisionsInput {
  const text = typeof state === "string" ? state : JSON.stringify(state ?? null);
  if (images.length === 0) return text;
  return [{ role: "user", content: [{ type: "input_text", text }, ...imageParts(images)] }];
}

function normalized(probabilities: Record<string, number>, allowed: readonly string[]) {
  const kept = Object.fromEntries(allowed.map((value) => [value, probabilities[value] ?? 0]));
  const total = Object.values(kept).reduce((sum, p) => sum + p, 0);
  if (total <= 0) throw invalidResponseError("OpenAI Decisions gave no probability to any option.");
  return Object.fromEntries(Object.entries(kept).map(([value, p]) => [value, p / total]));
}

/** Turns a Decisions probability table into the validated answer shape for each question type. */
export function toJevAnswer(question: JevQuestion, probabilities: Record<string, number>): JevAnswer;
export function toJevAnswer(question: JudgeQuestion, probabilities: Record<string, number>): JudgeAnswer;
export function toJevAnswer(question: JudgeQuestion, probabilities: Record<string, number>): JudgeAnswer {
  if (question.type === "predicate") {
    const p = probabilities.true;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw invalidResponseError("OpenAI Decisions gave no probability for a yes/no question.");
    return { type: "predicate", probability: p };
  }
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

/** Every question of the request in ONE call; a question the model declined comes back as `{type: "refusal"}`. */
export async function judgeWithDecisions(
  client: DecisionsClient,
  model: string,
  request: JudgeRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JudgeResult> {
  const started = Date.now();
  const entries = Object.entries(request.questions);
  if (entries.length === 0) throw badRequestError("A judgement needs at least one question.");
  const questions = entries.map(([name, q]) => toDecisionsQuestion(name, q));
  const input = toDecisionsInput(request.state, normalizeImages(request.images));
  const asked = await client.ask({ model, input, questions }, options);
  const refused = new Set(asked.refused);
  const answers: Record<string, JudgeAnswer> = {};
  for (const [name, question] of entries) {
    if (refused.has(name)) {
      answers[name] = { type: "refusal" };
      continue;
    }
    const probabilities = asked.answers[name];
    if (!probabilities) throw invalidResponseError(`OpenAI Decisions did not answer "${name}".`);
    answers[name] = toJevAnswer(question, probabilities);
  }
  return { answers, model: asked.model, usage: asked.usage, latencyMs: Date.now() - started };
}
