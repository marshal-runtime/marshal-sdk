import type { ApprovalRequest } from "../approval-contract";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalDefaultPrompt(_request: ApprovalRequest, _ctx: PolicyContext): RuleResult {
  return { decision: "prompt", auditOutcome: undefined };
}

export const DEFAULT_PROMPT_RULE: PolicyRule = {
  id: "default-prompt",
  auditSource: "user-interactive",
  apply: applyMarshalDefaultPrompt,
};
