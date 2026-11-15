// The Marshal SDK's side of the session engine's host contract. The engine (packages/providers/src/backend)
// is the desktop's code; the types it shares with the desktop's IPC contract and service ports live in the
// desktop, so here they are open shapes until each one moves into the shared contract (docs/engine.md).
// The desktop keeps its own copy of this file that re-exports its real types; this folder is not vendored.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RuntimeTool } from "../src/backend/runtime-contract";

// The permission engine is a package of this repository: these types are its own.
export type {
  ApprovalCallback,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResult,
  IPermissionPolicy,
  PolicyDenyWithFeedback,
} from "../../permissions/src/policy/approval-contract";
export type { CommandClassification } from "../../permissions/src/policy/permission-classification-contracts";
export type { PolicyEvaluation } from "../../permissions/src/policy/permission-policy";
export type { NormalizedPermissionRequest } from "../../permissions/src/policy/permission-request-types";

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
export type ISelfToolDeps = HostShape;
export type IpcEventMap = HostShape;
export type IpcHandler<_Channel = unknown> = HostShape;
export type IpcInvokeMap = HostShape;
export type MSettings = HostShape;
export type MainSessionWorkspaceBinding = HostShape;
export type MarshalPromptFiles = HostShape;
export type McpServerInfo = HostShape;
export type PermissionsConfig = HostShape;
export type PermissionsControllableMap = HostShape;
export type PermissionsEnvelope = HostShape;
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

