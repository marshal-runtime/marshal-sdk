// Extract of zygstinct apps/agent-server/src/nudges/turn.ts at 7110e58c8: only OperatorNudgeTurn.
/** What a nudge turn knows beyond the messages: the operator's words, who they are, and the members they may mean (by name, never by id). */
export interface OperatorNudgeTurn {
  /** The `/nudge` text with the command removed. */
  instruction: string;
  operatorName: string;
  members: { name: string }[];
}
