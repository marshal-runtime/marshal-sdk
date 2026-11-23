import { z } from "zod";
import { catalogRoutine, OWNER_REPORT_DAILY, UA_CBO } from "./catalog.js";

export * from "./catalog.js";
export * from "./ua-snapshot.js";

const Zone = z.string().min(1).max(80).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "invalid IANA timezone");
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const Base = z.object({
  brandId: z.string().uuid(), routineId: Id, revision: z.number().int().positive(),
  name: z.string().min(1).max(120), description: z.string().min(1).max(500),
  cadence: z.string().min(1).max(120), timezone: Zone, currency: Currency, enabled: z.boolean(),
});

export const RoutineSchema = z.discriminatedUnion("origin", [
  Base.extend({
    origin: z.literal("marley"), routineId: z.enum([UA_CBO, OWNER_REPORT_DAILY]),
    /** Owner-editable UA CBO target cost per acquisition in the routine currency; absent means the channel KPI goal. */
    targetCpa: z.number().positive().max(1_000_000).optional(),
  }).strict().refine((routine) => routine.targetCpa === undefined || routine.routineId === UA_CBO, "targetCpa belongs to the UA CBO routine"),
  Base.extend({ origin: z.literal("owner"), routineId: Id.refine((value) => !catalogRoutine(value), "catalog routine id is reserved"), instructions: z.string().min(1).max(2000) }).strict(),
]);
export type Routine = z.infer<typeof RoutineSchema>;

export function publicRoutine(raw: unknown): Routine {
  return RoutineSchema.parse(raw);
}
export * from "./system.js";
