import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isBrandEventName } from "./brand-events-contract.js";
import { isRoutineEventName, ROUTINE_EVENT_NAMES } from "./routine-events.js";

/**
 * A routine's triggers as its extension package declares them (`routines/<agent>.yaml`, docs/design/extension-triggers.md). This file is the only place a
 * routine's start conditions are written: the trigger dispatcher (trigger-dispatcher.ts) reads them, per brand, from the package the registry resolves for that
 * brand (its fork, else the release package), and turns them into SDK automations (schedules, after) and bus subscriptions (events).
 */
const CRON_FIELD = /^[0-9*/,-]+$/;
export const cron = z.string().max(120).refine((text) => { const fields = text.trim().split(/\s+/); return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field)); }, "a five-field cron expression");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const duration = z.string().regex(/^\d+(m|h)$/, "a duration like 90m or 6h");
const routineName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** A server event of routine-events.ts, or one of the brand's own `brand.<slug>` events (whether the brand defines it is checked when it fires). */
const eventName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).refine((event) => isRoutineEventName(event) || isBrandEventName(event), `an event the server emits (${ROUTINE_EVENT_NAMES.join(", ")}) or the brand's own brand.<slug>`);
const matchValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
/** A payload filter: every named field must equal the value (a list matches any of its values), as a chat subscription's filter (matchesFilter). */
const match = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), z.union([matchValue, z.array(matchValue).min(1).max(20)]));
/** An event a routine starts on: its name, or the name with a filter on the event's payload fields (`{event: "brand.big-order", match: {tier: "big"}}`). */
const eventTrigger = z.union([eventName, z.strictObject({ event: eventName, match: match.optional() })]);

export const RoutineTriggersSchema = z.strictObject({
  /** Five-field crons, in `timezone`. */
  schedules: z.array(cron).max(8).optional(),
  /** Event types on the bus: the server's (routine-events.ts) and the brand's own (`brand.<slug>`, brand-events.ts), optionally with a payload filter. */
  events: z.array(eventTrigger).max(8).optional(),
  /** Runs when another routine of the brand (its agent id) finished well. `notBefore` holds it until that local time; `within` drops it when that wait is longer. */
  after: z.strictObject({ routine: z.union([routineName, z.array(routineName).min(1).max(8)]), mode: z.enum(["any", "all"]).optional(), notBefore: clock.optional(), within: duration.optional() }).optional(),
  /** "brand": the brand's own zone; otherwise an IANA zone. */
  timezone: z.string().min(1).max(64).optional(),
  /** May be run by hand (the inspector's run now). */
  manual: z.boolean().optional(),
});
export type RoutineTriggers = z.infer<typeof RoutineTriggersSchema>;

const RoutineFileSchema = z.object({
  title: z.string().optional(),
  triggers: RoutineTriggersSchema,
  enabled: z.boolean().optional(),
}).passthrough();

/** A routine file's triggers; a file switched off (`enabled: false`) declares none. Throws on a file that is not a routine file. */
export function parseRoutineTriggers(text: string): RoutineTriggers {
  const file = RoutineFileSchema.parse(parseYaml(text));
  return file.enabled === false ? {} : file.triggers;
}

/** The zone a trigger's clock runs in for a brand: the brand's own for "brand" (UTC when it has none), else the zone the file names. */
export const triggerZone = (triggers: RoutineTriggers, brandZone: string | undefined): string =>
  !triggers.timezone || triggers.timezone === "brand" ? brandZone ?? "UTC" : triggers.timezone;

/** The events a routine starts on, each with its payload filter ({} = every payload). */
export const eventTriggers = (triggers: RoutineTriggers): { event: string; match: Record<string, string | number | boolean | (string | number | boolean)[]> }[] =>
  (triggers.events ?? []).map((entry) => (typeof entry === "string" ? { event: entry, match: {} } : { event: entry.event, match: entry.match ?? {} }));

/** The routine names an `after` trigger follows. */
export const afterRoutines = (triggers: RoutineTriggers): string[] => (triggers.after ? (Array.isArray(triggers.after.routine) ? triggers.after.routine : [triggers.after.routine]) : []);

/** The release package's own routine file of an agent (`<package>/routines/<agent>.yaml`), parsed; null when the package ships none. */
export function releaseTriggers(packageRoot: string, agent: string): RoutineTriggers | null {
  const file = path.join(packageRoot, "routines", `${agent}.yaml`);
  if (!fs.existsSync(file)) return null;
  return parseRoutineTriggers(fs.readFileSync(file, "utf8"));
}
