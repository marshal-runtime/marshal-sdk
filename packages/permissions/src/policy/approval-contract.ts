// The approval vocabulary and the policy's ports, moved from the desktop's electron/backend/types.ts and
// electron/backend/ports.ts (which re-export them).
import type { PermissionAction } from "../common/marshal-constants";
import type {
  ReviewerValidationAuthorizationResult,
  ReviewerValidationCommandSpec,
  ReviewerValidationPermissionRequest,
  ReviewerValidationReceipt,
  ReviewerValidationRequest,
} from "../common/goal-infrastructure-contract";
import type { PermissionDecision, PolicyEvaluation } from "./permission-policy";
import type { NormalizedPermissionRequest } from "./permission-request-types";

// ── Approval ────────────────────────────────────────────────────────────


/**
 * A fully-typed permission request: the normalized discriminated union plus
 * identity fields.
 */
export type ApprovalRequest = NormalizedPermissionRequest & {
  id: string;
  sessionId: string;
  /** Set by the local approval adapter / permission-card-manager after construction. */
  approvalPattern?: string;
};

/** Marshal-owned approval vocabulary; each backend translates at its own boundary. */
export type ApprovalDecision = "approved" | "denied-by-rules" | "denied-interactively-by-user";

/**
 * A policy/security hard-deny that carries an actionable, model-facing reason.
 * The CopilotBackend translates this to the SDK's `reject` result with
 * `feedback`, so the model sees WHY it was blocked (and that it should not
 * retry/work around it) instead of the generic "could not request permission
 * from user" message reserved for genuine no-approver situations.
 */
export type PolicyDenyWithFeedback = {
  kind: "denied-by-policy-with-feedback";
  feedback: string;
};

export type ApprovalResult = ApprovalDecision | PolicyDenyWithFeedback;

export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalResult>;

/**
 * Subset of `PermissionPolicy` that the adapter consults: evaluate the
 * auto-approve / auto-deny pipeline, record the user's interactive outcome
 * for audit, and log infrastructure-level failures (no-window, timeout).
 */
export interface IPermissionPolicy {
  evaluate(request: ApprovalRequest): PermissionDecision;
  /**
   * Optional richer evaluation: same decision as {@link evaluate} plus a
   * model-facing `denyReason` for hard `deny` outcomes. The CopilotBackend
   * adapter prefers this (falling back to {@link evaluate}) so policy denials
   * surface an accurate, actionable message instead of "could not request
   * permission from user". Optional so gateway-side doubles need not implement it.
   */
  evaluateDetailed?(request: ApprovalRequest): PolicyEvaluation;
  recordInteractiveOutcome(
    request: ApprovalRequest,
    action: PermissionAction,
    decision: ApprovalDecision,
  ): boolean;
  logInfraFailure(request: ApprovalRequest, source: "no-window" | "timeout"): void;
}

/** Dedicated validation executor resolves registry IDs; requests never carry raw commands. */
export interface IReviewerValidationExecutorPort {
  getCommandSpec(commandId: string): Promise<ReviewerValidationCommandSpec | null>;
  executeValidation(request: ReviewerValidationRequest): Promise<ReviewerValidationReceipt>;
}

/** Synchronous permission precheck; the async executor still revalidates and claims. */
export interface IReviewerValidationAuthorizationPort {
  authorizeReviewerValidation(
    sessionId: string,
    request: ReviewerValidationPermissionRequest,
  ): ReviewerValidationAuthorizationResult;
}

/** Shape of the old-vs-new diff passed to the permissions escalation card.
 *  Only fields that actually change are present. `tools.changed` contains only
 *  the entries being modified, not the full tools map. */
export interface PermissionsEscalationDiff {
  allow?: { from: string[]; to: string[] };
  autoApproveReadOnly?: { from: boolean; to: boolean };
  tools?: { changed: Record<string, { from: boolean; to: boolean }> };
  servers?: Record<string, { autoApprove: { from: boolean; to: boolean } }>;
  /** `forget { completely: true }`: the user's own memory text, shown only on their card. */
  forgetCompletely?: { memoryText: string };
}
