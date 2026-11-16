import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionPublisher } from "./kit/publisher.js";
import { claudeNativePath } from "./org-publish.js";
import { scrubText } from "./org-scrub.js";
import type { FileSessionStore, SessionRecord } from "./session-store.js";

/**
 * Run records: a host's sessions written as runs in the format the organization's run index reads
 * (zyg-agents `runs/<run id>/{summary.json, record.jsonl, sessions/<session>.jsonl, sessions/<session>.claude.jsonl}`,
 * docs/run-records.md). The index then lists them in Marshal under their workspace and workflow, rows only, and serves
 * a transcript when someone opens it. Unlike `publishToOrg`, nothing here needs a person's org token: a service host
 * (Marley's agent server) only needs write access to the records bucket, and who may read a run is the workspace's
 * rule on the server (its auditors and boundary), never the host's.
 */

/** The version of the summary shape the run index accepts. */
export const RUN_SUMMARY_VERSION = 1;
export const RUNS_PREFIX = "runs";

/** Link kinds the run index knows (`RUN_LINK_KINDS` in @marshal/agent-runtime-org). */
export type RunLinkKind = "slack" | "pr" | "datadog" | "pagerduty" | "monitor" | "root-cause" | "linear" | "wake" | "chat" | "session";

export interface RunLink {
  kind: RunLinkKind;
  /** Canonical per kind; a chat is `<brand>:<conversation>`. */
  key: string;
  role: "origin" | "output" | "related";
}

/** What one run is: the workflow (procedure) it belongs to, its title and what it is linked to. */
export interface RunGroup {
  /** The procedure, e.g. `marley-chat`. The server's workspace manifests map workflow names to a workspace. */
  workflow: string;
  title: string;
  links: RunLink[];
  /** The person the run was for (`user:` principal or email), when there is one; a run without one is read by auditors only. */
  user?: string;
}

/** Decides the run of a root session (a session without a parent); undefined publishes nothing for it. */
export type RunGrouping = (root: SessionRecord) => RunGroup | undefined;

/** Where run objects go: a folder (tests, local proof) or a bucket. */
export interface RunRecordSink {
  put(objectName: string, body: string | Uint8Array, contentType: string): Promise<void>;
}

export interface RunRecordsOptions {
  store: Pick<FileSessionStore, "get" | "list" | "events" | "messages">;
  sink: RunRecordSink;
  /** Default `labelRunGrouping()`. */
  grouping?: RunGrouping;
  /**
   * Which runs may leave the host, decided on the root session. Default: none. A host passes its own rule, e.g.
   * Marley's allowlist of test and internal brands, so customer conversations are never published by accident.
   */
  allow?: (root: SessionRecord) => boolean;
  /** Also upload each session's native Claude transcript (`<session>.claude.jsonl`), for Continue. Default false. */
  envelopes?: boolean;
  /** Reads a session's native state; default reads the Claude projects file (`claudeNativePath`). */
  nativeState?: (record: SessionRecord) => Uint8Array | undefined;
  log?: (line: string) => void;
}

export interface RunFile {
  name: string;
  body: string | Uint8Array;
  contentType: string;
}

export interface BuiltRun {
  runId: string;
  summary: RunSummary;
  files: RunFile[];
}

interface SessionSummary {
  session: string;
  role: string;
  model?: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  conversation?: string;
  error?: string;
  toolCalls: number;
  toolErrors: number;
}

export interface RunSummary {
  version: number;
  runId: string;
  workflow: string;
  source: "chat";
  title: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  costUsd: number;
  user?: string;
  dryRun: boolean;
  error?: string;
  links: RunLink[];
  sessions: SessionSummary[];
  counts: { events: number; toolCalls: number; toolErrors: number; evidenceCalls: number; publications: number; failedPublications: number };
}

const NAME_PART = /[^A-Za-z0-9._-]+/g;
const MAX_TITLE = 300;
const MAX_KEY = 256;

const slug = (value: string, max: number) => value.replace(NAME_PART, "-").replace(/^[-._]+/, "").slice(0, max) || "x";

/**
 * The default grouping: a root session's labels name its run. `procedure` (or `workflow`) is the workflow; `brand` and
 * `conversation` make a `chat` link `<brand>:<conversation>`; `channel` and `kind` go into the title. A root session
 * without a procedure label publishes nothing.
 */
export function labelRunGrouping(options: { titlePrefix?: string } = {}): RunGrouping {
  return (root) => {
    const labels = root.labels ?? {};
    const workflow = labels.procedure ?? labels.workflow;
    if (!workflow) return undefined;
    const links: RunLink[] = [];
    if (labels.brand) links.push({ kind: "chat", key: `${labels.brand}:${labels.conversation ?? root.id}`.slice(0, MAX_KEY), role: "origin" });
    const parts = [options.titlePrefix, labels.brandName ?? labels.brand, labels.channel, labels.kind, root.title].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    return { workflow, title: parts.join(" · ").slice(0, MAX_TITLE), links, ...(labels.requester ? { user: labels.requester } : {}) };
  };
}

