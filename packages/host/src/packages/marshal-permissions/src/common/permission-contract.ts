// Permission settings and reviewer-session scope, moved from the desktop's IPC contract (which re-exports them).
export { PERMISSION_KIND_TUPLE, type PermissionKind } from "../../host-deps";

export type SessionPermissionMode = "default" | "allow-all" | "read-only-reviewer";
export type ReviewerSessionPermissionMode = Extract<SessionPermissionMode, "read-only-reviewer">;
export const REVIEWER_SESSION_PERMISSION_MODE: ReviewerSessionPermissionMode = "read-only-reviewer";

/** A reviewer may run whatever a regular session runs without asking, provided
 *  it changes nothing: shell, network, and credentials are limited to the
 *  commands the shared read-only classifier auto-approves (git log, cat, gh pr view). */
export interface ReviewerSessionCapabilities {
  readonly permissionMode: ReviewerSessionPermissionMode;
  readonly networkAccess: "read-only";
  readonly credentialAccess: "read-only";
  readonly validationExecution: "dedicated";
  readonly shellAccess: "read-only";
}

export const REVIEWER_SESSION_CAPABILITIES: ReviewerSessionCapabilities = Object.freeze({
  permissionMode: REVIEWER_SESSION_PERMISSION_MODE,
  networkAccess: "read-only",
  credentialAccess: "read-only",
  validationExecution: "dedicated",
  shellAccess: "read-only",
});

export interface ReviewerSessionPermissionScope extends ReviewerSessionCapabilities {
  role: "reviewer";
  /** The session whose goal is under review. Reads outside the workspace follow
   *  that session's read reach (its folder grants, or everything under allow-all). */
  sourceSessionId?: string;
  workspaceName?: string;
  repoPath?: string;
  /** Required literal: reviewer sessions never inherit a parent `allow-all` mode. */
  permissionMode: ReviewerSessionPermissionMode;
  allowedTools: string[];
  folderGrants: { read: string[]; write: string[] };
  skills: string[];
  mcp: string[];
  verificationRoot: string;
}

export interface ServerPermission {
  enabled: boolean;
  autoApprove: boolean;
}

export interface PermissionsConfig {
  /**
   * When true, user-allowable permission requests from agents and subagents are
   * auto-approved through the normal policy pipeline. Tenant/org hard blocks
   * and force-prompt policy still take precedence.
   */
  autopilotMode?: boolean;
  autoApproveReadOnly: boolean;
  allow: string[];
  /**
   * Per-session deny list for shell commands. Applied after server-level
   * `autoApprove` checks (policy step 5), so a server configured with
   * `autoApprove: true` is immune. When a deny pattern fires it supersedes
   * any allow-pattern that would otherwise match — use this to carve safety
   * holes inside a broad allow rule, e.g. allow `gh api repos/foo/*` but deny
   * `gh api * -X*` to block method-changing flag smuggling.
   *
   * Read-kind requests bypass this (they're handled at policy step 3).
   */
  denyPatterns?: string[];
  /**
   * When true, the AI may call requestPermissionEscalation to propose
   * permission changes — each requires explicit user approval via consent card.
   * Default false (opt-in).
   */
  allowModelPermissionsChange?: boolean;
  /**
   * User-granted exceptions to the sensitive-path denylist (step 4.5 of the
   * permission pipeline). Entries are exact absolute file paths written by
   * "Always allow" on the permission card, or glob patterns added manually in
   * Settings (e.g. `~/.ssh/*`). Checked by `checkSensitivePath()`.
   */
  allowedSensitivePaths?: string[];
  /**
   * Folders OUTSIDE the workspace the user granted SDK read access to, as
   * normalized absolute directory prefixes. A read whose resolved path is the
   * folder or nested under it auto-approves (FOLDER_GRANT_RULE). Written by
   * "Always allow this folder" on a read card; managed in Settings → Folder
   * access. Independent from write grants.
   */
  allowedReadFolders?: string[];
  /** Folders OUTSIDE the workspace granted SDK write access. See allowedReadFolders. */
  allowedWriteFolders?: string[];
  tools: Record<string, boolean>;
  /**
   * Snapshot of per-tool states before a group toggle enabled all tools.
   * Used to restore the previous partial state when the group is toggled off.
   */
  previousTools?: Record<string, Record<string, boolean>>;
  servers: Record<string, ServerPermission>;
}
