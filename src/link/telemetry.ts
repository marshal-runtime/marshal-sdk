// Telemetry of a session or run, computed from the backend events a host writes to events.jsonl.
// Pure functions: the link server and the viewer's local-folder host both use them.

/** One line of events.jsonl as FileSessionStore.appendEvent writes it. */
export interface EventLine {
  seq: number;
  at: string;
  event: Record<string, any>;
}

export interface Telemetry {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  /** Turns the host ran (one per message sent to the session). */
  turns: number;
  /** Model round trips inside those turns, as the backend counts them. */
  modelRoundTrips: number;
  toolCalls: Record<string, number>;
  toolCallTotal: number;
  toolErrors: number;
  turnDurations: { count: number; totalMs: number; averageMs: number; medianMs: number; maxMs: number; lastMs: number[] };
  errors: { count: number; last: { at: string; text: string }[] };
  models: Record<string, { costUsd: number; outputTokens: number }>;
  events: number;
  firstEventAt?: string;
  lastEventAt?: string;
}

const MAX_DURATIONS = 50;
const MAX_ERRORS = 10;
const MAX_ERROR_TEXT = 300;

export function emptyTelemetry(): Telemetry {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    turns: 0,
    modelRoundTrips: 0,
    toolCalls: {},
    toolCallTotal: 0,
    toolErrors: 0,
    turnDurations: { count: 0, totalMs: 0, averageMs: 0, medianMs: 0, maxMs: 0, lastMs: [] },
    errors: { count: 0, last: [] },
    models: {},
    events: 0,
  };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function noteError(telemetry: Telemetry, at: string, text: string): void {
  telemetry.errors.count += 1;
  telemetry.errors.last.push({ at, text: text.slice(0, MAX_ERROR_TEXT) });
  if (telemetry.errors.last.length > MAX_ERRORS) telemetry.errors.last.shift();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join(" ");
}

/** Every duration seen so far, kept beside the telemetry so medians stay exact while lines stream in. */
export class TelemetryBuilder {
  readonly telemetry = emptyTelemetry();
  private readonly durations: number[] = [];

  add(line: EventLine): void {
    const telemetry = this.telemetry;
    const event = line.event ?? {};
    telemetry.events += 1;
    telemetry.firstEventAt ??= line.at;
    telemetry.lastEventAt = line.at;
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        telemetry.toolCalls[block.name] = (telemetry.toolCalls[block.name] ?? 0) + 1;
        telemetry.toolCallTotal += 1;
      }
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "tool_result" && block.is_error === true) telemetry.toolErrors += 1;
      }
    } else if (event.type === "result") {
      telemetry.turns += 1;
      telemetry.modelRoundTrips += num(event.num_turns);
      telemetry.costUsd += num(event.total_cost_usd);
      telemetry.tokens.input += num(event.usage?.input_tokens);
      telemetry.tokens.output += num(event.usage?.output_tokens);
      telemetry.tokens.cacheRead += num(event.usage?.cache_read_input_tokens);
      telemetry.tokens.cacheWrite += num(event.usage?.cache_creation_input_tokens);
      for (const [model, usage] of Object.entries((event.modelUsage ?? {}) as Record<string, any>)) {
        const entry = (telemetry.models[model] ??= { costUsd: 0, outputTokens: 0 });
        entry.costUsd += num(usage?.costUSD);
        entry.outputTokens += num(usage?.outputTokens);
      }
      const duration = num(event.duration_ms);
      if (duration > 0) this.durations.push(duration);
      if (event.is_error === true) {
        noteError(telemetry, line.at, typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "error"));
      }
    } else if (event.type === "system" && /error/i.test(String(event.subtype ?? ""))) {
      noteError(telemetry, line.at, contentText(event.message ?? event.error ?? event.subtype));
    }
  }

  result(): Telemetry {
    const sorted = [...this.durations].sort((left, right) => left - right);
    const totalMs = sorted.reduce((sum, value) => sum + value, 0);
    this.telemetry.turnDurations = {
      count: sorted.length,
      totalMs,
      averageMs: sorted.length ? Math.round(totalMs / sorted.length) : 0,
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
      maxMs: sorted.at(-1) ?? 0,
      lastMs: this.durations.slice(-MAX_DURATIONS),
    };
    return this.telemetry;
  }
}

