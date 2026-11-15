// Permission management for a Marshal host: the desktop's permission engine (packages/permissions, the same
// source the Marshal desktop vendors) turned into the handler a session's model backend calls for every tool
// request. The person-facing part, a card or a message that waits for someone, is the host's: it plugs in
// through the approval port. Bundled into dist/src/permissions.js (see build.mjs).
import { randomUUID } from "node:crypto";

import {
  applyGuardrails,
  extractPattern,
  getCommandText,
  isReadOnlyCommand,
  normalizePermissionRequest,
  PermissionPolicy,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResult,
  type AuditLogger,
  type PermissionAction,
  type PermissionsConfig,
  type SessionPermissionMode,
  type SettingsManager,
  type TenantPolicyProvider,
} from "../packages/permissions/src/index";
import type {
  RuntimePermissionHandler,
  RuntimePermissionResult,
} from "../packages/providers/src/backend/runtime-contract";

export * from "../packages/permissions/src/index";

/** One request waiting on a person; the desktop's ApprovalBroker.requestPrompt takes the same shape. */
export interface PermissionPrompt {
  permissionRequest: ApprovalRequest;
  requestId: string;
  sessionId: string;
}

export type PermissionPromptResult =
  | { outcome: "resolved"; action: PermissionAction; silent?: boolean }
  | { outcome: "timed-out" };

/**
 * The host's way to ask a person: show a card, post to Slack, ping a phone. Resolves with the button they
 * pressed ("allow" once, "allow-session", "always-allow" writes a rule, "deny"), or timed-out.
 */
export interface PermissionApprovalPort {
  requestPrompt(prompt: PermissionPrompt): Promise<PermissionPromptResult>;
}

export interface MarshalPermissionsOptions {
  /**
   * "allow-all" (default) approves every tool request, as unattended SDK hosts do today. "policy" runs the
   * desktop's policy: rules, the shell classifier, sensitive paths, tenant blocks, and asks the approval port
   * when the policy says prompt.
   */
  mode?: "allow-all" | "policy";
  /** Starting permissions for "policy" when no settings store is given. Default: the desktop's defaults. */
  permissions?: PermissionsConfig;
  /** Host-owned settings store; "Always allow" writes granted rules back through it. */
  settings?: SettingsManager;
  /** Asks a person. Without it a "prompt" decision is denied (nobody is there to ask). */
  approval?: PermissionApprovalPort;
  audit?: AuditLogger;
  tenantPolicy?: TenantPolicyProvider;
  /** The session's workspace; reads and writes inside it follow the workspace rules. */
  workspaceDir?: string;
  getWorkspaceRootForSession?: (sessionId: string) => string | undefined;
  getPermissionMode?: (sessionId: string) => SessionPermissionMode;
  getKnownMcpKeys?: () => readonly string[];
}

export interface MarshalPermissions {
  mode: "allow-all" | "policy";
  /** The policy, in "policy" mode: per-session grants, entity permissions, deny-prompt sessions. */
  policy?: PermissionPolicy;
  /** The handler a model backend calls for each tool request (MarshalHostOptions.permissions.canUseTool). */
  canUseTool: RuntimePermissionHandler;
}

/** The desktop's DEFAULT_PERMISSIONS (common/marshal-default-settings.ts), minus its per-tool approvals. */
export const DEFAULT_POLICY_PERMISSIONS: PermissionsConfig = {
  autopilotMode: false,
  autoApproveReadOnly: false,
  allow: [],
  allowModelPermissionsChange: false,
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  },
};

/** A settings store held in memory, for hosts that don't persist permissions. */
export function createMemoryPermissionSettings(permissions: PermissionsConfig = DEFAULT_POLICY_PERMISSIONS): SettingsManager {
  let current: PermissionsConfig = structuredClone(permissions);
  return {
    get: () => ({ permissions: current }),
    update: (partial) => {
      if (partial.permissions) current = partial.permissions;
    },
  };
}

const APPROVE: RuntimePermissionResult = { kind: "approve-once" };
// The desktop's mapping (electron/backend/local/internal.ts APPROVAL_DECISION_TO_RUNTIME).
const DECISION_TO_RUNTIME: Record<ApprovalDecision, RuntimePermissionResult> = {
  approved: APPROVE,
  "denied-by-rules": { kind: "user-not-available" },
  "denied-interactively-by-user": { kind: "reject" },
};

function toRuntime(result: ApprovalResult): RuntimePermissionResult {
  return typeof result === "string" ? DECISION_TO_RUNTIME[result] : { kind: "reject", feedback: result.feedback };
}

const APPROVING_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  "allow",
  "allow-type",
  "allow-all",
  "allow-session",
  "always-allow",
]);

export function createMarshalPermissions(options: MarshalPermissionsOptions = {}): MarshalPermissions {
  const mode = options.mode ?? "allow-all";
  if (mode === "allow-all") return { mode, canUseTool: () => APPROVE };

  const policy = new PermissionPolicy({
    settingsManager: options.settings ?? createMemoryPermissionSettings(options.permissions),
    tenantPolicy: options.tenantPolicy,
    workspaceDir: options.workspaceDir,
    getWorkspaceRootForSession: options.getWorkspaceRootForSession,
    getPermissionMode: options.getPermissionMode,
    getKnownMcpKeys: options.getKnownMcpKeys,
  });
  if (options.audit) policy.setAuditLogger(options.audit);
  const approval = options.approval;

  // The decision flow of the desktop's approval adapter (electron/backend/local/approval-adapter.ts), without
  // its background LLM classifier.
  async function decide(request: ApprovalRequest): Promise<ApprovalResult> {
    const evaluation = policy.evaluateDetailed(request);
    if (evaluation.decision === "approve") return "approved";
    if (evaluation.decision === "deny") {
      return evaluation.denyReason ? { kind: "denied-by-policy-with-feedback", feedback: evaluation.denyReason } : "denied-by-rules";
    }
    if (!approval) {
      policy.logInfraFailure(request, "no-window");
      return "denied-by-rules";
    }
    if (request.kind === "shell") {
      const command = getCommandText(request);
      if (command) {
        const gated = applyGuardrails(
          command,
          {
            explanation: "",
            category: "unknown",
            suggestedPattern: extractPattern(command),
            patternRationale: null,
            source: "fallback",
            guardrailRuleId: null,
          },
          { isReadOnlyCommand },
        );
        if (gated.suggestedPattern) request.approvalPattern = gated.suggestedPattern;
      }
    }
    const result = await approval.requestPrompt({
      permissionRequest: request,
      requestId: `perm-${randomUUID()}`,
      sessionId: request.sessionId,
    });
    if (result.outcome === "timed-out") {
      policy.logInfraFailure(request, "timeout");
      return "denied-by-rules";
    }
    const approved = APPROVING_ACTIONS.has(result.action);
    const decision: ApprovalDecision = approved ? "approved" : "denied-interactively-by-user";
    if (!result.silent) {
      const accepted = policy.recordInteractiveOutcome(request, result.action, decision);
      if (approved && !accepted) return "denied-by-rules";
    } else if (approved && policy.evaluate(request) === "deny") {
      return "denied-by-rules";
    }
    return decision;
  }

  return {
    mode,
    policy,
    canUseTool: async (incoming, { sessionId }) => {
      const request: ApprovalRequest = { id: randomUUID(), sessionId, ...normalizePermissionRequest(incoming) };
      return toRuntime(await decide(request));
    },
  };
}
