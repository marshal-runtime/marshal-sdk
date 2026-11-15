import { assertLaunchAttachments, assertLaunchSystemPrompt } from "../session-launch-override";
import type { MarshalRuntimeAgentLaunchRequest } from "./agent-orchestration";
import { invalidRuntimeRequest } from "./runtime-provider-error";

type LaunchOverride = Pick<MarshalRuntimeAgentLaunchRequest, "systemPrompt" | "attachments">;

/** Maps the session-shaping fields of a delegation launch request to an agent launch. */
export function delegationLaunchOverride(request: {
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly attachments?: readonly string[];
}): LaunchOverride & Pick<MarshalRuntimeAgentLaunchRequest, "allowedTools"> {
  return {
    ...(request.tools === undefined ? {} : { allowedTools: [...request.tools] }),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.attachments === undefined ? {} : { attachments: [...request.attachments] }),
  };
}

/** Rejects a systemPrompt or attachments that the requested launch cannot honor. */
export async function assertLaunchOverride(
  request: MarshalRuntimeAgentLaunchRequest,
): Promise<void> {
  if (request.systemPrompt === undefined && request.attachments === undefined) return;
  if (request.sessionId !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError("systemPrompt and attachments cannot change an already running session."),
    );
  }
  if (request.systemPrompt !== undefined && request.agentName !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError("systemPrompt replaces the repository agent prompt; omit agentName."),
    );
  }
  try {
    if (request.systemPrompt !== undefined) assertLaunchSystemPrompt(request.systemPrompt);
    if (request.attachments !== undefined) await assertLaunchAttachments(request.attachments);
  } catch (error) {
    throw error instanceof TypeError || error instanceof RangeError
      ? invalidRuntimeRequest(error)
      : error;
  }
}
