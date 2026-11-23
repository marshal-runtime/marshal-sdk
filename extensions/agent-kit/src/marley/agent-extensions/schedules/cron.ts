import { DAY_MS, HOUR_MS, instantOfNaive, naiveOf, wallOf, type Wall } from "./zone.js";

export class CronError extends Error {}

/** Cron may not fire more often than this. */
export const MIN_INTERVAL_MINUTES = 15;

export interface CronSpec {
  expression: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(raw: string, label: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> {
  const values = new Set<number>();
  const value = (token: string): number => {
    const lowered = token.toLowerCase();
    const named = names ? names.indexOf(lowered) : -1;
    if (named >= 0) return named + nameBase;
    if (!/^\d{1,2}$/.test(token)) throw new CronError(`${label}: "${token}" is not a number${names ? " or name" : ""}`);
    return Number(token);
  };
  for (const part of raw.split(",")) {
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "") throw new CronError(`${label}: bad part "${part}"`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) throw new CronError(`${label}: bad step "${stepRaw}"`);
      step = Number(stepRaw);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || a === undefined || b === undefined) throw new CronError(`${label}: bad range "${range}"`);
      from = value(a);
      to = value(b);
    } else {
      from = value(range);
      to = stepRaw === undefined ? from : max;
    }
    if (from < min || to > max || from > to) throw new CronError(`${label}: ${range} is outside ${min}-${max}`);
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

/** Parses a five-field cron expression (minute hour day-of-month month day-of-week). Throws CronError. */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim();
  if (trimmed.length > 120) throw new CronError("cron expression is too long");
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) throw new CronError("cron needs five fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, "minute", 0, 59);
  const hours = parseField(hour, "hour", 0, 23);
  const days = parseField(dom, "day-of-month", 1, 31);
  const months = parseField(month, "month", 1, 12, MONTHS, 1);
  const weekdays = new Set([...parseField(dow, "day-of-week", 0, 7, DAYS, 0)].map((d) => d % 7));
  const spec: CronSpec = {
    expression: trimmed,
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth: days,
    months: months,
    daysOfWeek: weekdays,
    domAny: dom === "*",
    dowAny: dow === "*",
  };
  const gap = smallestGapMinutes(spec);
  if (gap < MIN_INTERVAL_MINUTES) throw new CronError(`cron may not fire more often than every ${MIN_INTERVAL_MINUTES} minutes (this one can fire ${gap} minute${gap === 1 ? "" : "s"} apart)`);
  return spec;
}

export const CADENCE_CLASSES = ["intraday", "daily", "weekdays", "weekly", "monthly", "custom"] as const;
export type CadenceClass = (typeof CADENCE_CLASSES)[number];

/** A coarse, text-free name for how often a parsed cron fires, for analytics (the expression itself is not a token the dashboard can group by). */
export function cadenceClass(spec: CronSpec): CadenceClass {
  if (spec.months.size !== 12) return "custom";
  if (spec.hours.length * spec.minutes.length > 1) return "intraday";
  if (spec.domAny && spec.dowAny) return "daily";
  if (spec.domAny) return [1, 2, 3, 4, 5].every((day) => spec.daysOfWeek.has(day)) && spec.daysOfWeek.size === 5 ? "weekdays" : "weekly";
  if (spec.dowAny) return "monthly";
  return "custom";
}

/** The smallest gap between two fires within a day, around the clock (so a fire at 23:55 and one at 00:05 count as 10 minutes). */
function smallestGapMinutes(spec: CronSpec): number {
  const slots = spec.hours.flatMap((h) => spec.minutes.map((m) => h * 60 + m)).sort((a, b) => a - b);
  if (slots.length < 2) return 1440;
  let smallest = slots[0]! + 1440 - slots[slots.length - 1]!;
  for (let i = 1; i < slots.length; i += 1) smallest = Math.min(smallest, slots[i]! - slots[i - 1]!);
  return smallest;
}

function dayMatches(spec: CronSpec, wall: Pick<Wall, "month" | "day" | "dow">): boolean {
  if (!spec.months.has(wall.month)) return false;
  const dom = spec.daysOfMonth.has(wall.day);
  const dow = spec.daysOfWeek.has(wall.dow);
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dow;
  if (spec.dowAny) return dom;
  return dom || dow;
}

/**
 * The first fire strictly after `afterMs`, in the zone's wall clock, or null when none comes within five years.
 * A fixed time of day (`30 2 * * *`) fires once per day: in a fall-back fold at the first pass, in a spring-forward
 * gap right after the clock jumps. A cron that runs in every hour of the day follows elapsed time, so it
 * keeps firing through a repeated hour.
 */
export function nextFire(spec: CronSpec, afterMs: number, timeZone: string): number | null {
  return spec.hours.length === 24 ? nextByElapsedTime(spec, afterMs, timeZone) : nextByWallClock(spec, afterMs, timeZone);
}

function nextByWallClock(spec: CronSpec, afterMs: number, timeZone: string): number | null {
  const start = wallOf(afterMs, timeZone);
  const startNaive = naiveOf({ ...start, second: 0 }) - 3 * HOUR_MS;
  let day = Date.UTC(start.year, start.month - 1, start.day) - DAY_MS;
  let best: number | null = null;
  let bestNaive = 0;
  for (let guard = 0; guard < 366 * 5 + 3; guard += 1, day += DAY_MS) {
    const date = new Date(day);
    if (best !== null && day > bestNaive + 3 * HOUR_MS) break;
    if (!dayMatches(spec, { month: date.getUTCMonth() + 1, day: date.getUTCDate(), dow: date.getUTCDay() })) continue;
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const naive = day + hour * HOUR_MS + minute * 60_000;
        if (naive < startNaive) continue;
        if (best !== null && naive > bestNaive + 3 * HOUR_MS) return best;
        const instant = instantOfNaive(naive, timeZone);
        if (instant > afterMs && (best === null || instant < best)) {
          if (best === null) bestNaive = naive;
          best = instant;
        }
      }
    }
  }
  return best;
}

function nextByElapsedTime(spec: CronSpec, afterMs: number, timeZone: string): number | null {
  let t = (Math.floor(afterMs / 60_000) + 1) * 60_000;
  for (let guard = 0; guard < 40_000; guard += 1) {
    const wall = wallOf(t, timeZone);
    if (!dayMatches(spec, wall)) {
      const midnight = instantOfNaive(Date.UTC(wall.year, wall.month - 1, wall.day + 1), timeZone);
      t = midnight > t ? midnight : t + HOUR_MS;
      continue;
    }
    if (spec.minutes.includes(wall.minute)) return t;
    const following = spec.minutes.find((m) => m > wall.minute);
    t += ((following ?? 60) - wall.minute) * 60_000;
  }
  return null;
}
