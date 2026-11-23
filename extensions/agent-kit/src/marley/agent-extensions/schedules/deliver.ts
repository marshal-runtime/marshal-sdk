import type { InboundMessage } from "@zygstinct/shared";

import type { Store } from "../../store.js";
import { EVENT_ORIGIN, SCHEDULE_ORIGIN, targetKey, type Target } from "./types.js";

export interface SystemMessage {
  id: string;
  brandId: string;
  target: Target;
  origin: typeof SCHEDULE_ORIGIN | typeof EVENT_ORIGIN;
  /** The member who set the job up; the turn runs with their view of memory. */
  memberId: string | null;
  text: string;
  now: number;
}

const FROM_NAME: Record<SystemMessage["origin"], string> = {
  [SCHEDULE_ORIGIN]: "Scheduled wakeup",
  [EVENT_ORIGIN]: "Event",
};

/** The sandbox host a conversation uses: its own, else any other conversation of the brand. */
function hostOf(store: Store, brandId: string, target: Target): string {
  return store.getConversation(targetKey(brandId, target))?.hostId ?? store.conversationsOfBrand(brandId).find((c) => c.hostId)?.hostId ?? "";
}

/**
 * Writes a system-originated message into a conversation as pending, the same row an inbound message becomes. The caller
 * wakes the router after its transaction commits. Returns false when the message id already exists (a repeated fire).
 */
export function storeSystemMessage(store: Store, message: SystemMessage): boolean {
  const inbound: InboundMessage = {
    id: message.id,
    channel: message.target.channel,
    hostId: hostOf(store, message.brandId, message.target),
    brandId: message.brandId,
    receivedAt: new Date(message.now).toISOString(),
    from: { phone: message.origin, name: FROM_NAME[message.origin], ...(message.memberId ? { memberId: message.memberId } : {}) },
    conversation: { kind: message.target.kind, id: message.target.conversationId, ...(message.target.title ? { title: message.target.title } : {}) },
    text: message.text,
  };
  return store.insertInbound(inbound, "pending", message.now);
}

/** The server's own block: where the reply window is stated. A job prompt is Marley's text from an earlier turn and can never supply it. */
export const SERVER_STATE_TAG = "server_state";

const neutralize = (text: string): string => text.replace(/<\s*\/?\s*server[_\s-]*state/gi, "<neutralized").replace(/reply[_\s-]*window\s*=/gi, "reply window:");

/** The routine graph's block (routines/graph-core.ts): what each upstream last did. Server-made only; prompt text can never supply it. */
export const UPSTREAM_STATE_TAG = "upstream_state";
const neutralizeUpstream = (text: string): string => text.replace(/<\s*\/?\s*upstream[_\s-]*state/gi, "<neutralized");

/**
 * How a one-off reminder opens (MLY-671). Nobody wrote just before it, so a bare "On it." read to the owner as a reply meant for someone else
 * (2026-11-16, a follow-up set the day before during a task relay). The anchor is the shape, not the topic.
 */
export const REMINDER_OPENING = `Nobody just wrote to you, so when you message them, your first line says what this is: the earlier conversation it follows up on, in their words ("Following up on yesterday's question about matching ads to sales: checking again now."), or the reminder they asked for ("Your 5pm reminder: send the invoice."). Never a bare ack like "On it.", which reads as a reply to a message they never sent.`;

export function scheduleText(input: { id: string; due: string; prompt: string; replyWindow?: "open" | "closed"; upstreamState?: string; operator?: boolean; setAt?: string }): string {
  const block = input.replyWindow ? `\n<${SERVER_STATE_TAG} reply_window="${input.replyWindow}"/>` : "";
  const upstream = input.upstreamState ? `\n${input.upstreamState}` : "";
  if (input.operator) return `[Scheduled wakeup ${input.id}, due ${input.due}. No person wrote this message: the Marley team asked you to send this follow-up.] A follow-up the Marley team asked you to send this person: ${neutralizeUpstream(neutralize(input.prompt))}\nWrite it yourself with fresh data.${upstream}${block}`;
  if (input.setAt) return `[Scheduled wakeup ${input.id}, due ${input.due}, set ${input.setAt}. No person wrote this message: it is a follow-up you set then.] ${neutralizeUpstream(neutralize(input.prompt))}\n${REMINDER_OPENING}${upstream}${block}`;
  return `[Scheduled wakeup ${input.id}, due ${input.due}. No person wrote this message: it is a reminder you set earlier.] ${neutralizeUpstream(neutralize(input.prompt))}${upstream}${block}`;
}

export function eventText(input: { subscriptionId: string; event: string; summary: string; prompt: string }): string {
  return `[Event ${input.event} (subscription ${input.subscriptionId}): ${input.summary}. No person wrote this message: it is a subscription you set earlier.] ${input.prompt}`;
}
