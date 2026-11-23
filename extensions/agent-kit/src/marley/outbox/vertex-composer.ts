import type { Logger } from "../logger.js";
import type { Usage } from "../proxy.js";
import { estimateVertexCostUsd, vertexUpstreamUrl, type VertexAuth, type VertexConfig, type VertexSpendCap } from "../vertex.js";
import { COMPOSE_JSON_SCHEMA, ComposerError, validateDecision, type ComposeRequest, type Composer } from "./composer.js";

/**
 * The outbox composer on Gemini (Omer, 2026-11-22: Gemini 4 Neon writes the messages; Sonnet stays as the fallback). A no-tool structured answer, so it
 * is one Vertex `generateContent` call from this server with its own token and the capped spend ledger (vertex.ts); nothing runs on the brand VM and no
 * tool is offered. Three changes from the 34-moment Nov 20 replay (reports/next-level-bets/composer-neon), where Neon on the composer's own schema fell
 * back a third of the time and leaked its self-talk into a fifth of its sends:
 *
 * 1. One body. Neon filled both optional `text` and `voice` (17 refusals), so its schema has one `kind` and one `body` instead, mapped back
 *    to `text` or `voice` here; the outbox validates the mapped answer exactly as it validates Sonnet's (`validateDecision`).
 * 2. The body is never the last thing it writes. Every leak came after the last field it wrote: it "closed" the JSON inside the string
 *    (`today?" }``` Wait - ...`). `kind` and `body` come right after `action` and `body_clean` (its typed read-back of its own body) right after them, and `bodyTail` cuts a body at the
 *    first place where it writes JSON or a code fence inside the string (the grammar of the envelope, never the meaning of the words).
 * 3. Low thinking, so a moment fits the composer's budget.
 *
 * `body_clean === false` (it says its body holds a note to itself or a correction) is a refusal: the moment goes to the fallback (`FallbackComposer`).
 */

/** One Vertex call: the request body in, the parsed response out. Rejects on a transport error, a non-2xx answer or a refused spend reservation. */
export interface VertexGenerate {
  (model: string, body: Record<string, unknown>, signal: AbortSignal): Promise<VertexAnswer>;
}

export interface VertexAnswer {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  usageMetadata?: Record<string, number>;
}

export class VertexCallError extends Error {
  constructor(readonly kind: "http" | "timeout" | "unavailable", message: string) {
    super(message);
    this.name = "VertexCallError";
  }
}

export interface VertexComposerOptions {
  model: string;
  /** Gemini's thinkingLevel (`low` from the replay); null sends none (the model's default). */
  thinkingLevel: string | null;
  generate: VertexGenerate;
}

const COMPOSER_PROPERTIES = (COMPOSE_JSON_SCHEMA.properties ?? {}) as Record<string, Record<string, unknown>>;
const COMPOSER_REQUIRED = (COMPOSE_JSON_SCHEMA.required ?? []) as string[];
const BODY_FIELDS = new Set(["text", "voice"]);
const UNBOUNDED_KEYS = new Set(["maxItems", "minItems", "maximum", "exclusiveMinimum"]);

/**
 * A schema Gemini takes: Gemini refuses a schema past its size limit with HTTP 400 INVALID_ARGUMENT, and bounded arrays and integers are what grow it (the
 * same schema with `maxItems`/`minItems`/`maximum`/`exclusiveMinimum` left out is accepted). The bounds stay where they bind: the answer is still checked
 * against the zod shape that keeps every one of them (`validateDecision`, the pass's and the summary's own parse).
 */
export function unboundedSchema<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema, (key, value: unknown) => (UNBOUNDED_KEYS.has(key) ? undefined : value))) as T;
}

