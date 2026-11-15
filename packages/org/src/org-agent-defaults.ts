import type { OrgAgentDefaults } from "./common/org-onboarding-agent-defaults";

/** Hands the org's `agentDefaults` to the session manager (`applyOrgAgentDefaults`: once, only unset values). */
export type ApplyOrgAgentDefaults = (defaults: OrgAgentDefaults) => unknown;
