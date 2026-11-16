/**
 * IPC Contract — single source of truth for all IPC types.
 *
 * Domain types, invoke-channel signatures, event-channel payloads,
 * and namespace API interfaces used by both main and renderer processes.
 */

import {
  REVIEWER_SESSION_CAPABILITIES,
  REVIEWER_SESSION_PERMISSION_MODE,
  type PermissionsConfig,
  type ReviewerSessionCapabilities,
  type ReviewerSessionPermissionMode,
  type ReviewerSessionPermissionScope,
  type ServerPermission,
  type SessionPermissionMode,
} from "../packages/marshal-permissions/src/common/permission-contract";

// Permission settings and the reviewer scope are the permission engine's (packages/marshal-permissions).
export { REVIEWER_SESSION_CAPABILITIES, REVIEWER_SESSION_PERMISSION_MODE };
export type {
  PermissionsConfig,
  ReviewerSessionCapabilities,
  ReviewerSessionPermissionMode,
  ReviewerSessionPermissionScope,
  ServerPermission,
  SessionPermissionMode,
};
import {
  PERMISSION_KIND_TUPLE,
  type ContextTier,
  type MessageToolCall,
  type ModelInfo,
  type ModelRuntimeInfo,
  type ReasoningEffort,
  type SessionSandboxConfig,
  type ToolActivityKind,
} from "../packages/marshal-providers/src/contract/host-types";

export {
  PERMISSION_KIND_TUPLE,
  type ContextTier,
  type MessageToolCall,
  type ModelInfo,
  type ModelRuntimeInfo,
  type ReasoningEffort,
  type SessionSandboxConfig,
  type ToolActivityKind,
};

import type {
  RuntimeExtensionCatalogSearchRequest,
  RuntimeExtensionCatalogSearchResponse as RuntimeExtensionCatalogSearchResponseBase,
  RuntimeExtensionContractRepairRequest,
  RuntimeExtensionContractRepairResult,
  RuntimeExtensionRecord,
} from "@marshal/runtime/extensions";

import type {
  OrgCloudMoveStatusResult,
  OrgCloudSessionsResult,
  OrgCloudTestRunResult,
  OrgCloudTestRunsQuery,
  OrgContinueCloudRequest,
  OrgContinueCloudResult,
  OrgContinueHereRequest,
  OrgContinueHereResult,
  OrgDirectorySearchResult,
  OrgForkSessionRequest,
  OrgForkSessionResult,
  OrgGetSharedLinkResult,
  OrgGetSharedLiveResult,
  OrgHeldTranscriptResult,
  OrgJoinSharedSessionRequest,
  OrgJoinSharedSessionResult,
  OrgListSharedLinksResult,
  OrgMentionNote,
  OrgMentionRequest,
  OrgMentionResult,
  OrgMoveToCloudRequest,
  OrgMoveToCloudResult,
  OrgPlacementPreviewRequest,
  OrgPlacementPreviewResult,
  OrgPostCommentResult,
  OrgProjectsCloneRequest,
  OrgProjectsCloneResult,
  OrgProjectsEvent,
  OrgProjectsFailure,
  OrgProjectsGhStatus,
  OrgProjectsListResult,
  OrgPromoteTargetsResult,
  OrgRemoteInboxResult,
  OrgRemoteMessageActionResult,
  OrgRemoteMessageRef,
  OrgRemoteNotificationSummary,
  OrgRemoteResult,
  OrgRemoteSessionDetail,
  OrgRemoteSessionSummary,
  OrgReturnedMessage,
  OrgRoutineCloudTestRequest,
  OrgRoutineCloudTestResult,
  OrgRoutineDispatchRequest,
  OrgRoutineDispatchResult,
  OrgRoutineEnabledRequest,
  OrgRoutineEnabledResult,
  OrgRoutineEventsRequest,
  OrgRoutineEventsResult,
  OrgRoutinePromoteRequest,
  OrgRoutinePromoteResult,
  OrgRoutineRunsRequest,
  OrgRoutineRunsResult,
  OrgRoutineTestLocallyRequest,
  OrgRoutineTestLocallyResult,
  OrgRunChatOpenOptions,
  OrgRunChatResult,
  OrgSendRemoteMessageRequest,
  OrgSendRemoteMessageResult,
  OrgSessionChange,
  OrgSessionSharePreviewResult,
  OrgSessionShareResult,
  OrgSessionWatchResult,
  OrgSessionWorkspaceMappingResult,
  OrgSetSessionWorkspaceRequest,
  OrgShareWorkspacesResult,
  OrgSharedLinkChangedEvent,
  OrgSharedLiveChangedEvent,
  OrgSlackDestinationsRequest,
  OrgSlackDestinationsResult,
  OrgStatus,
  OrgWorkspaceMapping,
  OrgWorkspaceRoutinesResult,
} from "../packages/marshal-org/src/contract/org-types";
import type {
  CommandCenterSessionActivityDetails,
  CommandCenterSnapshot,
  CommandCenterTodoStatus,
  RemoveWorktreeRequest,
  SessionWorkspaceOverview,
  SessionWorkspaceState,
  WorkspaceFilePatch,
  WorkspaceCommitFilesRequest,
  WorkspaceCommitFiles,
  WorkspaceFilePatchRequest,
  WorkspaceTurnPrompt,
  WorkspaceTurnRef,
  WorktreeDiskUsage,
} from "./command-center-contract";
import type {
  GoalChangedEventPayload,
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalFence,
  GoalLifecycleStatus,
  GoalRuntimeSnapshot,
} from "./goal-contract";
import type { InterfaceCustomization } from "./interface-customization";
import type { LocalTelemetryDeleteResult, LocalTelemetryEventPayload } from "./local-telemetry";
import type { PermissionAction } from "./marshal-constants";
import type { SanitizationWarning } from "./marshal-skill-sanitization";
import type { MiniModeSettings } from "./marshal/mini-mode-settings";
import type { ModelRuntimeRouting } from "./model-runtime-routing";
import type {
  OrgCatalogActionResult,
  OrgCatalogPublishPreviewRequest,
  OrgCatalogPublishPreviewResult,
  OrgCatalogPublishRequest,
  OrgCatalogResult,
  OrgCatalogReviewRequest,
  OrgCatalogUpdateRequest,
  OrgOnboardingConnectResult,
  OrgOnboardingInstallResult,
  OrgOnboardingManifestResult,
  OrgOnboardingRunResult,
  OrgOnboardingScope,
  OrgOnboardingStatusResult,
  OrgPublishableResult,
} from "./org-onboarding";
import type {
  DevToolId,
  DevToolsDetectResult,
  DevToolsInstallResult,
  DevToolsPlanResult,
} from "./org-onboarding-tools";
import type {
  OrgSkillActionResult,
  OrgSkillPublishableResult,
  OrgSkillPublishPreviewResult,
  OrgSkillPublishRequest,
  OrgSkillReviewFilesResult,
  OrgSkillReviewRequest,
  OrgSkillsResult,
  OrgSkillUpdateRequest,
} from "./org-skills";
import type { WorkServiceProviderSettings } from "./provider-config";
import type { RelayAddress } from "./relay-contract";
import type {
  RelayProviderActionRequest,
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
} from "./relay-provider-settings";
import type { RequestOrigin } from "./request-ledger-contract";
import type { RuntimeAcceptanceIpcInvokeMap } from "./runtime-acceptance";
import type { RuntimeAccountUsage } from "./runtime-account-usage";
import type { RuntimeAccountsSettings } from "./runtime-accounts";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
  RuntimeInteractiveAuthMethod,
} from "./runtime-auth";
import type { RuntimeSessionEvent } from "./runtime-events";
import type {
  RuntimeUiCloseCommand,
  RuntimeUiCommandResult,
  RuntimeUiEvent,
  RuntimeUiFocusCommand,
  RuntimeUiIpcResult,
  RuntimeUiApplicationCapabilityInvokeCommand,
  RuntimeUiApplicationHostCommand,
  RuntimeUiSelectSessionCommand,
  RuntimeUiSelectedSession,
  RuntimeUiImageHandle,
  RuntimeUiImageCommand,
  RuntimeUiImageContent,
  RuntimeUiApplicationCapabilityCancelCommand,
  RuntimeUiApplicationCapabilityValue,
  RuntimeUiApplicationResourceContent,
  RuntimeUiApplicationResourceReadCommand,
  RuntimeUiListCommand,
  RuntimeUiOpenCommand,
  RuntimeUiPlacementInvokeRequest,
  RuntimeUiPlacementSnapshot,
  RuntimeUiScope,
  RuntimeUiSnapshot,
  RuntimeUiUpdateCommand,
} from "./runtime-ui";
import type {
  SessionImportCandidate,
  SessionImportJob,
  SessionImportOrigin,
  SessionImportRef,
  SessionImportRunOptions,
  SessionImportSourceSummary,
} from "./session-import-contract";
import type { MidgardError } from "./telemetry/types";
import type { TranscribeErrorKind } from "./transcribe-errors";
import type {
  RunHistoryEntry,
  RunSnapshot,
  WorkflowArtifactSummary,
  WorkflowArtifactReadResult,
  WorkflowEvent,
  WorkflowActionCenterItem,
  WorkflowActionDispatchRequest,
  WorkflowActionDispatchResult,
  WorkflowNotificationApprovalRequest,
  WorkflowPermissionRequestEvent,
  WorkflowPermissionResponse,
  WorkflowRendererBundle,
  WorkflowRunEventBatch,
  WorkflowRunStatusEvent,
  WorkflowRunTickEvent,
  WorkflowScheduleSummary,
  WorkflowStateCompactionResult,
  WorkflowStateEntrySummary,
  WorkflowStateValueSnapshot,
  WorkflowStateClearRequest,
  WorkflowStateClearResult,
  WorkflowStateReadResult,
  WorkflowSummary,
} from "./workflows-contract";
export * from "../packages/marshal-org/src/contract/org-types";

// Re-export Command Center contract types for `@/types/electron` consumers.
export type {
  CommandCenterArtifactSummary,
  CommandCenterBlockerSummary,
  CommandCenterEvent,
  CommandCenterFileSummary,
  CommandCenterRelationshipSummary,
  CommandCenterReplayState,
  CommandCenterRunSummary,
  CommandCenterSessionSummary,
  CommandCenterSessionActivityDetails,
  CommandCenterSessionActivityFileChange,
  CommandCenterSessionActivitySource,
  CommandCenterSnapshot,
  CommandCenterTodoStatus,
  CommandCenterTodoSummary,
  CommandCenterToolSummary,
  RemoveWorktreeRequest,
  SessionWorkspaceOverview,
  SessionWorkspaceState,
  WorkspaceBranchSwitch,
  WorkspaceCommit,
  WorkspaceDiffScope,
  WorkspaceFileChange,
  WorkspaceFilePatch,
  WorkspaceCommitFilesRequest,
  WorkspaceCommitFile,
  WorkspaceCommitFiles,
  WorkspaceFilePatchRequest,
  WorkspaceFileTouch,
  WorkspacePullRequestRef,
  WorkspaceRepoBase,
  WorkspaceRepoState,
  WorkspaceTurnPrompt,
  WorkspaceTurnRef,
  WorkspaceWorktree,
  WorktreeDiskUsage,
} from "./command-center-contract";

export type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
} from "./runtime-auth";
export type {
  RuntimeUiAction,
  RuntimeUiApplicationContent,
  RuntimeUiAuthorityDecision,
  RuntimeUiAuthorityRequest,
  RuntimeUiChatCardCommand,
  RuntimeUiChatMessageCommand,
  RuntimeUiCloseCommand,
  RuntimeUiCommandReceipt,
  RuntimeUiCommandResult,
  RuntimeUiContent,
  RuntimeUiError,
  RuntimeUiErrorCode,
  RuntimeUiEvent,
  RuntimeUiFocusCommand,
  RuntimeUiInstance,
  RuntimeUiIpcResult,
  RuntimeUiJsonPrimitive,
  RuntimeUiJsonValue,
  RuntimeUiListCommand,
  RuntimeUiMarkdownContent,
  RuntimeUiNotificationCommand,
  RuntimeUiOpenCommand,
  RuntimeUiOwner,
  RuntimeUiOwnerIdentity,
  RuntimeUiPermission,
  RuntimeUiPlacementDiagnostic,
  RuntimeUiPlacementDiagnosticCode,
  RuntimeUiPlacementInvokeRequest,
  RuntimeUiPlacementMetadata,
  RuntimeUiPlacementMode,
  RuntimeUiPlacementResolution,
  RuntimeUiPlacementSnapshot,
  RuntimeUiResult,
  RuntimeUiScope,
  RuntimeUiSnapshot,
  RuntimeUiSurface,
  RuntimeUiTextContent,
  RuntimeUiUpdateCommand,
} from "./runtime-ui";

export type {
  GoalChangedEventPayload,
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalDocumentV2,
  GoalFence,
  GoalJsonValue,
  GoalLifecycleStatus,
  GoalRecord,
  GoalReviewTarget,
  GoalRuntimeState,
  GoalRuntimeSnapshot,
  GoalStatePatch,
  GoalState,
  GoalStatus,
  GoalTransitionProposal,
  GoalTransitionReviewInput,
  GoalTransitionReviewVerdict,
} from "./goal-contract";
export type {
  GoalAllowedScope,
  GoalAllowedScopeIdentity,
  GoalAuthorityMode,
  GoalCommandCheckKind,
  GoalExecutionAccountingIdentity,
  GoalOperationRecord,
  GoalRuntimeOwnershipLease,
  GoalRuntimeLeaseIdentity,
  GoalWorkAssignmentIdentity,
  ReviewerValidationArtifactRef,
  ReviewerValidationAuthorizationResult,
  ReviewerValidationAuthorized,
  ReviewerValidationCommandSpec,
  ReviewerValidationDenied,
  ReviewerValidationPermissionRequest,
  ReviewerValidationReceipt,
  ReviewerValidationRequest,
} from "./goal-infrastructure-contract";
export {
  GOAL_DOCUMENT_SCHEMA_VERSION,
  GOAL_INITIAL_EPOCH,
  goalFenceFor,
  isInitialGoalFence,
  matchesGoalFence,
} from "./goal-contract";
export type {
  ExternalOperationEffect,
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
  ExternalOperationStatus,
} from "./external-operation-contract";
export { externalOperationIdentityFor } from "./external-operation-contract";
// Re-export workflows contract types for `@/types/electron` consumers.
export type {
  ArtifactRef,
  AgentHandleSummary,
  ExecutionUnitStatus,
  FanOutUnit,
  RunActions,
  RunCapacitySnapshot,
  RunError,
  RunHistoryEntry,
  RunSnapshot,
  StepStatus,
  StepView,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowArtifactSummary,
  WorkflowJSONSchema,
  WorkflowPermissionRequestEvent,
  WorkflowPermissionResponse,
  WorkflowRendererBundle,
  WorkflowRunEventBatch,
  WorkflowRunStatus,
  WorkflowRunStatusEvent,
  WorkflowRunTickEvent,
  WorkflowScheduleSummary,
  WorkflowSource,
  WorkflowStateCompactionResult,
  WorkflowStateEntrySummary,
  WorkflowStateValueSnapshot,
  WorkflowArtifactReadResult,
  WorkflowStateReadResult,
  WorkflowSummary,
} from "./workflows-contract";

// ── Shared Constants ───────────────────────────────────────────────────────

/** Error messages returned by bundle import handlers that represent user-initiated dismissals, not real errors. */
export const SKILL_IMPORT_DISMISSED = [
  "Cancelled",
  "Import cancelled",
  "Skipped existing skill",
] as const;

/**
 * Universal IPC envelope shape — every handler in `electron/ipc/*-ipc.ts`
 * returns this base + any handler-specific data fields. Declared here so
 * helpers like `useIpcMutation` and any future generic IPC adapter can
 * import the canonical shape rather than redeclaring it per call site.
 */
export interface IpcResult {
  success: boolean;
  error?: string;
}

// ── Domain Types ────────────────────────────────────────────────────────────

export type MemoryCategory = "preference" | "fact" | "decision" | "context";

export interface MemoryEntry {
  id: string; // Local ID (UUID)
  fact: string;
  category: MemoryCategory;
  source: string;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  /** `"global"` (or absent) for every session, else the git project id it applies to. */
  appliesTo?: string;
  /** Repo-relative files (and symbols) the memory is about. */
  links?: MemoryLink[];
  /** Brain entity ids (`kind:id`, e.g. `person:a@b.com`) the memory is about. */
  entities?: string[];
  /** Key of the copy stored in the workspace's Brain, when one was written. */
  brainKey?: string;
}

export interface MemoryLink {
  path: string;
  symbol?: string;
}

export interface MemorySettings {
  maxMemories: number;
  decayDays: number;
}

// Custom app events emitted by the main process (not from the SDK).
// Each is typed so the renderer can narrow event.data after checking event.type.
interface AppSessionStatusEvent {
  type: "session.status";
  data: { status: string | null };
}
interface AppToolExecutionEndEvent {
  type: "tool.execution_end";
  data: { toolCallId: string; toolName: string };
}
interface AppMetadataUpdatedEvent {
  type: "session.metadata_updated";
}
interface AppErrorEvent {
  type: "error";
  data?: { message?: string; [key: string]: unknown };
}

type AppCustomEvent =
  | AppSessionStatusEvent
  | AppToolExecutionEndEvent
  | AppMetadataUpdatedEvent
  | AppErrorEvent;

/** Runtime adapter events + custom app events. Discriminated union on `type`. */
export type RuntimeEvent = RuntimeSessionEvent | AppCustomEvent;

export interface RuntimeEventWrapper {
  sessionId: string;
  event: RuntimeEvent;
}

// ── Turn Events (main → renderer) ─────────────────────────────────────────
// Enriched events emitted by TurnAccumulator. The renderer never sees raw
// SDK events — only these types.

interface TurnTextDeltaEvent {
  type: "turn:text-delta";
  delta: string;
  /** Ordered assistant blocks accumulated so far in this backend turn. */
  contentBlocks?: AssistantContentBlock[];
}

interface TurnReasoningUpdatedEvent {
  type: "turn:reasoning-updated";
  reasoning: { text: string; durationSeconds: number | null };
  /** Ordered assistant blocks accumulated so far in this backend turn. */
  contentBlocks?: AssistantContentBlock[];
}

export interface TurnToolsUpdatedEvent {
  type: "turn:tools-updated";
  toolCalls: TurnToolStatus[];
  /** Set when this update was triggered by a new tool starting. */
  startedToolId?: string;
  /** Ordered assistant blocks accumulated so far in this backend turn. */
  contentBlocks?: AssistantContentBlock[];
}

export interface TurnToolStatus extends MessageToolCall {
  id: string;
  running: boolean;
}

/**
 * Chronological assistant output within one backend turn. Consecutive events
 * of the same kind share a block; switching kind starts a new bubble/island.
 */
export type AssistantContentBlock =
  | { id: string; type: "text"; content: string }
  | {
      id: string;
      type: "reasoning";
      text: string;
      durationSeconds: number | null;
    }
  | {
      id: string;
      type: "tools";
      toolCalls: Array<MessageToolCall & { running?: boolean }>;
    };

export type ToolProvenanceRecord = Record<string, unknown>;

export interface TurnToolCompletedEvent {
  type: "turn:tool-completed";
  toolCallId: string;
  output: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
  provenance?: ToolProvenanceRecord;
}

interface TurnMessageCommittedEvent {
  type: "turn:message-committed";
  message: SessionMessage;
  /** Set when the message was written into the session from outside its turns (goal timeline, runtime UI chat, restart notices). */
  origin?: "external";
}

interface TurnIdleEvent {
  type: "turn:idle";
}

interface TurnErrorEvent {
  type: "turn:error";
  error: string;
  /** True when the backend is retrying THIS turn (transient recoverable error);
   *  consumers (sendAndCollect collectors, the session view) treat it as
   *  non-fatal instead of a terminal turn failure. */
  retrying?: boolean;
  message?: SessionMessage;
  /** Runtime error code, e.g. `usage_limit` (see common/runtime-usage-limit.ts). */
  code?: string;
  /** Epoch milliseconds when a usage limit resets. */
  retryAt?: number;
}

interface TurnStatusEvent {
  type: "turn:status";
  status: string | null;
}

interface TurnMetadataUpdatedEvent {
  type: "turn:metadata-updated";
  changes?: Partial<SessionMetadata>;
}

interface TurnTokenUsageEvent {
  type: "turn:token-usage";
  currentTokens: number;
  tokenLimit: number;
}

export interface TurnLlmUsageEvent {
  type: "turn:llm-usage";
  usageAvailability?: {
    inputTokens: boolean;
    outputTokens: boolean;
    cachedInputTokens: boolean;
    costUsd: boolean;
  };
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  duration: number;
  ttftMs: number;
  interTokenLatencyMs: number;
  initiator: string | undefined;
  apiCallId: string | undefined;
  providerCallId: string | undefined;
}

/** Real per-turn token spend, derived from the SDK `assistant.usage` event
 *  (input + output tokens for the LLM call). Distinct from
 *  `turn:token-usage`, which reports CONTEXT SIZE (currentTokens/tokenLimit),
 *  not incremental spend. Consumed by the GoalEngine to accumulate
 *  `GoalState.tokensUsed`. */
export interface TurnUsageEvent {
  type: "turn:usage";
  inputTokens: number;
  outputTokens: number;
}

export interface QuestionAnswer {
  title: string;
  description?: string;
}

export interface MessageQuestion {
  question: string;
  answers: QuestionAnswer[];
  recommendedIndex?: number;
  selectedAnswer?: string;
}

export type TurnEvent =
  | TurnTextDeltaEvent
  | TurnReasoningUpdatedEvent
  | TurnToolsUpdatedEvent
  | TurnToolCompletedEvent
  | TurnMessageCommittedEvent
  | TurnIdleEvent
  | TurnErrorEvent
  | TurnStatusEvent
  | TurnMetadataUpdatedEvent
  | TurnTokenUsageEvent
  | TurnLlmUsageEvent
  | TurnUsageEvent;

/** Snapshot of in-flight turn state from TurnAccumulator, for re-subscribing renderers. */
export interface TurnState {
  text: string;
  reasoning: { text: string; durationSeconds: number | null } | null;
  toolCalls: TurnToolStatus[];
  contentBlocks?: AssistantContentBlock[];
}

// ── BackendCapabilities (shared between main process and IPC layer) ────────

export interface AutomationCapabilities {
  multiStep: boolean;
  workingDir: boolean;
  skills: boolean;
  perAutomationPermissions: boolean;
  conditionTrigger: boolean;
  heartbeat: boolean;
  /** Phase 3a-1: per-backend ability to fire a heartbeat on demand. */
  heartbeatRunNow: boolean;
  bundleImport: boolean;
  exportImport: boolean;
  githubImport: boolean;
}

/**
 * Per-RPC flags advertising which DesktopCapabilities the backend's runtime
 * actually invokes today. Gateway: all start `false` and flip true in small
 * follow-up PRs as lobster's runtime wires each RPC. Copilot: all `false`
 * (copilot doesn't use the desktop-capabilities path; flags stay present
 * for interface symmetry per CLAUDE.md rule 3).
 *
 * Note: the older `localPolicy` and `approvalCards` flags were removed when
 * `evaluateLocalPolicy` and `showApprovalCard` moved off `DesktopCapabilities`
 * onto `IToolBackend.attachApprovalRouter`. Approval-routing wiring is no
 * longer per-RPC-flagged because both backends always wire it.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.3.
 */
export interface DesktopCapabilitiesFlags {
  /** executeLocalTool wired (filesystem/Playwright/shell/self-tools) */
  localTools: boolean;
  /** showNotification wired (native OS notifications) */
  notifications: boolean;
}

