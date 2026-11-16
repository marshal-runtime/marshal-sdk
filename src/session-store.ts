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
  /** Model round trips the backend counted (the SDK's num_turns), summed over turns; absent in older records. */
  modelTurns?: number;
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
  /**
   * The desktop's durable session partition (CLAUDE.md invariant): which runtime owns the session. Records written
   * before it existed read it from `runtime`.
   */
  runtimeId: string;
  /** The runtime's compatibility transport family, as the desktop's index rows carry it (local runtimes: "copilot"). */
  backendOrigin: string;
  model?: string;
  reasoningEffort?: string;
  native: NativeSessionRef;
  parentId?: string;
  /** A lane: the session that started it. A lane has no parent; nothing reports back to its launcher on its own. */
  launchedBy?: string;
  fork?: SessionFork;
  /** Agent profile: extension identities whose capabilities and skills this session sees (absent: all installed). */
  extensions?: string[];
  /** Agent profile: skill names the session sees besides its extensions' skills (absent with extensions: only theirs). */
  skills?: string[];
  /** Agent profile: the backend's built-in tools the session keeps (absent: the host's default surface). */
  nativeTools?: string[];
  /** Agent profile: sections appended to the host prompt. */
  systemPromptAppend?: string;
  /** Agent profile: the MCP server names this session keeps (absent: all). */
  mcpServerNames?: string[];
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
  extensions?: readonly string[];
  skills?: readonly string[];
  nativeTools?: readonly string[];
  systemPromptAppend?: string;
  mcpServerNames?: readonly string[];
  workspace?: string;
  labels?: Record<string, string>;
}

const INDEX_FILE = "index.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const EVENTS_FILE = "events.jsonl";
/** The most often a streamed delta refreshes a session's activity time. */
const TOUCH_INTERVAL_MS = 1000;
const TODOS_FILE = "todos.json";
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
/** The names the backend's init event lists: observed, not requested. */
export interface SessionEnvironment {
  tools: string[];
  mcpServers: string[];
  skills: string[];
}

/**
 * What the agent port, the host and the kits need from a session store. `FileSessionStore` keeps everything on disk;
 * the org store (org-store/) publishes it to the bucket after a session goes idle and keeps the backend's transcript there.
 */
export interface SessionStore {
  /** Where this store's run began: every session it creates carries it. */
  readonly origin: { runId: string; host: { id: string; kind: string } };
  /** A local folder the store keeps files in (a cloud store: its cache), for readers that open session files directly. */
  readonly root: string;
  create(input: NewSession): SessionRecord;
  get(id: string): SessionRecord | undefined;
  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "schemaVersion">>): SessionRecord;
  addUsage(id: string, usage: Partial<SessionUsage>): SessionRecord;
  list(filter?: SessionFilter): SessionRecord[];
  appendMessage(id: string, message: Omit<TranscriptMessage, "id" | "timestamp">): TranscriptMessage;
  messages(id: string, limit?: number): TranscriptMessage[];
  setTodos(id: string, plan: SessionPlan): void;
  todos(id: string): SessionPlan | undefined;
  events(id: string): { seq: number; at: string; event: unknown }[];
  appendEvent(id: string, event: unknown): void;
  touch(id: string): void;
  activity(id: string): { eventCount: number; lastEventAt?: string; environment?: SessionEnvironment };
  setEnvironment(id: string, environment: SessionEnvironment): void;
  /** Word search over titles, labels and transcripts, best first. */
  search(query: string, limit?: number): SessionSearchHit[];
  /** The backend's own transcript store for this host's sessions (Claude Agent SDK `sessionStore`), when it keeps one. */
  transcripts?: BackendTranscriptStore;
}

export interface SessionPlan {
  todos: { id: string; title: string; status: string }[];
  goalLabel?: string;
  updatedAt: string;
}

/** The Claude Agent SDK's `SessionStore` adapter shape (alpha), restated so this module needs no SDK import. */
export interface BackendTranscriptStore {
  append(key: { projectKey: string; sessionId: string; subpath?: string }, entries: { type: string; uuid?: string; [k: string]: unknown }[]): Promise<void>;
  load(key: { projectKey: string; sessionId: string; subpath?: string }): Promise<{ type: string; uuid?: string; [k: string]: unknown }[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  delete?(key: { projectKey: string; sessionId: string; subpath?: string }): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
  /** A store whose objects live per Marshal session returns the view for that session; the port passes it to the backend each turn. */
  bind?(marshalSessionId: string): BackendTranscriptStore;
}

export class FileSessionStore implements SessionStore {
  /** Set by the host when an org store keeps the backend's transcripts. */
  transcripts?: BackendTranscriptStore;
  private readonly records = new Map<string, SessionRecord>();
  private readonly counts = new Map<string, number>();
  private readonly lastEventAt = new Map<string, string>();
  private readonly touchedAt = new Map<string, number>();
  private readonly environments = new Map<string, SessionEnvironment>();

