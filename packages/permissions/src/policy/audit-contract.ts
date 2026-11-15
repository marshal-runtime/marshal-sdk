// The audit record and its sink. The desktop's AuditLogger (electron/audit-log.ts) writes it to disk;
// any host can pass its own sink.
import type { PermissionAction } from "../common/marshal-constants";
import type { ApprovalRequest } from "./approval-contract";
import { getCommandText, getServerName, getToolName } from "./permission-policy";

export type AuditDecisionSource =
  | "pre-hook-disabled-server"
  | "pre-hook-tenant-policy"
  | "pre-hook-file-upload-disabled"
  | "pre-hook-blocked-tool"
  | "internal-auto-approve"
  | "policy-auto-approve"
  | "policy-auto-deny"
  | "policy-burst-defuser"
  | "policy-security-gate"
  | "user-interactive"
  | "timeout"
  | "no-window"
  | "no-callback-fallback";

export interface AuditLogEntry {
  /** ISO-8601 UTC timestamp */
  timestamp: string;
  /** Internal session ID */
  sessionId: string;
  /** GitHub username (cached from AuthStatus) */
  userLogin: string;
  /** SDK tool call ID — present for MCP tools only */
  toolCallId?: string;
  /** Permission kind */
  kind: string;
  /** Tool name (MCP tool name or "") */
  toolName: string;
  /** MCP server name or "" */
  serverName: string;
  /** Shell command text or "" */
  commandText: string;
  /** Final outcome */
  decision: "approved" | "denied";
  /** User's button choice (only for interactive decisions) */
  userAction?: PermissionAction;
  /** Where the decision was made */
  source: AuditDecisionSource;
  /** SDK-level result returned to the Copilot SDK */
  sdkResult: string;
  /**
   * Set on `always-allow` rows. `true` if a durable rule was written,
   * `false` if the pattern was unrepresentable (collapsed to `*`) and
   * the persistence layer short-circuited. Absent for other actions.
   */
  persistedRule?: boolean;
}

/** Fields required from callers — timestamp and identity are added by the logger. */
export type AuditLogInput = Omit<AuditLogEntry, "timestamp" | "userLogin">;

export interface AuditQueryFilters {
  sessionId?: string;
  kind?: string;
  decision?: "approved" | "denied";
  source?: AuditDecisionSource;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string; // YYYY-MM-DD
  toolName?: string;
}

/** Build an AuditLogInput from a ApprovalRequest and decision metadata. */
export function buildAuditInput(
  request: ApprovalRequest,
  decision: "approved" | "denied",
  source: AuditDecisionSource,
  sdkResult: string,
  userAction?: PermissionAction,
): AuditLogInput {
  const serverName = getServerName(request);
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    kind: request.kind,
    toolName: getToolName(request),
    serverName,
    commandText: getCommandText(request),
    decision,
    source,
    sdkResult,
    ...(userAction ? { userAction } : {}),
  };
}

/** Build an AuditLogInput for pre-hook / permissionHandler sites that lack a full ApprovalRequest. */
export function buildPreHookAuditInput(opts: {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  serverName: string;
  kind: string;
  decision: "approved" | "denied";
  source: AuditDecisionSource;
  sdkResult: string;
}): AuditLogInput {
  return {
    sessionId: opts.sessionId,
    toolCallId: opts.toolCallId,
    kind: opts.kind,
    toolName: opts.toolName,
    serverName: opts.serverName,
    commandText: "",
    decision: opts.decision,
    source: opts.source,
    sdkResult: opts.sdkResult,
  };
}

/** Where the policy writes audit rows. */
export interface AuditLogger {
  log(input: AuditLogInput): void;
}
