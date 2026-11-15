// Host-facing types the provider layer reads and writes. The desktop's IPC contract re-exports
// these, so there is one definition for Marshal and the Marshal SDK.

export type ToolActivityKind = "read" | "mutation" | "command" | "other";

export interface MessageToolCall {
  id?: string;
  name: string;
  description: string;
  activityKind?: ToolActivityKind;
  input?: string;
  output?: string;
  success?: boolean;
  cancelled?: boolean;
  error?: string;
  /** Full input/output/error exists in session storage and is fetched on demand. */
  detailsAvailable?: boolean;
}

/**
 * The part of a transcript message a provider produces when it reads native state back. A host's
 * own message type carries more (all optional); this subset is assignable to it.
 */
export interface ProviderSessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  toolCalls?: MessageToolCall[];
  reasoning?: { text: string; durationSeconds: number | null };
}

/** Explicit per-session runtime sandbox override. Undefined = adapter default
 *  (read-only for Codex). Only consulted by adapters that execute commands in
 *  an OS sandbox; approval-flow permissions are unaffected. "danger-full-access"
 *  removes the OS sandbox (filesystem and network), like runtimes that have
 *  none; it is derived for allow-all sessions and never accepted from callers. */
export interface SessionSandboxConfig {
  mode: "read-only" | "workspace-write" | "danger-full-access";
  /** Extra writable roots granted alongside the session cwd when mode is
   *  "workspace-write" (e.g. a report directory outside the worktree). */
  writableRoots?: string[];
}

export const PERMISSION_KIND_TUPLE = [
  "shell",
  "write",
  "mcp",
  "read",
  "url",
  "custom-tool",
  "memory",
  "hook",
  "settings",
] as const;

export type PermissionKind = (typeof PERMISSION_KIND_TUPLE)[number];

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ContextTier = "default" | "long_context";

export interface ModelInfo {
  id: string;
  name: string;
  featured?: boolean;
  capabilities?: {
    supportsVision?: boolean;
    supports?: {
      vision?: boolean;
      reasoningEffort?: boolean;
      structured_outputs?: boolean;
      tool_calls?: boolean;
    };
  };
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  supportedContextTiers?: ContextTier[];
  contextWindowTokens?: Partial<Record<ContextTier, number>>;
  policy?: {
    /**
     * Mirrors Copilot SDK `ModelPolicy.state`. Only `"enabled"` (or no
     * policy) is usable; `"disabled"` and `"unconfigured"` fail with
     * `Model "X" is not available.` at session creation.
     */
    state?: "enabled" | "disabled" | "unconfigured";
    /** Copilot terms the user or org must accept before this model can be used. */
    terms?: string;
  };
  billing?: {
    isPremium?: boolean;
    premiumMultiplier?: number;
  };
  /** Runtime and account the model runs on; the picker groups by it. */
  runtime?: ModelRuntimeInfo;
}

export interface ModelRuntimeInfo {
  runtimeId: string;
  /** Absent for a runtime's original account. */
  accountId?: string;
  /** Group heading, e.g. `Claude Agent · work`. */
  label: string;
}

export interface RuntimeSubagentUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}
