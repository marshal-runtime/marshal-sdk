import type { ObjectStore } from "../object-store.js";
import { PreconditionFailedError } from "../object-store.js";
import { LABEL_VALUE, rootOf } from "../run-records.js";
import type { SessionRecord, SessionStore } from "../session-store.js";
import { dayOf, implFile, indexDir, partitionPath, rowObject, sessionDir, shardObject, validateImpl, type ImplDeclaration } from "./layout.js";
import { OrgTranscriptStore, type OrgTranscriptOptions } from "./transcripts.js";

/** One line of an index shard. The last row per `id` (by `updatedAt`) wins. Ids and counts only: no message text. */
export interface IndexRow {
  v: 1;
  id: string;
  ws: string;
  impl: string;
  part: Record<string, string>;
  day: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | "idle" | "failed";
  messages: number;
  title: string;
  labels: Record<string, string>;
  usage: { costUsd: number; inputTokens: number; outputTokens: number };
  host: { id: string; kind: string };
  members: string[];
  has: { native: boolean };
  /** The generation of `session.json` this row describes: a reader that holds a copy of that generation holds the session. */
  gen: string;
}

export interface OrgStoreOptions {
  objects: ObjectStore;
  impl: ImplDeclaration;
  /** Labels every session of this host carries for the layout and the row (Marley: `env`, which is the deployment's, not the session's). They win over a session's own. */
  fixedLabels?: Record<string, string>;
  /** Quiet time after a session goes idle before its objects are published. Default 1 s. */
  publishDelayMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const slug = (value: string, max: number) => value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, max) || "x";
