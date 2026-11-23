// Extract of zygstinct apps/agent-server/src/stack-confirm.ts at 7110e58c8: only ConfirmJudge.
import type { ConversationKey } from "./store.js";

/** Runs the judgement; resolves to the raw structured answer (validated by the caller). */
export type ConfirmJudge = (input: { key: ConversationKey; system: string; prompt: string }, signal: AbortSignal) => Promise<unknown>;
