// Read-only view over marshal-sdk session stores (src/session-store.ts writes them): index.json plus
// <session id>/transcript.jsonl per store. A store is one host's state/sessions folder; a run is one runId in it.
import fs from "fs";
import os from "os";
import path from "path";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  state: "running" | "idle" | "failed";
  createdAt: string;
  updatedAt: string;
  runtime: string;
  model?: string;
  reasoningEffort?: string;
  native: { kind: string; sessionId?: string; cwd: string; configDir?: string };
  parentId?: string;
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
}

export interface RunSummary {
  runId: string;
  store: string;
  host: { id: string; kind: string };
  startedAt: string;
  updatedAt: string;
  sessions: number;
  running: number;
  failed: number;
  models: string[];
  costUsd: number;
  outputTokens: number;
  firstTitle: string;
}

const INDEX = "index.json";
const MAX_SCAN_DEPTH = 4;

export function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

/** Store folders under the given roots: a root is a store itself or is searched (a few levels) for state/sessions/index.json. */
export function findStores(roots: readonly string[]): string[] {
  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, INDEX))) {
      found.add(dir);
      return;
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  for (const root of roots) walk(path.resolve(expandHome(root)), 0);
  return [...found].sort();
}

export function readSessions(store: string): SessionRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(store, INDEX), "utf8"));
    return Array.isArray(parsed) ? (parsed as SessionRecord[]).filter((record) => record && typeof record.id === "string") : [];
  } catch {
    return [];
  }
}

export function readTranscript(store: string, sessionId: string): TranscriptMessage[] {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) return [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(store, sessionId, "transcript.jsonl"), "utf8");
  } catch {
    return [];
  }
  const rows: TranscriptMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as TranscriptMessage);
    } catch {
      // A torn last line while the run is still writing.
    }
  }
  return rows;
}

export function summarizeRuns(stores: readonly string[]): RunSummary[] {
  const runs = new Map<string, RunSummary>();
  for (const store of stores) {
    for (const session of readSessions(store)) {
      const key = `${store}\u0000${session.runId}`;
      const run =
        runs.get(key) ??
        ({
          runId: session.runId,
          store,
          host: session.host,
          startedAt: session.createdAt,
          updatedAt: session.updatedAt,
          sessions: 0,
          running: 0,
          failed: 0,
          models: [],
          costUsd: 0,
          outputTokens: 0,
          firstTitle: session.title,
        } satisfies RunSummary);
      run.sessions += 1;
      if (session.state === "running") run.running += 1;
      if (session.state === "failed") run.failed += 1;
      if (session.model && !run.models.includes(session.model)) run.models.push(session.model);
      run.costUsd += session.usage?.costUsd ?? 0;
      run.outputTokens += session.usage?.outputTokens ?? 0;
      if (session.createdAt < run.startedAt) {
        run.startedAt = session.createdAt;
        run.firstTitle = session.title;
      }
      if (session.updatedAt > run.updatedAt) run.updatedAt = session.updatedAt;
      runs.set(key, run);
    }
  }
  return [...runs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** Claude keeps a session at `<config dir or ~/.claude>/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl` (same as src/org-publish.ts). */
export function claudeNativeFile(session: Pick<SessionRecord, "native">): string | undefined {
  const { native } = session;
  if (native?.kind !== "claude" || !native.sessionId || !/^[A-Za-z0-9_.-]+$/.test(native.sessionId)) return undefined;
  const configDir = native.configDir ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", native.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${native.sessionId}.jsonl`);
}

export function findSession(stores: readonly string[], sessionId: string): { store: string; session: SessionRecord } | undefined {
  for (const store of stores) {
    const session = readSessions(store).find((record) => record.id === sessionId);
    if (session) return { store, session };
  }
  return undefined;
}

export interface SearchHit {
  session: SessionRecord;
  store: string;
  snippet: string;
  score: number;
}

/** Word search over titles, labels and transcripts, the same scoring as the SDK's own store. */
export function searchSessions(stores: readonly string[], query: string, limit: number): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const store of stores) {
    for (const session of readSessions(store)) {
      const head = `${session.title} ${Object.values(session.labels ?? {}).join(" ")} ${session.runId}`.toLowerCase();
      let score = words.filter((word) => head.includes(word)).length * 3;
      let snippet = session.title;
      for (const message of readTranscript(store, session.id)) {
        const text = String(message.content ?? "").toLowerCase();
        const matched = words.filter((word) => text.includes(word));
        if (matched.length === 0) continue;
        score += matched.length;
        if (snippet === session.title) {
          const at = Math.max(0, text.indexOf(matched[0]!) - 60);
          snippet = String(message.content).slice(at, at + 200);
        }
      }
      if (score > 0) hits.push({ session, store, snippet, score });
    }
  }
  return hits.sort((left, right) => right.score - left.score).slice(0, limit);
}
