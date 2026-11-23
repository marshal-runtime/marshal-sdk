const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface Wall {
  year: number;
  /** 1 to 12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, found);
  }
  return found;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of an instant in a zone. */
export function wallOf(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const dow = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay();
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second!, dow };
}

/** A wall clock read as if it were UTC: the "naive" millisecond count of a local time. */
export function naiveOf(wall: Pick<Wall, "year" | "month" | "day" | "hour" | "minute" | "second">): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** Offset of the zone from UTC at an instant, in ms (east is positive). */
export function offsetMs(ms: number, timeZone: string): number {
  return naiveOf(wallOf(Math.floor(ms / 1000) * 1000, timeZone)) - Math.floor(ms / 1000) * 1000;
}

/** Every instant at which the zone's wall clock shows this naive time: none in a spring-forward gap, two in a fall-back fold. */
export function instantsOfNaive(naive: number, timeZone: string): number[] {
  const found = new Set<number>();
  for (const probe of [naive - DAY_MS, naive + DAY_MS]) {
    const offset = offsetMs(probe, timeZone);
    const candidate = naive - offset;
    if (offsetMs(candidate, timeZone) === offset) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The instant for a local time, the way people mean it: the first of two in a fold, and in a gap the moment the clock
 * jumps (02:30 on a spring-forward night is 03:30 after the change).
 */
export function instantOfNaive(naive: number, timeZone: string): number {
  const all = instantsOfNaive(naive, timeZone);
  if (all.length > 0) return all[0]!;
  return naive - offsetMs(naive - DAY_MS, timeZone);
}

/** Formats an instant as a local time with its zone, for messages the agent reads. */
export function describeInstant(ms: number, timeZone: string): string {
  const wall = wallOf(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)} ${timeZone}`;
}

export { DAY_MS, HOUR_MS };
