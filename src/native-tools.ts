/**
 * The native Claude tool surface of a session on Marshal's prompt, copied from the desktop
 * (electron/prompt/v2/assemble.ts V2_DISABLED_NATIVE_TOOLS and V2_NATIVE_SUBAGENT_ALLOWLIST, desktop 36452cec2;
 * the shared prompt package doesn't export them). test/native-tools.test.ts fails when the desktop's lists change.
 */

/** Native tools a session on Marshal's prompt never sees; Marshal owns each job (the v2 core's "tools" section). */
export const DISABLED_NATIVE_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "Workflow",
  "ListAgents",
  "SendMessage",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "EnterPlanMode",
  "ExitPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "EnterWorktree",
  "ExitWorktree",
  "DesignSync",
];

/**
 * The only native subagent such a session may launch: the CLI reads web pages through it. Every other
 * `Agent`/`Task` call is denied in favor of forkSubagents.
 */
export const NATIVE_SUBAGENT_ALLOWLIST: readonly string[] = ["web-fetch"];

const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * The Claude Agent SDK PreToolUse hook that enforces `allowlist`, with the desktop Claude client's wording
 * (packages/providers hooks.ts deniedNativeSubagent).
 */
export function nativeSubagentHook(allowlist: readonly string[]) {
  return async (input: { hook_event_name?: string; tool_name?: string; tool_input?: unknown }) => {
    if (input.hook_event_name !== "PreToolUse" || !NATIVE_SUBAGENT_TOOLS.has(String(input.tool_name))) return {};
    const subagentType = (input.tool_input as { subagent_type?: unknown } | undefined)?.subagent_type;
    if (typeof subagentType === "string" && allowlist.includes(subagentType)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason:
          "Native subagents are off in this session. Split work with forkSubagents instead; it continues from your exact context." +
          (allowlist.length > 0 ? ` Allowed native agent types: ${allowlist.join(", ")}.` : ""),
      },
    };
  };
}
