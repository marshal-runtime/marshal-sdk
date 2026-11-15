import {
  OrgApiError,
  OrgContractError,
  OrgFeatureUnavailableError,
} from "@marshal/agent-runtime-org";

import { OrgNotSignedInError } from "./org-service";

export interface OrgFailure {
  /** A short code safe to show and to log: never a message that could carry content. */
  code: string;
  /** Worth retrying later without the person doing anything. */
  transient: boolean;
  status?: number;
}

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function classifyOrgFailure(error: unknown): OrgFailure {
  if (error instanceof OrgNotSignedInError) return { code: "not-signed-in", transient: true };
  if (error instanceof OrgFeatureUnavailableError) {
    return { code: "feature-unavailable", transient: false };
  }
  if (error instanceof OrgContractError) return { code: error.code, transient: false };
  if (error instanceof OrgApiError) {
    const code = CODE_PATTERN.test(error.code) ? error.code : "request-failed";
    const transient = error.status === 0 || error.status === 408 || error.status === 429;
    return { code, status: error.status, transient: transient || error.status >= 500 };
  }
  return { code: "request-failed", transient: false };
}
