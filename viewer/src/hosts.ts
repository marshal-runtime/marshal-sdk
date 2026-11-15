// Hosts the viewer reads: local folders (session stores on this machine) and linked hosts (a marshal-sdk
// serving the link, docs/link.md). Both answer the same calls so the tab and the capabilities don't care which.
import fs from "fs";
import os from "os";
import path from "path";
import { gzipSync } from "zlib";

import { LinkClient, LinkError } from "../../src/link/client";
import { FileRoots } from "../../src/link/files";
import { StoreReader } from "../../src/link/store-reader";
import { activityOf, combineTelemetry, type Activity, type EventLine, type Telemetry } from "../../src/link/telemetry";
import { findStores, readSessions, readTranscript, summarizeRuns, type SessionRecord, type TranscriptMessage } from "./store";

type Row = Record<string, any>;

export const LOCAL_HOST_ID = "local";
const INFO_TIMEOUT_MS = 4000;
const MAX_WAIT_MS = 20_000;
const POLL_MS = 400;
const MAX_MESSAGE_CHARS = 20_000;

export interface LinkedHostConfig {
  id: string;
  name?: string;
  url: string;
  token: string;
}

export interface HostSummary {
  id: string;
  name: string;
  kind: "folder" | "link";
  /** The URL without any credentials in it. */
  url?: string;
  /** The last four characters of the token, never more. */
  token?: string;
  roots?: string[];
}

export interface TranscriptPage {
  found: boolean;
  session?: SessionRecord;
  total: number;
  cursor: number;
  messages: (TranscriptMessage & { index: number; truncated?: number })[];
}

export interface WatchResult extends TranscriptPage {
  activity: Activity[];
  eventCursor: number;
}

export interface Host {
  summary: HostSummary;
  info(): Promise<Row>;
  runs(): Promise<Row[]>;
  sessions(runId: string): Promise<SessionRecord[]>;
  session(sessionId: string): Promise<SessionRecord | undefined>;
  transcript(sessionId: string, options: { since?: number; tail?: number; limit?: number }): Promise<TranscriptPage>;
  watch(sessionId: string, options: { since: number; eventCursor: number; state?: string; updatedAt?: string; waitMs: number }): Promise<WatchResult>;
  telemetry(target: { sessionId?: string; runId?: string }): Promise<Row>;
  files(runId: string | undefined, root: string | undefined, relative: string): Promise<Row>;
  readFile(runId: string | undefined, root: string, relative: string, maxBytes?: number): Promise<Row>;
  events(sessionId: string, since: number, limit: number): Promise<{ events: EventLine[]; total: number }>;
  search(query: string, limit: number): Promise<Row[]>;
  send(sessionId: string, text: string, deliveryMode: "queue" | "interrupt"): Promise<Row>;
  cancel(sessionId: string): Promise<Row>;
  /** The envelope marshal.sessions.importNative takes, or why there is none. */
  native(sessionId: string): Promise<{ ok: true; state: Row; title: string; bytes: number } | { ok: false; reason: string; message: string }>;
}

const bound = (message: TranscriptMessage, index: number) =>
  message.content.length > MAX_MESSAGE_CHARS
    ? { ...message, index, content: message.content.slice(0, MAX_MESSAGE_CHARS), truncated: message.content.length }
    : { ...message, index };

