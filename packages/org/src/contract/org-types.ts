// Organization contract types, shared by the desktop's IPC contract and the Marshal SDK.

export type OrgSignInState = "disabled" | "signed-out" | "signing-in" | "signed-in";

export interface OrgStatus {
  success: boolean;
  error?: string;
  state: OrgSignInState;
  /** Flags `org.enabled` and `org.signIn` are both on. */
  enabled: boolean;
  /** Flags `org.workspaces`, `org.signIn` and `org.enabled` are all on. */
  workspacesEnabled: boolean;
  /** Flags `org.remoteSessions`, `org.signIn` and `org.enabled` are all on. */
  remoteSessionsEnabled: boolean;
  /** Flag `org.sessionSharing` and everything it needs are on. */
  sessionSharingEnabled?: boolean;
  /** Flag `org.mentions` and everything it needs are on. */
  mentionsEnabled?: boolean;
  /** Flag `org.cloudMove` and everything it needs are on. */
  cloudMoveEnabled?: boolean;
  /** Flag `org.sessionAudit` and everything it needs are on. */
  sessionAuditEnabled?: boolean;
  /** Flag `org.remoteMode` and everything it needs are on. */
  remoteModeEnabled?: boolean;
  /** Flag `org.cloudGroup` and everything it needs are on. */
  cloudGroupEnabled?: boolean;
  /** Flag `org.fork` and everything it needs are on. */
  forkEnabled?: boolean;
  /** Onboarding is available: signed in to an organization that serves it. */
  onboardingEnabled?: boolean;
  /** Flag `org.placement` and everything it needs are on. */
  placementEnabled?: boolean;
  /** Flag `org.liveSessions` and everything it needs are on. */
  liveSessionsEnabled?: boolean;
  /** Flag `org.rooms` and everything it needs are on. */
  roomsEnabled?: boolean;
  orgUrl?: string;
  /** An admin policy pins the URL; the user cannot change it. */
  orgUrlManaged: boolean;
  /** Signed in and the organization's discovery document is loaded, so `features` is the real list (it may be empty). */
  featuresKnown?: boolean;
  /** Signed in, but the organization's discovery document could not be loaded, so `features` is unknown. */
  discoveryFailed?: boolean;
  orgDisplayName?: string;
  identity?: { displayName: string; email: string };
  /** Extensions allowed to use the org services only because a local build was trusted. */
  locallyTrustedExtensions?: string[];
  features: string[];
  /** Short failure code from the last sign-in attempt, never a message that could carry secrets. */
  lastError?: string;
}

/**
 * The organization workspace a local workspace belongs to, derived from its git `origin`. `message` is
 * the user-facing reason when it is not mapped; only mapped workspaces can be shared or moved to the cloud.
 */
export type OrgWorkspaceMapping =
  | { mapped: true; orgWorkspaceId: string; orgWorkspaceName: string; repo: string }
  | {
      mapped: false;
      reason:
        | "no-workspace"
        | "no-origin"
        | "repo-not-in-org"
        | "ambiguous"
        | "origin-mismatch"
        | "unavailable";
      message: string;
      repo?: string;
    };

/** An organization workspace a session can be shared into when its own workspace maps to none. */
export interface OrgShareWorkspace {
  id: string;
  displayName: string;
}

/**
 * A session's organization workspace. `mapping` is what its local workspace maps to; when that is not
 * mapped, `chosen` is the organization workspace the person picked for this session (sharing and
 * mentions use it) and `canChoose` says whether picking one is possible.
 */
export type OrgSessionWorkspaceMappingResult =
  | {
      success: true;
      mapping: OrgWorkspaceMapping;
      chosen?: OrgShareWorkspace;
      canChoose?: boolean;
    }
  | { success: false; error: string };

export type OrgShareWorkspacesResult =
  | { success: true; workspaces: OrgShareWorkspace[] }
  | { success: false; error: string };

export interface OrgSetSessionWorkspaceRequest {
  sessionId: string;
  orgWorkspaceId: string;
}

// ── Organization workspace routines ─────────────
// The agent workflows that run for an organization workspace (GET /v1/workspaces/:id/routines) and their
// runs from the organization's run index. Links are only those the organization served.

