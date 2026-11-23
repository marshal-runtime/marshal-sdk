import type { OperatorNudgeTurn } from "./nudges/turn.js";
import type { TaskOrigin } from "./tasks/origin-shape.js";
import type { RanSummary } from "./tasks/ran.js";
import type { ConversationKind } from "@zygstinct/shared";

import type { ConversationKey, ConversationRecord, StoredMessage } from "./store.js";
import type { Viewer } from "./memory.js";
import type { ReplyParts } from "./reply-parts.js";

export const NO_REPLY = "NO_REPLY";

/** Recorded on a skipped turn (turns.reason) when the pool holds no usable credential for the brand. */
export const POOL_NOT_CONFIGURED = "claude pool not configured";

/** The model pool cannot serve the turn; `reason` says why (not configured, or every member resting) and is recorded on the skipped turn. */
export class PoolNotConfiguredError extends Error {
  constructor(readonly reason: string = POOL_NOT_CONFIGURED) {
    super(reason);
  }
}

/**
 * The model provider answered the run's latest model call with an HTTP error, and the run then failed (MLY-524). Typed from what the
 * provider returned: the HTTP status and the `error.type` field of its JSON body (null when the body has none), plus its request id
 * header. Nothing is read out of the provider's message text, so a usage limit and any other 400 `invalid_request_error` look alike here.
 */
export class ProviderRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly providerErrorType: string | null,
    readonly providerRequestId: string | null,
  ) {
    super(`model provider refused the call (HTTP ${status}, ${providerErrorType ?? "no error type"})`);
    this.name = "ProviderRefusedError";
  }
}

export class TurnAbortedError extends Error {
  constructor() {
    super("turn aborted");
  }
}

export interface TurnRequest {
  /** Fixed-purpose nonfinancial evidence; never resumes a normal tool-enabled session. */
  onboarding?: string;
  onboardingConsent?: boolean;
  /**
   * Set when Marley greeted this owner first (the signup greeting): `sent`, the first reply answers it without a second
   * hello; `uncertain`, the greeting may have arrived (its outcome is unknown), so a one-line hello at most.
   */
  onboardingGreeting?: "sent" | "uncertain";
  /** Which voice policy the first reply follows (first-reply-prompt.ts); absent means the default. */
  onboardingVoice?: "V" | "T" | "off";
  /** First contact for a brand on ORGANISM_FIRST_CONTACT_BRANDS (first-contact.ts): the first reply carries one finding of the first-look record and one question, no voice. */
  onboardingFirstContact?: boolean;
  turnId: string;
  key: ConversationKey;
  /** The sandbox host the brand lives on. */
  hostId: string;
  title: string | null;
  session: ConversationRecord;
  messages: StoredMessage[];
  viewer: Viewer;
  /** Free text for a brand control turn; set instead of `messages`. */
  controlInstruction?: string;
  /** Set by the router, never from model or VM input, only on a turn whose one message is a platform maintainer's `/nudge` (nudges/turn.ts): the turn gets the operator_nudge block and only read tools and zs.nudge.propose. */
  operatorNudge?: OperatorNudgeTurn;
  /** Set by the server, never from model or VM input, only on the scheduled daily owner-report turn after its routine, owner and DM were rechecked (routines/vm-turns.ts). */
  ownerReport?: { memberId: string };
  /**
   * Set by the server, never from model or VM input, only on a scheduled or inspector-test UA review turn (routines/vm-turns.ts): the turn is a server-marked
   * run for this viewer, so it gets the per-turn data grant like `ownerReport` (data-grant.ts) without the brief build's time limit (MLY-543).
   */
  dataRun?: { memberId: string };
  /** Set by the server (routines/vm-turns.ts) on a turn that runs a linked routine's fire, never from model or VM input: the turn runs on the routine role (the @marley/chat routine profile). */
  routine?: true;
  signal: AbortSignal;
  /** Milliseconds the router spent before the turn runner started, for the `turn.start.timing` log: rollover, session row and files; the runtime-feature probe. */
  startTiming?: { setupMs: number; probeMs: number };
  /** Settles when the router's live-send preparation (running beside the turn's own setup) is done; the runner awaits it right before the model starts, and a rejection fails the turn. */
  beforeModel?: () => Promise<void>;
  /** Called as soon as the SDK reports its session id, so a crash can resume it. */
  onSession(sessionId: string): void;
  /** Called with the untrusted data-query log entries of a turn that failed or was aborted (a finished turn returns them in its result). */
  onDataQueries?(entries: unknown[]): void;
  /**
   * Called when a tool call of the turn's model starts (allowed by the gate) and when it ends (succeeded or failed), by tool use id: the router
   * never hands off a turn while a call is open, short of a stalled-call limit, and keeps a turn that is still working alive past its deadline.
   * `sent` is true at the end of a send tool's call that succeeded (the typed tool name, as the SDK reported it): the tool has written its message.
   */
  onTool?(phase: "start" | "end", toolUseId: string, sent?: boolean): void;
  /** Set only for a front turn of a brand with background tasks on: the wall-clock moment after which it may use no tool but its reply tools (tasks/tool-gate.ts). */
  /** Set by the router, never from model or VM input, on an ungated scheduled wakeup of this DM member's own schedule (tasks/spawn.ts systemAuthority) when the VM takes host forks: the turn may start a follow-on task. */
  wakeSpawn?: boolean;
  /** Set by the router, never from model or VM input: the brand VM's runtime carries `outbox_put@1` (reply-protocol.ts), so the turn speaks through the outbox capabilities and its unsent final text goes to the outbox. Absent: the tags protocol. */
  replyTools?: boolean;
  /** Set by the router, never from model or VM input: the brand VM's runtime carries `living_state_tool@1` (reply-protocol.ts), so the turn keeps its living state with `state_set` calls and its final text is never searched for `<state>`. Absent: the directives. */
  stateTool?: boolean;
  /**
   * Set by the router, never from model or VM input, on a turn that may reach no person (free time and the relays of the tasks it started, free-time.ts):
   * the session lists no send or react tool, a hook denies them, and the server starts no live sends and no end notice for it.
   */
  sends?: "none";
  /**
   * Set by the router, only on a tools-protocol turn whose delivery the server owns (an owner report fire): reads what the model queued with the send tools this turn, as typed parts
   * (reply-parts.ts), after the turn ended. The routine layer decides from them whether anything is delivered; the model's final text is never searched for directives.
   */
  collectSends?(): Promise<import("./reply-parts.js").ReplyParts>;
  background?: { deadlineAt: number; /** Set by the front's tool gate at its first hand-off denial: later tools are denied too. */ handedOff?: boolean; /** Set by the router on every gated turn from the brand VM's runtime: true when it takes host forks (the hand-off is marshal.tool.forkSubagents), false when it does not (the hand-off is the `<task>` directive, as before). */ spawn?: boolean; /** False when the speaker may not start background work (tasks/spawn.ts spawnSpeaker; a pending tester in an inspector chat): the front prompt and gate say nothing continues after this turn, and no worker, directive or copy starts. Absent means a hand-off is possible. */ handoff?: false; /** Set by the router, never from model or VM input, on a decide-first turn the decision let answer (decide-first.ts decisionNote): server-written, shown to the front as a turn note. */ decision?: string };
}

