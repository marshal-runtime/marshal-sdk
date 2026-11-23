import type { LiveMessage } from "../live-sends.js";
import type { Logger } from "../logger.js";
import { replyPartsCount, replyPartsOf, type ReplyParts } from "../reply-parts.js";
import type { ConversationKey } from "../store.js";
import type { Outbox } from "./outbox.js";

/**
 * One turn of a routine or extension session whose outbox parts the engine read while it ran (ExtensionRoutineEngine, `runSends`). Every engine session speaks
 * the same way (Omer R151, "routines must go through outbox too. no exception"): its marley.outbox.* calls queue in its own send folder on the brand VM, the
 * engine reads that folder every few seconds and once when the turn ends, and each new batch becomes outbox material of the run's home conversation carrying
 * the run's typed identity (`runId`, the session id). The outbox agent decides what reaches the person; nothing is read after the run to be delivered.
 * - `run`: a run of a routine (a scheduled report, a notice, the Meta analysis, a server-fired check). `delivery` is the routine record as the run started.
 * - `rework`: a turn of a finished run that the outbox sent back (`reworkRun`); its words replace the held piece.
 * - `gated`: an awaited run (free time, the store check, dream); its home is the conversation the gate named.
 */
export interface RunSendsTurn {
  brandId: string;
  routineId: string;
  /** The run's Marshal session: the material's `runId`. */
  sessionId: string;
  /** The send folder this turn wrote (the session id for a run, `<session>-rw<n>` for a rework turn). */
  turnId: string;
  home: ConversationKey;
  kind: "run" | "rework" | "gated";
  delivery?: { revision: number; memberId: string };
  /** A run the inspector fired for a test chain: nothing it writes reaches anyone. */
  testSlot?: string;
}

/** Who the run's words are for, decided by the server from its own records at the time of the batch (SD01/SD05): never from run output. */
export type RunRecipient = { memberId: string } | { withheld: string };

export interface RunSendsDeps {
  outbox: () => Pick<Outbox, "sentBackToRun"> | undefined;
  /** The authority check of a `run` or `gated` batch: the routine still enabled and authorized (as it started), or the home DM's own person. */
  recipient: (turn: RunSendsTurn) => Promise<RunRecipient>;
  /** The router's server-words path (Router.deliverServerReply): outbox material with `writer.runId`, under the reply gate. */
  deliver: (key: ConversationKey, memberId: string, parts: ReplyParts, deliveryId: string, pendingIds: readonly string[], writer: { runId: string }) => Promise<{ sent: number; withheld: string | null; dropped?: string }>;
  logger: Logger;
}

/**
 * The server's side of `runSends`: one batch of a turn's parts to the outbox. Returns how many parts it handed over. The delivery id derives from the turn and the
 * batch's first part, so a batch read again after a failed hand-over is the same material (the outbox keys it), never a second piece.
 */
export function runSendsTo(deps: RunSendsDeps): (turn: RunSendsTurn, messages: readonly LiveMessage[]) => Promise<number> {
  return async (turn, messages) => {
    const fields = { brandId: turn.brandId, routineId: turn.routineId, runId: turn.sessionId, turnId: turn.turnId, kind: turn.kind, parts: messages.length };
    if (messages.length === 0) return 0;
    if (turn.testSlot) { deps.logger.info("routine.run_sends_test", fields); return 0; }
    const parts = replyPartsOf(messages);
    if (replyPartsCount(parts) === 0) return 0;
    const first = messages[0]!.id;
    if (turn.kind === "rework") {
      // The rework turn writes for the person the sent-back piece was for, checked with the same messages, so its words replace that piece (Outbox.buffer).
      const target = deps.outbox()?.sentBackToRun(turn.home, turn.sessionId) ?? null;
      if (!target || target.memberId === null) { deps.logger.info("routine.rework_unplaced", fields); return 0; }
      const result = await deps.deliver(turn.home, target.memberId, parts, `routine-rework:${turn.turnId}:${first}`, target.pendingIds, { runId: turn.sessionId });
      deps.logger.info("routine.rework_delivered", { ...fields, sent: result.sent, withheld: result.withheld });
      return messages.length;
    }
    const recipient = await deps.recipient(turn);
    if ("withheld" in recipient) { deps.logger.info("routine.run_sends_withheld", { ...fields, reason: recipient.withheld }); return 0; }
    const result = await deps.deliver(turn.home, recipient.memberId, parts, `routine-run:${turn.turnId}:${first}`, [], { runId: turn.sessionId });
    deps.logger.info("routine.run_sends_outboxed", { ...fields, sent: result.sent, withheld: result.withheld, ...(result.dropped ? { dropped: result.dropped } : {}) });
    return messages.length;
  };
}
