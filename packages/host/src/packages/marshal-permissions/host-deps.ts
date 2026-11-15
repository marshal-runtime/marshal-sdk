// The permission engine's only imports from outside src: the desktop's copy of the provider layer.
// marshal-sdk carries the same file pointing at its packages/providers. Not part of the vendored src tree.
export { createLogger } from "../marshal-providers/src/common/marshal-logger";
export {
  canonicalizeFirstPartyPermissionKey,
  expandLegacyFirstPartyPermissionPattern,
  FIRST_PARTY_TOOL_NAMES,
} from "../marshal-providers/src/common/tool-names";
export { GIT_SAFE_ALIAS_SUBCOMMANDS } from "../marshal-providers/src/backend/local/git-safe-aliases";
export {
  PERMISSION_KIND_TUPLE,
  type PermissionKind,
} from "../marshal-providers/src/contract/host-types";
export {
  getBarePlaywrightToolName,
  isBrowserCodeExecutionTool,
  PLAYWRIGHT_CODE_EXECUTION_TOOLS,
  PLAYWRIGHT_EXPLICIT_WRITE_TOOLS,
} from "../marshal-providers/src/support/platform/security/browser-tools/names";
