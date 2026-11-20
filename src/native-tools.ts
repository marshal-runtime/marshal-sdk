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

/**
 * The native tools a Claude session on this host keeps (the CLI's surface minus DISABLED_NATIVE_TOOLS), as the
 * "Tools on this host" list names them. Seen in a real session's init event (2026-11-16): Task, Bash, Edit, Monitor,
 * NotebookEdit, Read, ReportFindings, Skill, TaskStop, ToolSearch, WebSearch, Write.
 */
export const CLAUDE_NATIVE_PROMPT_TOOLS: readonly { name: string; description: string }[] = [
  { name: "Bash", description: "Run shell commands in this run's working folder (background with run_in_background; Monitor and TaskStop follow and stop them)." },
  { name: "Read", description: "Read a file, an image (you see it) or a PDF." },
  { name: "Write", description: "Create or overwrite a file." },
  { name: "Edit", description: "Exact string replacement in a file you have read." },
  { name: "NotebookEdit", description: "Edit a Jupyter notebook cell." },
  { name: "WebSearch", description: "Search the web for facts that live outside the organization's systems." },
  { name: "Task", description: `Only the ${NATIVE_SUBAGENT_ALLOWLIST.join(", ")} subagent, to read a web page; split other work with marshal.tool.forkSubagents.` },
];

/**
 * The built-in tools an Antigravity session on this host keeps (its subagent, messaging, workflow, question and
 * timer tools are Marshal's), each line the opening of Google's own tool description as the harness sends it to
 * Vertex (desktop electron/prompt/v2/antigravity-vanilla-prompt.txt was captured from the same request).
 */
export const ANTIGRAVITY_NATIVE_PROMPT_TOOLS: readonly { name: string; description: string }[] = [
  { name: "run_command", description: "Run a command on the user's system (zsh). A command that outlives WaitMsBeforeAsync goes to the background; the system notifies you when it finishes, so don't poll." },
  { name: "manage_task", description: "Manage background tasks: list running tasks, kill one, check its status and log file, or send it input." },
  { name: "view_file", description: "View the contents of a file from the local filesystem: text (up to 800 lines at a time), image, pdf, video or audio." },
  { name: "write_to_file", description: "Create a new file (Overwrite to replace one, Append to add to one); parent directories are created." },
  { name: "replace_file_content", description: "Edit an existing file by replacing a single contiguous block of text." },
  { name: "search_web", description: "Perform a web search; returns a summary with URL citations." },
  { name: "read_url_content", description: "Fetch content from a URL via HTTP request and convert it to markdown (no JavaScript, no authentication)." },
  { name: "generate_image", description: "Generate an image or edit existing images from a text prompt; the result is saved as an artifact." },
];
