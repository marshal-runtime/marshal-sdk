import type { MarshalRuntimeApi, MarshalRuntimeScope } from "../host-deps";

const INVOKE_PREFIX = "marshal.tool.invoke:";
const DECLARED_PREFIX = "runtime-extension:";

export interface StatusReadGrantDeps {
  search: MarshalRuntimeApi["search"];
  /** The enabled extension that registered a capability provider, or null. */
  ownerOfProvider: (providerId: string) => Promise<string | null>;
  allowTool: (sessionId: string, toolName: string) => void;
}

/**
 * Lets the onboarding status poll read one manifest-named status capability without a prompt, for this
 * session only. The capability must belong to an enabled extension the org manifest lists and declare nothing but
 * low-risk read permissions (an undeclared risk counts only for a `.read` permission). Anything else
 * returns false and the read stays forbidden.
 */
export function createStatusReadGrant(deps: StatusReadGrantDeps) {
  return async (
    scope: MarshalRuntimeScope,
    ownerIds: readonly string[],
    capability: string,
  ): Promise<boolean> => {
    const found = await deps.search({ ...scope, name: capability, detail: "full" });
    if (!found.ok) return false;
    const matches = found.value.matches.filter((match) => match.capability.name === capability);
    if (matches.length !== 1) return false;
    const descriptor = matches[0].capability;
    const extensionId = await deps.ownerOfProvider(descriptor.provider.id);
    if (!extensionId || !ownerIds.includes(extensionId)) return false;
    const permissions = descriptor.permissions ?? [];
    if (permissions.length === 0) return false;
    const toolNames: string[] = [];
    for (const entry of permissions) {
      const readOnly =
        entry.risk === "low" || (entry.risk === undefined && entry.permission.endsWith(".read"));
      if (!readOnly) return false;
      if (entry.permission.startsWith(INVOKE_PREFIX)) {
        if (entry.permission.slice(INVOKE_PREFIX.length) !== capability) return false;
        toolNames.push(capability);
      } else {
        toolNames.push(`${DECLARED_PREFIX}${extensionId}:${entry.permission}`);
      }
    }
    for (const toolName of toolNames) deps.allowTool(scope.sessionId, toolName);
    return true;
  };
}
