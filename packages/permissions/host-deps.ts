// The permission engine's only imports from outside packages/permissions/src. Each repo that carries the
// package points these at its copy of the provider layer: marshal-sdk at packages/providers, the desktop at
// packages/marshal-providers. Not part of the vendored src tree.
export { createLogger } from "../providers/src/common/marshal-logger";
export {
  canonicalizeFirstPartyPermissionKey,
  expandLegacyFirstPartyPermissionPattern,
  FIRST_PARTY_TOOL_NAMES,
} from "../providers/src/common/tool-names";
export { GIT_SAFE_ALIAS_SUBCOMMANDS } from "../providers/src/backend/local/git-safe-aliases";
export { PERMISSION_KIND_TUPLE, type PermissionKind } from "../providers/src/contract/host-types";
