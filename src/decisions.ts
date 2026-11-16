import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import type { ClaudeAgentPort } from "./agent-port.js";
import { callerSessionId } from "./agent-provider.js";
import type { SessionStore } from "./session-store.js";

export type DecisionKind = "decision" | "question" | "gap";

export interface DecisionOption {
  title: string;
  description?: string;
}

export interface DecisionAnswer {
  /** The option picked, when the person picked one. */
  choice?: number;
  /** The option's title, or the person's own words. */
  text: string;
  by: { personId?: string; name?: string };
  route: string;
  at: string;
}

/** One record of the run: a decision a session took, a question for a person, or a gap. */
export interface DecisionEntry {
  id: string;
  kind: DecisionKind;
  text: string;
  /** For a question: the default the session went ahead with. */
  defaultTaken?: string;
  ref?: string;
  options?: DecisionOption[];
  recommendedIndex?: number;
  /** askUser: the session waits for this answer as its next message. */
  asked?: boolean;
  /** Which route(s) to deliver to (route ids); all routes when omitted. */
  to?: string[];
  sessionId?: string;
  sessionTitle?: string;
  runId: string;
  host: string;
  createdAt: string;
  status: "recorded" | "open" | "answered";
  answer?: DecisionAnswer;
  deliveries: { route: string; delivered: boolean; ref?: string; error?: string }[];
}

/** An answer coming back from a person through a route. */
export interface InboundAnswer {
  questionId: string;
  /** Index into the question's options. */
  choice?: number;
  /** Free text, or the option title. */
  text?: string;
  by?: { personId?: string; name?: string };
  route: string;
}

export interface AnswerResult {
  accepted: boolean;
  error?: string;
  /** The session message the answer became. */
  messageId?: string;
}

/**
 * Carries records and questions to people and brings their answers back. A route is a channel: a file folder (here),
 * a test double (here), WhatsApp for Marley, or a specific Marshal instance (the link adds that one). `deliver` sends
 * one entry; a route that can hear answers calls the sink it got in `start`.
 */
export interface PersonRoute {
  readonly id: string;
  deliver(entry: DecisionEntry): Promise<{ delivered: boolean; ref?: string; error?: string }>;
  start?(sink: (answer: InboundAnswer) => Promise<AnswerResult>): void | Promise<void>;
  stop?(): void | Promise<void>;
}

const LOG_FILE = "decisions.jsonl";
const MAX_OPTIONS = 6;

/**
 * The decisions record of the sessions in one store, kept beside them (`<sessions root>/decisions.jsonl`, one line per
 * entry or answer) so a reader of the store sees them with the run. Answers become messages in the asking session.
 */
export class DecisionDesk {
  private readonly entries = new Map<string, DecisionEntry>();
  private readonly routes = new Map<string, PersonRoute>();
  private readonly file: string;

  constructor(
    private readonly sessions: SessionStore,
    private readonly port: ClaudeAgentPort,
    private readonly log?: (line: string) => void,
  ) {
    this.file = path.join(sessions.root, LOG_FILE);
    for (const line of readLines(this.file)) {
      if (line.type === "entry") this.entries.set(line.entry.id, line.entry);
      else if (line.type === "answer" && this.entries.has(line.id)) {
        this.entries.set(line.id, { ...this.entries.get(line.id)!, status: "answered", answer: line.answer });
      } else if (line.type === "deliveries" && this.entries.has(line.id)) {
        this.entries.set(line.id, { ...this.entries.get(line.id)!, deliveries: line.deliveries });
      }
    }
  }

  /** Adds a route; it starts hearing answers now. Returns the call that removes it. */
  async addRoute(route: PersonRoute): Promise<() => Promise<void>> {
    if (this.routes.has(route.id)) throw new Error(`A route ${route.id} is already registered.`);
    this.routes.set(route.id, route);
    await route.start?.((answer) => this.answer(answer));
    return async () => {
      if (this.routes.get(route.id) !== route) return;
      this.routes.delete(route.id);
      await route.stop?.();
    };
  }

