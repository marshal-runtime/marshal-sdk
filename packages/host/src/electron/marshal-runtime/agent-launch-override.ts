import { assertLaunchAttachments, assertLaunchSystemPrompt } from "../session-launch-override";
import type { MarshalRuntimeAgentLaunchRequest } from "./agent-orchestration";
import { invalidRuntimeRequest } from "./runtime-provider-error";

type LaunchOverride = Pick<
  MarshalRuntimeAgentLaunchRequest,
  "systemPrompt" | "systemPromptAppend" | "attachments"
>;

/** Maps the session-shaping fields of a delegation launch request to an agent launch. */
export function delegationLaunchOverride(request: {
  readonly systemPrompt?: string;
  readonly systemPromptAppend?: string;
  readonly tools?: readonly string[];
  readonly attachments?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
}): LaunchOverride &
  Pick<MarshalRuntimeAgentLaunchRequest, "allowedTools" | "mcpServers" | "skills"> {
  return {
    ...(request.tools === undefined ? {} : { allowedTools: [...request.tools] }),
    ...(request.mcpServers === undefined ? {} : { mcpServers: [...request.mcpServers] }),
    ...(request.skills === undefined ? {} : { skills: [...request.skills] }),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.systemPromptAppend === undefined
      ? {}
      : { systemPromptAppend: request.systemPromptAppend }),
    ...(request.attachments === undefined ? {} : { attachments: [...request.attachments] }),
  };
}

/** Rejects a systemPrompt, systemPromptAppend or attachments that the requested launch cannot honor. */
export async function assertLaunchOverride(
  request: MarshalRuntimeAgentLaunchRequest,
): Promise<void> {
  if (request.systemPromptAppend !== undefined) {
    if (request.sessionId !== undefined) {
      throw invalidRuntimeRequest(
        new TypeError("systemPromptAppend cannot change an already running session."),
      );
    }
    if (request.systemPrompt !== undefined) {
      throw invalidRuntimeRequest(
        new TypeError(
          "systemPromptAppend cannot be combined with systemPrompt, which replaces the host prompt.",
        ),
      );
    }
    try {
      assertLaunchSystemPrompt(request.systemPromptAppend);
    } catch (error) {
      throw error instanceof RangeError ? invalidRuntimeRequest(error) : error;
    }
  }
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