export function telemetryFromEvents(lines: Iterable<EventLine>): Telemetry {
  const builder = new TelemetryBuilder();
  for (const line of lines) builder.add(line);
  return builder.result();
}

/** A run's telemetry: the sum of its sessions' (durations are pooled, errors keep the latest). */
export function combineTelemetry(parts: readonly Telemetry[]): Telemetry {
  const total = emptyTelemetry();
  const durations: number[] = [];
  for (const part of parts) {
    total.tokens.input += part.tokens.input;
    total.tokens.output += part.tokens.output;
    total.tokens.cacheRead += part.tokens.cacheRead;
    total.tokens.cacheWrite += part.tokens.cacheWrite;
    total.costUsd += part.costUsd;
    total.turns += part.turns;
    total.modelRoundTrips += part.modelRoundTrips;
    total.toolCallTotal += part.toolCallTotal;
    total.toolErrors += part.toolErrors;
    total.events += part.events;
    for (const [name, count] of Object.entries(part.toolCalls)) total.toolCalls[name] = (total.toolCalls[name] ?? 0) + count;
    for (const [model, usage] of Object.entries(part.models)) {
      const entry = (total.models[model] ??= { costUsd: 0, outputTokens: 0 });
      entry.costUsd += usage.costUsd;
      entry.outputTokens += usage.outputTokens;
    }
    total.errors.count += part.errors.count;
    total.errors.last.push(...part.errors.last);
    durations.push(...part.turnDurations.lastMs);
    if (part.firstEventAt && (!total.firstEventAt || part.firstEventAt < total.firstEventAt)) total.firstEventAt = part.firstEventAt;
    if (part.lastEventAt && (!total.lastEventAt || part.lastEventAt > total.lastEventAt)) total.lastEventAt = part.lastEventAt;
  }
  total.errors.last = total.errors.last.sort((left, right) => left.at.localeCompare(right.at)).slice(-MAX_ERRORS);
  const sorted = [...durations].sort((left, right) => left - right);
  const counted = parts.reduce((sum, part) => sum + part.turnDurations.count, 0);
  const totalMs = parts.reduce((sum, part) => sum + part.turnDurations.totalMs, 0);
  total.turnDurations = {
    count: counted,
    totalMs,
    averageMs: counted ? Math.round(totalMs / counted) : 0,
    medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
    maxMs: Math.max(0, ...parts.map((part) => part.turnDurations.maxMs)),
    lastMs: sorted.slice(-MAX_DURATIONS),
  };
  return total;
}

/** What a session is doing right now, from one backend event: the live indicator's line. */
export interface Activity {
  seq: number;
  at: string;
  kind: "init" | "tool" | "text" | "result";
  name?: string;
  chars?: number;
  ok?: boolean;
  durationMs?: number;
  costUsd?: number;
}

export function activityOf(line: EventLine): Activity[] {
  const event = line.event ?? {};
  const base = { seq: line.seq, at: line.at };
  if (event.type === "system" && event.subtype === "init") return [{ ...base, kind: "init" }];
  if (event.type === "result") {
    return [{ ...base, kind: "result", ok: event.is_error !== true, durationMs: num(event.duration_ms), costUsd: num(event.total_cost_usd) }];
  }
  if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return [];
  const out: Activity[] = [];
  for (const block of event.message.content) {
    if (block?.type === "tool_use" && typeof block.name === "string") out.push({ ...base, kind: "tool", name: block.name });
    else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ ...base, kind: "text", chars: block.text.length });
    }
  }
  return out;
}