  async stop(): Promise<void> {
    for (const route of [...this.routes.values()]) await route.stop?.();
    this.routes.clear();
  }

  list(filter: { sessionId?: string; runId?: string; kind?: DecisionKind; status?: DecisionEntry["status"] } = {}): DecisionEntry[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          (filter.sessionId === undefined || entry.sessionId === filter.sessionId) &&
          (filter.runId === undefined || entry.runId === filter.runId) &&
          (filter.kind === undefined || entry.kind === filter.kind) &&
          (filter.status === undefined || entry.status === filter.status),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(id: string): DecisionEntry | undefined {
    return this.entries.get(id);
  }

  /** Records an entry and delivers it on the routes. A question with options, or an ask, is open until answered. */
  async record(input: {
    kind: DecisionKind;
    text: string;
    defaultTaken?: string;
    ref?: string;
    options?: DecisionOption[];
    recommendedIndex?: number;
    asked?: boolean;
    to?: string[];
    sessionId?: string;
  }): Promise<DecisionEntry> {
    if (!input.text.trim()) throw invalid("text is required");
    if (input.options && input.options.length > MAX_OPTIONS) throw invalid(`At most ${MAX_OPTIONS} options.`);
    if (input.recommendedIndex !== undefined && !(input.options && input.recommendedIndex >= 0 && input.recommendedIndex < input.options.length)) {
      throw invalid("recommendedIndex must point at an option.");
    }
    const unknownRoute = input.to?.find((id) => !this.routes.has(id));
    if (unknownRoute) throw invalid(`No route ${unknownRoute} on this host.`);
    const session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    const entry: DecisionEntry = {
      id: `${input.kind}-${randomUUID()}`,
      kind: input.kind,
      text: input.text.trim(),
      ...(input.defaultTaken ? { defaultTaken: input.defaultTaken } : {}),
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.options?.length ? { options: input.options } : {}),
      ...(input.recommendedIndex !== undefined ? { recommendedIndex: input.recommendedIndex } : {}),
      ...(input.asked ? { asked: true } : {}),
      ...(input.to?.length ? { to: input.to } : {}),
      ...(session ? { sessionId: session.id, sessionTitle: session.title } : {}),
      runId: session?.runId ?? this.sessions.origin.runId,
      host: this.sessions.origin.host.id,
      createdAt: new Date().toISOString(),
      status: input.kind === "question" ? "open" : "recorded",
      deliveries: [],
    };
    this.entries.set(entry.id, entry);
    this.append({ type: "entry", entry });
    const deliveries: DecisionEntry["deliveries"] = [];
    for (const route of this.routes.values()) {
      if (entry.to && !entry.to.includes(route.id)) continue;
      try {
        deliveries.push({ route: route.id, ...(await route.deliver(entry)) });
      } catch (error) {
        deliveries.push({ route: route.id, delivered: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const delivered = { ...this.entries.get(entry.id)!, deliveries };
    this.entries.set(entry.id, delivered);
    this.append({ type: "deliveries", id: entry.id, deliveries });
    return delivered;
  }

  /**
   * A person answered. The first answer to an open question wins; it is stored and becomes a message in the asking
   * session from that person: `Answer to your question "<question>" (<id>): <answer>`.
   */
  async answer(input: InboundAnswer): Promise<AnswerResult> {
    const entry = this.entries.get(input.questionId);
    if (!entry || entry.kind !== "question") return { accepted: false, error: `No question ${input.questionId}.` };
    if (entry.status === "answered") return { accepted: false, error: "This question is already answered." };
    let text = input.text?.trim() ?? "";
    if (input.choice !== undefined) {
      const option = entry.options?.[input.choice];
      if (!option) return { accepted: false, error: `Option ${input.choice} does not exist.` };
      text = text && text !== option.title ? `${option.title} (${text})` : option.title;
    }
    if (!text) return { accepted: false, error: "An answer needs a choice or text." };
    const answer: DecisionAnswer = {
      ...(input.choice !== undefined ? { choice: input.choice } : {}),
      text,
      by: input.by ?? {},
      route: input.route,
      at: new Date().toISOString(),
    };
    this.entries.set(entry.id, { ...entry, status: "answered", answer });
    this.append({ type: "answer", id: entry.id, answer });
    if (!entry.sessionId) return { accepted: true };
    const delivered = await this.port.deliver({
      messageId: `answer-${entry.id}`,
      from: {
        kind: "person",
        ...(answer.by.name ? { name: answer.by.name } : {}),
        ...(answer.by.personId ? { personId: answer.by.personId } : {}),
      },
      to: { sessionId: entry.sessionId },
      body: `Answer to your question "${entry.text}" (${entry.id}): ${text}`,
      deliveryMode: "queue",
      sentAt: answer.at,
    });
    if (!delivered.accepted) this.log?.(`answer to ${entry.id} not delivered: ${delivered.error}`);
    return { accepted: true, messageId: delivered.messageId, ...(delivered.accepted ? {} : { error: delivered.error }) };
  }

  private append(line: LogLine): void {
    fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }
}

type LogLine =
  | { type: "entry"; entry: DecisionEntry }
  | { type: "deliveries"; id: string; deliveries: DecisionEntry["deliveries"] }
  | { type: "answer"; id: string; answer: DecisionAnswer };

function readLines(file: string): LogLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: LogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as LogLine);
    } catch {
      // A torn last line from a crash.
    }
  }
  return lines;
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-request" });
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

/**
 * A folder a person (or a script acting for one) reads and writes: every entry lands in `outbox/<id>.json`; an
 * answer is a file `inbox/<anything>.json` holding `{questionId, choice?, text?, by?}`, picked up on the next poll and
 * moved to `inbox/done/`.
 */
export class FilePersonRoute implements PersonRoute {
  readonly id: string;
  private sink?: (answer: InboundAnswer) => Promise<AnswerResult>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly folder: string,
    private readonly options: { id?: string; pollMs?: number } = {},
  ) {
    this.id = options.id ?? "file";
    fs.mkdirSync(path.join(folder, "outbox"), { recursive: true });
    fs.mkdirSync(path.join(folder, "inbox", "done"), { recursive: true });
  }

