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
export { createLocalRuntimeCapabilities } from "../packages/providers/src/backend/local/capabilities";
export { getRuntimeMetadata } from "../packages/providers/src/common/runtime-config";
export { detectModelProviderFamily, type ModelProviderFamily } from "../packages/providers/src/common/model-runtime-routing";
export {
  CURSOR_ACCOUNT_IDENTITY_PREFIX,
  CURSOR_DEFAULT_MODEL_ID,
  CURSOR_PREFERRED_MODEL_IDS,
  CURSOR_SESSION_CONFIG_TRACE_FILENAME,
} from "../packages/providers/src/backend/cursor/constants";
// The Antigravity client itself, for an embedder that drives sessions without the engine (and the tests).
export { AntigravityRuntimeClient } from "../packages/providers/src/backend/antigravity/client";
export {
  ANTIGRAVITY_ACCOUNT_IDENTITY_PREFIX,
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  ANTIGRAVITY_PREFERRED_MODEL_IDS,
  ANTIGRAVITY_SESSION_CONFIG_TRACE_FILENAME,
} from "../packages/providers/src/backend/antigravity/constants";
