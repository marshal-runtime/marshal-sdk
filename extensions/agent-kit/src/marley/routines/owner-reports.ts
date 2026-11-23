// Extract of zygstinct apps/agent-server/src/routines/owner-reports.ts at 7110e58c8: only ShopClock, ownerReportCoverage.
import { type Routine } from "@zygstinct/routines-public";
import { wallOf } from "../agent-extensions/schedules/zone.js";

const pad = (value: number): string => String(value).padStart(2, "0");

const dayOf = (ms: number, zone: string): string => { const wall = wallOf(ms, zone); return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`; };

const addDay = (day: string, offset: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * What a fire at `slot` reports, on the shop's clock (`shop.zone`; the routine's own zone when none is known): yesterday in that zone, or the day `shop.readyDay` names. The runner gets it as --date, so it never re-derives it from the clock of the moment it runs.
 * The gather capability reports the newest day that has data and says "data through".
 */
export function ownerReportCoverage(routine: Routine, slot: number, shop?: ShopClock): { date: string; covered: string; today: string } {
  // The report day is decided in the shop's zone; the routine's zone (the owner's) only decides when it is delivered. Without a known shop zone the routine's own clock stays.
  const today = dayOf(slot, shop?.zone ?? routine.timezone);
  const clockDate = addDay(today, -1);
  // The shop day the readiness event announced wins over the clock while it is the newest or the one before (a build retried past shop midnight still covers its own day).
  const date = shop?.readyDay && shop.readyDay >= addDay(clockDate, -1) && shop.readyDay <= clockDate ? shop.readyDay : clockDate;
  return { date, covered: date, today };
}

/** The shop's clock for a report: its IANA zone, and the day of the latest `shop-day.ready` event (null when none). */
export interface ShopClock { zone: string; readyDay?: string | null }