  async deliver(entry: DecisionEntry): Promise<{ delivered: boolean; ref: string }> {
    const file = path.join(this.folder, "outbox", `${entry.id}.json`);
    fs.writeFileSync(file, JSON.stringify(entry, null, 1));
    return { delivered: true, ref: file };
  }

  start(sink: (answer: InboundAnswer) => Promise<AnswerResult>): void {
    this.sink = sink;
    if (this.options.pollMs !== 0) {
      const loop = () => {
        void this.poll().finally(() => {
          if (this.sink) this.timer = setTimeout(loop, this.options.pollMs ?? 2_000).unref();
        });
      };
      this.timer = setTimeout(loop, this.options.pollMs ?? 2_000).unref();
    }
  }

  stop(): void {
    this.sink = undefined;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Reads every answer file in the inbox once; returns what each one did. */
  async poll(): Promise<{ file: string; result: AnswerResult }[]> {
    if (!this.sink) return [];
    const inbox = path.join(this.folder, "inbox");
    const results: { file: string; result: AnswerResult }[] = [];
    for (const name of fs.readdirSync(inbox).filter((item) => item.endsWith(".json")).sort()) {
      const file = path.join(inbox, name);
      let result: AnswerResult;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InboundAnswer>;
        result =
          typeof parsed.questionId === "string"
            ? await this.sink({
                questionId: parsed.questionId,
                ...(typeof parsed.choice === "number" ? { choice: parsed.choice } : {}),
                ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
                ...(parsed.by && typeof parsed.by === "object" ? { by: parsed.by } : {}),
                route: this.id,
              })
            : { accepted: false, error: "questionId is missing." };
      } catch (error) {
        result = { accepted: false, error: error instanceof Error ? error.message : String(error) };
      }
      fs.renameSync(file, path.join(inbox, "done", name));
      results.push({ file: name, result });
    }
    return results;
  }
}

