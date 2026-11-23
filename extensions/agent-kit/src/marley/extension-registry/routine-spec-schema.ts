import { OWNER_REPORT_DAILY, SYSTEM_ROUTINES, UA_CBO, type Routine } from "@zygstinct/routines-public";
import { z } from "zod";

/**
 * A routine as data: an instruction prompt (never the system prompt), the skills loaded for its run, an optional runtime extension and metadata.
 * Release defaults live here (version 0); a brand's edits are append-only extension versions in the registry, read by `RoutineSpecs` (routine-specs.ts).
 */
export const RoutineSpecSchema = z.strictObject({
  id: z.string().min(1).max(64),
  version: z.number().int().min(0),
  origin: z.enum(["system", "owner"]),
  metadata: z.strictObject({
    name: z.string().min(1).max(120),
    description: z.string().max(600),
    cadence: z.string().max(120),
    timezone: z.string().max(64),
    enabled: z.boolean(),
    currency: z.string().max(8).optional(),
    /** Which calendar the report day is on: the shop's own day ("shop", the default) or the owner's ("owner", not offered yet). Passed to the capabilities as an explicit input, never hidden in a script. */
    dayBasis: z.enum(["shop", "owner"]).optional(),
  }),
  /** The run's instruction prompt. Placeholders the server renders: {{date}} {{brandId}} {{runner}} {{routineId}} {{default}} (the release's built prompt for the slot). */
  prompt: z.string().min(1).max(8192),
  skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(16),
  /** The runtime capabilities the run calls by name (the VM's routine extension, zs-routine-tools.mjs). Carried and stored; the VM offers them in every routine turn today, enforcement comes later. */
  extension: z.strictObject({ id: z.string().min(1).max(120), tools: z.array(z.string().min(1).max(120)).max(32) }).nullable(),
});
export type RoutineSpec = z.infer<typeof RoutineSpecSchema>;

export const DEFAULT_PROMPT = "{{default}}";
const REPORT_SKILLS: Record<string, string[]> = {
  [OWNER_REPORT_DAILY]: ["owner-reports", "morning-brief-video"],
  [UA_CBO]: ["meta-insights"],
};

/** The routine extension on the brand VM: the capabilities each system routine's run calls instead of any script path. */
export const ROUTINE_EXTENSION_ID = "marley-routines";
const REPORT_TOOLS: Record<string, string[]> = {
  [OWNER_REPORT_DAILY]: ["zs.brief.gather", "zs.brief.greetings", "zs.reports.run"],
  // ua-cbo has none: the server runs the UA analysis itself (routines/ua-server), nothing on the VM.
};

export const DEFAULT_SPECS: readonly RoutineSpec[] = SYSTEM_ROUTINES.filter((routine) => routine.kind === "routine").map((routine) => ({
  id: routine.id, version: 0, origin: "system" as const,
  metadata: { name: routine.name, description: routine.description, cadence: "release default", timezone: "owner", enabled: true },
  prompt: DEFAULT_PROMPT,
  skills: REPORT_SKILLS[routine.id] ?? [],
  extension: REPORT_TOOLS[routine.id] ? { id: ROUTINE_EXTENSION_ID, tools: REPORT_TOOLS[routine.id]! } : null,
}));

export const skillsLine = (skills: string[]): string => (skills.length ? `Load these skills for this run: ${skills.join(", ")}.\n` : "");

export function renderSpecPrompt(spec: Pick<RoutineSpec, "prompt">, vars: Record<string, string>): string {
  // One pass, so a value that contains a placeholder is not expanded again.
  return spec.prompt.replace(/\{\{(date|brandId|routineId|runner|default)\}\}/g, (_match, key: string) => vars[key] ?? "");
}

export interface SpecDiff { from: number; to: number; changed: string[] }
export function diffSpecs(a: RoutineSpec, b: RoutineSpec): SpecDiff {
  const changed: string[] = [];
  if (a.prompt !== b.prompt) changed.push("prompt");
  if (JSON.stringify(a.skills) !== JSON.stringify(b.skills)) changed.push("skills");
  if (JSON.stringify(a.extension) !== JSON.stringify(b.extension)) changed.push("extension");
  for (const key of Object.keys(b.metadata) as (keyof RoutineSpec["metadata"])[]) if (a.metadata[key] !== b.metadata[key]) changed.push(`metadata.${key}`);
  return { from: a.version, to: b.version, changed };
}
