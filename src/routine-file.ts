import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isTenantZone, type AutomationInput } from "./automations.js";

/**
 * Marshal's routine file (`.marshal/routines/<id>.yaml`), the same schema the desktop (common/routines/routine-definition.ts)
 * and zyg-agents (src/shared/routines/routine-definition.ts) parse, plus what an agent extension needs:
 *
 * - `body.extension {id, agent, input}`: start an agent an extension declares (contributes.agents) with its pinned profile;
 * - `triggers.after {routine, notBefore, within}`: run once another routine finished well;
 * - `triggers.timezone`: the zone of its schedules and notBefore (an IANA name, or "tenant" (alias "brand") for the tenant's own).
 *
 * zyg-agents' Slack and alert event objects are accepted here as data and ignored by this host (it fires named events).
 */

export const ROUTINE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_ROUTINE_FILE_BYTES = 64 * 1024;
const MAX_ROUTINE_PROMPT_CHARS = 32_000;
const CRON_FIELD = /^[\d*/,\-A-Za-z]+$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const cron = z.string().refine(
  (value) => {
    const fields = value.trim().split(/\s+/);
    return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
  },
  { message: "must be a five-field cron expression" },
);

const after = z
  .object({
    routine: z.string().regex(ROUTINE_ID_PATTERN),
    notBefore: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time of day HH:MM")
      .optional(),
    within: z
      .string()
      .regex(/^\d{1,5}(s|m|h|d)$/, 'must be a duration like "90m" or "6h"')
      .optional(),
  })
  .strict();

const triggers = z
  .object({
    schedules: z.array(cron).max(16).default([]),
    events: z.array(z.union([z.string().min(1).max(128), z.record(z.string(), z.unknown())])).max(32).default([]),
    manual: z.boolean().default(true),
    after: after.optional(),
    timezone: z.string().min(1).max(128).optional(),
  })
  .strict();

const agentBody = z
  .object({
    agent: z
      .object({
        prompt: z.string().min(1).max(MAX_ROUTINE_PROMPT_CHARS),
        role: z.string().min(1).max(128).optional(),
        model: z.string().min(1).max(128).optional(),
        effort: z.enum(EFFORTS).optional(),
      })
      .strict(),
  })
  .strict();

const workflowBody = z
  .object({ workflow: z.string().regex(ROUTINE_ID_PATTERN), prompt: z.string().min(1).max(MAX_ROUTINE_PROMPT_CHARS).optional() })
  .strict();

const extensionBody = z
  .object({
    extension: z
      .object({
        id: z.string().regex(/^@?[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/),
        agent: z.string().regex(ROUTINE_ID_PATTERN),
        input: z.record(z.string(), z.unknown()).optional(),
        model: z.string().min(1).max(128).optional(),
        effort: z.enum(EFFORTS).optional(),
      })
      .strict(),
  })
  .strict();

const outputs = z
  .object({
    channels: z.array(z.string().min(1).max(128)).max(64).default([]),
    people: z.array(z.string().min(1).max(256)).max(64).default([]),
    thread: z.boolean().default(false),
  })
  .strict();

export const RoutineDefinitionSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2_000).optional(),
    triggers: triggers.default({ schedules: [], events: [], manual: true }),
    body: z.union([agentBody, workflowBody, extensionBody]),
    outputs: outputs.default({ channels: [], people: [], thread: false }),
    placement: z.enum(["local", "cloud"]).default("local"),
    enabled: z.boolean().default(true),
    workspaces: z.array(z.string().min(1).max(128)).max(32).default([]),
  })
  .strict();

export type RoutineDefinitionFile = z.infer<typeof RoutineDefinitionSchema>;
export interface RoutineDefinition extends RoutineDefinitionFile {
  readonly id: string;
}

export type ParsedRoutine = { ok: true; routine: RoutineDefinition } | { ok: false; id: string; error: string };

/** Parses one routine file; a broken file comes back with its first problem in words. */
export function parseRoutineFile(id: string, text: string): ParsedRoutine {
  if (!ROUTINE_ID_PATTERN.test(id)) return { ok: false, id, error: "invalid routine id" };
  if (Buffer.byteLength(text, "utf8") > MAX_ROUTINE_FILE_BYTES) return { ok: false, id, error: "the routine file is too large" };
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 0 });
  } catch (error) {
    return { ok: false, id, error: `invalid YAML: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`.slice(0, 300) };
  }
  const parsed = RoutineDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, id, error: `${where}${issue?.message ?? "invalid routine"}`.slice(0, 300) };
  }
  return { ok: true, routine: { id, ...parsed.data } };
}

/**
 * The automations a routine becomes on this host, one per trigger kind it declares (a schedule each, the named events,
 * the `after` chain). Manual-only routines become one automation with no trigger of its own (run with runNow). The
 * caller (the host) supplies the tenant and labels; a session never does.
 */
export function routineAutomations(
  routine: RoutineDefinition,
  host: { tenant?: string; labels?: Record<string, string>; timezone?: string } = {},
): AutomationInput[] {
  const body = routine.body;
  const common: Partial<AutomationInput> = {
    name: routine.title,
    ...(routine.description ? { description: routine.description } : {}),
    routineId: routine.id,
    enabled: routine.enabled,
    ...(host.tenant ? { tenant: host.tenant } : {}),
    ...(host.labels ? { labels: host.labels } : {}),
  };
  if ("workflow" in body) throw Object.assign(new Error(`Routine ${routine.id} runs a workflow; this host runs agent and extension bodies.`), { code: "invalid-request" });
  if ("agent" in body) {
    Object.assign(common, {
      prompt: body.agent.prompt,
      ...(body.agent.model ? { model: body.agent.model } : {}),
      ...(body.agent.effort ? { reasoningEffort: body.agent.effort } : {}),
    });
  } else {
    Object.assign(common, {
      extension: { id: body.extension.id, agent: body.extension.agent, ...(body.extension.input ? { input: body.extension.input } : {}) },
      ...(body.extension.model ? { model: body.extension.model } : {}),
      ...(body.extension.effort ? { reasoningEffort: body.extension.effort } : {}),
    });
  }
  const zone = isTenantZone(routine.triggers.timezone) ? host.timezone : routine.triggers.timezone;
  const inputs: AutomationInput[] = [];
  for (const schedule of routine.triggers.schedules) {
    inputs.push({ ...common, triggerType: "schedule", schedule, ...(zone ? { timezone: zone } : {}) } as AutomationInput);
  }
  for (const event of routine.triggers.events) {
    if (typeof event === "string") inputs.push({ ...common, triggerType: "event", event } as AutomationInput);
  }
  if (routine.triggers.after) {
    inputs.push({
      ...common,
      triggerType: "after",
      after: { ...routine.triggers.after, timezone: isTenantZone(routine.triggers.timezone) ? "tenant" : routine.triggers.timezone! },
    } as AutomationInput);
  }
  // A routine with no automatic trigger is still runnable by hand.
  if (!inputs.length) inputs.push({ ...common, triggerType: "event", event: `routine.manual:${routine.id}` } as AutomationInput);
  return inputs;
}
