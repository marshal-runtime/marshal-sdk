import type { BackgroundTaskSummary, SessionCronSummary } from "@anthropic-ai/claude-agent-sdk";

import type { BackgroundWorkWakeup } from "../../common/background-work";
import type { RuntimeSessionEventDataMap } from "../../common/runtime-events";
import { backgroundTaskKind } from "./events";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LOOKAHEAD_YEARS = 5;
/** A one-shot whose fire minute passed less than this long ago is overdue, not scheduled for next year. */
const OVERDUE_ONE_SHOT_WINDOW_MS = DAY_MS;

interface CronField {
  star: boolean;
  values: Set<number>;
}

function parseCronField(
  source: string,
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
): CronField | undefined {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [range = "", stepSource] = part.split("/");
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let low: number;
    let high: number;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [lowSource = "", highSource = ""] = range.split("-");
      low = Number(lowSource);
      high = Number(highSource);
    } else {
      low = Number(range);
      high = stepSource === undefined ? low : max;
    }
    if (
      !Number.isInteger(low) ||
      !Number.isInteger(high) ||
      low < min ||
      high > max ||
      low > high
    ) {
      return undefined;
    }
    for (let value = low; value <= high; value += step) values.add(normalize(value));
  }
  return { star: source.startsWith("*"), values };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCron(schedule: string): ParsedCron | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minute = parseCronField(fields[0] ?? "", 0, 59);
  const hour = parseCronField(fields[1] ?? "", 0, 23);
  const dayOfMonth = parseCronField(fields[2] ?? "", 1, 31);
  const month = parseCronField(fields[3] ?? "", 1, 12);
  const dayOfWeek = parseCronField(fields[4] ?? "", 0, 7, (value) => value % 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return undefined;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  const domMatches = cron.dayOfMonth.values.has(date.getDate());
  const dowMatches = cron.dayOfWeek.values.has(date.getDay());
  return cron.dayOfMonth.star || cron.dayOfWeek.star
    ? domMatches && dowMatches
    : domMatches || dowMatches;
}

/**
 * Next local-time fire of a standard 5-field cron expression strictly after
 * `from`. Returns undefined for an expression this parser does not understand
 * or that never fires, so a malformed schedule shows a wakeup without a time
 * instead of a wrong one.
 */
export function nextCronFireAt(schedule: string, from: number): number | undefined {
  const cron = parseCron(schedule);
  if (!cron) return undefined;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + MINUTE_MS);
  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + LOOKAHEAD_YEARS);

  const advanceTo = (next: Date): void => {
    cursor.setTime(
      next.getTime() > cursor.getTime() ? next.getTime() : cursor.getTime() + MINUTE_MS,
    );
  };
  while (cursor.getTime() <= limit.getTime()) {
    if (!cron.month.values.has(cursor.getMonth() + 1)) {
      advanceTo(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
    } else if (!dayMatches(cron, cursor)) {
      advanceTo(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1));
    } else if (!cron.hour.values.has(cursor.getHours())) {
      advanceTo(
        new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), cursor.getHours() + 1),
      );
    } else if (!cron.minute.values.has(cursor.getMinutes())) {
      cursor.setTime(cursor.getTime() + MINUTE_MS);
    } else {
      return cursor.getTime();
    }
  }
  return undefined;
}

/**
 * Fire time of a one-shot cron, which encodes a single minute. A minute that
 * passed within the last day is overdue and is reported as that past time
 * (due now) instead of rolling over to the same date next year.
 */
function oneShotFireAt(schedule: string, now: number): number | undefined {
  const fields = schedule.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month] = fields.slice(0, 4).map((field) => Number(field));
  if (
    fields.length === 5 &&
    [minute, hour, dayOfMonth, month].every((value) => Number.isInteger(value))
  ) {
    const thisYear = new Date(now).getFullYear();
    const candidate = new Date(thisYear, (month ?? 1) - 1, dayOfMonth, hour, minute).getTime();
    if (candidate <= now && now - candidate < OVERDUE_ONE_SHOT_WINDOW_MS) return candidate;
  }
  return nextCronFireAt(schedule, now);
}

export function wakeupsFromSessionCrons(
  crons: readonly SessionCronSummary[],
  now: number,
): BackgroundWorkWakeup[] {
  return crons.map((cron) => {
    const nextFireAt = cron.recurring
      ? nextCronFireAt(cron.schedule, now)
      : oneShotFireAt(cron.schedule, now);
    return {
      id: cron.id,
      recurring: cron.recurring,
      ...(nextFireAt !== undefined ? { nextFireAt } : {}),
      ...(cron.prompt ? { prompt: cron.prompt } : {}),
    };
  });
}

export function tasksFromStopHook(
  tasks: readonly BackgroundTaskSummary[],
): NonNullable<RuntimeSessionEventDataMap["session.background_work"]["tasks"]> {
  return tasks.map((task) => ({
    id: task.id,
    kind: backgroundTaskKind(task.type, task.agent_type),
    description: task.description || task.command || "",
  }));
}
