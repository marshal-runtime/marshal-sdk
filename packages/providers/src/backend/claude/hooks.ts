import type {
  BackgroundTaskSummary,
  HookCallback,
  HookEvent,
  Options,
  SessionCronSummary,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { scriptingNudge } from "../local/scripting-nudge";
import type {
  RuntimeSessionHooks,
  RuntimeSubagentStartContext,
  RuntimeToolCallHint,
} from "../runtime-contract";
import type { ClaudeToolInvocationRegistry } from "./tool-invocations";
import { parseClaudeToolName } from "./tool-names";

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hook(callback: HookCallback): Array<{ hooks: HookCallback[] }> {
  return [{ hooks: [callback] }];
}

function mapPreToolUseResult(value: unknown): SyncHookJSONOutput {
  const result = toRecord(value);
  const decision = result["permissionDecision"];
  const reason = text(result["permissionDecisionReason"]);
  const additionalContext = text(result["additionalContext"]);
  const updatedInputValue = result["updatedInput"];
  const updatedInput =
    typeof updatedInputValue === "object" &&
    updatedInputValue !== null &&
    !Array.isArray(updatedInputValue)
      ? toRecord(updatedInputValue)
      : undefined;
  if (decision === "deny" || decision === "allow" || decision === "ask" || decision === "defer") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
        ...(additionalContext ? { additionalContext } : {}),
        ...(updatedInput ? { updatedInput } : {}),
      },
    };
  }
  return additionalContext || updatedInput
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          ...(additionalContext ? { additionalContext } : {}),
          ...(updatedInput ? { updatedInput } : {}),
        },
      }
    : {};
}

