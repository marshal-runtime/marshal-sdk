import * as fs from "node:fs";
import * as path from "node:path";

import {
  applyRoomChange,
  isRoomTextUpdate,
  viewRoomRecords,
  type RoomActor,
  type RoomChange,
  type RoomOp,
  type RoomRecordKey,
  type RoomRecordState,
  type RoomRole,
  type RoomStatus,
  type RoomTextState,
  type RoomTextUpdate,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import { secureMkdirSync } from "../../host-deps";

type DatabaseSync = import("node:sqlite").DatabaseSync;

export const ROOMS_REPLICA_SCHEMA_VERSION = 1;

export interface ReplicaRoom {
  id: string;
  kind: string;
  workspaceId: string;
  schemaVersion: number;
  title: string;
  owner: string;
  role: RoomRole;
  status: RoomStatus;
  updatedAt: string;
  /** Epoch of the bus the positions below belong to; undefined until the first join. */
  epoch?: string;
  /** Every change up to this position is applied here. */
  pulledSeq: number;
  /** Every change up to this position is stored by the organization. */
  durableSeq: number;
  joined: boolean;
}

/** One change of my own that `durable` has not passed yet. */
export interface OutboxEntry {
  room: string;
  id: string;
  record: RoomRecordKey;
  type: string;
  op: RoomOp;
  set?: Record<string, unknown>;
  /** Mergeable text edits: field name to a Yjs update (or a compaction reset) for that field. */
  text?: Record<string, RoomTextUpdate>;
  base?: number;
  ifSeq?: number;
  actor: RoomActor;
  author: `user:${string}`;
  at: string;
  /** Position the organization gave it; undefined until acknowledged. */
  seq?: number;
}

// Rows and JSON cells are read through these schemas, so a file written by an older or newer build
// (extra columns or fields) keeps working and a corrupt cell reads as absent (KNOWN_FIELDS rule).
const seq = z.number().int().min(0);
const principal = z.custom<`user:${string}`>(
  (value) => typeof value === "string" && value.startsWith("user:"),
);
const recordKey = z.custom<RoomRecordKey>(
  (value) => typeof value === "string" && value.includes(":"),
);
const actorSchema: z.ZodType<RoomActor> = z.union([
  z.object({ kind: z.literal("person") }),
  z.object({
    kind: z.literal("agent"),
    host: z.literal("desktop"),
    session: z.string(),
    runtime: z.string(),
    model: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent"),
    host: z.literal("cloud"),
    run: z.string(),
    askedBy: principal,
  }),
]);
const fieldsSchema = z.record(z.string(), z.unknown());
const textUpdatesSchema = z.record(
  z.string(),
  z.custom<RoomTextUpdate>((value) => isRoomTextUpdate(value)),
);
const textStateSchema: z.ZodType<RoomTextState> = z.object({
  gen: seq,
  state: z.string(),
  resetSeq: seq,
  ahead: z.array(z.object({ gen: seq, update: z.string(), seq })).optional(),
});
const changeSchema: z.ZodType<RoomChange> = z.object({
  seq,
  epoch: z.string(),
  id: z.string(),
  author: principal,
  actor: actorSchema,
  at: z.string(),
  record: recordKey,
  type: z.string(),
  op: z.enum(["set", "delete"]),
  set: fieldsSchema.optional(),
  text: textUpdatesSchema.optional(),
  base: seq.optional(),
});
const recordSchema: z.ZodType<RoomRecordState> = z.object({
  key: recordKey,
  type: z.string(),
  fields: fieldsSchema,
  texts: z.record(z.string(), textStateSchema).optional(),
  fieldSeqs: z.record(z.string(), seq),
  createdSeq: seq,
  updatedSeq: seq,
  deletedSeq: seq.optional(),
  updatedBy: principal,
});
const roomRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  workspace_id: z.string(),
  schema_version: z.number().int(),
  title: z.string(),
  owner: z.string(),
  role: z.enum(["viewer", "collaborator", "driver", "owner"]).catch("viewer"),
  status: z.enum(["active", "offline", "revoked", "gone"]).catch("offline"),
  updated_at: z.string(),
  epoch: z.string().nullable(),
  pulled_seq: z.number(),
  durable_seq: z.number(),
  joined: z.number(),
});
const outboxRowSchema = z.object({
  room_id: z.string(),
  change_id: z.string(),
  record_key: recordKey,
  record_type: z.string(),
  op: z.enum(["set", "delete"]),
  set_json: z.string().nullable(),
  text_json: z.string().nullable().optional(),
  base: z.number().nullable(),
  if_seq: z.number().nullable(),
  actor_json: z.string(),
  author: principal,
  at: z.string(),
  seq: z.number().nullable(),
});
const seqRow = z.object({ seq: z.number() });
const jsonCellRow = z.object({ value: z.string() });
const numberRow = z.object({ value: z.number() });

