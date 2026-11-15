// Lifted from OmerMachluf/marshal electron/org/rooms/rooms-manager.ts at c75500b1b (copied, not imported); adapted for the SDK (no Electron, local logger, node:fs).
import { randomUUID } from "node:crypto";
import { stat as fsStat } from "node:fs/promises";
import * as path from "node:path";

import {
  MAX_PRESENCE_BYTES,
  MAX_ROOM_FILE_BYTES,
  MAX_ROOM_CHANGE_BYTES,
  ROOM_ROUTES,
  MAX_ROOM_TEXT_RESET_FRAME_BYTES,
  MAX_ROOM_TEXT_UPDATE_BYTES,
  RoomTextTooLargeError,
  RoomWriteError,
  checkRoomWrite,
  isRoomTextReset,
  mergeRoomTextState,
  summarizeRoomTextHistory,
  isRoomRecordKey,
  jsonBytes,
  roomRecordKeyType,
  parseRoomEnvelope,
  parseRoomGrantList,
  parseRoomList,
  roomPositionBetween,
  roomRoleAllows,
  type RoomActor,
  type RoomApiChange,
  type RoomChange,
  type RoomEnvelope,
  type RoomEvent,
  type RoomFileRef,
  type RoomKindSchema,
  type RoomMember,
  type RoomPresence,
  type RoomRecord,
  type RoomRecordState,
  type RoomRecordKey,
  type RoomSummary,
  type RoomTextCursor,
  type RoomTextEvent,
  type RoomTextReplica,
  type RoomTextRun,
  type RoomTextUpdate,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import { createLogger } from "./log.js";
import { RoomFileCache, RoomFileError, parseRoomFileRef } from "./rooms-file-cache.js";
import { RoomsReplica, type OutboxEntry, type ReplicaRoom } from "./rooms-replica.js";
import { declarationFor } from "./rooms-schema.js";
import { RoomsSocketClient, type RoomsSocketEvent, type RoomsSocketFactory } from "./rooms-socket.js";
import { RoomTexts, textFieldsOf, type TextReading, type TextSend } from "./rooms-text.js";
import { uploadFileStreaming, type UploadFile } from "./rooms-upload.js";

const log = createLogger("OrgRooms");
const ROOM_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TITLE = 200;

export interface RoomsEndpoint {
  orgId: string;
  apiBase: string;
  socketUrl: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OrgRoomsManagerDeps {
  endpoint: RoomsEndpoint;
  token: () => Promise<string>;
  /** The signed-in person as the organization names them (`user:<email>`). */
  person: () => Promise<`user:${string}` | undefined>;
  /** `~/.marshal/org-rooms` */
  root: string;
  createSocket: RoomsSocketFactory;
  fetch?: FetchLike;
  /** Identifies this host among the person's clients (added in the SDK lift). */
  clientId?: string;
  /** PUTs a file from disk to an upload address; streams with a known length by default. */
  uploadFile?: UploadFile;
  now?: () => number;
  /** Every room event, for pushing into open screens. */
  onRoomEvent?: (room: { id: string; kind: string }, event: RoomEvent) => void;
  /** Socket tuning for tests. */
  socket?: {
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    random?: () => number;
    retryMs?: number;
  };
}

/** Who is calling, decided by the host (never by the extension). */
export interface RoomsCaller {
  /** The calling extension's identity, stamped by the extension manager; undefined for host tools. */
  extension?: string;
  actor: RoomActor;
  /** The calling extension's `contributes.rooms`; writes need a declaration of the room's kind. */
  declarations: readonly RoomKindSchema[];
  /**
   * Host code only (never set for an extension): the host's own schema of a built-in kind such as
   * `marshal/conversation`, which writes to rooms of that kind are checked against.
   */
  builtin?: RoomKindSchema;
}

const errorBody = z.object({ error: z.string() });
/**
 * Longest wait between reconnect attempts (full jitter, so about half on average): text shows again within a second of the
 * network coming back.
 */
const MAX_RECONNECT_BACKOFF_MS = 1000;
/**
 * How long one field's keystrokes are held to go out as one change: a frame (the contract suggests up to 50 ms). The
 * first keystroke after a quiet spell goes out at once, so this adds latency only inside a burst.
 */
const TEXT_BATCH_MS = 16;

/** One field's keystrokes of the last TEXT_BATCH_MS, shown at once in the live text and sent as one change. */
interface TextBatch {
  room: string;
  record: RoomRecordKey;
  type: string;
  field: string;
  gen: number;
  updates: string[];
  bytes: number;
  actor: RoomActor;
  author: `user:${string}`;
  timer: ReturnType<typeof setTimeout>;
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

function isUserPrincipal(value: string): value is `user:${string}` {
  return value.startsWith("user:") && value.length > "user:".length;
}

export function apiChangeOf(change: RoomChange): RoomApiChange {
  return { ...change, pending: false };
}

function apiPendingChange(entry: OutboxEntry): RoomApiChange {
  return {
    seq: null,
    epoch: null,
    pending: true,
    id: entry.id,
    author: entry.author,
    actor: entry.actor,
    at: entry.at,
    record: entry.record,
    type: entry.type,
    op: entry.op,
    ...(entry.set ? { set: entry.set } : {}),
    ...(entry.text ? { text: entry.text } : {}),
    ...(entry.base !== undefined ? { base: entry.base } : {}),
  };
}

function apiRecordOf(record: RoomRecordState, pending: boolean): RoomRecord {
  return {
    key: record.key,
    type: record.type,
    fields: record.fields,
    seq: record.updatedSeq,
    updatedBy: record.updatedBy,
    pending,
  };
}

function summaryOf(room: ReplicaRoom): RoomSummary {
  return {
    id: room.id,
    kind: room.kind,
    workspaceId: room.workspaceId,
    title: room.title,
    owner: isUserPrincipal(room.owner) ? room.owner : "user:unknown",
    role: room.role,
    status: room.status,
    updatedAt: room.updatedAt,
  };
}

function envelopeSummary(envelope: RoomEnvelope): RoomSummary {
  return {
    id: envelope.id,
    kind: envelope.kind,
    workspaceId: envelope.workspaceId,
    title: envelope.title,
    owner: envelope.owner,
    role: envelope.role,
    status: envelope.archivedAt ? "gone" : "offline",
    updatedAt: envelope.updatedAt,
  };
}

/**
 * Every room of one signed-in organization on this desktop: the replica, the socket and the HTTP
 * routes beside it. Writes land in the replica first (shown at once) and leave through the socket.
 */
export class OrgRoomsManager {
  readonly replica: RoomsReplica;
  readonly files: RoomFileCache;
  readonly socket: RoomsSocketClient;
  private readonly texts: RoomTexts;
  private readonly textBatches = new Map<string, TextBatch>();
  /** When each field's last batch went out: the first keystroke after a quiet TEXT_BATCH_MS goes out at once. */
  private readonly textSentAt = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(event: RoomEvent) => void>>();
  private readonly presence = new Map<string, Map<string, RoomPresence>>();
  private readonly waiting = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private started = false;

  constructor(private readonly deps: OrgRoomsManagerDeps) {
    this.replica = RoomsReplica.forOrg(deps.root, deps.endpoint.orgId);
    this.files = new RoomFileCache(path.join(deps.root, "files"));
    this.texts = new RoomTexts(this.replica, (sends) => this.sendText(sends));
    this.socket = new RoomsSocketClient({
      socketUrl: deps.endpoint.socketUrl,
      token: deps.token,
      replica: this.replica,
      createSocket: deps.createSocket,
      onEvent: (event) => this.onSocketEvent(event),
      ...(deps.clientId ? { clientId: deps.clientId } : {}),
      maxBackoffMs: MAX_RECONNECT_BACKOFF_MS,
      ...deps.socket,
    });
  }

  get orgId(): string {
    return this.deps.endpoint.orgId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const room of this.replica.listRooms()) {
      if (room.joined && room.status !== "revoked" && room.status !== "gone")
        this.socket.join(room.id);
    }
    this.socket.start();
  }

  stop(): void {
    this.started = false;
    this.flushTextBatches();
    this.socket.stop();
    for (const waiter of this.waiting.values())
      waiter.reject(new RoomWriteError("busy", { message: "rooms stopped" }));
    this.waiting.clear();
    this.texts.close();
    this.replica.close();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async http(method: string, route: string, body?: unknown): Promise<unknown> {
    const token = await this.deps.token();
    const fetchImpl = this.deps.fetch ?? fetch;
    const response = await fetchImpl(`${this.deps.endpoint.apiBase.replace(/\/$/, "")}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const code = errorBody.safeParse(value).data?.error ?? `http-${response.status}`;
      const refusal =
        response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "gone"
            : response.status === 409
              ? "conflict"
              : "invalid";
      throw new RoomWriteError(refusal, {
        message: `rooms ${method} ${route.split("?")[0]} failed: ${code}`,
      });
    }
    return value;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private emit(roomId: string, event: RoomEvent): void {
    for (const listener of this.listeners.get(roomId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        log.warn("Room listener failed:", error instanceof Error ? error.name : "unknown");
      }
    }
    const room = this.replica.getRoom(roomId);
    if (room) this.deps.onRoomEvent?.({ id: room.id, kind: room.kind }, event);
  }

  /**
   * A change for screens, plus `values`: for each text field it touches that is open as live text here, the value
   * and version after it, so a screen can show it without a text.read.
   */
  private withTextValues(room: string, change: RoomChange): RoomApiChange {
    const api = apiChangeOf(change);
    const values = Object.fromEntries(
      Object.keys(change.text ?? {}).flatMap((field) => {
        const current = this.texts.peek(room, change.record, field);
        return current ? [[field, current] as const] : [];
      }),
    );
    if (Object.keys(values).length === 0) return api;
    const withValues: RoomApiChange & { values: typeof values } = { ...api, values };
    return withValues;
  }

  private onSocketEvent(event: RoomsSocketEvent): void {
    switch (event.kind) {
      case "records":
        this.flushTextBatches(event.room);
        if (event.own) this.settle(event.room, event.changes[0]?.id, undefined);
        this.texts.onChanges(event.room, event.changes, event.own);
        this.emit(event.room, {
          kind: "records",
          changes: event.changes.map((change) => this.withTextValues(event.room, change)),
        });
        return;
      case "presence": {
        const map = this.presence.get(event.room) ?? new Map<string, RoomPresence>();
        map.set(`${event.principal}\n${event.client}`, {
          principal: event.principal,
          client: event.client,
          actor: event.actor,
          state: event.state,
          at: event.at,
          self: event.client === this.socket.clientId,
        });
        this.presence.set(event.room, map);
        this.emit(event.room, { kind: "presence", presence: [...map.values()] });
        return;
      }
      case "left": {
        const map = this.presence.get(event.room);
        if (!map?.delete(`${event.principal}\n${event.client}`)) return;
        this.emit(event.room, { kind: "presence", presence: [...map.values()] });
        return;
      }
      case "status":
        this.emit(event.room, { kind: "status", status: event.status });
        return;
      case "refused":
        this.flushTextBatches(event.room);
        this.settle(event.room, event.id, new RoomWriteError(event.code));
        if (event.record) this.texts.onRefused(event.room, event.record);
        if (event.record)
          this.emit(event.room, {
            kind: "refused",
            changeId: event.id,
            record: event.record,
            code: event.code,
          });
        return;
      case "reset":
        this.flushTextBatches(event.room);
        // Records above the durable position were dropped; the screen re-reads what it shows.
        this.emit(event.room, { kind: "records", changes: [] });
        this.texts.onReset(event.room);
        return;
      case "role":
      case "durable":
      case "connection":
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  private settle(roomId: string, changeId: string | undefined, error: Error | undefined): void {
    if (!changeId) return;
    const key = `${roomId}\n${changeId}`;
    const waiter = this.waiting.get(key);
    if (!waiter) return;
    this.waiting.delete(key);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void {
    const set = this.listeners.get(roomId) ?? new Set<(event: RoomEvent) => void>();
    set.add(listener);
    this.listeners.set(roomId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(roomId);
    };
  }

  presenceOf(roomId: string): RoomPresence[] {
    return [...(this.presence.get(roomId)?.values() ?? [])];
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  roomSummary(roomId: string): RoomSummary | undefined {
    const room = this.replica.getRoom(roomId);
    return room ? summaryOf(room) : undefined;
  }

  private storeEnvelope(envelope: RoomEnvelope, joined: boolean): void {
    const existing = this.replica.getRoom(envelope.id);
    this.replica.upsertRoom({
      id: envelope.id,
      kind: envelope.kind,
      workspaceId: envelope.workspaceId,
      schemaVersion: envelope.schemaVersion,
      title: envelope.title,
      owner: envelope.owner,
      role: envelope.role,
      status: envelope.archivedAt ? "gone" : (existing?.status ?? "offline"),
      updatedAt: envelope.updatedAt,
      joined,
    });
  }

  /** Creates a room of a kind `caller` declares (`shortKind` from its `contributes.rooms`). */
  async create(
    caller: RoomsCaller,
    input: { kind: string; workspaceId: string; title: string },
  ): Promise<RoomSummary> {
    const declaration = caller.declarations.find((candidate) => candidate.kind === input.kind);
    if (!caller.extension || !declaration) {
      throw new RoomWriteError("unknown-type", {
        message: `room kind ${input.kind} is not declared by the calling extension`,
      });
    }
    const id = `r-${randomUUID()}`;
    const answer = await this.http("POST", ROOM_ROUTES.rooms, {
      id,
      kind: `${caller.extension}/${declaration.kind}`,
      workspaceId: input.workspaceId,
      schemaVersion: declaration.schemaVersion,
      title: input.title.slice(0, MAX_TITLE),
    });
    const envelope = parseRoomEnvelope(answer);
    this.storeEnvelope(envelope, true);
    this.socket.join(envelope.id);
    return envelopeSummary(envelope);
  }

  /**
   * Host code: opens a built-in room with a deterministic id, creating it first when this person may.
   * A room already there answers the create with its envelope (or a conflict); that and a viewer's refusal
   * (forbidden) fall back to joining it, and a replica copy opens without a create. Any other refusal (a bad request, no session)
   * is the caller's to see, not hidden behind a second failing open.
   */
  async openOrCreateBuiltin(input: {
    id: string;
    kind: string;
    schemaVersion: number;
    workspaceId: string;
    title: string;
  }): Promise<RoomSummary> {
    if (!ROOM_ID.test(input.id))
      throw new RoomWriteError("invalid", { message: "invalid room id" });
    if (this.replica.getRoom(input.id)) return this.open(input.id);
    try {
      const envelope = parseRoomEnvelope(
        await this.http("POST", ROOM_ROUTES.rooms, {
          id: input.id,
          kind: input.kind,
          workspaceId: input.workspaceId,
          schemaVersion: input.schemaVersion,
          title: input.title.slice(0, MAX_TITLE),
        }),
      );
      this.storeEnvelope(envelope, true);
      this.socket.join(envelope.id);
      return envelopeSummary(envelope);
    } catch (error) {
      // 409: a service that answers an existing room's create with a conflict rather than its envelope.
      if (
        error instanceof RoomWriteError &&
        (error.code === "forbidden" || error.code === "conflict")
      )
        return this.open(input.id);
      throw error;
    }
  }

  /** Joins a room (reading its envelope when reachable) and returns it from the replica. */
  async open(roomId: string): Promise<RoomSummary> {
    if (!ROOM_ID.test(roomId)) throw new RoomWriteError("invalid", { message: "invalid room id" });
    const local = this.replica.getRoom(roomId);
    if (local?.status === "revoked") throw new RoomWriteError("revoked");
    try {
      this.storeEnvelope(parseRoomEnvelope(await this.http("GET", ROOM_ROUTES.room(roomId))), true);
    } catch (error) {
      // Offline with a replica copy: keep working on it.
      if (
        !local ||
        (error instanceof RoomWriteError && (error.code === "forbidden" || error.code === "gone"))
      )
        throw error;
      this.replica.upsertRoom({ ...local, joined: true });
    }
    const room = this.replica.getRoom(roomId);
    if (!room) throw new RoomWriteError("gone");
    this.socket.join(roomId);
    return summaryOf(room);
  }

  /** Rooms this person can read: the organization's list when reachable, merged with the replica. */
  async list(filter: { kind?: string; workspaceId?: string } = {}): Promise<RoomSummary[]> {
    const merged = new Map(
      this.replica.listRooms(filter).map((room) => [room.id, summaryOf(room)]),
    );
    try {
      const query = new URLSearchParams();
      if (filter.kind) query.set("kind", filter.kind);
      if (filter.workspaceId) query.set("workspaceId", filter.workspaceId);
      const { rooms } = parseRoomList(
        await this.http("GET", `${ROOM_ROUTES.rooms}${query.size ? `?${query}` : ""}`),
      );
      for (const envelope of rooms) {
        if (merged.has(envelope.id)) continue;
        if (filter.kind && envelope.kind !== filter.kind) continue;
        if (filter.workspaceId && envelope.workspaceId !== filter.workspaceId) continue;
        merged.set(envelope.id, envelopeSummary(envelope));
      }
    } catch (error) {
      log.info(
        "Rooms list from the organization failed; using the replica:",
        error instanceof Error ? error.name : "unknown",
      );
    }
    return [...merged.values()];
  }

  /** Owner only (added in the SDK lift: the desktop grants through the org's own sharing screens): POST /v1/rooms/:id/grants. */
  async grant(roomId: string, principal: `user:${string}`, role: "viewer" | "collaborator" | "driver"): Promise<void> {
    await this.http("POST", ROOM_ROUTES.grants(roomId), { principal, role });
  }

  async members(roomId: string): Promise<RoomMember[]> {
    const { grants } = parseRoomGrantList(await this.http("GET", ROOM_ROUTES.grants(roomId)));
    return grants.map((grant) => ({
      principal: grant.principal,
      name: grant.principal.slice("user:".length),
      role: grant.role,
    }));
  }

  get(roomId: string, key: string): RoomRecord | undefined {
    const view = this.replica.viewOne(roomId, key);
    return view ? apiRecordOf(view.record, view.pending) : undefined;
  }

  query(roomId: string, filter: { type?: string } = {}): RoomRecord[] {
    const { records, pending } = this.replica.view(roomId);
    return [...records.values()]
      .filter((record) => filter.type === undefined || record.type === filter.type)
      .map((record) => apiRecordOf(record, pending.has(record.key)));
  }

  history(
    roomId: string,
    options: { key?: string; afterSeq?: number; limit?: number } = {},
  ): RoomApiChange[] {
    const ordered = this.replica.history(roomId, options).map(apiChangeOf);
    const pending = this.replica
      .pending(roomId)
      .filter((entry) => options.key === undefined || entry.record === options.key)
      .map(apiPendingChange);
    return [...ordered, ...pending];
  }

  /** Where `caller` may write: the room's kind schema and the record type, or a RoomWriteError. */
  private writeTarget(
    caller: RoomsCaller,
    roomId: string,
    key: string,
  ): { record: RoomRecordKey; type: string; declaration: RoomKindSchema } {
    const room = this.replica.getRoom(roomId);
    if (!room) throw new RoomWriteError("gone", { message: "open the room first" });
    if (room.status === "revoked") throw new RoomWriteError("revoked");
    if (room.status === "gone") throw new RoomWriteError("gone");
    const declaration =
      caller.extension === undefined && caller.builtin?.kind === room.kind
        ? caller.builtin
        : declarationFor(caller.extension, caller.declarations, room.kind);
    if (!declaration) {
      throw new RoomWriteError("unknown-type", {
        message: `${room.kind} is not declared by the calling extension`,
      });
    }
    if (!isRoomRecordKey(key)) throw new RoomWriteError("invalid-key");
    const type = roomRecordKeyType(key);
    if (!roomRoleAllows(room.role, { kind: "write", type })) throw new RoomWriteError("read-only");
    return { record: key, type, declaration };
  }

  private async author(): Promise<`user:${string}`> {
    const author = await this.deps.person();
    if (!author)
      throw new RoomWriteError("forbidden", { message: "not signed in to the organization" });
    return author;
  }

  /** Writes one change to the replica (shown at once) and sends it; with `ifSeq`, resolves on the organization's answer. */
  private enqueue(change: {
    room: string;
    record: RoomRecordKey;
    type: string;
    op: "set" | "delete";
    set?: Record<string, unknown>;
    text?: Record<string, RoomTextUpdate>;
    ifSeq?: number;
    actor: RoomActor;
    author: `user:${string}`;
  }): Promise<void> | undefined {
    const confirmed = this.replica.confirmed(change.room, change.record);
    const entry: Omit<OutboxEntry, "seq"> = {
      room: change.room,
      id: `c-${randomUUID()}`,
      record: change.record,
      type: change.type,
      op: change.op,
      ...(change.op === "set" && change.set ? { set: change.set } : {}),
      ...(change.text ? { text: change.text } : {}),
      ...(confirmed ? { base: confirmed.updatedSeq } : {}),
      ...(change.ifSeq !== undefined ? { ifSeq: change.ifSeq } : {}),
      actor: change.actor,
      author: change.author,
      at: new Date(this.now()).toISOString(),
    };
    const carriesReset = Object.values(change.text ?? {}).some(isRoomTextReset);
    if (jsonBytes(entry) > (carriesReset ? MAX_ROOM_TEXT_RESET_FRAME_BYTES : MAX_ROOM_CHANGE_BYTES))
      throw new RoomWriteError("too-large");
    this.replica.enqueue(entry);
    this.emit(change.room, { kind: "records", changes: [apiPendingChange(entry)] });
    const settled =
      change.ifSeq !== undefined
        ? new Promise<void>((resolve, reject) =>
            this.waiting.set(`${change.room}\n${entry.id}`, { resolve, reject }),
          )
        : undefined;
    this.socket.submit(entry);
    return settled;
  }

  /** Rebased edits and compactions the text layer asks for; a refused compaction (`conflict`) is simply dropped. */
  private sendText(sends: readonly TextSend[]): void {
    for (const send of sends) {
      try {
        void this.enqueue({
          room: send.room,
          record: send.record,
          type: send.type,
          op: "set",
          text: { [send.field]: send.update },
          ...(send.ifSeq !== undefined ? { ifSeq: send.ifSeq } : {}),
          actor: send.actor,
          author: send.author,
        })?.catch(() => undefined);
      } catch (error) {
        log.warn("Room text change not sent:", error instanceof Error ? error.name : "unknown");
      }
    }
  }

  /**
   * One change by `caller`: checked against the caller's declaration of the room's kind, written to the
   * replica (shown at once), then sent. A string for a `text` field is a whole-value write: with
   * `textBase[field]` (the version the writer started from) only the writer's own edit is applied onto the current
   * text; without one, as wholeValue says. Never a later-wins overwrite; one change per text update, after the other
   * fields. With `ifSeq` the promise waits for the organization's answer to the first change.
   */
  async write(
    caller: RoomsCaller,
    roomId: string,
    key: string,
    op: "set" | "delete",
    fields: Record<string, unknown> | undefined,
    options: { ifSeq?: number; textBase?: Readonly<Record<string, string>> } = {},
  ): Promise<void> {
    const { record, type, declaration } = this.writeTarget(caller, roomId, key);
    const textFields = op === "set" ? textFieldsOf(declaration, type) : new Set<string>();
    const set: Record<string, unknown> = {};
    const textValues = new Map<string, string>();
    for (const [name, value] of Object.entries(fields ?? {})) {
      if (!textFields.has(name)) set[name] = value;
      else if (typeof value === "string") textValues.set(name, value);
      else throw new RoomWriteError("invalid-value", { field: name });
    }
    const check = checkRoomWrite(declaration, {
      record,
      type,
      op,
      ...(op === "set" ? { set } : {}),
    });
    if (!check.ok)
      throw new RoomWriteError(check.code, check.field !== undefined ? { field: check.field } : {});
    const author = await this.author();
    for (const field of textValues.keys()) this.flushTextBatch(roomId, record, field);
    const edits = [...textValues].flatMap(([field, value]) =>
      this.wholeValue(roomId, record, field, value, options.textBase?.[field]).map(
        (update) => [field, update] as const,
      ),
    );
    const base = { room: roomId, record, type, actor: caller.actor, author };
    let ifSeq = options.ifSeq;
    const waits: Promise<void>[] = [];
    if (op === "delete" || Object.keys(set).length > 0 || edits.length === 0) {
      const settled = this.enqueue({
        ...base,
        op,
        ...(op === "set" ? { set } : {}),
        ...(ifSeq !== undefined ? { ifSeq } : {}),
      });
      if (settled) waits.push(settled);
      ifSeq = undefined;
    }
    for (const [field, update] of edits) {
      const settled = this.enqueue({
        ...base,
        op: "set",
        text: { [field]: update },
        ...(ifSeq !== undefined ? { ifSeq } : {}),
      });
      if (settled) waits.push(settled);
      ifSeq = undefined;
    }
    await Promise.all(waits);
  }

  // ── Text ─────────────────────────────────────────────────────────────────

  /** Runs a local edit on a field's live text, mapping the text layer's refusals to RoomWriteError codes. */
  private textEdit(
    roomId: string,
    record: RoomRecordKey,
    field: string,
    edit: (text: RoomTextReplica) => RoomTextUpdate[],
  ): RoomTextUpdate[] {
    try {
      return edit(this.texts.get(roomId, record, field));
    } catch (error) {
      if (error instanceof RoomTextTooLargeError) throw new RoomWriteError("too-large", { field });
      if (error instanceof RangeError) throw new RoomWriteError("invalid-value", { field });
      throw error;
    }
  }

  private readableText(roomId: string, key: string): RoomRecordKey {
    if (!this.replica.getRoom(roomId))
      throw new RoomWriteError("gone", { message: "open the room first" });
    if (!isRoomRecordKey(key)) throw new RoomWriteError("invalid-key");
    return key;
  }

  /**
   * A whole new value of a text field. Written against `base` (a version from textRead or an edit's answer) it applies
   * only the writer's own edit, base to `value`, onto the current text, so others' typing since base is kept. With no
   * base the host takes the recent value `value` is the smallest edit from (RoomTexts.guessBase), which covers a screen
   * that had not painted a remote change yet. With a base this field no longer remembers (too old, or from before a
   * restart) and no recent match, it is the smallest edit from the current value: whatever others typed that the writer
   * had not seen is then overwritten where the two overlap.
   */
  private wholeValue(
    roomId: string,
    record: RoomRecordKey,
    field: string,
    value: string,
    base: string | undefined,
  ): RoomTextUpdate[] {
    return this.textEdit(roomId, record, field, (text) => {
      const fromBase =
        base !== undefined
          ? this.texts.editFromBase(roomId, record, field, base, value)
          : undefined;
      const guess =
        fromBase === undefined ? this.texts.guessBase(roomId, record, field, value) : undefined;
      const splices =
        fromBase ??
        (guess !== undefined
          ? this.texts.editFromBase(roomId, record, field, guess, value)
          : undefined);
      return splices
        ? splices.flatMap((splice) => text.splice(splice.index, splice.deleteCount, splice.insert))
        : text.setValue(value);
    });
  }

  /** A text field's current value: the ordered text with this desktop's unordered edits on top. */
  textValue(roomId: string, key: string, field: string): string {
    return this.texts.get(roomId, this.readableText(roomId, key), field).value();
  }

  /** The current value and its version token: pass the token back as the base of a whole-value write. */
  textRead(roomId: string, key: string, field: string): TextReading {
    return this.texts.read(roomId, this.readableText(roomId, key), field);
  }

  /**
   * A local edit of a `text` field: a splice, or a whole new value (`base`: see wholeValue). A splice with `base` (the
   * version its index and deleteCount refer to, i.e. what the screen showed) is moved onto the current text through
   * every change since, others' and this desktop's own; without one, or with a base this field no longer remembers,
   * the index is taken against the current text as is, so others' typing the screen had not shown yet shifts it. One
   * change per resulting update (a large paste is several). Answers the value and version after the edit, and for a
   * splice the `index` in that value where it was applied (where its insertion starts, or where its deletion was).
   * Answers as soon as the edit is in the live text, without waiting for the keystroke batch to be sent; a send that
   * then fails is refused like any change (a `refused` event, and the live text goes back to the replica).
   */
  async textSplice(
    caller: RoomsCaller,
    roomId: string,
    key: string,
    field: string,
    edit:
      | { index: number; deleteCount: number; insert: string; base?: string }
      | { value: string; base?: string },
  ): Promise<TextReading & { index?: number }> {
    const { record, type, declaration } = this.writeTarget(caller, roomId, key);
    if (!textFieldsOf(declaration, type).has(field))
      throw new RoomWriteError("unknown-field", { field });
    const author = await this.author();
    let applied = "value" in edit ? undefined : edit.index;
    const updates =
      "value" in edit
        ? this.wholeValue(roomId, record, field, edit.value, edit.base)
        : this.textEdit(roomId, record, field, (text) => {
            const moved =
              edit.base !== undefined
                ? this.texts.spliceFromBase(roomId, record, field, edit.base, {
                    index: edit.index,
                    deleteCount: edit.deleteCount,
                    insert: edit.insert,
                  })
                : undefined;
            // The insertion comes last, else the lowest deletion: either way where the edit now is.
            if (moved) applied = moved.at(-1)?.index;
            return moved
              ? moved.flatMap((splice) =>
                  text.splice(splice.index, splice.deleteCount, splice.insert),
                )
              : text.splice(edit.index, edit.deleteCount, edit.insert);
          });
    const answer = this.texts.read(roomId, record, field);
    void Promise.all(
      updates.map((update) =>
        this.batchText({ room: roomId, record, type, field, actor: caller.actor, author }, update),
      ),
    ).catch((error: unknown) =>
      log.warn("Text batch not sent:", error instanceof RoomWriteError ? error.code : "unknown"),
    );
    return applied !== undefined ? { ...answer, index: applied } : answer;
  }

  /** Adds a local text update to its field's batch; resolves once the batch is in the outbox. */
  private batchText(
    change: {
      room: string;
      record: RoomRecordKey;
      type: string;
      field: string;
      actor: RoomActor;
      author: `user:${string}`;
    },
    update: RoomTextUpdate,
  ): Promise<void> {
    if (isRoomTextReset(update)) throw new RoomWriteError("invalid-value", { field: change.field });
    const id = `${change.room}\n${change.record}\n${change.field}`;
    const current = this.textBatches.get(id);
    if (
      current &&
      (current.gen !== update.gen ||
        current.author !== change.author ||
        JSON.stringify(current.actor) !== JSON.stringify(change.actor) ||
        current.bytes + update.update.length > MAX_ROOM_TEXT_UPDATE_BYTES)
    )
      this.flushTextBatch(change.room, change.record, change.field);
    let batch = this.textBatches.get(id);
    const quiet = this.now() - (this.textSentAt.get(id) ?? Number.NEGATIVE_INFINITY);
    const leading = !batch && quiet >= TEXT_BATCH_MS;
    if (!batch) {
      batch = {
        ...change,
        gen: update.gen,
        updates: [],
        bytes: 0,
        waiters: [],
        timer: setTimeout(
          () => this.flushTextBatch(change.room, change.record, change.field),
          Math.max(0, TEXT_BATCH_MS - quiet),
        ),
      };
      this.textBatches.set(id, batch);
    }
    batch.updates.push(update.update);
    batch.bytes += update.update.length;
    const waiters = batch.waiters;
    const sent = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    // The first keystroke after a quiet spell goes out now; the rest of the burst waits for the batch.
    if (leading) this.flushTextBatch(change.room, change.record, change.field);
    return sent;
  }

  private flushTextBatch(room: string, record: string, field: string): void {
    const id = `${room}\n${record}\n${field}`;
    const batch = this.textBatches.get(id);
    if (!batch) return;
    this.textBatches.delete(id);
    this.textSentAt.set(id, this.now());
    clearTimeout(batch.timer);
    // Merging a batch of updates (without the state they apply to) gives one update carrying all of them.
    const merged =
      batch.updates.length === 1
        ? batch.updates[0]
        : mergeRoomTextState(undefined, batch.updates)?.state;
    const updates =
      merged !== undefined && merged.length <= MAX_ROOM_TEXT_UPDATE_BYTES
        ? [merged]
        : batch.updates;
    try {
      for (const update of updates) {
        void this.enqueue({
          room: batch.room,
          record: batch.record,
          type: batch.type,
          op: "set",
          text: { [batch.field]: { gen: batch.gen, update } },
          actor: batch.actor,
          author: batch.author,
        });
      }
      for (const waiter of batch.waiters) waiter.resolve();
    } catch (error) {
      // The live text already shows these edits: back to what the replica holds.
      this.texts.onRefused(batch.room, batch.record);
      for (const waiter of batch.waiters) waiter.reject(error);
    }
  }

  /** Sends every held batch now (of one room, or all): before a rebuild reads the outbox, and on stop. */
  private flushTextBatches(room?: string): void {
    for (const batch of [...this.textBatches.values()])
      if (room === undefined || batch.room === room)
        this.flushTextBatch(batch.room, batch.record, batch.field);
  }

  /** Every change of one text field as splices: this desktop's at once, others' as they merge, `rebuilt` after a reset. */
  subscribeText(
    roomId: string,
    key: string,
    field: string,
    listener: (event: RoomTextEvent) => void,
  ): () => void {
    return this.texts.get(roomId, this.readableText(roomId, key), field).subscribe(listener);
  }

  textCursor(roomId: string, key: string, field: string, index: number): RoomTextCursor {
    return this.texts.get(roomId, this.readableText(roomId, key), field).cursor(index);
  }

  textResolve(roomId: string, key: string, field: string, cursor: RoomTextCursor): number | null {
    return this.texts.get(roomId, this.readableText(roomId, key), field).resolve(cursor);
  }

  /** Who typed what in a record's text fields (ordered changes), grouped into runs. */
  textHistory(roomId: string, key: string, field?: string): RoomTextRun[] {
    return summarizeRoomTextHistory(
      this.replica.history(roomId, { key: this.readableText(roomId, key) }),
      field !== undefined ? { field } : {},
    );
  }

  setPresence(roomId: string, state: unknown, actor: RoomActor): void {
    if (jsonBytes(state ?? null) > MAX_PRESENCE_BYTES) throw new RoomWriteError("too-large");
    this.socket.setPresence(roomId, state, actor);
  }

  between(before?: string, after?: string): string {
    return roomPositionBetween(before, after);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  /**
   * The rooms service's own routes need the person's token; a store's signed address (another origin)
   * must never receive it.
   */
  private async authFor(url: string): Promise<Record<string, string>> {
    return new URL(url).origin === new URL(this.deps.endpoint.apiBase).origin
      ? { authorization: `Bearer ${await this.deps.token()}` }
      : {};
  }

  /** Copies a local file into the cache, registers it with the room and uploads it, streaming from disk. */
  async putFile(roomId: string, filePath: string, contentType: string): Promise<RoomFileRef> {
    const stat = await fsStat(filePath).catch(() => undefined);
    if (!stat?.isFile()) throw new RoomFileError("not-a-file");
    if (stat.size > MAX_ROOM_FILE_BYTES) throw new RoomFileError("too-large");
    const ref = await this.files.putFile(filePath, contentType);
    const answer = z
      .object({
        upload: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }).optional(),
      })
      .safeParse(await this.http("POST", ROOM_ROUTES.files(roomId), ref));
    const upload = answer.success ? answer.data.upload : undefined;
    if (upload) {
      const local = this.files.lookup(ref.sha256, ref.bytes);
      if (!local) throw new RoomFileError("unavailable", "the cached copy disappeared");
      const status = await (this.deps.uploadFile ?? uploadFileStreaming)(
        upload.url,
        { ...upload.headers, ...(await this.authFor(upload.url)) },
        local,
        ref.bytes,
      );
      if (status < 200 || status >= 300)
        throw new RoomFileError("upload-failed", `upload answered http-${status}`);
    }
    this.replica.recordFile(roomId, ref);
    return ref;
  }

  /** The local path of a room file, downloading it into the cache (size and SHA-256 checked) when absent. */
  async filePath(roomId: string, value: unknown): Promise<string> {
    const ref = parseRoomFileRef(value);
    if (!ref) throw new RoomWriteError("invalid-value", { message: "not a file reference" });
    const cached = this.files.lookup(ref.sha256, ref.bytes);
    if (cached) return cached;
    const answer = z
      .object({ url: z.string() })
      .safeParse(await this.http("GET", ROOM_ROUTES.file(roomId, ref.sha256)));
    if (!answer.success) throw new RoomFileError("unavailable", "no download address");
    const response = await (this.deps.fetch ?? fetch)(answer.data.url, {
      headers: await this.authFor(answer.data.url),
    });
    if (!response.ok || !response.body)
      throw new RoomFileError("unavailable", `download answered http-${response.status}`);
    return this.files.putStream(ref, response.body);
  }
}
