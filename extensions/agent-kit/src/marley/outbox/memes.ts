import type Database from "better-sqlite3";

import { isSystemPhone } from "../agent-extensions/schedules/types.js";
import type { Logger } from "../logger.js";
import { failureFields } from "../operation-error.js";
import type { ConversationKey, StoredMessage } from "../store.js";
import { inert, type ComposeDecision, type ComposeMeme, type ComposerNoteKind } from "./composer.js";
import { MEME_RENDER_SCRIPT, memeRenderCommand, memeRenderInput, type MemeBoxFit } from "./meme-render.js";
import { memeTemplate } from "./meme-templates.js";
import type { FrozenMoment } from "./store.js";

/** The one VM call a meme needs: a command run as the conversation's own chat user (BrandVms.get with the chat key). */
export interface MemeVm {
  run(command: string, options: { stdin?: string | Buffer; timeoutMs?: number }): Promise<{ code: number | null; stdout: string }>;
}

export interface MemeMakerDeps {
  vm(hostId: string, brandId: string, key: ConversationKey): MemeVm;
  /** The brand's sandbox host, read fresh; asked only when the moment has no turn (the held tick). */
  hostOf(brandId: string): Promise<string | null>;
  /** The brands memes are on for; absent = every brand the outbox serves. */
  brands?: ReadonlySet<string>;
  logger: Logger;
  timeoutMs?: number;
}

/** The outcome of drawing one meme: the chat-relative outbox path the image send reads, on that host, or null when it could not be drawn (logged). */
export type MadeMeme = { hostId: string; path: string } | null;

/** One box of a previewed meme: how its words came out, the words themselves and what the box holds (the catalog's line hint). */
export type MemePreviewBox = MemeBoxFit & { words: string; holds: string };

/**
 * What a preview tells the composer about a meme it is thinking of sending: how each box's words came out (size, wrapped lines, whether they fit, how much
 * of the box they fill, emoji left off), the font and the canvas. The composer's model cannot see the picture itself (the engine's tool results reach a
 * Gemini session as text only, and the runtime's answer to a Claude session carries no image block), so the measurement is what it gets.
 */
export type MemePreview =
  | { ok: true; template: string; font: string; canvas: [number, number]; boxes: MemePreviewBox[]; readable: boolean; advice: string[] }
  | { ok: false; why: string };

/**
 * Draws the composer's meme on the brand's sandbox as the conversation's own chat user (the picture lands in that chat's `files/outbox/`, where the
 * outbox's image send reads it with the same checks as any live image). The template's URL and boxes come from the catalog, the words from the decision;
 * nothing of the brand leaves the sandbox except the image the person is sent. Every failure is null: the words still go without the picture.
 */
export class MemeMaker {
  constructor(private readonly deps: MemeMakerDeps) {}

  on(key: ConversationKey): boolean {
    return this.deps.brands === undefined || this.deps.brands.has(key.brandId);
  }

  async make(hostId: string | null, key: ConversationKey, meme: ComposeMeme, name: string): Promise<MadeMeme> {
    const input = memeRenderInput(meme, name);
    if (!input) { this.deps.logger.warn("outbox.meme_failed", { brandId: key.brandId, reason: "unknown_template" }); return null; }
    const ran = await this.run(hostId, key, memeRenderCommand(input), "outbox.meme_failed");
    if (!ran) return null;
    const { host, answer, code } = ran;
    if (code !== 0 || !answer?.ok || typeof answer.path !== "string") {
      this.deps.logger.warn("outbox.meme_failed", { brandId: key.brandId, reason: answer?.why ?? "render_failed", code });
      return null;
    }
    const overflow = answer.fit?.filter((box) => box.fits === false).map((box) => box.box) ?? [];
    this.deps.logger.info("outbox.meme_drawn", { brandId: key.brandId, template: input.template, bytes: answer.bytes, ...(overflow.length ? { overflow } : {}) });
    return { hostId: host, path: answer.path };
  }

