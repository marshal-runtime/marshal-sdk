import { assertLaunchAttachments, assertLaunchSystemPrompt } from "../session-launch-override";
import type { MarshalRuntimeAgentLaunchRequest } from "./agent-orchestration";
import { invalidRuntimeRequest } from "./runtime-provider-error";

type LaunchOverride = Pick<MarshalRuntimeAgentLaunchRequest, "systemPrompt" | "attachments">;

/** Maps the session-shaping fields of a delegation launch request to an agent launch. */
export function delegationLaunchOverride(request: {
  readonly systemPrompt?: string;
  readonly systemPromptAppend?: string;
  readonly tools?: readonly string[];
  readonly attachments?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensions?: readonly string[];
  readonly nativeTools?: readonly string[];
}): LaunchOverride &
  Pick<
    MarshalRuntimeAgentLaunchRequest,
    "allowedTools" | "mcpServers" | "skills" | "extensions" | "nativeTools" | "systemPromptAppend"
  > {
  return {
    ...(request.systemPromptAppend === undefined
      ? {}
      : { systemPromptAppend: request.systemPromptAppend }),
    ...(request.mcpServers === undefined ? {} : { mcpServers: [...request.mcpServers] }),
    ...(request.skills === undefined ? {} : { skills: [...request.skills] }),
    ...(request.extensions === undefined ? {} : { extensions: [...request.extensions] }),
    ...(request.nativeTools === undefined ? {} : { nativeTools: [...request.nativeTools] }),
    ...(request.tools === undefined ? {} : { allowedTools: [...request.tools] }),
    ...(request.mcpServers === undefined ? {} : { mcpServers: [...request.mcpServers] }),
    ...(request.skills === undefined ? {} : { skills: [...request.skills] }),
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
    ...(request.attachments === undefined ? {} : { attachments: [...request.attachments] }),
  };
}

/** Rejects a systemPrompt or attachments that the requested launch cannot honor. */
export async function assertLaunchOverride(
  request: MarshalRuntimeAgentLaunchRequest,
): Promise<void> {
  if (request.nativeTools !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError(
        "nativeTools is not supported by this host yet; omit it to keep every built-in tool.",
      ),
    );
  }
  if (request.systemPrompt !== undefined && request.systemPromptAppend !== undefined) {
    throw invalidRuntimeRequest(
      new TypeError("systemPrompt replaces the prompt; use systemPromptAppend alone to add to it."),
    );
  }
  if (
    request.sessionId !== undefined &&
    (request.systemPromptAppend !== undefined ||
      request.extensions !== undefined ||
      request.mcpServers !== undefined ||
      request.skills !== undefined)
  ) {
    throw invalidRuntimeRequest(
      new TypeError(
        "systemPromptAppend, extensions, mcpServers and skills cannot change an already running session.",
      ),
    );
  }
  if (request.systemPromptAppend !== undefined)
    assertLaunchSystemPrompt(request.systemPromptAppend);
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
