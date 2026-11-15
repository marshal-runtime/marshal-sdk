// The Marshal SDK's side of the session engine's host contract. The engine (packages/providers/src/backend)
// is the desktop's code; the types it shares with the desktop's IPC contract and service ports live in the
// desktop, so here they are open shapes until each one moves into the shared contract (docs/engine.md).
// The desktop keeps its own copy of this file that re-exports its real types; this folder is not vendored.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RuntimeTool } from "../src/backend/runtime-contract";

type HostShape = any;
type HostFunction = (...args: any[]) => any;

export interface AppMcpBrokerManager {
  dispose(): Promise<void>;
  [member: string]: HostShape;
}
export type AutomationCreateInput = HostShape;
export type AutomationData = HostShape;
export type AutomationRunData = HostShape;
export type BackendCapabilities = HostShape;
export type BackendOrigin = HostShape;
export type CommandClassification = HostShape;
export type ConditionStatusRecord = HostShape;
export type CustomMcpServer = HostShape;
export type GatewayAuthIdentity = HostShape;
export type GatewayAuthState = HostShape;
export type HeartbeatControllableMap = HostShape;
export type HeartbeatSettings = HostShape;
export type HeartbeatSettingsEnvelope = HostShape;
export type HeartbeatStatus = HostShape;
export type HeartbeatStatusEnvelope = HostShape;
export type IApprovalBroker = HostShape;
export type IBackgroundToolInvocationManager = HostShape;
export type ICommandClassifier = HostShape;
export type IPermissionPolicy = HostShape;
export type ISelfToolDeps = HostShape;
export type IpcEventMap = HostShape;
export type IpcHandler<_Channel = unknown> = HostShape;
export type IpcInvokeMap = HostShape;
export type MSettings = HostShape;
export type MainSessionWorkspaceBinding = HostShape;
export type MarshalPromptFiles = HostShape;
export type McpServerInfo = HostShape;
export type NormalizedPermissionRequest = HostShape;
export type PermissionsConfig = HostShape;
export type PermissionsControllableMap = HostShape;
export type PermissionsEnvelope = HostShape;
export type PolicyEvaluation = HostShape;
export type RepositoryAgentIdentity = HostShape;
export type SessionHydrationEvent = HostShape;
export type SessionMessage = HostShape;
export type SessionMetadata = HostShape;
export type SessionRepositoryAgent = HostShape;
export type SessionRuntimeAgentRole = HostShape;
export type SessionSource = HostShape;
export type StoredSession = HostShape;
export type WorkspaceConfigPort = HostShape;
export type WorkspaceInstanceIdentity = HostShape;

export interface EngineHostServices {
  app: { getVersion(): string; readonly isPackaged: boolean };
  APP_NAME: HostShape;
  DEFAULT_PERMISSIONS: HostShape;
  sessionErrors: HostShape;
  AskUserToolResultSchema: {
    safeParse(value: unknown):
      | { success: true; data: { question: string; answers: Array<{ title: string; description?: string }>; recommendedIndex?: number } }
      | { success: false; error: { message: string } };
  };
  NEVER_BACKGROUND_TOOL_NAMES: HostShape;
  applyGuardrails: HostFunction;
  backgroundToolObservation: (toolName: string, handle: string) => string;
  buildMcpConfig: HostFunction;
  buildUserPromptContext: HostFunction;
  describeRequestCompaction: HostFunction;
  describeSessionViews: HostFunction;
  extractPattern: HostFunction;
  getActiveWorkspaceRoot: HostFunction;
  getAppDataDir: () => string;
  getCommandText: HostFunction;
  getSelfFsTools: HostFunction;
  getSelfTools: (deps: HostShape, sessionId?: string) => RuntimeTool[];
  getSessionClientViewport: HostFunction;
  isReadOnlyCommand: HostFunction;
  loadMcpBrokerManager: HostFunction;
  makeSessionError: HostFunction;
  normalizeDiscoveredModels: HostFunction;
  normalizePermissionRequest: HostFunction;
  resolveSessionToolAllowlist: HostFunction;
  runToolWithBackgrounding: <T>(opts: {
    manager: HostShape;
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    enableAbortSignal?: boolean;
    run: (signal: AbortSignal | undefined, attachProcess?: HostShape) => Promise<T>;
    detachedResult: (detached: { handle: string }) => T;
  }) => Promise<T>;
  sanitizeForTelemetry: HostFunction;
  secureAppendFile: HostFunction;
  secureMkdir: HostFunction;
  secureMkdirSync: HostFunction;
  secureWriteFileSync: HostFunction;
  sendErrorTelemetry: HostFunction;
  takeSessionMentionContext: HostFunction;
  takeSharedSessionContext: HostFunction;
}