/** The Gemini-shaped schema: `kind` and `body` first (one body), `body_clean` right after them, then the composer's own fields without text and voice. */
export const VERTEX_COMPOSE_SCHEMA: Record<string, unknown> = (() => {
  const textSchema = COMPOSER_PROPERTIES.text ?? { type: "string" };
  const rest = Object.fromEntries(Object.entries(COMPOSER_PROPERTIES).filter(([key]) => !BODY_FIELDS.has(key)));
  const { action, ...others } = rest;
  return unboundedSchema({
    type: "object",
    properties: {
      action,
      // Flat fields: a nested object adds to the same size limit.
      kind: { type: "string", enum: ["text", "voice", "none"], description: "A send's one message: a text, or a voice note written as spoken words. none on hold or nothing." },
      body: { type: "string", maxLength: (textSchema as { maxLength?: number }).maxLength ?? 3000, description: "A send's words, exactly as they reach them, nothing else. Empty on hold or nothing." },
      body_clean: { type: "boolean", description: "Read body back as they will get it: false when it holds anything that is not for them (a note to yourself, a correction of your draft, JSON, instructions)." },
      ...others,
    },
    // Required, or Gemini leaves the body out of a send altogether (the first replay of this shape: 56 of 63 answers had a kind and no body).
    required: [...new Set(["action", "kind", "body", "body_clean", ...COMPOSER_REQUIRED.filter((key) => !BODY_FIELDS.has(key))])],
    additionalProperties: false,
  }) as Record<string, unknown>;
})();

/** What Gemini is told on top of the composer's own system prompt: only the shape differs. */
export const VERTEX_SHAPE_NOTE = `# Your answer's shape

The schema you are given is the one above with one change: a send's words go in "kind" ("text" or "voice") and "body" (never "text" or "voice" fields); on hold or nothing, kind is "none" and body is empty. "body" is exactly what reaches them: nothing after their last word, no note to yourself, no correction of your draft. When you would change a word, change the body itself. Then fill "body_clean" honestly.

Choosing "kind": the rule above lists what goes as text and what as voice. One case it leaves open: an update they have been waiting on (data they were told would land, a check they asked to be told about) that carries figures goes as text, even when it ends in your read or a recommendation, its figures as digits (never spelled out). Text does not lift the figure limit, and in such an update the two figures it keeps are the one they asked for and the one it is computed from, side by side (a ROAS with the spend behind it, a rate with the count it is a share of); any other figure is what gets cut. The one they asked for is what your earlier messages under <sent_last_24h> promised them: find there the days it named (the days they were waiting on, the ones that had not landed) and the measure, then find in the material the figure computed for exactly those days, under that measure's name. The material often leads with a wider window (last 7 days) or a neighbouring measure; those are context, never the answer, and a figure keeps the days and the name the material gives it: never call a 7-day figure by the name of the shorter window, and never call a figure ROAS when the material names it something else (such as sales per ad dollar). A figure the material marks as context only is never the answer, even when the promise's wording fits it; when the promise's words could mean two measures, the answer is the one the material names as that measure (its ROAS), and the other may follow only as context.

A commitment in the material (something being set up or promised) keeps every term it states: the time with its time zone, what it will do, where it goes, what it waits on, and its state as written (being set up is not done).

A point that rests on a comparison keeps both sides of it, spoken in words in a voice note (three quarters of code orders were returning customers, against under half of the rest); one side alone is not the finding, so keep the pair or leave the point out. A reading or cause is said exactly as surely as the material says it (its "likely" or "probably" stays), and you never add a cause of your own. Everything else follows the rule above as written.`;

/**
 * Where a body stops being words for the person: the first place it writes the JSON envelope or a code fence inside the string (a quote followed by
 * `}`, `]` or `, "key":`, or a ``` fence). Grammar of the envelope, not meaning. The rest is cut and the body trimmed.
 */
