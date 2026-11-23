import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import type { Channel } from "@zygstinct/shared";

import type { OutboundRequest } from "../gateway.js";
import type { ConversationKey } from "../store.js";
import type { ComposeDecision, ComposeMeme, ComposerNote, ComposerNoteKind, MaterialOrigin } from "./composer.js";

/**
 * The outbox's own agent.db tables (docs/design/organism-outbox.md 3.2). This is the agent server's SQLite, migrated by the module like the tasks and
 * schedules tables; the operational Postgres and its pgroll chain (DT15) are not touched.
 *
 * `outbox_material` holds what turns queued for the member, keyed by the live send key (`<turn>:live:<n>:<sha12>`), so a replayed turn inserts nothing new.
 * `outbox_moments` holds each moment's decision, frozen before the first gateway attempt (SD06's pattern): a retry sends the stored bytes under the same key.
 */

/** `awaiting_check`: unasked, unchecked material that corrects something already told, kept until checked material reaches the conversation (or `CHECK_WAIT_MS` passes). */
export type MaterialState = "buffered" | "held" | "composing" | "awaiting_check" | "sent" | "dropped" | "untold" | "withheld" | "unknown";
/** How a moment ended: its decision was carried out, or the composer failed and the fallback ran (answers sent as written, the rest held). */
export type MomentState = "decided" | "sent" | "held" | "nothing" | "fallback" | "withheld" | "unknown" | "failed" | "dropped";

/**
 * The exact bytes of a message the composer may not rewrite (R149): an approval card with its buttons (AU03), an owner-only action result in fixed server
 * wording (SD17), a team invite to forward, a file, picture, artifact link or reaction (SD16), an approved-hash alert. Stored without its recipient and key:
 * the outbox's send rebuilds those from the moment's conversation and the piece's own key (SD01), so a stored body can never name another chat.
 */
export type FixedBody = DistributiveOmit<OutboundRequest, "channel" | "brandId" | "conversation" | "idempotencyKey" | "hostId"> & { hostId?: string };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface FixedPiece {
  body: FixedBody;
  /** Only the brand's signup owner may get it, rechecked from a fresh directory read right before the send (SD17). */
  ownerOnly?: boolean;
  /**
   * The caller registered a dispatch guard for this piece in this process (`Router.fixedGuards`), awaited before every attempt. After a restart the guard is
   * gone and the piece is never sent unguarded: it is settled dropped (`guard_lost`).
   */
  guarded?: boolean;
  /** A named, durable hook told the provider message id once the piece is sent (an approval card binds its buttons to it). */
  onSent?: { hook: string; args: Record<string, string> };
  /** What the outbound record (and every later reader of it, the composer's ledger included) keeps instead of the bytes: an invite's join link is a credential. */
  recordText?: string;
  /** A reply's file (or its artifact link): the name the delivery hook is told once it is sent, so a skill's file going out is that skill's send (MLY-407). */
  fileName?: string;
}

export interface NewMaterial {
  key: string;
  conversation: ConversationKey;
  memberId: string | null;
  turnId: string;
  /** `fixed`: exact bytes (`fixed`) the composer can send, hold or leave out but never rewrite; `text` is then the description it reads. */
  kind: "text" | "voice" | "fixed";
  text: string;
  fixed?: FixedPiece | null;
  lang: string | null;
  /** The brand's persona voice when the turn queued it: a held moment speaks in it without asking the sandbox. */
  voiceName: string | null;
  origin: MaterialOrigin;
  answersMessageId: string | null;
  checked: boolean;
  /** Takes back or corrects something already told: the reply tool's typed `corrects` argument (live-sends.ts), never read from the words. */
  corrects?: boolean;
  /**
   * What the words rest on, as the session that wrote them typed it (outbox.put `basis`): `state` = the brand state it already had (no fresh work), `work` = a
   * worker's own checking. Absent for material from before it existed and for a turn's unsent final words.
   */
  basis?: "state" | "work" | null;
  /** The task whose worker wrote it (outbox.put `taskId`, checked against the server's own task ledger): where the outbox agent asks for a rework. */
  taskId?: string | null;
  /**
   * The routine run that wrote it (its Marshal session id, set by the server from the run it delivers, never from the words): where the outbox agent asks
   * for a rework when no task wrote it (`ExtensionRoutineEngine.reworkRun`).
   */
  runId?: string | null;
  /** The ref of an earlier message of this conversation the words answer (outbox.put `replyTo`): the outbox agent may quote it. */
  replyTo?: string | null;
  /** How many times the words this piece replaces were sent back to their writer (a rework or a revise): bounded by MAX_REWORKS, then the composer decides alone. */
  reworks?: number;
  /** The ids of the turn's pending messages: what the reply gate is asked with when held material goes out later. */
  pendingIds: readonly string[];
  at: number;
  /**
   * A meme the composer's pass prepared (origin "composer" only; the outbox drops it from any other piece): the next send that names this piece and has no
   * meme of its own carries it, screened like any meme (the memes lane's `withPreparedMeme`).
   */
  meme?: ComposeMeme | null;
}