/** `reason` is the sentence the run log shows; `code` is the closed code the routine events carry, set by the code that decided the outcome (never derived from the sentence). Only a success may have none. */
export type RunOutcome = { status: "success"; reason: string | null; code: string | null } | { status: "failed" | "skipped" | "not_ready"; reason: string | null; code: string };

export interface TurnResult {
  /** Untrusted, bounded VM outbox; only the fixed control-plane reducer may apply it. */
  controlIntents?: unknown[];
  /** The living-state writes the turn's `state_set` calls queued (state/living-state.ts splitStateToolIntents), already taken out of `controlIntents`. Set only on a stateTool turn. */
  stateWrites?: { section: "picture" | "numbers" | "threads" | "found"; mode: "replace" | "add"; text: string }[];
  /** The brand's sign-off, for the router to add to what goes out. */
  signOff?: string;
  /** Untrusted data-query log entries the VM wrote this turn; the server validates and stores them (query-log.ts). */
  dataQueries?: unknown[];
  /** The reply to send, or null when the agent chose not to answer. */
  reply: string | null;
  /** On a tools-protocol server-delivered turn: what the model sent with the send tools, typed. `reply` then only carries their words for logs and checks; delivery sends these parts. */
  replyParts?: ReplyParts;
  /**
   * The model's own final text when the server replaced `reply` with its own (a UA routine turn): read only for its living-state directives
   * (state/living-state.ts), never sent. Unset everywhere else, where the directives come from `reply`.
   */
  stateReply?: string | null;
  sessionId: string | null;
  contextTokens: number;
  costUsd: number | null;
  turns: number;
  durationMs: number;
  /** Short topic the agent noted for the activity log (never raw message text). */
  topic: string | null;
  outcome: string;
  /** How a scheduled routine turn ended, set by the code that decided it (routines/vm-turns.ts); the Routines page records it. */
  run?: RunOutcome;
  memoryHash: string | null;
  /** The model the turn ran on (the role's, or FRONT_MODEL for a front conversation turn). */
  model?: string;
  /** Where this turn's conversation ends in its SDK session: a task the turn spawns forks the conversation here (tasks/fork.ts). */
  forkPoint?: ForkPoint | null;
}