function page(session: SessionRecord | undefined, all: TranscriptMessage[], options: { since?: number; tail?: number; limit?: number }): TranscriptPage {
  if (!session) return { found: false, total: 0, cursor: 0, messages: [] };
  const limit = Math.min(500, Math.max(1, options.limit ?? 500));
  const since = options.tail !== undefined ? Math.max(0, all.length - options.tail) : Math.max(0, options.since ?? 0);
  const messages = all.slice(since, since + limit).map((message, offset) => bound(message, since + offset));
  return { found: true, session, total: all.length, cursor: since + messages.length, messages };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run folder is `<run>/state/sessions`; its workspace and output sit beside state as ws/ and out/. */
function runFolders(store: string): Record<string, string> {
  if (path.basename(path.dirname(store)) !== "state") return {};
  const run = path.dirname(path.dirname(store));
  const folders: Record<string, string> = {};
  for (const [name, dir] of [["workspace", "ws"], ["output", "out"], ["data", "data"]] as const) {
    if (fs.existsSync(path.join(run, dir))) folders[name] = path.join(run, dir);
  }
  return folders;
}

/** Session stores under folders on this machine: what the viewer always showed. */
export function folderHost(roots: readonly string[]): Host {
  const stores = () => findStores(roots);
  const locate = (sessionId: string) => {
    for (const store of stores()) {
      const session = readSessions(store).find((record) => record.id === sessionId);
      if (session) return { store, session, reader: new StoreReader(store) };
    }
    return undefined;
  };
  const storeOfRun = (runId: string | undefined) => {
    for (const store of stores()) if (!runId || readSessions(store).some((session) => session.runId === runId)) return store;
    return undefined;
  };
  return {
    summary: { id: LOCAL_HOST_ID, name: "This Mac (folders)", kind: "folder", roots: [...roots] },
    async info() {
      const found = stores();
      return { status: "local", mode: "folder", stores: found, runs: summarizeRuns(found).length, extensions: [], capabilities: [], files: ["workspace", "output", "data"] };
    },
    async runs() {
      return summarizeRuns(stores());
    },
    async sessions(runId) {
      return stores()
        .flatMap((store) => readSessions(store).filter((session) => session.runId === runId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    async session(sessionId) {
      return locate(sessionId)?.session;
    },
    async transcript(sessionId, options) {
      const found = locate(sessionId);
      return page(found?.session, found ? readTranscript(found.store, sessionId) : [], options);
    },
    async watch(sessionId, options) {
      const deadline = Date.now() + Math.min(MAX_WAIT_MS, Math.max(0, options.waitMs));
      for (;;) {
        const found = locate(sessionId);
        const changed =
          !found ||
          found.session.messageCount > options.since ||
          (options.state !== undefined && found.session.state !== options.state) ||
          (options.updatedAt !== undefined && found.session.updatedAt !== options.updatedAt);
        if (changed || Date.now() >= deadline) {
          const transcript = page(found?.session, found ? readTranscript(found.store, sessionId) : [], { since: options.since });
          const events = found ? found.reader.events(sessionId, options.eventCursor, 500).events : [];
          return { ...transcript, activity: events.flatMap(activityOf), eventCursor: events.at(-1)?.seq ?? options.eventCursor };
        }
        await sleep(POLL_MS);
      }
    },
    async telemetry(target) {
      if (target.sessionId) {
        const found = locate(target.sessionId);
        if (!found) return { found: false };
        return { found: true, sessionId: target.sessionId, state: found.session.state, telemetry: found.reader.telemetry(target.sessionId) };
      }
      const runId = String(target.runId ?? "");
      const parts: { session: SessionRecord; telemetry: Telemetry }[] = [];
      for (const store of stores()) {
        const reader = new StoreReader(store);
        for (const session of reader.sessions({ runId })) parts.push({ session, telemetry: reader.telemetry(session.id) });
      }
      if (!parts.length) return { found: false };
      return {
        found: true,
        runId,
        telemetry: { ...combineTelemetry(parts.map((part) => part.telemetry)), sessions: parts.length },
        sessions: parts.map(({ session, telemetry }) => ({
          id: session.id,
          title: session.title,
          state: session.state,
          costUsd: telemetry.costUsd,
          outputTokens: telemetry.tokens.output,
          turns: telemetry.turns,
          toolCallTotal: telemetry.toolCallTotal,
          errors: telemetry.errors.count,
        })),
      };
    },
    async files(runId, root, relative) {
      const store = storeOfRun(runId);
      const roots = new FileRoots(store ? runFolders(store) : {});
      if (!root) return { roots: roots.names() };
      return { roots: roots.names(), ...roots.list(root, relative) };
    },
    async readFile(runId, root, relative, maxBytes) {
      const store = storeOfRun(runId);
      return new FileRoots(store ? runFolders(store) : {}).read(root, relative, maxBytes);
    },
    async events(sessionId, since, limit) {
      const found = locate(sessionId);
      return found ? found.reader.events(sessionId, since, limit) : { events: [], total: 0 };
    },
    async search(query, limit) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: Row[] = [];
      for (const store of stores()) {
        for (const session of readSessions(store)) {
          const head = `${session.title} ${Object.values(session.labels ?? {}).join(" ")} ${session.runId}`.toLowerCase();
          let score = words.filter((word) => head.includes(word)).length * 3;
          let snippet = session.title;
          for (const message of readTranscript(store, session.id)) {
            const text = String(message.content ?? "").toLowerCase();
            const matched = words.filter((word) => text.includes(word));
            if (!matched.length) continue;
            score += matched.length;
            if (snippet === session.title) {
              const at = Math.max(0, text.indexOf(matched[0]!) - 60);
              snippet = String(message.content).slice(at, at + 200);
            }
          }
          if (score > 0) hits.push({ session, snippet, score });
        }
      }
      return hits.sort((left, right) => right.score - left.score).slice(0, limit);
    },
    async send() {
      return {
        ok: false,
        reason: "read-only",
        message: "This run is a folder on this Mac with no host running it. Serve it with `marshal-sdk serve` and add it as a linked host to talk to it.",
      };
    },
    async cancel() {
      return { ok: false, reason: "read-only", message: "Nothing runs this folder's sessions." };
    },
    async native(sessionId) {
      const found = locate(sessionId);
      if (!found) return { ok: false, reason: "not-found", message: "This session is not in the stores any more." };
      if (found.session.state === "running") return { ok: false, reason: "running", message: "This session is still running. Continue it once it is idle." };
      const file = found.reader.nativeFile(found.session);
      if (!file) return { ok: false, reason: "no-native-state", message: "This session's Claude conversation file isn't on this machine." };
      const bytes = fs.readFileSync(file);
      return { ok: true, title: found.session.title, bytes: bytes.length, state: { format: "claude-jsonl", encoding: "gzip-base64", data: gzipSync(bytes).toString("base64") } };
    },
  };
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

/** Why a link call failed, in words for the tab; never includes the token. */
export function linkProblem(error: unknown): { reason: string; message: string } {
  if (error instanceof LinkError) {
    if (error.status === 401) return { reason: "unauthorized", message: "The host refused the token. Check the token configured for it." };
    if (error.code === "unreachable" || error.code === "timeout") return { reason: "offline", message: error.message };
    return { reason: error.code, message: error.message };
  }
  return { reason: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** A marshal-sdk host serving the link. */
export function linkedHost(config: LinkedHostConfig): Host {
  const client = new LinkClient({ url: config.url, token: config.token });
  const quick = new LinkClient({ url: config.url, token: config.token, timeoutMs: INFO_TIMEOUT_MS });
  return {
    summary: { id: config.id, name: config.name ?? config.id, kind: "link", url: safeUrl(config.url), token: `••••${config.token.slice(-4)}` },
    async info() {
      try {
        return { status: "online", ...(await quick.info()) };
      } catch (error) {
        return { status: "offline", ...linkProblem(error) };
      }
    },
    async runs() {
      return (await client.runs()).runs;
    },
    async sessions(runId) {
      return (await client.sessions({ runId })).sessions;
    },
    async session(sessionId) {
      try {
        return (await client.session(sessionId)).session;
      } catch (error) {
        if (error instanceof LinkError && error.status === 404) return undefined;
        throw error;
      }
    },
    async transcript(sessionId, options) {
      try {
        return { found: true, ...(await client.transcript(sessionId, options)) };
      } catch (error) {
        if (error instanceof LinkError && error.status === 404) return { found: false, total: 0, cursor: 0, messages: [] };
        throw error;
      }
    },
    async watch(sessionId, options) {
      const transcript = await client.transcript(sessionId, {
        since: options.since,
        waitMs: Math.min(MAX_WAIT_MS, options.waitMs),
        ...(options.state ? { state: options.state } : {}),
        ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
      });
      const events = (await client.events(sessionId, options.eventCursor, 500)) as { events: EventLine[] };
      return { found: true, ...transcript, activity: events.events.flatMap(activityOf), eventCursor: events.events.at(-1)?.seq ?? options.eventCursor };
    },
    async telemetry(target) {
      try {
        return { found: true, ...(target.sessionId ? await client.sessionTelemetry(target.sessionId) : await client.runTelemetry(String(target.runId))) };
      } catch (error) {
        if (error instanceof LinkError && error.status === 404) return { found: false };
        throw error;
      }
    },
    async files(_runId, root, relative) {
      const roots = ((await client.info()).files ?? []) as string[];
      if (!root) return { roots };
      return { roots, ...(await client.files(root, relative)) };
    },
    async readFile(_runId, root, relative, maxBytes) {
      return client.readFile(root, relative, maxBytes);
    },
    async events(sessionId, since, limit) {
      return client.events(sessionId, since, limit);
    },
    async search(query, limit) {
      return (await client.sessions({ q: query, limit })).hits;
    },
    async send(sessionId, text, deliveryMode) {
      try {
        const out = await client.send(sessionId, text, deliveryMode);
        return { ok: true, message: "Sent.", agent: out.agent };
      } catch (error) {
        if (error instanceof LinkError && error.code === "store-only") {
          return { ok: false, reason: "store-only", message: "This host serves a finished run; nothing is running to answer." };
        }
        return { ok: false, ...linkProblem(error) };
      }
    },
    async cancel(sessionId) {
      try {
        return { ok: true, agent: (await client.cancel(sessionId)).agent };
      } catch (error) {
        return { ok: false, ...linkProblem(error) };
      }
    },
    async native(sessionId) {
      try {
        const out = await client.native(sessionId);
        return { ok: true, state: out.state, title: out.title, bytes: out.bytes };
      } catch (error) {
        const problem = linkProblem(error);
        if (problem.reason === "running") return { ok: false, reason: "running", message: "This session is still running. Continue it once it is idle." };
        if (problem.reason === "no-native-state") return { ok: false, reason: "no-native-state", message: "The host doesn't have this session's Claude conversation file." };
        return { ok: false, ...problem };
      }
    },
  };
}

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Linked hosts from the extension's configuration (`hosts: [{ id, name?, url, token | tokenFile }]`); bad entries are reported, not used. */
export function configuredLinks(configuration: Row | undefined): { hosts: LinkedHostConfig[]; problems: string[] } {
  const hosts: LinkedHostConfig[] = [];
  const problems: string[] = [];
  const entries = Array.isArray(configuration?.hosts) ? configuration.hosts : [];
  for (const [index, entry] of entries.entries()) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!HOST_ID.test(id) || id === LOCAL_HOST_ID) {
      problems.push(`hosts[${index}]: id must be lowercase letters, digits and dashes (and not "local").`);
      continue;
    }
    if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
      problems.push(`${id}: url must start with http:// or https://.`);
      continue;
    }
    let token = typeof entry.token === "string" ? entry.token : "";
    if (!token && typeof entry.tokenFile === "string") {
      try {
        token = fs.readFileSync(entry.tokenFile.startsWith("~") ? path.join(os.homedir(), entry.tokenFile.slice(1)) : entry.tokenFile, "utf8").trim();
      } catch {
        problems.push(`${id}: tokenFile can't be read.`);
        continue;
      }
    }
    if (token.length < 16) {
      problems.push(`${id}: token (or tokenFile) must hold at least 16 characters.`);
      continue;
    }
    if (hosts.some((host) => host.id === id)) {
      problems.push(`${id}: listed twice; the first one is used.`);
      continue;
    }
    hosts.push({ id, url: entry.url, token, ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}) });
  }
  return { hosts, problems };
}
