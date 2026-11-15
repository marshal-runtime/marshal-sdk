// Lifted from OmerMachluf/marshal electron/org/rooms/rooms-socket.ts at c75500b1b (copied, not imported); adapted for the SDK (no Electron, local logger, node:fs).
import { randomUUID } from "node:crypto";

import {
  ROOMS_PROTOCOL_VERSION,
  parseRoomServerFrame,
  type RoomActor,
  type RoomChange,
  type RoomClientFrame,
  type RoomNackCode,
  type RoomRecordKey,
  type RoomRole,
  type RoomServerFrame,
  type RoomStatus,
} from "@marshal/agent-runtime-org";

import { createLogger } from "./log.js";
import type { OutboxEntry, RoomsReplica } from "./rooms-replica.js";

const log = createLogger("RoomsSocket");

/** The subset of a WebSocket the client uses; `ws` and test sockets both satisfy it. */
export interface RoomsSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type RoomsSocketFactory = (url: string) => RoomsSocketLike;

export type RoomsSocketEvent =
  | { kind: "records"; room: string; changes: RoomChange[]; own: boolean }
  | {
      kind: "presence";
      room: string;
      principal: `user:${string}`;
      client: string;
      actor: RoomActor;
      state: unknown;
      at: string;
    }
  | { kind: "left"; room: string; principal: string; client: string }
  | { kind: "status"; room: string; status: RoomStatus }
  | { kind: "role"; room: string; role: RoomRole }
  | {
      kind: "refused";
      room: string;
      id: string;
      code: RoomNackCode;
      record: RoomRecordKey | undefined;
    }
  | { kind: "reset"; room: string; epoch: string }
  | { kind: "durable"; room: string; through: number }
  | { kind: "connection"; state: "connecting" | "open" | "closed"; principal?: string };

export interface RoomsSocketOptions {
  socketUrl: string;
  /** A fresh access token for every hello. */
  token: () => Promise<string>;
  replica: RoomsReplica;
  createSocket: RoomsSocketFactory;
  onEvent: (event: RoomsSocketEvent) => void;
  /** Identifies this desktop among a person's clients. */
  clientId?: string;
  random?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Delay before a `busy` or `not-joined` change is sent again. */
  retryMs?: number;
  now?: () => number;
}

const OPEN = 1;
const PRESENCE_MIN_INTERVAL_MS = Math.ceil(1000 / 30);

function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return undefined;
}

/**
 * One socket per organization carrying every joined room (layer spec, section 4). Reconnects with
 * exponential backoff and full jitter, rejoins with `have`, resends the outbox, follows `bye`, and
 * applies the new-epoch rule through the replica.
 */
