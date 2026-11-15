/**
 * The host room: what an SDK host shows the organization beyond org sessions, over rooms (docs/org.md, "Rooms").
 *
 * The org path already carries sessions, transcripts, checkpoints and instructions (src/org-bridge.ts). The host room
 * carries the rest of what the link (docs/link.md) offers: who the host is and whether it is up (presence), its
 * sessions as they run, and requests for cancel, telemetry, files and the other link reads. Every payload is a link v1
 * payload, so a Marshal that already speaks the link (desktop electron/sdk-hosts) maps one to one. The host dials out;
 * nothing listens.
 *
 * Contract v1, room kind `@marshal/org/host` (schema version 1), room id `host.<host id>`, owned by the person the
 * host runs as; they grant `driver` to whoever may send requests:
 * - `info:host` {v: 1, info: GET /v1/info, owner, at}
 * - `session:<local session id>` {v: 1, session: GET /v1/sessions/:id `.session`, orgSessionId, room} (removed when gone)
 * - `request:<id>` (built-in type): {to: <the person the host runs as>, about?: "info:host" | "session:<id>",
 *   text: JSON {v: 1, method, path, query?, body?}, status: "open"}. A request's addressee is a person (the rooms schema
 *   takes a principal or `agent:team`), and the room is this host's, so whatever is addressed to its person is for it.
 *   The host claims it (status `claimed`, claimedBy = that person) and finishes it: `done` with result JSON
 *   {v: 1, status, body} or, when the body is larger than a record allows, {v: 1, status, file: RoomFileRef, bytes} (the
 *   file holds the body as JSON); `failed` with {v: 1, status, error: {code, message}}, the link's error codes.
 * - presence state {v: 1, host, running, at}, refreshed every `presenceMs`.
 */
import type { RoomFileRef, RoomKindSchema } from "@marshal/agent-runtime-org";

export const HOST_ROOM_KIND = "host";
export const HOST_ROOM_EXTENSION = "@marshal/org";
export const HOST_ROOM_FULL_KIND = `${HOST_ROOM_EXTENSION}/${HOST_ROOM_KIND}`;
export const HOST_ROOM_SCHEMA_VERSION = 1;
export const HOST_ROOM_PROTOCOL = 1;

/** The kind @marshal/org declares in `contributes.rooms`. */
export const HOST_ROOM_SCHEMA: RoomKindSchema = {
  kind: HOST_ROOM_KIND,
  schemaVersion: HOST_ROOM_SCHEMA_VERSION,
  records: {
    info: { fields: { v: "value", info: "value", owner: "value", at: "value" } },
    session: { fields: { v: "value", session: "value", orgSessionId: "value", room: "value" } },
  },
};

/** The link routes a request may name (method, then a path pattern). Streams and `/v1/invoke` are not offered. */
export const HOST_ROOM_ROUTES: readonly { method: "GET" | "POST"; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/v1\/info$/ },
  { method: "GET", pattern: /^\/v1\/runs$/ },
  { method: "GET", pattern: /^\/v1\/runs\/[^/]+\/telemetry$/ },
  { method: "GET", pattern: /^\/v1\/sessions$/ },
  { method: "GET", pattern: /^\/v1\/sessions\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/sessions\/[^/]+\/(transcript|telemetry|native)$/ },
  { method: "POST", pattern: /^\/v1\/sessions\/[^/]+\/(messages|cancel)$/ },
  { method: "GET", pattern: /^\/v1\/files(\/read)?$/ },
  { method: "GET", pattern: /^\/v1\/decisions(\/[^/]+)?$/ },
  { method: "POST", pattern: /^\/v1\/decisions\/[^/]+\/answer$/ },
];

/** A result longer than this goes into a room file instead of the record (`request.result` is at most 32,000 characters). */
export const HOST_ROOM_INLINE_RESULT_CHARS = 31_000;
const RECORD_ID = /[^A-Za-z0-9._:~-]/g;

