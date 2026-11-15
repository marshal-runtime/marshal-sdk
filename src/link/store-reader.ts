// Reads a marshal-sdk session store from disk on every call, so one reader serves a live host (whose
// FileSessionStore rewrites index.json on each change) and a finished store alike.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionFilter, SessionRecord, TranscriptMessage } from "../session-store.js";
import { TelemetryBuilder, type EventLine, type Telemetry } from "./telemetry.js";

const INDEX_FILE = "index.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const EVENTS_FILE = "events.jsonl";
export const SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export interface RunSummary {
  runId: string;
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

/** Lines appended to a file since a byte offset; a torn last line waits for the next read. */
export function readLinesFrom(file: string, offset: number): { lines: string[]; offset: number } {
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch {
    return { lines: [], offset };
  }
  try {
    const size = fs.fstatSync(handle).size;
    if (size < offset) offset = 0;
    if (size === offset) return { lines: [], offset };
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(handle, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    const text = buffer.subarray(0, end).toString("utf8");
    return { lines: text.split("\n").filter((line) => line.trim()), offset: offset + end + 1 };
  } finally {
    fs.closeSync(handle);
  }
}

function parseLines<T>(lines: readonly string[]): T[] {
  const rows: T[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A line torn by a crash; the rest still reads.
    }
  }
  return rows;
}

export class StoreReader {
  private telemetryCache = new Map<string, { size: number; telemetry: Telemetry }>();

  constructor(
    readonly root: string,
    private readonly nativeRoots: readonly string[] = [],
  ) {}

  sessions(filter: SessionFilter = {}): SessionRecord[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(this.root, INDEX_FILE), "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return (parsed as SessionRecord[])
      .filter((record) => record && typeof record.id === "string" && SESSION_ID.test(record.id))
      .filter(
        (record) =>
          (filter.runId === undefined || record.runId === filter.runId) &&
          (filter.parentId === undefined || record.parentId === filter.parentId) &&
          (filter.state === undefined || record.state === filter.state) &&
          Object.entries(filter.labels ?? {}).every(([key, value]) => record.labels?.[key] === value),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  session(id: string): SessionRecord | undefined {
    return SESSION_ID.test(id) ? this.sessions().find((record) => record.id === id) : undefined;
  }

  runs(): RunSummary[] {
    const runs = new Map<string, RunSummary>();
    for (const session of this.sessions()) {
      let run = runs.get(session.runId);
      if (!run) {
        run = {
          runId: session.runId,
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
        };
        runs.set(session.runId, run);
      }
      run.sessions += 1;
      if (session.state === "running") run.running += 1;
      if (session.state === "failed") run.failed += 1;
      if (session.model && !run.models.includes(session.model)) run.models.push(session.model);
      run.costUsd += session.usage?.costUsd ?? 0;
      run.outputTokens += session.usage?.outputTokens ?? 0;
      if (session.updatedAt > run.updatedAt) run.updatedAt = session.updatedAt;
    }
    return [...runs.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  transcriptFile(id: string): string {
    return path.join(this.root, id, TRANSCRIPT_FILE);
  }

  eventsFile(id: string): string {
    return path.join(this.root, id, EVENTS_FILE);
  }

  messages(id: string): TranscriptMessage[] {
    return parseLines<TranscriptMessage>(readLinesFrom(this.transcriptFile(id), 0).lines);
  }

  events(id: string, sinceSeq = 0, limit = 200): { events: EventLine[]; total: number } {
    const all = parseLines<EventLine>(readLinesFrom(this.eventsFile(id), 0).lines);
    return { events: all.filter((line) => line.seq > sinceSeq).slice(0, limit), total: all.length };
  }

  /** Recomputed only when events.jsonl grew. */
  telemetry(id: string): Telemetry {
    const file = this.eventsFile(id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // No events yet.
    }
    const cached = this.telemetryCache.get(id);
    if (cached && cached.size === size) return cached.telemetry;
    const builder = new TelemetryBuilder();
    for (const line of parseLines<EventLine>(readLinesFrom(file, 0).lines)) builder.add(line);
    const telemetry = builder.result();
    this.telemetryCache.set(id, { size, telemetry });
    return telemetry;
  }

  /**
   * The backend's own conversation file. Claude keeps a session at `<config dir>/projects/<cwd with
   * non-alphanumerics as '-'>/<id>.jsonl`; a store copied off its machine finds it under a native root.
   */
  nativeFile(session: { native: { kind: string; sessionId?: string; cwd: string; configDir?: string } }): string | undefined {
    const native = session.native;
    if (native?.kind !== "claude" || !native.sessionId || !SESSION_ID.test(native.sessionId)) return undefined;
    const project = String(native.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-");
    const configDirs = [native.configDir, ...this.nativeRoots, path.join(os.homedir(), ".claude")].filter(
      (dir): dir is string => typeof dir === "string" && dir.length > 0,
    );
    for (const dir of configDirs) {
      const direct = path.join(dir, "projects", project, `${native.sessionId}.jsonl`);
      if (fs.existsSync(direct)) return direct;
    }
    for (const dir of this.nativeRoots) {
      let projects: string[];
      try {
        projects = fs.readdirSync(path.join(dir, "projects"));
      } catch {
        continue;
      }
      for (const name of projects) {
        const candidate = path.join(dir, "projects", name, `${native.sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }
}
