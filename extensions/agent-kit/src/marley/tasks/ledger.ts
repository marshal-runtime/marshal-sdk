// Extract of zygstinct apps/agent-server/src/tasks/ledger.ts at 7110e58c8: only TaskLedger:declare.
import type Database from "better-sqlite3";
import { type ListTasksQuery, type RelayState, type SpawnedVia, type Task, type TaskStatus } from "./schema.js";
import type { TaskOrigin } from "./origin-shape.js";
import type { ForkPoint } from "../types.js";

/**
 * A safety cap on open (queued + working) tasks of one conversation, not the running cap: the manager's pump runs `perConversation` at a time and
 * leaves the rest queued until one finishes (Omer R248, 2026-11-18). At 3 a fourth ask was refused and the person was told "I'll take this one",
 * with nothing stored.
 */
export const MAX_OPEN_PER_CONVERSATION = 10;

export interface NewTask {
  brandId: string;
  channel: string;
  conversationId: string;
  memberId: string | null;
  originTurnId: string;
  hostId: string;
  title: string;
  brief: string;
  /** The originating turn's frozen owner flag, pixel policy and quadrants line (tasks/origin.ts). */
  origin?: TaskOrigin;
  /** Set by a spawn intent (spawnTaskId); absent otherwise and then generated. An existing id returns that row, so a replay creates nothing twice. */
  taskId?: string;
  parentSessionId?: string | null;
  parentTurnId?: string | null;
  spawnedVia?: SpawnedVia;
  authorizingTurnId?: string | null;
  recallIds?: string[];
  parentTaskId?: string | null;
  /** Where the worker forks the spawning conversation (tasks/fork.ts); absent, it starts from the brief. */
  fork?: ForkPoint | null;
  now: number;
}

export interface FinishRecord {
  summary: string;
  resultJson: string;
  artifactIds: string[];
  entityRefs: string[];
  costUsd: number | null;
  sdkSessionId: string | null;
}

/**
 * Who is asking: the speaker of a direct chat (their member) or a group, with the conversation the turn runs in. `conversation` is an eval
 * conversation (MLY-353, the server's `eval_conversations` mark): it sees only the tasks of that one conversation.
 */
/**
 * Who sees which tasks. `brand`: every task of the brand from every chat, for a turn the caller admitted from a FRESH directory read (an active member's own
 * direct chat, its workers and routine turns; cross-chat order, 2026-11-12, D-CROSS-CHAT). `dm`: the tasks of one member across that member's chats (a turn
 * without that admission). `conversation`: one conversation's own (an eval chat, MLY-353).
 */
export type TaskViewer = { kind: "brand"; key: { brandId: string; channel: string; conversationId: string } } | { kind: "dm"; memberId: string | undefined; key: { brandId: string; channel: string; conversationId: string } } | { kind: "conversation"; key: { brandId: string; channel: string; conversationId: string } };

export type TaskListener = (task: Task) => void;

/**
 * The server's task ledger. Every state change is one compare-and-set statement on the status (and the claim), so two writers (a
 * worker finishing and a cancel, a restart and a late finish) cannot both win. Authority fields (brand, channel, conversation,
 * member, kind, host) are written once at creation from the originating turn and never updated.
 */
export declare class TaskLedger {
  private readonly listeners;
  private readonly createdListeners;
  private readonly startedListeners;
  private readonly db;
  constructor(db: Database.Database);
  onFinished(listener: TaskListener): void;
  /** Called once for each task right after it is created (queued). */
onCreated(listener: TaskListener): void;
  /** Called each time a worker claims a task (queued to working, once per attempt). */
onStarted(listener: TaskListener): void;
  private emit;
  get(taskId: string): Task | null;
  /** A task of this exact conversation, or null: a model-named id is only ever resolved under the turn's own key. */
getIn(taskId: string, scope: { brandId: string; channel: string; conversationId: string }): Task | null;
  list(query: ListTasksQuery): Task[];
  /**
   * The tasks one viewer may see, newest first: a `brand` viewer every task of the brand from every chat (owner's 12 Nov order); a `dm` viewer the tasks of its
   * own member across that member's conversations, and nothing without a member; a `conversation` viewer its own conversation's. Never another brand's. `listed` is the
   * open tasks, those created since `since`, and this conversation's own, capped; the counts cover everything the viewer may see.
   * An eval conversation (`conversation`) sees only its own tasks, and a direct chat never sees an eval conversation's tasks (MLY-353; an eval
   * conversation is always a test-chat DM, so a group's own-conversation clause already leaves them out).
   */
visibleTo(viewer: TaskViewer, query: { since: number; limit: number }): { listed: Task[]; sinceCount: number; sinceByStatus: Partial<Record<TaskStatus, number>>; earlierCount: number };
  openIn(scope: { brandId: string; channel: string; conversationId: string }): Task[];
  /** Creates a queued task, or returns "limit" when the conversation already has MAX_OPEN_PER_CONVERSATION open ones. One transaction, so two turns cannot both slip under the cap. */
create(input: NewTask): Task | "limit";
  /** queued -> working with a fresh claim; spends one attempt. Null when someone else got it or it is no longer queued. */
claim(taskId: string, now: number): { task: Task; claimId: string } | null;
  /** The brand's sandbox host as read for this attempt; only the claim holder writes it. */
rehost(taskId: string, claimId: string, hostId: string, now: number): boolean;
  recordSession(taskId: string, claimId: string, sdkSessionId: string): void;
  /** working -> done. False when the claim no longer holds (cancelled, requeued, recovered): then nothing is stored. */
finish(taskId: string, claimId: string, record: FinishRecord, now: number): boolean;
  /** working -> failed with a bounded reason. */
fail(taskId: string, claimId: string, reason: string, now: number, costUsd?: number | null): boolean;
  /** queued or working -> cancelled, from the member (through the front) or the server. A cancelled task relays nothing. */
cancel(taskId: string, reason: string, now: number): Task | null;
  private addedCost;
  /**
   * working -> queued, parked: the worker split work into sub-tasks and waits for them. The run's cost and session are kept, the attempt is
   * not spent, and the manager starts it again (resuming that session with the sub-tasks' outcomes) only once every sub-task has finished.
   */
park(taskId: string, claimId: string, record: { costUsd: number | null; sdkSessionId: string | null }, now: number): boolean;
  /** A worker's own sub-tasks, oldest first. */
childrenOf(taskId: string): Task[];
  /** The parent's run read these sub-tasks' outcomes: they are never given to it again. */
markParentRead(taskIds: string[], now: number): void;
  /** working -> queued without spending the attempt: a hold, a drain or a shutdown interrupted the worker. */
requeue(taskId: string, claimId: string, now: number): boolean;
  /** After a restart: a row left `working` has no live worker. It is queued again, or failed when it has used its attempts. */
recoverWorking(now: number): { requeued: Task[]; failed: Task[] };
  queued(limit?: any): Task[];
  working(): Task[];
  /** Finished tasks whose result was never told (a crash between the finish and the event, or a turn that has not run yet). */
unrelayed(): Task[];
  /** The one place a task's result is marked handed over (or settled without one): once, and only for a finished task. */
markRelayed(taskId: string, state: RelayState, now: number): boolean;
  result(taskId: string): string | null;
}