function mapPostToolUseResult(
  value: unknown,
  hookEventName: "PostToolUse" | "PostToolUseFailure",
): SyncHookJSONOutput {
  const result = toRecord(value);
  const additionalContext = text(result["additionalContext"]);
  if (hookEventName === "PostToolUse") {
    const updatedToolOutput = result["updatedToolOutput"];
    return {
      hookSpecificOutput: {
        hookEventName,
        ...(additionalContext ? { additionalContext } : {}),
        ...(updatedToolOutput !== undefined ? { updatedToolOutput } : {}),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName,
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
}

// The CLI's own generic background-notification frame for a finished
// backgrounded task (distinct from the scheduled-trigger frame — see
// SDKMessageOrigin in the SDK's own type declarations). Live-observed
// verbatim, e.g.:
//   <task-notification>
//   <task-id>b6b39dhav</task-id>
//   <tool-use-id>toolu_01ENxaxoeGGmuBHr5J5N1A13</tool-use-id>
//   <output-file>/path/to/task.output</output-file>
//   <status>failed</status>
//   <summary>Background command "..." failed with exit code 1</summary>
//   </task-notification>
// The exact tag pair is a stable, distinctive marker: no human-typed or
// Marshal-composed prompt starts this way (Marshal's own equivalent is
// `<marshal-control kind="background-task">`).
function isClaudeTaskNotificationAutoContinuation(prompt: string): boolean {
  return (
    prompt.startsWith("<task-notification>\n<task-id>") &&
    prompt.trimEnd().endsWith("</task-notification>")
  );
}

function mapPromptResult(value: unknown, originalPrompt: string): SyncHookJSONOutput {
  const result = toRecord(value);
  const explicitContext = text(result["additionalContext"]);
  const modifiedPrompt = text(result["modifiedPrompt"]);
  const derivedContext =
    modifiedPrompt && modifiedPrompt.startsWith(originalPrompt)
      ? modifiedPrompt.slice(originalPrompt.length).trim()
      : modifiedPrompt;
  const additionalContext = explicitContext ?? derivedContext;
  return additionalContext
    ? {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      }
    : {};
}

export interface ClaudeStopSnapshot {
  readonly backgroundTasks: readonly BackgroundTaskSummary[];
  readonly sessionCrons: readonly SessionCronSummary[];
}

interface ScriptingToolOptions {
  /** Called when the main thread stops with the CLI's own account of in-flight work and scheduled wakeups. */
  readonly onStop?: (snapshot: ClaudeStopSnapshot) => void;
  readonly scriptingToolName?: string;
  readonly scriptingToolHint?: RuntimeToolCallHint;
  readonly scriptingSubagentContext?: RuntimeSubagentStartContext;
  /** Native subagent types (`Agent`/`Task` `subagent_type`) the model may launch; others are denied. */
  readonly nativeSubagentAllowlist?: readonly string[];
}

const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

function deniedNativeSubagent(
  toolName: string,
  toolInput: unknown,
  allowlist: readonly string[] | undefined,
): SyncHookJSONOutput | undefined {
  if (!allowlist || !NATIVE_SUBAGENT_TOOLS.has(toolName)) return undefined;
  const subagentType = toRecord(toolInput)["subagent_type"];
  if (typeof subagentType === "string" && allowlist.includes(subagentType)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Native subagents are off in this session. Split work with forkSubagents instead; it continues from your exact context." +
        (allowlist.length > 0 ? ` Allowed native agent types: ${allowlist.join(", ")}.` : ""),
    },
  };
}

function isDenied(output: SyncHookJSONOutput): boolean {
  const decision = output.hookSpecificOutput;
  return decision?.hookEventName === "PreToolUse" && decision.permissionDecision === "deny";
}

async function withScriptingNudges(
  mapped: SyncHookJSONOutput,
  toolName: string,
  toolInput: unknown,
  sessionId: string,
  agentId: string | undefined,
  options: ScriptingToolOptions,
): Promise<SyncHookJSONOutput> {
  const { scriptingToolName, scriptingToolHint } = options;
  if (!scriptingToolName || isDenied(mapped)) return mapped;
  const call = { toolName, toolInput, sessionId, agentId, scriptingToolName };
  if (toolName !== "Bash" && toolName !== "Grep") {
    // The hint only observes other calls: a knowledge.* call through any runtime tool counts as an index search.
    await scriptingToolHint?.(call);
    return mapped;
  }
  const decision = mapped.hookSpecificOutput;
  const hint = await scriptingToolHint?.(call);
  if (typeof hint === "object") {
    return {
      ...mapped,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: hint.denyReason,
      },
    };
  }
  const nudges = [
    toolName === "Bash"
      ? scriptingNudge(toRecord(toolInput)["command"], scriptingToolName)
      : undefined,
    hint,
  ].filter((nudge): nudge is string => nudge !== undefined);
  if (nudges.length === 0) return mapped;
  const nudge = nudges.join("\n\n");
  const existing = decision?.hookEventName === "PreToolUse" ? decision : undefined;
  return {
    ...mapped,
    hookSpecificOutput: {
      ...existing,
      hookEventName: "PreToolUse",
      additionalContext: existing?.additionalContext
        ? `${existing.additionalContext}\n\n${nudge}`
        : nudge,
    },
  };
}

export function toClaudeHooks(
  sessionHooks: RuntimeSessionHooks | undefined,
  sessionId: string,
  invocations: ClaudeToolInvocationRegistry,
  options: ScriptingToolOptions = {},
): Options["hooks"] {
  if (!sessionHooks && !options.onStop) return undefined;
  const runtimeHooks: RuntimeSessionHooks = sessionHooks ?? {};
  const hooks: Partial<Record<HookEvent, Array<{ hooks: HookCallback[] }>>> = {};

  if (runtimeHooks.onPreToolUse) {
    hooks.PreToolUse = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "PreToolUse") return {};
      const input = rawInput;
      const parsedName = parseClaudeToolName(input.tool_name);
      invocations.record(parsedName.runtimeName, input.tool_use_id);
      const subagentDenial = deniedNativeSubagent(
        input.tool_name,
        input.tool_input,
        options.nativeSubagentAllowlist,
      );
      if (subagentDenial) {
        invocations.discard(parsedName.runtimeName, input.tool_use_id);
        return subagentDenial;
      }
      const result = await runtimeHooks.onPreToolUse?.(
        {
          toolName: parsedName.runtimeName,
          toolArgs: input.tool_input,
          timestamp: Date.now(),
          cwd: input.cwd,
          toolCallId: input.tool_use_id,
          serverName: parsedName.isHostTool ? undefined : parsedName.serverName,
        },
        { sessionId },
      );
      const output = await withScriptingNudges(
        mapPreToolUseResult(result),
        input.tool_name,
        input.tool_input,
        sessionId,
        input.agent_id,
        options,
      );
      if (isDenied(output)) invocations.discard(parsedName.runtimeName, input.tool_use_id);
      return output;
    });
  }

  const { scriptingToolName, scriptingSubagentContext } = options;
  if (scriptingToolName && scriptingSubagentContext) {
    hooks.SubagentStart = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "SubagentStart") return {};
      const additionalContext = await scriptingSubagentContext({ sessionId, scriptingToolName });
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } }
        : {};
    });
  }

  if (runtimeHooks.onPostToolUse || runtimeHooks.onPreToolUse) {
    hooks.PostToolUse = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "PostToolUse") return {};
      const input = rawInput;
      const parsedName = parseClaudeToolName(input.tool_name);
      invocations.discard(parsedName.runtimeName, input.tool_use_id);
      const result = await runtimeHooks.onPostToolUse?.(
        {
          toolName: parsedName.runtimeName,
          toolArgs: input.tool_input,
          toolResult: input.tool_response,
          timestamp: Date.now(),
          cwd: input.cwd,
          toolCallId: input.tool_use_id,
          serverName: parsedName.isHostTool ? undefined : parsedName.serverName,
        },
        { sessionId },
      );
      return mapPostToolUseResult(result, "PostToolUse");
    });
  }

  if (runtimeHooks.onPostToolUseFailure || runtimeHooks.onPreToolUse) {
    hooks.PostToolUseFailure = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "PostToolUseFailure") return {};
      const input = rawInput;
      const parsedName = parseClaudeToolName(input.tool_name);
      invocations.discard(parsedName.runtimeName, input.tool_use_id);
      const result = await runtimeHooks.onPostToolUseFailure?.(
        {
          toolName: parsedName.runtimeName,
          toolArgs: input.tool_input,
          error: input.error,
          timestamp: Date.now(),
          cwd: input.cwd,
          toolCallId: input.tool_use_id,
          serverName: parsedName.isHostTool ? undefined : parsedName.serverName,
        },
        { sessionId },
      );
      return mapPostToolUseResult(result, "PostToolUseFailure");
    });
  }

  if (runtimeHooks.onUserPromptSubmitted) {
    hooks.UserPromptSubmit = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "UserPromptSubmit") return {};
      const input = rawInput;
      // The CLI has its own background-task auto-continuation: independent
      // of anything Marshal sends, its persistent query re-submits a
      // `<task-notification>`-framed prompt on its own once a backgrounded
      // Bash/Agent task finishes (any status observed live so far —
      // completed, failed — though not an explicit Query.stopTask() stop,
      // which the CLI never auto-continues for). That races SessionManager's
      // own explicit tryWakeSessionForBackgroundTask wake (electron/
      // sessions.ts) for the exact same completion. Blocking this turn via
      // `decision: "block"` was tried and does NOT prevent the extra turn —
      // live testing showed the SDK still runs a full command_lifecycle/turn
      // cycle for a blocked prompt, it just replaces the model's reply with
      // an "operation blocked by hook" system message, which is worse (a
      // useless turn, and it corrupts which committed message Marshal treats
      // as its own wake's response). Instead, let this prompt through
      // completely unchanged and just flag it generically so
      // RuntimeSessionHooks.onUserPromptSubmitted's implementation
      // (electron/backend/local/session.ts) can tell SessionManager a
      // same-purpose turn is already in flight, so it can skip sending its
      // own redundant wake for this completion instead.
      const result = await runtimeHooks.onUserPromptSubmitted?.(
        {
          prompt: input.prompt,
          source: input.source,
          isBackgroundTaskAutoContinuation: isClaudeTaskNotificationAutoContinuation(input.prompt),
        },
        { sessionId },
      );
      return mapPromptResult(result, input.prompt);
    });
  }

  if (runtimeHooks.onContextCompacted) {
    hooks.SessionStart = hook(async (rawInput) => {
      // In streaming mode the CLI fires SessionStart again right after a
      // compaction, before the turn continues; its context reaches the model
      // inside that turn. Kept under 10,000 characters by the host: above
      // that the CLI writes it to a file and leaves a 2,000-character preview.
      if (rawInput.hook_event_name !== "SessionStart" || rawInput.source !== "compact") return {};
      const result = toRecord(await runtimeHooks.onContextCompacted?.({}, { sessionId }));
      const additionalContext = text(result["additionalContext"]);
      return additionalContext
        ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }
        : {};
    });
  }

  const { onStop } = options;
  if (onStop) {
    hooks.Stop = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "Stop") return {};
      onStop({
        backgroundTasks: rawInput.background_tasks ?? [],
        sessionCrons: rawInput.session_crons ?? [],
      });
      return {};
    });
  }

  if (runtimeHooks.onSessionEnd) {
    hooks.SessionEnd = hook(async (rawInput) => {
      if (rawInput.hook_event_name !== "SessionEnd") return {};
      const input = rawInput;
      await runtimeHooks.onSessionEnd?.({ reason: input.reason }, { sessionId });
      return {};
    });
  }

  return hooks;
}
