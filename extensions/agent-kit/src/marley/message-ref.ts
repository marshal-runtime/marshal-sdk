import { createHash } from "node:crypto";

import { isSystemPhone } from "./agent-extensions/schedules/types.js";
import { isDeletion, type StoredMessage } from "./store.js";

/**
 * The short name a turn's prompt gives one of its messages ("m" and 6 hex digits of the message id's hash), so the
 * model can point at a message without copying a long channel id. It names nothing outside the turn: the server
 * resolves it only against that turn's own messages (resolveMessageRef).
 */
export function messageRef(messageId: string): string {
  return `m${createHash("sha256").update(messageId).digest("hex").slice(0, 6)}`;
}

/**
 * Notes only the gateway writes on rows that stand for an event, not a message a person sent (channels/whatsapp-inbound.ts,
 * channels/imessage-linq.ts, whose reaction rows also carry a `reaction:` id).
 */
const EVENT_NOTES = ["the user reacted ", "the user removed their reaction ", "the user removed a reaction ", "WhatsApp system notice"];
const EDIT_NOTE = "the user edited message ";

/**
 * The channel message a reply quotes for this row, or null when the row is no message a person sent: a scheduled or
 * event wake-up, a reaction, a WhatsApp system notice or a deletion. A late transcript and an edit stand for the
 * message they belong to (gateway-set `updateOf` / `replyTo`), whose id is what the channel knows.
 */
export function quoteTarget(message: StoredMessage): string | null {
  if (isSystemPhone(message.fromPhone) || isDeletion(message) || message.id.startsWith("reaction:")) return null;
  if (message.notes.some((note) => EVENT_NOTES.some((prefix) => note.startsWith(prefix)))) return null;
  if (message.updateOf) return message.updateOf;
  if (message.notes.some((note) => note.startsWith(EDIT_NOTE))) return message.replyTo;
  return message.id;
}

/**
 * The channel message id a ref (or a row's full id) names among `messages`, or undefined when no quotable row or more
 * than one does. `messages` must be the turn's own messages of its own conversation: that is the whole authority of a target.
 */
export function resolveMessageRef(ref: string | undefined, messages: readonly StoredMessage[]): string | undefined {
  const wanted = ref?.trim();
  if (!wanted) return undefined;
  const quotable = messages.filter((m) => quoteTarget(m) !== null);
  const exact = quotable.filter((m) => m.id === wanted);
  const named = exact.length ? exact : quotable.filter((m) => messageRef(m.id) === wanted.toLowerCase());
  return named.length === 1 ? quoteTarget(named[0]!)! : undefined;
}