export interface BackendCapabilities {
  taskList: boolean;
  cronExpressions: boolean;
  retryPolicy: boolean;
  policyEditor: boolean;
  heartbeatIsolated: boolean;
  modelFallback: boolean;
  connectionStatus: boolean;
  /** The active provider can manually compact an idle session's context. */
  sessionCompaction: boolean;
  /** send() on a busy session injects the message into the active turn without
   *  interrupting in-flight work (e.g. Codex turn/steer). When set,
   *  SessionManager.steerMessage skips its cancel+resend fallback, which would
   *  otherwise kill running tools and discard the turn's progress. */
  busyTurnSteer: boolean;
  /** The runtime can copy a live session into new sessions that resume its exact
   *  context (forkSubagents / subagents v2). */
  sessionFork: boolean;
  /** Each turn gets what others wrote in a shared session (through the user-prompt hook), so the runtime can take part. */
  sharedSessions: boolean;
  automations: AutomationCapabilities;
  desktopCapabilities: DesktopCapabilitiesFlags;
}

// ── Session View (main → renderer, throttled snapshots) ──────────────────
// The SessionView is the single source of truth for the chat UI.
// The main process maintains it and emits throttled snapshots via session:view.

export type SessionViewStatus = "ready" | "submitted" | "streaming" | "error";

export interface SessionView {
  status: SessionViewStatus;
  streamingText: string;
  reasoning: { text: string; durationSeconds: number | null } | null;
  toolStatuses: TurnToolStatus[];
  tokenUsage: { currentTokens: number; tokenLimit: number } | null;
  lastTurnUsage: { inputTokens: number; outputTokens: number } | null;
  error: string | null;
  sessionStatus: string | null;
  /** Ordered live output. Undefined for older producers and stored snapshots. */
  contentBlocks?: AssistantContentBlock[];
}

export const DEFAULT_SESSION_VIEW: SessionView = {
  status: "ready",
  streamingText: "",
  reasoning: null,
  toolStatuses: [],
  tokenUsage: null,
  lastTurnUsage: null,
  error: null,
  sessionStatus: null,
};

export interface SessionViewEvent {
  type: "session:view";
  view: SessionView;
  committedMessages: SessionMessage[];
}

export interface SessionViewDelivery extends SessionViewEvent {
  sessionId: string;
  epoch: string;
  sequence: number;
}

export interface SessionViewSnapshot {
  sessionId: string;
  epoch: string;
  sequence: number;
  view: SessionView;
}

export interface SessionStatusDelta {
  sessionId: string;
  status: SessionViewStatus;
  sessionStatus: string | null;
  hasError: boolean;
}

export interface SessionStatusBatch {
  epoch: string;
  sequence: number;
  sessions: SessionStatusDelta[];
}

export interface CopilotAttachment {
  type: "file" | "directory";
  path: string;
  displayName?: string;
}

export type OverlayReviewAttachmentKind = "screenshot" | "composite" | "audio";

export interface OverlayReviewLaunchRequest {
  sessionId: string;
  sessionTitle?: string;
}

export interface OverlayReviewTarget {
  sessionId?: string;
  sessionTitle?: string;
  isNew: boolean;
}

export interface OverlayReviewComposerAttachment {
  name: string;
  mimeType: string;
  path: string;
  kind: OverlayReviewAttachmentKind;
}

export interface OverlayReviewSubmittedEvent {
  reviewId: string;
  target: OverlayReviewTarget;
  attachments: OverlayReviewComposerAttachment[];
  summaryMarkdown: string;
}

/** Lightweight signal that one or more reviews are buffered for a session and
 * should be claimed (the full payload is fetched via `overlay-review:claim`). */
export interface OverlayReviewPendingEvent {
  sessionId: string;
}

export interface OverlayReviewErrorEvent {
  message: string;
}

/** Entity types supported by the Context Picker search backend. */
export type ContextEntityType = "People" | "File";

export interface ContextPersonEntity {
  type: "People";
  id: string;
  referenceId?: string;
  displayName: string;
  email?: string;
  jobTitle?: string;
  department?: string;
}

export interface ContextFileEntity {
  type: "File";
  id: string;
  referenceId?: string;
  title: string;
  accessUrl?: string;
  fileExtension?: string;
  dateModified?: string;
  author?: string;
  /** Absolute path for a file selected from a local Marshal workspace. */
  localPath?: string;
}

export type ContextEntity = ContextPersonEntity | ContextFileEntity;

export type GoalTimelineResumeTriggerKind =
  | "initial-pursuit"
  | "continuation-completed"
  | "explicit-resume-takeover"
  | "completion-claim-rejected"
  | "milestone-available"
  | "restart-recovery"
  | "busy-yield-cleared";

export interface GoalTimelineResumeTrigger {
  kind: GoalTimelineResumeTriggerKind;
  reason: string;
  milestoneSummary?: string;
  occurredAt: string;
}

export interface GoalTimelineDurableMilestone {
  latestProgress?: string;
  handoffSummary?: string;
  latestDecision?: string;
  openQuestion?: string;
}

export type GoalTimelineAgentSource = "assistant" | "subagent" | "workflow-agent" | "reviewer";

export interface GoalTimelineAgentAttribution {
  sessionId: string;
  source: GoalTimelineAgentSource;
  sourceLabel?: string;
}

export interface GoalTimelineReviewerAttribution extends GoalTimelineAgentAttribution {
  requestedCompaction: boolean;
}

export type SessionInternalControlKind =
  | "goal-continuation"
  | "goal-continuation-composer"
  | "goal-transition-review"
  | "relay-progress"
  | "subagent-readiness"
  | "background-task";

export interface SessionInternalControlMetadata {
  kind: SessionInternalControlKind;
  exchangeId: string;
  side: "request" | "response";
}

export type GoalTimelineEvent =
  | {
      type: "goal.declared";
      fence: GoalFence;
      objective: string;
    }
  | {
      type: "goal.continuation";
      fence: GoalFence;
      sequence: number;
      verification: boolean;
      resumeTrigger: GoalTimelineResumeTrigger;
      durableMilestone: GoalTimelineDurableMilestone;
      agent: GoalTimelineAgentAttribution;
      reviewer?: GoalTimelineReviewerAttribution;
    }
  | {
      type: "goal.completion-requested";
      fence: GoalFence;
      attempt: number;
    }
  | {
      type: "goal.completion-rejected";
      fence: GoalFence;
      reason: string;
      outcome: "continuing" | "blocked";
    }
  | {
      type: "goal.lifecycle-changed";
      fence: GoalFence;
      from: GoalLifecycleStatus;
      to: GoalLifecycleStatus;
      reason?: string;
    };

export type SessionAgentMessageKind =
  | "subagent"
  | "parent"
  | "session"
  | "readiness"
  | "review-comment"
  | "review-feedback"
  | "goal-terminal"
  | "selected-session"
  | "relay"
  | "app-restart"
  | "ui-view-health"
  | "decision-answer";

export type SessionAgentMessageDeliveryMode = "queue" | "interrupt";
export type SessionGoalMessageDeliveryKind = "child" | "reviewer" | "terminal";
export type SessionGoalMessageTerminalKind = "blocked" | "completed";

/**
 * Durable agent-message envelope attached to the user-role turn injected into
 * the target session. Core provenance remains required for older records;
 * transport state is populated for new outbox deliveries.
 */
export interface SessionAgentMessageMetadata {
  source: string;
  sourceLabel?: string;
  /** The sender's own words, without the delivery header naming the sending session; what a shared session shares. */
  body?: string;
  kind: SessionAgentMessageKind;
  deliveryMode: SessionAgentMessageDeliveryMode;
  sequence: number;
  messageId?: string;
  idempotencyKey?: string;
  target?: string;
  priority?: number;
  /** Present when several queued messages were delivered together as this one turn. */
  coalescedMessageCount?: number;
  deadline?: string;
  attempts?: number;
  state?: AgentMessageState;
  acceptedAt?: string;
  updatedAt?: string;
  retryAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  backendAcceptedAt?: string;
  backendDeliveredAt?: string;
  goalFence?: GoalFence;
  goalId?: string;
  goalDeliveryKind?: SessionGoalMessageDeliveryKind;
  goalTerminalKind?: SessionGoalMessageTerminalKind;
  goalDeliverySequence?: number;
  processedAt?: string;
  sourceSessionSource?: SessionSource;
  relayOrigin?: RelayAddress;
  readinessGeneration?: string;
  readinessWakeVersion?: 1;
  /** Backend execution identity used to reconcile a readiness dispatch after restart. */
  readinessDispatchExchangeId?: string;
}

export interface SessionMessageAttachment {
  type: "file" | "directory";
  path: string;
  displayName?: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  background?: boolean;
  /** True when the message represents a terminal turn failure rather than an assistant reply. */
  error?: boolean;
  /** True for hidden user turns auto-injected by the GoalEngine while
   *  autonomously pursuing a goal. The renderer uses goalTimelineEvent metadata
   *  to show a lifecycle entry instead of exposing the control prompt as a user
   *  bubble, and these turns are excluded from quick-title / user-intent paths. */
  goalContinuation?: boolean;
  /** Durable correlation for host-authored control exchanges. Requests and every
   *  assistant result from the same turn share an exchange ID. Requests stay
   *  hidden unless they carry a structured timeline boundary; composer responses
   *  stay hidden, while continuation/readiness work remains visible. */
  internalControl?: SessionInternalControlMetadata;
  /** Structured lifecycle metadata for visible goal status entries. The raw
   *  continuation prompt remains in `content` for backend delivery, while the
   *  renderer uses this metadata instead of exposing it as ordinary user text. */
  goalTimelineEvent?: GoalTimelineEvent;
  /** Durable agent-message outbox metadata. Preserved so subagent handoffs,
   *  review feedback, and terminal goal notifications render as agent events
   *  rather than being flattened into ordinary user messages. */
  agentMessage?: SessionAgentMessageMetadata;
  /** Hidden assistant output generated by legacy conversational idle-readiness delivery. */
  suppressedAgentStatusResponse?: boolean;
  /** Set on a message a person, or the session that started this one, wrote:
   *  the request ledger records exactly these. Unset on everything the harness
   *  sends itself, and on history a fork copied from its parent. */
  requestOrigin?: RequestOrigin;
  /** Files sent with a user message, kept so the bubble can still show them
   *  (image thumbnails, file names) after a refetch or reload. */
  attachments?: SessionMessageAttachment[];
  reasoning?: { text: string; durationSeconds: number | null };
  toolCalls?: MessageToolCall[];
  /** Ordered rendering model for interleaved text, thought, and tool streams. */
  contentBlocks?: AssistantContentBlock[];
  toolProvenance?: ToolProvenanceRecord[];
  question?: MessageQuestion;
  /** Read only, on sessions from builds where a shared session's owner ran others' turns. `content` holds the wrapped prompt the model saw. */
  orgParticipant?: SessionOrgParticipantMetadata;
  /** Set on a message written into the session from outside its turns (goal timeline, runtime UI chat,
   *  restart and compaction notices). A shared session never uploads these. */
  origin?: "external";
  /** A display-only message another person, or their Marshal, wrote in a shared session. It never starts a turn and is not sent to the model as one. */
  orgRemote?: SessionOrgRemoteMetadata;
}

export interface SessionOrgRemoteMetadata {
  /** The author's principal, for example `user:ada@example.com`. */
  author: string;
  authorLabel: string;
  /** The author's Marshal wrote it (an assistant message). */
  fromAgent: boolean;
}

/** The organization participant whose inbox message started a turn, on sessions from builds where the owner ran others' turns. */
export interface SessionOrgParticipantMetadata {
  /** The author's principal, for example `user:ada`. */
  principal: string;
  role: "collaborator" | "driver";
  /** The organization inbox message this turn ran. */
  orgMessageId: string;
  /** The participant's own words, as they wrote them. */
  text: string;
}

/** Who a session shared to the team Brain is visible to. */
export type BrainShareAccess = { audience: "team" } | { audience: "people"; emails: string[] };

/** A session this machine shared to the team Brain. */
export interface BrainShareRecord {
  sharedAt: string;
  audience: "team" | "people";
  emails?: string[];
  workspace?: string;
  /**
   * Set while the Brain may hold a copy Marshal could not confirm: a share in progress or whose outcome is unknown
   * (a timeout, a lost answer), or an unshare that did not confirm. Cleared only by a confirmed unshare.
   */
  cleanup?: { since: string; attempts: number; lastError?: string };
}

export function isHiddenInternalControlMessage(
  message: Pick<SessionMessage, "internalControl">,
): boolean {
  const control = message.internalControl;
  return (
    control !== undefined &&
    (control.side === "request" ||
      control.kind === "goal-continuation-composer" ||
      control.kind === "goal-transition-review" ||
      control.kind === "relay-progress")
  );
}

export function isVisibleInternalControlResponse(
  message: Pick<SessionMessage, "internalControl">,
): boolean {
  return message.internalControl?.side === "response" && !isHiddenInternalControlMessage(message);
}

export function isUserVisibleSessionMessage(
  message: Pick<
    SessionMessage,
    "goalContinuation" | "internalControl" | "suppressedAgentStatusResponse"
  >,
): boolean {
  return (
    !isHiddenInternalControlMessage(message) &&
    message.goalContinuation !== true &&
    message.suppressedAgentStatusResponse !== true
  );
}

// ── Goal feature ───────────────────────────────────────────────────────────
// Goal contracts live in common/goal-contract.ts and are re-exported above so
// existing IPC consumers keep a single import surface.

/** Default name for newly created sessions, before the user sends a message. */
export const DEFAULT_SESSION_NAME = "New Chat";

/** Which current backend family created a session. Missing legacy values remain Copilot. */
export type BackendOrigin = "copilot" | "gateway";
export type SessionSource =
  | "user"
  | "automation"
  | "subagent"
  | "workflow-agent"
  | "workflow-run"
  | "workspace"
  | "heartbeat"
  | "feedback"
  /** Read-only mirror of a subagent the Claude runtime runs inside its own process. */
  | "claude-subagent";
export type SessionRuntimeAgentRole =
  | "brain"
  | "planner"
  | "swarm"
  | "worker"
  | "reviewer"
  | "validator"
  | "reconciler";
export function isToolFreeRuntimeAgentRole(role: SessionRuntimeAgentRole | undefined): boolean {
  return role === "planner";
}
/**
 * The exact host tool names a session may call. `undefined` = unrestricted,
 * `[]` = tool-free. Skills, MCP servers, and SDK built-ins are excluded whenever
 * a list (even an empty one) is present, except the MCP servers and skills the
 * session itself names (non-empty `scopedMcp` / `scopedSkills`); a tool-free
 * role keeps none.
 */
export function resolveSessionToolAllowlist(
  role: SessionRuntimeAgentRole | undefined,
  allowedTools: readonly string[] | undefined,
): readonly string[] | undefined {
  return isToolFreeRuntimeAgentRole(role) ? [] : allowedTools;
}

export interface WorkspaceInstanceIdentity {
  version: 1;
  device: string;
  inode: string;
  birthtimeNs: string;
}

export interface MainSessionWorkspaceBinding {
  name: string;
  identity: WorkspaceInstanceIdentity;
}

export interface RepositoryAgentIdentity {
  version: 1;
  normalizedPath: string;
  declaredName: string;
  contentDigest: string;
}

export interface SessionRepositoryAgent {
  name: string;
  path: string;
  description?: string;
  /** Absent only on legacy persisted sessions, which main sessions treat as stale. */
  identity?: RepositoryAgentIdentity;
}

export interface MainSessionContextSelection {
  workspaceBinding?: MainSessionWorkspaceBinding;
  repositoryAgent?: SessionRepositoryAgent;
  /** Optional active empty main session to replace after the new session starts.
   * The main process revalidates source, activity, and persisted message count. */
  replaceEmptySessionId?: string;
}

export type AgentMessageState =
  | "accepted"
  | "pending"
  | "leased"
  | "backend-accepted"
  | "processed"
  | "dead-letter"
  | "delivery-unknown"
  | "cancelled";

export interface AgentMessageApiResult {
  success: boolean;
  accepted?: boolean;
  messageId?: string;
  deliveryState?: AgentMessageState;
  response?: string;
  status?: string;
  error?: string;
  /** Sender's queued messages this one replaced before they were delivered. */
  replacedMessageIds?: string[];
}

export interface AgentMessageQueueCancellationResult {
  success: boolean;
  cancelledMessageIds?: string[];
  /** Requested IDs that were not cancelled: delivery already began, or not this sender's. */
  notCancelledMessageIds?: string[];
  error?: string;
}

export interface SessionMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  hasUnread: boolean;
  isActive: boolean;
  /** User-pinned to the top of the sidebar. Absent on every session created
   *  before pinning existed, so `undefined` must read as "not pinned". */
  isPinned?: boolean;
  /** Transient list-only flag: true while a turn is currently processing. */
  isBusy?: boolean;
  /** Transient list-only flag: true when this session has a descendant subagent
   *  (transitive, via parentSessionId) currently processing a turn, even if this
   *  session's own turn is idle. Drives the sidebar "running" spinner so a chat
   *  keeps showing activity while its spawned subagents are still working. */
  hasRunningSubagent?: boolean;
  /** Transient list-only: work the runtime still has in flight for this session after its
   *  turn ended (background shells, monitors, subagents, workflows, scheduled wakeups).
   *  Absent when there is none. Never persisted. */
  backgroundWork?: import("./background-work").SessionBackgroundWork;
  /** Transient list-only flag: true when this session works in a subagent
   *  worktree rather than a workspace the user created. Worktree workspaces are
   *  real registered workspaces (`<base>-<8 hex>`), so sessions bind to them
   *  legitimately and the sidebar would otherwise mint one group per throwaway
   *  worktree — 309 distinct groups in one real profile. Derived at list time
   *  from `repoPath` (NOT from the workspace registry, which drops these
   *  entries and anyway loses them once a worktree is deleted), never
   *  persisted, so it re-classifies if `worktreeDir` moves. Absent `repoPath`
   *  leaves it false rather than guessing.
   *  Display/grouping only: never use it for binding or root resolution. */
  isWorktreeWorkspace?: boolean;
  model?: string;
  /** Whether this chat follows the configured default account or pins a named one. */
  runtimeAccountSelection?: "default" | "explicit";
  /** Per-session reasoning-effort override. Undefined = inherit the tier
   *  default (chat/subagent/workflow) resolved by ModelManager. Set via the
   *  chat ModelPicker or a subagent/workflow spawn override. */
  reasoningEffort?: ReasoningEffort;
  /** Per-session context-window override. Undefined = inherit the resolved
   *  model/tier default. */
  contextTier?: ContextTier;
  soul?: string;
  source?: SessionSource;
  automationId?: string;
  /** Parent session that launched this session when source === "subagent". */
  parentSessionId?: string;
  /** Optional durable role for a Runtime-owned ordinary child agent. */
  runtimeAgentRole?: SessionRuntimeAgentRole;
  /** Host-issued portable delegation identity; never populated from agent tool input. */
  runtimeDelegationId?: string;
  runtimeTaskController?: string;
  /** Permission behavior for delegated/subagent sessions. Defaults to "default".
   * Reviewer session creation must instead provide REVIEWER_SESSION_PERMISSION_MODE. */
  permissionMode?: SessionPermissionMode;
  workspaceName?: string;
  /**
   * Display-only: the workspace a worktree session was cut FROM.
   *
   * Worktree sessions cannot carry `workspaceName` — `captureWorkspaceBinding`
   * throws when `workspaceName` and `repoPath` resolve to different roots, and
   * a worktree's root is by definition not its origin workspace's root. Without
   * this the sidebar files every worktree agent under "General", or mints a
   * group per throwaway worktree. Never use it for binding, root resolution, or
   * scoping — grouping and labels only.
   */
  originWorkspaceName?: string;
  /**
   * Transient list-only: the registered workspace this session resolves to,
   * keyed by the workspace's canonical filesystem path (normalized for
   * compare), not its name.
   *
   * Bindings are captured as a *name*, but a name is user-editable — renaming a
   * workspace would otherwise split one group in two and orphan every existing
   * session under a heading that no longer exists. The path is what the
   * workspace actually is, so it is the grouping key.
   *
   * Undefined means "does not resolve to a currently-registered workspace" —
   * a workspace that was deleted or was never registered (a throwaway worktree,
   * a legacy path-shaped binding). The sidebar hides those rather than minting
   * a group per stale binding. Re-registering the workspace makes them resolve
   * again, so this is reversible and never destroys data.
   *
   * Derived at list time from the workspace registry, never persisted, so it
   * re-resolves whenever the registry changes.
   */
  registeredWorkspaceKey?: string;
  /**
   * Transient list-only: the *current* display name of the registered workspace
   * identified by `registeredWorkspaceKey`. Paired with the key so a rename
   * changes what the user reads without moving any session between groups.
   */
  registeredWorkspaceLabel?: string;
  /** Exact filesystem instance selected for a scoped main session. */
  workspaceIdentity?: WorkspaceInstanceIdentity;
  /** Set when the bound workspace instance was removed. Prevents silent rebinding by name. */
  workspaceBindingInvalid?: boolean;
  /** Repo-local role selected for this session. Additive to trusted main-agent instructions. */
  repositoryAgent?: SessionRepositoryAgent;
  /** Absolute repo root for repoPath-scoped subagents without a Co-create workspace name. */
  repoPath?: string;
  /** Durable runtime-adapter partition. Missing values derive from backendOrigin,
   *  and rows missing both fields belong to the legacy Copilot runtime. */
  runtimeId?: string;
  /** Undefined on pre-spec sessions — treated as "copilot" by the loader. */
  backendOrigin?: BackendOrigin;
  /** Backend's stable server-side identity for this session. Populated post-create.
   *  For Copilot this is the SDK session id; for Gateway it's the cloud UUID from
   *  sessions.create. */
  backendId?: string;
  /** Set on sessions imported from another tool (Claude Code, Codex, Cursor). */
  importedFrom?: SessionImportOrigin;
  /** Set on read-only mirrors of subagents a runtime runs inside its own process
   *  (`source === "claude-subagent"`). */
  runtimeSubagent?: import("./runtime-subagent").RuntimeSubagentRef;
}

export interface SessionListOptions {
  query?: string;
  /** Sidebar-only opt-in for synthetic workflow-run host rows. */
  includeWorkflowRuns?: boolean;
  limit?: number;
  beforeSessionId?: string;
  sources?: SessionSource[];
  excludeSources?: SessionSource[];
}

/** Error a sessions search returns when a newer query replaced it; callers must not cache it. */
export const SESSION_SEARCH_SUPERSEDED = "search-superseded";

export interface SessionSearchResult extends SessionMetadata {
  snippets: string[];
}

export interface SessionListPage {
  sessions: SessionMetadata[];
  hasMore: boolean;
  nextCursor?: string;
  selectedSession?: SessionMetadata;
}

export interface SessionMetadataChangedEvent {
  sessionId: string;
  changes?: Partial<SessionMetadata>;
}

export interface StoredSession extends SessionMetadata {
  messages: SessionMessage[];
  permissionCards?: PermissionCardData[];
  contextSummary?: string;
  summaryUpToMessageId?: string;
}