/** An in-memory route for tests: what it was sent, and `answer()` to play the person. */
export class TestPersonRoute implements PersonRoute {
  readonly sent: DecisionEntry[] = [];
  private sink?: (answer: InboundAnswer) => Promise<AnswerResult>;

  constructor(readonly id = "test") {}

  async deliver(entry: DecisionEntry): Promise<{ delivered: boolean; ref: string }> {
    this.sent.push(entry);
    return { delivered: true, ref: `test:${this.sent.length}` };
  }

  start(sink: (answer: InboundAnswer) => Promise<AnswerResult>): void {
    this.sink = sink;
  }

  stop(): void {
    this.sink = undefined;
  }

  answer(questionId: string, answer: { choice?: number; text?: string; by?: { personId?: string; name?: string } }): Promise<AnswerResult> {
    if (!this.sink) throw new Error("The route is not started.");
    return this.sink({ questionId, ...answer, route: this.id });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Capabilities: the desktop's recordDecision and askUser by name, plus reading the record and answering.

const VERSION = "1.0.0";
const OPTION = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 1000 } },
} as const;
const DELIVERY = {
  type: "object",
  additionalProperties: false,
  required: ["route", "delivered"],
  properties: { route: { type: "string" }, delivered: { type: "boolean" }, ref: { type: "string" }, error: { type: "string" } },
} as const;
const ENTRY = { type: "object" };
const result = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["success"],
  properties: { success: { type: "boolean" }, error: { type: "string" }, ...properties },
});
const OPERATIONS: Record<string, { title: string; description: string; risk: "low" | "medium"; input: object; output: object }> = {
  "marshal.tool.recordDecision": {
    title: "Record a decision, question or gap",
    description:
      "Record, when it happens, a decision you made on the person's behalf, a question only they can settle (with the default you took and up to 6 options), or a gap (not done, not verified, partly working). Stored with this run and sent on the host's person routes; an answer to a question arrives as a message in this session.",
    risk: "low",
    input: {
      type: "object",
      required: ["kind", "text"],
      properties: {
        kind: { enum: ["decision", "question", "gap"] },
        text: { type: "string", minLength: 1, maxLength: 4000 },
        defaultTaken: { type: "string", maxLength: 2000 },
        ref: { type: "string", maxLength: 2000 },
        options: { type: "array", maxItems: MAX_OPTIONS, items: { type: "string", minLength: 1, maxLength: 200 } },
        request: { type: "string", maxLength: 64 },
        to: { type: "array", items: { type: "string" } },
      },
    },
    output: result({ id: { type: "string" }, deliveries: { type: "array", items: DELIVERY } }),
  },
  "marshal.tool.askUser": {
    title: "Ask a person a question with options",
    description:
      "Ask a person (through the host's person routes, or the ones named in `to`) a short question with 2-5 answers. The answer arrives later as a message in this session from that person; end your turn after asking and carry on with what does not depend on it.",
    risk: "medium",
    input: {
      type: "object",
      required: ["question", "answers"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 1000 },
        answers: { type: "array", minItems: 2, maxItems: 5, items: OPTION },
        recommendedIndex: { type: "integer", minimum: 0, maximum: 4 },
        to: { type: "array", items: { type: "string" } },
      },
    },
    output: result({ questionId: { type: "string" }, deliveries: { type: "array", items: DELIVERY }, note: { type: "string" } }),
  },
  "marshal.decisions.list": {
    title: "Read the decisions record",
    description: "Decisions, questions and gaps of this host's sessions, with answers; filter by session, run, kind or status.",
    risk: "low",
    input: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        runId: { type: "string" },
        kind: { enum: ["decision", "question", "gap"] },
        status: { enum: ["recorded", "open", "answered"] },
      },
    },
    output: result({ entries: { type: "array", items: ENTRY } }),
  },
  "marshal.decisions.answer": {
    title: "Answer an open question",
    description: "Answer a question a session asked (a person, or a route acting for one). The first answer wins and reaches the session as a message.",
    risk: "medium",
    input: {
      type: "object",
      required: ["questionId"],
      properties: {
        questionId: { type: "string", minLength: 1 },
        choice: { type: "integer", minimum: 0 },
        text: { type: "string", maxLength: 4000 },
        by: { type: "object", properties: { personId: { type: "string" }, name: { type: "string" } } },
        route: { type: "string", maxLength: 128 },
      },
    },
    output: result({ accepted: { type: "boolean" }, messageId: { type: "string" } }),
  },
};

