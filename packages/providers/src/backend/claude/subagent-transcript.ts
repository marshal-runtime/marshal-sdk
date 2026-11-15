import type { ProviderSessionMessage as SessionMessage } from "../../contract/host-types";
import { claudeJsonlToDisplayMessages } from "./native-state-history";
import type { ClaudeSdkFacade } from "./sdk-facade";

/**
 * A subagent's own transcript as display messages. The SDK reads it from the session's project
 * directory on disk, so this needs only the parent's native session id and workspace, not a live
 * query. A subagent's task id is the agent id of its `subagents/agent-<id>.jsonl` file; an unknown
 * id reads as an empty transcript.
 */
export async function readClaudeSubagentTranscript(
  sdk: Pick<ClaudeSdkFacade, "getSubagentMessages">,
  sessionId: string,
  workingDirectory: string,
  taskId: string,
): Promise<SessionMessage[]> {
  const persisted = await sdk.getSubagentMessages(sessionId, taskId, { dir: workingDirectory });
  const lines = persisted.map((entry) =>
    JSON.stringify({
      type: entry.type,
      uuid: entry.uuid,
      isSidechain: true,
      message: entry.message,
    }),
  );
  return claudeJsonlToDisplayMessages(Buffer.from(lines.join("\n")), { sidechain: true });
}