export interface OrgRoutineView {
  id: string;
  title: string;
  description?: string;
  /** The engine workflow its runs carry. */
  workflow: string;
  /** Cron schedules (UTC) as the workflow file states them. */
  schedules: string[];
  manual: boolean;
  /** Events other than a schedule or a manual dispatch, by name. */
  events: string[];
  definitionPath: string;
  definitionUrl: string;
  docUrl?: string;
  /** The Slack channel ids the routine posts to. */
  channels: string[];
  channelCount: number;
  /** What mainly starts it; an `event` routine is run now only by replaying one of its events. */
  kind: "event" | "schedule" | "manual";
  /** Whether its workflow is on; absent when the organization does not say. */
  enabled?: boolean;
  /** Whether the organization serves its events (`routineEvents`). */
  hasEvents: boolean;
  /** Whether the organization runs it now and turns it on or off (`routineActions`). */
  canControl: boolean;
}

export type OrgWorkspaceRoutinesResult =
  | { success: true; orgWorkspaceId: string; routines: OrgRoutineView[] }
  | { success: false; error: string };

/** Something a run started from or produced: a pull request, a Linear or Datadog issue, a root cause. */
export interface OrgRoutineRunOutput {
  kind: "pr" | "linear" | "datadog" | "pagerduty" | "monitor" | "root-cause";
  key: string;
  role: "origin" | "output" | "related";
  /** Set for the links Marshal can open (a pull request on github.com). */
  url?: string;
}

export interface OrgRoutineRunView {
  /** Opens the run's transcript as a remote session view. */
  viewId: string;
  title: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  durationMs?: number;
  costUsd: number;
  dryRun: boolean;
  toolErrors: number;
  flags: string[];
  /** The GitHub event that started the run (`schedule`, `workflow_dispatch`, `repository_dispatch`, …). */
  trigger?: string;
  /** The Slack channel id of the thread the run started from. */
  originChannel?: string;
  /** The Slack channel ids the run posted to, other than its origin. */
  postedChannels: string[];
  slackThreads: number;
  outputs: OrgRoutineRunOutput[];
  /** The run's final answer, when the organization serves it to this reader. */
  answer?: string;
  githubUrl?: string;
  hasTranscript: boolean;
}

export type OrgRoutineRunStatusFilter = "running" | "succeeded" | "failed";

export interface OrgRoutineRunsRequest {
  orgWorkspaceId: string;
  workflow: string;
  limit?: number;
  /** A Slack channel id: only runs linked to a thread in that channel. */
  channel?: string;
  status?: OrgRoutineRunStatusFilter;
  /** A GitHub event name. */
  trigger?: string;
}

export type OrgRoutineRunsResult =
  | { success: true; runs: OrgRoutineRunView[]; more: boolean }
  | { success: false; error: string };

export type OrgRoutineEventSeverity = "error" | "warning" | "info";

export type OrgRoutineEventStatus = "handled" | "unhandled";

/** One event that woke a cloud routine; the run it started is its id. */
export interface OrgRoutineEventView {
  id: string;
  /** Opens the run the event started (`org:openRunChat`). */
  viewId: string;
  at: string;
  title: string;
  /** Where it came from: a Datadog issue, a monitor, a Slack thread, or the trigger of a run with no link. */
  sourceKind: string;
  sourceKey: string;
  /** The Slack channel id it came from or was answered in. */
  channel?: string;
  severity: OrgRoutineEventSeverity;
  /** The agent role that handled it. */
  role?: string;
  status: OrgRoutineEventStatus;
  runStatus: "running" | "succeeded" | "failed";
  dryRun: boolean;
  githubUrl?: string;
}

export interface OrgRoutineEventsRequest {
  orgWorkspaceId: string;
  routineId: string;
  /** ISO 8601 times. */
  since?: string;
  until?: string;
  channel?: string;
  severity?: OrgRoutineEventSeverity;
  role?: string;
  status?: OrgRoutineEventStatus;
  q?: string;
  cursor?: string;
  limit?: number;
}

export type OrgRoutineEventsResult =
  | { success: true; events: OrgRoutineEventView[]; nextCursor?: string }
  | { success: false; error: string };

export interface OrgRoutineDispatchRequest {
  orgWorkspaceId: string;
  routineId: string;
  /** An event (run id) of the routine to replay; required for an event routine. */
  eventId?: string;
}

