import { type Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import type { ConversationKey, Store } from "../../store.js";
import { nextFire, parseCron } from "./cron.js";
import { scheduleText, storeSystemMessage } from "./deliver.js";
import type { FireOutcome, ScheduleRepo } from "./repo.js";
import { SCHEDULE_ORIGIN, targetKey, type ScheduleConfig, type ScheduleRecord } from "./types.js";
import { describeInstant } from "./zone.js";

/** A wake-up is told its reply window is open only with this much left, so the turn's own running time cannot close it. */
export const REPLY_WINDOW_MARGIN_MS = 30 * 60_000;

export interface SchedulerDeps {
  repo: ScheduleRepo;
  store: Store;
  config: ScheduleConfig;
  logger: Logger;
  /** Starts a turn for a conversation that holds a new pending message. */
  wake(key: ConversationKey): void;
  /** Called after a fire started a turn, so subscriptions to schedule.fired can run. */
  onFired?(schedule: ScheduleRecord, scheduledFor: number, firedAt: number): void;
  now?: () => number;
  prompt?(schedule: ScheduleRecord, scheduledFor: number): string;
  /** A held brand fires nothing (brand-holds.ts). */
  brandHeld?(brandId: string): boolean;
  /** The held brands, left out of the due query so they cannot fill its limit. */
  heldBrands?(): string[];
  /** Moves a cron slot to the moment the job really fires (owner reports wait for the shop's period to close). Never earlier than `instant`. */
  /** Milliseconds of [from, to] the brand was held: left out of the lateness a fire logs. */
  holdOverlapMs?(brandId: string, from: number, to: number): number;
  /**
   * The routine graph's say over a due slot (routines/graph-core.ts), asked inside the fire's transaction: fire it (optionally with the server's `<upstream_state>` block),
   * or hold it (an `&& schedule` trigger whose other conditions are not true yet: recorded as `held`, the schedule moves on, the engine may fire it later).
   */
  gate?(schedule: ScheduleRecord, scheduledFor: number, now: number): { fire: true; upstreamState?: string } | { fire: false };
  /** The nudge store's say over an `origin = 'operator'` schedule, asked just before its fire: false when the nudge was cancelled or is not applied. "pending" leaves the schedule due for the next tick (the nudge is still being applied). Unset, such a schedule never fires. */
  operatorNudgeApplied?(schedule: ScheduleRecord): Promise<boolean | "pending">;
  /** Late-bound (the proactive engine is built after the schedules): a due WhatsApp DM schedule whose window is closed is handed to it instead of running a turn nobody could receive. */
  followUp?(): FollowUpHandoff | null;
  /** True for a one-off reminder set in a conversation (not a routine, free time, an alert or any other server-owned wakeup): its fire says when it was set and how to open (MLY-671). */
  reminder?(schedule: ScheduleRecord): boolean;
}

/** What the engine said about a handed-off fire: `retry` keeps the slot due, every other answer ends the fire. */
export type FollowUpVerdict = "queued" | "duplicate" | "skipped" | "retry";

export interface FollowUpHandoff {
  /** True for a kind of schedule whose closed-window fire belongs to the follow-up template (a chat reminder or an operator nudge), false for a system-owned one (free time, onboarding, a routine's own). */
  covers(schedule: ScheduleRecord): boolean;
  /** True when `covers` and the engine can take the fire right now (switched on, not draining, brand admitted). */
  eligible(schedule: ScheduleRecord): boolean;
  /** Queues the follow-up for exactly the schedule's member. Idempotent per slot through `episodeId`. */
  offer(input: { schedule: ScheduleRecord; scheduledFor: number; memberId: string; prompt: string }): Promise<FollowUpVerdict>;
}

/** A handoff that throws is tried again after this long, doubling per failure up to the cap: the slot stays due, so the reminder is never dropped, and a damaged slot raises one ERROR, not one per tick. */
export const HANDOFF_RETRY_BASE_MS = 30_000;
export const HANDOFF_RETRY_MAX_MS = 15 * 60_000;

export interface TickResult {
  fired: number;
}

/**
 * Finds due schedules and starts a turn for each by writing a system message into the target conversation. The fire is
 * recorded in the same transaction as the message, so a restart never fires a slot twice. A missed slot runs once,
 * however late (the fire logs `lateSeconds`). A recurring schedule then moves to its next slot after now, so several missed
 * slots in a row cost one run.
 */
export class Scheduler {
  private ticking = false;
  private readonly handingOff = new Set<string>();
  private readonly handoffFailures = new Map<string, { failures: number; retryAt: number }>();
  private readonly handoffRuns = new Set<Promise<void>>();

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * What the reply gate will say about this wake-up's reply, decided by the server when it fires: "open" only when the owner wrote
   * recently enough that the window stays open for REPLY_WINDOW_MARGIN_MS more, so a turn that runs a while still gets through.
   * A job that keeps state about what it told the owner commits it only on "open".
   */
  private replyWindow(job: ScheduleRecord, now: number): "open" | "closed" {
    if (job.target.channel !== "whatsapp") return "open";
    const last = this.deps.repo.lastHumanMessageAt(job.brandId, job.target.channel, job.target.conversationId);
    return last !== null && last <= now && now - last <= this.deps.config.replyWindowMs - REPLY_WINDOW_MARGIN_MS ? "open" : "closed";
  }

  private readonly overdueReported = new Set<string>();

  /** A due slot that a hold keeps from firing past the grace: one `schedule.overdue` line per slot, for the watchdog. */
  private reportOverdue(job: ScheduleRecord, now: number): void {
    if (job.nextRunAt === null) return;
    const lagMs = now - job.nextRunAt;
    const slot = `${job.id}:${job.nextRunAt}`;
    if (lagMs <= this.deps.config.lateMs || this.overdueReported.has(slot)) return;
    if (this.overdueReported.size >= 1000) this.overdueReported.clear();
    this.overdueReported.add(slot);
    this.deps.logger.warn("schedule.overdue", { brandId: job.brandId, scheduleId: job.id, dueAt: new Date(job.nextRunAt).toISOString(), lagMs, reason: "brand_held" });
  }

  /** One pass over everything due. Safe to call at any time; overlapping calls are ignored. */
  tick(): TickResult {
    const result: TickResult = { fired: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      const now = this.now();
      const handoff = this.deps.followUp?.() ?? null;
      for (const job of this.deps.repo.dueSchedules(now, 100, this.deps.heldBrands?.() ?? [])) this.visit(job, handoff, now, result);
      // The due query leaves held brands out, so a hold that outlasts the grace is looked up on its own.
      const held = this.deps.heldBrands?.() ?? [];
      if (held.length > 0) for (const job of this.deps.repo.dueSchedules(now - this.deps.config.lateMs, 100, [], held)) this.reportOverdue(job, now);
    } finally {
      this.ticking = false;
    }
    return result;
  }

  /** What one pass decides for a due job: a held brand keeps its slot, an operator schedule is checked against its nudge, a closed window hands off, anything else fires. */
  private visit(job: ScheduleRecord, handoff: FollowUpHandoff | null, now: number, result: TickResult): void {
    // A held brand keeps its due slot: nothing fires, nothing advances, and the hold time is not counted as lateness (see fire).
    if (this.deps.brandHeld?.(job.brandId)) return;
    // An operator schedule is checked against its nudge first; only then may a closed window hand it to the follow-up template.
    if (job.origin === "operator") { this.fireOperator(job, handoff); return; }
    if (handoff && this.closedWindowDm(job, handoff, now)) { this.startHandoff(job, handoff, now); return; }
    if (handoff && this.closedWindowPersonDm(job, now) && handoff.covers(job)) this.deps.logger.warn("schedule.handoff_unavailable", { brandId: job.brandId, scheduleId: job.id, conversation: job.target.conversationId, note: "the follow-up template is not available, so the fire runs as a turn and its reply is held" });
    try {
      const outcome = this.fire(job, now);
      if (outcome === "held") this.deps.logger.info("schedule.held", { brandId: job.brandId, scheduleId: job.id });
      if (outcome === "started") result.fired += 1;
    } catch (error) {
      this.deps.logger.error("schedule.fire_failed", { brandId: job.brandId, scheduleId: job.id, ...failureFields(error) });
    }
  }

  /**
   * The SDK clock's fire of one schedule (its automation came due): the same decisions the periodic pass made for a due job. The record stays the authority on the
   * slot, so a clock that fires early, twice or after the graph held the slot does nothing the record does not already say is due.
   */
  fireDue(brandId: string, scheduleId: string): { fired: number } {
    const result: TickResult = { fired: 0 };
    const now = this.now();
    const job = this.deps.repo.getSchedule(brandId, scheduleId);
    if (!job || job.status !== "active" || job.nextRunAt === null || job.nextRunAt > now) return result;
    this.visit(job, this.deps.followUp?.() ?? null, now, result);
    return result;
  }

  private readonly operatorChecking = new Set<string>();

  /** An operator schedule fires only after the nudge behind it is reread as still applied; the check is async, so the next tick finds the job still due until it answers. */
  private fireOperator(job: ScheduleRecord, handoff: FollowUpHandoff | null): void {
    const { logger } = this.deps;
    const check = this.deps.operatorNudgeApplied;
    if (!check || !job.nudgeId) { logger.warn("schedule.operator_skipped", { brandId: job.brandId, scheduleId: job.id, reason: check ? "no_nudge" : "no_nudge_check" }); return; }
    if (this.operatorChecking.has(job.id)) return;
    this.operatorChecking.add(job.id);
    void check(job).then(
      (applied) => {
        if (applied === "pending") return;
        if (!applied) {
          this.deps.repo.deleteSchedule(job.brandId, job.id);
          logger.info("schedule.operator_skipped", { brandId: job.brandId, scheduleId: job.id, nudgeId: job.nudgeId, reason: "nudge_not_applied" });
          return;
        }
        const now = this.now();
        if (handoff && this.closedWindowDm(job, handoff, now)) { this.startHandoff(job, handoff, now); return; }
        if (handoff && this.closedWindowPersonDm(job, now) && handoff.covers(job)) logger.warn("schedule.handoff_unavailable", { brandId: job.brandId, scheduleId: job.id, conversation: job.target.conversationId, note: "the follow-up engine cannot take this closed-window fire; the turn runs and its reply is held" });
        try { this.fire(job, now); } catch (error) { logger.error("schedule.fire_failed", { brandId: job.brandId, scheduleId: job.id, ...failureFields(error) }); }
      },
      (error) => logger.error("schedule.operator_check_failed", { brandId: job.brandId, scheduleId: job.id, ...failureFields(error) }),
    ).finally(() => this.operatorChecking.delete(job.id));
  }

  /** A due fire of a person's WhatsApp DM whose 24-hour window is closed: the reply of its turn would be held for good, so the turn does not run. */
  private closedWindowDm(job: ScheduleRecord, handoff: FollowUpHandoff, now: number): boolean {
    return this.closedWindowPersonDm(job, now) && handoff.eligible(job);
  }

  private closedWindowPersonDm(job: ScheduleRecord, now: number): boolean {
    return job.target.channel === "whatsapp" && job.target.kind === "dm" && job.createdByMember !== null && this.replyWindow(job, now) === "closed";
  }

  private startHandoff(job: ScheduleRecord, handoff: FollowUpHandoff, now: number): void {
    const scheduledFor = job.nextRunAt;
    if (scheduledFor === null) return;
    const slot = `${job.id}:${scheduledFor}`;
    if (this.handingOff.has(slot) || now < (this.handoffFailures.get(slot)?.retryAt ?? 0)) return;
    this.handingOff.add(slot);
    const run: Promise<void> = this.handOff(job, scheduledFor, handoff).then(() => { this.handoffFailures.delete(slot); }, (error) => {
      const failures = (this.handoffFailures.get(slot)?.failures ?? 0) + 1;
      const retryMs = Math.min(HANDOFF_RETRY_BASE_MS * 2 ** (failures - 1), HANDOFF_RETRY_MAX_MS);
      if (this.handoffFailures.size >= 1000) this.handoffFailures.clear();
      this.handoffFailures.set(slot, { failures, retryAt: this.now() + retryMs });
      const fields = { brandId: job.brandId, scheduleId: job.id, failures, retryInSeconds: retryMs / 1000, ...failureFields(error) };
      if (failures === 1) this.deps.logger.error("schedule.handoff_failed", fields);
      else this.deps.logger.warn("schedule.handoff_failed_again", fields);
    }).finally(() => { this.handingOff.delete(slot); this.handoffRuns.delete(run); });
    this.handoffRuns.add(run);
    void run;
  }

  /** Resolves when every handoff started so far has ended (recorded or scheduled for a retry). For a simulator or test that must see its outcome. */
  async whenIdle(): Promise<void> {
    while (this.handoffRuns.size > 0) await Promise.allSettled([...this.handoffRuns]);
  }

  /**
   * The slot stays due until the engine confirms the offer is queued (or decided it cannot be), so an unreadable directory is tried again at the next tick. The fire is then
   * recorded and the schedule advanced in one transaction, exactly like a started fire; a second handoff of the same slot is the same episode.
   */
  private async handOff(job: ScheduleRecord, scheduledFor: number, handoff: FollowUpHandoff): Promise<void> {
    const { logger } = this.deps;
    const verdict = await handoff.offer({ schedule: job, scheduledFor, memberId: job.createdByMember!, prompt: this.deps.prompt?.(job, scheduledFor) ?? job.prompt });
    const fields = { brandId: job.brandId, scheduleId: job.id, scheduledFor: new Date(scheduledFor).toISOString(), conversation: job.target.conversationId };
    if (verdict === "retry") { logger.warn("schedule.handoff_retry", fields); return; }
    this.endHandoff(job, scheduledFor, verdict);
  }

  /** Records the decision that ends a handed-off fire and advances the schedule, exactly like a started fire. */
  private endHandoff(job: ScheduleRecord, scheduledFor: number, verdict: "queued" | "duplicate" | "skipped"): void {
    const { repo, logger } = this.deps;
    const fields = { brandId: job.brandId, scheduleId: job.id, scheduledFor: new Date(scheduledFor).toISOString(), conversation: job.target.conversationId };
    const now = this.now();
    let next: number | null;
    try { next = this.nextRun(job, now); } catch { next = null; }
    const outcome: FireOutcome = verdict === "skipped" ? "handoff_skipped" : "handed_off";
    const done = repo.transaction(() => {
      const current = repo.getSchedule(job.brandId, job.id);
      if (!current || current.status !== "active" || current.nextRunAt !== scheduledFor) return false;
      if (!repo.recordFire(job.id, scheduledFor, now, outcome, null)) { repo.advanceSchedule(job.id, next, now, false); return false; }
      repo.advanceSchedule(job.id, next, now, verdict !== "skipped");
      return true;
    });
    if (done) logger.info(verdict === "skipped" ? "schedule.handoff_skipped" : "schedule.handed_off", { ...fields, verdict, next: next === null ? null : new Date(next).toISOString() });
  }

  private nextRun(job: ScheduleRecord, now: number): number | null {
    if (job.kind === "at" || !job.cron) return null;
    return nextFire(parseCron(job.cron), now, job.timezone);
  }

  /** When a one-off reminder was set, on its own clock; undefined for every other schedule (operator nudges keep their own framing). */
  private setAt(job: ScheduleRecord): string | undefined {
    return job.kind === "at" && job.origin === "member" && this.deps.reminder?.(job) === true ? describeInstant(job.createdAt, job.timezone) : undefined;
  }

  private fire(job: ScheduleRecord, now: number): "started" | "duplicate" | "stale" | "held" {
    const { repo, store, config, logger } = this.deps;
    const scheduledFor = job.nextRunAt;
    if (scheduledFor === null) return "stale";
    const late = now - scheduledFor - (this.deps.holdOverlapMs?.(job.brandId, scheduledFor, now) ?? 0);
    const messageId = `sched-${job.id}-${scheduledFor}`;
    let next: number | null;
    try {
      next = this.nextRun(job, now);
    } catch {
      next = null;
    }
    let upstreamState: string | undefined;
    const outcome = repo.transaction((): "started" | "duplicate" | "stale" | "held" => {
      const current = repo.getSchedule(job.brandId, job.id);
      if (!current || current.status !== "active" || current.nextRunAt !== scheduledFor) return "stale";
      if (this.deps.gate) {
        const verdict = this.deps.gate(job, scheduledFor, now);
        if (!verdict.fire) {
          if (!repo.recordFire(job.id, scheduledFor, now, "held", null)) { repo.advanceSchedule(job.id, next, now, false); return "duplicate"; }
          repo.advanceSchedule(job.id, next, now, false);
          return "held";
        }
        upstreamState = verdict.upstreamState;
      }
      if (!repo.recordFire(job.id, scheduledFor, now, "started", messageId)) {
        repo.advanceSchedule(job.id, next, now, false);
        return "duplicate";
      }
      storeSystemMessage(store, {
        id: messageId,
        brandId: job.brandId,
        target: job.target,
        origin: SCHEDULE_ORIGIN,
        memberId: job.createdByMember,
        text: scheduleText({ id: job.id, due: describeInstant(scheduledFor, job.timezone), prompt: this.deps.prompt?.(job, scheduledFor) ?? job.prompt, replyWindow: this.replyWindow(job, now), upstreamState, operator: job.origin === "operator", setAt: this.setAt(job) }),
        now,
      });
      repo.advanceSchedule(job.id, next, now, true);
      return "started";
    });
    if (outcome === "started") {
      logger.info("schedule.fired", { brandId: job.brandId, scheduleId: job.id, scheduledFor: new Date(scheduledFor).toISOString(), lateSeconds: Math.round(late / 1000), conversation: job.target.conversationId, next: next === null ? null : new Date(next).toISOString() });
      this.deps.wake(targetKey(job.brandId, job.target));
      this.deps.onFired?.(job, scheduledFor, now);
    }
    return outcome;
  }

  /**
   * Fires a schedule's wake-up now, outside its cron slot (the routine graph's upstream trigger or a released `&& schedule` hold). It is the same message, prompt, run log and
   * reply gate as a cron fire; the slot is the instant, so it can never collide with a cron slot, and the schedule's next run is left alone. Null when the schedule is gone, paused or held.
   */
  fireNow(job: ScheduleRecord, upstreamState?: string): number | null {
    const { repo, store } = this.deps;
    const now = this.now();
    const refuse = (reason: string): null => { this.deps.logger.warn("schedule.fire_refused", { brandId: job.brandId, scheduleId: job.id, reason, via: "graph" }); return null; };
    if (this.deps.brandHeld?.(job.brandId)) return refuse("brand_held");
    const messageId = `sched-${job.id}-${now}`;
    let why = "";
    const started = repo.transaction(() => {
      const current = repo.getSchedule(job.brandId, job.id);
      if (!current) { why = "schedule_gone"; return false; }
      if (current.status !== "active") { why = `schedule_${current.status}`; return false; }
      if (!repo.recordFire(job.id, now, now, "started", messageId)) { why = "slot_taken"; return false; }
      return storeSystemMessage(store, {
        id: messageId, brandId: job.brandId, target: job.target, origin: SCHEDULE_ORIGIN, memberId: job.createdByMember,
        text: scheduleText({ id: job.id, due: describeInstant(now, job.timezone), prompt: this.deps.prompt?.(job, now) ?? job.prompt, replyWindow: this.replyWindow(job, now), upstreamState, setAt: this.setAt(job) }), now,
      });
    });
    if (!started) return refuse(why || "not_started");
    this.deps.logger.info("schedule.fired", { brandId: job.brandId, scheduleId: job.id, scheduledFor: new Date(now).toISOString(), lateSeconds: 0, conversation: job.target.conversationId, next: null, via: "graph" });
    this.deps.wake(targetKey(job.brandId, job.target));
    this.deps.onFired?.(job, now, now);
    return now;
  }
}