export interface PermissionCardData {
  id: string;
  toolCallId?: string;
  sessionId?: string;
  kind: (typeof PERMISSION_KIND_TUPLE)[number];
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  tooltips?: Record<string, string>;
  output?: string;
  /**
   * Card resolution state. Set by main process PermissionCardManager.
   * Cards are pushed to renderer via `permissions:cards-changed` IPC.
   * - `"allowed"` — user approved, tool may still be running (output == null) or completed
   * - `"denied"` — user clicked Deny
   * - `"failed"` — tool execution failed after approval
   * - `"timed-out"` — 5-minute auto-deny, no user response
   */
  resolved?: "allowed" | "denied" | "failed" | "timed-out";
  createdAt?: number;
  category?: "readonly" | "writes" | "network" | "destructive" | "unknown";
  suggestedPattern?: string | null;
  patternRationale?: string | null;
  sdkIntention?: string;
  sdkWarning?: string;
  sdkCommandIdentifiers?: string[];
  browserUseDisclosure?: boolean;
  /**
   * Heuristic + guardrails pattern computed synchronously by the adapter —
   * what the primary "Always allow" button will store. Locked at card-creation
   * time so the button's semantics never mutate while the card is visible.
   * null/undefined when no heuristic survived (literal command stored instead).
   */
  primaryPattern?: string | null;
  /**
   * False when the shell heuristic collapses to "*" (paren-wrapped expressions,
   * bare variable substitution) — clicking "Always allow" would be a silent
   * no-op at the persistence layer. UI omits the button in that case. Absent /
   * undefined is treated as true (default-show) for cards predating this field.
   */
  canPersistAlwaysAllow?: boolean;
  /**
   * Set when the card was raised because a write targets a security-sensitive
   * location. Value is a human-readable label shown as a warning banner, e.g.
   * `"~/.ssh/config is in a security-sensitive location"`. Undefined on
   * non-sensitive cards — no behavior change for the common path.
   */
  sensitivePathWarning?: string;
}

export type PermissionKind = PermissionCardData["kind"];

export interface Skill {
  id: string;
  name: string;
  displayName?: string;
  description: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  /** `organization`: installed from the signed-in organization's catalog; read-only here. */
  /** `extension`: declared by an installed runtime extension's package; read-only here. */
  scope: "local" | "global" | "bundled" | "organization" | "extension";
  /** The organization catalog version, for `organization` skills. */
  orgVersion?: string;
  /** The identity of the extension that ships it, for `extension` skills. */
  extension?: string;
  /** Supporting directories included when the skill was imported as a bundle (e.g. scripts, references, scopes, assets). */
  bundleDirs?: string[];
}

/** Tiers (other than chat) that carry their own default model + reasoning
 *  effort. Chat keeps the legacy `defaultModel` + per-model reasoning map. */
export type ModelTier = "subagent" | "workflow";

export interface SoulPreset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  greeting: string;
}

export interface HeartbeatStatus {
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  running: boolean;
}

export interface HeartbeatControllableMap {
  enabled: boolean;
  intervalMinutes: boolean;
  schedule: boolean;
  prompt: boolean;
  permissions: boolean;
  workDays: boolean;
  workStartHour: boolean;
  workEndHour: boolean;
}

export interface HeartbeatSettings {
  /**
   * @internal — persistence-only. Not authoritative on the wire (gateway
   * mode has no `enabled` field in marshal's HeartbeatSchema). Read the
   * live toggle from `HeartbeatStatus.enabled` instead. Excluded from
   * `HeartbeatSettingsEnvelope` so the type system enforces this.
   */
  enabled: boolean;
  intervalMinutes: 15 | 30 | 60 | 120;
  schedule: "work-hours" | "always";
  prompt: string;
  /** Per-heartbeat permissions — full replacement for global when set.
   *  When absent, heartbeat derives from global + autoApproveReadOnly: true. */
  permissions?: PermissionsConfig;
  /** Days considered work days (0=Sun..6=Sat). Defaults to Mon–Fri [1,2,3,4,5]. */
  workDays?: number[];
  /** Work start hour (0-23). Defaults to 8. */
  workStartHour?: number;
  /** Work end hour (0-23, exclusive). Defaults to 18. */
  workEndHour?: number;
}

/**
 * Discriminated-union envelope for heartbeat config. Phase 3a-1: supports
 * both copilot and gateway backends. `enabled` is intentionally omitted
 * from the wire shape — it's persistence-only and lies in gateway mode (see
 * `HeartbeatSettings.enabled` JSDoc). Renderers must read the live toggle
 * from `HeartbeatStatusEnvelope.enabled`.
 */
export type HeartbeatSettingsEnvelope =
  | { supported: false }
  | ({ supported: true } & Omit<HeartbeatSettings, "enabled"> & {
        controllable: HeartbeatControllableMap;
      });

/** Discriminated-union envelope for heartbeat status. Phase 3a-1: supports both copilot and gateway backends. */
export type HeartbeatStatusEnvelope =
  | { supported: false }
  | ({ supported: true } & HeartbeatStatus);

export const DEFAULT_WORK_DAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]); // Mon–Fri
export const DEFAULT_WORK_START_HOUR = 8;
export const DEFAULT_WORK_END_HOUR = 18;

export interface HeartbeatLogEntry {
  timestamp: string;
  type: "start" | "complete" | "skip" | "urgent" | "ok" | "error";
  message: string;
}

// ── AI Investigator ───────────────────────────────────────────────────────────

export type AIInvestigatorState =
  | "idle"
  | "collecting"
  | "investigating"
  | "ready"
  | "posting"
  | "posted"
  | "error";

export interface AIInvestigatorProgressLogEntry {
  timestamp: string;
  message: string;
}

export interface AIInvestigatorStatus {
  state: AIInvestigatorState;
  userDescription: string;
  log: AIInvestigatorProgressLogEntry[];
  /** Title parsed from the AI report (first H1). Available once state is "ready". */
  title?: string;
  /** Body of the AI report (everything after the title). Available once state is "ready". */
  body?: string;
  /** Resulting issue URL after a successful post. */
  issueUrl?: string;
  /** Fallback browser URL when the provider's direct filing path is unavailable. */
  fallbackUrl?: string;
  /** Set when state is "error". */
  error?: string;
  /** Destination the report will be filed against (e.g. "owner/repo"), from
   *  the configured issue-reporter provider. Surfaced so the modal can render
   *  "will be filed to <target>" without duplicating config reads. */
  target?: string;
  /** Display name of the configured issue-reporter provider (e.g. "GitHub"). */
  providerName?: string;
}

export type AIInvestigatorEvent =
  | { type: "status"; state: AIInvestigatorState }
  | { type: "progress"; message: string }
  | { type: "ready"; title: string; body: string }
  | { type: "posted"; issueUrl?: string; fallbackUrl?: string }
  | { type: "error"; error: string };

export interface AutomationStep {
  id: string;
  label: string;
  prompt: string;
}

/**
 * IPC schedule type — legacy flat fields are required, new union fields
 * (kind, time, intervalMinutes, anchor, times) are optional for backward compatibility.
 * The strict discriminated union lives in electron/automations.ts
 * (SingleSchedule | IntervalSchedule | MultiSchedule).
 * normalizeSchedule() bridges this loose shape to the strict union at all boundaries.
 */
export interface AutomationSchedule {
  naturalLanguage: string;
  days: number[];
  hour: number;
  minute: number;
  kind?: "single" | "interval" | "multi";
  time?: { hour: number; minute: number };
  intervalMinutes?: number;
  anchor?: { hour: number; minute: number };
  times?: { hour: number; minute: number }[];
  /**
   * Set by the gateway inverse-mapper when the cron job's schedule shape
   * isn't faithfully round-trippable to the Marshal `AutomationSchedule`
   * (e.g. a cron expression that doesn't cleanly map to (days, hour, minute)).
   * UI should treat schedule fields as read-only when this is true.
   */
  readOnly?: boolean;
}

/** Host-owned, non-secret application-job binding. Never sufficient to authorize execution. */
export interface AutomationApplicationJob {
  ownerKey: string;
  jobKey: string;
  jobId: string;
  state: "armed" | "disarmed" | "suspended-restart";
}

export interface AutomationData {
  id: string;
  name: string;
  description?: string;
  steps: AutomationStep[];
  schedule: AutomationSchedule;
  enabled: boolean;
  oneShot?: boolean;
  createdAt: string;
  updatedAt: string;
  triggerType: "schedule" | "condition";
  condition?: string;
  conditionCheckInterval?: number;
  workingDir?: string;
  skillNames?: string[];
  targetSessionId?: string;
  workspaceName?: string;
  repoPath?: string;
  pinnedSessionId?: string;
  /** `repo:<workspace>:<id>` or `personal:<id>` when generated from a routine file, which then owns the automation. */
  routineKey?: string;
  applicationJob?: AutomationApplicationJob;
  /** Optional per-automation model override. Falls back to the global default when unset. */
  model?: string;
  /** Optional per-automation reasoning effort; runs start with it instead of the model's default. */
  reasoningEffort?: ReasoningEffort;
  /** When true, ALL runs of this automation (scheduled, condition-triggered,
   *  and manual "Run now") launch Playwright's browser in headless mode so it
   *  runs invisibly. Default: false. */
  browserHeadless?: boolean;
  /** Per-run completion-notification policy. Missing/undefined is treated as
   *  `"always"` by the runtime — the historical behavior — so existing
   *  automations are unaffected by this field's introduction.
   *  - `"always"`: framework auto-relays the run's `finalOutput` to the notification relay
   *    via the existing second-pass LLM reformat path.
   *  - `"auto"`: framework sends nothing on completion; the agent decides
   *    per-run by calling `sendNotification` when there is something
   *    actionable to report.
   *  - `"never"`: framework never sends a notification for this automation
   *    (the agent's own in-conversation tool calls during the run are
   *    unaffected — that is the tool's normal behavior). */
  teamsNotify?: "always" | "auto" | "never";
  /** Per-automation permissions — full replacement for global when set. */
  permissions?: PermissionsConfig;
  /**
   * Set when a condition-triggered automation has fired (its watcher cron
   * self-removed in cloud, observed via WS `cron` removed event). Renderer
   * displays a "Fired at <time>" badge when present. Schedule-triggered
   * automations leave this undefined; their lifecycle uses `enabled: false`
   * (via `oneShot: true` + marshal's `deleteAfterRun`) instead.
   */
  firedAt?: string;
}

/**
 * Creation-time subset of `AutomationData`. Backends (CopilotAutomationBackend,
 * GatewayAutomationBackend) are responsible for assigning `id`, `createdAt`,
 * and `updatedAt`; the renderer supplies everything else. `enabled` is
 * optional (defaults to `true`); `triggerType` is optional (defaults to
 * `"schedule"` on copilot, forbidden as `"condition"` on gateway by
 * capability-gate + mapper guard).
 *
 * This shape lets `automations:create` IPC callers pass a typed payload
 * without casting to AutomationData to satisfy a create signature that
 * demands id/createdAt/updatedAt.
 */
export type AutomationCreateInput = Omit<
  AutomationData,
  "id" | "createdAt" | "updatedAt" | "enabled" | "triggerType"
> & { enabled?: boolean; triggerType?: "schedule" | "condition" };

export interface AutomationStepResult {
  stepId: string;
  // "skipped" is used by the gateway-mode multi-step history aggregator when
  // a chain failed mid-way and remaining steps never ran. Local-mode
  // (electron/automations/manager.ts) only uses pending/running/completed/
  // failed because it stops the loop at the first failure without producing
  // step results for the unrun tail.
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
}

/** Where a local routine is defined: a routine file (repo or personal) or an older scheduler it adapts. */
export type LocalRoutineSource = "repo" | "personal" | "automation" | "heartbeat" | "workflow";

/** One routine that runs on this Marshal, from a routine file or adapted from automations, the heartbeat or workflows v2. */
export interface LocalRoutineView {
  /** `repo:<id>`, `personal:<id>`, `automation:<id>`, `heartbeat` or `workflow:<name>`. */
  key: string;
  id: string;
  source: LocalRoutineSource;
  /** The workspace it belongs to: a repo file's workspace or the one an automation is bound to. Absent for the person's own and global routines. */
  workspaceName?: string;
  title: string;
  description?: string;
  placement: "local" | "cloud";
  enabled: boolean;
  /** Five-field cron expressions. */
  schedules: string[];
  /** Schedules that are not cron, already in words (an automation's own schedule text, the heartbeat interval). */
  scheduleLabels: string[];
  events: string[];
  manual: boolean;
  body?: "agent" | "workflow";
  /** The model and reasoning effort an agent routine file asks for; absent runs with the defaults. */
  model?: string;
  effort?: ReasoningEffort;
  channels: string[];
  people: string[];
  /** The definition file, when the routine has one. */
  path?: string;
  /** Why a routine file could not be read; such a routine never runs. */
  error?: string;
  /** Why a routine file does not fire on its own on this Marshal, when it should (a cron with no local equivalent). */
  scheduleNote?: string;
  /** The automation that fires and records the runs of a routine file. */
  automationId?: string;
  /** The latest runs of a routine file, newest first. */
  runs?: LocalRoutineRunEntry[];
  canRunNow: boolean;
}

export interface LocalRoutineRunEntry {
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  completedAt?: string;
  /** The chat the run happened in. */
  sessionId?: string;
}

export interface LocalRoutinesResult {
  success: boolean;
  routines?: LocalRoutineView[];
  error?: string;
}

export interface LocalRoutineRunRequest {
  workspaceName?: string;
  key: string;
  /** The chat whose runtime scope a workflow run uses (workflows run as a runtime capability). */
  sessionId?: string;
}

export interface LocalRoutineRunResult {
  success: boolean;
  /** The chat a run opened, when it opened one. */
  sessionId?: string;
  error?: string;
}

export interface LocalRoutineDetailsRequest {
  workspaceName?: string;
  key: string;
}

/** What a local routine does and when it runs, as far as this Marshal can show and change it. */
export interface LocalRoutineDetails {
  success: boolean;
  error?: string;
  /** The prompt the agent runs with. Absent when the routine runs a workflow. */
  prompt?: string;
  /** Where the prompt lives when it cannot be edited here (the heartbeat's settings, a workflow's main.ts). */
  promptSource?: string;
  promptEditable: boolean;
  /** cron: five-field expressions, one per line. text: a schedule in words. */
  scheduleKind: "cron" | "text" | "none";
  schedules: string[];
  scheduleEditable: boolean;
}

/** Changes the prompt and/or schedule of a routine file or an automation. */
export interface LocalRoutineUpdateRequest {
  workspaceName?: string;
  key: string;
  prompt?: string;
  /** Cron expressions for a routine file; one schedule in words for an automation. */
  schedules?: string[];
}

/** Turns a routine file (`repo:<id>`, `personal:<id>`) or a workflows-v2 schedule (`workflow:<name>`) on or off. Automations and the heartbeat keep their own toggles. */
export interface LocalRoutineEnabledRequest {
  workspaceName?: string;
  key: string;
  enabled: boolean;
}

export interface AutomationRunData {
  id: string;
  automationId: string;
  automationName?: string;
  sessionId?: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "skipped";
  stepResults: AutomationStepResult[];
  finalOutput?: string;
}

export interface MServerPermissions {
  write?: boolean;
  shell?: boolean;
  mcp?: boolean;
  read?: boolean;
  url?: boolean;
  "custom-tool"?: boolean;
}

/**
 * Per-field controllable entry. Carries editability plus an optional
 * backend-supplied reason and help URL so the renderer stays fully
 * backend-agnostic (no gatewayTooltips.ts lookup needed).
 */
export interface PermissionsControllableField {
  /** Whether this field is editable in the UI. */
  enabled: boolean;
  /** Tooltip text when `enabled: false`. Renderer surfaces this verbatim. */
  disabledReason?: string;
  /** Optional learn-more URL (e.g. lobster issue tracking the gap). */
  helpUrl?: string;
}

/**
 * Per-field controllable map for the permissions UI. Copilot backend
 * returns all-enabled; gateway backend returns the spec-defined partial
 * map with disabled-reason strings for unsupported fields.
 */
export type PermissionsControllableMap = Record<
  | "tools"
  | "autopilotMode"
  | "autoApproveReadOnly"
  | "shellAllow"
  | "shellDeny"
  | "serverEnabled"
  | "serverAutoApprove"
  | "perHeartbeatScope",
  PermissionsControllableField
>;

/**
 * Read envelope returned by the permissions backend. `permissions` always
 * carries a complete `PermissionsConfig` (defaults filled in). Set
 * `hasUnrepresentablePatterns` when the marshal config carries glob
 * patterns we can't represent as booleans — the UI swaps the affected
 * tool grid for a banner pointing at the raw-JSON editor.
 */
export interface PermissionsEnvelope {
  supported: boolean;
  permissions: PermissionsConfig;
  controllable: PermissionsControllableMap;
  hasUnrepresentablePatterns?: boolean;
}

export interface ToolInfo {
  key: string;
  name: string;
  description?: string;
}

export interface ToolGroup {
  key: string;
  name: string;
  tools: ToolInfo[];
  status?: "connected" | "disconnected" | "static" | "loading" | "error";
}

export interface ToolCategory {
  key: string;
  name: string;
  groups: ToolGroup[];
}

export type CustomMcpServer =
  | {
      name: string;
      url: string;
      type?: "http" | "sse";
      clientId?: string;
      tokenEndpoint?: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiry?: number;
      accessTokenOrigin?: string;
      /** Per-server tool-call timeout in milliseconds. Forwarded to the Copilot SDK as MCPServerConfig.timeout. */
      timeout?: number;
      exposeAsGatewayNodeCommand?: boolean;
      oauthAlias?: string;
    }
  | {
      name: string;
      type: "command";
      command: string;
      args?: string[];
      /** Optional .env file path. `${workspaceFolder}` is substituted at load time. */
      envFile?: string;
      /** Per-server tool-call timeout in milliseconds. Forwarded to the Copilot SDK as MCPServerConfig.timeout. */
      timeout?: number;
      exposeAsGatewayNodeCommand?: boolean;
    };

// ── MCP Store Types ────────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  description: string;
  namespacedName?: string;
  /** JSON Schema from the MCP server's listTools(). Round-tripped to the
   *  gateway-side LLM via mcp.help; not validated here. */
  inputSchema?: unknown;
}

export interface McpServerInfo {
  key: string;
  name: string;
  builtin: boolean;
  config?: CustomMcpServer;
  tools?: McpToolInfo[];
  status?: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured";
  error?: string;
  requiresOAuth?: boolean;
  oauthAlias?: string;
}

// ── Extensions MCP Input Types ──────────────────────────────────────────────

export interface AddMcpServerInput {
  name: string;
  mode: "url" | "command";
  url?: string;
  command?: string;
  bearerToken?: string;
  /** Per-server tool-call timeout in milliseconds. Optional — when omitted the SDK default applies. */
  timeout?: number;
  exposeAsGatewayNodeCommand?: boolean;
  /** Defaults to ``http`` (streamable HTTP); ``sse`` selects the legacy
   *  Server-Sent Events transport. Ignored when ``mode === "command"``. */
  transport?: "http" | "sse";
  /** Optional .env file path (supports ``${workspaceFolder}``). Ignored when ``mode === "url"``. */
  envFile?: string;
}

export interface InstallCatalogMcpInput {
  name: string;
  catalogContent: string;
}

export interface SaveMcpConfigInput {
  serverName: string;
  catalogContent: string;
  configParams: Array<{ key: string; required?: boolean }>;
  values: Record<string, string>;
}

// ── Activities Aggregated Types ─────────────────────────────────────────────

export interface ConditionStatusRecord {
  lastCheck: string | null;
  nextCheck: string | null;
  lastError: string | null;
}

export interface ActivitiesAggregatedResult {
  success: boolean;
  heartbeatStatus?: HeartbeatStatus;
  heartbeatSettings?: HeartbeatSettings;
  heartbeatLogs?: HeartbeatLogEntry[];
  automations?: AutomationData[];
  allAutomationRuns?: AutomationRunData[];
  conditionStatuses?: Record<string, ConditionStatusRecord>;
  error?: string;
}

export interface WhatsAppSettings {
  enabled: boolean;
  defaultNotificationsEnabled: boolean;
  progressNotificationsEnabled: boolean;
}

export interface WhatsAppAccountSummary {
  phoneNumber?: string;
  displayName?: string;
  username?: string;
}

export interface WhatsAppProvisioningStatus {
  community: boolean;
  newChats: boolean;
  progress: boolean;
  informationControl: boolean;
}

export interface WhatsAppStatus {
  runtimeId: "whatsapp-baileys";
  initialized: boolean;
  connection:
    | "starting"
    | "connecting"
    | "awaiting-qr"
    | "connected"
    | "reconnecting"
    | "stopped"
    | "requires-reset";
  settings: WhatsAppSettings;
  qr?: string;
  account?: WhatsAppAccountSummary;
  provisioning?: WhatsAppProvisioningStatus;
  error?: string;
}

export interface MSettings extends MiniModeSettings, WorkServiceProviderSettings {
  /** @deprecated — migrated to permissions block */
  autoApprove: {
    global: boolean;
    perServer: Record<string, MServerPermissions>;
  };
  permissions?: PermissionsConfig;
  theme?: "system" | "light" | "dark";
  whatsapp?: WhatsAppSettings;
  interceptFileChooser?: boolean;
  experiments?: ExperimentFlags;
  /** Organization URL (serves `/.well-known/marshal-org.json`). An admin policy `orgUrl` overrides it. */
  orgUrl?: string;
  /** Developer builds only: trust the local build of an extension that may use the org services. */
  trustLocalOrgExtensions?: boolean;
  /** String-keyed runtime adapter selected at the next app startup. */
  runtimeId?: string;
  /** Memory persistence provider selected at the next app startup. */
  memoryProviderId?: string;
  /** Session persistence provider selected at the next app startup. */
  sessionStorageProviderId?: string;
  /** Ordered skill-provider IDs enabled for catalog composition. */
  skillProviderIds?: string[];
  /** Auto-delete sessions older than this many days. 0 = disabled. Default: 90. */
  sessionRetentionDays?: number;
  /** Rerank searchSessions results with OpenAI when a key is configured. Default: true. */
  sessionRecallRerank?: boolean;
  /** User interface customization (edits to placement parts, disabled contributions, replacement winners, theme). */
  interfaceCustomization?: InterfaceCustomization;
  /** Re-run the transactional update when a locally installed extension's source directory changes. Default: true. */
  localExtensionHotReload?: boolean;
  /** Whether the user has opted in to optional diagnostic telemetry. Defaults to true. */
  telemetryEnabled?: boolean;
  /** Set once the first-run offer to import Claude Code, Codex and Cursor sessions was shown. */
  sessionImportOffered?: boolean;
  /** Cross-platform: prevent system idle sleep while a relay/Heartbeat are active. */
  preventSleepEnabled?: boolean;
  /** Windows-only keep-awake mouse jiggle while a relay/Heartbeat are active. */
  mouseWiggleEnabled?: boolean;
  /** Keep the machine awake whenever Marshal is running. */
  alwaysKeepAwakeEnabled?: boolean;
  /** Override the default workspace directory (Documents/Marshal). Takes effect on next launch. */
  workspaceDir?: string;
  /** Override the root for new subagent git worktrees. Existing worktrees are not moved. */
  worktreeDir?: string;
  /** Provider-neutral model policy snapshotted when an autonomous swarm run is created. */
  swarmRoleModels?: Partial<
    Record<
      "planner" | "reviewer" | "worker" | "reconciler",
      {
        model: string;
        reasoningEffort?: ReasoningEffort;
      }
    >
  >;
  /** Default model for worker-role sessions created by autonomous swarm runs. */
  swarmWorkerModel?: string;
  /** Default reasoning effort for worker-role sessions created by autonomous swarm runs. */
  swarmWorkerReasoningEffort?: ReasoningEffort;
  /** Local runtime that runs plain model ids of each provider family (e.g. openai → cursor).
   *  Unset families run on the active runtime. See common/model-runtime-routing.ts. */
  modelRuntimeRouting?: ModelRuntimeRouting;
  /** Extra signed-in accounts per local runtime and which one plain models use.
   *  See common/runtime-accounts.ts. */
  runtimeAccounts?: RuntimeAccountsSettings;
  /** When true, the in-app updater queries the beta channel (GitHub prereleases). Default: false. */
  updateChannelBeta?: boolean;
  /** Destination for AI-investigated bug reports. Provider-neutral: `target`
   *  is interpreted by the selected issue-reporter provider (for GitHub,
   *  `owner/repo`). Absent by default — the feature is then unavailable. */
  issueReporter?: IssueReporterSettings;
}

