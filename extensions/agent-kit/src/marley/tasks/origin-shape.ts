// Extract of zygstinct apps/agent-server/src/tasks/origin-shape.ts at 7110e58c8: only TaskOrigin.
import type { PixelPolicy } from "../pixel-audit.js";
import type { HandoffChat } from "./handoff.js";

/**
 * What a task keeps of the turn that started it, written by the server from that turn's fresh directory read (never from the brief or
 * the directive) and read back when the worker runs: whether the asker was the brand owner in their own direct chat, the pixel policy of
 * that turn (website host included, SB21) and the creative-quadrants host line. A task without it (a row from before this column)
 * carries nothing owner-only: every owner run, the pixel audit and the quadrants fail closed. This file holds only the shape and its
 * strict reader, so the ledger can import it without the directory and pixel modules (tasks/origin.ts builds one).
 */
export interface TaskOrigin {
  v: 1;
  owner: boolean;
  pixel: PixelPolicy | null;
  quadrants: string | null;
  /** The person's own message(s) of that turn and the last few chat lines of the same conversation, for the worker (tasks/handoff.ts). Absent on a task from before it. */
  chat?: HandoffChat | null;
  /** The chain generation this task's chain started at (tasks/chain.ts): set on a wakeup's task, absent (0) on work a person asked for. */
  chain?: number;
  /**
   * The id of the person's own message that asked for this work (the newest message of theirs the originating turn answered that a reply can quote).
   * The outbox quotes it when the task's result arrives, so the answer sits under its question. Absent on a task from before it or one nobody asked for.
   */
  asked?: string;
}
