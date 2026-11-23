// Extract of zygstinct apps/agent-server/src/nudges/inspector.ts at 7110e58c8: only isInspectorNudgeConversation.
import type { ConversationKey } from "../store.js";

const NUDGE_CONVERSATION = /^insp-nudge-(main|[a-z0-9]{6,32})$/;

export const isInspectorNudgeConversationId = (conversationId: string): boolean => NUDGE_CONVERSATION.test(conversationId);

export const isInspectorNudgeConversation = (key: Pick<ConversationKey, "channel" | "conversationId">): boolean =>
  key.channel === "inspector" && isInspectorNudgeConversationId(key.conversationId);
