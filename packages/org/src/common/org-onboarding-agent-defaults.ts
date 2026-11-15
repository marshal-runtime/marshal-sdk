import type {
  AgentDefaultEffort,
  AgentModelDefault,
  OrgAgentDefaults,
} from "@marshal/agent-runtime-org";

export type { AgentDefaultEffort, AgentModelDefault, OrgAgentDefaults };

/** Mirrors `AGENT_DEFAULT_EFFORTS` of `@marshal/agent-runtime-org`; the `satisfies` keeps the two in step. */
export const AGENT_DEFAULT_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AgentDefaultEffort[];

function parseModelDefault(value: unknown): AgentModelDefault | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model: unknown = Reflect.get(value, "model");
  const effort: unknown = Reflect.get(value, "effort");
  const runtime: unknown = Reflect.get(value, "runtime");
  if (typeof model !== "string" || !model.trim() || model.length > 200) return undefined;
  const parsed: AgentModelDefault = { model: model.trim() };
  if (effort !== undefined && effort !== null) {
    const known = AGENT_DEFAULT_EFFORTS.find((entry) => entry === effort);
    if (!known) return undefined;
    parsed.effort = known;
  }
  if (typeof runtime === "string" && runtime.trim() && runtime.length <= 100) {
    parsed.runtime = runtime.trim();
  }
  return parsed;
}

/**
 * The one reader of an org manifest's `agentDefaults` (desktop manifest parser and model manager):
 * a malformed side is dropped instead of failing the manifest. Types come from the runtime contract.
 */
export function parseOrgAgentDefaults(value: unknown): OrgAgentDefaults | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const main = parseModelDefault(Reflect.get(value, "main"));
  const subagents = parseModelDefault(Reflect.get(value, "subagents"));
  if (!main && !subagents) return undefined;
  return { ...(main ? { main } : {}), ...(subagents ? { subagents } : {}) };
}
