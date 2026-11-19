// The link: a small HTTP server on a Marshal SDK host that another Marshal reads and drives.
// Protocol: docs/link.md. Bearer token on every request; without a token the server does not start.
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type { SessionFilter, SessionRecord, SessionState, TranscriptMessage } from "../session-store.js";
import { DEFAULT_MAX_FILE_BYTES, FileAccessError, FileRoots } from "./files.js";
import { DECISION_ID, readDecisions } from "./decisions.js";
import { PageStore } from "./pages.js";
import { readLinesFrom, SESSION_ID, StoreReader } from "./store-reader.js";
import { activityOf, combineTelemetry, type EventLine } from "./telemetry.js";

export const LINK_PROTOCOL_VERSION = 1;
export const MIN_TOKEN_LENGTH = 16;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 500;
const MAX_WAIT_MS = 25_000;
const POLL_MS = 400;
const HEARTBEAT_MS = 15_000;

/** What a live host adds to a store: sending, cancelling, invoking. Absent in store-only mode. */
export interface LinkLivePort {
  send(sessionId: string, text: string, deliveryMode: "queue" | "interrupt"): unknown;
  cancel(sessionId: string): unknown;
  invoke(capability: string, input: unknown): Promise<unknown>;
  extensions(): { identity: string; version: string }[];
  capabilities(): Promise<string[]>;
  /** A person on the linked Marshal answers an open question (src/decisions.ts DecisionDesk.answer, route `link`). */
  answer?(input: { questionId: string; choice?: number; text?: string; by?: { personId?: string; name?: string } }): Promise<{
    accepted: boolean;
    error?: string;
    messageId?: string;
  }>;
}

export interface LinkServerOptions {
  /** Every request must carry `Authorization: Bearer <token>`; at least 16 characters. */
  token: string;
  /** Address to bind. Default 127.0.0.1. */
  bind?: string;
  /** Default 0: a free port. */
  port?: number;
  /** The host's `sessions` folder (state root + /sessions). */
  sessionsRoot: string;
  host: { id: string; kind: string };
  /** Named folders a client may list and read, for example { workspace, output }. */
  files?: Record<string, string>;
  /** Claude config dirs to look for conversation files in when a session's own config dir is not on this machine. */
  nativeRoots?: string[];
  /** A page editor's data folder (pages/ and library/): pages a run made, served for import elsewhere. */
  pagesDir?: string;
  live?: LinkLivePort;
  maxFileBytes?: number;
  log?: (line: string) => void;
}

export interface LinkServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let cachedVersion: string | undefined;
/** The SDK's package version, read from the nearest package.json named @marshal/sdk. */
export function sdkVersion(): string {
  if (cachedVersion) return cachedVersion;
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // Bundled as CommonJS (inside a Marshal extension) there is no module URL.
    return (cachedVersion = "unknown");
  }
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@marshal/sdk" && manifest.version) return (cachedVersion = manifest.version);
    } catch {
      // Not here; look one folder up.
    }
    dir = path.dirname(dir);
  }
  return (cachedVersion = "unknown");
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function boundedMessage(message: TranscriptMessage, index: number): TranscriptMessage & { index: number; truncated?: number } {
  return message.content.length > MAX_MESSAGE_CHARS
    ? { ...message, index, content: message.content.slice(0, MAX_MESSAGE_CHARS), truncated: message.content.length }
    : { ...message, index };
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new HttpError(400, "invalid-request", `Expected an integer, got ${value}.`);
  return Math.min(max, Math.max(min, parsed));
}

