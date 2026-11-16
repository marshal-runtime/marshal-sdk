// Procedure groups: a service's runs (Marley's chats, tasks and routines) published as run records (marshal-sdk
// src/run-records.ts), browsed apart from the chat list. Group -> workflow (marley-chat, marley-task, marley-routine)
// -> brand -> env. Listing reads only each run's summary.json (ids, labels, status, cost); a transcript is fetched when
// someone opens it and kept in the cloud cache (~/.marshal/cloud-cache), every procedure run marked restricted so sign-out
// (sdksessions.cloudCache {restricted: true}) wipes it.
import fs from "node:fs";
import path from "node:path";

import { CloudCache, defaultCacheRoot } from "./cache";
import { gcsCat, gcsGlob } from "./cloud";
import { expandHome } from "./store";

type Row = Record<string, any>;

export const DEFAULT_PROCEDURE_DAYS = 7;
export const MAX_PROCEDURE_DAYS = 31;
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80}-[0-9a-f]{12}$/;
const SESSION_FILE = /^[A-Za-z0-9._-]{1,160}\.jsonl$/;
const ENVS = ["local", "staging", "production"] as const;

export interface ProcedureGroup {
  id: string;
  name: string;
  /** Run-id workflow prefix: "marley-" lists marley-chat, marley-task and marley-routine. */
  prefix: string;
  /** Folders or gs:// roots that hold runs/<runId>/ (a records bucket, a local Marley's records folder). */
  sources: string[];
}

export interface ProcedureRun {
  id: string;
  source: string;
  workflow: string;
  title: string;
  status: string;
  startedAt: string;
  costUsd: number;
  env: string;
  brand: string;
  conversation: string;
  kind: string;
  channel: string;
  sessions: { session: string; role: string; status: string; turns?: number }[];
}

export interface ProcedureMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: string;
}

/** The Marley group when nothing is configured: local Marley's records folder (dev stack, evals). */
export const MARLEY_GROUP: ProcedureGroup = { id: "marley", name: "Marley", prefix: "marley-", sources: ["~/.marshal/marley-runs"] };

/** Groups from configuration.procedures [{id, name, prefix, sources}] or MARSHAL_SDK_MARLEY_RUNS (colon-separated sources; a gs:// colon does not split). */
export function configuredProcedures(configuration: Row | undefined): ProcedureGroup[] {
  const list = Array.isArray(configuration?.procedures) ? configuration!.procedures : [];
  const groups: ProcedureGroup[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(entry.id)) continue;
    const sources = Array.isArray(entry.sources) ? entry.sources.filter((value: unknown): value is string => typeof value === "string" && value.length > 0) : [];
    if (!sources.length) continue;
    const prefix = typeof entry.prefix === "string" && /^[a-z0-9-]{1,40}$/.test(entry.prefix) ? entry.prefix : `${entry.id}-`;
    groups.push({ id: entry.id, name: typeof entry.name === "string" && entry.name ? entry.name : entry.id, prefix, sources });
  }
  if (groups.some((group) => group.id === MARLEY_GROUP.id)) return groups;
  const fromEnv = (process.env.MARSHAL_SDK_MARLEY_RUNS ?? "").split(/:(?!\/\/)/).filter(Boolean);
  return [{ ...MARLEY_GROUP, sources: fromEnv.length ? fromEnv : MARLEY_GROUP.sources }, ...groups];
}

const isGcs = (source: string) => source.startsWith("gs://");
const trim = (source: string) => source.replace(/\/+$/, "");
const localRoot = (source: string) => expandHome(trim(source));

function daysBack(days: number, now: Date): string[] {
  return Array.from({ length: days }, (_, index) => new Date(now.getTime() - index * 86_400_000).toISOString().slice(0, 10));
}

const readLabel = (value: unknown) => (typeof value === "string" ? value : "");

