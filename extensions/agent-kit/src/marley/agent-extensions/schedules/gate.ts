import type { StoredMessage } from "../../store.js";
import type { ConversationKey } from "../../store.js";
import type { ScheduleRepo } from "./repo.js";
import { isSystemPhone, type ScheduleConfig } from "./types.js";

/** What the router asks before sending a reply: may this reply go out, and where does it go when it may not. */
export interface ReplyGate {
  /** The reason a reply must be withheld, or null when it may be sent. */
  check(key: ConversationKey, pending: StoredMessage[], now: number): string | null;
  /**
   * The channel's window read fresh from the person's newest message, whatever the batch holds: for a reply that goes out later than the turn that wrote it
   * (the outbox holds material up to a day), where "their message just opened the window" is no longer true.
   */
  window(key: ConversationKey, now: number): string | null;
  /** Stores a reply that was not sent. */
  withhold(key: ConversationKey, turnId: string, text: string, reason: string, now: number): void;
}

export const OUTSIDE_WINDOW = "outside the 24-hour WhatsApp window";

/**
 * WhatsApp allows a free-form message to a person only within 24 hours of their last message. A turn started by a
 * schedule or an event (every pending message is a system message) still runs, but its reply is stored, not sent, once
 * that window has closed. A turn that answers a person never passes through here: their message just opened the window.
 * A reminder or nudge that is due while the window is closed does not get here: the scheduler hands it to the follow-up
 * template (`proactive/follow-up.ts`) before any turn runs, and the person's reply opens the window for a turn that
 * writes it. What this gate still holds is a system schedule's turn (free time, routines, onboarding), an event
 * subscription's turn, or a race (the window closed between the fire and the reply); the router logs it at INFO, and
 * nothing reads `withheld_replies`. A fire the follow-up engine could not take is logged at WARN by the scheduler
 * (`schedule.handoff_unavailable`).
 */
export function replyGate(repo: ScheduleRepo, config: Pick<ScheduleConfig, "replyWindowMs">): ReplyGate {
  const window = (key: ConversationKey, now: number): string | null => {
    if (key.channel !== "whatsapp") return null;
    const last = repo.lastHumanMessageAt(key.brandId, key.channel, key.conversationId);
    return last !== null && now - last <= config.replyWindowMs ? null : OUTSIDE_WINDOW;
  };
  return {
    check(key, pending, now) {
      if (pending.length === 0 || !pending.every((message) => isSystemPhone(message.fromPhone))) return null;
      return window(key, now);
    },
    window,
    withhold(key, turnId, text, reason, now) {
      repo.addWithheldReply(turnId, key.brandId, key.channel, key.conversationId, text, reason, now);
    },
  };
}