export type OrgRoutineDispatchResult =
  | { success: true; replayOf?: string }
  | { success: false; error: string };

export interface OrgRoutineEnabledRequest {
  orgWorkspaceId: string;
  routineId: string;
  enabled: boolean;
}

export type OrgRoutineEnabledResult =
  | { success: true; enabled: boolean }
  | { success: false; error: string };

/** Runs a cloud routine's event on this Marshal: a new chat in `workspaceName` gets the routine and the event as its task. */
export interface OrgRoutineTestLocallyRequest {
  orgWorkspaceId: string;
  routineId: string;
  eventId: string;
  workspaceName?: string;
}

export type OrgRoutineTestLocallyResult =
  | { success: true; sessionId: string }
  | { success: false; error: string };

/** A local routine file (`repo:<id>` or `personal:<id>`) of `workspaceName`, sent to the organization. */
export interface OrgLocalRoutineRef {
  workspaceName?: string;
  localKey: string;
}

/** Runs a local agent routine once in the cloud as a dry run, without adding it to any workspace. */
export interface OrgRoutineCloudTestRequest extends OrgLocalRoutineRef {
  orgWorkspaceId: string;
}

/** Where a cloud test's run shows up in the run index once it is picked up. */
export interface OrgCloudTestRunsQuery {
  orgWorkspaceId: string;
  workflow: string;
  testId: string;
}

export type OrgRoutineCloudTestResult =
  | { success: true; testId: string; title: string; runs: OrgCloudTestRunsQuery }
  | { success: false; error: string; message?: string };

/** Opens the pull request that adds a local agent routine as a cloud routine of `orgWorkspaceId`. */
export interface OrgRoutinePromoteRequest extends OrgLocalRoutineRef {
  orgWorkspaceId: string;
}

export type OrgRoutinePromoteResult =
  | { success: true; prUrl: string; number: number }
  | { success: false; error: string; message?: string; prUrl?: string };

/** A cloud test's run, once the run index has it. */
export type OrgCloudTestRunResult =
  | {
      success: true;
      run?: {
        runId: string;
        viewId: string;
        status: "running" | "succeeded" | "failed";
        hasTranscript: boolean;
        githubUrl?: string;
      };
    }
  | { success: false; error: string };

export type OrgPromoteTargetsResult =
  | { success: true; workspaces: Array<{ id: string; name: string }> }
  | { success: false; error: string };

// ── Organization onboarding: Projects step ─────────────
// The person's own GitHub identity (through the GitHub CLI) lists the repositories they can access in
// the organization's owner and clones each one into a Marshal workspace. Marshal never sees the token.

export type OrgProjectsGhStatus =
  | { success: true; gh: "missing"; installHint: string }
  | { success: true; gh: "unauthed" }
  | {
      success: true;
      gh: "ready";
      login: string;
      /** Set when git already had another github.com credential helper, which Marshal left unchanged. */
      credentialNotice?: string;
    };

export type OrgProjectsFailure = { success: false; error: string };

export type OrgProjectRepoState =
  | { kind: "not-cloned" }
  | { kind: "cloned"; path: string; workspaceName?: string }
  | { kind: "conflict"; path: string; reason: string };

export interface OrgProjectRepo {
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  sizeKb: number;
  pushedAt: string;
  state: OrgProjectRepoState;
}

export type OrgProjectsListResult =
  | {
      success: true;
      owner: string;
      root: string;
      repos: OrgProjectRepo[];
      /** Only when the list is empty: where to authorize the token for SAML SSO. */
      ssoUrl?: string;
    }
  | { success: false; error: string };

export interface OrgProjectsCloneRequest {
  owner: string;
  repos: string[];
  /** Folder to clone into; `~` is expanded. Each repo lands in `<root>/<repo>`. */
  root: string;
}

export interface OrgProjectCloneOutcome {
  repo: string;
  status: "cloned" | "registered" | "failed" | "cancelled";
  path?: string;
  workspaceName?: string;
  /** Whether the workspace now maps to an organization workspace through its git origin; undefined when unknown. */
  orgMapped?: boolean;
  error?: string;
}

export type OrgProjectsCloneResult =
  | { success: true; outcomes: OrgProjectCloneOutcome[] }
  | { success: false; error: string };