  /**
   * Draws the meme the way `make` would, as the same chat user with the same script, but in memory only: the script answers before it touches the chat's
   * outbox folder, so nothing the image send reads is written. Only a catalog id and the words come in; a path or a URL has no field to go in.
   */
  async preview(hostId: string | null, key: ConversationKey, meme: ComposeMeme): Promise<MemePreview> {
    const template = memeTemplate(meme.template);
    const input = memeRenderInput(meme, "preview.jpg", { preview: true });
    if (!template || !input) return { ok: false, why: "unknown_template" };
    if (meme.lines.length > template.boxes.length) return { ok: false, why: `${template.id} has ${template.boxes.length} boxes; ${meme.lines.length} lines were given` };
    const ran = await this.run(hostId, key, memeRenderCommand(input), "outbox.meme_preview_failed");
    if (!ran) return { ok: false, why: "sandbox_unreachable" };
    const { answer, code } = ran;
    if (code !== 0 || !answer?.ok || answer.preview !== true || !answer.fit) return { ok: false, why: answer?.why ?? "render_failed" };
    const measured = answer.fit;
    const boxes: MemePreviewBox[] = template.boxes.map((box, index) => {
      const words = meme.lines[index] ?? "";
      const fit = measured.find((one) => one.box === index) ?? { box: index, empty: true as const, dropped: 0 };
      // A line longer than its box's `max` is refused at send (validateDecision), whatever the picture shows.
      const tooLong = box.max !== undefined && words.length > box.max;
      return { ...fit, ...(tooLong ? { fits: false } : {}), words, holds: template.lines[index] ?? "" };
    });
    const advice: string[] = [];
    for (const box of boxes) {
      const name = `box ${box.box + 1} (${box.holds})`;
      if (box.empty) { advice.push(`${name} is empty: the picture shows it blank`); continue; }
      if (box.fits === false) advice.push(`${name} does not fit: cut its words`);
      else if (box.smallest) advice.push(`${name} fits only at the smallest size, hard to read on a phone: shorten it`);
      if (box.dropped > 0) advice.push(`${name} lost ${box.dropped} emoji or symbol characters (no meme font draws them)`);
    }
    // An empty box is the composer's choice (fewer lines than boxes is allowed); only words that overflow or shrink to the floor read badly.
    const readable = boxes.some((box) => !box.empty) && boxes.every((box) => box.empty || (box.fits !== false && !box.smallest));
    return { ok: true, template: template.id, font: answer.font ?? "unknown", canvas: answer.canvas ?? [0, 0], boxes, readable, advice };
  }

  private async run(hostId: string | null, key: ConversationKey, command: string, failure: string): Promise<{ host: string; answer: Answer | null; code: number | null } | null> {
    let host = hostId;
    try {
      if (!host) host = await this.deps.hostOf(key.brandId);
    } catch (error) {
      this.deps.logger.warn(failure, { brandId: key.brandId, reason: "host_unreadable", ...failureFields(error) });
      return null;
    }
    if (!host) { this.deps.logger.warn(failure, { brandId: key.brandId, reason: "no_host" }); return null; }
    try {
      const result = await this.deps.vm(host, key.brandId, key).run(command, { stdin: MEME_RENDER_SCRIPT, timeoutMs: this.deps.timeoutMs ?? 45_000 });
      return { host, answer: parseAnswer(result.stdout), code: result.code };
    } catch (error) {
      this.deps.logger.warn(failure, { brandId: key.brandId, reason: "run_failed", ...failureFields(error) });
      return null;
    }
  }
}

interface Answer { ok: boolean; path?: unknown; bytes?: unknown; why?: string; preview?: true; font?: string; canvas?: [number, number]; fit?: MemeBoxFit[] }

/** The script's one JSON line, read field by field: only typed values pass (a sandbox answer is the brand's, PI01). */
function parseAnswer(stdout: string): Answer | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const fit = Array.isArray(value.fit) ? value.fit.filter(isFit).slice(0, 8).map(cleanFit) : undefined;
    const canvas = Array.isArray(value.canvas) && value.canvas.length === 2 && value.canvas.every((n) => Number.isInteger(n)) ? (value.canvas as [number, number]) : undefined;
    return {
      ok: value.ok === true,
      path: value.path,
      bytes: value.bytes,
      ...(typeof value.why === "string" ? { why: value.why.slice(0, 40) } : {}),
      ...(value.preview === true ? { preview: true as const } : {}),
      ...(typeof value.font === "string" && /^[A-Za-z0-9 ._-]{1,60}$/.test(value.font) ? { font: value.font } : {}),
      ...(canvas ? { canvas } : {}),
      ...(fit ? { fit } : {}),
    };
  } catch {
    return null;
  }
}

function isFit(value: unknown): value is MemeBoxFit {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  return Number.isInteger(box.box) && typeof box.dropped === "number" && (box.empty === true || (typeof box.size === "number" && typeof box.fits === "boolean"));
}

