import type { BrandContext, BrandMember } from "./directory.js";
import { dmSpeaker, memberOf } from "./preferences-prompt.js";
import { promptLabel } from "./prompt-text.js";
import { isSystemPhone } from "./agent-extensions/schedules/types.js";
import type { StoredMessage } from "./store.js";

/** Most people named in a group turn. */

const name = (member: BrandMember): string => JSON.stringify(promptLabel(member.displayName));
const goesBy = (member: BrandMember): string =>
  member.preferences?.preferredName ? `, and they go by ${JSON.stringify(promptLabel(member.preferences.preferredName))}` : "";

/**
 * Who the turn is with, from server-owned identity: the directory member the gateway matched by the sending phone (or, for a
 * wakeup, the member who set it). Rendered outside host_context on purpose: a resumed session replaces an unchanged
 * host_context with a hash line, and the speaker can change from one turn to the next. Names are quoted data. Returns null
 * when no sender is a brand member (the router does not run such turns).
 */
export function speakerPrompt(input: { messages: StoredMessage[]; brand: BrandContext | null }): string | null {
  const answered = input.messages.filter((message) => message.state !== "context");
  const considered = answered.length ? answered : input.messages;
  // As in the router: system, schedule, event and routine messages never name a speaker, even when they carry the creator's member id.
  const human = considered.filter((message) => !isSystemPhone(message.fromPhone));
  const jobOnly = considered.length > 0 && human.length === 0;
  const member = dmSpeaker(input.messages, input.brand);
  if (!member) return null;
  return [
    "<speaker>",
    `This is your direct chat with ${name(member)} (member id ${member.id}): a member of the brand's team${goesBy(member)}. The server knows them by the phone their messages come from. What you have on file about them: marshal.tool.recall {query: their name}.${jobOnly ? " No person wrote this turn: a wakeup or event they set started it." : ""}`,
    "</speaker>",
  ].join("\n");
}