export type OrgProjectsEvent =
  | { kind: "device-code"; code: string; url: string }
  | { kind: "login-finished"; ok: boolean; error?: string }
  | { kind: "clone-progress"; repo: string; phase: string; percent?: number }
  | { kind: "clone-finished"; outcome: OrgProjectCloneOutcome };

// ── Organization remote sessions (flag org.remoteSessions) ───────────────────
// Sessions other people shared with the signed-in user. They live on the organization server and are
// held in memory only; they are never written to the local sessions index.

export type OrgRemoteSessionError =
  | "disabled"
  | "not-signed-in"
  | "unauthorized"
  | "not-shared"
  | "unavailable"
  | "unsupported"
  | "unreachable";

export type OrgRemoteSessionRole = "viewer" | "collaborator" | "driver" | "owner";

export interface OrgRemoteSessionSummary {
  id: string;
  title: string;
  /** Owner principal, for example `user:ada`. */
  owner: string;
  workspaceId: string;
  /** The organization workspace's display name when the organization lists it. */
  workspaceName?: string;
  /** The signed-in user's role on the session. */
  role: OrgRemoteSessionRole;
  updatedAt: string;
  runtime: string;
  messageCount: number;
  /** The owner turned live collaboration on: collaborators and drivers can send it messages, which the owner's Marshal runs. */
  live?: boolean;
}

export interface OrgRemoteTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  at: string;
  /** Principal of the person who wrote a user message, or whose Marshal wrote an assistant message, as the organization recorded it. */
  author?: string;
}

export interface OrgRemoteSessionDetail {
  session: OrgRemoteSessionSummary;
  messages: OrgRemoteTranscriptMessage[];
  /** True when the transcript is longer than the messages returned. */
  truncated: boolean;
}

export interface OrgRemoteNotificationSummary {
  id: string;
  kind:
    | "mention"
    | "share"
    | "handover-request"
    | "fork"
    | "needs-you"
    | "turn-finished"
    | "cloud-failed"
    | "held-message";
  sessionId: string;
  from: string;
  at: string;
  read: boolean;
}

/** What a cloud session is doing, as the organization's list reports it. */
export type OrgCloudTurnState =
  | "running"
  | "hot"
  | "stalled"
  | "queued"
  | "failed"
  | "needs-you"
  | "idle";

export interface OrgCloudSessionSummary {
  id: string;
  title: string;
  workspaceId: string;
  turnState: OrgCloudTurnState;
  /** Messages waiting for the cloud to run them. */
  queued: number;
  lastActivityAt: string;
  /** An https link to follow the run, as the organization's list gave it. */
  runLink?: string;
  /** A session whose Continue here was refused: the server lists it as local, and the row stays so the person can retry or remove it. */
  stranded?: boolean;
}

/** The status of one session moved from this computer. */
export interface OrgCloudMovedStatus {
  id: string;
  turnState: OrgCloudTurnState;
  queued: number;
}

/** The Cloud group's list: sessions not in this computer's index, and how many of the others are the ones moved from here. */
export type OrgCloudSessionsResult = OrgRemoteResult<{
  sessions: OrgCloudSessionSummary[];
  movedCount: number;
  /** The status of the sessions moved from this computer, for the badge on their rows in Threads. */
  moved: OrgCloudMovedStatus[];
}>;

export type OrgRemoteResult<T> =
  | ({ success: true } & T)
  | { success: false; error: OrgRemoteSessionError };

/** Why a run could not be opened as a local chat; the app then shows the run's read-only view instead. */
export type OrgRunChatError =
  | "disabled"
  | "not-signed-in"
  | "unauthorized"
  | "unsupported"
  | "invalid-request"
  | "not-found"
  | "no-transcript"
  | "too-large"
  | "unreachable"
  | "unavailable";

export interface OrgRunChatOpenOptions {
  /** Switch the app to the local copy (the default); `false` only imports or finds it. */
  show?: boolean;
}

/** A run opened as a local session: a copy of the run's own conversation, with its subagents as child sessions. Sending continues the copy; the run is never changed. */
export type OrgRunChatResult =
  | { success: true; sessionId: string; reused: boolean }
  | { success: false; error: OrgRunChatError };