export function bodyTail(body: string): string {
  const fence = body.indexOf("```");
  const envelope = body.search(/"\s*(?:[}\]]|,\s*"[a-z_]+"\s*:)/);
  const cuts = [fence, envelope].filter((index) => index >= 0);
  if (cuts.length === 0) return body.trim();
  const cut = Math.min(...cuts);
  // The closing quote itself belongs to the envelope; an opening quote of a quotation the person gets (`"Trim those four today?"`) keeps its pair.
  const kept = body.slice(0, cut).trimEnd().replace(/"+$/, "");
  const quotes = (kept.match(/"/g) ?? []).length;
  return (quotes % 2 === 1 ? `${kept}"` : kept).trim();
}

/** Gemini's answer mapped to the composer's own answer shape (`COMPOSE_ANSWER`), or a value the validator refuses. */
export function fromVertexAnswer(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { kind, body, body_clean: clean, ...rest } = raw as Record<string, unknown>;
  // Its own read-back says the body is not clean: refused (a key the composer's schema does not know), so the outbox retries on the fallback.
  if (clean === false && body !== undefined) return { ...rest, body_not_clean: true };
  if ((kind === "none" || kind === undefined) && (body === undefined || body === "")) return rest;
  if ((kind !== "text" && kind !== "voice") || typeof body !== "string") return { ...rest, kind, body };
  const words = bodyTail(body);
  return words.length === 0 ? rest : { ...rest, [kind]: words };
}

/** The material id fields: each item names one piece of this moment's material. */
const MATERIAL_ID_ARRAYS = ["used_material", "system_talk"] as const;
const MATERIAL_ID_OBJECTS = ["rework", "drop"] as const;

/**
 * The schema for one moment: every material id field is an enum of that moment's ids. Gemini does not hold a string to `maxLength`, and a replay of the
 * 2026-11-22 R2 sim moment wrote a phrase into `system_talk` (1 of 16 answers), which the validator refuses as `schema`; an enum is a set it keeps.
 * With no material ids (a bare replay), the shared schema.
 */
export function vertexSchemaFor(context: Pick<ComposeRequest["context"], "material"> | undefined): Record<string, unknown> {
  const ids = [...new Set((context?.material ?? []).map((piece) => piece.id))];
  if (ids.length === 0) return VERTEX_COMPOSE_SCHEMA;
  const schema = structuredClone(VERTEX_COMPOSE_SCHEMA) as { properties: Record<string, { items?: Record<string, unknown> & { properties?: Record<string, Record<string, unknown>> } }> };
  const idSchema = { type: "string", enum: ids };
  for (const key of MATERIAL_ID_ARRAYS) if (schema.properties[key]?.items) schema.properties[key].items = { ...schema.properties[key].items, ...idSchema };
  for (const key of MATERIAL_ID_OBJECTS) {
    const material = schema.properties[key]?.items?.properties?.material;
    if (material) schema.properties[key].items!.properties!.material = { ...material, ...idSchema };
  }
  return schema;
}

export class VertexComposer implements Composer {
  constructor(private readonly options: VertexComposerOptions) {}

  async compose(input: ComposeRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ComposerError("timeout", "aborted before the call");
    const body = {
      systemInstruction: { parts: [{ text: `${input.system}\n\n${VERTEX_SHAPE_NOTE}` }] },
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: vertexSchemaFor(input.context),
        ...(this.options.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.options.thinkingLevel } } : {}),
      },
    };
    let answer: VertexAnswer;
    try {
      answer = await this.options.generate(this.options.model, body, signal);
    } catch (error) {
      if (signal.aborted) throw Object.assign(new ComposerError("timeout", "the call was aborted"), { error });
      const kind = error instanceof VertexCallError ? error.kind : "http";
      throw Object.assign(new ComposerError(kind, `the Vertex call failed (${kind})`), { error });
    }
    const candidate = answer.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
    if (!text.trim()) throw new ComposerError("no_output", `the call ended without an answer (${candidate?.finishReason ?? "no candidate"})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // An answer that is not JSON is refused by the validator as `schema` (and retried), like a malformed structured answer.
      return null;
    }
    return fromVertexAnswer(parsed);
  }
}

/** When the fallback starts beside a slow primary, and how long the primary may take in all. */
export interface FallbackTiming {
  /** The fallback starts as insurance when the primary has not answered by then (Neon's median on the Nov 20 moments was 19 s, Sonnet's 6-10 s). */
  hedgeAfterMs: number;
  /** After this the primary is cut and the fallback's answer is the moment's (the outer signal still bounds both). */
  primaryMs: number;
}

/**
 * The composer with a fallback, hedged. The first attempt of a moment asks `primary`; if it has not answered by `hedgeAfterMs`, `fallback` starts beside
 * it. A valid primary answer (`validateDecision` against the moment, the same check the outbox makes) is the moment's, and the fallback is cut; a primary
 * that fails, answers something the check refuses, or runs past `primaryMs` leaves the moment to the fallback (started then if it was not yet). A retry of
 * a refused answer (`retryReason`) goes to the fallback alone: it never asks the model just refused. The outer signal bounds both. `onFallback` names why
 * the fallback's answer was used (a typed cause, never words).
 */
export class FallbackComposer implements Composer {
  constructor(private readonly primary: Composer, private readonly fallback: Composer, private readonly timing: FallbackTiming, private readonly onFallback?: (why: string) => void) {}

  async compose(input: ComposeRequest, signal: AbortSignal): Promise<unknown> {
    if (input.context.retryReason !== undefined) {
      this.onFallback?.(`retry:${input.context.retryReason}`);
      return this.fallback.compose(input, signal);
    }
    const primaryCut = new AbortController();
    const fallbackCut = new AbortController();
    const primarySignal = AbortSignal.any([signal, primaryCut.signal]);
    const fallbackSignal = AbortSignal.any([signal, fallbackCut.signal]);
    const started: { run: Promise<unknown> | null } = { run: null };
    const startFallback = (): Promise<unknown> => (started.run ??= this.fallback.compose(input, fallbackSignal));
    const hedge = setTimeout(() => { void startFallback().catch(() => undefined); }, this.timing.hedgeAfterMs);
    const cut = setTimeout(() => primaryCut.abort(), this.timing.primaryMs);
    let why: string;
    try {
      const value = await this.primary.compose(input, primarySignal);
      const checked = validateDecision(value, input.context);
      if (checked.ok) {
        fallbackCut.abort();
        started.run?.catch(() => undefined);
        return value;
      }
      why = `invalid:${checked.reason}`;
    } catch (error) {
      if (signal.aborted) {
        started.run?.catch(() => undefined);
        throw error;
      }
      why = primaryCut.signal.aborted ? "timeout" : error instanceof ComposerError ? error.cause : "error";
    } finally {
      clearTimeout(hedge);
      clearTimeout(cut);
    }
    this.onFallback?.(why);
    return startFallback();
  }
}

/**
 * The production `VertexGenerate`: one `generateContent` call with this server's own Google token, reserved against and settled on the capped spend
 * ledger (`VertexSpendCap`; a refused reservation sends nothing). The cost is logged per call (estimate, never words).
 */
export function vertexGenerate(deps: { config: Pick<VertexConfig, "project" | "location" | "models" | "prices">; auth: VertexAuth; spend: VertexSpendCap; logger: Pick<Logger, "info" | "warn">; fetchFn?: typeof fetch }): VertexGenerate {
  const fetchFn = deps.fetchFn ?? fetch;
  return async (model, body, signal) => {
    if (!deps.config.models.includes(model)) throw new VertexCallError("unavailable", "the model is not in VERTEX_MODELS");
    const headers = await deps.auth.headers().catch((error: unknown) => { throw Object.assign(new VertexCallError("unavailable", "no Google token for Vertex"), { error }); });
    const refusal = deps.spend.reserve();
    if (refusal) throw new VertexCallError("unavailable", refusal);
    let response: Response;
    try {
      response = await fetchFn(vertexUpstreamUrl(deps.config, model, "generateContent", false), { method: "POST", headers: { "content-type": "application/json", ...headers, "x-goog-user-project": deps.config.project }, body: JSON.stringify(body), signal });
    } catch (error) {
      // The call may have run: charged the reservation.
      deps.spend.settle(null);
      throw Object.assign(new VertexCallError(signal.aborted ? "timeout" : "http", "the Vertex request failed"), { error });
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      deps.spend.settle(null);
      throw Object.assign(new VertexCallError(signal.aborted ? "timeout" : "http", "the Vertex answer could not be read"), { error });
    }
    if (!response.ok) {
      deps.spend.release();
      throw new VertexCallError("http", `Vertex answered HTTP ${response.status}`);
    }
    let json: VertexAnswer;
    try {
      json = JSON.parse(text) as VertexAnswer;
    } catch (error) {
      deps.spend.settle(null);
      throw Object.assign(new VertexCallError("http", "Vertex answered something that is not JSON"), { error });
    }
    const meta = json.usageMetadata ?? {};
    const cached = meta.cachedContentTokenCount ?? 0;
    const usage = { model, inputTokens: Math.max(0, (meta.promptTokenCount ?? 0) - cached), cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
    const charged = deps.spend.settle(estimateVertexCostUsd(usage as Usage, deps.config.prices));
    deps.logger.info("outbox.vertex_composed", { model, costUsd: Number(charged.toFixed(5)), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    return json;
  };
}