export interface MaterialRow extends NewMaterial {
  state: MaterialState;
  holdUntil: number | null;
  holds: number;
  momentId: string | null;
  reason: string | null;
  /** When the composer's current streak of failures began (the first `composer_failed` hold); null while it has not failed on this piece or once it decided (a hold, a send, nothing). */
  failedSince: number | null;
}

export interface FrozenMoment {
  momentId: string;
  conversation: ConversationKey;
  materialKeys: string[];
  /** The decision as carried out: the composer's, or `fallback` when it failed. */
  decision: ComposeDecision | FallbackDecision;
  state: MomentState;
  createdAt: number;
}

/**
 * The composer gave no usable answer. `screened` is the machinery screen's verdict on each piece that answers the person (by material key), judged before the
 * decision was frozen, so a replay acts on the same verdicts: `clean` goes as written, `system` is replaced by a fixed human line, `unavailable` (or no verdict:
 * a moment frozen before the screen existed) waits for a judgement behind a fixed wait line. Absent with no screen wired (a scripted test composer).
 * `verbatim`: no composer and no screen were asked (an inspector nudge conversation, `OPERATOR_NUDGE_CAUSE`): every piece goes as its turn wrote it, at once.
 */
export interface FallbackDecision { action: "fallback"; cause: string; oneText?: true; verbatim?: true; screened?: Record<string, "clean" | "system" | "unavailable">; plains?: Record<string, string>; lineLang?: "he" | "en"; again?: true }

export const OUTBOX_RETENTION_MS = 14 * 24 * 3_600_000;
/** How long a correction waits for a check before it is offered to the composer anyway, marked unchecked: never kept from the person forever (LN03). */
export const CHECK_WAIT_MS = 6 * 3_600_000;