export function createDecisionsProvider(desk: DecisionDesk): CapabilityProvider {
  const descriptors = Object.entries(OPERATIONS).map(([name, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "decision", "question", "person"],
    inputSchema: spec.input,
    outputSchema: spec.output,
    permissions: [{ permission: name, risk: spec.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marshal.decisions",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as Record<string, any>;
      const caller = callerSessionId(context);
      try {
        switch (name) {
          case "marshal.tool.recordDecision": {
            const entry = await desk.record({
              kind: input.kind,
              text: String(input.text ?? ""),
              ...(input.defaultTaken ? { defaultTaken: String(input.defaultTaken) } : {}),
              ...(input.ref ? { ref: String(input.ref) } : {}),
              ...(Array.isArray(input.options) ? { options: (input.options as string[]).map((title) => ({ title })) } : {}),
              ...(Array.isArray(input.to) ? { to: input.to as string[] } : {}),
              ...(caller ? { sessionId: caller } : {}),
            });
            return { output: { success: true, id: entry.id, deliveries: entry.deliveries } };
          }
          case "marshal.tool.askUser": {
            const entry = await desk.record({
              kind: "question",
              text: String(input.question ?? ""),
              options: input.answers as DecisionOption[],
              ...(typeof input.recommendedIndex === "number" ? { recommendedIndex: input.recommendedIndex } : {}),
              asked: true,
              ...(Array.isArray(input.to) ? { to: input.to as string[] } : {}),
              ...(caller ? { sessionId: caller } : {}),
            });
            return {
              output: {
                success: true,
                questionId: entry.id,
                deliveries: entry.deliveries,
                note: entry.deliveries.some((delivery) => delivery.delivered)
                  ? "Asked. The answer arrives as a message in this session; end your turn and carry on with what does not depend on it."
                  : "Recorded, but no route delivered it: nobody has seen this question yet. Go on with your default.",
              },
            };
          }
          case "marshal.decisions.list":
            return { output: { success: true, entries: desk.list(input) } };
          case "marshal.decisions.answer": {
            const answered = await desk.answer({
              questionId: String(input.questionId),
              ...(typeof input.choice === "number" ? { choice: input.choice } : {}),
              ...(typeof input.text === "string" ? { text: input.text } : {}),
              ...(input.by ? { by: input.by } : {}),
              route: typeof input.route === "string" ? input.route : "capability",
            });
            return {
              output: {
                success: answered.accepted,
                accepted: answered.accepted,
                ...(answered.messageId ? { messageId: answered.messageId } : {}),
                ...(answered.error ? { error: answered.error } : {}),
              },
            };
          }
          default:
            throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
        }
      } catch (error) {
        if ((error as { code?: string }).code === "invalid-request") return { output: { success: false, error: (error as Error).message } };
        throw error;
      }
    },
  } as unknown as CapabilityProvider;
}