/** A Brain or memory result inside a session whose audience is wider than `team` can read, so a teammate may not see it. */
export interface OrgShareRestrictedItem {
  id: string;
  source: "brain" | "memory";
  tool: string;
  audience: string;
  label: string;
}

export interface OrgSessionSharePreview {
  title: string;
  orgWorkspaceId: string;
  messageCount: number;
  /** The data-label high-water mark the envelope will carry. */
  label: "team" | "restricted";
  restrictedItems: OrgShareRestrictedItem[];
  /** The session is already waiting in the retry outbox. */
  queued: boolean;
}

export type OrgSessionSharePreviewResult =
  | ({ success: true } & OrgSessionSharePreview)
  | { success: false; error: string };

export type OrgSessionShareResult =
  | { success: true; state: "uploaded" | "queued"; messageCount: number }
  /** `uploaded`: the session record reached the organization before the upload failed. */
  | { success: false; error: string; uploaded?: true };

// ── Organization @mentions (flag org.mentions) ───────────────────────────────

/** Roles an @mention can grant. `owner` is never grantable. */
export type OrgMentionRole = "viewer" | "collaborator" | "driver";

export interface OrgDirectoryEntry {
  /** User principal, for example `user:ada`. */
  principal: string;
  displayName: string;
  email?: string;
}

export type OrgDirectorySearchResult =
  | { success: true; entries: OrgDirectoryEntry[] }
  | { success: false; error: string };

export interface OrgMentionRequest {
  sessionId: string;
  principal: string;
  role: OrgMentionRole;
  /** The owner saw the items the person may not be able to read and still wants to share. */
  acknowledgeRestricted?: boolean;
}

/** A person tagged in the message being sent; main tells the model about them on that turn. */
export interface OrgMentionNote {
  displayName: string;
  email?: string;
  role: OrgMentionRole;
  /** `granting`: the grant runs now; `waiting`: it waits for an organization workspace to be picked. */
  state: "granting" | "waiting";
}

export type OrgMentionResult =
  | { success: true; role: OrgMentionRole; notified: boolean }
  | { success: false; error: string; restrictedItems?: OrgShareRestrictedItem[] };

// ── Shared sessions (flag org.liveSessions) ──────────────────────────────────
// Each person's own Marshal answers their own messages; a shared session is a
// local session linked to an organization session whose transcript everyone appends to.

export type OrgSharedRole = "owner" | "driver" | "collaborator";

/** `active`: syncing. `revoked`: the caller lost write access. `gone`: the organization session no longer exists. `offline`: the last sync could not reach the organization. */
export type OrgSharedLinkStatus = "active" | "revoked" | "gone" | "offline";

export interface OrgSharedParticipant {
  principal: string;
  label: string;
}

export interface OrgSharedLink {
  orgSessionId: string;
  role: OrgSharedRole;
  ownerLabel: string;
  status: OrgSharedLinkStatus;
  participants: OrgSharedParticipant[];
}

export type OrgJoinSharedSessionError =
  /** This person's copy of the session belongs to a runtime other than the one active now. */
  | "other-runtime"
  /** The runtime active now cannot give its turns what others wrote, so it cannot take part. */
  | "runtime-unsupported"
  | "not-enabled"
  | "not-signed-in"
  | "forbidden"
  | "not-found"
  | "cloud-session"
  | "failed";

export interface OrgJoinSharedSessionRequest {
  orgSessionId: string;
}

export type OrgJoinSharedSessionResult =
  | { success: true; localSessionId: string }
  | { success: false; error: OrgJoinSharedSessionError };

export type OrgGetSharedLinkResult =
  | { success: true; link?: OrgSharedLink }
  | { success: false; error: "not-enabled" | "failed" };

export interface OrgSharedLinkSummary {
  localSessionId: string;
  orgSessionId: string;
  role: OrgSharedRole;
  /** `revoked` and `gone` links keep their local copy, but the organization row stays listed so the person can join again. */
  status: OrgSharedLinkStatus;
}

export type OrgListSharedLinksResult =
  | { success: true; links: OrgSharedLinkSummary[] }
  | { success: false; error: "not-enabled" | "failed" };

export interface OrgSharedLinkChangedEvent {
  localSessionId: string;
}