const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function cleanFit(box: MemeBoxFit): MemeBoxFit {
  if (box.empty) return { box: box.box, empty: true, dropped: number(box.dropped) ?? 0 };
  const lines = number(box.lines), width = number(box.width), height = number(box.height);
  return { box: box.box, size: number(box.size)!, fits: box.fits === true, smallest: box.smallest === true, dropped: number(box.dropped) ?? 0, ...(lines !== undefined ? { lines } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

/**
 * Whether a meme can go as written: a catalog template, no more lines than its boxes, none past a box's `max`, and at least one word. The same rule
 * `validateDecision` holds a composed meme to, for a meme that did not come through it (a prepared one).
 */
export function memeFits(meme: ComposeMeme): boolean {
  const boxes = memeTemplate(meme.template)?.boxes;
  if (!boxes || meme.lines.length === 0 || meme.lines.length > boxes.length) return false;
  if (meme.lines.every((line) => line.trim().length === 0)) return false;
  return meme.lines.every((line, index) => line.length <= (boxes[index]?.max ?? 90));
}

/**
 * The outbox material a meme from the composer's pass becomes (REFLECT_ANSWER.meme): origin `composer`, unasked, carrying the meme as a typed field. Its
 * text is what the composer reads in the next moment; the meme itself goes only as the field, and only when that moment's message names the piece.
 */
export function preparedMemeMaterial(meme: ComposeMeme, replyTo?: string): { kind: "text"; origin: "composer"; text: string; meme: ComposeMeme; answersMessageId: null; checked: false; replyTo: string | null } {
  const template = memeTemplate(meme.template);
  const lines = meme.lines.map((line, index) => `${template?.lines[index] ?? `line ${index + 1}`}: "${inert(line)}"`).join(" | ");
  return {
    kind: "text",
    origin: "composer",
    text: `A meme you prepared after your last message: ${template?.name ?? meme.template} (${meme.template}), ${lines}. It goes as the picture of your next message when you name this piece in used_material and it still fits what that message says; otherwise leave it out.`,
    meme,
    answersMessageId: null,
    checked: false,
    replyTo: replyTo ?? null,
  };
}

/**
 * A send decision that names a prepared meme's piece and has no meme of its own carries that meme (the first such piece it uses), so the outbox screens and
 * draws it like any composed meme. Nothing changes for any other decision, where memes are off, or for a prepared meme that no longer fits its template.
 */
export function withPreparedMeme<D extends ComposeDecision>(decision: D, used: readonly { meme?: ComposeMeme | null }[], memesOn: boolean): D {
  if (decision.action !== "send" || decision.meme || !memesOn) return decision;
  const prepared = used.find((row) => row.meme && memeFits(row.meme))?.meme;
  return prepared ? { ...decision, meme: { template: prepared.template, lines: [...prepared.lines] } } : decision;
}

/** How long a sent meme waits for the person's first message before its note says they wrote nothing after it. */
export const MEME_QUIET_MS = 24 * 3_600_000;
const MEME_REPLY_CHARS = 160;

/** The meme memory's own agent.db table: one row per sent meme, so a note is written when it went and rewritten once when they answered or stayed quiet. */
export function migrateMemeMemory(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS composer_meme_memory (
    moment_id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL, channel TEXT NOT NULL, conversation_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL, seen_seq INTEGER NOT NULL, template TEXT NOT NULL, lines_json TEXT NOT NULL, state TEXT NOT NULL)`);
  db.exec("CREATE INDEX IF NOT EXISTS composer_meme_memory_waiting_idx ON composer_meme_memory (brand_id, channel, conversation_id, state)");
}

export interface MemeMemoryDeps {
  database: Database.Database;
  /** A moment's frozen decision (Outbox.frozen). */
  frozen(momentId: string): Pick<FrozenMoment, "decision" | "createdAt"> | null;
  /** The composer's notebook (OutboxStore's accessors). */
  notes: {
    notes(key: ConversationKey, limit?: number): { id: string; at: number; kind: ComposerNoteKind }[];
    addNotes(key: ConversationKey, notes: { kind: ComposerNoteKind; text: string }[], now: number): void;
    retireNotes(key: ConversationKey, ids: readonly string[]): void;
  };
  /** The conversation's stored messages, newest first (the agent store's recentMessages). */
  recentMessages(key: ConversationKey, limit?: number): StoredMessage[];
  /** The member's time zone (UTC when unknown). */
  zoneOf?: (key: ConversationKey, memberId: string | null) => string | null;
  logger: Logger;
}

type AfterMoment = { key: ConversationKey; momentId: string; memberId: string | null; outcome: string; at: number };
type MemeRow = { moment_id: string; sent_at: number; seen_seq: number; template: string; lines_json: string };

/**
 * What the composer learns from its memes (Omer R15.3): a `meme` note in its notebook when one went, with the template, its words and the time, rewritten
 * once with the first thing the person wrote after it (or that they wrote nothing for a day). Only direct chats: in a group, whoever writes next is not
 * the one the meme was for. Driven by the outbox's `afterMoment`; every failure is logged and changes nothing of the moment.
 */
export class MemeMemory {
  constructor(private readonly deps: MemeMemoryDeps) {
    migrateMemeMemory(deps.database);
  }

  after(event: AfterMoment): void {
    if (event.key.conversationId.endsWith("@g.us")) return;
    try {
      this.resolve(event);
      if (event.outcome === "sent") this.record(event);
    } catch (error) {
      this.deps.logger.warn("outbox.meme_memory_failed", { brandId: event.key.brandId, momentId: event.momentId, ...failureFields(error) });
    }
  }

  private record(event: AfterMoment): void {
    const frozen = this.deps.frozen(event.momentId);
    const decision = frozen?.decision;
    if (!decision || decision.action === "fallback" || !(decision as ComposeDecision).meme) return;
    const meme = (decision as ComposeDecision).meme!;
    const sentAt = frozen!.createdAt;
    // "After the meme" is by the store's own message order, not by clocks: the message that drew the meme can carry a later receive time than the moment.
    const seenSeq = Math.max(0, ...this.deps.recentMessages(event.key, 60).map((message) => message.seq));
    const inserted = this.deps.database.prepare(`INSERT OR IGNORE INTO composer_meme_memory (moment_id, brand_id, channel, conversation_id, sent_at, seen_seq, template, lines_json, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')`).run(event.momentId, event.key.brandId, event.key.channel, event.key.conversationId, sentAt, seenSeq, meme.template, JSON.stringify(meme.lines));
    if (inserted.changes === 0) return;
    this.deps.notes.addNotes(event.key, [{ kind: "meme", text: `${this.sentLine(event.key, meme.template, meme.lines, sentAt, event.memberId)} No reply yet.` }], sentAt);
  }

  /** Each waiting meme of this chat: their first message after it rewrites its note; a day of silence does too. */
  private resolve(event: AfterMoment): void {
    const waiting = this.deps.database.prepare(`SELECT moment_id, sent_at, seen_seq, template, lines_json FROM composer_meme_memory WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND state = 'waiting' ORDER BY sent_at`)
      .all(event.key.brandId, event.key.channel, event.key.conversationId) as MemeRow[];
    if (waiting.length === 0) return;
    const theirs = this.deps.recentMessages(event.key, 60).filter((message) => !isSystemPhone(message.fromPhone)).sort((a, b) => a.seq - b.seq);
    for (const row of waiting) {
      const reply = theirs.find((message) => message.seq > row.seen_seq);
      if (!reply && event.at - row.sent_at < MEME_QUIET_MS) continue;
      const lines = JSON.parse(row.lines_json) as string[];
      const head = this.sentLine(event.key, row.template, lines, row.sent_at, event.memberId);
      const text = reply ? `${head} They wrote ${minutes(Date.parse(reply.receivedAt) - row.sent_at)} later: "${quoted(reply)}"` : `${head} They wrote nothing for a day after it.`;
      // The waiting note is replaced only while it is still live: a note the composer retired on purpose stays retired.
      const live = this.deps.notes.notes(event.key, 60).filter((note) => note.kind === "meme" && note.at === row.sent_at).map((note) => note.id);
      const claimed = this.deps.database.prepare("UPDATE composer_meme_memory SET state = ? WHERE moment_id = ? AND state = 'waiting'").run(reply ? "answered" : "quiet", row.moment_id);
      if (claimed.changes === 0 || live.length === 0) continue;
      this.deps.notes.retireNotes(event.key, live);
      this.deps.notes.addNotes(event.key, [{ kind: "meme", text }], row.sent_at);
    }
  }

  private sentLine(key: ConversationKey, template: string, lines: readonly string[], at: number, memberId: string | null): string {
    return `Sent a ${template} meme (${lines.map((line) => `"${inert(line).slice(0, 90)}"`).join(" / ")}) with my message on ${when(at, this.deps.zoneOf?.(key, memberId) ?? null)}.`;
  }
}

function when(at: number, zone: string | null): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  try { return format(zone ?? "UTC"); } catch { return `${format("UTC")} UTC`; }
}

function minutes(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
  const total = Math.round(ms / 60_000);
  if (total < 90) return `${total} min`;
  const hours = Math.round(total / 60);
  return hours < 36 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

/** Their words as data for the notebook (PI01): angle brackets and line separators made inert, whitespace collapsed, cut short. */
function quoted(message: StoredMessage): string {
  const words = (message.text ?? "").split(/\s+/).join(" ").trim();
  if (!words) return message.attachments.length || message.mediaJson ? "(a picture, sticker or other media, no words)" : "(no words)";
  const clean = inert(words).replace(/"/g, "'");
  return clean.length > MEME_REPLY_CHARS ? `${clean.slice(0, MEME_REPLY_CHARS - 1)}…` : clean;
}
