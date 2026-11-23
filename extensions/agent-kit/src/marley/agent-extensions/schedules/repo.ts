import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";
import type { Channel, ConversationKind } from "@zygstinct/shared";

import type { EventFilter, EventName, ScheduleRecord, SubscriptionRecord, Target } from "./types.js";

interface ScheduleRow {
  id: string;
  brand_id: string;
  kind: "cron" | "at";
  cron: string | null;
  at_ms: number | null;
  timezone: string;
  prompt: string;
  channel: Channel;
  conversation_id: string;
  conversation_kind: ConversationKind;
  conversation_title: string | null;
  created_by_member: string | null;
  created_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  fire_count: number;
  status: ScheduleRecord["status"];
  chain_generation: number;
  origin: ScheduleRecord["origin"] | null;
  nudge_id: string | null;
}

interface SubscriptionRow {
  id: string;
  brand_id: string;
  event: EventName;
  prompt: string;
  filter_json: string;
  channel: Channel;
  conversation_id: string;
  conversation_kind: ConversationKind;
  conversation_title: string | null;
  created_by_member: string | null;
  created_at: number;
  fire_count: number;
  status: SubscriptionRecord["status"];
  chain_generation: number;
  once: number | null;
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

const targetOf = (row: { channel: Channel; conversation_id: string; conversation_kind: ConversationKind; conversation_title: string | null }): Target => ({
  channel: row.channel,
  conversationId: row.conversation_id,
  kind: row.conversation_kind,
  title: row.conversation_title,
});

const toSchedule = (row: ScheduleRow): ScheduleRecord => ({
  id: row.id,
  brandId: row.brand_id,
  kind: row.kind,
  cron: row.cron,
  atMs: row.at_ms,
  timezone: row.timezone,
  prompt: row.prompt,
  target: targetOf(row),
  createdByMember: row.created_by_member,
  createdAt: row.created_at,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  fireCount: row.fire_count,
  status: row.status,
  chainGeneration: row.chain_generation ?? 0,
  origin: row.origin === "operator" ? "operator" : "member",
  nudgeId: row.nudge_id ?? null,
});

const toSubscription = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  brandId: row.brand_id,
  event: row.event,
  prompt: row.prompt,
  filter: JSON.parse(row.filter_json) as EventFilter,
  target: targetOf(row),
  createdByMember: row.created_by_member,
  createdAt: row.created_at,
  fireCount: row.fire_count,
  status: row.status,
  chainGeneration: row.chain_generation ?? 0,
  once: row.once === 1,
});

export type NewSchedule = Omit<ScheduleRecord, "id" | "lastRunAt" | "fireCount" | "status" | "chainGeneration" | "origin" | "nudgeId"> & { chainGeneration?: number; origin?: ScheduleRecord["origin"]; nudgeId?: string | null };
export type NewSubscription = Omit<SubscriptionRecord, "id" | "fireCount" | "status" | "chainGeneration" | "once"> & { chainGeneration?: number; once?: boolean };

/** `handed_off`: the person's WhatsApp window was closed, so the turn did not run and a template opener was queued for them (MLY-619). `handoff_skipped`: that offer was refused by a guard (opt-out, not an active member). */
export type FireOutcome = "started" | "skipped_late" | "held" | "handed_off" | "handoff_skipped";

/** Queries on the schedules tables. Every read or write that a tool reaches takes the brand id and filters on it. */
export class ScheduleRepo {
  /** Told after a write that can change what the clock must fire (a schedule made, paused, moved, ended): the SDK automations follow it. */
  onChange: ((brandId: string, scheduleId: string) => void) | null = null;

  constructor(readonly db: Database.Database) {}

  private brandOf(id: string): string {
    return (this.db.prepare("SELECT brand_id FROM schedules WHERE id = ?").get(id) as { brand_id: string } | undefined)?.brand_id ?? "";
  }

  private changed(brandId: string, scheduleId: string): void {
    try { this.onChange?.(brandId, scheduleId); } catch { /* the clock follows on the next sync */ }
  }