/** Starts the link server. Refuses to start without a token of at least 16 characters. */
export async function startLinkServer(options: LinkServerOptions): Promise<LinkServer> {
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The link needs a bearer token of at least ${MIN_TOKEN_LENGTH} characters; refusing to start without one.`);
  }
  const expected = digest(options.token);
  const reader = new StoreReader(options.sessionsRoot, options.nativeRoots ?? []);
  const files = new FileRoots(options.files ?? {});
  const pages = options.pagesDir ? new PageStore(options.pagesDir) : undefined;
  const live = options.live;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const log = options.log ?? (() => undefined);
  const streams = new Set<() => void>();

  const requireSession = (id: string): SessionRecord => {
    const session = SESSION_ID.test(id) ? reader.session(id) : undefined;
    if (!session) throw new HttpError(404, "not-found", `No session ${id} on this host.`);
    return session;
  };
  const requireLive = (): LinkLivePort => {
    if (!live) throw new HttpError(409, "store-only", "This host serves a finished store; it has no runtime to run sessions or capabilities.");
    return live;
  };

  const filterFrom = (query: URLSearchParams): SessionFilter => {
    const labels: Record<string, string> = {};
    for (const pair of query.getAll("label")) {
      const at = pair.indexOf(":");
      if (at <= 0) throw new HttpError(400, "invalid-request", `label takes key:value, got ${pair}.`);
      labels[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const state = query.get("state");
    if (state !== null && !["running", "idle", "failed"].includes(state)) throw new HttpError(400, "invalid-request", `Unknown state ${state}.`);
    return {
      ...(query.get("runId") ? { runId: query.get("runId")! } : {}),
      ...(query.get("parentId") ? { parentId: query.get("parentId")! } : {}),
      ...(state ? { state: state as SessionState } : {}),
      ...(Object.keys(labels).length ? { labels } : {}),
    };
  };

  const transcriptPage = (session: SessionRecord, query: URLSearchParams) => {
    const all = reader.messages(session.id);
    const limit = integer(query.get("limit"), DEFAULT_PAGE, 1, MAX_PAGE);
    const tail = query.get("tail");
    const since = tail !== null ? Math.max(0, all.length - integer(tail, DEFAULT_PAGE, 1, MAX_PAGE)) : integer(query.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    const messages = all.slice(since, since + limit).map((message, offset) => boundedMessage(message, since + offset));
    return { session, total: all.length, cursor: since + messages.length, messages };
  };

  const waitFor = async (check: () => boolean, waitMs: number, request: http.IncomingMessage): Promise<void> => {
    const deadline = Date.now() + waitMs;
    let closed = false;
    request.once("close", () => {
      closed = true;
    });
    while (!check() && !closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  };

  const readBody = (request: http.IncomingMessage): Promise<Record<string, any>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, "too-large", "Request body over 1 MiB."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (size === 0) return resolve({});
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          resolve(parsed as Record<string, any>);
        } catch {
          reject(new HttpError(400, "invalid-request", "The body must be a JSON object."));
        }
      });
      request.on("error", reject);
    });

  /** Server-sent events for one session: its record when it changes, new messages, and activity from backend events. */
  const streamSession = (session: SessionRecord, query: URLSearchParams, request: http.IncomingMessage, response: http.ServerResponse) => {
    let cursor = integer(query.get("since") ?? (request.headers["last-event-id"] as string | undefined) ?? null, reader.messages(session.id).length, 0, Number.MAX_SAFE_INTEGER);
    let transcriptOffset = 0;
    let index = 0;
    let eventsOffset = fs.existsSync(reader.eventsFile(session.id)) ? fs.statSync(reader.eventsFile(session.id)).size : 0;
    let updatedAt = "";
    const send = (event: string, data: unknown, id?: number) => {
      response.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const tick = () => {
      const current = reader.session(session.id);
      if (!current) return;
      if (current.updatedAt !== updatedAt) {
        updatedAt = current.updatedAt;
        send("session", current);
      }
      const read = readLinesFrom(reader.transcriptFile(session.id), transcriptOffset);
      transcriptOffset = read.offset;
      for (const line of read.lines) {
        if (index >= cursor) {
          try {
            send("message", boundedMessage(JSON.parse(line) as TranscriptMessage, index), index + 1);
            cursor = index + 1;
          } catch {
            // Torn line.
          }
        }
        index += 1;
      }
      const events = readLinesFrom(reader.eventsFile(session.id), eventsOffset);
      eventsOffset = events.offset;
      for (const line of events.lines) {
        try {
          for (const activity of activityOf(JSON.parse(line) as EventLine)) send("activity", activity);
        } catch {
          // Torn line.
        }
      }
    };
    return tick;
  };

  /** Server-sent events for a run: session records as they change, and every new message with its session id. */
  const streamRun = (runId: string) => {
    const seen = new Map<string, { updatedAt: string; offset: number; index: number }>();
    let first = true;
    return (send: (event: string, data: unknown) => void) => {
      for (const session of reader.sessions({ runId })) {
        let entry = seen.get(session.id);
        if (!entry) {
          const size = first && fs.existsSync(reader.transcriptFile(session.id)) ? fs.statSync(reader.transcriptFile(session.id)).size : 0;
          entry = { updatedAt: "", offset: size, index: first ? reader.messages(session.id).length : 0 };
          seen.set(session.id, entry);
        }
        if (entry.updatedAt !== session.updatedAt) {
          entry.updatedAt = session.updatedAt;
          send("session", session);
        }
        const read = readLinesFrom(reader.transcriptFile(session.id), entry.offset);
        entry.offset = read.offset;
        for (const line of read.lines) {
          try {
            send("message", { sessionId: session.id, ...boundedMessage(JSON.parse(line) as TranscriptMessage, entry.index) });
          } catch {
            // Torn line.
          }
          entry.index += 1;
        }
      }
      first = false;
    };
  };

  const openStream = (request: http.IncomingMessage, response: http.ServerResponse, tick: () => void) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`retry: 2000\n\n`);
    let lastBeat = Date.now();
    const timer = setInterval(() => {
      try {
        tick();
        if (Date.now() - lastBeat > HEARTBEAT_MS) {
          response.write(`: heartbeat\n\n`);
          lastBeat = Date.now();
        }
      } catch (error) {
        log(`stream tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, POLL_MS);
    const stop = () => {
      clearInterval(timer);
      streams.delete(stop);
      response.end();
    };
    streams.add(stop);
    request.once("close", stop);
    tick();
  };

  const route = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<unknown> => {
    const url = new URL(request.url ?? "/", "http://link");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? "GET";
    if (parts[0] !== "v1") throw new HttpError(404, "not-found", "Unknown path; the API lives under /v1.");
    const [, resource, id, action] = parts;
    const query = url.searchParams;

    if (method === "GET" && resource === "info" && !id) {
      return {
        protocol: LINK_PROTOCOL_VERSION,
        sdkVersion: sdkVersion(),
        host: options.host,
        mode: live ? "live" : "store",
        runs: reader.runs().map((run) => run.runId),
        sessions: reader.sessions().length,
        extensions: live?.extensions() ?? [],
        capabilities: live ? await live.capabilities() : [],
        files: files.names(),
        pages: !!pages,
      };
    }
    if (method === "GET" && resource === "runs" && !id) return { runs: reader.runs() };
    if (resource === "runs" && id && action === "telemetry" && method === "GET") {
      const sessions = reader.sessions({ runId: id });
      if (!sessions.length) throw new HttpError(404, "not-found", `No run ${id} on this host.`);
      const parts = sessions.map((session) => ({ session, telemetry: reader.telemetry(session.id) }));
      return {
        runId: id,
        telemetry: { ...combineTelemetry(parts.map((part) => part.telemetry)), sessions: sessions.length },
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
    }
    if (resource === "runs" && id && action === "stream" && method === "GET") {
      if (!reader.sessions({ runId: id }).length) throw new HttpError(404, "not-found", `No run ${id} on this host.`);
      const tick = streamRun(id);
      openStream(request, response, () => tick((event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)));
      return undefined;
    }
    if (method === "GET" && resource === "sessions" && !id) {
      const text = query.get("q");
      if (text) {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = reader
          .sessions(filterFrom(query))
          .map((session) => {
            const head = `${session.title} ${Object.values(session.labels ?? {}).join(" ")} ${session.runId}`.toLowerCase();
            let score = words.filter((word) => head.includes(word)).length * 3;
            let snippet = session.title;
            for (const message of reader.messages(session.id)) {
              const lower = message.content.toLowerCase();
              const matched = words.filter((word) => lower.includes(word));
              if (!matched.length) continue;
              score += matched.length;
              if (snippet === session.title) {
                const at = Math.max(0, lower.indexOf(matched[0]!) - 60);
                snippet = message.content.slice(at, at + 200);
              }
            }
            return { session, snippet, score };
          })
          .filter((hit) => hit.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, integer(query.get("limit"), 30, 1, 100));
        return { hits };
      }
      return { sessions: reader.sessions(filterFrom(query)) };
    }
    if (resource === "sessions" && id) {
      const session = requireSession(id);
      if (method === "GET" && !action) return { session };
      if (method === "GET" && action === "transcript") {
        const waitMs = integer(query.get("waitMs"), 0, 0, MAX_WAIT_MS);
        if (waitMs > 0 && query.get("tail") === null) {
          const since = integer(query.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
          const knownState = query.get("state");
          const knownUpdatedAt = query.get("updatedAt");
          await waitFor(
            () => {
              const current = reader.session(id);
              return (
                !current ||
                current.messageCount > since ||
                (knownState !== null && current.state !== knownState) ||
                (knownUpdatedAt !== null && current.updatedAt !== knownUpdatedAt)
              );
            },
            waitMs,
            request,
          );
          return transcriptPage(reader.session(id) ?? session, query);
        }
        return transcriptPage(session, query);
      }
      if (method === "GET" && action === "events") {
        const page = reader.events(id, integer(query.get("since"), 0, 0, Number.MAX_SAFE_INTEGER), integer(query.get("limit"), DEFAULT_PAGE, 1, MAX_PAGE));
        return { sessionId: id, ...page, cursor: page.events.at(-1)?.seq ?? integer(query.get("since"), 0, 0, Number.MAX_SAFE_INTEGER) };
      }
      if (method === "GET" && action === "telemetry") return { sessionId: id, state: session.state, telemetry: reader.telemetry(id) };
      if (method === "GET" && action === "stream") {
        openStream(request, response, streamSession(session, query, request, response));
        return undefined;
      }
      if (method === "GET" && action === "native") {
        if (session.state === "running" && query.get("allowRunning") !== "1") {
          throw new HttpError(409, "running", "This session is running; its conversation file is still being written.");
        }
        const file = reader.nativeFile(session);
        if (!file) throw new HttpError(404, "no-native-state", "This session's conversation file is not on this host.");
        const bytes = fs.readFileSync(file);
        return {
          sessionId: id,
          title: session.title,
          nativeSessionId: session.native.sessionId,
          state: { format: "claude-jsonl", encoding: "gzip-base64", data: gzipSync(bytes).toString("base64") },
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      if (method === "POST" && action === "messages") {
        const port = requireLive();
        const body = await readBody(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, "invalid-request", "text is required (at most 64k characters).");
        const mode = body.deliveryMode === "interrupt" ? "interrupt" : "queue";
        return { sessionId: id, accepted: true, agent: port.send(id, text, mode) };
      }
      if (method === "POST" && action === "cancel") {
        return { sessionId: id, agent: requireLive().cancel(id) };
      }
    }
    if (method === "POST" && resource === "invoke" && !id) {
      const port = requireLive();
      const body = await readBody(request);
      if (typeof body.capability !== "string" || !body.capability) throw new HttpError(400, "invalid-request", "capability is required.");
      return { capability: body.capability, output: await port.invoke(body.capability, body.input ?? {}) };
    }
    if (resource === "decisions") {
      if (method === "GET" && !id) {
        const filter = Object.fromEntries(["kind", "status", "runId", "sessionId"].map((key) => [key, query.get(key) ?? undefined]));
        return { decisions: readDecisions(options.sessionsRoot, filter), answers: !!live?.answer };
      }
      if (!id || !DECISION_ID.test(id)) throw new HttpError(404, "not-found", "No such entry.");
      if (method === "GET" && !action) {
        const entry = readDecisions(options.sessionsRoot).find((candidate) => candidate.id === id);
        if (!entry) throw new HttpError(404, "not-found", `No entry ${id} on this host.`);
        return { decision: entry };
      }
      if (method === "POST" && action === "answer") {
        const port = requireLive();
        if (!port.answer) throw new HttpError(409, "no-decisions", "This host takes no answers.");
        const body = await readBody(request);
        const choice = Number.isInteger(body.choice) && body.choice >= 0 ? (body.choice as number) : undefined;
        const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : undefined;
        if (choice === undefined && !text) throw new HttpError(400, "invalid-request", "An answer needs a choice or text.");
        const name = typeof body.by?.name === "string" ? body.by.name.slice(0, 200) : undefined;
        const personId = typeof body.by?.personId === "string" ? body.by.personId.slice(0, 200) : undefined;
        const result = await port.answer({
          questionId: id,
          ...(choice !== undefined ? { choice } : {}),
          ...(text ? { text } : {}),
          ...(name || personId ? { by: { ...(name ? { name } : {}), ...(personId ? { personId } : {}) } } : {}),
        });
        if (!result.accepted) throw new HttpError(409, "not-accepted", result.error ?? "The answer was not accepted.");
        return { questionId: id, ...result };
      }
    }
    if (method === "GET" && resource === "pages") {
      if (!id) {
        const runId = query.get("runId");
        const all = pages?.list(reader.runs()) ?? [];
        return { served: !!pages, pages: runId ? all.filter((page) => page.runId === runId) : all };
      }
      if (!pages) throw new HttpError(404, "no-pages", "This host serves no pages folder.");
      if (!action) {
        const manifest = pages.manifest(id);
        if (!manifest) throw new HttpError(404, "not-found", `No page ${id} on this host.`);
        return manifest;
      }
      const [, , , , brand, name] = parts;
      if (action === "pictures" && brand && name && parts.length === 6) {
        const picture = pages.picture(id, brand, name);
        if (!picture) throw new HttpError(404, "not-found", "That page shows no such picture here.");
        response.writeHead(200, { "content-type": picture.type, "content-length": picture.bytes.length, "cache-control": "no-store" });
        response.end(picture.bytes);
        return undefined;
      }
    }
    if (method === "GET" && resource === "files") {
      const root = query.get("root") ?? "";
      const relative = query.get("path") ?? "";
      if (id === "read") return files.read(root, relative, integer(query.get("maxBytes"), maxFileBytes, 1, maxFileBytes));
      if (!id) return files.list(root, relative);
    }
    throw new HttpError(404, "not-found", `No route ${method} ${url.pathname}.`);
  };

  const server = http.createServer((request, response) => {
    const header = String(request.headers.authorization ?? "");
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !timingSafeEqual(digest(presented), expected)) {
      response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "A valid bearer token is required." } }));
      return;
    }
    route(request, response).then(
      (result) => {
        if (result === undefined) return;
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
      },
      (error: unknown) => {
        const known = error instanceof HttpError ? error : error instanceof FileAccessError ? new HttpError(error.code === "outside-root" ? 403 : error.code === "unknown-root" || error.code === "not-found" ? 404 : 400, error.code, error.message) : undefined;
        const status = known?.status ?? (typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code === "not-found" ? 404 : 500);
        const code = known?.code ?? (status === 404 ? "not-found" : "failed");
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) log(`link ${request.method} ${request.url?.split("?")[0]} failed: ${message}`);
        if (response.headersSent) return response.end();
        response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { code, message } }));
      },
    );
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  const bind = options.bind ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const shown = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind.includes(":") ? `[${bind}]` : bind;
  return {
    url: `http://${shown}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stop of [...streams]) stop();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