function rowOf(source: string, summary: Row): ProcedureRun | null {
  if (!summary || summary.version !== 1 || typeof summary.runId !== "string" || !RUN_ID.test(summary.runId)) return null;
  const labels = summary.labels && typeof summary.labels === "object" ? (summary.labels as Row) : {};
  const chat = Array.isArray(summary.links) ? summary.links.find((link: Row) => link?.kind === "chat") : undefined;
  const [linkBrand, linkConversation] = typeof chat?.key === "string" ? String(chat.key).split(/:(.*)/s) : [];
  return {
    id: summary.runId,
    source,
    workflow: readLabel(summary.workflow),
    title: readLabel(summary.title),
    status: readLabel(summary.status),
    startedAt: readLabel(summary.startedAt),
    costUsd: typeof summary.costUsd === "number" ? summary.costUsd : 0,
    env: readLabel(labels.env) || "unknown",
    brand: readLabel(labels.brand) || linkBrand || "",
    conversation: readLabel(labels.conversation) || linkConversation || "",
    kind: readLabel(labels.kind),
    channel: readLabel(labels.channel),
    sessions: Array.isArray(summary.sessions)
      ? summary.sessions
          .filter((entry: Row) => typeof entry?.session === "string" && SESSION_FILE.test(`${entry.session}.jsonl`))
          .map((entry: Row) => ({ session: entry.session, role: readLabel(entry.role), status: readLabel(entry.status), ...(typeof entry.turns === "number" ? { turns: entry.turns } : {}) }))
      : [],
  };
}

export interface ProcedureFilter {
  workflow?: string;
  brand?: string;
  env?: string;
  days?: number;
}

export interface ProcedureListing {
  group: { id: string; name: string };
  runs: ProcedureRun[];
  facets: { workflows: string[]; brands: string[]; envs: string[] };
  problems: { source: string; message: string }[];
}

/** A group's runs of the last `days` days, newest first: summaries only, never a transcript. */
export async function listProcedureRuns(group: ProcedureGroup, filter: ProcedureFilter = {}, now = new Date()): Promise<ProcedureListing> {
  const days = Math.min(MAX_PROCEDURE_DAYS, Math.max(1, Math.floor(filter.days ?? DEFAULT_PROCEDURE_DAYS)));
  const wanted = new Set(daysBack(days, now));
  const all: ProcedureRun[] = [];
  const problems: ProcedureListing["problems"] = [];
  for (const source of group.sources) {
    try {
      if (isGcs(source)) {
        const uris: string[] = [];
        for (const day of wanted) uris.push(...(await gcsGlob(`${trim(source)}/runs/${day}-${group.prefix}*/summary.json`)));
        for (const uri of uris) {
          const row = rowOf(source, JSON.parse(await gcsCat(uri)));
          if (row) all.push(row);
        }
      } else {
        const runsDir = path.join(localRoot(source), "runs");
        if (!fs.existsSync(runsDir)) continue;
        for (const name of fs.readdirSync(runsDir)) {
          if (!RUN_ID.test(name) || !wanted.has(name.slice(0, 10)) || !name.slice(11).startsWith(group.prefix)) continue;
          const file = path.join(runsDir, name, "summary.json");
          if (!fs.existsSync(file)) continue;
          const row = rowOf(source, JSON.parse(fs.readFileSync(file, "utf8")));
          if (row) all.push(row);
        }
      }
    } catch (error) {
      problems.push({ source, message: (error as Error).message });
    }
  }
  const facets = {
    workflows: [...new Set(all.map((run) => run.workflow).filter(Boolean))].sort(),
    brands: [...new Set(all.filter((run) => !filter.workflow || run.workflow === filter.workflow).map((run) => run.brand).filter(Boolean))].sort(),
    envs: [...new Set([...ENVS, ...all.map((run) => run.env)])].filter((env) => all.some((run) => run.env === env)),
  };
  const runs = all
    .filter((run) => (!filter.workflow || run.workflow === filter.workflow) && (!filter.brand || run.brand === filter.brand) && (!filter.env || run.env === filter.env))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return { group: { id: group.id, name: group.name }, runs, facets, problems };
}

