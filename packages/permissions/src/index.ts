// Marshal's permission engine: the policy that decides every tool request (approve, deny, or ask a person),
// its rules, the 3-tier shell classifier, path and credential guards, and the audit record. The Marshal
// desktop vendors this tree (packages/marshal-permissions/src) and runs the same code; the person-facing
// approval UI stays with each host.

export {
  PermissionPolicy,
  ReviewerToolPolicy,
  denyReasonForRule,
  getCommandText,
  getPermissionKey,
  getServerName,
  getToolName,
  isReadOnlyCommand,
  isReadOnlyCustomTool,
  isUnattendedSafeCustomTool,
  type PermissionDecision,
  type PolicyEvaluation,
} from "./policy/permission-policy";
export { POLICY_PRE_HOOK_RULES, type PolicyContext, type PreHookDeny } from "./policy/permission-policy-checks";
export { POLICY_RULES } from "./policy/policy-rules/index";
export type { PolicyRule, RuleResult } from "./policy/policy-rules/types";
export { classifyShellCommand, type ClassifierDeps, type InferFn } from "./policy/permission-classifier";
export type { CommandClassification } from "./policy/permission-classification-contracts";
export { applyGuardrails } from "./policy/permission-pattern-guardrails";
export { extractPattern, extractPatterns, getPatternKey, matchesAllowPattern, matchesDenyPattern, splitShellSegments } from "./policy/permission-patterns";
export { checkSensitivePath, type SensitivePathHit } from "./policy/sensitive-path-permission-guard";
export { hasRemoteAuthVector } from "./policy/remote-auth-permission-guard";
export { grantFolderForPath, isPathWithinDir } from "./policy/permission-path-scope";
export { normalizePermissionRequest, type NormalizerResolvers } from "./policy/permission-request-normalizer";
export type { NormalizedPermissionRequest } from "./policy/permission-request-types";
export type {
  ApprovalCallback,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResult,
  IPermissionPolicy,
  PolicyDenyWithFeedback,
} from "./policy/approval-contract";
export {
  buildAuditInput,
  buildPreHookAuditInput,
  type AuditDecisionSource,
  type AuditLogEntry,
  type AuditLogger,
  type AuditLogInput,
} from "./policy/audit-contract";
export type { SettingsManager, TenantPolicy, TenantPolicyProvider } from "./policy/host-contract";
export type { PermissionAction } from "./common/marshal-constants";
export type { PermissionKind, PermissionsConfig, ServerPermission, SessionPermissionMode } from "./common/permission-contract";