/**
 * The run id of a root session: `<day it started>-<workflow>-<12 hex of the session id>`. The index lists runs by the
 * day their id starts with, so the id must start with that day; the hash keeps it stable across re-publishes.
 */
export function runIdOf(root: SessionRecord, group: RunGroup): string {
  const day = root.createdAt.slice(0, 10);
  const hash = createHash("sha256").update(root.id).digest("hex").slice(0, 12);
  return `${day}-${slug(group.workflow, 64)}-${hash}`;
}

/** The root of a session: follow `parentId` while the parent is in the store. */
export function rootOf(store: Pick<FileSessionStore, "get">, record: SessionRecord): SessionRecord {
  let current = record;
  const seen = new Set<string>([current.id]);
  while (current.parentId) {
    const parent = store.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

const statusOf = (record: SessionRecord): SessionSummary["status"] =>
  record.state === "running" ? "running" : record.state === "failed" ? "failed" : "succeeded";

const sessionNameOf = (record: SessionRecord, root: SessionRecord): string => {
  const role = record.labels?.role ?? (record.id === root.id ? "main" : "fork");
  return `${slug(role, 40)}-${record.id.replace(NAME_PART, "").slice(0, 12)}`;
};

function scrubDeep(value: unknown, roots: { workspaceRoot?: string; homeDir?: string }): unknown {
  if (typeof value === "string") return scrubText(value, roots);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, roots));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubDeep(item, roots)]));
  }
  return value;
}

interface ContentBlock {
  type?: unknown;
  is_error?: unknown;
}

const blocksOf = (event: Record<string, unknown>): ContentBlock[] => {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
};

/** Builds every object of one run from the store: the summary, the record and one stream per session. */
export function buildRun(
  store: RunRecordsOptions["store"],
  root: SessionRecord,
  group: RunGroup,
  options: Pick<RunRecordsOptions, "envelopes" | "nativeState"> = {},
): BuiltRun {
  const runId = runIdOf(root, group);
  const all = store.list();
  const members = all.filter((record) => rootOf(store, record).id === root.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const files: RunFile[] = [];
  const record: Record<string, unknown>[] = [{ type: "run_started", at: root.createdAt, runId, workflow: group.workflow }];
  const sessions: SessionSummary[] = [];
  let eventCount = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const homeDir = os.homedir();
  for (const member of members) {
    const name = sessionNameOf(member, root);
    const roots = { workspaceRoot: member.native.cwd, homeDir };
    const lines: string[] = [];
    let calls = 0;
    let errors = 0;
    for (const entry of store.events(member.id)) {
      eventCount++;
      const event = entry.event as Record<string, unknown> | undefined;
      if (!event || (event.type !== "assistant" && event.type !== "user")) continue;
      for (const block of blocksOf(event)) {
        if (event.type === "assistant" && block.type === "tool_use") calls++;
        if (event.type === "user" && block.type === "tool_result" && block.is_error === true) errors++;
      }
      lines.push(JSON.stringify({ ...(scrubDeep(event, roots) as Record<string, unknown>), timestamp: entry.at }));
    }
    toolCalls += calls;
    toolErrors += errors;
    if (lines.length) files.push({ name: `sessions/${name}.jsonl`, body: `${lines.join("\n")}\n`, contentType: "application/x-ndjson" });
    if (options.envelopes) {
      const native = (options.nativeState ?? readNative)(member);
      if (native) files.push({ name: `sessions/${name}.claude.jsonl`, body: native, contentType: "application/x-ndjson" });
    }
    const messages = store.messages(member.id);
    const task = messages.find((message) => message.role === "user")?.content;
    const output = [...messages].reverse().find((message) => message.role === "assistant" && !message.error)?.content;
    const status = statusOf(member);
    record.push({ type: "session_started", at: member.createdAt, session: name, role: member.labels?.role ?? name.split("-")[0], ...(task ? { task: scrubText(task, roots) } : {}) });
    if (status !== "running") {
      record.push({ type: "session_finished", at: member.updatedAt, session: name, status, ...(output ? { output: scrubText(output, roots) } : {}) });
    }
    sessions.push({
      session: name,
      role: member.labels?.role ?? (member.id === root.id ? "main" : "fork"),
      ...(member.model ? { model: member.model } : {}),
      status,
      startedAt: member.createdAt,
      ...(status !== "running" ? { finishedAt: member.updatedAt } : {}),
      costUsd: member.usage.costUsd,
      turns: member.usage.turns,
      ...(member.native.sessionId ? { sessionId: member.native.sessionId } : {}),
      ...(member.labels?.conversation ? { conversation: member.labels.conversation } : {}),
      ...(member.lastError ? { error: scrubText(member.lastError, roots).slice(0, 2000) } : {}),
      toolCalls: calls,
      toolErrors: errors,
    });
  }
  const running = sessions.some((session) => session.status === "running");
  const rootStatus = statusOf(root);
  const status: RunSummary["status"] = running ? "running" : rootStatus === "failed" ? "failed" : "succeeded";
  const finishedAt = running ? undefined : members.map((member) => member.updatedAt).sort().at(-1);
  if (finishedAt) record.push({ type: "run_finished", at: finishedAt, status });
  const summary: RunSummary = {
    version: RUN_SUMMARY_VERSION,
    runId,
    workflow: group.workflow,
    source: "chat",
    title: group.title,
    status,
    startedAt: root.createdAt,
    ...(finishedAt ? { finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(root.createdAt)) } : {}),
    costUsd: Math.round(members.reduce((sum, member) => sum + member.usage.costUsd, 0) * 1e6) / 1e6,
    ...(group.user ? { user: group.user } : {}),
    dryRun: false,
    ...(root.lastError ? { error: scrubText(root.lastError, { workspaceRoot: root.native.cwd, homeDir }).slice(0, 2000) } : {}),
    links: group.links,
    sessions,
    counts: { events: eventCount, toolCalls, toolErrors, evidenceCalls: 0, publications: 0, failedPublications: 0 },
  };
  files.push({ name: "record.jsonl", body: `${record.map((line) => JSON.stringify(line)).join("\n")}\n`, contentType: "application/x-ndjson" });
  // The summary goes last: the index treats a run as changed when its summary changes, so every file it points at is already there.
  files.push({ name: "summary.json", body: `${JSON.stringify(summary, null, 2)}\n`, contentType: "application/json" });
  return { runId, summary, files };
}