export interface IssueReporterSettings {
  /** Issue-reporter provider id. Defaults to "github". */
  providerId?: string;
  /** Provider-interpreted destination, e.g. "owner/repo". */
  target?: string;
}

export interface RuntimeStartupSelection {
  requestedRuntimeId: string;
  runtimeId: string;
}

export interface RuntimeSwitchResult {
  selection: RuntimeStartupSelection;
  requiresRestart: boolean;
}

export type ExperimentFlags = {
  /** Marshal-owned full-replacement system prompt on Claude and Cursor (staged experiment; default off). */
  promptReplacement?: boolean;
  /** Lean Claude system prompt sections and trimmed native tools for new sessions (default on). Off restores the legacy prompt exactly; env MARSHAL_LEAN_PROMPT=0/1 overrides. */
  leanPrompt?: boolean;
  /** Forward an index of large always-apply repo rule files instead of their bodies for new Claude sessions (default on); env MARSHAL_LEAN_REPO_RULES=0/1 overrides. */
  leanRepoRules?: boolean;
  /** Rewritten, shorter behavior core for new Claude sessions (default on); env MARSHAL_LEAN_CORE=0/1 overrides. */
  leanCore?: boolean;
  /** Agent prompt v2: the rewritten system prompt and leaner native tool list for new Claude sessions (default off); env MARSHAL_AGENT_PROMPT_V2=0/1 overrides, and 0 also reverts existing sessions. */
  agentPromptV2?: boolean;
  /** Subagents v2: sessions on a runtime with `sessionFork` delegate by forking themselves into subagents that resume from the parent's exact context and prompt cache; spawnSubagent and its guidance are withdrawn while it is on (default on). */
  forkSubagents?: boolean;
  /** Show back/forward navigation buttons in the title bar. */
  titleBarNavigation?: boolean;
  /** When true, enables the UI extensions system for 1P features. */
  uiExtensionsSystem?: boolean;
  /** Flag `org.enabled`: master switch for Marshal Org. Off means no org network calls and no org UI (default on). */
  orgEnabled?: boolean;
  /** Flag `org.signIn`: organization sign-in; needs `orgEnabled` (default on). */
  orgSignIn?: boolean;
  /** Flag `org.workspaces`: linking local workspaces to organization workspaces; needs `orgEnabled` and `orgSignIn` (default on). */
  orgWorkspaces?: boolean;
  /** Flag `org.remoteSessions`: "Shared with me" organization sessions, read-only; needs `orgEnabled` and `orgSignIn` (default on). */
  orgRemoteSessions?: boolean;
  /** Flag `org.sessionSharing`: share a local session with the organization; needs `orgEnabled`, `orgSignIn` and `orgWorkspaces` (default on). */
  orgSessionSharing?: boolean;
  /** Flag `org.mentions`: `@` mentions in the composer that grant and notify; needs `orgSessionSharing` (default on). */
  orgMentions?: boolean;
  /** Flag `org.cloudMove`: move a shared session to the organization's cloud and bring it back; needs `orgEnabled`, `orgSignIn`, `orgWorkspaces` and `orgSessionSharing` (default on). */
  orgCloudMove?: boolean;
  /** Flag `org.sessionAudit`: search, read and analyze the organization's engine runs; needs `orgEnabled` and `orgSignIn` (default off). */
  orgSessionAudit?: boolean;
  /** Flag `org.remoteMode`: keep the composer usable while the organization's cloud holds a session; sends go to the session's inbox. Needs `orgCloudMove` and a cloud that serves `messages` (default on). */
  orgRemoteMode?: boolean;
  /** Flag `org.cloudGroup`: a collapsed "Cloud" sidebar group listing the sessions the organization's cloud holds for you; needs `orgCloudMove` and a cloud that serves `cloudList` (default on). */
  orgCloudGroup?: boolean;
  /** Flag `org.fork`: fork a session shared with you (driver or owner) into a new private local session, from its last completed turn; the code is not copied. Needs `orgRemoteSessions` and an organization that serves `forks` (default off). */
  orgFork?: boolean;
  /** Flag `org.placement`: a move to the cloud carries the session's git work (unpushed commits, tracked changes and untracked files) as a bundle. Needs `orgCloudMove` and a cloud that serves `placement` (default off). */
  orgPlacement?: boolean;
  /** Flag `org.liveSessions`: shared sessions people write in together; each person's own Marshal answers their own messages on their own computer. Needs `orgRemoteSessions`, `orgSessionSharing`, `orgMentions` and an organization that serves `sharedTranscript` (default off). */
  orgLiveSessions?: boolean;
  /** Flag `org.rooms` (hidden experiment): rooms extensions share live through the organization's rooms service; needs `orgSignIn` and an organization that serves `rooms` (default off). */
  orgRooms?: boolean;
};

export interface BackgroundServiceSettings {
  /**
   * When enabled, closing or minimizing the main window hides it to the system tray
   * rather than quitting the application. The process continues running
   * in the background and scheduled automations/heartbeats keep firing.
   */
  enabled: boolean;

  /**
   * Register M as a Windows/macOS login item so it launches automatically
   * at system startup. Uses app.setLoginItemSettings() which writes to the
   * Windows registry (HKCU\Software\Microsoft\Windows\CurrentVersion\Run)
   * or macOS launchd plist.
   */
  runOnStartup: boolean;

  /**
   * When true (and enabled is true), the app launches with the window
   * hidden — only the tray icon is visible. Users click the tray to open.
   */
  hideOnLaunch: boolean;
}

export interface TenantPolicyStatus {
  success: boolean;
  managed: boolean;
  disabledServers: string[];
  disabledPermissionKinds: string[];
  forcePrompt: boolean;
  disabledModels: string[];
  disableHeartbeat: boolean;
  disableAutomations: boolean;
  disabledProviders: string[];
  restrictToWorkspace: boolean;
  browserEgressBlockedOrigins: string[];
  /** Organization URL an admin policy pins; absent when no policy sets one. */
  orgUrl?: string;
}

// ── User Identity (backend-agnostic) ─────────────────────────────────────────
// The renderer's PersonContextMenu consumes only this shape — no
// `if (isGateway)` branching. The main process composes it from whichever
// runtime is active (Copilot auth, Gateway auth, or generic
// local-runtime auth), so adding a future backend is a composer change, not a
// UI change.

export interface UserIdentityIntegration {
  /** Stable id for click routing (e.g., "relay"). Renderer doesn't
   *  need to branch on the id — it just looks it up against its own handler
   *  map when applicable. */
  id: string;
  name: string;
  connected: boolean;
}

export interface UserIdentitySignOut {
  title: string;
  description: string;
  confirmLabel: string;
}

export interface UserIdentity {
  /** Current runtime authentication state. */
  isAuthenticated: boolean;
  /** Top-line name the user thinks of themselves as. */
  displayName: string;
  /** Secondary label under the name (e.g., "Lobster · AAD" or a GitHub handle). */
  subtitle: string | null;
  /** User account name/email suitable as a non-secret login hint, when known. */
  accountName: string | null;
  /** Absolute URL to the avatar image, or null for the placeholder. */
  avatarUrl: string | null;
  /** Base status color reflecting auth + integration state. The session-level
   *  connection indicator is applied as a further override in the renderer. */
  statusColor: "success" | "warning" | "danger" | "muted";
  statusText: string;
  /** Backend-specific integrations (e.g. relay). Empty array when the
   *  active backend doesn't surface any. */
  integrations: UserIdentityIntegration[];
  /** Copy for the Sign-out confirm dialog, filled by the backend so the
   *  renderer doesn't need to know whether to say "Sign out" or "Disconnect". */
  signOut: UserIdentitySignOut;
}

// ── Gateway Auth ────────────────────────────────────────────────────────────

export type GatewayAuthMode = "no-auth" | "hosted";

/** Exhaustive list of valid GatewayAuthMode values. Exported so main-process
 *  boundary validators can check incoming IPC payloads against a single
 *  source of truth. */
export const GATEWAY_AUTH_MODES: ReadonlyArray<GatewayAuthMode> = ["no-auth", "hosted"];

/** Defaults to ``operator`` when absent — pre-roleMode persisted creds
 *  must keep working. ``no-auth`` is implicit operator. */
export type GatewayRoleMode = "operator" | "node" | "operator-and-node";

export const GATEWAY_ROLE_MODES: ReadonlyArray<GatewayRoleMode> = [
  "operator",
  "node",
  "operator-and-node",
];

export function roleModeIncludesOperator(roleMode: GatewayRoleMode | undefined): boolean {
  return roleMode === undefined || roleMode === "operator" || roleMode === "operator-and-node";
}

export function roleModeIncludesNode(roleMode: GatewayRoleMode | undefined): boolean {
  return roleMode === "node" || roleMode === "operator-and-node";
}

export function isGatewayRoleMode(value: string): value is GatewayRoleMode {
  return (GATEWAY_ROLE_MODES as ReadonlyArray<string>).includes(value);
}

// ── Gateway Node activity ──────────────────────────────────────────────────

export type NodeActivityDirection = "inbound" | "outbound";

export type NodeActivityStatus = "received" | "ok" | "error";

export interface NodeActivityEntry {
  id: string;
  timestamp: number;
  direction: NodeActivityDirection;
  command: string;
  invocationId: string;
  status: NodeActivityStatus;
  durationMs?: number;
  paramsPreview?: string;
  resultPreview?: string;
  errorMessage?: string;
}

export interface GatewayAuthIdentity {
  mode: GatewayAuthMode;
  oid?: string;
  tid?: string;
  roleMode?: GatewayRoleMode;
  /** Defaults to the OS hostname in main when undefined. */
  nodeName?: string;
}

export type GatewayAuthStatus = "picking" | "connecting" | "pairing" | "signed-in" | "error";

export interface GatewayAuthState {
  status: GatewayAuthStatus;
  identity?: GatewayAuthIdentity;
  error?: string;
  /** When status === "pairing", the Marshal device pair requestId returned
   *  by the gateway. The user references this when approving on another
   *  paired surface (CLI: `marshal nodes approve <requestId>`). */
  pairingRequestId?: string;
  /** OR of operator + node reconnect-loop states. Status stays at
   *  "signed-in" through the cycle so the renderer shows a banner
   *  rather than churning the auth gate. */
  reconnecting?: boolean;
}

/** A device with a pending pair-approval request, returned by marshal's
 *  `device.pair.list` RPC. Surfaced in m's local-dev device-approval panel
 *  so a developer running an marshal container locally can approve scope
 *  upgrades (e.g. for cron-fired agents needing `cron.*` admin scope)
 *  without exec'ing into the container. Local mode only. */
export interface PendingDeviceRequest {
  requestId: string;
  deviceId: string;
  displayName?: string;
  platform?: string;
  role?: string;
  /** Scopes the device is requesting. Caller-side display only — marshal is
   *  the source of truth for what's actually granted on approve. */
  scopes?: string[];
  /** Wall-clock ms timestamp of the original pair request. */
  ts: number;
}

/** Subset of marshal's `PairedDevice` shape that the renderer cares about.
 *  Token material is intentionally omitted — m never needs to display it. */
export interface PairedDevice {
  deviceId: string;
  displayName?: string;
  role?: string;
  approvedAtMs: number;
  lastSeenAtMs?: number;
}

export interface WorkspaceUIState {
  activeWorkspace: string;
  expandedPaths: Record<string, string[]>; // workspace name → relative paths
  selectedFiles?: Record<string, string>; // workspace name → relative path
}

export interface WorkspaceDirEntry {
  name: string;
  type: "file" | "directory";
}

export interface ElectronAPI {
  spawnPty: () => Promise<{ pid: number }>;
  writePty: (data: string) => void;
  resizePty: (cols: number, rows: number) => void;
  killPty: () => void;
  onPtyData: (callback: (data: string) => void) => void;
  onPtyExit: (callback: (exitCode: number) => void) => void;
  removePtyListeners: () => void;
}

// ── IPC Invoke Map ──────────────────────────────────────────────────────────

export interface RuntimeExtensionsScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export interface RuntimeExtensionsSearchRequest extends RuntimeExtensionsScope {
  readonly search?: RuntimeExtensionCatalogSearchRequest;
}

export interface RuntimeExtensionsMutationRequest extends RuntimeExtensionsScope {
  readonly catalogEntryId: string;
}

export interface RuntimeExtensionsLocalInstallRequest extends RuntimeExtensionsScope {
  readonly packageRoot: string;
}

export interface RuntimeExtensionsUpdateRequest extends RuntimeExtensionsScope {
  readonly identity: string;
  readonly catalogEntryId?: string;
  readonly packageRoot?: string;
}

export interface RuntimeExtensionsIdentityRequest extends RuntimeExtensionsScope {
  readonly identity: string;
}

export interface RuntimeExtensionsConfigurationRequest extends RuntimeExtensionsIdentityRequest {
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface RuntimeExtensionsProviderRequest extends RuntimeExtensionsScope {
  readonly identity: string;
  readonly serviceId: string;
  readonly providerId?: string;
}

export interface RuntimeExtensionsContractRepairRequest extends RuntimeExtensionsScope {
  readonly request: RuntimeExtensionContractRepairRequest;
}

export type RuntimeExtensionProjectedStatus =
  | "detected"
  | "installing"
  | "installed-enabled"
  | "installed-disabled"
  | "invalid"
  | "unbuilt"
  | "unreadable";

export interface RuntimeExtensionStatusDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RuntimeExtensionProjectedStatusItem {
  readonly candidateId: string;
  readonly catalogEntryId?: string;
  readonly identity?: string;
  readonly version?: string;
  readonly packageRoot?: string;
  readonly installation?: {
    readonly script: string;
    readonly packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  };
  readonly status: RuntimeExtensionProjectedStatus;
  readonly diagnostics: readonly RuntimeExtensionStatusDiagnostic[];
  readonly operation?: {
    readonly kind: "install";
    readonly startedAt: string;
    readonly initiatingSessionId: string;
    readonly initiatingWorkspaceName: string;
  };
}

export interface RuntimeExtensionsStatusSnapshot extends RuntimeExtensionsScope {
  readonly revision: number;
  readonly scannedAt: string;
  readonly discoveryStatus: "ready" | "error" | "unavailable";
  readonly items: readonly RuntimeExtensionProjectedStatusItem[];
  readonly diagnostics: readonly RuntimeExtensionStatusDiagnostic[];
}

export interface RuntimeExtensionsChangedEvent {
  readonly revision: number;
  readonly sessionId?: string;
  readonly workspaceName?: string;
}

export interface RuntimeExtensionLiveComposition {
  readonly health?: string;
  readonly blockingReason?: string;
  readonly missingDependencies?: readonly string[];
  readonly disabledDependencies?: readonly string[];
  readonly incompatibleContracts?: readonly string[];
  readonly providedServices?: readonly string[];
  readonly requiredServices?: readonly string[];
  readonly contracts?: readonly {
    readonly id: string;
    readonly shape?: string;
    readonly selectedProvider?: string;
    readonly alternatives?: readonly string[];
    readonly collisions?: readonly string[];
  }[];
  readonly configurationSchema?: unknown;
  readonly configurationValues?: Readonly<Record<string, unknown>>;
  readonly docs?: readonly string[];
  readonly resources?: readonly string[];
  readonly examples?: readonly string[];
  readonly appServicesSnippet?: string;
}

export type RuntimeExtensionsCatalogSearchResponse = Omit<
  RuntimeExtensionCatalogSearchResponseBase,
  "matches"
> & {
  readonly matches: readonly (RuntimeExtensionCatalogSearchResponseBase["matches"][number] & {
    readonly entry: RuntimeExtensionCatalogSearchResponseBase["matches"][number]["entry"] & {
      readonly liveComposition?: RuntimeExtensionLiveComposition;
    };
  })[];
};

export type RuntimeExtensionsIpcResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly error: string };

export interface IpcInvokeMap extends RuntimeAcceptanceIpcInvokeMap {
  "remote-access:setupTailscale": () => Promise<import("./remote-access").RemoteAccessState>;
  "remote-access:getState": () => Promise<import("./remote-access").RemoteAccessState>;
  "remote-access:configure": (input: {
    enabled: boolean;
    origin: string;
    rotateKey?: boolean;
  }) => Promise<import("./remote-access").RemoteAccessState>;
  // appAPI
  "app:getDefaultWorkspaceDir": () => Promise<{
    success: boolean;
    defaultWorkspaceDir?: string;
    error?: string;
  }>;

