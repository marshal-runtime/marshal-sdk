import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  backendOriginOf,
  type BackendTranscriptStore,
  type NewSession,
  type SessionEnvironment,
  type SessionFilter,
  type SessionPlan,
  type SessionRecord,
  type SessionSearchHit,
  type SessionStore,
  type SessionUsage,
  type TranscriptMessage,
} from "../session-store.js";
import { applySchema } from "./schema.js";
import type { ObjectStore, SqlClient } from "./storage.js";
import { CloudTranscriptStore } from "./transcripts.js";

const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
const TOUCH_INTERVAL_MS = 1000;
/** The longest message text indexed for search (the message itself is stored whole). */
const INDEXED_CHARS = 100_000;

export interface CloudSessionStoreOptions {
  sql: SqlClient;
  objects: ObjectStore;
  /** Whose sessions these are (Marley: the brand). Every row and every query carries it; a store never sees another tenant's. */
  tenant: string;
  origin: { runId: string; host: { id: string; kind: string } };
  /** Create the tables when they are missing. Default true. */
  migrate?: boolean;
  /** A local folder for readers that open session files directly. Default: a fresh temporary folder. */
  cacheDir?: string;
  /** Wait this long after a write before the batch goes to the database. Default 50 ms. */
  writeDelayMs?: number;
  /**
   * The hook for semantic search: given the lexical candidates (up to 5x the limit), return them reordered or rescored,
   * for example by embedding similarity. Without it the order is the database's text rank.
   */
  rerank?: (query: string, candidates: SessionSearchHit[]) => Promise<SessionSearchHit[]> | SessionSearchHit[];
  /** Largest transcript batch kept inside a database row. Default 256 KiB. */
  inlineLimitBytes?: number;
  log?: (line: string) => void;
}

interface Queued {
  messages: { sessionId: string; message: TranscriptMessage; seq: number }[];
  events: { sessionId: string; seq: number; at: string; event: unknown }[];
  records: Set<string>;
  todos: Set<string>;
}

/**
 * Sessions of one tenant in Postgres, with transcripts and artifacts in an object store, for every host of that tenant:
 * a brand VM, a server, a laptop. Reads answer from memory (every record of the tenant is loaded when the store opens,
 * a session's messages and events by `hydrate`); writes land in memory at once and go to the database in batches, in
 * order, and `flush` resolves when they are durable. Messages and events are append-only and idempotent (message id,
 * event sequence), so a retried batch cannot duplicate; one writer per session is assumed, as in the file store.
 */
export class CloudSessionStore implements SessionStore {
  readonly root: string;
  readonly origin: SessionStore["origin"];
  readonly transcripts: BackendTranscriptStore;
  private readonly records = new Map<string, SessionRecord>();
  private readonly messageCache = new Map<string, TranscriptMessage[]>();
  private readonly eventCache = new Map<string, { seq: number; at: string; event: unknown }[]>();
  private readonly planCache = new Map<string, SessionPlan>();
  private readonly hydrated = new Set<string>();
  private readonly lastEventAt = new Map<string, string>();
  private readonly touchedAt = new Map<string, number>();
  private readonly environments = new Map<string, SessionEnvironment>();
  private queue: Queued = emptyQueue();
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private failure: Error | undefined;

