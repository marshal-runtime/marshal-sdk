import type { PersistedSession } from "../../host/engine-host-types";

export function resolveSessionMcpScope(
  session: Pick<PersistedSession, "source" | "scopedMcp"> | null | undefined,
): readonly string[] | null {
  if (session?.scopedMcp !== undefined) return session.scopedMcp;
  return session?.source === "subagent" || session?.source === "workflow-agent" ? [] : null;
}