// SessionManager's host types.
export type CommandCenterSafeBackendEvent<_A = any, _B = any, _C = any> = HostShape;
export type GoalContextPatch<_A = any, _B = any, _C = any> = HostShape;
export type GoalDefinitionPatch<_A = any, _B = any, _C = any> = HostShape;
export type GoalFence<_A = any, _B = any, _C = any> = HostShape;
export type GoalRecord<_A = any, _B = any, _C = any> = HostShape;
export type GoalRuntimeSnapshot<_A = any, _B = any, _C = any> = HostShape;
export type GoalState<_A = any, _B = any, _C = any> = HostShape;
export type GoalTransitionProposal<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageApiResult<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageQueueCancellationResult<_A = any, _B = any, _C = any> = HostShape;
export type GoalTimelineEvent<_A = any, _B = any, _C = any> = HostShape;
export type MainSessionContextSelection<_A = any, _B = any, _C = any> = HostShape;
export type MessageQuestion<_A = any, _B = any, _C = any> = HostShape;
export type ModelInfo<_A = any, _B = any, _C = any> = HostShape;
export type ModelRuntimeInfo<_A = any, _B = any, _C = any> = HostShape;
export type PermissionCardData<_A = any, _B = any, _C = any> = HostShape;
export type ContextTier<_A = any, _B = any, _C = any> = HostShape;
export type ReasoningEffort<_A = any, _B = any, _C = any> = HostShape;
export type CreateFromNativeStateError<_A = any, _B = any, _C = any> = HostShape;
export type SessionListOptions<_A = any, _B = any, _C = any> = HostShape;
export type SessionListPage<_A = any, _B = any, _C = any> = HostShape;
export type SessionAgentMessageMetadata<_A = any, _B = any, _C = any> = HostShape;
export type SessionInternalControlMetadata<_A = any, _B = any, _C = any> = HostShape;
export type MessageToolCall<_A = any, _B = any, _C = any> = HostShape;
export type ReviewerSessionPermissionScope<_A = any, _B = any, _C = any> = HostShape;
export type SessionPermissionMode<_A = any, _B = any, _C = any> = HostShape;
export type SessionSandboxConfig<_A = any, _B = any, _C = any> = HostShape;
export type SessionSearchResult<_A = any, _B = any, _C = any> = HostShape;
export type SessionView<_A = any, _B = any, _C = any> = HostShape;
export type SessionViewEvent<_A = any, _B = any, _C = any> = HostShape;
export type TurnEvent<_A = any, _B = any, _C = any> = HostShape;
export type Skill<_A = any, _B = any, _C = any> = HostShape;
export type RequestOrigin<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageDeliveryContext<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageDeliveryMode<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageDeliveryResult<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageKind<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageOutbox<_A = any, _B = any, _C = any> = HostShape;
export type AgentMessageRecord<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolCancellationRequest<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolCancellationRequestToken<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolDispatchClaim<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolDispatchClaimRequest<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolDispatchClaimResult<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolInvocationCompletion<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolInvocationRegistrationResult<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolInvocationStart<_A = any, _B = any, _C = any> = HostShape;
export type BackgroundToolProcessAttachment<_A = any, _B = any, _C = any> = HostShape;
export type IGoalToolsManager<_A = any, _B = any, _C = any> = HostShape;
export type ForkSubagentTask<_A = any, _B = any, _C = any> = HostShape;
export type IMemoryManager<_A = any, _B = any, _C = any> = HostShape;
export type ISelfToolsSessionManager<_A = any, _B = any, _C = any> = HostShape;
export type RunningToolCallInfo<_A = any, _B = any, _C = any> = HostShape;
export type RunningToolCancelResult<_A = any, _B = any, _C = any> = HostShape;
export type RunningToolCancellationScope<_A = any, _B = any, _C = any> = HostShape;
export type RunningToolInspectResult<_A = any, _B = any, _C = any> = HostShape;
export type TranscriptHandoffReason<_A = any, _B = any, _C = any> = HostShape;
export type CommandCenterSessionObserver<_A = any, _B = any, _C = any> = HostShape;
export type KnowledgeAvailability<_A = any, _B = any, _C = any> = HostShape;
export type McpStore<_A = any, _B = any, _C = any> = HostShape;
export type PermissionPolicy<_A = any, _B = any, _C = any> = HostShape;
export type ExtensionPromptContribution<_A = any, _B = any, _C = any> = HostShape;
export type RequestSessionSnapshot<_A = any, _B = any, _C = any> = HostShape;
export type RequestStoredMessage<_A = any, _B = any, _C = any> = HostShape;
export type LiveSessionInfo<_A = any, _B = any, _C = any> = HostShape;
export type SelfToolDeps<_A = any, _B = any, _C = any> = HostShape;
export type ISessionStore<_A = any, _B = any, _C = any> = HostShape;
export type Message<_A = any, _B = any, _C = any> = HostShape;
export type PendingModelSwitch<_A = any, _B = any, _C = any> = HostShape;
export type PersistedSession<_A = any, _B = any, _C = any> = HostShape;
export type ReadonlySessionsIndex<_A = any, _B = any, _C = any> = HostShape;
export type SessionForkRecord<_A = any, _B = any, _C = any> = HostShape;
export type SessionProgressRecord<_A = any, _B = any, _C = any> = HostShape;
export type SessionsIndex<_A = any, _B = any, _C = any> = HostShape;
export type RuntimeTranscriptRequest<_A = any, _B = any, _C = any> = HostShape;
export type RuntimeTranscriptPage<_A = any, _B = any, _C = any> = HostShape;
export type SkillCatalog<_A = any, _B = any, _C = any> = HostShape;
export type TenantPolicyProvider<_A = any, _B = any, _C = any> = HostShape;
export type MidgardError<_A = any, _B = any, _C = any> = HostShape;
export type TelemetryCallbacks<_A = any, _B = any, _C = any> = HostShape;
export type TurnLlmUsageEvent<_A = any, _B = any, _C = any> = HostShape;
export type AssistantContentBlock<_A = any, _B = any, _C = any> = HostShape;
export type ToolProvenanceRecord<_A = any, _B = any, _C = any> = HostShape;
export type TurnState<_A = any, _B = any, _C = any> = HostShape;
export type TurnToolCompletedEvent<_A = any, _B = any, _C = any> = HostShape;
export type TurnToolsUpdatedEvent<_A = any, _B = any, _C = any> = HostShape;
export type SoulPreset<_A = any, _B = any, _C = any> = HostShape;
export type Binding<_A = any, _B = any, _C = any> = HostShape;
export type BindingsFile<_A = any, _B = any, _C = any> = HostShape;
export type RunSnapshot<_A = any, _B = any, _C = any> = HostShape;
export type TriggeredBy<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowManifest<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowArtifactSummary<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowJSONSchema<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowRendererBundle<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowRunStatus<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowScheduleSummary<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowStateCompactionResult<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowStateClearRequest<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowStateClearResult<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowStateEntrySummary<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowStateValueSnapshot<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowActionCenterItem<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowActionDispatchRequest<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowActionDispatchResult<_A = any, _B = any, _C = any> = HostShape;
export type WorkflowNotificationApprovalRequest<_A = any, _B = any, _C = any> = HostShape;
export type ErrorFamily<_A = any, _B = any, _C = any> = HostShape;
export type ToolActivityKind<_A = any, _B = any, _C = any> = HostShape;

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
  DEFAULT_SESSION_NAME: HostShape;
  isHiddenInternalControlMessage: HostShape;
  isToolFreeRuntimeAgentRole: HostShape;
  isVisibleInternalControlResponse: HostShape;
  describeAgentMessageSendTime: HostShape;
  isAgentMessageDeliveryControlError: HostShape;
  clearAvatarCache: HostShape;
  buildImportedConversationState: HostShape;
  buildTranscriptConversationState: HostShape;
  reconcileWithTranscript: HostShape;
  BusySessionTracker: HostShape;
  getMcpStatus: HostShape;
  assembleMarshalSystemPrompt: HostShape;
  isAgentPromptV2Session: HostShape;
  isLeanCoreSession: HostShape;
  isLeanPromptSession: HostShape;
  isLeanRepoRulesSession: HostShape;
  LEAN_PROMPT_DISABLED_NATIVE_TOOLS: HostShape;
  resolveAgentPromptV2ForNewSession: HostShape;
  resolveLeanCoreForNewSession: HostShape;
  resolveLeanPromptForNewSession: HostShape;
  resolveLeanRepoRulesForNewSession: HostShape;
  SPAWN_ONLY_SKILL_NAMES: HostShape;
  assembleMarshalSystemPromptV2: HostShape;
  V2_DISABLED_NATIVE_TOOLS: HostShape;
  V2_DEFERRED_HOST_TOOLS: HostShape;
  V2_EXPOSED_HOST_TOOLS: HostShape;
  V2_NATIVE_SUBAGENT_ALLOWLIST: HostShape;
  searchSessions: HostShape;
  isSessionHiddenFromList: HostShape;
  isSessionHiddenFromSearchAndDelete: HostShape;
  LocalSessionStore: HostShape;
  readRuntimeTranscript: HostShape;
  STUCK_TIMEOUT_MS: HostShape;
  createSkillCatalog: HostShape;
  getSkillsForSystemPrompt: HostShape;
  ViewEmissionManager: HostShape;
  getWorkspaceRegistry: HostShape;
  getWorkspaceRoot: HostShape;
  listRegisteredWorkspaces: HostShape;
  normalizePathForCompare: HostShape;
  registerExistingWorkspace: HostShape;
  registerManagedWorkspace: HostShape;
  resolveRegisteredWorkspace: HostShape;
  validateWorkspaceName: HostShape;
  workspaceDisplayName: HostShape;
  applyRuntimeAgentStrategy: HostShape;
  buildSdkDefaultSubagentSystemContent: HostShape;
  buildSystemMessage: HostShape;
  getSoulGreeting: HostShape;
  buildRelayAttentionSection: HostShape;
  buildSoulPrompt: HostShape;
  formatBundledWorkspaceFile: HostShape;
}