/** One message of a conversation's SDK session: the session id and the uuid of the last message a fork keeps. */
export interface ForkPoint {
  sessionId: string;
  messageUuid: string;
}

export interface SummaryRequest {
  key: ConversationKey;
  hostId: string;
  session: ConversationRecord;
  viewer: Viewer;
  signal: AbortSignal;
}

/** Runs agent turns. The Claude implementation and the test stubs share this interface. */
export interface TurnRunner {
  /** False while no Claude credentials are available (for the brand, when given: subscription members serve internal brands only). */
  ready(brandId?: string): boolean;
  /** Why no pool member can take a session for the brand right now (resting, over a cap), or null when one can. Asked before a turn starts. */
  unavailable?(brandId: string): Promise<string | null>;
  runTurn(request: TurnRequest): Promise<TurnResult>;
  /** Asks the old session for a summary of itself, used before a rollover. */
  summarize(request: SummaryRequest): Promise<string>;
  /** Runs one background task in its own session (no soul, no way to send). */
  runTask?(request: TaskRunRequest): Promise<TaskRunResult>;
  /** Releases anything kept alive between turns. */
  shutdown?(): Promise<void>;
}

/** One background worker run (tasks/manager.ts). Identity fields come from the frozen task row, never from the model. */
export interface TaskRunRequest {
  /** `<task id>:w<attempt>`: the worker's own turn id for its snapshot, query log and transcript. */
  turnId: string;
  taskId: string;
  title: string;
  brief: string;
  attempt: number;
  key: ConversationKey;
  hostId: string;
  viewer: Viewer;
  /** What the originating turn froze (tasks/origin.ts); null for a task from before it, which carries nothing owner-only. */
  origin: TaskOrigin | null;
  signal: AbortSignal;
  /** Called as soon as the SDK reports the worker's own session id. */
  onSession(sessionId: string): void;
  /** An inspector follow-up: the task's own earlier SDK session, restored on the VM and resumed (the same frozen origin and worker gates apply). */
  resumeSessionId?: string;
  followUp?: boolean;
  /** The spawning conversation's session and last message (tasks/fork.ts): the worker forks the conversation there instead of starting from the brief alone. Never with resumeSessionId. */
  fork?: ForkPoint | null;
  /** A parent worker resumed after its sub-tasks finished (with resumeSessionId): this text, holding their outcomes, is its next message instead of the task prompt. */
  continuation?: string;
  /** With resumeSessionId and fork: the worker was interrupted and continues its own session; when that session cannot be resumed the run starts from the brief at the fork point (task.resume_unavailable). */
  restarted?: boolean;
  /** The worker may split work into sub-tasks (it may fork): false at the deepest level allowed. */
  canSpawn?: boolean;
  /**
   * A run that only rewrites the task's answer (the result repair): no hands, no spawn and no browser are listed, and the gate refuses every write, so
   * it can change nothing the server must then reconcile (Astra F6). Whoever runs a repair sets it.
   */
  toolFree?: boolean;
  /** Set by the task manager, never from model or VM input: the worker's runtime carries `living_state_tool@1`, so it keeps the living state with `zs.state.set` calls and its text is never searched for `<state>`. */
  stateTool?: boolean;
}

export interface TaskRunResult {
  /** The worker's final text; the server reads only its `<result>` block. */
  text: string;
  sessionId: string | null;
  costUsd: number | null;
  /** What the worker ran, from the server's tool hook (tasks/ran.ts), not from its text. */
  ran?: RanSummary;
  /** The intents the worker wrote in its own outbox this run (untrusted: the manager validates them); spawns are the only kind it acts on. */
  intents?: unknown[];
  /** The memory saves the VM logged for this run (untrusted: the manager validates them and records them as the task's memory receipts). */
  saves?: unknown[];
  /** The last message of the worker's session: a sub-task forks it there. */
  lastMessageUuid?: string | null;
  /** On a stateTool run: the living-state writes its zs.state.set calls queued (splitStateToolIntents), already taken out of `intents`. */
  stateWrites?: { section: "picture" | "numbers" | "threads" | "found"; mode: "replace" | "add"; text: string }[];
  /** How many pieces of words the worker put in the outbox itself (outbox.put): its result's relay is then covered unless it owes a file. */
  outboxed?: number;
}

/** A composer run (claude.ts compose) stopped because a tool call was refused: by its gate, or as a browser capability, which no composer run may reach. */
export class ComposeToolRefusedError extends Error {
  constructor(readonly code: string, readonly tool: string) {
    super(`the composer's tool call was refused (${code})`);
    this.name = "ComposeToolRefusedError";
  }
}