/**
 * A shared session's live state from its conversation room (flags `org.liveSessions` and `org.rooms`): who else
 * has it open or is composing, what each one's Marshal is doing (from host state, never text), and replies
 * others' Marshals are still writing. Held in memory only; nothing here is stored or given to a model.
 */
export interface OrgSharedLiveView {
  /** The session's room is joined and connected. */
  live: boolean;
  people: { principal: string; label: string; open: boolean; composing: boolean }[];
  agents: {
    principal: string;
    label: string;
    /** The team's cloud agent rather than a person's own Marshal. */
    cloud: boolean;
    step?: string;
    tasks?: { text: string; done: boolean }[];
    filesChanged?: number;
    subagents?: number;
  }[];
  streaming: { key: string; author: string; authorLabel: string; text: string; at?: string }[];
}

export type OrgGetSharedLiveResult =
  | { success: true; live?: OrgSharedLiveView }
  | { success: false; error: "not-enabled" };

export interface OrgSharedLiveChangedEvent {
  localSessionId: string;
  live: OrgSharedLiveView;
}

// ── Move to cloud / Continue here (flag org.cloudMove) ───────────────────────

export interface OrgCloudRunSummary {
  id: string;
  status: "starting" | "running" | "released" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Why the run failed: `lease-forced`, `lease-expired` or `lease-revoked`. */
  error?: string;
  /** A human link to follow the run. */
  link?: string;
}

export interface OrgCloudMoveStatus {
  /** `cloud` while the organization's cloud drives the session and it is read-only here. */
  placement: "local" | "cloud";
  run?: OrgCloudRunSummary;
  /** The session is locked here but the organization is unreachable (feature off, signed out, another org): only release is possible. */
  releaseOnly?: boolean;
  /** Names this move, so what was cached for an earlier move of the session is not shown for this one. */
  moveId?: string;
}

export type OrgCloudMoveStatusResult =
  | ({ success: true } & OrgCloudMoveStatus)
  | { success: false; error: string };

/** What the person chose on the placement preview (flag `org.placement`). */
export interface OrgPlacementChoice {
  /** `local-only`: move the conversation only; the files stay on this computer and the cloud has no tree. Default `git` once a placement is sent; a request with no placement at all moves the conversation only. */
  mode?: "git" | "local-only";
  /** Carry changed tracked files and unpushed commits; leave untracked files here. Needed when the untracked budget is exceeded. */
  trackedOnly?: boolean;
  /** Repo-relative untracked paths or folders to leave out. */
  excludePaths?: string[];
  /** `after-turn`: wait for the running turn to end, then move. Default `now`: stop the turn at a safe point. */
  when?: "now" | "after-turn";
}

export interface OrgPlacementPreviewRequest {
  sessionId: string;
  trackedOnly?: boolean;
  excludePaths?: string[];
}

export interface OrgPlacementPreview {
  repo: string;
  branch?: string;
  baseBranch?: string;
  localCommits: number;
  tracked: number;
  trackedBytes: number;
  untracked: number;
  untrackedBytes: number;
  /** Untracked files that stay here, with why: `secret`, `embedded-repo`, `unreadable`, `excluded-by-user`, `over-budget`. At most 200. */
  skipped: Array<{ path: string; why: string }>;
  skippedTotal: number;
  /** Anything in the way of carrying the files; the move then needs `mode: "local-only"` or a change here. */
  refusals: Array<{
    code: string;
    message: string;
    paths?: string[];
    rules?: string[];
    trackedOnlyHelps?: boolean;
  }>;
  trackedOnly: boolean;
  overBudget?: { files: number; bytes: number };
  maxBundleBytes: number;
  unavailableTools: Array<{ name: string; why: string }>;
}

export type OrgPlacementPreviewResult =
  | { success: true; preview: OrgPlacementPreview }
  /** `no-git-work`: this session has no git work the cloud could take, so a move carries the conversation only; `reason` is the code and `message` the sentence. */
  | { success: false; error: string; reason?: string; message?: string };

export interface OrgMoveToCloudRequest {
  sessionId: string;
  /** What the cloud run should do first. */
  instruction?: string;
  /** Flag `org.placement`: what the person chose on the preview. Ignored with the flag off. */
  placement?: OrgPlacementChoice;
  /** A Slack channel id from `listSlackDestinations`; omitted for the direct message. Owner only. */
  slackDestination?: string;
}