const memberName = (record: SessionRecord, root: SessionRecord) => `${slug(record.labels?.role ?? (record.id === root.id ? "main" : "fork"), 40)}-${record.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;

/**
 * The org store of one SDK usage: it publishes each root session to `sdk/v1/<ws>/<impl>/<partition>/<day>/<root>/` (transcripts, then
 * `session.json` last as the commit marker), keeps a row object per session and folds a day's rows into `<day>.jsonl` with a generation
 * precondition. One writer per session, so no object is shared by writers; the compactor is idempotent and a lost race retries.
 */
export class OrgStore {
  readonly transcripts: OrgTranscriptStore;
  private readonly impl: ImplDeclaration;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<Promise<void>>();
  private implWritten = false;

  constructor(
    private readonly options: OrgStoreOptions,
    private readonly sessions: SessionStore,
    isCurrent?: OrgTranscriptOptions["isCurrent"],
  ) {
    this.impl = validateImpl(options.impl);
    this.transcripts = new OrgTranscriptStore({
      objects: options.objects,
      locate: (id) => this.locate(id),
      ...(isCurrent ? { isCurrent } : {}),
      lookup: async (nativeId) => {
        const record = this.sessions.list().find((candidate) => candidate.native?.sessionId === nativeId);
        return record ? this.locate(record.id) : undefined;
      },
      ...(options.log ? { log: options.log } : {}),
    });
  }

  private labelsOf(root: SessionRecord): Record<string, string> {
    return { ...(root.labels ?? {}), ...(this.options.fixedLabels ?? {}) };
  }

  /** The directory of a session's root, or undefined when the root's labels do not satisfy the partition. */
  locate(sessionId: string): string | undefined {
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    const root = rootOf(this.sessions, record);
    const partition = partitionPath(this.impl, this.labelsOf(root));
    return partition === undefined ? undefined : sessionDir(this.impl, partition, dayOf(root.createdAt), root.id);
  }

  /** Writes `_impl.json` once (create-only); a second writer finds it and moves on. */
  async ensureImpl(): Promise<void> {
    if (this.implWritten) return;
    try {
      await this.options.objects.put(implFile(this.impl), JSON.stringify(this.impl, null, 2), { contentType: "application/json", ifGenerationMatch: 0 });
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
    }
    this.implWritten = true;
  }

  /** Publishes a session's root shortly after it goes idle, off the turn. Repeated calls within the delay publish once. */
  schedule(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    const rootId = rootOf(this.sessions, record).id;
    clearTimeout(this.timers.get(rootId));
    const timer = setTimeout(() => {
      this.timers.delete(rootId);
      const job = this.publish(rootId)
        .then(() => undefined)
        .catch((error) => this.options.log?.("org-store.publish_failed", { rootId, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.running.delete(job));
      this.running.add(job);
    }, this.options.publishDelayMs ?? 1000);
    timer.unref?.();
    this.timers.set(rootId, timer);
  }

  /** Publishes every pending root now and waits for running publishes (shutdown, tests). */
  async close(): Promise<void> {
    for (const [rootId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(rootId);
      await this.publish(rootId).catch((error) => this.options.log?.("org-store.publish_failed", { rootId, error: error instanceof Error ? error.message : String(error) }));
    }
    await Promise.all([...this.running]);
  }

  /** Publishes one root session: transcripts, then `session.json`, then its row, then the day's shard. Returns undefined when it has no directory. */
  async publish(rootId: string): Promise<{ dir: string; row: IndexRow } | undefined> {
    const root = this.sessions.get(rootId);
    if (!root) return undefined;
    const partition = partitionPath(this.impl, this.labelsOf(root));
    if (partition === undefined) {
      this.options.log?.("org-store.skipped", { rootId, reason: "partition labels missing or not id-shaped" });
      return undefined;
    }
    await this.ensureImpl();
    const objects = this.options.objects;
    const day = dayOf(root.createdAt);
    const dir = sessionDir(this.impl, partition, day, root.id);
    const members = this.sessions.list().filter((record) => rootOf(this.sessions, record).id === root.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const member of members) await this.transcripts.compose(member.id);
    const named = members.map((member) => ({ id: member.id, name: memberName(member, root), record: member }));
    for (const { id, name } of named) {
      const lines = this.sessions.messages(id).map((message) => JSON.stringify(message));
      await objects.put(`${dir}/transcripts/${name}.jsonl`, lines.length ? lines.join("\n") + "\n" : "", { contentType: "application/x-ndjson" });
    }
    const row = this.row(root, named, day, partition);
    const body = { v: 1, row: { ...row, gen: undefined }, members: named.map(({ id, name, record }) => ({ id, name, state: record.state, nativeSessionId: record.native?.sessionId ?? null, labels: record.labels })) };
    const written = await objects.put(`${dir}/session.json`, JSON.stringify(body, null, 2), { contentType: "application/json" });
    const withGen: IndexRow = { ...row, gen: written.generation };
    await objects.put(rowObject(this.impl, partition, day, root.id), JSON.stringify(withGen), { contentType: "application/json" });
    await this.compactDay(partition, day);
    return { dir, row: withGen };
  }

  private row(root: SessionRecord, named: Array<{ name: string; record: SessionRecord }>, day: string, partition: string): IndexRow {
    const labels: Record<string, string> = {};
    for (const key of Object.keys(this.impl.fields)) {
      const value = this.labelsOf(root)[key];
      if (typeof value === "string" && LABEL_VALUE.test(value)) labels[key] = value;
    }
    const part: Record<string, string> = {};
    for (const segment of partition.split("/").filter(Boolean)) {
      const [key, ...rest] = segment.split("=");
      part[key!] = rest.join("=");
    }
    const records = named.map((member) => member.record);
    const state: IndexRow["state"] = records.some((record) => record.state === "running") ? "running" : root.state === "failed" ? "failed" : "idle";
    const sum = (pick: (record: SessionRecord) => number) => records.reduce((total, record) => total + pick(record), 0);
    const title = [labels.procedure ?? this.impl.impl, ...this.impl.partition.map((key) => part[key]), labels.kind].filter(Boolean).join(" · ").slice(0, 300);
    return {
      v: 1,
      id: root.id,
      ws: this.impl.workspace,
      impl: this.impl.impl,
      part,
      day,
      createdAt: root.createdAt,
      updatedAt: records.map((record) => record.updatedAt).sort().at(-1) ?? root.updatedAt,
      state,
      messages: sum((record) => record.messageCount),
      title,
      labels,
      usage: { costUsd: sum((record) => record.usage.costUsd ?? 0), inputTokens: sum((record) => record.usage.inputTokens ?? 0), outputTokens: sum((record) => record.usage.outputTokens ?? 0) },
      host: root.host,
      members: named.map((member) => member.name),
      has: { native: records.some((record) => Boolean(record.native?.sessionId)) },
      gen: "",
    };
  }

  /** Folds a day's row objects into `<day>.jsonl`, writing only if the shard is still the generation that was read. Idempotent; a lost race retries. */
  async compactDay(partition: string, day: string): Promise<void> {
    const objects = this.options.objects;
    const shard = shardObject(this.impl, partition, day);
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await objects.read(shard);
      const byId = new Map<string, IndexRow>();
      const take = (row: IndexRow) => {
        const current = byId.get(row.id);
        if (!current || current.updatedAt <= row.updatedAt) byId.set(row.id, row);
      };
      if (existing) for (const line of Buffer.from(existing.data).toString("utf8").split("\n")) if (line) take(JSON.parse(line) as IndexRow);
      const rowsPrefix = `${indexDir(this.impl, partition)}/${day}/_rows/`;
      for (const name of await objects.list(rowsPrefix)) {
        const bytes = await objects.get(name);
        if (bytes) take(JSON.parse(Buffer.from(bytes).toString("utf8")) as IndexRow);
      }
      const text = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((row) => JSON.stringify(row)).join("\n") + "\n";
      try {
        await objects.put(shard, text, { contentType: "application/x-ndjson", ifGenerationMatch: existing ? existing.generation : 0 });
        return;
      } catch (error) {
        if (!(error instanceof PreconditionFailedError)) throw error;
      }
    }
    throw new Error(`Could not compact ${shard}: it kept changing.`);
  }
}

export interface IndexQuery {
  objects: ObjectStore;
  impl: ImplDeclaration;
  /** A prefix of the partition keys, in order: `{ env: "staging", brand: "x" }`. */
  partition?: Record<string, string>;
  /** Days, inclusive, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  /** Exact matches on `labels`. */
  where?: Record<string, string>;
}

/** Lists rows from the index with no ranking: newest first. Reads shards plus any row objects not yet folded in. */
export async function listIndex(query: IndexQuery): Promise<IndexRow[]> {
  const { objects, impl } = query;
  const segments: string[] = [];
  for (const key of impl.partition) {
    const value = query.partition?.[key];
    if (value === undefined) break;
    segments.push(`${key}=${value}`);
  }
  const prefix = `${indexDir(impl, segments.join("/"))}${segments.length < impl.partition.length ? "/" : "/"}`.replace(/\/+$/, "/");
  const byId = new Map<string, IndexRow>();
  const take = (row: IndexRow) => {
    const current = byId.get(row.id);
    if (!current || current.updatedAt <= row.updatedAt) byId.set(row.id, row);
  };
  for (const info of await objects.listInfo(prefix)) {
    const isShard = info.name.endsWith(".jsonl");
    const isRow = info.name.includes("/_rows/") && info.name.endsWith(".json");
    if (!isShard && !isRow) continue;
    const day = (isShard ? info.name.slice(0, -".jsonl".length) : info.name.split("/_rows/")[0]!).split("/").pop()!;
    if ((query.from && day < query.from) || (query.to && day > query.to)) continue;
    const bytes = await objects.get(info.name);
    if (!bytes) continue;
    const text = Buffer.from(bytes).toString("utf8");
    if (isShard) {
      for (const line of text.split("\n")) if (line) take(JSON.parse(line) as IndexRow);
    } else take(JSON.parse(text) as IndexRow);
  }
  return [...byId.values()]
    .filter((row) => Object.entries(query.where ?? {}).every(([key, value]) => row.labels[key] === value))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