export class RoomsSocketClient {
  private pingSentAt: number | undefined;
  private serverOffset: number | undefined;
  private socket: RoomsSocketLike | undefined;
  private readonly rooms = new Set<string>();
  private readonly joined = new Set<string>();
  private readonly presence = new Map<
    string,
    { state: unknown; actor: RoomActor; lastSentAt: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private awaitingPong = false;
  private stopped = true;
  private welcomed = false;
  private principal: string | undefined;
  readonly clientId: string;

  constructor(private readonly options: RoomsSocketOptions) {
    this.clientId = options.clientId ?? `desktop-${randomUUID()}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get connected(): boolean {
    return this.welcomed && this.socket?.readyState === OPEN;
  }

  get signedInPrincipal(): string | undefined {
    return this.principal;
  }

  isJoined(room: string): boolean {
    return this.joined.has(room) && this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.heartbeatTimer);
    for (const entry of this.presence.values()) clearTimeout(entry.timer);
    const socket = this.socket;
    this.socket = undefined;
    this.welcomed = false;
    this.joined.clear();
    socket?.close(1000, "stopped");
  }

  /** Starts receiving a room; remembered across reconnects. */
  join(room: string): void {
    const fresh = !this.rooms.has(room);
    this.rooms.add(room);
    if (fresh && this.connected) this.sendJoin(room);
  }

  leave(room: string): void {
    this.rooms.delete(room);
    this.joined.delete(room);
    clearTimeout(this.presence.get(room)?.timer);
    this.presence.delete(room);
    if (this.connected) this.send({ t: "leave", room });
  }

  /** Sends one outbox row if its room is joined; otherwise it goes with the next join. */
  submit(entry: OutboxEntry): void {
    if (!this.isJoined(entry.room)) return;
    this.send({
      t: "op",
      room: entry.room,
      id: entry.id,
      record: entry.record,
      type: entry.type,
      op: entry.op,
      actor: entry.actor,
      ...(entry.set ? { set: entry.set } : {}),
      ...(entry.text ? { text: entry.text } : {}),
      ...(entry.base !== undefined ? { base: entry.base } : {}),
      ...(entry.ifSeq !== undefined ? { ifSeq: entry.ifSeq } : {}),
    });
  }

  private flush(room: string): void {
    for (const entry of this.options.replica.pending(room)) this.submit(entry);
  }

  /** My short-lived state in a room, coalesced to at most 30 updates a second and resent on rejoin. */
  setPresence(room: string, state: unknown, actor: RoomActor): void {
    const current = this.presence.get(room) ?? { state, actor, lastSentAt: 0 };
    current.state = state;
    current.actor = actor;
    this.presence.set(room, current);
    if (current.timer !== undefined) return;
    const wait = PRESENCE_MIN_INTERVAL_MS - (this.now() - current.lastSentAt);
    if (wait <= 0) {
      this.sendPresence(room);
      return;
    }
    current.timer = setTimeout(() => {
      current.timer = undefined;
      this.sendPresence(room);
    }, wait);
  }

  private sendPresence(room: string): void {
    const current = this.presence.get(room);
    if (!current || !this.isJoined(room)) return;
    current.lastSentAt = this.now();
    this.send({ t: "presence", room, actor: current.actor, state: current.state });
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onEvent({ kind: "connection", state: "connecting" });
    let socket: RoomsSocketLike;
    try {
      socket = this.options.createSocket(this.options.socketUrl);
    } catch (error) {
      log.warn(
        "Rooms socket could not be created:",
        error instanceof Error ? error.name : "unknown",
      );
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.options.token().then(
        (token) => {
          if (this.socket === socket && socket.readyState === OPEN) {
            this.send({ t: "hello", v: ROOMS_PROTOCOL_VERSION, token, client: this.clientId });
          }
        },
        () => {
          log.warn("Rooms socket: no access token; retrying later");
          socket.close(4001, "no-token");
        },
      );
    });
    socket.on("message", (data) => {
      if (this.socket === socket) this.receive(data);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.onClosed();
    });
    socket.on("error", (error) => {
      if (this.socket === socket) log.warn("Rooms socket error:", error.name);
    });
  }

  private onClosed(): void {
    this.socket = undefined;
    this.welcomed = false;
    clearTimeout(this.heartbeatTimer);
    for (const room of this.joined) {
      this.options.replica.setStatus(room, "offline");
      this.options.onEvent({ kind: "status", room, status: "offline" });
    }
    this.joined.clear();
    this.options.onEvent({ kind: "connection", state: "closed" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const base = this.options.baseBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    const random = this.options.random ?? Math.random;
    const ceiling = immediate ? 250 : Math.min(max, base * 2 ** this.attempt);
    if (!immediate) this.attempt += 1;
    // Full jitter: a deploy that drops everyone does not bring everyone back in the same millisecond.
    this.reconnectTimer = setTimeout(() => this.connect(), Math.floor(random() * ceiling));
  }

  private send(frame: RoomClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private sendJoin(room: string): void {
    const replicaRoom = this.options.replica.getRoom(room);
    this.send({
      t: "join",
      room,
      ...(replicaRoom?.epoch !== undefined
        ? { have: { epoch: replicaRoom.epoch, seq: replicaRoom.pulledSeq } }
        : {}),
    });
  }

  /** Server clock minus this desktop's clock (ms), from the last ping/pong; undefined before the first. */
  get serverOffsetMs(): number | undefined {
    return this.serverOffset;
  }

  private startHeartbeat(intervalMs: number): void {
    clearTimeout(this.heartbeatTimer);
    const tick = () => {
      if (this.awaitingPong) {
        // A whole interval without a pong: the connection is dead even if the OS has not noticed.
        this.socket?.close(4000, "heartbeat");
        return;
      }
      this.awaitingPong = true;
      this.pingSentAt = this.now();
      this.send({ t: "ping" });
      this.heartbeatTimer = setTimeout(tick, intervalMs);
    };
    this.awaitingPong = false;
    this.heartbeatTimer = setTimeout(tick, intervalMs);
  }

  private receive(data: unknown): void {
    const raw = textOf(data);
    if (raw === undefined) return;
    let frame: RoomServerFrame;
    try {
      frame = parseRoomServerFrame(JSON.parse(raw) as unknown);
    } catch {
      log.warn("Rooms socket: dropped a frame that does not match protocol v1");
      return;
    }
    try {
      this.handle(frame);
    } catch (error) {
      log.error(
        "Rooms frame handling failed:",
        frame.t,
        error instanceof Error ? error.name : "unknown",
      );
    }
  }

  private handle(frame: RoomServerFrame): void {
    const replica = this.options.replica;
    switch (frame.t) {
      case "welcome":
        this.welcomed = true;
        this.attempt = 0;
        this.principal = frame.principal;
        this.startHeartbeat(frame.heartbeatMs);
        // One ping at once, so the server clock offset is known before the first heartbeat.
        this.awaitingPong = true;
        this.pingSentAt = this.now();
        this.send({ t: "ping" });
        this.options.onEvent({ kind: "connection", state: "open", principal: frame.principal });
        for (const room of this.rooms) this.sendJoin(room);
        return;
      case "error":
        this.onError(frame.code, frame.room);
        return;
      case "pong": {
        this.awaitingPong = false;
        const server = frame.serverTime ? Date.parse(frame.serverTime) : Number.NaN;
        if (Number.isFinite(server) && this.pingSentAt !== undefined) {
          // offset ≈ S − (t0 + t1) / 2, good to about half the round trip.
          this.serverOffset = server - (this.pingSentAt + this.now()) / 2;
        }
        return;
      }
      case "bye":
        this.socket?.close(1000, "bye");
        this.onClosedBeforeReconnect();
        return;
      case "reset":
        replica.resetToDurable(frame.room, frame.epoch, frame.durable);
        this.options.onEvent({ kind: "reset", room: frame.room, epoch: frame.epoch });
        return;
      case "joined": {
        const room = replica.getRoom(frame.room);
        if (!room) return;
        if (room.epoch !== undefined && room.epoch !== frame.epoch) {
          // A new epoch without a reset frame first: apply the same rule and ask again from what is stored.
          replica.resetToDurable(frame.room, frame.epoch, frame.durable);
          this.options.onEvent({ kind: "reset", room: frame.room, epoch: frame.epoch });
          this.sendJoin(frame.room);
          return;
        }
        if (room.epoch === undefined) replica.setEpoch(frame.room, frame.epoch);
        replica.setRole(frame.room, frame.role);
        replica.setStatus(frame.room, "active");
        replica.markDurable(frame.room, frame.durable);
        this.joined.add(frame.room);
        this.options.onEvent({ kind: "role", room: frame.room, role: frame.role });
        this.options.onEvent({ kind: "status", room: frame.room, status: "active" });
        this.flush(frame.room);
        if (this.presence.has(frame.room)) this.sendPresence(frame.room);
        return;
      }
      case "changes":
        this.applyFromServer(frame.room, frame.changes);
        return;
      case "change":
        this.applyFromServer(frame.room, [frame.change]);
        return;
      case "ack": {
        if (replica.getRoom(frame.room)?.epoch !== frame.epoch) return;
        const change = replica.acknowledge(frame.room, frame.id, frame.seq, frame.epoch);
        if (change)
          this.options.onEvent({ kind: "records", room: frame.room, changes: [change], own: true });
        return;
      }
      case "nack":
        this.onNack(frame.room, frame.id, frame.code);
        return;
      case "presence":
        this.options.onEvent({
          kind: "presence",
          room: frame.room,
          principal: frame.principal,
          client: frame.client,
          actor: frame.actor,
          state: frame.state,
          at: frame.at,
        });
        return;
      case "left":
        this.options.onEvent({
          kind: "left",
          room: frame.room,
          principal: frame.principal,
          client: frame.client,
        });
        return;
      case "durable":
        if (replica.getRoom(frame.room)?.epoch !== frame.epoch) return;
        replica.markDurable(frame.room, frame.through);
        this.options.onEvent({ kind: "durable", room: frame.room, through: frame.through });
        return;
      case "role":
        replica.setRole(frame.room, frame.role);
        this.options.onEvent({ kind: "role", room: frame.room, role: frame.role });
        return;
      case "revoked":
        this.markGone(frame.room, "revoked");
        return;
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  }

  private applyFromServer(room: string, changes: readonly RoomChange[]): void {
    const epoch = this.options.replica.getRoom(room)?.epoch;
    const current = changes.filter((change) => change.epoch === epoch);
    const fresh = this.options.replica.applyOrdered(room, current);
    if (fresh.length > 0)
      this.options.onEvent({ kind: "records", room, changes: fresh, own: false });
  }

  private onClosedBeforeReconnect(): void {
    // `bye`: the instance is going away. Reconnect now (with a little jitter) instead of backing off.
    const socket = this.socket;
    this.socket = undefined;
    if (socket) this.onClosed();
    this.scheduleReconnect(true);
  }

  private markGone(room: string, status: "revoked" | "gone"): void {
    this.rooms.delete(room);
    this.joined.delete(room);
    this.options.replica.setStatus(room, status);
    this.options.onEvent({ kind: "status", room, status });
  }

  private onError(code: string, room: string | undefined): void {
    if (room !== undefined) {
      // Only this join failed.
      if (code === "forbidden") this.markGone(room, "revoked");
      else if (code === "not-found") this.markGone(room, "gone");
      else log.warn("Rooms join refused:", code);
      return;
    }
    log.warn("Rooms socket refused:", code);
    this.socket?.close(4002, code);
  }

  private onNack(room: string, id: string, code: RoomNackCode): void {
    switch (code) {
      case "busy":
      case "not-joined": {
        // Over the room's rate, or the server lost the join: the change stays pending and goes again.
        if (code === "not-joined" && this.connected) this.sendJoin(room);
        setTimeout(() => this.resendOne(room, id), this.options.retryMs ?? 250);
        return;
      }
      case "forbidden":
      case "conflict":
      case "too-large":
      case "invalid":
      case "room-full": {
        const entry = this.options.replica.reject(room, id);
        this.options.onEvent({ kind: "refused", room, id, code, record: entry?.record });
        return;
      }
      default: {
        const exhaustive: never = code;
        return exhaustive;
      }
    }
  }

  private resendOne(room: string, id: string): void {
    if (this.stopped) return;
    const entry = this.options.replica.outboxEntry(room, id);
    if (entry && entry.seq === undefined) this.submit(entry);
  }
}