export function migrateOutbox(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_material (
    key TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
    member_id TEXT, turn_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, lang TEXT, voice_name TEXT,
    origin TEXT NOT NULL, answers_message_id TEXT, checked INTEGER NOT NULL, pending_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, state TEXT NOT NULL, hold_until INTEGER, holds INTEGER NOT NULL DEFAULT 0, moment_id TEXT, reason TEXT, failed_since INTEGER)`);
  // A table made before the failure streak was stored gets its column once.
  if (!(db.prepare("PRAGMA table_info(outbox_material)").all() as { name: string }[]).some((column) => column.name === "failed_since")) db.exec("ALTER TABLE outbox_material ADD COLUMN failed_since INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS outbox_material_conversation_idx ON outbox_material (brand_id, channel, conversation_id, state)");
  db.exec("CREATE INDEX IF NOT EXISTS outbox_material_due_idx ON outbox_material (state, hold_until)");
  db.exec(`CREATE TABLE IF NOT EXISTS outbox_moments (
    moment_id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
    material_json TEXT NOT NULL, decision_json TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, finished_at INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS outbox_moments_conversation_idx ON outbox_moments (brand_id, channel, conversation_id, created_at)");
  const columns = db.prepare("PRAGMA table_info(outbox_material)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "corrects")) db.exec("ALTER TABLE outbox_material ADD COLUMN corrects INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "basis")) db.exec("ALTER TABLE outbox_material ADD COLUMN basis TEXT");
  if (!columns.some((column) => column.name === "task_id")) db.exec("ALTER TABLE outbox_material ADD COLUMN task_id TEXT");
  if (!columns.some((column) => column.name === "reply_to")) db.exec("ALTER TABLE outbox_material ADD COLUMN reply_to TEXT");
  if (!columns.some((column) => column.name === "reworks")) db.exec("ALTER TABLE outbox_material ADD COLUMN reworks INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "fixed_json")) db.exec("ALTER TABLE outbox_material ADD COLUMN fixed_json TEXT");
  if (!columns.some((column) => column.name === "run_id")) db.exec("ALTER TABLE outbox_material ADD COLUMN run_id TEXT");
  if (!columns.some((column) => column.name === "meme_json")) db.exec("ALTER TABLE outbox_material ADD COLUMN meme_json TEXT");
  // The composer's own session per conversation (docs/design/composer-agent.md): the engine session it resumes, its counters and the summary carried over a
  // rollover. Its notebook: what it keeps about the person, per conversation. Both live here only, never on the brand's machine.
  db.exec(`CREATE TABLE IF NOT EXISTS composer_sessions (
    brand_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
    session_id TEXT, started_at INTEGER, turns INTEGER NOT NULL DEFAULT 0, context_tokens INTEGER NOT NULL DEFAULT 0, summary TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY (brand_id, channel, conversation_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS composer_notes (
    id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
    at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, retired_at INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS composer_notes_conversation_idx ON composer_notes (brand_id, channel, conversation_id, retired_at, at)");
}

/** The composer session of one conversation as stored (`OutboxStore.composerSession`). */
export interface ComposerSessionRecord { sessionId: string | null; startedAt: number | null; turns: number; contextTokens: number; summary: string | null; /** When it was last saved (read only; set by the store). */ updatedAt?: number }
/** At most this many live notes are kept per conversation; adding past it retires the oldest. */
export const NOTES_KEPT = 60;
const NOTE_KINDS: readonly ComposerNoteKind[] = ["pattern", "promise", "tone", "offer", "meme", "other"];

interface MaterialDbRow {
  key: string; brand_id: string; channel: string; conversation_id: string; member_id: string | null; turn_id: string; kind: string; text: string; lang: string | null; voice_name: string | null;
  origin: string; answers_message_id: string | null; checked: number; pending_ids_json: string; created_at: number; state: string; hold_until: number | null; holds: number;
  moment_id: string | null; reason: string | null; failed_since: number | null; corrects: number; basis: string | null; task_id: string | null; run_id: string | null; reply_to: string | null; reworks: number | null; fixed_json: string | null; meme_json: string | null;
}

/** A stored prepared meme read back: a template id and its lines, or null for anything else (never trusted further than its shape). */
function memeOf(text: string | null): ComposeMeme | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as { template?: unknown; lines?: unknown };
    return typeof value.template === "string" && Array.isArray(value.lines) && value.lines.every((line) => typeof line === "string") ? { template: value.template, lines: value.lines as string[] } : null;
  } catch {
    return null;
  }
}

function toMaterial(row: MaterialDbRow): MaterialRow {
  return {
    key: row.key,
    conversation: { brandId: row.brand_id, channel: row.channel as Channel, conversationId: row.conversation_id },
    memberId: row.member_id,
    turnId: row.turn_id,
    kind: row.kind === "voice" ? "voice" : row.kind === "fixed" && row.fixed_json ? "fixed" : "text",
    fixed: row.kind === "fixed" && row.fixed_json ? JSON.parse(row.fixed_json) as FixedPiece : null,
    text: row.text,
    lang: row.lang,
    voiceName: row.voice_name,
    origin: row.origin as MaterialOrigin,
    answersMessageId: row.answers_message_id,
    checked: row.checked === 1,
    corrects: row.corrects === 1,
    basis: row.basis === "state" || row.basis === "work" ? row.basis : null,
    taskId: row.task_id,
    runId: row.run_id,
    replyTo: row.reply_to,
    reworks: row.reworks ?? 0,
    ...(row.origin === "composer" && memeOf(row.meme_json) ? { meme: memeOf(row.meme_json) } : {}),
    pendingIds: JSON.parse(row.pending_ids_json) as string[],
    at: row.created_at,
    state: row.state as MaterialState,
    holdUntil: row.hold_until,
    holds: row.holds,
    momentId: row.moment_id,
    reason: row.reason,
    failedSince: row.failed_since,
  };
}

export class OutboxStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    migrateOutbox(db);
  }

  /** Stores a piece of material unless its key is already stored (a replay of the same turn): true when it is new. */
  add(material: NewMaterial): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO outbox_material (key, brand_id, channel, conversation_id, member_id, turn_id, kind, text, lang, voice_name, origin, answers_message_id, checked, corrects, basis, task_id, run_id, reply_to, reworks, pending_ids_json, created_at, fixed_json, meme_json, state, holds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'buffered', 0)`).run(
      material.key, material.conversation.brandId, material.conversation.channel, material.conversation.conversationId, material.memberId, material.turnId, material.kind,
      material.text, material.lang, material.voiceName, material.origin, material.answersMessageId, material.checked ? 1 : 0, material.corrects ? 1 : 0, material.basis ?? null, material.taskId ?? null, material.runId ?? null, material.replyTo ?? null, material.reworks ?? 0, JSON.stringify(material.pendingIds), material.at, material.kind === "fixed" && material.fixed ? JSON.stringify(material.fixed) : null, material.origin === "composer" && material.meme ? JSON.stringify({ template: material.meme.template, lines: material.meme.lines }) : null);
    return result.changes === 1;
  }

  /**
   * What is ready for a moment in this conversation: buffered material, held material that is due, material of a moment left `composing` (by a crash, or
   * waiting for a check that could not be made: a turn's flush tries it again at once, the tick at its `hold_until`), and a correction whose wait for a
   * check ran out. Oldest first.
   */
  ready(key: ConversationKey, now: number): MaterialRow[] {
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ?
      AND (state IN ('buffered', 'composing') OR (state = 'held' AND hold_until <= ?) OR (state = 'awaiting_check' AND created_at <= ?)) ORDER BY created_at, key`)
      .all(key.brandId, key.channel, key.conversationId, now, now - CHECK_WAIT_MS) as MaterialDbRow[]).map(toMaterial);
  }

  /** Keys of this conversation's held material of one task, held for `reason` (a rework the task was asked for). */
  heldOfTask(key: ConversationKey, taskId: string, reason: string): string[] {
    return (this.db.prepare(`SELECT key FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'held' AND task_id = ? AND reason = ?`)
      .all(key.brandId, key.channel, key.conversationId, taskId, reason) as { key: string }[]).map((row) => row.key);
  }

  /** This conversation's pieces a routine run wrote that are held for `reason` (sent back to that run for a rework). */
  heldOfRun(key: ConversationKey, runId: string, reason: string): string[] {
    return (this.db.prepare(`SELECT key FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'held' AND run_id = ? AND reason = ?`)
      .all(key.brandId, key.channel, key.conversationId, runId, reason) as { key: string }[]).map((row) => row.key);
  }

  /**
   * This conversation's pieces of the inbox's own words that were sent back to it (held for `reason`) or already replaced (`reworked`), newest first: where the
   * words of a revise turn find the piece they replace.
   */
  sentBackToInbox(key: ConversationKey, reasons: readonly string[]): MaterialRow[] {
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND task_id IS NULL AND run_id IS NULL AND reworks > 0
      AND ((state = 'held' AND reason = ?) OR (state = 'dropped' AND reason = ?)) ORDER BY created_at DESC LIMIT 20`)
      .all(key.brandId, key.channel, key.conversationId, reasons[0], reasons[1]) as MaterialDbRow[]).map(toMaterial);
  }

  /** Corrections of this conversation still waiting for a check, oldest first. */
  awaitingCheck(key: ConversationKey): MaterialRow[] {
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'awaiting_check' ORDER BY created_at, key`)
      .all(key.brandId, key.channel, key.conversationId) as MaterialDbRow[]).map(toMaterial);
  }

  /**
   * Conversations the tick owes a moment, oldest first: held material that is due, material a crash left `composing` (its frozen moment is resumed, never composed
   * again), and material still `buffered` from before `strandedBefore` (its turn never flushed it).
   */
  dueConversations(now: number, strandedBefore: number, limit = 20): ConversationKey[] {
    return (this.db.prepare(`SELECT brand_id, channel, conversation_id, MIN(COALESCE(hold_until, created_at)) AS due FROM outbox_material
      WHERE (state IN ('held', 'composing') AND COALESCE(hold_until, 0) <= ?) OR (state = 'buffered' AND created_at <= ?) OR (state = 'awaiting_check' AND created_at <= ?)
      GROUP BY brand_id, channel, conversation_id ORDER BY due LIMIT ?`).all(now, strandedBefore, now - CHECK_WAIT_MS, limit) as { brand_id: string; channel: string; conversation_id: string }[])
      .map((row) => ({ brandId: row.brand_id, channel: row.channel as Channel, conversationId: row.conversation_id }));
  }

  /** Words parked after a long composer failure (`hold_until` = PARKED_UNTIL): waiting for a moment with material that answers the person. */
  parked(key: ConversationKey): MaterialRow[] {
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'held' AND hold_until = ? ORDER BY created_at, key`)
      .all(key.brandId, key.channel, key.conversationId, Number.MAX_SAFE_INTEGER) as MaterialDbRow[]).map(toMaterial);
  }

  /** The brands that have material still waiting (buffered, held or composing). */
  brandsWithWaiting(): string[] {
    return (this.db.prepare("SELECT DISTINCT brand_id FROM outbox_material WHERE state IN ('buffered', 'held', 'composing', 'awaiting_check')").all() as { brand_id: string }[]).map((row) => row.brand_id);
  }

  /**
   * Retires one brand's unasked waiting words (`untold`, reason `brand_unlisted`): buffered or held, and composing where no decision was frozen (none was attempted;
   * a frozen moment is carried out as decided by the flush). Words that answer the person are never retired here. Returns how many were retired and how many
   * answers are still owed.
   */
  retireUnasked(brandId: string): { untold: number; answersOwed: number } {
    return this.db.transaction(() => {
      const untold = this.db.prepare(`UPDATE outbox_material SET state = 'untold', reason = 'brand_unlisted' WHERE brand_id = ? AND answers_message_id IS NULL
        AND (state IN ('buffered', 'held', 'awaiting_check') OR (state = 'composing' AND (moment_id IS NULL OR moment_id NOT IN (SELECT moment_id FROM outbox_moments))))`).run(brandId).changes;
      const answersOwed = (this.db.prepare("SELECT COUNT(*) AS n FROM outbox_material WHERE brand_id = ? AND state IN ('buffered', 'held', 'composing') AND answers_message_id IS NOT NULL").get(brandId) as { n: number }).n;
      return { untold, answersOwed };
    })();
  }

  /**
   * Conversations of brands not on `listed` that a flush has something to do for, oldest first: buffered words, held words that are due, and composing ones unless
   * they wait for a check to be tried again (`hold_until` ahead).
   */
  unlistedConversations(listed: readonly string[], now: number): ConversationKey[] {
    const others = listed.length === 0 ? "" : `brand_id NOT IN (${listed.map(() => "?").join(", ")}) AND `;
    return (this.db.prepare(`SELECT brand_id, channel, conversation_id, MIN(created_at) AS first FROM outbox_material
      WHERE ${others}(state IN ('buffered', 'awaiting_check') OR (state IN ('held', 'composing') AND COALESCE(hold_until, 0) <= ?))
      GROUP BY brand_id, channel, conversation_id ORDER BY first`).all(...listed, now) as { brand_id: string; channel: string; conversation_id: string }[])
      .map((row) => ({ brandId: row.brand_id, channel: row.channel as Channel, conversationId: row.conversation_id }));
  }

  /** Whether any piece of any brand is still waiting (buffered, held or composing). */
  anyWaiting(): boolean {
    return this.db.prepare("SELECT 1 FROM outbox_material WHERE state IN ('buffered', 'held', 'composing', 'awaiting_check') LIMIT 1").get() !== undefined;
  }

  /** Moves material from one of the expected states to the next, only where it still is in one of them (a compare-and-set, SD04). Returns the keys moved. */
  move(keys: readonly string[], from: readonly MaterialState[], to: MaterialState, fields: { momentId?: string | null; holdUntil?: number | null; holdsPlus?: boolean; reworksPlus?: boolean; reason?: string | null; failedSince?: number | null; clearFailure?: boolean } = {}): string[] {
    const moved: string[] = [];
    const statement = this.db.prepare(`UPDATE outbox_material SET state = ?, moment_id = COALESCE(?, moment_id), hold_until = ?, holds = holds + ?, reworks = reworks + ?, reason = COALESCE(?, reason),
      failed_since = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, failed_since) END
      WHERE key = ? AND state IN (${from.map(() => "?").join(", ")})`);
    this.db.transaction(() => {
      for (const key of keys) {
        const result = statement.run(to, fields.momentId ?? null, fields.holdUntil ?? null, fields.holdsPlus ? 1 : 0, fields.reworksPlus ? 1 : 0, fields.reason ?? null, fields.clearFailure ? 1 : 0, fields.failedSince ?? null, key, ...from);
        if (result.changes === 1) moved.push(key);
      }
    })();
    return moved;
  }

  /** When words this turn buffered went out: the earliest sent moment's finish time, or null while none has (still waiting, held, dropped or withheld). */
  sentAt(turnId: string): number | null {
    const row = this.db.prepare("SELECT MIN(COALESCE(o.finished_at, o.created_at)) AS at FROM outbox_material m JOIN outbox_moments o ON o.moment_id = m.moment_id WHERE m.turn_id = ? AND m.state = 'sent' AND o.state = 'sent'").get(turnId) as { at: number | null };
    return row.at;
  }

  /** Pieces this turn buffered that are still waiting to go out: words the outbox took from the turn and owes the person. */
  waitingFor(turnId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outbox_material WHERE turn_id = ? AND state IN ('buffered', 'composing', 'held')").get(turnId) as { n: number }).n;
  }

  material(keys: readonly string[]): MaterialRow[] {
    if (keys.length === 0) return [];
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE key IN (${keys.map(() => "?").join(", ")})`).all(...keys) as MaterialDbRow[]).map(toMaterial);
  }

  moment(momentId: string): FrozenMoment | null {
    const row = this.db.prepare("SELECT * FROM outbox_moments WHERE moment_id = ?").get(momentId) as
      | { moment_id: string; brand_id: string; channel: string; conversation_id: string; material_json: string; decision_json: string; state: string; created_at: number }
      | undefined;
    return row ? {
      momentId: row.moment_id,
      conversation: { brandId: row.brand_id, channel: row.channel as Channel, conversationId: row.conversation_id },
      materialKeys: JSON.parse(row.material_json) as string[],
      decision: JSON.parse(row.decision_json) as FrozenMoment["decision"],
      state: row.state as MomentState,
      createdAt: row.created_at,
    } : null;
  }

  /** Stores a moment's decision unless one is already stored for it, and returns the stored one: the first writer wins, so every retry carries the same bytes. Throws when it cannot store. */
  freeze(momentId: string, key: ConversationKey, materialKeys: readonly string[], decision: FrozenMoment["decision"]): FrozenMoment {
    const now = this.now();
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM outbox_moments WHERE created_at < ?").run(now - OUTBOX_RETENTION_MS);
      this.db.prepare("DELETE FROM outbox_material WHERE created_at < ? AND state NOT IN ('buffered', 'held', 'composing', 'awaiting_check')").run(now - OUTBOX_RETENTION_MS);
      this.db.prepare(`INSERT OR IGNORE INTO outbox_moments (moment_id, brand_id, channel, conversation_id, material_json, decision_json, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'decided', ?)`).run(momentId, key.brandId, key.channel, key.conversationId, JSON.stringify(materialKeys), JSON.stringify(decision), now);
      const stored = this.moment(momentId);
      if (!stored) throw new Error("outbox moment was not stored");
      return stored;
    })();
  }

  /** Ends a moment, only from `decided` (a compare-and-set): a second writer of the same moment learns what the row says instead. */
  finish(momentId: string, state: MomentState): MomentState {
    this.db.prepare("UPDATE outbox_moments SET state = ?, finished_at = ? WHERE moment_id = ? AND state = 'decided'").run(state, this.now(), momentId);
    return (this.db.prepare("SELECT state FROM outbox_moments WHERE moment_id = ?").get(momentId) as { state: string } | undefined)?.state as MomentState;
  }

  /** The conversation's moments that sent a composed message since `since`, oldest first: the source of open items and advice as heard. */
  sentDecisions(key: ConversationKey, since: number): { at: number; decision: ComposeDecision }[] {
    return (this.db.prepare(`SELECT decision_json, created_at FROM outbox_moments WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'sent' AND created_at >= ? ORDER BY created_at`)
      .all(key.brandId, key.channel, key.conversationId, since) as { decision_json: string; created_at: number }[])
      .map((row) => ({ at: row.created_at, decision: JSON.parse(row.decision_json) as ComposeDecision }));
  }

  /** The conversation's newest moment that was carried out (not one still `decided`): when, what was decided and how it ended. */
  lastMoment(key: ConversationKey): { at: number; action: string; outcome: MomentState } | null {
    const row = this.db.prepare(`SELECT decision_json, state, created_at FROM outbox_moments WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state <> 'decided' ORDER BY created_at DESC LIMIT 1`)
      .get(key.brandId, key.channel, key.conversationId) as { decision_json: string; state: string; created_at: number } | undefined;
    if (!row) return null;
    const action = (JSON.parse(row.decision_json) as { action?: unknown }).action;
    return { at: row.created_at, action: typeof action === "string" ? action : "unknown", outcome: row.state as MomentState };
  }

  /** The conversation's composer session, or null when it never had one. */
  composerSession(key: ConversationKey): ComposerSessionRecord | null {
    const row = this.db.prepare("SELECT session_id, started_at, turns, context_tokens, summary, updated_at FROM composer_sessions WHERE brand_id = ? AND channel = ? AND conversation_id = ?")
      .get(key.brandId, key.channel, key.conversationId) as { session_id: string | null; started_at: number | null; turns: number; context_tokens: number; summary: string | null; updated_at: number } | undefined;
    return row ? { sessionId: row.session_id, startedAt: row.started_at, turns: row.turns, contextTokens: row.context_tokens, summary: row.summary, updatedAt: row.updated_at } : null;
  }

  /** Which conversation a composer engine session belongs to (a host capability called from that session learns its chat from the server's own row). */
  composerSessionKey(sessionId: string): ConversationKey | null {
    const rows = this.db.prepare("SELECT brand_id, channel, conversation_id FROM composer_sessions WHERE session_id = ? LIMIT 2")
      .all(sessionId) as { brand_id: string; channel: string; conversation_id: string }[];
    if (rows.length !== 1) return null;
    return { brandId: rows[0]!.brand_id, channel: rows[0]!.channel as ConversationKey["channel"], conversationId: rows[0]!.conversation_id };
  }

  saveComposerSession(key: ConversationKey, session: ComposerSessionRecord): void {
    this.db.prepare(`INSERT INTO composer_sessions (brand_id, channel, conversation_id, session_id, started_at, turns, context_tokens, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (brand_id, channel, conversation_id) DO UPDATE SET session_id = excluded.session_id, started_at = excluded.started_at, turns = excluded.turns,
      context_tokens = excluded.context_tokens, summary = excluded.summary, updated_at = excluded.updated_at`)
      .run(key.brandId, key.channel, key.conversationId, session.sessionId, session.startedAt, session.turns, session.contextTokens, session.summary, this.now());
  }

  /** The composer's live notes about this conversation's person, newest last (at most `limit`, the newest ones). */
  notes(key: ConversationKey, limit = 40): ComposerNote[] {
    return (this.db.prepare(`SELECT id, at, kind, text FROM composer_notes WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND retired_at IS NULL ORDER BY at DESC, id DESC LIMIT ?`)
      .all(key.brandId, key.channel, key.conversationId, Math.max(0, limit)) as { id: string; at: number; kind: string; text: string }[])
      .reverse()
      .map((row) => ({ id: row.id, at: row.at, kind: (NOTE_KINDS as readonly string[]).includes(row.kind) ? row.kind as ComposerNoteKind : "other", text: row.text }));
  }

  /** Adds notes (text capped at 400 characters); past NOTES_KEPT live notes the oldest are retired. */
  addNotes(key: ConversationKey, notes: { kind: ComposerNoteKind; text: string }[], now: number): void {
    const insert = this.db.prepare("INSERT INTO composer_notes (id, brand_id, channel, conversation_id, at, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const note of notes) {
        const text = note.text.trim().slice(0, 400);
        if (!text) continue;
        insert.run(`n_${randomBytes(6).toString("hex")}`, key.brandId, key.channel, key.conversationId, now, NOTE_KINDS.includes(note.kind) ? note.kind : "other", text);
      }
      this.db.prepare(`UPDATE composer_notes SET retired_at = ? WHERE id IN (SELECT id FROM composer_notes WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND retired_at IS NULL
        ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`).run(now, key.brandId, key.channel, key.conversationId, NOTES_KEPT);
    })();
  }

  /** Retires notes of this conversation only: an id of another conversation's note is ignored. */
  retireNotes(key: ConversationKey, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE composer_notes SET retired_at = ? WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND retired_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`)
      .run(this.now(), key.brandId, key.channel, key.conversationId, ...ids);
  }

  /** Material of the conversation the member never saw (held, dropped, untold, withheld or of unknown outcome) since `since`, oldest first. */
  notReached(key: ConversationKey, since: number): MaterialRow[] {
    return (this.db.prepare(`SELECT * FROM outbox_material WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state IN ('held', 'dropped', 'untold', 'withheld', 'unknown') AND created_at >= ? ORDER BY created_at`)
      .all(key.brandId, key.channel, key.conversationId, since) as MaterialDbRow[]).map(toMaterial);
  }
}
