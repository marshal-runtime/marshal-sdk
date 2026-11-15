// Marshal's model provider layer (packages/providers/src), bundled into one module: the same source the Marshal
// desktop vendors, so a session runs on the same provider code in both.
export * from "../packages/providers/src/index";
// The desktop's permission request shape, so a host's permission handler sees the same request on every engine.
export type {
  RuntimePermissionHandler,
  RuntimePermissionRequest,
  RuntimePermissionResult,
} from "../packages/providers/src/backend/runtime-contract";
export { toClaudePermissionResult, toRuntimePermissionRequest } from "../packages/providers/src/backend/claude/permissions";
