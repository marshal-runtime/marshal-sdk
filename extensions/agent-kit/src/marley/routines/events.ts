import { catalogRoutine, systemRoutine } from "@zygstinct/routines-public";

import type { Logger } from "../logger.js";

/**
 * The routine funnel for the Mega Dashboard (packages/analytics catalog, MLY-406): every routine, whatever starts it, logs the same four
 * lines. `routine.triggered` when a run starts, `routine.finished` with its status, then per recipient `routine.sent` or `routine.not_sent`.
 * Observation only: a line never decides or changes a run or a send. Fields are ids, closed words and counts, never text or figures.
 */
export type RoutineKind = "system" | "watch" | "custom" | "reminder" | "graph" | "free_time" | "alert";
export type RoutineFinish = "success" | "failed" | "not_ready" | "skipped";
/** Who sent it: the proactive engine (server-written message) or the routine's own turn reply. */
export type RoutineSender = "engine" | "reply";
/** direct: inside the 24-hour window; after_template: the owner said yes to the WhatsApp template offer and then got it. */
export type RoutineSendMode = "direct" | "after_template";

export const STORE_WATCH_ROUTINE = "store-watch";

/** What a schedule fire belongs to: a built-in routine, the hourly watch, a graph routine, a server-made one-off, or a person's routine or reminder. */
export function routineKindOf(input: { routineId: string; graphTracked?: boolean; schedule?: { kind: "cron" | "at"; prompt: string } | null; markers?: { alert?: string } }): RoutineKind {
  if (input.routineId === STORE_WATCH_ROUTINE) return "watch";
  if (systemRoutine(input.routineId) || catalogRoutine(input.routineId)) return "system";
  if (input.graphTracked) return "graph";
  const prompt = input.schedule?.prompt ?? "";
  if (input.markers?.alert && prompt.startsWith(input.markers.alert)) return "alert";
  if (prompt.startsWith("zs.")) return "system";
  return input.schedule?.kind === "at" ? "reminder" : "custom";
}

interface Base {
  brandId: string;
  routineId: string;
  kind: RoutineKind;
  /** One run: the turn of a scheduled fire, the watch's run, the engine's slot. Triggered and finished of a run share it. */
  runId: string;
}

type Run = Base & { memberId: string | null };

/** Turns kept waiting for their reply's delivery; older ones are dropped (a turn that sent nothing never comes back). */
const AWAITING_MAX = 2000;

export class RoutineEvents {
  private readonly awaiting = new Map<string, Run[]>();

  constructor(private readonly logger: Logger) {}

  /** A scheduled turn whose reply the router may deliver: its runs are reported sent at its first recorded delivery (`delivered`). */
  awaitDelivery(turnId: string, run: Run): void {
    const runs = this.awaiting.get(turnId) ?? [];
    if (!runs.some((existing) => existing.runId === run.runId)) runs.push(run);
    this.awaiting.delete(turnId);
    this.awaiting.set(turnId, runs);
    while (this.awaiting.size > AWAITING_MAX) this.awaiting.delete(this.awaiting.keys().next().value!);
  }

  /** The router recorded a send of this turn (router `onDelivered`): each scheduled run of the turn is sent once, by its reply. */
  delivered(turnId: string): void {
    const runs = this.awaiting.get(turnId);
    if (!runs) return;
    this.awaiting.delete(turnId);
    for (const run of runs) this.sent({ ...run, sentBy: "reply", mode: "direct", occurrenceId: run.runId });
  }

  /** The turn ended without a delivery: it is not waited for any longer. */
  settled(turnId: string): void {
    this.awaiting.delete(turnId);
  }

  triggered(input: Base & { scheduleId?: string | null; memberId?: string | null }): void {
    this.logger.info("routine.triggered", { brandId: input.brandId, routineId: input.routineId, routineKind: input.kind, runId: input.runId,
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}), ...(input.memberId ? { memberId: input.memberId } : {}) });
  }

  finished(input: Base & { status: RoutineFinish; code?: string | null; durationMs?: number | null; memberId?: string | null; counts?: { critical: number; warn: number; info: number } }): void {
    const reason = input.code ?? null;
    this.logger.info("routine.finished", { brandId: input.brandId, routineId: input.routineId, routineKind: input.kind, runId: input.runId, status: input.status,
      ...(reason ? { reason } : {}), ...(input.durationMs !== undefined && input.durationMs !== null ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
      ...(input.memberId ? { memberId: input.memberId } : {}),
      ...(input.counts ? { critical: input.counts.critical, warn: input.counts.warn, info: input.counts.info, findings: input.counts.critical + input.counts.warn } : {}) });
  }

  /** The routine's result reached one person (a send the server or the router recorded). `occurrenceId` is the delivery's own id (the engine's slot, the turn). */
  sent(input: Base & { memberId: string | null; sentBy: RoutineSender; mode: RoutineSendMode; occurrenceId: string }): void {
    this.logger.info("routine.sent", { brandId: input.brandId, routineId: input.routineId, routineKind: input.kind, runId: input.runId,
      ...(input.memberId ? { memberId: input.memberId } : {}), sentBy: input.sentBy, sendMode: input.mode, occurrenceId: input.occurrenceId });
  }

  /** A run or slot that ended without reaching the person, with why: a closed code the detecting site sets (the forwarder keeps `[a-z0-9_.:-]`, 64 at most). */
  notSent(input: Base & { memberId: string | null; sentBy: RoutineSender; code: string; occurrenceId: string }): void {
    this.logger.info("routine.not_sent", { brandId: input.brandId, routineId: input.routineId, routineKind: input.kind, runId: input.runId,
      ...(input.memberId ? { memberId: input.memberId } : {}), sentBy: input.sentBy, reason: input.code, occurrenceId: input.occurrenceId });
  }
}
