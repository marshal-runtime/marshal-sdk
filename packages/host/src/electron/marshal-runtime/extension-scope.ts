import type {
  PermissionCheck,
  PermissionDecision,
  RuntimeSearchResponse,
} from "@marshal/runtime/core";

/**
 * A launched agent can be limited to a list of extensions (a profile). Only providers that are
 * installed extensions are limited: host and built-in providers (marshal.*, runtime.*, ui.*) are
 * what the agent needs to function and always stay visible.
 */
export type SessionExtensionScope = (sessionId: string) => readonly string[] | undefined;

export function hiddenByExtensionScope(
  providerId: string,
  scope: readonly string[] | undefined,
  installed: ReadonlySet<string>,
): boolean {
  return scope !== undefined && installed.has(providerId) && !scope.includes(providerId);
}

function entryExtension(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = metadata?.extension ?? metadata?.extensionIdentity;
  return typeof value === "string" ? value : undefined;
}

export function filterSearchByExtensionScope(
  response: RuntimeSearchResponse,
  scope: readonly string[] | undefined,
  installed: ReadonlySet<string>,
): RuntimeSearchResponse {
  if (scope === undefined) return response;
  return {
    ...response,
    matches: response.matches.filter(
      (match) => !hiddenByExtensionScope(match.capability.provider.id, scope, installed),
    ),
    ...(response.discoveries
      ? {
          discoveries: response.discoveries.filter((found) => {
            const owner = entryExtension(found.entry.metadata);
            return owner === undefined || !hiddenByExtensionScope(owner, scope, installed);
          }),
        }
      : {}),
  };
}

export function extensionScopeDecision(
  check: PermissionCheck,
  scope: readonly string[] | undefined,
  installed: ReadonlySet<string>,
): PermissionDecision | undefined {
  const providerId = check.capability.provider.id;
  if (!hiddenByExtensionScope(providerId, scope, installed)) return undefined;
  return {
    decision: "deny",
    code: "permission_denied",
    reason: `Extension ${providerId} is not part of this agent's profile.`,
  };
}
