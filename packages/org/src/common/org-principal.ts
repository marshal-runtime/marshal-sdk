const USER_PRINCIPAL_PREFIX = "user:";

/** How a person's organization principal reads to people: `user:dana@zyg.com` shows as `dana@zyg.com`. */
export function orgPrincipalLabel(principal: string): string {
  return principal.startsWith(USER_PRINCIPAL_PREFIX)
    ? principal.slice(USER_PRINCIPAL_PREFIX.length)
    : principal;
}