  constructor(
    readonly root: string,
    readonly origin: { runId: string; host: { id: string; kind: string } },
  ) {
    fs.mkdirSync(root, { recursive: true });
    for (const record of readIndex(root)) this.records.set(record.id, withPartition(record));
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
      runtimeId: input.runtime,
      backendOrigin: backendOriginOf(input.runtime),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      native: input.native,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.launchedBy ? { launchedBy: input.launchedBy } : {}),
      ...(input.fork ? { fork: input.fork } : {}),
      ...(input.extensions ? { extensions: [...input.extensions] } : {}),
      ...(input.skills ? { skills: [...input.skills] } : {}),
      ...(input.nativeTools ? { nativeTools: [...input.nativeTools] } : {}),
      ...(input.systemPromptAppend ? { systemPromptAppend: input.systemPromptAppend } : {}),
      ...(input.mcpServerNames ? { mcpServerNames: [...input.mcpServerNames] } : {}),
      runId: this.origin.runId,
      host: this.origin.host,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      labels: { ...input.labels },
      messageCount: 0,
      usage: { ...EMPTY_USAGE },
    };
    fs.mkdirSync(path.join(this.root, record.id), { recursive: true });
    this.records.set(record.id, record);
    this.writeIndex();
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "schemaVersion">>): SessionRecord {
    const current = this.require(id);
    const next: SessionRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    this.writeIndex();
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
        modelTurns: (current.modelTurns ?? 0) + (usage.modelTurns ?? 0),
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

  /** The session's plan (`marshal.tool.setSessionTodos`), replaced whole; `todos.json` beside its transcript. */
  setTodos(id: string, plan: SessionPlan): void {
    const target = path.join(this.root, id, TODOS_FILE);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(plan, null, 2)}\n`);
    fs.renameSync(`${target}.tmp`, target);
  }

  todos(id: string): SessionPlan | undefined {
    try {
      // SF-4: our own file; a corrupt one reads as no plan.
      return JSON.parse(fs.readFileSync(path.join(this.root, id, TODOS_FILE), "utf8")) as never;
    } catch {
      return undefined;
    }
  }

  events(id: string): { seq: number; at: string; event: unknown }[] {
    return readJsonLines<{ seq: number; at: string; event: unknown }>(path.join(this.root, id, EVENTS_FILE));
  }

  appendEvent(id: string, event: unknown): void {
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    const at = new Date().toISOString();
    this.lastEventAt.set(id, at);
    fs.appendFileSync(path.join(this.root, id, EVENTS_FILE), `${JSON.stringify({ seq: count, at, event })}\n`);
  }

  /**
   * The backend is still producing something (a streamed delta of a message that has not landed yet): refreshes
   * lastEventAt, at most once a second, and nothing else (no event row, no count), so a long tool call or a long
   * answer is not read as silence.
   */
  touch(id: string): void {
    const now = Date.now();
    if (now - (this.touchedAt.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(id, now);
    this.lastEventAt.set(id, new Date(now).toISOString());
  }

  /** How far a session's backend has got in this process: events appended and when the latest one came. */
  activity(id: string): { eventCount: number; lastEventAt?: string; environment?: SessionEnvironment } {
    const lastEventAt = this.lastEventAt.get(id);
    const environment = this.environments.get(id);
    return { eventCount: this.counts.get(id) ?? 0, ...(lastEventAt ? { lastEventAt } : {}), ...(environment ? { environment } : {}) };
  }

  /** What the backend reported at the start of the session's latest turn: the tools, MCP servers and skills it really has. */
  setEnvironment(id: string, environment: SessionEnvironment): void {
    this.environments.set(id, environment);
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

  private writeIndex(): void {
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

/** The desktop's compatibility origin of a runtime id; runtimes the desktop doesn't know keep their own id. */
export function backendOriginOf(runtimeId: string): string {
  return LOCAL_RUNTIME_ORIGINS[runtimeId] ?? runtimeId;
}

// common/runtime-config.ts: the local adapters keep the legacy Copilot transport family for persisted-row compatibility.
const LOCAL_RUNTIME_ORIGINS: Record<string, string> = { claude: "copilot", codex: "copilot", cursor: "copilot", copilot: "copilot", gateway: "gateway" };

function withPartition(record: SessionRecord): SessionRecord {
  const runtimeId = record.runtimeId ?? record.runtime;
  return { ...record, runtimeId, backendOrigin: record.backendOrigin ?? backendOriginOf(runtimeId) };
}