  // copilotAPI
  "copilot:init": () => Promise<{
    success: boolean;
    sessionId?: string;
    error?: string;
    mockMode?: boolean;
  }>;
  "copilot:send": (
    message: string,
    sessionId?: string,
    attachments?: CopilotAttachment[],
    /** Shared between the optimistic insert and the broadcast so peer
     *  windows can dedupe by id when the broadcast echoes back. */
    clientMessageId?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "copilot:steer": (
    message: string,
    sessionId?: string,
    attachments?: CopilotAttachment[],
    clientMessageId?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "copilot:abort": (sessionId?: string) => Promise<{ success: boolean; error?: string }>;
  "copilot:destroy": () => Promise<{ success: boolean }>;
  "copilot:saveImage": (
    base64Data: string,
    mimeType: string,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  "overlay-review:launch": (
    request: OverlayReviewLaunchRequest,
  ) => Promise<{ success: boolean; error?: string }>;
  "overlay-review:claim": (
    sessionId: string,
  ) => Promise<{ reviews: OverlayReviewSubmittedEvent[] }>;
  "copilot:checkAuth": () => Promise<{
    success: boolean;
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
    copilotPlan?: string;
    error?: string;
  }>;
  "copilot:getVersion": () => Promise<{ success: boolean; version?: string }>;
  "copilot:getSystemInfo": () => Promise<{
    success: boolean;
    version?: string;
    platform?: string;
    arch?: string;
    osVersion?: string;
  }>;
  "copilot:login": () => Promise<{ success: boolean; error?: string }>;
  "copilot:startDeviceFlow": () => Promise<{
    success: boolean;
    isAuthenticated?: boolean;
    needsDeviceFlow?: boolean;
    deviceCode?: string;
    verificationUri?: string;
    error?: string;
  }>;
  "copilot:openDeviceFlowPage": (code?: string) => Promise<{ success: boolean; error?: string }>;
  "copilot:signOut": () => Promise<{ success: boolean; error?: string }>;
  "copilot:resolvePermission": (
    requestId: string,
    action: PermissionAction,
    /** When set, the main process re-runs guardrails on the pattern and
     *  writes it to `request.approvalPattern` if it survives. Used by the
     *  PermissionCard's secondary "Allow broader pattern" action. */
    overridePattern?: string,
  ) => Promise<{ success: boolean }>;

  // runtimeAuthAPI
  "runtimeAuth:getStatus": () => Promise<{
    success: boolean;
    status?: RuntimeAuthStatus;
    error?: string;
  }>;
  "runtimeAuth:login": (
    request: RuntimeAuthLoginRequest,
  ) => Promise<{ success: boolean; state?: RuntimeAuthLoginState; error?: string }>;
  "runtimeAuth:signOut": () => Promise<{ success: boolean; error?: string }>;

  // runtimeAccountsAPI
  "runtimeAccounts:list": () => Promise<{
    success: boolean;
    runtimes?: RuntimeAccountsView[];
    error?: string;
  }>;
  "runtimeAccounts:add": (
    runtimeId: string,
    label: string,
  ) => Promise<{ success: boolean; account?: RuntimeAccountView; error?: string }>;
  "runtimeAccounts:rename": (
    runtimeId: string,
    accountId: string,
    label: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "runtimeAccounts:remove": (
    runtimeId: string,
    accountId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "runtimeAccounts:setDefault": (
    runtimeId: string,
    accountId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "runtimeAccounts:getStatus": (
    runtimeId: string,
    accountId: string,
  ) => Promise<{ success: boolean; status?: RuntimeAuthStatus; error?: string }>;
  "runtimeAccounts:getUsage": (
    runtimeId: string,
    accountId: string,
    options?: { force?: boolean },
  ) => Promise<{ success: boolean; usage?: RuntimeAccountUsage; error?: string }>;
  "runtimeAccounts:login": (
    runtimeId: string,
    accountId: string,
    request: RuntimeAuthLoginRequest,
  ) => Promise<{ success: boolean; state?: RuntimeAuthLoginState; error?: string }>;
  "runtimeAccounts:signOut": (
    runtimeId: string,
    accountId: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // runtimeUiAPI
  "runtime-ui:getEvidence": (
    request: RuntimeUiScope,
  ) => Promise<RuntimeUiIpcResult<readonly import("./runtime-ui").RuntimeUiEvidenceEntry[]>>;
  "runtime-ui:openEvidence": (
    request: import("./runtime-ui").RuntimeUiEvidenceOpenRequest,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:getSnapshot": (
    request: RuntimeUiScope,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiSnapshot>>;
  "runtime-ui:subscribe": (
    request: RuntimeUiScope,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiSnapshot>>;
  "runtime-ui:unsubscribe": (scope?: RuntimeUiScope) => Promise<{ success: boolean }>;
  "runtime-ui:open": (
    request: RuntimeUiOpenCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:update": (
    request: RuntimeUiUpdateCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:focus": (
    request: RuntimeUiFocusCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:close": (
    request: RuntimeUiCloseCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:list": (
    request: RuntimeUiListCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:getPlacements": (request: RuntimeUiScope) => Promise<RuntimeUiPlacementSnapshot>;
  "runtime-ui:activatePlacement": (
    request: RuntimeUiPlacementInvokeRequest,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiCommandResult>>;
  "runtime-ui:invokePlacementCapability": (
    request: import("./runtime-ui").RuntimeUiPlacementCapabilityRequest,
  ) => Promise<RuntimeUiIpcResult<import("./runtime-ui").RuntimeUiApplicationCapabilityValue>>;
  "runtime-ui:selectSession": (
    request: RuntimeUiSelectSessionCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiSelectedSession | null>>;
  "runtime-ui:getSelectedSession": (
    request: RuntimeUiApplicationHostCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiSelectedSession | null>>;
  "runtime-ui:searchSessions": (
    request: import("./runtime-ui").RuntimeUiSessionSearchRequest,
  ) => Promise<RuntimeUiIpcResult<readonly import("./runtime-ui").RuntimeUiSessionSearchResult[]>>;
  "runtime-ui:selectImages": (
    request: RuntimeUiApplicationHostCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiImageHandle[]>>;
  "runtime-ui:listImages": (
    request: RuntimeUiApplicationHostCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiImageHandle[]>>;
  "runtime-ui:readImage": (
    request: RuntimeUiImageCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiImageContent>>;
  "runtime-ui:releaseImage": (request: RuntimeUiImageCommand) => Promise<RuntimeUiIpcResult<null>>;
  "runtime-ui:invokeCapability": (
    request: RuntimeUiApplicationCapabilityInvokeCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiApplicationCapabilityValue>>;
  "runtime-ui:cancelCapability": (
    request: RuntimeUiApplicationCapabilityCancelCommand,
  ) => Promise<RuntimeUiIpcResult<{ readonly cancelled: boolean }>>;
  "runtime-ui:readResource": (
    request: RuntimeUiApplicationResourceReadCommand,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiApplicationResourceContent>>;
  "runtime-ui:getLayout": (
    request: RuntimeUiScope,
  ) => Promise<RuntimeUiIpcResult<import("./runtime-ui-layout").RuntimeUiLayoutSnapshot>>;
  "runtime-ui:saveLayout": (
    request: import("./runtime-ui-layout").RuntimeUiLayoutSaveRequest,
  ) => Promise<RuntimeUiIpcResult<null>>;
  "runtime-ui:reportViewHealth": (
    request: import("./runtime-ui-health").RuntimeUiViewHealthReport,
  ) => Promise<RuntimeUiIpcResult<null>>;
  "runtime-ui:compileStreamFrame": (
    request: import("./streaming-ui").RuntimeUiStreamFrameRequest,
  ) => Promise<RuntimeUiIpcResult<import("./streaming-ui").RuntimeUiStreamFrame>>;
  "runtime-ui:readStreamTemplate": (
    request: import("./streaming-ui").RuntimeUiStreamScope,
  ) => Promise<RuntimeUiIpcResult<RuntimeUiApplicationResourceContent>>;
  "runtime-ui:promoteStreamFrame": (
    request: import("./streaming-ui").RuntimeUiStreamPromoteRequest,
  ) => Promise<RuntimeUiIpcResult<import("./streaming-ui").RuntimeUiStreamPromoteResult>>;

  "runtime-extensions:search": (
    request: RuntimeExtensionsSearchRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionsCatalogSearchResponse>>;
  "runtime-extensions:status": (
    request: RuntimeExtensionsScope,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionsStatusSnapshot>>;
  "runtime-extensions:install": (
    request: RuntimeExtensionsMutationRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:installLocal": (
    request: RuntimeExtensionsLocalInstallRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:update": (
    request: RuntimeExtensionsUpdateRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:enable": (
    request: RuntimeExtensionsIdentityRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:disable": (
    request: RuntimeExtensionsIdentityRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:configure": (
    request: RuntimeExtensionsConfigurationRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:setProvider": (
    request: RuntimeExtensionsProviderRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:clearProvider": (
    request: RuntimeExtensionsProviderRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionRecord>>;
  "runtime-extensions:repairContractConflict": (
    request: RuntimeExtensionsContractRepairRequest,
  ) => Promise<RuntimeExtensionsIpcResult<RuntimeExtensionContractRepairResult>>;
  "runtime-extensions:remove": (
    request: RuntimeExtensionsIdentityRequest,
  ) => Promise<RuntimeExtensionsIpcResult<null>>;

  // swarmAPI
  "swarm:create": (request: {
    sessionId: string;
    objective: string;
    fresh?: boolean;
    resourceIds?: string[];
    roleModels?: MSettings["swarmRoleModels"];
    workerModel?: string;
    workerReasoningEffort?: ReasoningEffort;
  }) => Promise<{
    success: boolean;
    runId?: string;
    state?: "running" | "paused" | "blocked" | "completed" | "failed";
    error?: string;
  }>;
  "swarm:get": (
    sessionId: string,
    runId: string,
  ) => Promise<{
    success: boolean;
    runId?: string;
    state?: "running" | "paused" | "blocked" | "completed" | "failed";
    error?: string;
  }>;
  "swarm:pause": (
    sessionId: string,
    runId: string,
    reason?: string,
  ) => Promise<{
    success: boolean;
    runId?: string;
    state?: "running" | "paused" | "blocked" | "completed" | "failed";
    error?: string;
  }>;
  "swarm:resume": (
    sessionId: string,
    runId: string,
  ) => Promise<{
    success: boolean;
    runId?: string;
    state?: "running" | "paused" | "blocked" | "completed" | "failed";
    error?: string;
  }>;

  // permissionsAPI
  "permissions:get-cards": (
    sessionId: string,
  ) => Promise<{ success: boolean; cards?: PermissionCardData[] }>;
  "permissions:clear-cards": (sessionId: string) => Promise<{ success: boolean }>;
  "permissions:list-tools": () => Promise<{
    success: boolean;
    categories?: ToolCategory[];
  }>;
  "permissions:get-config": () => Promise<
    { success: true; envelope: PermissionsEnvelope } | { success: false; error: string }
  >;
  "permissions:save-config": (
    patch: Partial<PermissionsConfig>,
  ) => Promise<
    | { success: true; rejectedShellPatterns?: string[] }
    | { success: false; error: string; conflict?: PermissionsEnvelope }
  >;

  // sessionsAPI
  "sessions:list": (query?: string) => Promise<{
    success: boolean;
    sessions?: SessionMetadata[];
    results?: SessionSearchResult[];
    error?: string;
  }>;
  "sessions:listWithOptions": (options?: SessionListOptions) => Promise<{
    success: boolean;
    sessions?: SessionMetadata[];
    results?: SessionSearchResult[];
    hasMore?: boolean;
    nextCursor?: string;
    selectedSession?: SessionMetadata;
    error?: string;
  }>;
  "sessions:create": (
    model?: string,
    soul?: string,
    options?: {
      name?: string;
      source?: SessionSource;
      parentSessionId?: string;
      permissionMode?: SessionPermissionMode;
      workspaceName?: string;
      setActive?: boolean;
      /** Explicit per-session runtime sandbox override (see SessionSandboxConfig).
       *  Rejected for read-only-reviewer sessions when it requests workspace-write. */
      sandbox?: SessionSandboxConfig;
    },
  ) => Promise<{ success: boolean; session?: SessionMetadata; error?: string }>;
  "sessions:createMain": (
    model?: string,
    soul?: string,
    selection?: MainSessionContextSelection,
  ) => Promise<{ success: boolean; session?: SessionMetadata; error?: string }>;
  "sessions:createOrReuseEmpty": (options?: {
    source?: "user" | "workspace";
    workspaceName?: string;
    /** When set, only check this specific session for reuse (workspace double-click guard). */
    activeSessionId?: string;
  }) => Promise<{
    success: boolean;
    session?: SessionMetadata;
    reused: boolean;
    error?: string;
  }>;
  "sessions:compact": (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  /** Background work the runtime still holds for one session, plus whether a turn is running now. */
  "sessions:getBackgroundWork": (sessionId: string) => Promise<{
    success: boolean;
    isBusy: boolean;
    backgroundWork?: import("./background-work").SessionBackgroundWork;
    /** Set when the session is a read-only mirror of a runtime-run subagent. */
    runtimeSubagent?: import("./runtime-subagent").RuntimeSubagentRef;
    error?: string;
  }>;
  /** Stops one runtime-owned background task (shell, monitor, subagent) without ending the session. */
  "sessions:stopBackgroundTask": (
    sessionId: string,
    taskId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "sessions:switch": (sessionId: string) => Promise<{
    success: boolean;
    session?: StoredSession;
    /** Row exists; data is being fetched in the background. Renderer still
     *  navigates; useSessionHydration drives the loading state. */
    hydrating?: boolean;
    error?: string;
  }>;
  "sessions:delete": (
    sessionId: string,
  ) => Promise<{ success: boolean; newActiveId?: string | null; error?: string }>;
  "sessions:delete-all": (options?: {
    preserveWorkflowGroups?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  "sessions:rename": (
    sessionId: string,
    name: string,
    aiGeneratedTitle?: string,
  ) => Promise<{ success: boolean; error?: string }>;

  "sessions:mark-read": (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  "sessions:setPinned": (
    sessionId: string,
    pinned: boolean,
  ) => Promise<{ success: boolean; error?: string }>;
  "sessions:get": (
    sessionId: string,
    options?: { messageLimit?: number },
  ) => Promise<{
    success: boolean;
    session?: StoredSession;
    isBusy?: boolean;
    turnState?: TurnState;
    messagePage?: { hasMore: boolean; total: number };
    error?: string;
  }>;
  "sessions:getMessages": (
    sessionId: string,
    options?: { beforeMessageId?: string; limit?: number },
  ) => Promise<{
    success: boolean;
    messages?: SessionMessage[];
    hasMore?: boolean;
    total?: number;
    error?: string;
  }>;
  "sessions:getToolCallDetails": (
    sessionId: string,
    messageId: string,
    toolCallIndex: number,
  ) => Promise<{
    success: boolean;
    toolCall?: MessageToolCall;
    error?: string;
  }>;
  "sessions:getView": (sessionId: string) => Promise<{
    success: boolean;
    view?: SessionView;
    error?: string;
  }>;
  "sessions:subscribeView": (sessionId: string) => Promise<{
    success: boolean;
    snapshot?: SessionViewSnapshot;
    error?: string;
  }>;
  "sessions:unsubscribeView": (sessionId: string) => Promise<{ success: boolean }>;
  "sessions:ackView": (
    sessionId: string,
    epoch: string,
    sequence: number,
  ) => Promise<{ success: boolean; accepted: boolean }>;
  "sessions:resyncView": (sessionId: string) => Promise<{
    success: boolean;
    snapshot?: SessionViewSnapshot;
    error?: string;
  }>;
  "sessions:setModel": (
    sessionId: string,
    model: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "sessions:patchQuestionSelection": (
    sessionId: string,
    messageId: string,
    selectedAnswer: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "sessions:messageSubagent": (
    sessionId: string,
    message: string,
    options?: {
      deliveryMode?: "wait-if-idle" | "queue" | "interrupt";
      waitForResponse?: boolean;
      timeoutMs?: number;
      replaceQueued?: boolean;
    },
  ) => Promise<AgentMessageApiResult>;
  "sessions:sendReviewComments": (
    sessionId: string,
    message: string,
    options?: {
      deliveryMode?: "wait-if-idle" | "queue";
      waitForResponse?: boolean;
      timeoutMs?: number;
    },
  ) => Promise<AgentMessageApiResult>;

  // commandCenterAPI
  "command-center:getSnapshot": () => Promise<{
    success: boolean;
    snapshot?: CommandCenterSnapshot;
    error?: string;
  }>;
  "command-center:refresh": () => Promise<{
    success: boolean;
    snapshot?: CommandCenterSnapshot;
    error?: string;
  }>;
  "command-center:upsertTodo": (todo: {
    todoId: string;
    title: string;
    status: CommandCenterTodoStatus;
    sessionId?: string;
    goalId?: string;
    goalLabel?: string;
  }) => Promise<{ success: boolean; snapshot?: CommandCenterSnapshot; error?: string }>;
  "command-center:deleteTodo": (
    todoId: string,
  ) => Promise<{ success: boolean; snapshot?: CommandCenterSnapshot; error?: string }>;
  "command-center:openSession": (
    safeSessionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "command-center:getSessionActivity": (sessionId: string) => Promise<{
    success: boolean;
    activity?: CommandCenterSessionActivityDetails;
    sessions?: SessionMetadata[];
    error?: string;
  }>;
  /** Start keeping this session tree's git state current while a view shows it. */
  "command-center:watchWorkspaceState": (sessionId: string) => Promise<{
    success: boolean;
    state?: SessionWorkspaceState | null;
    error?: string;
  }>;
  "command-center:unwatchWorkspaceState": (
    sessionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Refresh now, clearing any timeout backoff. */
  "command-center:refreshWorkspaceState": (
    sessionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "command-center:getWorkspaceFilePatch": (
    request: WorkspaceFilePatchRequest,
  ) => Promise<{ success: boolean; patch?: WorkspaceFilePatch; error?: string }>;
  /** Files changed by one commit listed in the tree's workspace state. */
  "command-center:getWorkspaceCommitFiles": (
    request: WorkspaceCommitFilesRequest,
  ) => Promise<{ success: boolean; commitFiles?: WorkspaceCommitFiles; error?: string }>;
  /** Prompt and number of the turns the Changes tab groups edits by; sessions outside the tree are skipped. */
  "command-center:getTurnPrompts": (
    rootSessionId: string,
    turns: WorkspaceTurnRef[],
  ) => Promise<{ success: boolean; turns?: WorkspaceTurnPrompt[]; error?: string }>;
  /** Worktrees and branch switches of a session tree; read only when a view asks. */
  "command-center:getWorkspaceOverview": (
    sessionId: string,
    options?: { force?: boolean },
  ) => Promise<{ success: boolean; overview?: SessionWorkspaceOverview; error?: string }>;
  /** Disk used by the tree's worktrees; cached for 10 minutes unless forced. */
  "command-center:measureWorktreeSizes": (
    sessionId: string,
    options?: { force?: boolean },
  ) => Promise<{ success: boolean; sizes?: WorktreeDiskUsage[]; error?: string }>;
  "command-center:removeWorktree": (
    request: RemoveWorktreeRequest,
  ) => Promise<{ success: boolean; error?: string }>;

  /** RAM, CPU, processes, zombies and orphans for a session tree; one `ps` per call. */
  "command-center:getSessionHealth": (rootSessionId: string) => Promise<{
    success: boolean;
    health?: SessionHealth;
    proposals?: HealthCleanupProposal[];
    error?: string;
  }>;
  /** SIGTERM a process the current snapshot classifies as an orphan of a session in the tree. */
  "command-center:endOrphanProcess": (
    rootSessionId: string,
    pid: number,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Drop a pending cleanup proposal without performing it. */
  "command-center:dismissHealthProposal": (
    rootSessionId: string,
    proposalId: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // modelsAPI
  "models:list": () => Promise<{
    success: boolean;
    models?: ModelInfo[];
    /** Runtimes without credentials: hidden from the model list, offered as "connect" entries. */
    signedOutRuntimes?: ModelRuntimeInfo[];
    error?: string;
  }>;
  "models:getDefault": () => Promise<{ success: boolean; model?: string; error?: string }>;
  "models:setDefault": (model: string) => Promise<{ success: boolean; error?: string }>;
  "models:getDefaultReasoningEffort": (
    model: string,
  ) => Promise<{ success: boolean; effort?: ReasoningEffort; error?: string }>;
  "models:setDefaultReasoningEffort": (
    model: string,
    effort?: ReasoningEffort,
  ) => Promise<{ success: boolean; error?: string }>;
  "models:getDefaultContextTier": (
    model: string,
  ) => Promise<{ success: boolean; contextTier?: ContextTier; error?: string }>;
  "models:setDefaultContextTier": (
    model: string,
    contextTier?: ContextTier,
  ) => Promise<{ success: boolean; error?: string }>;
  "models:getSessionModel": (
    sessionId: string,
  ) => Promise<{ success: boolean; model?: string; error?: string }>;
  /** Per-session reasoning-effort override (undefined = inherit tier default). */
  "models:getSessionReasoningEffort": (sessionId: string) => Promise<{
    success: boolean;
    effort?: ReasoningEffort;
    /** What the session runs with after tier and app defaults (effort when it is overridden). */
    resolvedEffort?: ReasoningEffort;
    error?: string;
  }>;
  "models:setSessionReasoningEffort": (
    sessionId: string,
    effort?: ReasoningEffort,
  ) => Promise<{ success: boolean; error?: string }>;
  "models:getSessionContextTier": (
    sessionId: string,
  ) => Promise<{ success: boolean; contextTier?: ContextTier; error?: string }>;
  "models:setSessionContextTier": (
    sessionId: string,
    contextTier?: ContextTier,
  ) => Promise<{ success: boolean; error?: string }>;
  /** Default model, reasoning, and context tier for the subagent or workflow tier. */
  "models:getTierDefaults": (tier: ModelTier) => Promise<{
    success: boolean;
    defaults?: {
      model?: string;
      reasoningEffort?: ReasoningEffort;
      contextTier?: ContextTier;
    };
    error?: string;
  }>;
  "models:setTierDefaultModel": (
    tier: ModelTier,
    model?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "models:setTierDefaultReasoningEffort": (
    tier: ModelTier,
    effort?: ReasoningEffort,
  ) => Promise<{ success: boolean; error?: string }>;
  "models:setTierDefaultContextTier": (
    tier: ModelTier,
    contextTier?: ContextTier,
  ) => Promise<{ success: boolean; error?: string }>;

  // soulAPI
  "soul:list": () => Promise<{
    success: boolean;
    souls?: SoulPreset[];
    error?: string;
  }>;
  "soul:getDefault": () => Promise<{
    success: boolean;
    soul?: string;
    error?: string;
  }>;
  "soul:setDefault": (soul: string) => Promise<{ success: boolean; error?: string }>;
  "soul:getGreeting": (
    soulId: string,
  ) => Promise<{ success: boolean; greeting?: string | null; error?: string }>;
  "soul:getSessionSoul": (
    sessionId: string,
  ) => Promise<{ success: boolean; soul?: string; error?: string }>;

  // sessionImportAPI
  "sessionImport:scan": () => Promise<{
    success: boolean;
    sources?: SessionImportSourceSummary[];
    candidates?: SessionImportCandidate[];
    error?: string;
  }>;
  /** Starts a background import, or returns the one already running. Progress: `sessionImport:progress`. */
  "sessionImport:start": (
    refs: SessionImportRef[],
    options: SessionImportRunOptions,
  ) => Promise<{ success: boolean; job?: SessionImportJob; error?: string }>;
  "sessionImport:status": () => Promise<{
    success: boolean;
    job?: SessionImportJob | null;
    error?: string;
  }>;

  // sessionBrainShareAPI: share one session to the team Brain (explicit user action only)
  "sessionBrainShare:status": () => Promise<{
    success: boolean;
    /** True when the installed Brain offers session sharing (cloud on). */
    available?: boolean;
    shares?: Record<string, BrainShareRecord>;
    error?: string;
  }>;
  "sessionBrainShare:share": (
    sessionId: string,
    access: BrainShareAccess,
  ) => Promise<{ success: boolean; record?: BrainShareRecord; error?: string }>;
  "sessionBrainShare:unshare": (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  "sessionBrainShare:retryCleanup": (
    sessionId: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // skillsAPI
  "skills:list": (
    sessionId?: string,
  ) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
  "skills:add": (
    name: string,
    description: string,
    instructions?: string,
    displayName?: string,
  ) => Promise<{
    success: boolean;
    skill?: Skill;
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:update": (
    id: string,
    updates: {
      name?: string;
      displayName?: string;
      description?: string;
      instructions?: string;
      enabled?: boolean;
    },
  ) => Promise<{
    success: boolean;
    skill?: Skill;
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:delete": (id: string) => Promise<{ success: boolean; error?: string }>;
  "skills:export": (skillName: string) => Promise<{ success: boolean; error?: string }>;
  "skills:import-file": () => Promise<{
    success: boolean;
    skill?: Skill;
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:import-path": (filePath: string) => Promise<{
    success: boolean;
    skill?: Skill;
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:import-contents": (files: Array<{ content: string; fileName: string }>) => Promise<{
    success: boolean;
    succeeded: Array<{ name: string; warnings?: SanitizationWarning[] }>;
    errors: Array<{ fileName: string; error: string }>;
  }>;
  "skills:import-url": (url: string) => Promise<{
    success: boolean;
    skill?: Skill;
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:import-bundle": (dirPath?: string) => Promise<{
    success: boolean;
    skill?: Skill;
    bundleDirs?: string[];
    error?: string;
    warnings?: SanitizationWarning[];
  }>;
  "skills:openFile": (skillName: string) => Promise<{ success: boolean; error?: string }>;

  // goalAPI — per-conversation autonomous goal pursuit
  "goal:get": (
    sessionId: string,
  ) => Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot | null; error?: string }>;
  "goal:set": (
    sessionId: string,
    input: { objective: string; criteria?: string[] },
  ) => Promise<{
    success: boolean;
    snapshot?: GoalRuntimeSnapshot;
    error?: string;
  }>;
  "goal:updateDefinition": (
    sessionId: string,
    input: { expectedFence: GoalFence; patch: GoalDefinitionPatch },
  ) => Promise<{
    success: boolean;
    snapshot?: GoalRuntimeSnapshot;
    error?: string;
  }>;
  "goal:updateContext": (
    sessionId: string,
    input: { expectedFence: GoalFence; patch: GoalContextPatch },
  ) => Promise<{
    success: boolean;
    snapshot?: GoalRuntimeSnapshot;
    error?: string;
  }>;
  "goal:pause": (
    sessionId: string,
    expectedFence: GoalFence,
  ) => Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot; error?: string }>;
  "goal:resume": (
    sessionId: string,
    expectedFence: GoalFence,
  ) => Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot; error?: string }>;
  "goal:steer": (
    sessionId: string,
    input: { expectedFence: GoalFence; instruction: string },
  ) => Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot; error?: string }>;
  "goal:stop": (
    sessionId: string,
    expectedFence: GoalFence,
  ) => Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot; error?: string }>;

  // decisionsAPI — decisions, questions and gaps agents record for the user
  "decisions:list": (filter?: import("./decision-log-contract").DecisionListFilter) => Promise<{
    success: boolean;
    entries?: import("./decision-log-contract").DecisionBoardEntry[];
    error?: string;
  }>;
  "decisions:setReviewed": (
    id: string,
    reviewed: boolean,
  ) => Promise<{
    success: boolean;
    entry?: import("./decision-log-contract").DecisionEntry;
    error?: string;
  }>;
  /** Answers an open question, closes it, and queues the answer to the session that asked. */
  "decisions:answer": (
    id: string,
    answer: string,
  ) => Promise<{
    success: boolean;
    entry?: import("./decision-log-contract").DecisionEntry;
    delivered?: boolean;
    error?: string;
  }>;

  // requestsAPI — what the user asked of a session and what became of it
  "requests:get": (sessionId: string) => Promise<{
    success: boolean;
    view?: import("./request-ledger-contract").RequestLedgerView;
    error?: string;
  }>;
  /** The user left the session: what changes after this moment is news when they return. */
  "requests:markSeen": (sessionId: string) => Promise<{ success: boolean; error?: string }>;

  // sdkHostsAPI — linked Marshal SDK hosts and their sessions (common/sdk-hosts-contract.ts)
  "sdkHosts:list": () => Promise<
    import("./sdk-hosts-contract").SdkHostResult<{
      hosts: import("./sdk-hosts-contract").SdkHostSummary[];
    }>
  >;
  /** Links a host after it answered with the token; `message` explains a refused input. */
  "sdkHosts:add": (request: import("./sdk-hosts-contract").SdkHostAddRequest) => Promise<
    | import("./sdk-hosts-contract").SdkHostResult<{
        host: import("./sdk-hosts-contract").SdkHostSummary;
      }>
    | { success: false; error: "invalid-request"; message: string }
  >;
  "sdkHosts:remove": (
    hostId: string,
  ) => Promise<import("./sdk-hosts-contract").SdkHostResult<object>>;
  "sdkHosts:listSessions": () => Promise<
    import("./sdk-hosts-contract").SdkHostResult<import("./sdk-hosts-contract").SdkSessionsListing>
  >;
  "sdkHosts:getSession": (
    key: string,
  ) => Promise<
    import("./sdk-hosts-contract").SdkHostResult<import("./sdk-hosts-contract").SdkSessionDetail>
  >;
  "sdkHosts:send": (request: {
    key: string;
    text: string;
    deliveryMode?: "queue" | "interrupt";
  }) => Promise<import("./sdk-hosts-contract").SdkHostResult<object>>;
  "sdkHosts:cancel": (key: string) => Promise<import("./sdk-hosts-contract").SdkHostResult<object>>;
  "sdkHosts:telemetry": (key: string) => Promise<
    import("./sdk-hosts-contract").SdkHostResult<{
      telemetry: import("./sdk-hosts-contract").SdkSessionTelemetry;
    }>
  >;
  "sdkHosts:listFiles": (request: {
    key: string;
    root?: string;
    path?: string;
  }) => Promise<
    import("./sdk-hosts-contract").SdkHostResult<import("./sdk-hosts-contract").SdkFileListing>
  >;
  "sdkHosts:readFile": (request: { key: string; root: string; path: string }) => Promise<
    import("./sdk-hosts-contract").SdkHostResult<{
      file: import("./sdk-hosts-contract").SdkFileContent;
    }>
  >;
  /** Continues the host's session as a normal local chat (one copy per host session) and shows it. */
  "sdkHosts:continueHere": (
    key: string,
  ) => Promise<
    import("./sdk-hosts-contract").SdkHostResult<{ sessionId: string; reused: boolean }>
  >;

  // transcribeAPI — audio transcription via the OpenAI transcription API.
  // `audioBase64` is base64-encoded WAV (PCM 16kHz mono) recorded in the renderer.
  "transcribe:audio": (
    audioBase64: string,
    mimeType?: string,
  ) => Promise<{
    success: boolean;
    text?: string;
    error?: string;
    errorKind?: TranscribeErrorKind;
  }>;

  // settingsAPI
  "settings:get": () => Promise<{
    success: boolean;
    settings?: MSettings;
    error?: string;
  }>;
  "settings:getRuntimeSelection": () => Promise<{
    success: boolean;
    selection?: RuntimeStartupSelection;
    error?: string;
  }>;
  "settings:switchRuntime": (runtimeId: string) => Promise<{
    success: boolean;
    result?: RuntimeSwitchResult;
    error?: string;
  }>;
  "settings:save": (settings: MSettings) => Promise<{ success: boolean; error?: string }>;
  "settings:getShowHideShortcutStatus": () => Promise<{
    success: boolean;
    status?: {
      enabled: boolean;
      accelerator: string;
      registered: boolean;
      error: string | null;
    };
    error?: string;
  }>;
  "settings:pickWorkspaceDir": (defaultPath?: string) => Promise<{
    success: boolean;
    folderPath?: string;
    error?: string;
  }>;
  "settings:pickWorktreeDir": (defaultPath?: string) => Promise<{
    success: boolean;
    folderPath?: string;
    error?: string;
  }>;
  "settings:openFile": () => Promise<{ success: boolean; error?: string }>;

  // relayProviderSettingsAPI
  "relay-provider-settings:list": () => Promise<{
    success: boolean;
    providers?: RelayProviderRuntimeSnapshot[];
    error?: string;
  }>;
  "relay-provider-settings:connect": (request: RelayProviderActionRequest) => Promise<{
    success: boolean;
    setup?: RelayProviderSetupEvent;
    error?: string;
  }>;
  "relay-provider-settings:disconnect": (request: RelayProviderActionRequest) => Promise<{
    success: boolean;
    setup?: RelayProviderSetupEvent;
    error?: string;
  }>;
  "relay-provider-settings:reset": (request: RelayProviderActionRequest) => Promise<{
    success: boolean;
    setup?: RelayProviderSetupEvent;
    error?: string;
  }>;
  "relay-provider-settings:relink": (request: RelayProviderActionRequest) => Promise<{
    success: boolean;
    setup?: RelayProviderSetupEvent;
    error?: string;
  }>;
  "relay-provider-settings:provision": (request: RelayProviderActionRequest) => Promise<{
    success: boolean;
    setup?: RelayProviderSetupEvent;
    error?: string;
  }>;

  // telemetryAPI
  "telemetry:write-local-event": (
    event: LocalTelemetryEventPayload,
  ) => Promise<{ success: boolean; error?: string }>;
  "telemetry:delete-local-data": () => Promise<LocalTelemetryDeleteResult>;
  "telemetry:renderer-finalized": () => Promise<{ success: boolean }>;

  // diagnosticsAPI
  "diagnostics:rendererHeartbeat": (
    heartbeat: RendererResponsivenessHeartbeat,
  ) => Promise<RendererResponsivenessAck>;
  "diagnostics:log": (entry: {
    level: "error" | "warn" | "info";
    category: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ success: boolean }>;
  "diagnostics:getLogPath": () => Promise<{ success: boolean; path?: string }>;
  "diagnostics:revealLogFolder": () => Promise<{ success: boolean }>;
  "diagnostics:sanitize": (text: string) => Promise<{ success: boolean; sanitized: string }>;
  "diagnostics:getResourceSnapshot": () => Promise<{
    success: boolean;
    snapshot?: ResourceSnapshot;
    error?: string;
  }>;

  // heartbeatAPI
  "heartbeat:status": () => Promise<{
    success: boolean;
    status?: HeartbeatStatusEnvelope;
    error?: string;
  }>;
  "heartbeat:toggle": (enable: boolean) => Promise<{ success: boolean; error?: string }>;
  "heartbeat:getSettings": () => Promise<{
    success: boolean;
    settings?: HeartbeatSettingsEnvelope;
    error?: string;
  }>;
  "heartbeat:saveSettings": (
    updates: Partial<HeartbeatSettings>,
  ) => Promise<{ success: boolean; error?: string }>;
  "heartbeat:getLogs": (
    lines?: number,
  ) => Promise<{ success: boolean; logs?: HeartbeatLogEntry[]; error?: string }>;
  "heartbeat:runNow": () => Promise<{ success: boolean; error?: string }>;

  // automationsAPI
  "automations:listRoutines": (workspaceName?: string) => Promise<LocalRoutinesResult>;
  "automations:runRoutine": (request: LocalRoutineRunRequest) => Promise<LocalRoutineRunResult>;
  "automations:setRoutineEnabled": (
    request: LocalRoutineEnabledRequest,
  ) => Promise<{ success: boolean; error?: string }>;
  "automations:getRoutineDetails": (
    request: LocalRoutineDetailsRequest,
  ) => Promise<LocalRoutineDetails>;
  "automations:updateRoutine": (
    request: LocalRoutineUpdateRequest,
  ) => Promise<{ success: boolean; error?: string }>;
  "automations:list": () => Promise<{
    success: boolean;
    automations?: AutomationData[];
    error?: string;
  }>;
  "automations:create": (
    data: AutomationCreateInput,
  ) => Promise<{ success: boolean; automation?: AutomationData; error?: string }>;
  "automations:update": (
    id: string,
    updates: Partial<AutomationData>,
  ) => Promise<{ success: boolean; automation?: AutomationData; error?: string }>;
  "automations:delete": (
    id: string,
    opts?: { deleteSkills?: boolean },
  ) => Promise<{ success: boolean; error?: string }>;
  "automations:toggle": (
    id: string,
    enabled: boolean,
  ) => Promise<{ success: boolean; error?: string }>;
  "automations:runNow": (
    id: string,
  ) => Promise<{ success: boolean; run?: AutomationRunData; error?: string }>;
  "automations:getHistory": (
    id: string,
  ) => Promise<{ success: boolean; runs?: AutomationRunData[]; error?: string }>;
  "automations:getAllHistory": () => Promise<{
    success: boolean;
    runs?: AutomationRunData[];
    error?: string;
  }>;
  "automations:getCurrentRun": () => Promise<{ success: boolean; run?: AutomationRunData | null }>;
  "automations:getConditionStatus": (id: string) => Promise<{
    success: boolean;
    lastCheck?: string;
    nextCheck?: string;
    lastError?: string;
    error?: string;
  }>;
  "automations:export": (
    id: string,
  ) => Promise<{ success: boolean; json?: string; error?: string }>;
  "automations:import": (
    json: string,
  ) => Promise<{ success: boolean; automations?: AutomationData[]; error?: string }>;
  "automations:importBundle": () => Promise<{
    success: boolean;
    skillsInstalled?: Skill[];
    automations?: AutomationData[];
    error?: string;
  }>;
  "automations:importFromGithub": (
    url: string,
    token?: string,
  ) => Promise<{
    success: boolean;
    needsToken?: boolean;
    skillsInstalled?: Skill[];
    automations?: AutomationData[];
    repoInfo?: { owner: string; repo: string; path: string };
    error?: string;
  }>;

  // updateAPI
  "update:auth": () => Promise<{ success: boolean; authenticated?: boolean; error?: string }>;
  "update:clear-token": () => Promise<{ success: boolean }>;
  "update:check": () => Promise<{
    success: boolean;
    upToDate?: boolean;
    currentVersion?: string;
    latestVersion?: string;
    /** Installer download URL — provider-agnostic. */
    downloadUrl?: string;
    assetName?: string;
    releaseUrl?: string;
    channel?: "stable" | "beta";
    /** Integrity hash when the catalog supplies one (endpoint path). */
    sha256?: string;
    error?: string;
    ssoUrl?: string;
  }>;
  "update:download": (
    url: string,
    assetName: string,
  ) => Promise<{ success: boolean; filePath?: string; error?: string; ssoUrl?: string }>;
  "update:install": (filePath: string) => Promise<{ success: boolean; error?: string }>;
  "update:restart": (installerPath?: string) => Promise<{ success: boolean; error?: string }>;
  "update:check-minimum": () => Promise<{
    success: boolean;
    blocked?: boolean;
    minimumVersion?: string;
    currentVersion?: string;
    error?: string;
  }>;
  // backgroundAPI
  "background:getSettings": () => Promise<{
    success: boolean;
    settings?: BackgroundServiceSettings;
    error?: string;
  }>;
  "background:saveSettings": (
    updates: Partial<BackgroundServiceSettings>,
  ) => Promise<{ success: boolean; settings?: BackgroundServiceSettings; error?: string }>;

  // windowControlsAPI
  "window-controls:getState": () => Promise<{
    success: boolean;
    isMaximized?: boolean;
    isFullScreen?: boolean;
    error?: string;
  }>;
  "window-controls:minimize": () => Promise<{ success: boolean; error?: string }>;
  "window-controls:toggleMaximize": () => Promise<{
    success: boolean;
    isMaximized?: boolean;
    error?: string;
  }>;
  "window-controls:close": () => Promise<{ success: boolean; error?: string }>;
  "window-controls:setWidth": (width: number) => Promise<{ success: boolean; error?: string }>;

  // chatWindowsAPI — "Open in New Window" for chats.
  // Pops a chat session out into its own independent BrowserWindow so multiple
  // chats can be visible simultaneously. Each window subscribes to the detailed
  // session view it displays; other session updates stay summary-only.
  "chat-windows:open": (
    sessionId: string,
    /** Optional drop-location in screen coordinates (HTMLDragEvent.screenX/Y).
     *  When present, the new window opens near these coords (clamped to the
     *  containing display's workArea). When absent, OS-default placement is
     *  used — appropriate for non-spatial triggers like the overflow menu. */
    bounds?: { x: number; y: number },
  ) => Promise<{ success: boolean; alreadyOpen?: boolean; error?: string }>;

  // mcpsAPI
  "mcps:initiateOAuth": (
    serverName: string,
    loginHint?: string,
    /**
     * - `contextSessionId`: originating session id from a chat-time
     *   `mcp:oauth-required` event so the handler picks the same session
     *   as the executor. Omitted for user-initiated sign-in (auth state
     *   is server-scoped — any live session works).
     * - `forceReauth`: overrides the handler's default `!!loginHint`
     *   heuristic. Pass `true` for explicit re-sign-in actions so the
     *   SDK's cached token is dropped instead of silently reused.
     */
    options?: { contextSessionId?: string; forceReauth?: boolean },
  ) => Promise<{ status: "success"; oauthAlias?: string } | { status: "error"; message: string }>;
  "mcps:list": () => Promise<{ success: boolean; servers?: McpServerInfo[]; error?: string }>;
  /**
   * User-initiated MCP OAuth sign-out. Drops the SDK's cached OAuth token
   * for this server, clears the persisted `oauthAlias`, and refreshes the
   * session so the server lands in `needs-auth` (no auto-reconnect with
   * cached creds). Unlike `mcps:initiateOAuth`, this does NOT open a
   * browser — the SDK starts a pending OAuth flow internally that we
   * discard. The pending flow times out silently after ~5 min in the SDK
   * and has no user-visible impact.
   */
  "mcps:signOut": (
    serverName: string,
  ) => Promise<{ status: "success" } | { status: "error"; message: string }>;
  "mcps:add": (
    input: AddMcpServerInput,
  ) => Promise<{ success: boolean; name?: string; needsOAuth?: boolean; error?: string }>;
  "mcps:install-catalog": (
    input: InstallCatalogMcpInput,
  ) => Promise<{ success: boolean; error?: string }>;
  "mcps:remove": (name: string) => Promise<{ success: boolean; error?: string }>;
  "mcps:update-config": (
    input: SaveMcpConfigInput,
  ) => Promise<{ success: boolean; error?: string }>;
  "mcps:openFile": () => Promise<{ success: boolean; error?: string }>;
  "mcps:rediscover": () => Promise<{ success: boolean; error?: string }>;
  "mcps:setExposeAsGatewayNodeCommand": (
    name: string,
    expose: boolean,
  ) => Promise<{ success: boolean; error?: string }>;
  /**
   * Open the per-server secrets file at `${appDataDir}/marshal-mcp-env/<key>.env`
   * in the user's editor of choice (`default` for the OS default, `vscode` for
   * a `vscode://file/...` deep link) or reveal it in Finder/Explorer
   * (`reveal`). `serverKey` is re-validated against `/^[a-z0-9_-]+$/` in main
   * (no path traversal). For the `default` target, an empty file is
   * materialized when missing so the editor has something to open — Marshal
   * never reads or writes the secrets body itself; the user types secrets in
   * their own editor process.
   */
  "mcps:openEnvFile": (
    serverKey: string,
    target?: "default" | "reveal",
  ) => Promise<{ success: boolean; revealed?: boolean; error?: string }>;

  // tenantAPI
  "tenant:getStatus": () => Promise<TenantPolicyStatus>;

  // orgAPI
  "org:getStatus": () => Promise<OrgStatus>;
  "org:setOrgUrl": (orgUrl: string) => Promise<OrgStatus>;
  "org:signIn": () => Promise<OrgStatus>;
  "org:signOut": () => Promise<OrgStatus>;
  "org:whoami": () => Promise<OrgStatus>;
  "org:getWorkspaceMappings": () => Promise<
    | { success: true; mappings: Record<string, OrgWorkspaceMapping> }
    | { success: false; error: string }
  >;
  "org:listWorkspaceRoutines": (orgWorkspaceId: string) => Promise<OrgWorkspaceRoutinesResult>;
  "org:listRoutineRuns": (request: OrgRoutineRunsRequest) => Promise<OrgRoutineRunsResult>;
  "org:openRoutineLink": (url: string) => Promise<{ success: boolean }>;
  "org:listRoutineEvents": (request: OrgRoutineEventsRequest) => Promise<OrgRoutineEventsResult>;
  "org:dispatchRoutine": (request: OrgRoutineDispatchRequest) => Promise<OrgRoutineDispatchResult>;
  "org:setRoutineEnabled": (request: OrgRoutineEnabledRequest) => Promise<OrgRoutineEnabledResult>;
  "org:testRoutineEventLocally": (
    request: OrgRoutineTestLocallyRequest,
  ) => Promise<OrgRoutineTestLocallyResult>;
  "org:testRoutineInCloud": (
    request: OrgRoutineCloudTestRequest,
  ) => Promise<OrgRoutineCloudTestResult>;
  "org:promoteRoutine": (request: OrgRoutinePromoteRequest) => Promise<OrgRoutinePromoteResult>;
  "org:listPromoteTargets": () => Promise<OrgPromoteTargetsResult>;
  "org:findCloudTestRun": (query: OrgCloudTestRunsQuery) => Promise<OrgCloudTestRunResult>;
  "org:getSessionWorkspaceMapping": (
    sessionId: string,
  ) => Promise<OrgSessionWorkspaceMappingResult>;
  /** The organization workspaces an unmapped session can be shared into (never one with a data boundary). */
  "org:listShareWorkspaces": () => Promise<OrgShareWorkspacesResult>;
  /** Records the organization workspace for a session whose own workspace maps to none. */
  "org:setSessionWorkspace": (
    request: OrgSetSessionWorkspaceRequest,
  ) => Promise<OrgSessionWorkspaceMappingResult>;
  "org:previewSessionShare": (sessionId: string) => Promise<OrgSessionSharePreviewResult>;
  "org:shareSession": (sessionId: string) => Promise<OrgSessionShareResult>;
  "org:getCloudMoveStatus": (sessionId: string) => Promise<OrgCloudMoveStatusResult>;
  "org:takePendingSessionLink": () => Promise<{
    success: true;
    sessionId: string | null;
    /** This computer has the session in its own store. */
    local: boolean;
  }>;
  "org:listCloudHeldSessions": () => Promise<{ success: true; sessionIds: string[] }>;
  "org:listCloudSessions": () => Promise<OrgCloudSessionsResult>;
  "org:openCloudRunLink": (url: string) => Promise<{ success: boolean }>;
  "org:dismissStrandedCloudSession": (sessionId: string) => Promise<{ success: boolean }>;
  "org:listSlackDestinations": (
    request: OrgSlackDestinationsRequest,
  ) => Promise<OrgSlackDestinationsResult>;
  "org:placementPreview": (
    request: OrgPlacementPreviewRequest,
  ) => Promise<OrgPlacementPreviewResult>;
  "org:cancelPlacementStaging": (sessionId: string) => Promise<{ success: true }>;
  "org:moveToCloud": (request: OrgMoveToCloudRequest) => Promise<OrgMoveToCloudResult>;
  "org:continueHere": (request: OrgContinueHereRequest) => Promise<OrgContinueHereResult>;
  "org:continueCloudSession": (request: OrgContinueCloudRequest) => Promise<OrgContinueCloudResult>;
  "org:forkSession": (request: OrgForkSessionRequest) => Promise<OrgForkSessionResult>;
  "org:onboardingGetManifest": () => Promise<OrgOnboardingManifestResult>;
  "org:onboardingStatus": (scope: OrgOnboardingScope) => Promise<OrgOnboardingStatusResult>;
  "org:onboardingInstall": (request: {
    scope: OrgOnboardingScope;
    ids: string[];
  }) => Promise<OrgOnboardingInstallResult>;
  "org:onboardingConnect": (request: {
    scope: OrgOnboardingScope;
    extensionId: string;
    index: number;
  }) => Promise<OrgOnboardingConnectResult>;
  "org:onboardingRunVault": (request: {
    scope: OrgOnboardingScope;
    capability: string;
    input?: unknown;
  }) => Promise<OrgOnboardingRunResult>;
  "org:catalogGet": (scope?: OrgOnboardingScope) => Promise<OrgCatalogResult>;
  "org:catalogUpdate": (request: OrgCatalogUpdateRequest) => Promise<OrgCatalogActionResult>;
  "org:catalogReview": (request: OrgCatalogReviewRequest) => Promise<OrgCatalogActionResult>;
  "org:catalogInstall": (request: {
    scope: OrgOnboardingScope;
    id: string;
    version: string;
  }) => Promise<OrgOnboardingInstallResult>;
  "org:catalogPublishable": (scope: OrgOnboardingScope) => Promise<OrgPublishableResult>;
  "org:catalogPublish": (request: OrgCatalogPublishRequest) => Promise<OrgCatalogActionResult>;
  "org:catalogPublishPreview": (
    request: OrgCatalogPublishPreviewRequest,
  ) => Promise<OrgCatalogPublishPreviewResult>;
  /** Organization skills: the catalog plus which of them are installed here. */
  "org:skillsGet": () => Promise<OrgSkillsResult>;
  /** Installs (or updates to) the approved version of an organization skill. */
  "org:skillsInstall": (request: { name: string }) => Promise<OrgSkillActionResult>;
  /** Removes an installed organization skill from this computer. */
  "org:skillsRemove": (request: { name: string }) => Promise<OrgSkillActionResult>;
  "org:skillsPublishable": () => Promise<OrgSkillPublishableResult>;
  "org:skillsPublishPreview": (request: { name: string }) => Promise<OrgSkillPublishPreviewResult>;
  "org:skillsPublish": (request: OrgSkillPublishRequest) => Promise<OrgSkillActionResult>;
  /** Admin: approve or reject a pending skill version. */
  "org:skillsReview": (request: OrgSkillReviewRequest) => Promise<OrgSkillActionResult>;
  /** Admin: tier, pin, or remove a skill from the organization. */
  "org:skillsUpdate": (request: OrgSkillUpdateRequest) => Promise<OrgSkillActionResult>;
  /** Every file of a skill version, for review. */
  "org:skillsReviewFiles": (request: {
    name: string;
    version: string;
  }) => Promise<OrgSkillReviewFilesResult>;
  /** Contract C7: which developer tools are installed; any tool, no org needed. */
  "org:devToolsDetect": () => Promise<DevToolsDetectResult>;
  /** What installing a tool the org named would do, to show before the user confirms. */
  "org:devToolsPlan": (request: { id: DevToolId }) => Promise<DevToolsPlanResult>;
  /** Runs Marshal's fixed installer for a tool the org named; call only after the user confirmed the plan. */
  "org:devToolsInstall": (request: {
    id: DevToolId;
    token: string;
  }) => Promise<DevToolsInstallResult>;
  "org:releaseCloudMoveLock": (
    sessionId: string,
  ) => Promise<{ success: true; returnedMessages?: OrgReturnedMessage[] }>;
  "org:sendRemoteMessage": (
    request: OrgSendRemoteMessageRequest,
  ) => Promise<OrgSendRemoteMessageResult>;
  "org:getRemoteInbox": (sessionId: string) => Promise<OrgRemoteInboxResult>;
  "org:getHeldTranscript": (sessionId: string) => Promise<OrgHeldTranscriptResult>;
  "org:watchSession": (sessionId: string) => Promise<OrgSessionWatchResult>;
  "org:unwatchSession": (sessionId: string) => Promise<void>;
  "org:postComment": (request: {
    sessionId: string;
    text: string;
  }) => Promise<OrgPostCommentResult>;
  "org:cancelRemoteMessage": (ref: OrgRemoteMessageRef) => Promise<OrgRemoteMessageActionResult>;
  "org:runHeldRemoteMessage": (ref: OrgRemoteMessageRef) => Promise<OrgRemoteMessageActionResult>;
  "org:searchDirectory": (query: string) => Promise<OrgDirectorySearchResult>;
  "org:mentionSession": (request: OrgMentionRequest) => Promise<OrgMentionResult>;
  "org:noteMentions": (request: {
    sessionId: string;
    mentions: OrgMentionNote[];
  }) => Promise<{ success: true }>;
  "org:joinSharedSession": (
    request: OrgJoinSharedSessionRequest,
  ) => Promise<OrgJoinSharedSessionResult>;
  "org:getSharedLink": (request: { sessionId: string }) => Promise<OrgGetSharedLinkResult>;
  "org:getSharedLive": (request: { sessionId: string }) => Promise<OrgGetSharedLiveResult>;
  "org:setSharedComposing": (request: {
    sessionId: string;
    composing: boolean;
  }) => Promise<{ success: true }>;
  "org:listSharedLinks": () => Promise<OrgListSharedLinksResult>;
  "org:projectsStatus": () => Promise<OrgProjectsGhStatus | OrgProjectsFailure>;
  "org:projectsLogin": () => Promise<OrgProjectsGhStatus | OrgProjectsFailure>;
  "org:projectsSetupGit": () => Promise<{ success: true } | OrgProjectsFailure>;
  "org:projectsCancelLogin": () => Promise<{ success: true }>;
  "org:projectsList": (request: { owner: string; root: string }) => Promise<OrgProjectsListResult>;
  "org:projectsPickFolder": (defaultPath?: string) => Promise<{ success: true; path?: string }>;
  "org:projectsClone": (request: OrgProjectsCloneRequest) => Promise<OrgProjectsCloneResult>;
  "org:projectsCancelClone": () => Promise<{ success: true }>;

  "org:listRemoteSessions": () => Promise<OrgRemoteResult<{ sessions: OrgRemoteSessionSummary[] }>>;
  "org:getRemoteSession": (sessionId: string) => Promise<OrgRemoteResult<OrgRemoteSessionDetail>>;
  /** Opens a `run:<id>[:<session>]` run as a local session, reusing the one an earlier open made. */
  "org:openRunChat": (viewId: string, options?: OrgRunChatOpenOptions) => Promise<OrgRunChatResult>;
  "org:listRemoteNotifications": () => Promise<
    OrgRemoteResult<{ notifications: OrgRemoteNotificationSummary[]; unreadCount: number }>
  >;
  "org:markRemoteSessionRead": (sessionId: string) => Promise<OrgRemoteResult<object>>;

  // contextPickerAPI
  "contextPicker:search": (
    query: string,
    entityTypes?: ContextEntityType[],
  ) => Promise<{
    success: boolean;
    entities?: ContextEntity[];
    error?: string;
  }>;

  // gatewayAuthAPI
  "gatewayAuth:getState": () => Promise<{ success: true; state: GatewayAuthState }>;
  "gatewayAuth:signIn": (
    cred: GatewayAuthIdentity,
  ) => Promise<{ success: boolean; error?: string }>;
  "gatewayAuth:signOut": () => Promise<{ success: boolean; error?: string }>;
  /** Abort an in-flight pairing wait (status === "pairing") and return to
   *  the picker. No-op when no pairing loop is running. */
  "gatewayAuth:cancelPairing": () => Promise<{ success: boolean; error?: string }>;
  /** List pending device-pair requests for the current marshal runtime.
   *  Local-dev only — rejects with `error: "not-supported-non-local"` when
   *  the gateway URL is not localhost / 127.0.0.1 / [::1]. The renderer's
   *  `LocalDeviceApprovalPanel` polls this on focus to surface scope-upgrade
   *  approvals that production would normally route through ops channels. */
  "gatewayAuth:listPendingDevices": () => Promise<{
    success: boolean;
    pending?: PendingDeviceRequest[];
    paired?: PairedDevice[];
    error?: string;
  }>;
  /** Approve a pending device-pair request by its requestId. Local-dev only,
   *  same gating as `listPendingDevices`. Reject/remove is intentionally NOT
   *  exposed — the local panel is approve-only; cleanup happens server-side
   *  via the request TTL or the marshal CLI. */
  "gatewayAuth:approveDevice": (requestId: string) => Promise<{ success: boolean; error?: string }>;

  "gatewayNode:getActivity": () => Promise<{
    success: true;
    entries: NodeActivityEntry[];
  }>;

  // identityAPI — backend-agnostic user identity. Composed in main from the
  // active backend (Copilot auth / Gateway auth) + shared relay state.
  "identity:get": () => Promise<{ success: true; identity: UserIdentity }>;

  // workspaceAPI
  "workspace:getRoot": (
    workspaceName?: string,
  ) => Promise<{ success: boolean; root?: string; error?: string }>;
  "workspace:listDir": (
    dirPath: string,
  ) => Promise<{ success: boolean; entries?: WorkspaceDirEntry[]; error?: string }>;
  "workspace:searchFiles": (
    workspaceName: string | undefined,
    query: string,
  ) => Promise<{ success: boolean; files?: ContextFileEntity[]; error?: string }>;
  "workspace:readFile": (
    filePath: string,
    readCapability?: string,
  ) => Promise<{
    success: boolean;
    type?: "markdown" | "text" | "image" | "html";
    content?: string;
    error?: string;
  }>;
  "workspace:writeFile": (
    filePath: string,
    content: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:revealInFileManager": (
    targetPath: string,
    readCapability?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:openFile": (
    targetPath: string,
    readCapability?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:listWorkspaces": () => Promise<{
    success: boolean;
    workspaces?: string[];
    workspaceBindings?: MainSessionWorkspaceBinding[];
    externalWorkspaces?: string[];
    error?: string;
  }>;
  "workspace:listRepositoryAgents": (workspaceName: string) => Promise<{
    success: boolean;
    agents?: SessionRepositoryAgent[];
    error?: string;
  }>;
  "workspace:createWorkspace": (
    name: string,
    externalPickToken?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:renameWorkspace": (
    oldName: string,
    newName: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:deleteWorkspace": (name: string) => Promise<{ success: boolean; error?: string }>;
  "workspace:getWorkspaceContents": (
    name: string,
  ) => Promise<{ success: boolean; fileCount?: number; folderCount?: number; error?: string }>;
  "workspace:createFolder": (
    parentPath: string,
    name: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:renameItem": (
    itemPath: string,
    newName: string,
  ) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  "workspace:deleteItem": (itemPath: string) => Promise<{ success: boolean; error?: string }>;
  "workspace:moveItem": (
    sourcePath: string,
    destDir: string,
  ) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  "workspace:duplicateItem": (
    sourcePath: string,
    destPath: string,
  ) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  "workspace:registerExternalFileImportBridge": (
    bridgeToken: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:authorizeExternalFiles": (
    bridgeToken: string,
    externalPaths: string[],
  ) => Promise<{ success: boolean; importToken?: string; error?: string }>;
  "workspace:copyExternalFiles": (
    importToken: string,
    destDir: string,
  ) => Promise<{ success: boolean; copied?: number; error?: string }>;
  "workspace:pickFolder": () => Promise<{
    success: boolean;
    folderPath?: string;
    folderToken?: string;
    error?: string;
  }>;
  "workspace:getUIState": () => Promise<{
    success: boolean;
    state?: WorkspaceUIState;
    error?: string;
  }>;
  "workspace:setActiveWorkspace": (name: string) => Promise<{ success: boolean; error?: string }>;
  "workspace:setExpandedPaths": (
    workspaceName: string,
    relativePaths: string[],
  ) => Promise<{ success: boolean; error?: string }>;
  "workspace:setSelectedFile": (
    workspaceName: string,
    relativePath: string | undefined,
  ) => Promise<{ success: boolean; error?: string }>;

  // mini-mode
  "mini-mode:getState": () => Promise<{
    success: boolean;
    status?: string;
    permission?: {
      id: string;
      toolCallId?: string;
      kind: PermissionKind;
      title: string;
      message: string;
      detail: string;
      buttons: string[];
    } | null;
    pendingPermissionCount?: number;
    permissionIndex?: number;
    notification?: {
      id: string;
      type: "heartbeat-urgent" | "heartbeat-error" | "automation-complete" | "automation-failed";
      title: string;
      body: string;
      sessionId?: string;
      url?: string;
      statusOverride?: string;
    } | null;
  }>;
  "mini-mode:getAsset": (status: string) => Promise<{ success: boolean; asset?: string }>;
  "mini-mode:showMainWindow": (sessionId?: string) => Promise<{ success: boolean }>;
  "mini-mode:dismissApproval": (requestId: string) => Promise<{ success: boolean; error?: string }>;
  "mini-mode:dismissNotification": () => Promise<{ success: boolean }>;
  "mini-mode:openUrl": (url: string) => Promise<{ success: boolean }>;

  // activitiesAPI
  "activities:getAll": (logLines?: number) => Promise<ActivitiesAggregatedResult>;

  // devAPI
  "dev:getMockMode": () => Promise<{ success: boolean; enabled: boolean }>;
  "dev:setMockMode": (enabled: boolean) => Promise<{ success: boolean }>;
  "dev:testMiniModeNotification": (
    type: string,
    delayMs: number,
  ) => Promise<{ success: boolean; error?: string }>;

  // encryptionAPI
  "encryption:wasKeyReset": () => Promise<boolean>;

  // shellAPI
  "shell:openExternal": (url: string) => Promise<{ success: boolean; error?: string }>;
  "shell:quitApp": () => Promise<{ success: boolean; error?: string }>;

  // preferencesAPI
  "preferences:get": (
    key: string,
  ) => Promise<{ success: boolean; value: string | null; error?: string }>;
  "preferences:set": (
    key: string,
    value: string | null,
  ) => Promise<{ success: boolean; error?: string }>;

  // fileExportAPI
  "file:saveJson": (
    content: string,
    defaultFilename: string,
  ) => Promise<{ success: boolean; canceled?: boolean; error?: string }>;

  // backendAPI
  "backend:capabilities": () => Promise<BackendCapabilities>;

  // aiInvestigatorAPI
  "aiInvestigator:checkAvailability": () => Promise<{
    success: boolean;
    available: boolean;
    /** Human-readable reason when `available` is false (e.g., "gh CLI not installed"). */
    reason?: string;
  }>;
  "aiInvestigator:start": (input: {
    userDescription: string;
  }) => Promise<{ success: boolean; error?: string }>;
  "aiInvestigator:getStatus": () => Promise<{
    success: boolean;
    status: AIInvestigatorStatus;
  }>;
  "aiInvestigator:cancel": () => Promise<{ success: boolean; error?: string }>;
  "aiInvestigator:reset": () => Promise<{ success: boolean; error?: string }>;
  "aiInvestigator:post": () => Promise<{
    success: boolean;
    url?: string;
    fallbackUrl?: string;
    error?: string;
  }>;

  // ── workflowsAPI (Dynamic Workflows V1) ──────────────────────────────────
  // Handlers added by IMPL-ENGINE. Renderer code handles `undefined`
  // responses gracefully so the panel renders even before they exist.
  "workflows:list": (
    repoPath?: string | null,
    workspaceName?: string,
  ) => Promise<{
    success: boolean;
    workflows?: WorkflowSummary[];
    error?: string;
  }>;
  "workflows:listRuns": (
    workflowId?: string,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    runs?: RunHistoryEntry[];
    error?: string;
  }>;
  "workflows:getRunForHostSession": (hostSessionId: string) => Promise<{
    success: boolean;
    runId?: string;
    error?: string;
  }>;
  "workflows:getRun": (runId: string) => Promise<{
    success: boolean;
    snapshot?: RunSnapshot;
    error?: string;
  }>;
  "workflows:getEvents": (
    runId: string,
    fromSeq?: number,
  ) => Promise<{ success: boolean; events?: WorkflowEvent[]; error?: string }>;
  "workflows:run": (
    workflowId: string,
    input?: unknown,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    runId?: string;
    runFamilyId?: string;
    error?: string;
  }>;
  "workflows:cancel": (
    runId: string,
    reason?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  "workflows:retryFromStep": (
    runId: string,
    stepId: string,
  ) => Promise<{
    success: boolean;
    newRunId?: string;
    runFamilyId?: string;
    error?: string;
  }>;
  "workflows:installLocal": (
    sourceDir: string,
    overwrite?: boolean,
  ) => Promise<{
    success: boolean;
    workflowId?: string;
    warnings?: string[];
    error?: string;
  }>;
  "workflows:pickInstallDir": () => Promise<{
    success: boolean;
    sourceDir?: string;
    cancelled?: boolean;
    error?: string;
  }>;
  "workflows:updateSchedule": (
    workflowId: string,
    schedule: string,
    input?: unknown,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    schedule?: WorkflowScheduleSummary;
    error?: string;
  }>;
  "workflows:disableSchedule": (
    workflowId: string,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    schedule?: WorkflowScheduleSummary | null;
    error?: string;
  }>;
  "workflows:getRenderer": (
    workflowId: string,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    renderer?: WorkflowRendererBundle | null;
    error?: string;
  }>;
  "workflows:getCommandCenter": (
    workflowId: string,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    /** Compiled workflow-level command-center bundle, or null when none ships. */
    commandCenter?: WorkflowRendererBundle | null;
    error?: string;
  }>;
  "workflows:readArtifact": (
    runId: string,
    storageKey: string,
  ) => Promise<{
    success: boolean;
    mime?: string;
    encoding?: "utf8" | "base64";
    content?: string;
    error?: string;
  }>;
  "workflows:listArtifacts": (
    workflowId: string,
    repoPath?: string | null,
    prefix?: string,
    limit?: number,
  ) => Promise<{
    success: boolean;
    artifacts?: WorkflowArtifactSummary[];
    error?: string;
  }>;
  "workflows:listState": (
    workflowId: string,
    repoPath?: string | null,
    prefix?: string,
  ) => Promise<{
    success: boolean;
    entries?: WorkflowStateEntrySummary[];
    error?: string;
  }>;
  "workflows:readState": (
    workflowId: string,
    key: string,
    repoPath?: string | null,
  ) => Promise<{
    success: boolean;
    entry?: WorkflowStateValueSnapshot | null;
    error?: string;
  }>;
  "workflows:compactState": (
    workflowId: string,
    repoPath?: string | null,
    prefix?: string,
    olderThanMs?: number,
    limit?: number,
  ) => Promise<{
    success: boolean;
    result?: WorkflowStateCompactionResult;
    error?: string;
  }>;
  "workflows:clearState": (request: WorkflowStateClearRequest) => Promise<{
    success: boolean;
    result?: WorkflowStateClearResult;
    error?: string;
  }>;
  "workflows:readArtifactByKey": (
    runId: string,
    key: string,
  ) => Promise<
    ({ success: true } & WorkflowArtifactReadResult) | { success: false; error?: string }
  >;
  "workflows:getStateValue": (
    workflowId: string,
    key: string,
  ) => Promise<
    { success: true; state: WorkflowStateReadResult } | { success: false; error?: string }
  >;
  "workflows:listStateKeys": (
    workflowId: string,
    prefix?: string,
  ) => Promise<{ success: boolean; keys?: string[]; error?: string }>;
  "workflows:putConfigValue": (
    workflowId: string,
    /** Config key WITHOUT the reserved `config/` prefix (host adds + enforces it). */
    key: string,
    value: unknown,
    repoPath?: string | null,
  ) => Promise<{ success: boolean; error?: string }>;
  "workflows:dispatchAction": (
    request: WorkflowActionDispatchRequest,
  ) => Promise<{ success: boolean; result?: WorkflowActionDispatchResult; error?: string }>;
  "workflows:getActionItem": (
    workflowId: string,
    itemId: string,
    repoPath?: string | null,
    workspaceName?: string,
  ) => Promise<{ success: boolean; item?: WorkflowActionCenterItem | null; error?: string }>;
  "workflows:approveNotification": (
    request: WorkflowNotificationApprovalRequest,
  ) => Promise<{ success: boolean; result?: WorkflowActionDispatchResult; error?: string }>;
  "workflows:permissionResponse": (
    response: WorkflowPermissionResponse,
  ) => Promise<{ success: boolean; error?: string }>;
}

export type SessionHydrationEvent =
  | { sessionId: string; state: "started" }
  | { sessionId: string; state: "loaded" }
  | { sessionId: string; state: "failed"; error?: string };

// ── IPC Event Map ───────────────────────────────────────────────────────────

export interface IpcEventMap {
  "copilot:authError": string;
  "copilot:loginFailed": string;
  "runtimeAuth:authError": string;
  "runtimeAuth:loginFailed": string;
  "runtime-ui:event": RuntimeUiEvent;
  "runtime-ui:placements-changed": RuntimeUiPlacementSnapshot;
  "runtime-extensions:changed": RuntimeExtensionsChangedEvent;
  "gatewayAuth:stateChange": GatewayAuthState;
  "gatewayNode:activity": NodeActivityEntry;
  "identity:change": UserIdentity;
  "permissions:cards-changed": { sessionId: string; cards: PermissionCardData[] };
  "session:view": SessionViewDelivery;
  "sessions:status-delta": SessionStatusBatch;
  "overlay-review:pending": OverlayReviewPendingEvent;
  "overlay-review:error": OverlayReviewErrorEvent;
  "session:metadata-changed": string | SessionMetadataChangedEvent;
  "sessions:hydration-changed": SessionHydrationEvent;
  "sessions:switch-to": string;
  "sessions:list-changed": void;
  "command-center:snapshot": CommandCenterSnapshot;
  "command-center:workspace-state-changed": SessionWorkspaceState;
  "settings:changed": void;
  "settings:toggle": void;
  "relay-provider-settings:changed": RelayProviderRuntimeSnapshot;
  "relay-provider-settings:setup-changed": RelayProviderSetupEvent;
  "skills:changed": void;
  "goal:changed": GoalChangedEventPayload;
  "decisions:changed": import("./decision-log-contract").DecisionsChangedEventPayload;
  "requests:changed": import("./request-ledger-contract").RequestsChangedEventPayload;
  "sessionImport:progress": SessionImportJob;
  "sessionBrainShare:changed": Record<string, BrainShareRecord>;
  "automations:changed": void;
  "models:changed": void;
  "telemetry:logError": MidgardError;
  "telemetry:logEvent": { scenario: string; fields: Record<string, unknown> };
  "telemetry:finalize": void;
  "tenant:policyChanged": void;
  "org:statusChanged": void;
  "org:projectsEvent": OrgProjectsEvent;
  "org:sessionLinkPending": void;
  "org:openRun": string;
  "org:sessionChanged": OrgSessionChange;
  /** A local session's link to a shared organization session changed (joined, synced, revoked). */
  "org:sharedLinkChanged": OrgSharedLinkChangedEvent;
  /** A shared session's live state changed (presence, a reply being written, the room's connection). */
  "org:sharedLiveChanged": OrgSharedLiveChangedEvent;
  "update:progress": number;
  "update:device-flow": { userCode: string; verificationUri: string };
  "update:trigger-check": void;
  "window-controls:maximized-changed": boolean;
  "window-controls:fullscreen-changed": boolean;
  "workspace:changed": void;
  "workspace:registry-changed": void;
  "mcp:tools-updated": void;
  "mcp:server-status": {
    serverName: string;
    status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "not_configured";
    error?: string;
    source?: string;
  };
  "mcp:oauth-required": {
    requestId: string;
    serverName: string;
    serverUrl: string;
    /**
     * Originating session id. Forwarded so the dialog can pass it back on
     * sign-in submit, letting the OAuth IPC handler use the same session as
     * the executor for `oauth.login`. Optional because user-initiated
     * sign-in does not flow through this event.
     */
    sessionId?: string;
  };
  "mcp:oauth-completed": {
    requestId: string;
  };
  "aiInvestigator:event": AIInvestigatorEvent;

  // ── workflowsAPI events (emitted by IMPL-ENGINE) ─────────────────────────
  /** Channel name uses a runId suffix: `workflows:run-events:<runId>`. */
  "workflows:run-events": WorkflowRunEventBatch;
  /** Channel name uses a runId suffix: `workflows:run-status:<runId>`. */
  "workflows:run-status": WorkflowRunStatusEvent;
  /** Channel name uses a runId suffix: `workflows:run-tick:<runId>`. */
  "workflows:run-tick": WorkflowRunTickEvent;
  /** Permission-card dual-route (R1-FIXES A10). */
  "workflow:permission-request": WorkflowPermissionRequestEvent;
}

// ── Derived Namespace Utilities ─────────────────────────────────────────────

/** Convert kebab-case to camelCase: "delete-all" → "deleteAll" */
type KebabToCamel<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<KebabToCamel<T>>}`
  : S;

/**
 * Derive renderer API methods from IpcInvokeMap for a given channel namespace.
 * Converts channel suffixes from kebab-case to camelCase automatically.
 * E.g., InvokeMethodsFor<"sessions"> extracts all "sessions:*" channels and
 * maps "delete-all" → deleteAll, "save-messages" → saveMessages, etc.
 */
type InvokeMethodsFor<NS extends string> = {
  [K in keyof IpcInvokeMap as K extends `${NS}:${infer M}`
    ? KebabToCamel<M>
    : never]: IpcInvokeMap[K];
};

// ── Namespace API Interfaces ────────────────────────────────────────────────
// Invoke methods are derived from IpcInvokeMap. Event listeners and non-IPC
// methods (getPathForFile) are declared manually.

export interface CopilotAPI extends InvokeMethodsFor<"copilot"> {
  onAuthError: (callback: (error: string) => void) => () => void;
  onLoginFailed: (callback: (reason: string) => void) => () => void;
}

export interface RuntimeAuthAPI extends InvokeMethodsFor<"runtimeAuth"> {
  onAuthError: (callback: (error: string) => void) => () => void;
  onLoginFailed: (callback: (reason: string) => void) => () => void;
}

export interface RuntimeAccountView {
  id: string;
  label: string;
  /** True for the account that existed before accounts; it keeps the runtime's original credentials. */
  isOriginal: boolean;
  /** True for the account plain models of this runtime run on. */
  isDefault: boolean;
  /** Model-id prefix that runs a session on this account, e.g. `claude@work` or `claude@default`. */
  targetKey: string;
}

export interface RuntimeAccountsView {
  runtimeId: string;
  displayName: string;
  /** Sign-in methods whose credentials persist per account. */
  authMethods: Array<{ type: RuntimeInteractiveAuthMethod; label: string }>;
  accounts: RuntimeAccountView[];
}

export type RuntimeAccountsAPI = InvokeMethodsFor<"runtimeAccounts">;

export interface RuntimeUiAPI extends Omit<
  InvokeMethodsFor<"runtime-ui">,
  | "invokeCapability"
  | "invokePlacementCapability"
  | "cancelCapability"
  | "readResource"
  | "getEvidence"
  | "openEvidence"
  | "selectSession"
  | "getSelectedSession"
  | "searchSessions"
  | "selectImages"
  | "listImages"
  | "readImage"
  | "releaseImage"
  | "getLayout"
  | "saveLayout"
  | "reportViewHealth"
  | "compileStreamFrame"
  | "readStreamTemplate"
  | "promoteStreamFrame"
> {
  /** Optional: remote clients and older embedded windows do not report view health. */
  reportViewHealth?: InvokeMethodsFor<"runtime-ui">["reportViewHealth"];
  /** Optional: only windows that render streaming `marshal-ui` blocks use these. */
  compileStreamFrame?: InvokeMethodsFor<"runtime-ui">["compileStreamFrame"];
  readStreamTemplate?: InvokeMethodsFor<"runtime-ui">["readStreamTemplate"];
  promoteStreamFrame?: InvokeMethodsFor<"runtime-ui">["promoteStreamFrame"];
  /** Optional: remote clients and older embedded windows have no desktop layout. */
  getLayout?: InvokeMethodsFor<"runtime-ui">["getLayout"];
  saveLayout?: InvokeMethodsFor<"runtime-ui">["saveLayout"];
  /** Optional for older embedded windows; present in the current preload. */
  getEvidence?: InvokeMethodsFor<"runtime-ui">["getEvidence"];
  openEvidence?: InvokeMethodsFor<"runtime-ui">["openEvidence"];
  invokeCapability?: InvokeMethodsFor<"runtime-ui">["invokeCapability"];
  /** Optional: desktop-only; remote clients cannot run placement items. */
  invokePlacementCapability?: InvokeMethodsFor<"runtime-ui">["invokePlacementCapability"];
  cancelCapability?: InvokeMethodsFor<"runtime-ui">["cancelCapability"];
  selectSession?: InvokeMethodsFor<"runtime-ui">["selectSession"];
  getSelectedSession?: InvokeMethodsFor<"runtime-ui">["getSelectedSession"];
  searchSessions?: InvokeMethodsFor<"runtime-ui">["searchSessions"];
  selectImages?: InvokeMethodsFor<"runtime-ui">["selectImages"];
  listImages?: InvokeMethodsFor<"runtime-ui">["listImages"];
  readImage?: InvokeMethodsFor<"runtime-ui">["readImage"];
  releaseImage?: InvokeMethodsFor<"runtime-ui">["releaseImage"];
  /** Optional for older embedded windows; present in the current preload. */
  readResource?: InvokeMethodsFor<"runtime-ui">["readResource"];
  onEvent: (callback: (event: RuntimeUiEvent) => void) => () => void;
}

export interface RuntimeExtensionsAPI extends InvokeMethodsFor<"runtime-extensions"> {
  onChanged: (callback: (event: RuntimeExtensionsChangedEvent) => void) => () => void;
}

export type SwarmAPI = InvokeMethodsFor<"swarm">;

export interface OverlayReviewAPI extends InvokeMethodsFor<"overlay-review"> {
  onPending: (callback: (event: OverlayReviewPendingEvent) => void) => () => void;
  onError: (callback: (event: OverlayReviewErrorEvent) => void) => () => void;
}

export interface SessionsAPI extends InvokeMethodsFor<"sessions"> {
  onSwitchTo: (callback: (sessionId: string) => void) => () => void;
  onViewEvent: (callback: (event: SessionViewDelivery) => void) => () => void;
  onStatusDelta: (callback: (event: SessionStatusBatch) => void) => () => void;
  onMetadataChanged: (
    callback: (sessionId: string, changes?: Partial<SessionMetadata>) => void,
  ) => () => void;
  /** Fires when the main process mutates the session index (gateway reconcile,
   *  live sessions.changed events). Renderer invalidates ["sessions"] query on
   *  receipt so the sidebar stays in sync without polling. */
  onListChanged: (callback: () => void) => () => void;
  /** Lifecycle of index-only sessions whose data fetches in the background.
   *  ChatPanel renders a skeleton while `started` is in flight. */
  onHydrationChanged: (callback: (event: SessionHydrationEvent) => void) => () => void;
}

export interface SessionHealthSession {
  sessionId: string;
  title: string;
  parentSessionId?: string;
  processCount: number;
  rssBytes: number;
  cpuPercent: number;
  isBusy: boolean;
}

export interface SessionHealthZombie {
  pid: number;
  parentPid: number;
  label: string;
  parentLabel: string | null;
  sessionId: string;
}

export interface SessionHealthOrphan {
  pid: number;
  label: string;
  rssBytes: number;
  ageMs: number | null;
  sessionId: string;
}

export interface SessionHealth {
  capturedAtUnixMs: number;
  rootSessionId: string;
  processAttribution: "available" | "unsupported";
  totals: { cpuPercent: number; rssBytes: number; processCount: number };
  sessions: SessionHealthSession[];
  zombies: SessionHealthZombie[];
  orphans: SessionHealthOrphan[];
}

/** A cleanup an agent proposed through `health.cleanup.propose`; nothing runs until the user approves it. */
export type HealthCleanupProposal = {
  id: string;
  reason: string;
  proposedAtUnixMs: number;
} & ({ kind: "end-orphan"; pid: number } | { kind: "remove-worktree"; path: string });

export interface CommandCenterAPI extends InvokeMethodsFor<"command-center"> {
  onSnapshot: (callback: (snapshot: CommandCenterSnapshot) => void) => () => void;
  onWorkspaceStateChanged: (callback: (state: SessionWorkspaceState) => void) => () => void;
}

export interface ModelsAPI extends InvokeMethodsFor<"models"> {
  /** The model catalog changed (a runtime account finished loading or signed in/out). */
  onChanged: (callback: () => void) => () => void;
}

export type SoulAPI = InvokeMethodsFor<"soul">;

export interface SessionBrainShareAPI extends InvokeMethodsFor<"sessionBrainShare"> {
  onChanged: (callback: (shares: IpcEventMap["sessionBrainShare:changed"]) => void) => () => void;
}

export interface SessionImportAPI extends InvokeMethodsFor<"sessionImport"> {
  onProgress: (callback: (job: IpcEventMap["sessionImport:progress"]) => void) => () => void;
}

export interface SkillsAPI extends InvokeMethodsFor<"skills"> {
  onChanged: (callback: () => void) => () => void;
}

/** Renderer bridge for the goal feature. Mirrors the shape of the other
 *  `*Api` interfaces — invoke methods plus an `onChanged` subscription. */
export interface GoalAPI extends InvokeMethodsFor<"goal"> {
  /** Subscribe to backend-pushed goal changes. Returns an unsubscribe fn. */
  onChanged: (callback: (data: IpcEventMap["goal:changed"]) => void) => () => void;
}

/** Renderer bridge for a session's request ledger. */
export interface RequestsAPI extends InvokeMethodsFor<"requests"> {
  onChanged: (callback: (data: IpcEventMap["requests:changed"]) => void) => () => void;
}

/** Renderer bridge for linked Marshal SDK hosts and their sessions. */
export type SdkHostsAPI = InvokeMethodsFor<"sdkHosts">;

/** Renderer bridge for the decisions log: per-session entries and the cross-session board. */
export interface DecisionsAPI extends InvokeMethodsFor<"decisions"> {
  onChanged: (callback: (data: IpcEventMap["decisions:changed"]) => void) => () => void;
}

/** Renderer bridge for audio transcription (OpenAI transcription API). */
export type TranscribeAPI = InvokeMethodsFor<"transcribe">;

export interface SettingsAPI extends InvokeMethodsFor<"settings"> {
  onToggle: (callback: () => void) => () => void;
  onChanged: (callback: () => void) => () => void;
}

export interface RelayProviderSettingsAPI extends InvokeMethodsFor<"relay-provider-settings"> {
  onChanged: (
    callback: (snapshot: IpcEventMap["relay-provider-settings:changed"]) => void,
  ) => () => void;
  onSetupChanged: (
    callback: (event: IpcEventMap["relay-provider-settings:setup-changed"]) => void,
  ) => () => void;
}

export type EncryptionAPI = InvokeMethodsFor<"encryption">;

export interface RendererResponsivenessHeartbeat {
  schemaVersion: 1;
  sequence: number;
  sentAtUnixMs: number;
  frameCount: number;
  rendererUptimeMs: number;
  documentVisible: boolean;
  longTasksSupported: boolean;
  longTaskCount: number;
  longTaskTotalDurationMs: number;
  longTaskMaxDurationMs: number;
  lastAckRoundTripMs: number | null;
}

export interface MainEventLoopDelaySnapshot {
  /** Actual elapsed duration represented by completed samples; excludes the current partial sample. */
  sampleWindowMs: number;
  /** Arithmetic mean of the completed sample means. */
  meanMs: number;
  /** Highest p95 observed in any completed sample. */
  maxSampleP95Ms: number;
  /** Highest individual delay observed across the completed samples. */
  maxMs: number;
}

export interface RendererResponsivenessAck {
  success: boolean;
  sequence?: number;
  receivedAtUnixMs?: number;
  mainEventLoopDelay?: MainEventLoopDelaySnapshot;
  error?: string;
}

export interface RendererStallDiagnosticSnapshot {
  schemaVersion: 1;
  observedAtUnixMs: number;
  webContentsId: number;
  rendererPid: number;
  frameCount: number;
  stallDurationMs: number;
  heartbeatAgeMs: number;
  ipcDeliveryMs: number;
  lastAckRoundTripMs: number | null;
  longTasksSupported: boolean;
  longTaskCount: number;
  longTaskTotalDurationMs: number;
  longTaskMaxDurationMs: number;
  windowVisible: boolean;
  windowMinimized: boolean;
  windowFocused: boolean;
  mainEventLoopDelay: MainEventLoopDelaySnapshot;
  mainProcessPid: number;
  mainProcessUptimeMs: number;
  mainProcessRssBytes: number;
  mainProcessHeapUsedBytes: number;
}

export type ResourceProcessKind =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "runtime"
  | "child"
  | "other";

export interface ResourceProcessSample {
  pid: number;
  /** Executable basename or Electron process type; never a full command line. */
  label: string;
  kind: ResourceProcessKind;
  cpuPercent: number;
  rssBytes: number;
  /** Size of the subtree folded into cpuPercent/rssBytes (1 = just this process). */
  processCount: number;
  ageMs: number | null;
}

export interface SessionResourceUsage {
  sessionId: string;
  title: string;
  parentSessionId?: string;
  parentTitle?: string;
  source?: SessionSource;
  model?: string;
  isBusy: boolean;
  isForeground: boolean;
  idleMs: number | null;
  /** Processes owned by this chat (its runtime CLI plus descendants). 0 = shared runtime or remote. */
  processCount: number;
  cpuPercent: number;
  rssBytes: number;
  /** Age of the youngest owned runtime process; small values across many chats mean resume churn. */
  newestProcessAgeMs: number | null;
}

export interface ResourceStallSample {
  observedAtUnixMs: number;
  stallDurationMs: number;
  mainEventLoopMaxMs: number;
}

export interface ResourceSnapshot {
  capturedAtUnixMs: number;
  /** "unsupported" when the OS process table is unavailable (Windows); totals then cover Electron processes only. */
  processAttribution: "available" | "unsupported";
  totals: { cpuPercent: number; rssBytes: number; processCount: number };
  main: {
    pid: number;
    cpuPercent: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    eventLoop: MainEventLoopDelaySnapshot;
  };
  appProcesses: ResourceProcessSample[];
  sessions: SessionResourceUsage[];
  liveSessionCount: number;
  /** Child process subtrees not owned by a live chat: shared runtime servers, MCP hosts, leftovers. */
  unattributed: ResourceProcessSample[];
  /** Runtime child processes started within the last five minutes. */
  recentRuntimeStarts: number;
  recentStalls: ResourceStallSample[];
}

export type DiagnosticsAPI = InvokeMethodsFor<"diagnostics">;

export type HeartbeatAPI = InvokeMethodsFor<"heartbeat">;

export interface AIInvestigatorAPI extends InvokeMethodsFor<"aiInvestigator"> {
  onEvent: (callback: (event: IpcEventMap["aiInvestigator:event"]) => void) => () => void;
}

// AutomationsAPI: "automations:export" → exportAutomation, "automations:import" → importAutomation
// These don't match the kebab-to-camel pattern, so we exclude and add manually.
export interface AutomationsAPI extends Omit<InvokeMethodsFor<"automations">, "export" | "import"> {
  exportAutomation: IpcInvokeMap["automations:export"];
  importAutomation: IpcInvokeMap["automations:import"];
  /**
   * Subscribe to backend-pushed automation change events. Fired when a
   * condition-trigger watcher fires (gateway only — copilot has no equivalent
   * watcher fire path today). Returns an unsubscribe function. Renderer wires
   * this to invalidate the react-query `["automations"]` cache so the panel
   * reflects the new `firedAt` / `enabled: false` state without a manual
   * refetch.
   */
  onChanged: (callback: () => void) => () => void;
}

export interface UpdateAPI extends InvokeMethodsFor<"update"> {
  onProgress: (callback: (percent: number) => void) => () => void;
  onDeviceFlow: (
    callback: (data: { userCode: string; verificationUri: string }) => void,
  ) => () => void;
  onTriggerCheck: (callback: () => void) => () => void;
}

export type BackgroundAPI = InvokeMethodsFor<"background">;

export interface WindowControlsAPI extends InvokeMethodsFor<"window-controls"> {
  onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void;
  onFullScreenChanged: (callback: (isFullScreen: boolean) => void) => () => void;
}

export type ChatWindowsAPI = InvokeMethodsFor<"chat-windows">;

export interface McpsAPI extends InvokeMethodsFor<"mcps"> {
  onToolsUpdated?: (callback: () => void) => () => void;
  /** Bundled CLI emitted a server status change (connected / failed / needs-auth / etc.). */
  onServerStatus?: (callback: (data: IpcEventMap["mcp:server-status"]) => void) => () => void;
  /** Bundled CLI is opening a browser to authenticate against a remote MCP server. */
  onOAuthRequired?: (callback: (data: IpcEventMap["mcp:oauth-required"]) => void) => () => void;
  /** Bundled CLI completed an OAuth flow for a remote MCP server. */
  onOAuthCompleted?: (callback: (data: IpcEventMap["mcp:oauth-completed"]) => void) => () => void;
}

export interface TenantAPI extends InvokeMethodsFor<"tenant"> {
  onPolicyChanged?: (callback: () => void) => () => void;
}

export interface OrgAPI extends Omit<
  InvokeMethodsFor<"org">,
  | "openRunChat"
  | "listRoutineEvents"
  | "dispatchRoutine"
  | "setRoutineEnabled"
  | "testRoutineEventLocally"
  | "testRoutineInCloud"
  | "promoteRoutine"
  | "listPromoteTargets"
  | "findCloudTestRun"
  | "watchSession"
  | "unwatchSession"
  | "postComment"
  | "noteMentions"
  | "listShareWorkspaces"
  | "setSessionWorkspace"
  | "onboardingGetManifest"
  | "onboardingStatus"
  | "onboardingInstall"
  | "onboardingConnect"
  | "onboardingRunVault"
  | "catalogGet"
  | "catalogUpdate"
  | "catalogReview"
  | "catalogInstall"
  | "catalogPublishable"
  | "catalogPublish"
  | "catalogPublishPreview"
  | "skillsGet"
  | "skillsInstall"
  | "skillsRemove"
  | "skillsPublishable"
  | "skillsPublishPreview"
  | "skillsPublish"
  | "skillsReview"
  | "skillsUpdate"
  | "skillsReviewFiles"
  | "devToolsDetect"
  | "devToolsPlan"
  | "devToolsInstall"
  | "projectsStatus"
  | "projectsLogin"
  | "projectsSetupGit"
  | "projectsCancelLogin"
  | "projectsList"
  | "projectsPickFolder"
  | "projectsClone"
  | "projectsCancelClone"
  | "joinSharedSession"
  | "getSharedLink"
  | "getSharedLive"
  | "setSharedComposing"
  | "listSharedLinks"
> {
  /** Shared sessions (flag `org.liveSessions`); absent in a build without them. */
  joinSharedSession?: InvokeMethodsFor<"org">["joinSharedSession"];
  getSharedLink?: InvokeMethodsFor<"org">["getSharedLink"];
  /** Shared sessions over rooms (flag `org.rooms`); absent in a build without them. */
  getSharedLive?: InvokeMethodsFor<"org">["getSharedLive"];
  setSharedComposing?: InvokeMethodsFor<"org">["setSharedComposing"];
  onSharedLiveChanged?: (callback: (event: OrgSharedLiveChangedEvent) => void) => () => void;
  listSharedLinks?: InvokeMethodsFor<"org">["listSharedLinks"];
  /** Organization onboarding; absent in a build without it. */
  onboardingGetManifest?: () => Promise<OrgOnboardingManifestResult>;
  onboardingStatus?: (scope: OrgOnboardingScope) => Promise<OrgOnboardingStatusResult>;
  onboardingInstall?: (request: {
    scope: OrgOnboardingScope;
    ids: string[];
  }) => Promise<OrgOnboardingInstallResult>;
  onboardingConnect?: (request: {
    scope: OrgOnboardingScope;
    extensionId: string;
    index: number;
  }) => Promise<OrgOnboardingConnectResult>;
  onboardingRunVault?: (request: {
    scope: OrgOnboardingScope;
    capability: string;
    input?: unknown;
  }) => Promise<OrgOnboardingRunResult>;
  /** Settings > Organization > Extensions: the org extension catalog; absent in a build without it. */
  catalogGet?: (scope?: OrgOnboardingScope) => Promise<OrgCatalogResult>;
  catalogUpdate?: (request: OrgCatalogUpdateRequest) => Promise<OrgCatalogActionResult>;
  catalogReview?: (request: OrgCatalogReviewRequest) => Promise<OrgCatalogActionResult>;
  catalogInstall?: (request: {
    scope: OrgOnboardingScope;
    id: string;
    version: string;
  }) => Promise<OrgOnboardingInstallResult>;
  catalogPublishable?: (scope: OrgOnboardingScope) => Promise<OrgPublishableResult>;
  catalogPublish?: (request: OrgCatalogPublishRequest) => Promise<OrgCatalogActionResult>;
  catalogPublishPreview?: (
    request: OrgCatalogPublishPreviewRequest,
  ) => Promise<OrgCatalogPublishPreviewResult>;
  /** Organization skills (Plugins, Skills tab, Settings > Organization); absent in a build without them. */
  skillsGet?: InvokeMethodsFor<"org">["skillsGet"];
  skillsInstall?: InvokeMethodsFor<"org">["skillsInstall"];
  skillsRemove?: InvokeMethodsFor<"org">["skillsRemove"];
  skillsPublishable?: InvokeMethodsFor<"org">["skillsPublishable"];
  skillsPublishPreview?: InvokeMethodsFor<"org">["skillsPublishPreview"];
  skillsPublish?: InvokeMethodsFor<"org">["skillsPublish"];
  skillsReview?: InvokeMethodsFor<"org">["skillsReview"];
  skillsUpdate?: InvokeMethodsFor<"org">["skillsUpdate"];
  skillsReviewFiles?: InvokeMethodsFor<"org">["skillsReviewFiles"];
  openRunChat?: InvokeMethodsFor<"org">["openRunChat"];
  /** Picking an organization workspace for an unmapped session; absent in a build without it. */
  listShareWorkspaces?: InvokeMethodsFor<"org">["listShareWorkspaces"];
  setSessionWorkspace?: InvokeMethodsFor<"org">["setSessionWorkspace"];
  /** A cloud routine's events, run now, on/off and local test; absent in a build without them. */
  listRoutineEvents?: InvokeMethodsFor<"org">["listRoutineEvents"];
  dispatchRoutine?: InvokeMethodsFor<"org">["dispatchRoutine"];
  setRoutineEnabled?: InvokeMethodsFor<"org">["setRoutineEnabled"];
  testRoutineEventLocally?: InvokeMethodsFor<"org">["testRoutineEventLocally"];
  /** Test a local routine once in the cloud, or open the pull request that makes it a cloud routine; absent in a build without them. */
  testRoutineInCloud?: InvokeMethodsFor<"org">["testRoutineInCloud"];
  promoteRoutine?: InvokeMethodsFor<"org">["promoteRoutine"];
  listPromoteTargets?: InvokeMethodsFor<"org">["listPromoteTargets"];
  findCloudTestRun?: InvokeMethodsFor<"org">["findCloudTestRun"];
  devToolsDetect?: InvokeMethodsFor<"org">["devToolsDetect"];
  devToolsPlan?: InvokeMethodsFor<"org">["devToolsPlan"];
  devToolsInstall?: InvokeMethodsFor<"org">["devToolsInstall"];
  /** Onboarding Projects step; absent in a build without it. */
  projectsStatus?: InvokeMethodsFor<"org">["projectsStatus"];
  projectsLogin?: InvokeMethodsFor<"org">["projectsLogin"];
  projectsSetupGit?: InvokeMethodsFor<"org">["projectsSetupGit"];
  projectsCancelLogin?: InvokeMethodsFor<"org">["projectsCancelLogin"];
  projectsList?: InvokeMethodsFor<"org">["projectsList"];
  projectsPickFolder?: InvokeMethodsFor<"org">["projectsPickFolder"];
  projectsClone?: InvokeMethodsFor<"org">["projectsClone"];
  projectsCancelClone?: InvokeMethodsFor<"org">["projectsCancelClone"];
  /** Starts following a session's change feed in the main process; absent in a build without it. */
  watchSession?: (sessionId: string) => Promise<OrgSessionWatchResult>;
  unwatchSession?: (sessionId: string) => Promise<void>;
  /** Posts a comment for a session's owner; absent in a build without comments. */
  postComment?: (request: { sessionId: string; text: string }) => Promise<OrgPostCommentResult>;
  /** Tells the model, on the next turn, who the message being sent tagged; absent in a build without it. */
  noteMentions?: InvokeMethodsFor<"org">["noteMentions"];
  onProjectsEvent?: (callback: (event: OrgProjectsEvent) => void) => () => void;
  onStatusChanged?: (callback: () => void) => () => void;
  onSessionLinkPending?: (callback: () => void) => () => void;
  /** Main asks the renderer to show a run (`run:<id>[:<session>]`) in the read-only shared-session view. */
  onOpenRun?: (callback: (viewId: string) => void) => () => void;
  /** The main process's view of a watched session's change feed: whether it is live, and whether it just changed. */
  onSessionChanged?: (callback: (event: OrgSessionChange) => void) => () => void;
  /** A local session's shared link changed. */
  onSharedLinkChanged?: (callback: (event: OrgSharedLinkChangedEvent) => void) => () => void;
}

export type ContextPickerAPI = InvokeMethodsFor<"contextPicker">;

export interface GatewayAuthAPI extends InvokeMethodsFor<"gatewayAuth"> {
  onStateChange: (callback: (state: GatewayAuthState) => void) => () => void;
}

export interface GatewayNodeAPI extends InvokeMethodsFor<"gatewayNode"> {
  /** Subscribe to live activity entries. Returns an unsubscribe fn. */
  onActivity: (callback: (entry: NodeActivityEntry) => void) => () => void;
}

export interface IdentityAPI extends InvokeMethodsFor<"identity"> {
  onChange: (callback: (identity: UserIdentity) => void) => () => void;
}

export interface WorkspaceAPI extends Omit<
  InvokeMethodsFor<"workspace">,
  "registerExternalFileImportBridge" | "authorizeExternalFiles" | "copyExternalFiles"
> {
  onWorkspaceChange: (callback: () => void) => () => void;
  onWorkspaceRegistryChange: (callback: () => void) => () => void;
  copyExternalFiles: (
    files: FileList | readonly File[],
    destDir: string,
  ) => Promise<{ success: boolean; copied?: number; error?: string }>;
  /** Non-IPC: calls webUtils.getPathForFile() in preload context */
  getPathForFile: (file: File) => string;
}

export interface PermissionsAPI extends InvokeMethodsFor<"permissions"> {
  onCardsChanged: (
    callback: (data: { sessionId: string; cards: PermissionCardData[] }) => void,
  ) => () => void;
}

export type DevAPI = InvokeMethodsFor<"dev">;

export type MiniModeAPI = InvokeMethodsFor<"mini-mode">;

export type ActivitiesAPI = InvokeMethodsFor<"activities">;

export interface ShellAPI extends InvokeMethodsFor<"shell"> {
  onFileOpenError: (callback: (error: string) => void) => () => void;
}

export type PreferencesAPI = InvokeMethodsFor<"preferences">;

export type FileExportAPI = InvokeMethodsFor<"file">;

export type BackendAPI = InvokeMethodsFor<"backend">;

export type AppAPI = InvokeMethodsFor<"app">;

export interface WorkflowsAPI extends InvokeMethodsFor<"workflows"> {
  /** Subscribe to batched event delivery for a specific run (30Hz). */
  subscribeRunEvents: (
    runId: string,
    callback: (batch: WorkflowRunEventBatch) => void,
  ) => () => void;
  /** Subscribe to coarse status-change pushes for a run. */
  subscribeRunStatus: (
    runId: string,
    callback: (event: WorkflowRunStatusEvent) => void,
  ) => () => void;
  /** Subscribe to 1Hz top-bar tick — cheap and constant cadence. */
  subscribeRunTick: (runId: string, callback: (event: WorkflowRunTickEvent) => void) => () => void;
  /** Subscribe to permission-card requests routed to the Workflows tab. */
  subscribePermissionRequests: (
    callback: (event: WorkflowPermissionRequestEvent) => void,
  ) => () => void;
}

export interface TelemetryAPI extends InvokeMethodsFor<"telemetry"> {
  onLogError: (callback: (error: IpcEventMap["telemetry:logError"]) => void) => () => void;
  onLogEvent: (callback: (event: IpcEventMap["telemetry:logEvent"]) => void) => () => void;
  onFinalize: (callback: () => void) => () => void;
}

// ── Utility Types ───────────────────────────────────────────────────────────

/**
 * Handler type for main-process IPC handlers.
 * - Strict parameter checking against the contract
 * - Accepts both sync and async returns (ipcMain.handle auto-wraps sync values)
 * - Handlers with conditional returns (try/catch) may need an explicit return
 *   type annotation to satisfy the discriminated union check
 */
export type IpcHandler<C extends keyof IpcInvokeMap> = IpcInvokeMap[C] extends (
  ...args: infer A
) => Promise<infer R>
  ? (event: Electron.IpcMainInvokeEvent, ...args: A) => R | Promise<R>
  : never;