  private constructor(private readonly options: CloudSessionStoreOptions) {
    this.origin = options.origin;
    this.root = options.cacheDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "marshal-cloud-sessions-"));
    fs.mkdirSync(this.root, { recursive: true });
    this.transcripts = new CloudTranscriptStore({
      sql: options.sql,
      objects: options.objects,
      tenant: options.tenant,
      ...(options.inlineLimitBytes ? { inlineLimitBytes: options.inlineLimitBytes } : {}),
    });
  }

  static async open(options: CloudSessionStoreOptions): Promise<CloudSessionStore> {
    if (!options.tenant) throw new Error("A cloud session store needs a tenant.");
    if (options.migrate !== false) await applySchema(options.sql);
    const store = new CloudSessionStore(options);
    const { rows } = await options.sql.query(`SELECT record FROM marshal_sessions WHERE tenant = $1`, [options.tenant]);
    for (const row of rows) {
      const record = withPartition(row.record as SessionRecord);
      store.records.set(record.id, record);
    }
    return store;
  }

  get tenant(): string {
    return this.options.tenant;
  }

  create(input: NewSession): SessionRecord {
    const now = new Date().toISOString();
    if (input.id && this.records.has(input.id)) throw new Error(`Session ${input.id} already exists for tenant ${this.options.tenant}.`);
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
    this.records.set(record.id, record);
    this.messageCache.set(record.id, []);
    this.eventCache.set(record.id, []);
    this.hydrated.add(record.id);
    this.queue.records.add(record.id);
    this.schedule();
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  update(id: string, patch: Partial<Omit<SessionRecord, "id" | "schemaVersion">>): SessionRecord {
    const next: SessionRecord = { ...this.require(id), ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, next);
    this.queue.records.add(id);
    this.schedule();
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

  appendMessage(id: string, message: Omit<TranscriptMessage, "id" | "timestamp">): TranscriptMessage {
    const full: TranscriptMessage = { id: randomUUID(), timestamp: new Date().toISOString(), ...message };
    const cache = this.cached(this.messageCache, id);
    cache.push(full);
    this.queue.messages.push({ sessionId: id, message: full, seq: cache.length });
    this.update(id, { messageCount: this.require(id).messageCount + 1 });
    return full;
  }

  messages(id: string, limit?: number): TranscriptMessage[] {
    const all = this.messageCache.get(id) ?? [];
    return limit === undefined ? [...all] : all.slice(-limit);
  }

  setTodos(id: string, plan: SessionPlan): void {
    this.planCache.set(id, plan);
    this.queue.todos.add(id);
    this.schedule();
  }

  todos(id: string): SessionPlan | undefined {
    return this.planCache.get(id);
  }

  events(id: string): { seq: number; at: string; event: unknown }[] {
    return [...(this.eventCache.get(id) ?? [])];
  }

  appendEvent(id: string, event: unknown): void {
    const cache = this.cached(this.eventCache, id);
    const row = { seq: (cache.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), event };
    cache.push(row);
    this.lastEventAt.set(id, row.at);
    this.queue.events.push({ sessionId: id, ...row });
    this.schedule();
  }

  touch(id: string): void {
    const now = Date.now();
    if (now - (this.touchedAt.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(id, now);
    this.lastEventAt.set(id, new Date(now).toISOString());
  }

  activity(id: string): { eventCount: number; lastEventAt?: string; environment?: SessionEnvironment } {
    const lastEventAt = this.lastEventAt.get(id);
    const environment = this.environments.get(id);
    return { eventCount: this.eventCache.get(id)?.length ?? 0, ...(lastEventAt ? { lastEventAt } : {}), ...(environment ? { environment } : {}) };
  }

  setEnvironment(id: string, environment: SessionEnvironment): void {
    this.environments.set(id, environment);
  }

  /** Loads a session's messages, events and plan from the database; sessions created here are already in memory. */
  async hydrate(id: string): Promise<void> {
    if (this.hydrated.has(id)) return;
    if (!this.records.has(id)) throw new Error(`No session ${id} for tenant ${this.options.tenant}.`);
    const tenant = this.options.tenant;
    const [messages, events, plan] = await Promise.all([
      this.options.sql.query(`SELECT message FROM marshal_session_messages WHERE tenant = $1 AND session_id = $2 ORDER BY seq`, [tenant, id]),
      this.options.sql.query(`SELECT seq, at, event FROM marshal_session_events WHERE tenant = $1 AND session_id = $2 ORDER BY seq`, [tenant, id]),
      this.options.sql.query(`SELECT plan FROM marshal_session_todos WHERE tenant = $1 AND session_id = $2`, [tenant, id]),
    ]);
    // Anything appended here while the reads ran stays after what the database had.
    const pendingMessages = this.messageCache.get(id) ?? [];
    const fromDb = messages.rows.map((row) => row.message as TranscriptMessage);
    const known = new Set(fromDb.map((message) => message.id));
    this.messageCache.set(id, [...fromDb, ...pendingMessages.filter((message) => !known.has(message.id))]);
    const pendingEvents = this.eventCache.get(id) ?? [];
    const dbEvents = events.rows.map((row) => ({ seq: Number(row.seq), at: new Date(row.at).toISOString(), event: row.event as unknown }));
    this.eventCache.set(id, [...dbEvents, ...pendingEvents.filter((event) => event.seq > (dbEvents.at(-1)?.seq ?? 0))]);
    if (plan.rows[0] && !this.planCache.has(id)) this.planCache.set(id, plan.rows[0].plan as SessionPlan);
    this.hydrated.add(id);
  }

  async search(query: string, limit = 10): Promise<SessionSearchHit[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);
    if (terms.length === 0) return [];
    await this.flush();
    const tsquery = [...new Set(terms)].join(" | ");
    const depth = this.options.rerank ? limit * 5 : limit;
    const { rows } = await this.options.sql.query(
      `WITH q AS (SELECT to_tsquery('simple', $2) AS q),
            head AS (SELECT id, ts_rank(head_tsv, q.q) * 3 AS score FROM marshal_sessions, q WHERE tenant = $1 AND head_tsv @@ q.q),
            body AS (
              SELECT session_id AS id, sum(ts_rank(tsv, q.q)) AS score,
                     (array_agg(ts_headline('simple', message->>'content', q.q, 'MaxFragments=1, MaxWords=30, MinWords=10') ORDER BY ts_rank(tsv, q.q) DESC))[1] AS snippet
                FROM marshal_session_messages, q WHERE tenant = $1 AND tsv @@ q.q GROUP BY session_id)
       SELECT COALESCE(head.id, body.id) AS id, COALESCE(head.score, 0) + COALESCE(body.score, 0) AS score, body.snippet
         FROM head FULL OUTER JOIN body ON head.id = body.id
        ORDER BY score DESC LIMIT $3`,
      [this.options.tenant, tsquery, depth],
    );
    const hits: SessionSearchHit[] = [];
    for (const row of rows) {
      const session = this.records.get(String(row.id));
      if (session) hits.push({ session, snippet: String(row.snippet ?? session.title), score: Number(row.score) });
    }
    const ranked = this.options.rerank ? await this.options.rerank(query, hits) : hits;
    return ranked.slice(0, limit);
  }

  /** A file kept with a session (a rendered report, a brief video): stored in the object store under the tenant. */
  async putArtifact(sessionId: string, name: string, data: Uint8Array | string, contentType?: string): Promise<string> {
    this.require(sessionId);
    const key = this.artifactKey(sessionId, name);
    await this.options.objects.put(key, data, contentType);
    return key;
  }

  async getArtifact(sessionId: string, name: string): Promise<Uint8Array | undefined> {
    return this.options.objects.get(this.artifactKey(sessionId, name));
  }

  async listArtifacts(sessionId: string): Promise<string[]> {
    const prefix = `${this.artifactKey(sessionId, "")}`;
    return (await this.options.objects.list(prefix)).map((key) => key.slice(prefix.length));
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (;;) {
      await (this.draining ?? this.drain());
      if (this.failure) {
        const error = this.failure;
        this.failure = undefined;
        throw error;
      }
      if (isEmpty(this.queue) && !this.draining) return;
    }
  }

  private artifactKey(sessionId: string, name: string): string {
    if (name.includes("..") || name.startsWith("/")) throw new Error(`Artifact name ${name} is not a relative path.`);
    return `${this.options.tenant}/artifacts/${sessionId}/${name}`;
  }

  private schedule(): void {
    if (this.timer || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(() => undefined);
    }, this.options.writeDelayMs ?? 50);
    this.timer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (isEmpty(this.queue)) return Promise.resolve();
    const batch = this.queue;
    this.queue = emptyQueue();
    this.draining = this.write(batch)
      .catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.options.log?.(`cloud session store: write failed, kept for the next flush: ${this.failure.message}`);
        // Everything of the batch is idempotent, so it simply goes back in front of what arrived meanwhile.
        this.queue = merge(batch, this.queue);
      })
      .finally(() => {
        this.draining = undefined;
        if (!this.failure && !isEmpty(this.queue)) this.schedule();
      });
    return this.draining;
  }

  private async write(batch: Queued): Promise<void> {
    const tenant = this.options.tenant;
    const sql = this.options.sql;
    for (const [sessionId, rows] of group(batch.messages, (row) => row.sessionId)) {
      await sql.query(
        `INSERT INTO marshal_session_messages (tenant, session_id, message_id, seq, message, tsv)
         SELECT $1, $2, m.id, m.seq, m.message::jsonb, to_tsvector('simple', m.content)
           FROM unnest($3::text[], $4::bigint[], $5::text[], $6::text[]) AS m(id, seq, message, content)
         ON CONFLICT (tenant, session_id, message_id) DO NOTHING`,
        [
          tenant,
          sessionId,
          rows.map((row) => row.message.id),
          rows.map((row) => row.seq),
          rows.map((row) => JSON.stringify(row.message)),
          rows.map((row) => row.message.content.slice(0, INDEXED_CHARS)),
        ],
      );
    }
    for (const [sessionId, rows] of group(batch.events, (row) => row.sessionId)) {
      await sql.query(
        `INSERT INTO marshal_session_events (tenant, session_id, seq, at, event)
         SELECT $1, $2, e.seq, e.at::timestamptz, e.event::jsonb FROM unnest($3::int[], $4::text[], $5::text[]) AS e(seq, at, event)
         ON CONFLICT (tenant, session_id, seq) DO NOTHING`,
        [tenant, sessionId, rows.map((row) => row.seq), rows.map((row) => row.at), rows.map((row) => JSON.stringify(row.event ?? null))],
      );
    }
    for (const id of batch.todos) {
      const plan = this.planCache.get(id);
      if (!plan) continue;
      await sql.query(
        `INSERT INTO marshal_session_todos (tenant, session_id, plan) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (tenant, session_id) DO UPDATE SET plan = EXCLUDED.plan`,
        [tenant, id, JSON.stringify(plan)],
      );
    }
    // Records last: a record in the database never counts messages the database does not have yet.
    for (const id of batch.records) {
      const record = this.records.get(id);
      if (!record) continue;
      await sql.query(
        `INSERT INTO marshal_sessions (tenant, id, record, head_tsv, updated_at) VALUES ($1, $2, $3::jsonb, to_tsvector('simple', $4), $5::timestamptz)
         ON CONFLICT (tenant, id) DO UPDATE SET record = EXCLUDED.record, head_tsv = EXCLUDED.head_tsv, updated_at = EXCLUDED.updated_at`,
        [tenant, id, JSON.stringify(record), `${record.title} ${Object.values(record.labels).join(" ")}`, record.updatedAt],
      );
    }
  }

  private cached<T>(map: Map<string, T[]>, id: string): T[] {
    this.require(id);
    let list = map.get(id);
    if (!list) {
      list = [];
      map.set(id, list);
    }
    return list;
  }

  private require(id: string): SessionRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`No session ${id} for tenant ${this.options.tenant}.`);
    return record;
  }
}

function emptyQueue(): Queued {
  return { messages: [], events: [], records: new Set(), todos: new Set() };
}

function isEmpty(queue: Queued): boolean {
  return queue.messages.length === 0 && queue.events.length === 0 && queue.records.size === 0 && queue.todos.size === 0;
}

function merge(first: Queued, second: Queued): Queued {
  return {
    messages: [...first.messages, ...second.messages],
    events: [...first.events, ...second.events],
    records: new Set([...first.records, ...second.records]),
    todos: new Set([...first.todos, ...second.todos]),
  };
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const list = grouped.get(key(row)) ?? [];
    list.push(row);
    grouped.set(key(row), list);
  }
  return grouped;
}

function withPartition(record: SessionRecord): SessionRecord {
  const runtimeId = record.runtimeId ?? record.runtime;
  return { ...record, runtimeId, backendOrigin: record.backendOrigin ?? backendOriginOf(runtimeId) };
}