/**
 * Transcripts of opened procedure runs, in the cloud cache (<root>/procedure-<source>/<run>/sessions/<file>). Every
 * procedure run is marked restricted, so the cloud cache's sign-out wipe (sdksessions.cloudCache {restricted: true})
 * clears it and its size cap evicts least recently used files across pages and procedures alike.
 */
export class ProcedureCache {
  constructor(readonly cloud: CloudCache = new CloudCache(defaultCacheRoot())) {}

  private host(source: string): string {
    return `procedure-${source}`;
  }

  fileOf(source: string, run: string, file: string): string {
    return this.cloud.fileOf(this.host(source), run, `sessions/${file}`);
  }

  /** The cached text, touched as recently used; undefined when not here. */
  read(source: string, run: string, file: string): string | undefined {
    const target = this.fileOf(source, run, file);
    try {
      const text = fs.readFileSync(target, "utf8");
      const at = new Date();
      fs.utimesSync(target, at, at);
      return text;
    } catch {
      return undefined;
    }
  }

  write(source: string, run: string, file: string, text: string): void {
    this.cloud.markRestricted(this.host(source), run);
    const target = this.cloud.write(this.host(source), run, `sessions/${file}`, text);
    fs.chmodSync(target, 0o600);
    this.cloud.evict(new Set([target]));
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: Row) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
};

/** The readable lines of a run session stream (user and assistant events; tool calls and results as one-liners). */
export function messagesOf(jsonl: string): ProcedureMessage[] {
  const out: ProcedureMessage[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Row;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event?.message?.content;
    const at = typeof event.timestamp === "string" ? event.timestamp : undefined;
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "tool_use") out.push({ role: "tool", text: `→ ${String(part.name ?? "tool")} ${JSON.stringify(part.input ?? {}).slice(0, 200)}`, ...(at ? { at } : {}) });
      else if (part?.type === "tool_result") out.push({ role: "tool", text: `← ${(typeof part.content === "string" ? part.content : textOf(part.content)).slice(0, 400)}`, ...(at ? { at } : {}) });
    }
    const text = textOf(content);
    if (text && (event.type === "user" || event.type === "assistant")) out.push({ role: event.type, text, ...(at ? { at } : {}) });
  }
  return out;
}

export interface ProcedureTranscript {
  runId: string;
  session: string;
  messages: ProcedureMessage[];
  /** "cache" when this open was served from ~/.marshal/cloud-cache, "source" when it was fetched. */
  servedFrom: "cache" | "source";
  bytes: number;
}

/** One session of a run, fetched on demand and cached; a second open is served from the cache. */
export async function procedureTranscript(
  group: ProcedureGroup,
  input: { source: string; runId: string; session: string },
  cache: ProcedureCache,
  log: (line: string) => void = () => undefined,
): Promise<ProcedureTranscript> {
  if (!group.sources.includes(input.source)) throw new Error(`${input.source} is not a source of ${group.name}.`);
  if (!RUN_ID.test(input.runId) || !input.runId.slice(11).startsWith(group.prefix)) throw new Error(`${input.runId} is not a ${group.name} run.`);
  const file = `${input.session}.jsonl`;
  if (!SESSION_FILE.test(file)) throw new Error("Bad session name.");
  let text = cache.read(input.source, input.runId, file);
  const servedFrom = text === undefined ? "source" : "cache";
  if (text === undefined) {
    text = isGcs(input.source)
      ? await gcsCat(`${trim(input.source)}/runs/${input.runId}/sessions/${file}`)
      : fs.readFileSync(path.join(localRoot(input.source), "runs", input.runId, "sessions", file), "utf8");
    cache.write(input.source, input.runId, file, text);
  }
  log(`procedure transcript ${group.id}/${input.runId}/${input.session}: served from ${servedFrom} (${Buffer.byteLength(text)} bytes)`);
  return { runId: input.runId, session: input.session, messages: messagesOf(text), servedFrom, bytes: Buffer.byteLength(text) };
}