function parseJson<T>(schema: z.ZodType<T>, cell: string | null | undefined): T | undefined {
  if (typeof cell !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(cell) as unknown;
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseRow<T>(schema: z.ZodType<T>, row: unknown): T | undefined {
  const parsed = schema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

function parseRows<T>(schema: z.ZodType<T>, rows: readonly unknown[]): T[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A safe directory name for an organization id. */
export function orgDirectoryName(orgId: string): string {
  const cleaned = orgId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : "_";
}

/**
 * The local copy of every room of one organization (`<root>/<org>/replica.db`). Confirmed state is the
 * organization's ordered log replayed with the contract reducer; my own changes not yet ordered sit in
 * the outbox and are laid over it on read, so a local edit shows at once and the server's order is exact.
 */
export class RoomsReplica {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") {
      const dir = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(dir)) secureMkdirSync(dir, 0o700);
    }
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (!sqlite) throw new Error("Built-in SQLite is unavailable");
    this.db = new sqlite.DatabaseSync(databasePath);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.migrate();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  static forOrg(root: string, orgId: string): RoomsReplica {
    return new RoomsReplica(path.join(root, orgDirectoryName(orgId), "replica.db"));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '',
        epoch TEXT,
        pulled_seq INTEGER NOT NULL DEFAULT 0,
        durable_seq INTEGER NOT NULL DEFAULT 0,
        joined INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS changes (
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        change_json TEXT NOT NULL,
        record_key TEXT NOT NULL,
        PRIMARY KEY (room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS changes_record ON changes (room_id, record_key, seq);
      CREATE TABLE IF NOT EXISTS records (
        room_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (room_id, record_key)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        room_id TEXT NOT NULL,
        change_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_type TEXT NOT NULL,
        op TEXT NOT NULL,
        set_json TEXT,
        base INTEGER,
        if_seq INTEGER,
        actor_json TEXT NOT NULL,
        author TEXT NOT NULL,
        at TEXT NOT NULL,
        seq INTEGER,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (room_id, change_id)
      );
      CREATE TABLE IF NOT EXISTS files (
        room_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        PRIMARY KEY (room_id, sha256)
      );
    `);
    // Mergeable text (pack 86): replicas written before it get the outbox column here.
    const outboxColumns = parseRows(
      z.object({ name: z.string() }),
      this.db.prepare("PRAGMA table_info(outbox)").all(),
    );
    if (!outboxColumns.some((column) => column.name === "text_json"))
      this.db.exec("ALTER TABLE outbox ADD COLUMN text_json TEXT");
    this.db
      .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)")
      .run(String(ROOMS_REPLICA_SCHEMA_VERSION));
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The rooms replica is closed");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  upsertRoom(
    room: Omit<ReplicaRoom, "pulledSeq" | "durableSeq" | "joined" | "epoch"> & { joined?: boolean },
  ): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO rooms (id, kind, workspace_id, schema_version, title, owner, role, status, updated_at, joined)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, workspace_id = excluded.workspace_id,
           schema_version = excluded.schema_version, title = excluded.title, owner = excluded.owner,
           role = excluded.role, status = excluded.status, updated_at = excluded.updated_at,
           joined = MAX(rooms.joined, excluded.joined)`,
      )
      .run(
        room.id,
        room.kind,
        room.workspaceId,
        room.schemaVersion,
        room.title,
        room.owner,
        room.role,
        room.status,
        room.updatedAt,
        room.joined ? 1 : 0,
      );
  }

  getRoom(id: string): ReplicaRoom | undefined {
    this.assertOpen();
    const row = parseRow(
      roomRowSchema,
      this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id),
    );
    return row ? this.roomOf(row) : undefined;
  }

  listRooms(filter: { kind?: string; workspaceId?: string } = {}): ReplicaRoom[] {
    this.assertOpen();
    return parseRows(roomRowSchema, this.db.prepare("SELECT * FROM rooms ORDER BY id").all())
      .map((row) => this.roomOf(row))
      .filter(
        (room) =>
          (filter.kind === undefined || room.kind === filter.kind) &&
          (filter.workspaceId === undefined || room.workspaceId === filter.workspaceId),
      );
  }

  private roomOf(row: z.infer<typeof roomRowSchema>): ReplicaRoom {
    return {
      id: row.id,
      kind: row.kind,
      workspaceId: row.workspace_id,
      schemaVersion: row.schema_version,
      title: row.title,
      owner: row.owner,
      role: row.role,
      status: row.status,
      updatedAt: row.updated_at,
      ...(row.epoch ? { epoch: row.epoch } : {}),
      pulledSeq: row.pulled_seq,
      durableSeq: row.durable_seq,
      joined: row.joined === 1,
    };
  }

  setRole(id: string, role: RoomRole): void {
    this.db.prepare("UPDATE rooms SET role = ? WHERE id = ?").run(role, id);
  }

  setStatus(id: string, status: RoomStatus): void {
    this.db.prepare("UPDATE rooms SET status = ? WHERE id = ?").run(status, id);
  }

  setEpoch(id: string, epoch: string): void {
    this.db.prepare("UPDATE rooms SET epoch = ? WHERE id = ?").run(epoch, id);
  }

  /** Raises the durable watermark and drops every outbox row it passes. */
  markDurable(id: string, through: number): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE rooms SET durable_seq = MAX(durable_seq, ?) WHERE id = ?")
        .run(through, id);
      this.db
        .prepare("DELETE FROM outbox WHERE room_id = ? AND seq IS NOT NULL AND seq <= ?")
        .run(id, through);
    });
  }

  /** Forgets a room entirely (left or revoked). */
  removeRoom(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM changes WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM records WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM outbox WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM files WHERE room_id = ?").run(id);
      this.db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
    });
  }

  // ── Confirmed state ──────────────────────────────────────────────────────

  /**
   * Applies changes the organization ordered. Idempotent per position: a change already in the log is
   * skipped. Returns the changes that were new; `pulled_seq` advances over the contiguous run.
   */
  applyOrdered(roomId: string, changes: readonly RoomChange[]): RoomChange[] {
    if (changes.length === 0) return [];
    return this.transaction(() => this.applyOrderedInTransaction(roomId, changes));
  }

  private applyOrderedInTransaction(roomId: string, changes: readonly RoomChange[]): RoomChange[] {
    const fresh: RoomChange[] = [];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO changes (room_id, seq, change_json, record_key) VALUES (?, ?, ?, ?)",
    );
    for (const change of [...changes].sort((a, b) => a.seq - b.seq)) {
      const result = insert.run(roomId, change.seq, JSON.stringify(change), change.record);
      if (Number(result.changes) === 0) continue;
      const records = new Map<RoomRecordKey, RoomRecordState>();
      const current = this.readConfirmed(roomId, change.record);
      if (current) records.set(current.key, current);
      const outcome = applyRoomChange(records, change);
      if (outcome.kind === "applied") this.writeConfirmed(roomId, outcome.record);
      fresh.push(change);
    }
    this.advancePulled(roomId);
    return fresh;
  }

  private advancePulled(roomId: string): void {
    const room = this.getRoom(roomId);
    if (!room) return;
    let pulled = room.pulledSeq;
    const next = this.db.prepare(
      "SELECT seq FROM changes WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT 512",
    );
    for (;;) {
      const rows = parseRows(seqRow, next.all(roomId, pulled));
      let moved = false;
      for (const row of rows) {
        if (row.seq !== pulled + 1) break;
        pulled += 1;
        moved = true;
      }
      if (!moved || rows.length < 512) break;
    }
    this.db.prepare("UPDATE rooms SET pulled_seq = ? WHERE id = ?").run(pulled, roomId);
  }

  /** The record as the organization ordered it, without my pending changes (deleted ones included). */
  confirmed(roomId: string, key: string): RoomRecordState | undefined {
    this.assertOpen();
    return this.readConfirmed(roomId, key);
  }

  private readConfirmed(roomId: string, key: string): RoomRecordState | undefined {
    const row = parseRow(
      jsonCellRow,
      this.db
        .prepare("SELECT record_json AS value FROM records WHERE room_id = ? AND record_key = ?")
        .get(roomId, key),
    );
    return parseJson(recordSchema, row?.value);
  }

  private writeConfirmed(roomId: string, record: RoomRecordState): void {
    this.db
      .prepare(
        "INSERT INTO records (room_id, record_key, record_json) VALUES (?, ?, ?) ON CONFLICT (room_id, record_key) DO UPDATE SET record_json = excluded.record_json",
      )
      .run(roomId, record.key, JSON.stringify(record));
  }

  private confirmedRecords(roomId: string): Map<RoomRecordKey, RoomRecordState> {
    const rows = parseRows(
      jsonCellRow,
      this.db.prepare("SELECT record_json AS value FROM records WHERE room_id = ?").all(roomId),
    );
    const map = new Map<RoomRecordKey, RoomRecordState>();
    for (const row of rows) {
      const record = parseJson(recordSchema, row.value);
      if (record) map.set(record.key, record);
    }
    return map;
  }

  /**
   * New epoch (layer spec, section 4): the bus lost positions above `durable`. Others' changes above it
   * are dropped and the records replayed from the log up to it; my own outbox rows that got positions
   * above it go back to pending so they are resent and get new positions.
   */
  resetToDurable(roomId: string, epoch: string, durable: number): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE rooms SET durable_seq = MAX(durable_seq, ?) WHERE id = ?")
        .run(durable, roomId);
      const room = this.getRoom(roomId);
      const through = room?.durableSeq ?? durable;
      this.db.prepare("DELETE FROM changes WHERE room_id = ? AND seq > ?").run(roomId, through);
      this.db.prepare("DELETE FROM records WHERE room_id = ?").run(roomId);
      const rows = parseRows(
        jsonCellRow,
        this.db
          .prepare("SELECT change_json AS value FROM changes WHERE room_id = ? ORDER BY seq")
          .all(roomId),
      );
      const records = new Map<RoomRecordKey, RoomRecordState>();
      for (const row of rows) {
        const change = parseJson(changeSchema, row.value);
        if (change) applyRoomChange(records, change);
      }
      for (const record of records.values()) this.writeConfirmed(roomId, record);
      this.db
        .prepare("DELETE FROM outbox WHERE room_id = ? AND seq IS NOT NULL AND seq <= ?")
        .run(roomId, through);
      this.db.prepare("UPDATE outbox SET seq = NULL WHERE room_id = ?").run(roomId);
      this.db
        .prepare("UPDATE rooms SET epoch = ?, pulled_seq = ? WHERE id = ?")
        .run(epoch, through, roomId);
    });
  }

  // ── Outbox ───────────────────────────────────────────────────────────────

  enqueue(entry: Omit<OutboxEntry, "seq">): void {
    this.assertOpen();
    const next = parseRow(
      numberRow,
      this.db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM outbox").get(),
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (room_id, change_id, record_key, record_type, op, set_json, text_json, base, if_seq, actor_json, author, at, seq, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        entry.room,
        entry.id,
        entry.record,
        entry.type,
        entry.op,
        entry.set ? JSON.stringify(entry.set) : null,
        entry.text ? JSON.stringify(entry.text) : null,
        entry.base ?? null,
        entry.ifSeq ?? null,
        JSON.stringify(entry.actor),
        entry.author,
        entry.at,
        next?.value ?? 1,
      );
  }

  /** The organization ordered my change: it joins the confirmed state and waits in the outbox for `durable`. */
  acknowledge(
    roomId: string,
    changeId: string,
    position: number,
    epoch: string,
  ): RoomChange | undefined {
    return this.transaction(() => {
      const entry = this.outboxEntry(roomId, changeId);
      if (!entry) return undefined;
      this.db
        .prepare("UPDATE outbox SET seq = ? WHERE room_id = ? AND change_id = ?")
        .run(position, roomId, changeId);
      const change: RoomChange = {
        seq: position,
        epoch,
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
      this.applyOrderedInTransaction(roomId, [change]);
      return change;
    });
  }

  /** A refused change is dropped; the confirmed state never had it. */
  reject(roomId: string, changeId: string): OutboxEntry | undefined {
    const entry = this.outboxEntry(roomId, changeId);
    this.db.prepare("DELETE FROM outbox WHERE room_id = ? AND change_id = ?").run(roomId, changeId);
    return entry;
  }

  outboxEntry(roomId: string, changeId: string): OutboxEntry | undefined {
    const row = parseRow(
      outboxRowSchema,
      this.db
        .prepare("SELECT * FROM outbox WHERE room_id = ? AND change_id = ?")
        .get(roomId, changeId),
    );
    return row ? this.outboxOf(row) : undefined;
  }

  /** Rows still to send (no position yet), oldest first. */
  pending(roomId: string): OutboxEntry[] {
    return parseRows(
      outboxRowSchema,
      this.db
        .prepare("SELECT * FROM outbox WHERE room_id = ? AND seq IS NULL ORDER BY ordinal")
        .all(roomId),
    ).flatMap((row) => this.outboxOf(row) ?? []);
  }

  /** Every outbox row of a room, acknowledged or not. */
  outbox(roomId: string): OutboxEntry[] {
    return parseRows(
      outboxRowSchema,
      this.db.prepare("SELECT * FROM outbox WHERE room_id = ? ORDER BY ordinal").all(roomId),
    ).flatMap((row) => this.outboxOf(row) ?? []);
  }

  private outboxOf(row: z.infer<typeof outboxRowSchema>): OutboxEntry | undefined {
    const actor = parseJson(actorSchema, row.actor_json);
    if (!actor) return undefined;
    const set = parseJson(fieldsSchema, row.set_json);
    const text = parseJson(textUpdatesSchema, row.text_json);
    return {
      room: row.room_id,
      id: row.change_id,
      record: row.record_key,
      type: row.record_type,
      op: row.op,
      ...(set ? { set } : {}),
      ...(text ? { text } : {}),
      ...(row.base !== null ? { base: row.base } : {}),
      ...(row.if_seq !== null ? { ifSeq: row.if_seq } : {}),
      actor,
      author: row.author,
      at: row.at,
      ...(row.seq !== null ? { seq: row.seq } : {}),
    };
  }

  // ── Reads: confirmed state with my pending changes laid over it ──────────

  /** What a screen shows; `pending` lists the record keys that carry unordered local changes. */
  view(roomId: string): { records: Map<RoomRecordKey, RoomRecordState>; pending: Set<string> } {
    this.assertOpen();
    const pending = this.pending(roomId);
    return {
      records: viewRoomRecords(this.confirmedRecords(roomId), pending),
      pending: new Set(pending.map((entry) => entry.record)),
    };
  }

  viewOne(roomId: string, key: string): { record: RoomRecordState; pending: boolean } | undefined {
    this.assertOpen();
    const confirmed = new Map<RoomRecordKey, RoomRecordState>();
    const current = this.readConfirmed(roomId, key);
    if (current) confirmed.set(current.key, current);
    const pending = this.pending(roomId).filter((entry) => entry.record === key);
    const record = viewRoomRecords(confirmed, pending).values().next().value;
    return record ? { record, pending: pending.length > 0 } : undefined;
  }

  history(
    roomId: string,
    options: { key?: string; afterSeq?: number; limit?: number } = {},
  ): RoomChange[] {
    this.assertOpen();
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const after = options.afterSeq ?? 0;
    const rows =
      options.key === undefined
        ? this.db
            .prepare(
              "SELECT change_json AS value FROM changes WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .all(roomId, after, limit)
        : this.db
            .prepare(
              "SELECT change_json AS value FROM changes WHERE room_id = ? AND record_key = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .all(roomId, options.key, after, limit);
    return parseRows(jsonCellRow, rows).flatMap((row) => parseJson(changeSchema, row.value) ?? []);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  recordFile(roomId: string, file: { sha256: string; bytes: number; contentType: string }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO files (room_id, sha256, bytes, content_type) VALUES (?, ?, ?, ?)",
      )
      .run(roomId, file.sha256, file.bytes, file.contentType);
  }
}