export interface OrgSlackDestination {
  kind: "dm" | "channel";
  /** The channel id; null for the direct message. */
  id: string | null;
  name: string;
  /** `channel`: everyone in the channel will read the agent's answers. */
  visibility: "private" | "channel";
}

export interface OrgSlackDestinationsRequest {
  query?: string;
  cursor?: string;
  limit?: number;
  /** The session being moved, so the server can tell an owner from a driver. */
  sessionId?: string;
}

export type OrgSlackDestinationsResult =
  | {
      success: true;
      destinations: OrgSlackDestination[];
      nextCursor?: string;
      /** Slack's channel list was cut, so some channels may be missing. */
      truncated: boolean;
    }
  /** `unavailable`: the route is off for this organization, so the picker stays hidden. */
  | { success: false; error: string };

export type OrgMoveToCloudResult =
  | { success: true; run: OrgCloudRunSummary }
  /** `uploaded`: the session reached the organization (owner only) before the move failed. */
  | { success: false; error: string; uploaded?: true; orgCopyUpdated?: true };

/** Why a local session could not be rebuilt from a cloud session's native state. */
export type CreateFromNativeStateError =
  | "already-local"
  | "unsupported-format"
  | "runtime-unavailable"
  | "invalid-state"
  | "state-too-large"
  | "workspace-unavailable"
  | "start-failed";

export interface OrgForkSessionRequest {
  /** The organization session to fork. */
  sessionId: string;
}

export type OrgForkSessionError =
  | "disabled"
  | "not-signed-in"
  | "unauthorized"
  | "unsupported"
  | "forbidden"
  | "not-found"
  /** The session has no completed turn to fork from yet. */
  | "no-checkpoint"
  | "envelope-missing"
  | "envelope-mismatch"
  | "envelope-invalid"
  /** The local runtime cannot import the session's state (another runtime wrote it). */
  | "unsupported-runtime"
  /** This computer has no Claude runtime ready to run the forked session. */
  | "runtime-unavailable"
  /** The forked conversation is larger than this computer will import. */
  | "state-too-large"
  /** The forked session could not be written or started on this computer. */
  | "start-failed"
  | "unreachable"
  | "unavailable";

export type OrgForkSessionResult =
  | {
      success: true;
      /** The new local session. */
      sessionId: string;
      forkedFrom: { sessionId: string; messageCount: number; at: string };
      /** Always true in this version: the fork carries the conversation, not the files it changed. */
      codeNotIncluded: true;
    }
  | { success: false; error: OrgForkSessionError };

export interface OrgContinueHereRequest {
  sessionId: string;
  /** Owner only: take the lease from a running cloud host at once instead of asking it to stop. */
  force?: boolean;
  /** Restore from the older envelope after the app said the cloud's final state is missing. */
  acceptStale?: boolean;
  /** Restore although the app could not confirm the envelope is the cloud's final state. */
  acceptUnverified?: boolean;
}

/** A message this person wrote while the cloud held the session that the cloud never ran; Continue here hands it back so it can be sent from this computer. */
export interface OrgReturnedMessage {
  clientMsgId: string;
  text: string;
}

export type OrgContinueHereResult =
  | {
      success: true;
      verdict: "fresh" | "unverified" | "stale-accepted";
      reason?: string;
      returnedMessages?: OrgReturnedMessage[];
      /** Messages written here that never reached the cloud could not be read back from the local outbox. */
      unsentNotRecovered?: boolean;
    }
  /** `returnedMessages` can arrive with a failure too: the cloud gives them back when this computer takes the lease, whether or not the restore then works. */
  | { success: false; error: string; reason?: string; returnedMessages?: OrgReturnedMessage[] };

/** A local workspace folder a cloud session could continue in. */
export interface OrgFolderCandidate {
  name: string;
  path: string;
}

/** Continue here for a session the cloud holds that has no copy on this computer (flag org.cloudGroup). */
export interface OrgContinueCloudRequest extends OrgContinueHereRequest {
  /** A registered local workspace to continue in; must be one the organization workspace is linked to. */
  workspaceName?: string;
  /** A folder the person picked; used only when no single linked workspace exists. */
  repoPath?: string;
}

