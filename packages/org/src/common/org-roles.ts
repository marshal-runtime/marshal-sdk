import type { OrgMentionRole } from "../contract/org-types";

export type OrgSessionRole = "viewer" | "collaborator" | "driver" | "owner";

const ROLE_ORDER: readonly OrgSessionRole[] = ["viewer", "collaborator", "driver", "owner"];

/** Roles ordered from least to most access, excluding `owner`, which no grant can carry. */
export const ORG_GRANTABLE_ROLES: readonly OrgMentionRole[] = ["viewer", "collaborator", "driver"];

export function isGrantableRole(value: unknown): value is OrgMentionRole {
  return typeof value === "string" && (ORG_GRANTABLE_ROLES as readonly string[]).includes(value);
}

/**
 * The roles a person may hand out: nobody below `collaborator` may grant, and a grant never exceeds
 * the granter's own role. `owner` is never grantable.
 */
export function grantableRoles(callerRole: OrgSessionRole): OrgMentionRole[] {
  const rank = ROLE_ORDER.indexOf(callerRole);
  if (rank < ROLE_ORDER.indexOf("collaborator")) return [];
  return ORG_GRANTABLE_ROLES.filter((role) => ROLE_ORDER.indexOf(role) <= rank);
}