function readNative(record: SessionRecord): Uint8Array | undefined {
  const file = claudeNativePath(record);
  if (!file) return undefined;
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

/** Writes runs into a folder laid out like the records bucket (`<root>/runs/<run id>/…`). */
export function directoryRunSink(root: string): RunRecordSink {
  return {
    async put(objectName, body) {
      const target = path.join(root, ...objectName.split("/"));
      if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`object ${objectName} escapes ${root}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);
    },
  };
}

/**
 * Writes runs into a Cloud Storage bucket over the JSON API. The host supplies the access token (its workload
 * identity, metadata server or `gcloud auth print-access-token`); the token never appears in a log or an error.
 */
export function gcsRunSink(options: { bucket: string; accessToken: () => Promise<string>; fetch?: typeof fetch; timeoutMs?: number }): RunRecordSink {
  const doFetch = options.fetch ?? fetch;
  return {
    async put(objectName, body, contentType) {
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
      const token = await options.accessToken();
      const response = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body: typeof body === "string" ? body : Buffer.from(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      if (!response.ok) throw new Error(`upload of ${objectName} to gs://${options.bucket} answered ${response.status}`);
    },
  };
}

/**
 * Publishes each run whose session went idle or failed: one upload per run at a time, a turn that ends during an upload
 * queues exactly one more, failures are logged and never thrown (a run must not fail because the bucket is down).
 */
export class RunRecordsPublisher {
  private readonly queue: SessionPublisher;
  private readonly grouping: RunGrouping;
  private readonly published = new Map<string, { at: string; runId: string; files: number }>();

  constructor(private readonly options: RunRecordsOptions) {
    this.grouping = options.grouping ?? labelRunGrouping();
    // Keyed by root session: a fork going idle republishes its whole run.
    this.queue = new SessionPublisher((rootId) => this.publishRoot(rootId), options.log, "the run records");
  }

  /** Called with any session of the run (a fork included) when it goes idle or fails. */
  schedule(sessionId: string): void {
    const record = this.options.store.get(sessionId);
    if (!record) return;
    const root = rootOf(this.options.store, record);
    if (!(this.options.allow?.(root) ?? false)) return;
    if (!this.grouping(root)) return;
    this.queue.schedule(root.id);
  }

  async flush(): Promise<void> {
    await this.queue.flush();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  /** The last publish of each run, by root session id. */
  status(): Record<string, { at: string; runId: string; files: number }> {
    return Object.fromEntries(this.published);
  }

  /** Builds and uploads one run now. Throws on failure (the scheduler catches and logs). */
  async publishRoot(rootId: string): Promise<{ status: string }> {
    const root = this.options.store.get(rootId);
    if (!root) throw new Error(`no session ${rootId}`);
    if (!(this.options.allow?.(root) ?? false)) return { status: "not-allowed" };
    const group = this.grouping(root);
    if (!group) return { status: "no-run" };
    const built = buildRun(this.options.store, root, group, this.options);
    for (const file of built.files) {
      await this.options.sink.put(`${RUNS_PREFIX}/${built.runId}/${file.name}`, file.body, file.contentType);
    }
    this.published.set(rootId, { at: new Date().toISOString(), runId: built.runId, files: built.files.length });
    return { status: `run ${built.runId}` };
  }
}
