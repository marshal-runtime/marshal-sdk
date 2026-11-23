// Extract of zygstinct apps/agent-server/src/tasks/schema.ts at 7110e58c8: only ListTasksQuery, Task, BRIEF_MAX, OPEN_STATUSES, SUMMARY_MAX, TITLE_MAX, newTaskId, TaskRow.
import { randomBytes } from "node:crypto";
import { type TaskOrigin } from "./origin-shape.js";

export const TASK_STATUSES = ["queued", "working", "done", "failed", "cancelled"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const OPEN_STATUSES: readonly TaskStatus[] = ["queued", "working"];

export const TITLE_MAX = 120;

export const BRIEF_MAX = 2000;

export const SUMMARY_MAX = 1000;

/**
 * What became of a finished task's result: `outboxed` (its typed result entered the conversation's outbox as material, and the composer tells it; there is no
 * relay turn), `dropped` (nobody to tell: the outbox does not serve the brand, nobody wrote in the chat, or an operator's task), `parent` (a worker's sub-task:
 * its result goes back to the parent worker, never to the chat) or `covered` (the worker already said it through the outbox and owes no file). `sent` and
 * `withheld` are read on rows stored by the relay turn this replaced.
 */
export type RelayState = "outboxed" | "sent" | "withheld" | "dropped" | "parent" | "covered";

export interface Task {
  taskId: string;
  brandId: string;
  channel: string;
  conversationId: string;
  memberId: string | null;
  /** The conversation's kind as the ledger recorded it at creation (a group's task has no member). */
  conversationKind?: "dm" | "group";
  originTurnId: string;
  title: string;
  brief: string;
  status: TaskStatus;
  resultSummary: string | null;
  resultRef: string | null;
  artifactIds: string[];
  entityRefs: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  hostId: string;
  attempt: number;
  claimId: string | null;
  cancelRequested: boolean;
  error: string | null;
  costUsd: number | null;
  sdkSessionId: string | null;
  workerTurnId: string | null;
  relayState: RelayState | null;
  relayedAt: number | null;
  /** What the originating turn froze (tasks/origin.ts); null for a row from before it, which carries nothing owner-only. */
  origin: TaskOrigin | null;
  /** The front session row and live turn that spawned this child (null for a row from before child sessions and for an inspector task). */
  parentSessionId: string | null;
  parentTurnId: string | null;
  /** `spawn_subagent` (a front turn's intent), `handoff` (the server's hard stop or the retired directive) or `inspector` (an operator's New task). */
  spawnedVia: SpawnedVia | null;
  /** The live human turn that authorized the work (the spawning turn); approval-bound rules (AU03, AU06, SB14, SD14, SD17) read this, never the brief. */
  authorizingTurnId: string | null;
  /** Recall ids the brief builds on: stored only when the spawner could check them against the viewer (the router does not yet, so today always empty). */
  recallIds: string[];
  /** The task a re-run repeats (an inspector re-run); null otherwise. */
  parentTaskId: string | null;
  /** The spawning turn's SDK session and its last message: the worker forks the conversation there (tasks/fork.ts). Null: the worker starts from the brief alone. */
  forkSessionId: string | null;
  forkMessageUuid: string | null;
  /** A worker sub-task (`spawnedVia` worker): when its parent's run read its outcome; null until then. */
  parentReadAt: number | null;
}

/** `worker`: a sub-task a background worker split off; its parent is `parentTaskId` and its result goes back to that worker. */
export const SPAWNED_VIA = ["spawn_subagent", "handoff", "inspector", "worker"] as const;

export type SpawnedVia = (typeof SPAWNED_VIA)[number];

export interface TaskRow {
  task_id: string;
  brand_id: string;
  channel: string;
  conversation_id: string;
  member_id: string | null;
  origin_turn_id: string;
  title: string;
  brief: string;
  status: string;
  result_summary: string | null;
  result_ref: string | null;
  artifact_ids: string;
  entity_refs: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  kind: string;
  host_id: string;
  attempt: number;
  claim_id: string | null;
  claimed_at: number | null;
  cancel_requested: number;
  error: string | null;
  cost_usd: number | null;
  sdk_session_id: string | null;
  worker_turn_id: string | null;
  relay_state: string | null;
  relayed_at: number | null;
  origin_json: string | null;
  parent_session_id: string | null;
  parent_turn_id: string | null;
  spawned_via: string | null;
  authorizing_turn_id: string | null;
  recall_ids_json: string | null;
  parent_task_id: string | null;
  fork_session_id?: string | null;
  fork_message_uuid?: string | null;
  parent_read_at?: number | null;
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `tsk_` plus a 26-character ULID: 48 bits of time then 80 random bits, Crockford base32, so ids sort by creation time. */
export function newTaskId(now: number = Date.now(), random: Buffer = randomBytes(10)): string {
  let time = "";
  let remaining = Math.floor(now);
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[remaining % 32]! + time;
    remaining = Math.floor(remaining / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let tail = "";
  for (let i = 0; i < 16; i += 1) {
    tail = ALPHABET[Number(bits & 31n)]! + tail;
    bits >>= 5n;
  }
  return `tsk_${time}${tail}`;
}

export interface ListTasksQuery {
  brandId: string;
  conversationId?: string;
  channel?: string;
  /** Epoch ms: only tasks created or updated at or after it. */
  since?: number;
  limit: number;
}
