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

// The session engine: the desktop's local session backend (create, resume, send, steer, compact, tool and
// permission wiring, event normalization) over any provider client. A host configures its ports once with
// configureEngineHost and then constructs a LocalBackend per runtime, as the desktop does.
export {
  app as engineApp,
  configureEngineHost,
  isEngineHostConfigured,
  type EngineHostServices,
} from "../packages/providers/src/backend/engine-host";
export { LocalBackend } from "../packages/providers/src/backend/local/provider";
export { LocalSessionBackend } from "../packages/providers/src/backend/local/session";
export type { LocalRuntimeStrategy } from "../packages/providers/src/backend/local/strategy";
export { normalizeEvent } from "../packages/providers/src/backend/normalize-event";
export type {
  BackendEvent,
  CreateSessionOpts,
  ISessionBackend,
  SessionHandle,
} from "../packages/providers/src/backend/types";
