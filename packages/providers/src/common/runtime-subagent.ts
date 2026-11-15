import type { SessionMetadata } from "../../host/engine-host-types";

export type RuntimeSubagentStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export type { RuntimeSubagentUsage } from "../contract/host-types";
import type { RuntimeSubagentUsage } from "../contract/host-types";

/**
 * A subagent that a runtime (Claude's Task/Agent tool) runs inside its own process, shown as a
 * read-only child row. The runtime owns the work; Marshal only mirrors its state and transcript.
 */
export interface RuntimeSubagentRef {
  runtimeId: string;
  /** Claude's task id for the subagent. Equal to the agent id of its transcript file. */
  taskId: string;
  agentId: string;
  /** The Agent tool call in the parent turn that launched it. */
  toolUseId?: string;
  agentType?: string;
  spawnDepth?: number;
  parentTaskId?: string;
  background: boolean;
  readOnly: true;
  status: RuntimeSubagentStatus;
  /** Latest one-line progress, or the final summary once it ended. */
  summary?: string;
  lastToolName?: string;
  usage?: RuntimeSubagentUsage;
  startedAt: string;
  endedAt?: string;
}

export function isRuntimeSubagentRunning(
  ref: Pick<RuntimeSubagentRef, "status"> | undefined,
): boolean {
  return ref?.status === "running";
}

type MirrorCandidate = Pick<SessionMetadata, "source" | "parentSessionId" | "importedFrom">;

/**
 * A Claude subagent shown as a child session: a live mirror of one the running Claude session
 * started, or one imported from a Claude Code transcript. Both nest under their parent and share
 * the Claude badge and the Agents filter.
 */
export function isClaudeSubagentSession(session: MirrorCandidate): boolean {
  return (
    !!session.parentSessionId &&
    (session.source === "claude-subagent" || session.importedFrom?.source === "claude-code")
  );
}

/** Read-only live mirror: no composer, no backend session of its own. */
export function isRuntimeSubagentMirror(session: Pick<SessionMetadata, "source">): boolean {
  return session.source === "claude-subagent";
}

export const RUNTIME_SUBAGENT_READ_ONLY_NOTE =
  "This is a view of a Claude subagent. Reply in the parent chat to steer it.";
