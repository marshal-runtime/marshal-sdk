import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MessageSender } from "./session-messages.js";

export type SessionState = "running" | "idle" | "failed";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

/** Where the backend keeps its own copy of the conversation, so another Marshal host can resume it. */
export interface NativeSessionRef {
  kind: "claude";
  sessionId?: string;
  cwd: string;
  configDir?: string;
  /** A fork that has not run yet: its first turn forks this native session (resume + forkSession). */
  forkOf?: string;
}

/** A session forked from its parent: it continues the parent's conversation and reports back when it goes idle. */
export interface SessionFork {
  /** One fork call: every fork it made shares the group. */
  groupId: string;
  /** 1-based position in the call, and how many forks the call made. */
  index: number;
  total: number;
  task: string;
}

/**
 * One Marshal session started by the SDK. The same fields the desktop shows for a chat (title, state,
 * model, parent, workspace) plus where it ran (`host`, `runId`) and free labels to filter by.
 */
export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  source: "marshal-sdk";
  runtime: string;
  model?: string;
  reasoningEffort?: string;
  native: NativeSessionRef;
  parentId?: string;
  /** A lane: the session that started it. A lane has no parent; nothing reports back to its launcher on its own. */
  launchedBy?: string;
  fork?: SessionFork;
  runId: string;
  host: { id: string; kind: string };
  workspace?: string;
  labels: Record<string, string>;
  messageCount: number;
  usage: SessionUsage;
  lastError?: string;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  error?: boolean;
  /** Who sent a user-role message that did not come from the session's own launcher call. */
  from?: MessageSender;
}

export interface SessionFilter {
  runId?: string;
  parentId?: string;
  state?: SessionState;
  labels?: Record<string, string>;
}

export interface SessionSearchHit {
  session: SessionRecord;
  snippet: string;
  score: number;
}

export interface NewSession {
  /** A preset id (a fork's id is written into the conversation it continues). Default: a new id. */
  id?: string;
  title: string;
  runtime: string;
  model?: string;
  reasoningEffort?: string;
  native: NativeSessionRef;
  parentId?: string;
  launchedBy?: string;
  fork?: SessionFork;
  workspace?: string;
  labels?: Record<string, string>;
}

const INDEX_FILE = "index.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const EVENTS_FILE = "events.jsonl";
const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  turns: 0,
};

/**
 * Sessions on disk: `index.json` (one record per session, metadata only), and per session a
 * `transcript.jsonl` (what a person reads) and `events.jsonl` (every backend message, tool calls included).
 * One writer per directory; readers may open it at any time because the index is replaced atomically.
 */
export class FileSessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly counts = new Map<string, number>();

  constructor(
    readonly root: string,
    readonly origin: { runId: string; host: { id: string; kind: string } },
  ) {
    fs.mkdirSync(root, { recursive: true });
    for (const record of readIndex(root)) this.records.set(record.id, record);
  }

  create(input: NewSession): SessionRecord {
    const now = new Date().toISOString();
    if (input.id && this.records.has(input.id)) throw new Error(`Session ${input.id} already exists in ${this.root}.`);
    const record: SessionRecord = {
      schemaVersion: 1,
      id: input.id ?? randomUUID(),
      title: input.title,
      state: "running",
      createdAt: now,
      updatedAt: now,
      source: "marshal-sdk",
      runtime: input.runtime,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      native: input.native,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.launchedBy ? { launchedBy: input.launchedBy } : {}),
      ...(input.fork ? { fork: input.fork } : {}),
      runId: this.origin.runId,
      host: this.origin.host,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      labels: { ...input.labels },
      messageCount: 0,
      usage: { ...EMPTY_USAGE },
    };
    fs.mkdirSync(path.join(this.root, record.id), { recursive: true });
    this.records.set(record.id, record);
    this.flush();
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "schemaVersion">>): SessionRecord {
    const current = this.require(id);
    const next: SessionRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    this.flush();
    return next;
  }

  addUsage(id: string, usage: Partial<SessionUsage>): SessionRecord {
    const current = this.require(id).usage;
    return this.update(id, {
      usage: {
        inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
        cacheReadTokens: current.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: current.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        costUsd: current.costUsd + (usage.costUsd ?? 0),
        turns: current.turns + (usage.turns ?? 0),
      },
    });
  }

  list(filter: SessionFilter = {}): SessionRecord[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          (filter.runId === undefined || record.runId === filter.runId) &&
          (filter.parentId === undefined || record.parentId === filter.parentId) &&
          (filter.state === undefined || record.state === filter.state) &&
          Object.entries(filter.labels ?? {}).every(([key, value]) => record.labels[key] === value),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  appendMessage(
    id: string,
    message: Omit<TranscriptMessage, "id" | "timestamp">,
  ): TranscriptMessage {
    const full: TranscriptMessage = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...message,
    };
    fs.appendFileSync(path.join(this.root, id, TRANSCRIPT_FILE), `${JSON.stringify(full)}\n`);
    this.update(id, { messageCount: this.require(id).messageCount + 1 });
    return full;
  }

  messages(id: string, limit?: number): TranscriptMessage[] {
    const all = readJsonLines<TranscriptMessage>(path.join(this.root, id, TRANSCRIPT_FILE));
    return limit === undefined ? all : all.slice(-limit);
  }

  appendEvent(id: string, event: unknown): void {
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    fs.appendFileSync(
      path.join(this.root, id, EVENTS_FILE),
      `${JSON.stringify({ seq: count, at: new Date().toISOString(), event })}\n`,
    );
  }

  /** Word search over titles, labels and transcripts. A stand-in for the desktop's recall index. */
  search(query: string, limit = 10): SessionSearchHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: SessionSearchHit[] = [];
    for (const session of this.records.values()) {
      const head = `${session.title} ${Object.values(session.labels).join(" ")}`.toLowerCase();
      let score = words.filter((word) => head.includes(word)).length * 3;
      let snippet = session.title;
      for (const message of this.messages(session.id)) {
        const text = message.content.toLowerCase();
        const matched = words.filter((word) => text.includes(word));
        if (matched.length === 0) continue;
        score += matched.length;
        if (snippet === session.title) {
          const at = Math.max(0, text.indexOf(matched[0]!) - 60);
          snippet = message.content.slice(at, at + 200);
        }
      }
      if (score > 0) hits.push({ session, snippet, score });
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`No session ${id} in ${this.root}.`);
    return record;
  }

  private flush(): void {
    const file = path.join(this.root, INDEX_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.records.values()], null, 1));
    fs.renameSync(temporary, file);
  }
}

function readIndex(root: string): SessionRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, INDEX_FILE), "utf8"));
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : [];
  } catch {
    return [];
  }
}

function readJsonLines<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a crash; the rest of the transcript is still good.
    }
  }
  return rows;
}