export type OrgContinueCloudResult =
  | Extract<OrgContinueHereResult, { success: true }>
  | (Extract<OrgContinueHereResult, { success: false }> & {
      /** With `needs-folder`: the local workspaces linked to the session's organization workspace (none or several). */
      folders?: OrgFolderCandidate[];
    });

// ── Remote mode: sending to a session the cloud holds (flag org.remoteMode) ──

export type OrgRemoteExecutorState = "none" | "queued" | "starting" | "running" | "hot" | "stalled";

export interface OrgRemoteExecutor {
  state: OrgRemoteExecutorState;
  hostLabel?: string;
  estimatedStartSeconds?: number;
  /** What runs the session: the organization's cloud, or the owner's desktop for a live session. Absent means the cloud. */
  hostKind?: "cloud" | "desktop";
}

/**
 * Why a message cannot go to a session the cloud does not hold: the person only views it, the owner has not
 * turned live collaboration on, or the organization does not serve live sessions.
 */
export type OrgRemoteLiveRefusal = "viewer" | "not-live" | "live-unsupported" | "turn-budget-spent";

/**
 * Where one message stands. The first six come from the organization's inbox; `sending`,
 * `offline` and `failed` are local: the post is in flight, is waiting for a connection, or
 * was refused for good.
 */
export type OrgRemoteMessageStatus =
  | "sending"
  | "offline"
  | "failed"
  | "queued"
  | "claimed"
  | "done"
  | "cancelled"
  | "held"
  | "rejected";

export interface OrgRemoteMessage {
  /** The id the inbox gave it; absent while it only exists in the local outbox. */
  id?: string;
  clientMsgId: string;
  text: string;
  status: OrgRemoteMessageStatus;
  /** Written by this person; the rest are other people's messages the owner can run. */
  mine: boolean;
  /** Who wrote someone else's message. */
  authorLabel?: string;
  /** The author's role when the message was written, for a message that is not yours. */
  roleLabel?: string;
  /** Present on a comment: a note for the owner that never runs. */
  kind?: "comment";
  source: "desktop" | "slack" | "web" | "api";
  at: string;
  /** How many queued or claimed messages run before this one. */
  position?: number;
  /** Why a `failed` message was refused. */
  error?: string;
}

export interface OrgRemoteInbox {
  executor: OrgRemoteExecutor;
  messages: OrgRemoteMessage[];
  /** The organization could not be reached; `messages` holds only what is waiting in the local outbox. */
  offline?: boolean;
}

export interface OrgSendRemoteMessageRequest {
  sessionId: string;
  text: string;
}

export type OrgPostCommentResult = { success: true } | { success: false; error: string };

export type OrgSendRemoteMessageResult =
  | { success: true; message: OrgRemoteMessage }
  | { success: false; error: string };

export type OrgRemoteInboxResult =
  | ({ success: true } & OrgRemoteInbox)
  | { success: false; error: string };

/** What the cloud wrote to a held session since the move: the newest messages, tool steps included. */
export interface OrgHeldTranscript {
  messages: OrgRemoteTranscriptMessage[];
  /** Messages the cloud wrote since the move, including any left out of `messages` to bound the answer. */
  total: number;
  /** True while a long transcript is still being read: later polls carry on, and newer messages appear when it catches up. */
  truncated: boolean;
}

export type OrgHeldTranscriptResult =
  | ({ success: true } & OrgHeldTranscript)
  | { success: false; error: string };

/** Whether the main process follows a session's change feed for the renderer; `live` is true while real change events arrive. */
export type OrgSessionWatchResult =
  | { success: true; live: boolean }
  | { success: false; error: string };

/** What the main process tells the renderer about a followed session: `live` is its current feed state, `changed` is true when a real change event arrived and the session should be read again. */
export interface OrgSessionChange {
  sessionId: string;
  live: boolean;
  changed: boolean;
}

export interface OrgRemoteMessageRef {
  sessionId: string;
  clientMsgId: string;
  /** The inbox id; absent for a message that is still in the local outbox. */
  messageId?: string;
}

/** `text` is the cancelled message's text, so the composer can take it back. */
export type OrgRemoteMessageActionResult =
  | { success: true; text?: string }
  | { success: false; error: string };