  /** Told after a subscription is made or deleted: the SDK event triggers follow it. */
  onSubscriptionChange: ((brandId: string, subscriptionId: string) => void) | null = null;

  private subscriptionChanged(brandId: string, subscriptionId: string): void {
    try { this.onSubscriptionChange?.(brandId, subscriptionId); } catch { /* the triggers follow on the next sync */ }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  activeScheduleCount(brandId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE brand_id = ? AND status = 'active'").get(brandId) as { n: number }).n;
  }

  insertSchedule(input: NewSchedule): ScheduleRecord {
    const id = newId("sch");
    this.db
      .prepare(
        `INSERT INTO schedules (id, brand_id, kind, cron, at_ms, timezone, prompt, channel, conversation_id, conversation_kind,
           conversation_title, created_by_member, created_at, next_run_at, status, chain_generation, origin, nudge_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.brandId, input.kind, input.cron, input.atMs, input.timezone, input.prompt, input.target.channel, input.target.conversationId, input.target.kind, input.target.title, input.createdByMember, input.createdAt, input.nextRunAt, input.chainGeneration ?? 0, input.origin ?? "member", input.nudgeId ?? null);
    this.changed(input.brandId, id);
    return this.getSchedule(input.brandId, id)!;
  }

  getSchedule(brandId: string, id: string): ScheduleRecord | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE brand_id = ? AND id = ?").get(brandId, id) as ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  listSchedules(brandId: string): ScheduleRecord[] {
    const rows = this.db.prepare("SELECT * FROM schedules WHERE brand_id = ? AND status = 'active' ORDER BY next_run_at, created_at").all(brandId) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  /** Marks an active schedule deleted. False when the id is not an active schedule of this brand. */
  deleteSchedule(brandId: string, id: string): boolean {
    const done = this.db.prepare("UPDATE schedules SET status = 'deleted', next_run_at = NULL WHERE brand_id = ? AND id = ? AND status = 'active'").run(brandId, id).changes > 0;
    if (done) this.changed(brandId, id);
    return done;
  }

  /** Any recurring schedule of the brand that is not deleted (active or paused), for the Routines page. */
  listRecurring(brandId: string): ScheduleRecord[] {
    const rows = this.db.prepare("SELECT * FROM schedules WHERE brand_id = ? AND kind = 'cron' AND status IN ('active','paused') ORDER BY created_at").all(brandId) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  /** Turns a recurring schedule off (the scheduler picks only `active` rows) or on with its next slot. False when nothing changed. */
  setPaused(brandId: string, id: string, paused: boolean, nextRunAt: number | null): boolean {
    const done = paused
      ? this.db.prepare("UPDATE schedules SET status = 'paused', next_run_at = NULL WHERE brand_id = ? AND id = ? AND kind = 'cron' AND status = 'active'").run(brandId, id).changes > 0
      : this.db.prepare("UPDATE schedules SET status = 'active', next_run_at = ? WHERE brand_id = ? AND id = ? AND kind = 'cron' AND status = 'paused'").run(nextRunAt, brandId, id).changes > 0;
    if (done) this.changed(brandId, id);
    return done;
  }

  /** Changes a recurring schedule's cron and zone. An active one moves to `nextRunAt`; a paused one keeps no next slot. */
  updateCadence(brandId: string, id: string, cron: string, timezone: string, nextRunAt: number | null): boolean {
    const done = this.db.prepare("UPDATE schedules SET cron = ?, timezone = ?, next_run_at = CASE WHEN status = 'active' THEN ? ELSE NULL END WHERE brand_id = ? AND id = ? AND kind = 'cron' AND status IN ('active','paused')").run(cron, timezone, nextRunAt, brandId, id).changes > 0;
    if (done) this.changed(brandId, id);
    return done;
  }

  /** Deletes an active or paused schedule. */
  deleteAny(brandId: string, id: string): boolean {
    const done = this.db.prepare("UPDATE schedules SET status = 'deleted', next_run_at = NULL WHERE brand_id = ? AND id = ? AND status IN ('active','paused')").run(brandId, id).changes > 0;
    if (done) this.changed(brandId, id);
    return done;
  }

  /** The recorded fires of a schedule, newest first. */
  fires(jobId: string, limit: number): { scheduledFor: number; firedAt: number; outcome: string; messageId: string | null }[] {
    return (this.db.prepare("SELECT scheduled_for, fired_at, outcome, message_id FROM schedule_fires WHERE job_id = ? ORDER BY scheduled_for DESC LIMIT ?").all(jobId, limit) as { scheduled_for: number; fired_at: number; outcome: string; message_id: string | null }[])
      .map((row) => ({ scheduledFor: row.scheduled_for, firedAt: row.fired_at, outcome: row.outcome, messageId: row.message_id }));
  }

  /** Active schedules whose next run is at or before `nowMs`, across all brands, oldest first. */
  dueSchedules(nowMs: number, limit = 100, skipBrands: readonly string[] = [], onlyBrands: readonly string[] | null = null): ScheduleRecord[] {
    const skip = skipBrands.length ? ` AND brand_id NOT IN (${skipBrands.map(() => "?").join(",")})` : "";
    const only = onlyBrands ? ` AND brand_id IN (${onlyBrands.map(() => "?").join(",") || "NULL"})` : "";
    const rows = this.db.prepare(`SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?${skip}${only} ORDER BY next_run_at LIMIT ?`).all(nowMs, ...skipBrands, ...(onlyBrands ?? []), limit) as ScheduleRow[];
    return rows.map(toSchedule);
  }

  /** Records that a fire happened for a slot. False when the slot was already recorded (a second fire of the same slot). */
  recordFire(jobId: string, scheduledFor: number, firedAt: number, outcome: FireOutcome, messageId: string | null): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO schedule_fires (job_id, scheduled_for, fired_at, outcome, message_id) VALUES (?, ?, ?, ?, ?)").run(jobId, scheduledFor, firedAt, outcome, messageId).changes > 0;
  }

  /** Moves a schedule on after a fire: its next run (null finishes it), the time it last ran and the fire count. */
  advanceSchedule(id: string, nextRunAt: number | null, firedAt: number, counted: boolean): void {
    this.db
      .prepare("UPDATE schedules SET next_run_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END, fire_count = fire_count + ?, status = CASE WHEN ? IS NULL THEN 'done' ELSE status END WHERE id = ?")
      .run(nextRunAt, counted ? 1 : 0, firedAt, counted ? 1 : 0, nextRunAt, id);
    this.changed(this.brandOf(id), id);
  }

  fireOutcomes(jobId: string): { scheduledFor: number; outcome: string }[] {
    return (this.db.prepare("SELECT scheduled_for, outcome FROM schedule_fires WHERE job_id = ? ORDER BY scheduled_for").all(jobId) as { scheduled_for: number; outcome: string }[]).map((row) => ({ scheduledFor: row.scheduled_for, outcome: row.outcome }));
  }

  activeSubscriptionCount(brandId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE brand_id = ? AND status = 'active'").get(brandId) as { n: number }).n;
  }

  insertSubscription(input: NewSubscription): SubscriptionRecord {
    const id = newId("sub");
    this.db
      .prepare(
        `INSERT INTO event_subscriptions (id, brand_id, event, prompt, filter_json, channel, conversation_id, conversation_kind,
           conversation_title, created_by_member, created_at, status, chain_generation, once)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.brandId, input.event, input.prompt, JSON.stringify(input.filter), input.target.channel, input.target.conversationId, input.target.kind, input.target.title, input.createdByMember, input.createdAt, input.chainGeneration ?? 0, input.once === true ? 1 : 0);
    this.subscriptionChanged(input.brandId, id);
    return this.getSubscription(input.brandId, id)!;
  }

  getSubscription(brandId: string, id: string): SubscriptionRecord | null {
    const row = this.db.prepare("SELECT * FROM event_subscriptions WHERE brand_id = ? AND id = ?").get(brandId, id) as SubscriptionRow | undefined;
    return row ? toSubscription(row) : null;
  }

  listSubscriptions(brandId: string): SubscriptionRecord[] {
    const rows = this.db.prepare("SELECT * FROM event_subscriptions WHERE brand_id = ? AND status = 'active' ORDER BY created_at").all(brandId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  deleteSubscription(brandId: string, id: string): boolean {
    const done = this.db.prepare("UPDATE event_subscriptions SET status = 'deleted' WHERE brand_id = ? AND id = ? AND status = 'active'").run(brandId, id).changes > 0;
    if (done) this.subscriptionChanged(brandId, id);
    return done;
  }

  subscriptionsFor(brandId: string, event: EventName): SubscriptionRecord[] {
    const rows = this.db.prepare("SELECT * FROM event_subscriptions WHERE brand_id = ? AND event = ? AND status = 'active' ORDER BY created_at").all(brandId, event) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  /** Stores a received event. False when the same event id already arrived for this brand (a retry). */
  recordEvent(brandId: string, eventId: string, event: EventName, payload: unknown, receivedAt: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO events_received (brand_id, event_id, event, payload_json, received_at) VALUES (?, ?, ?, ?, ?)").run(brandId, eventId, event, JSON.stringify(payload), receivedAt).changes > 0;
  }

  markEventProcessed(brandId: string, eventId: string, matched: number, at: number): void {
    this.db.prepare("UPDATE events_received SET matched = ?, processed_at = ? WHERE brand_id = ? AND event_id = ?").run(matched, at, brandId, eventId);
  }

  /** Events received since `sinceMs` whose processing never finished (the server stopped in between). */
  unprocessedEvents(sinceMs: number): { brandId: string; eventId: string; event: EventName; payload: Record<string, unknown> }[] {
    const rows = this.db.prepare("SELECT brand_id, event_id, event, payload_json FROM events_received WHERE processed_at IS NULL AND received_at > ? ORDER BY received_at, rowid").all(sinceMs) as { brand_id: string; event_id: string; event: EventName; payload_json: string }[];
    return rows.map((row) => ({ brandId: row.brand_id, eventId: row.event_id, event: row.event, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
  }

  recordSubscriptionFire(subscriptionId: string, eventId: string, brandId: string, firedAt: number, messageId: string | null): boolean {
    const inserted = this.db.prepare("INSERT OR IGNORE INTO event_subscription_fires (subscription_id, event_id, brand_id, fired_at, message_id) VALUES (?, ?, ?, ?, ?)").run(subscriptionId, eventId, brandId, firedAt, messageId).changes > 0;
    if (inserted) this.db.prepare("UPDATE event_subscriptions SET fire_count = fire_count + 1 WHERE id = ?").run(subscriptionId);
    return inserted;
  }

  eventFiresSince(brandId: string, sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM event_subscription_fires WHERE brand_id = ? AND fired_at > ?").get(brandId, sinceMs) as { n: number }).n;
  }

  pruneEvents(olderThanMs: number): void {
    this.db.prepare("DELETE FROM events_received WHERE received_at < ?").run(olderThanMs);
    this.db.prepare("DELETE FROM event_subscription_fires WHERE fired_at < ?").run(olderThanMs);
  }

  addWithheldReply(turnId: string, brandId: string, channel: Channel, conversationId: string, text: string, reason: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO withheld_replies (turn_id, brand_id, channel, conversation_id, text, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(turnId, brandId, channel, conversationId, text, reason, now);
  }

  withheldReplies(brandId: string): { turnId: string; conversationId: string; text: string; reason: string }[] {
    return (this.db.prepare("SELECT turn_id, conversation_id, text, reason FROM withheld_replies WHERE brand_id = ? ORDER BY created_at").all(brandId) as { turn_id: string; conversation_id: string; text: string; reason: string }[]).map((row) => ({
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      text: row.text,
      reason: row.reason,
    }));
  }

  /** Time of the latest message a person wrote in the conversation; null when only system messages exist. */
  lastHumanMessageAt(brandId: string, channel: Channel, conversationId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(stored_at) AS at FROM messages WHERE brand_id = ? AND channel = ? AND conversation_id = ? AND from_phone NOT LIKE 'system:%'")
      .get(brandId, channel, conversationId) as { at: number | null };
    return row.at;
  }
}