export interface HostRoomRequest {
  v: 1;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export type HostRoomResult =
  | { v: 1; status: number; body: unknown }
  | { v: 1; status: number; file: RoomFileRef; bytes: number }
  | { v: 1; status: number; error: { code: string; message: string } };

/** A link call answered in process: the link's status and JSON body, or its error. */
export type LinkRelay = (request: Omit<HostRoomRequest, "v">) => Promise<{ status: number; body?: unknown; error?: { code: string; message: string } }>;

export const hostRoomId = (hostId: string): string => `host.${hostId.replace(RECORD_ID, "-")}`.slice(0, 128);

/** Parses a request's text; undefined for anything that is not a v1 request on an offered route. */
export function parseHostRoomRequest(text: unknown): HostRoomRequest | undefined {
  if (typeof text !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const request = value as Partial<HostRoomRequest> | null;
  if (!request || request.v !== HOST_ROOM_PROTOCOL || (request.method !== "GET" && request.method !== "POST") || typeof request.path !== "string") return undefined;
  if (!HOST_ROOM_ROUTES.some((route) => route.method === request.method && route.pattern.test(request.path!))) return undefined;
  // A long poll (waitMs) would hold every later request: the room's own changes are the live signal.
  const query =
    request.query && typeof request.query === "object" && !Array.isArray(request.query)
      ? Object.fromEntries(Object.entries(request.query).filter(([name, item]) => typeof item === "string" && name !== "waitMs"))
      : undefined;
  return { v: 1, method: request.method, path: request.path, ...(query ? { query: query as Record<string, string> } : {}), ...(request.body !== undefined ? { body: request.body } : {}) };
}

/** The part of a runtime `Room` (@marshal/agent-runtime-org RoomsApi) the host room uses. */
export interface HostRoomLike {
  readonly id: string;
  get(key: string): { fields: Record<string, unknown>; updatedBy?: string } | undefined;
  query(filter: { type: string }): { key: string; fields: Record<string, unknown>; updatedBy?: string }[];
  set(key: string, fields: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  subscribe(listener: (event: { kind: string }) => void): () => void;
  presence: { set(state: unknown): void };
  files?: { put(path: string, contentType: string): Promise<RoomFileRef> };
}

export interface HostRoomsLike {
  open(roomId: string): Promise<HostRoomLike>;
  /** Creates (or, on a retry, returns) a room with a chosen id; the SDK's own rooms client has it. */
  createRoom?(input: { id: string; kind: string; schemaVersion: number; workspaceId: string; title: string }): Promise<HostRoomLike>;
  /** The runtime RoomsApi (a host such as the desktop): a declared kind by its short name; the server picks the id. */
  create?(input: { kind: string; workspaceId: string; title: string }): Promise<HostRoomLike>;
  list?(filter?: { kind?: string; workspaceId?: string }): Promise<{ id: string; title: string; kind: string }[]>;
}

export interface HostRoomOptions {
  rooms: HostRoomsLike;
  hostId: string;
  workspaceId: string;
  /** The room title; default `Marshal host <id>`. */
  title?: string;
  /** The person the host runs as: requests are addressed to them. */
  owner: string;
  relay: LinkRelay;
  /** The org session id of a local session, for the session records (`msdk-<id>`). */
  orgSessionIdOf?: (sessionId: string) => string;
  /** How often info, sessions and presence are refreshed. Default 5 s. */
  refreshMs?: number;
  /** Where a large result is written before it goes into the room as a file. Default the OS temp folder. */
  scratchDir?: string;
  log?: (line: string) => void;
}

/**
 * Serves the host room: publishes info, sessions and presence, and answers requests addressed to this host by relaying
 * them to the link API in process (`relay`). Requests are answered one at a time, oldest first.
 */
export class HostRoomEndpoint {
  private room: HostRoomLike | undefined;
  private unsubscribe: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly handled = new Set<string>();
  private readonly published = new Map<string, string>();
  private stopped = false;
  private running = 0;

  constructor(private readonly options: HostRoomOptions) {}

  get roomId(): string | undefined {
    return this.room?.id;
  }

  /** Joins (or creates) the host room, publishes, and answers requests until `stop()`. */
  async start(): Promise<HostRoomLike> {
    this.room = await this.join();
    const room = this.room;
    // Requests left open from before a restart are answered too; finished ones are history.
    this.unsubscribe = room.subscribe((event) => {
      if (event.kind === "records") this.schedule();
    });
    await this.refresh();
    this.schedule();
    await this.queue;
    const every = this.options.refreshMs ?? 5_000;
    this.timer = setInterval(() => void this.refresh().catch((error: unknown) => this.log(`host room refresh failed: ${(error as Error).message}`)), every);
    this.timer.unref?.();
    return room;
  }

  /** Answers every open request now (also runs on each room change). */
  drain(): Promise<void> {
    this.schedule();
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.queue;
    this.room?.presence.set({ v: HOST_ROOM_PROTOCOL, host: this.options.hostId, running: 0, at: new Date().toISOString(), stopped: true });
  }

  /** Publishes info, the session records that changed, and presence. */
  async refresh(): Promise<void> {
    const room = this.room;
    if (!room || this.stopped) return;
    const info = await this.options.relay({ method: "GET", path: "/v1/info" });
    if (info.status === 200) await this.put(room, "info:host", { v: HOST_ROOM_PROTOCOL, info: info.body, owner: this.options.owner }, ["at"]);
    const listed = await this.options.relay({ method: "GET", path: "/v1/sessions" });
    const sessions = listed.status === 200 ? ((listed.body as { sessions?: { id: string; state?: string }[] }).sessions ?? []) : [];
    this.running = sessions.filter((session) => session.state === "running").length;
    const seen = new Set<string>();
    for (const session of sessions) {
      const key = `session:${session.id.replace(RECORD_ID, "-")}`;
      seen.add(key);
      const orgSessionId = this.options.orgSessionIdOf?.(session.id);
      await this.put(room, key, {
        v: HOST_ROOM_PROTOCOL,
        session,
        ...(orgSessionId ? { orgSessionId, room: `session:${orgSessionId}` } : {}),
      });
    }
    for (const record of room.query({ type: "session" })) {
      if (!seen.has(record.key)) {
        await room.delete(record.key);
        this.published.delete(record.key);
      }
    }
    room.presence.set({ v: HOST_ROOM_PROTOCOL, host: this.options.hostId, running: this.running, at: new Date().toISOString() });
  }

  private async join(): Promise<HostRoomLike> {
    const { rooms, hostId, workspaceId } = this.options;
    const title = this.options.title ?? `Marshal host ${hostId}`;
    const id = hostRoomId(hostId);
    if (rooms.createRoom) return rooms.createRoom({ id, kind: HOST_ROOM_FULL_KIND, schemaVersion: HOST_ROOM_SCHEMA_VERSION, workspaceId, title });
    // A runtime RoomsApi picks the id: find this host's room by its title before making one.
    const existing = (await rooms.list?.({ kind: HOST_ROOM_KIND, workspaceId })) ?? [];
    const mine = existing.find((summary) => summary.title === title);
    if (mine) return rooms.open(mine.id);
    if (!rooms.create) throw new Error("The rooms service here can neither create a room with a chosen id nor one of a declared kind.");
    return rooms.create({ kind: HOST_ROOM_KIND, workspaceId, title });
  }

  /** Writes a record only when its fields (minus volatile ones) changed. */
  private async put(room: HostRoomLike, key: string, fields: Record<string, unknown>, volatile: string[] = []): Promise<void> {
    const signature = JSON.stringify(fields);
    if (this.published.get(key) === signature) return;
    this.published.set(key, signature);
    await room.set(key, volatile.includes("at") ? { ...fields, at: new Date().toISOString() } : fields);
  }

  private schedule(): void {
    this.queue = this.queue.then(() => this.answerOpen()).catch((error: unknown) => this.log(`host room: ${(error as Error).message}`));
  }

  private async answerOpen(): Promise<void> {
    const room = this.room;
    if (!room || this.stopped) return;
    for (const record of room.query({ type: "request" })) {
      const fields = record.fields;
      if (fields.to !== this.options.owner || fields.status !== "open" || this.handled.has(record.key)) continue;
      this.handled.add(record.key);
      await this.answer(room, record.key, fields, record.updatedBy);
    }
  }

  private async answer(room: HostRoomLike, key: string, fields: Record<string, unknown>, by: string | undefined): Promise<void> {
    const claimed = { ...fields, status: "claimed", claimedBy: this.options.owner };
    await room.set(key, { status: "claimed", claimedBy: this.options.owner });
    const request = parseHostRoomRequest(fields.text);
    let result: HostRoomResult;
    if (!request) {
      result = { v: 1, status: 400, error: { code: "invalid-request", message: "Not a v1 host-room request on an offered link route." } };
    } else {
      this.log(`host room: ${request.method} ${request.path} from ${by ?? "someone"}`);
      try {
        const answer = await this.options.relay({ method: request.method, path: request.path, ...(request.query ? { query: request.query } : {}), ...(request.body !== undefined ? { body: request.body } : {}) });
        result = answer.error ? { v: 1, status: answer.status, error: answer.error } : await this.inline(room, answer.status, answer.body);
      } catch (error) {
        result = { v: 1, status: 500, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }
    const ok = !("error" in result);
    await room.set(key, { ...claimed, status: ok ? "done" : "failed", result: JSON.stringify(result) });
    if (request?.method === "POST") await this.refresh().catch(() => undefined);
  }

  /** The body itself, or a room file holding it when it is too large for the record. */
  private async inline(room: HostRoomLike, status: number, body: unknown): Promise<HostRoomResult> {
    const text = JSON.stringify(body ?? null);
    const bytes = Buffer.byteLength(text);
    if (JSON.stringify({ v: 1, status, body: body ?? null }).length <= HOST_ROOM_INLINE_RESULT_CHARS) return { v: 1, status, body: body ?? null };
    if (!room.files) return { v: 1, status: 413, error: { code: "too-large", message: `The answer is ${bytes} bytes; this room takes no files, so ask for less (tail, maxBytes) or use the link.` } };
    const { default: fs } = await import("node:fs");
    const { default: os } = await import("node:os");
    const { default: path } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const file = path.join(this.options.scratchDir ?? os.tmpdir(), `host-room-${randomUUID()}.json`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    try {
      return { v: 1, status, file: await room.files.put(file, "application/json"), bytes };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

/** A link relay over HTTP to a link server (the host's own, on loopback): the same payloads a linked Marshal gets. */
export function httpLinkRelay(url: string, token: () => string | Promise<string>, fetchFn: typeof globalThis.fetch = globalThis.fetch): LinkRelay {
  const base = url.replace(/\/+$/, "");
  return async (request) => {
    const query = request.query && Object.keys(request.query).length ? `?${new URLSearchParams(request.query).toString()}` : "";
    const response = await fetchFn(`${base}${request.path}${query}`, {
      method: request.method,
      headers: { authorization: `Bearer ${await token()}`, ...(request.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (response.ok) return { status: response.status, body };
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    return { status: response.status, error: { code: error?.code ?? "failed", message: error?.message ?? `HTTP ${response.status}` } };
  };
}
