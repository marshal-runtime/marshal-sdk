import type { ReasoningEffort } from "./marshal-ipc-contract";

export interface AgentModelDefault {
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** App defaults applied to values the user (or an org) has not set. */
export const APP_AGENT_DEFAULTS: {
  main: AgentModelDefault;
  subagents: AgentModelDefault;
} = {
  main: { model: "claude-opus-5-5", reasoningEffort: "medium" },
  subagents: { model: "claude-sonnet-5-5", reasoningEffort: "high" },
};

/** Compares model ids across catalogs that spell versions with dots or dashes. */
export function normalizeModelIdForMatch(id: string): string {
  return id.trim().toLowerCase().replaceAll(".", "-");
}
