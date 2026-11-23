import { NO_REPLY } from "./types.js";

/**
 * How a turn speaks to the person. Two protocols exist while brand VMs move to the new runtime snapshot:
 *
 * - tools: every outbound thing is one part put to the conversation's outbox through a VM capability (marley.outbox.send_text, send_voice, send_image,
 *   send_file, send_artifact, react, send_connect_link, called with runtime_exec; packages/outbox-tools). The outbox agent composes what reaches the person;
 *   final words the turn did not put go to the outbox for it (router.ts).
 * - tags: the older protocol, read from the final text (`<file/>`, `<voice>`, `<reply>`, `<react/>`, the NO_REPLY sentinel).
 *
 * Which one a turn runs is a typed fact of its brand VM: the installed runtime carries `outbox_put@1` in its RUNTIME_FEATURES (zs-data-tools.mjs), the
 * server reads it with the same probe as `remote_runtime@1` (tasks/runtime-features.ts), and a probe that cannot answer reads as "tags": an unknown runtime
 * is an old one. No flag and no brand list decides it.
 */
export const REPLY_TOOLS_RUNTIME_FEATURE = "outbox_put@1";
/**
 * The installed runtime lists the `zs.state.set` operation: a turn keeps its living state with a typed call instead of `<state>` directives in its final text.
 * Probed like `outbox_put@1`; a runtime without it (or a probe that cannot answer) keeps the directives. Independent of the reply protocol.
 */
export const LIVING_STATE_TOOL_RUNTIME_FEATURE = "living_state_tool@1";

/** The living-state sentences of the prompts, for each way of writing the state. */
export const STATE_TOKENS = {
  state_core: {
    tags: `write <state section="picture|numbers|threads|found">the section's full new text</state> at the very end of your final text: it replaces that section with the full new text, mode="add" adds a line (the usual way for found), an empty one clears it. Only in the final text, never in a message you send while working: the server removes it before anything is sent and keeps it in the brand's one shared sheet, which every member's chat reads.`,
    tools: `call runtime_exec {targetType: "operation", target: "zs.state.set", input: {section: "picture|numbers|threads|found", mode?: "replace|add", text}}: it replaces that section with the full new text (mode "add" adds a line, the usual way for found; empty text clears it). It is a tool call like any other, made while you work or last: the server keeps it in the brand's one shared sheet, which every member's chat reads, and it is never sent to anybody.`,
  },
  state_routine: {
    tags: `<state section="picture|numbers|threads|found">the section's full new text</state> at the end of your final text`,
    tools: `a zs.state.set call (runtime_exec {targetType: "operation", target: "zs.state.set", input: {section, mode?, text}})`,
  },
  state_block: {
    tags: `Keep them current: at the very end of the words you end your turn with (never in a message you send while working) write <state section="picture|numbers|threads|found">the section's full new text</state>, or mode="add" to add a line; an empty one clears it. This holds when a task fixes what you end your turn with: put them after it. The server removes these before anything is read or sent.`,
    tools: `Keep them current: call runtime_exec {targetType: "operation", target: "zs.state.set", input: {section: "picture|numbers|threads|found", mode?: "replace|add", text}} (mode "add" adds a line; empty text clears the section). It is a tool call, never part of a message; the server keeps it in the brand's one shared sheet.`,
  },
  state_closing: {
    tags: `end it with at least one <state> directive saying what this run found, or why nothing was ready`,
    tools: `also make at least one zs.state.set call saying what this run found, or why nothing was ready`,
  },
  /** The worker role's living-state sentences (extensions/persona/layers/worker.md). */
  worker_state_write: {
    tags: `you write as <state section="picture|numbers|threads|found">the section's full new text</state> directives just before the result block, never after it`,
    tools: `you write with zs.state.set calls (runtime_exec {targetType: "operation", target: "zs.state.set", input: {section: "picture|numbers|threads|found", mode?: "replace|add", text}}) before you write the result block`,
  },
  worker_state_item: {
    tags: `your <state section="picture|numbers|threads|found">the section's full new text</state> directives.`,
    tools: "your zs.state.set calls.",
  },
} as const;
export const stateTokenFor = (name: keyof typeof STATE_TOKENS, stateTool: boolean | undefined): string => STATE_TOKENS[name][stateTool ? "tools" : "tags"];

/**
 * What happens to the plain text a tools turn writes at its end. false: it reaches nobody (it is logged, with `turn.no_send` when a person's message got no send at
 * all), so the model must call a send tool to speak. true: it is sent as one more text message, as the tags protocol always did. This is the one place the choice lives.
 */
export const FINAL_TEXT_IS_SENT = false;


export type ReplyProtocol = "tools" | "tags";
export const protocolOf = (replyTools: boolean | undefined): ReplyProtocol => (replyTools ? "tools" : "tags");

/** The outbox capabilities the model calls with runtime_exec, as the prompt names them. */
export const REPLY_TOOL_LIST = "marley.outbox.send_text, marley.outbox.send_voice, marley.outbox.send_image, marley.outbox.send_file, marley.outbox.react and marley.outbox.send_connect_link";

/**
 * The sentences of the prompts that differ between the two protocols, keyed by the placeholder a role file or prompt text carries. Each `tags` entry is the
 * wording the prompts had before replies were tools, byte for byte; each `tools` entry says the same thing for a turn whose final text goes nowhere.
 */
const TOKENS: Record<string, Record<ReplyProtocol, string>> = {
  /** "…when everything went out, {{nothing_more}}." */
  nothing_more: { tags: `the final reply is ${NO_REPLY}`, tools: "you send nothing more and call no send tool again" },
  /** The front's one-answer rule. */
  goes_out_once: {
    tags: `It goes out once: either as your final reply, or with reply_send_text and then ${NO_REPLY} as the final reply. Never both, and never two versions of the same line. Starting the worker is never a reason for ${NO_REPLY}: on a person's message it is your final reply only when the answer already went out in this turn.`,
    tools: "It goes out once, with one send call, and never as two versions of the same line. Starting the worker is never a reason to send nothing: on a person's message you send nothing only when the answer already went out in this turn.",
  },
  /** "…their message asked for nothing (banter, thanks, a greeting), so {{send_nothing}}: no recap…" */
  send_nothing: { tags: `the final reply is ${NO_REPLY} alone`, tools: "you call no send tool at all" },
  /** Where the filing sits relative to the answer. */
  filing_order: {
    tags: "Nothing runs after your final reply, and words written before a tool call never reach the person, so when your answer is the final reply itself, you file first and then write the whole answer as that reply.",
    tools: "Your answer goes out with the send tools while you work and the turn ends when you stop calling tools, so you file after the answer has gone out and finish there.",
  },
  filing_order_v2: {
    tags: "Nothing runs after your final reply and words written before a tool call never reach the person, so when the answer is your final reply, file first and then write the whole answer.",
    tools: "Your answer goes out with the send tools while you work and the turn ends when you stop calling tools, so you file after the answer has gone out and finish there.",
  },
  /** The end of a turn. */
  end_of_turn: {
    tags: `Whatever you write at the end of your turn is also sent, as one more message after everything you sent while working. When everything already went out through the tools, reply ${NO_REPLY} alone and nothing more goes out.`,
    tools: `Only what reaches the outbox reaches the person. When you put parts while you work, what you write at the end of your turn is for the log; when you put nothing, your final words go to the outbox as your answer. When you have nothing to say, put nothing and end with ${NO_REPLY} alone, and the person hears nothing from this turn.`,
  },
  /** The send tools and what is left of the final reply (extensions/persona/layers/delivering.md). */
  send_tools_block: {
    tags: `**Your three send tools** (always call the prefixed names mcp__marshal__reply_send_text, mcp__marshal__reply_send_voice, mcp__marshal__reply_send_image; a bare name fails). Each call is one message, queued for this conversation only, in the order you send. There is no recipient to give. A sent message cannot be recalled and gives no receipt; on an error, say the thing in your next message.
- reply_send_text {text}: one text message.
- reply_send_voice {text, lang?}: a voice part, only when the person asked for a voice note. Plain words, at most 600 characters, no links or markup; lang="he" for Hebrew. Everything else goes as text: whether it is spoken is the composer's call.
- reply_send_image {path, caption?}: one PNG or JPEG of up to 5 MB from files/outbox (path relative to your home), sent right after the line with the key number; the caption holds the one-line takeaway.

**Your final reply** is also sent, as one more message after everything you sent while working. When everything already went out, the final reply is {{no_reply}} alone. In it you may also use: <react emoji="👍"/> (reacts to the last message you answer; message="<ref>" picks another of this turn); <reply to="<ref>">answer</reply> to answer one of several messages of this turn under its quote (at most 5); <voice lang="he">words</voice> for a voice note as the last thing you say; <file path="files/outbox/<name>" caption="…"/> for a file from this conversation's own outbox. {{files_rule}}`,
    tools: `**How you speak: the outbox.** Everything you say goes to this conversation's outbox, one part per call, through the runtime: runtime_exec {targetType: "operation", target: "marley.outbox.send_text", input: {text, basis: "state"}}, and the same for each capability below. The outbox agent composes what reaches the person from every part waiting for them: it may open with a short pointer back, quote an earlier message, add a line on how fresh state-based facts are, or ask a worker to rework its words. Every part carries basis: "state" when you answer from what you already have (the living state, memory, this conversation), "work" when it is the result of checking done for this request. replyTo is the ref of the message it answers, when that is not their latest one; a worker also gives taskId, its own task's id. There is no recipient to give. A part cannot be recalled and gives no receipt; on an error, say the thing in your next part.
- marley.outbox.send_text {text, corrects?}: one text message. corrects is true when it takes back or corrects something already told (a figure, a date, a conclusion).
- marley.outbox.send_voice {text, lang?}: a voice part, only when the person asked for a voice note. Plain words, at most 600 characters, no links or markup; lang="he" for Hebrew. Everything else goes as text: whether it is spoken is the composer's call.
- marley.outbox.send_image {path, caption?}: one PNG or JPEG of up to 5 MB from files/outbox (path relative to your home), right after the line with the key number; the caption holds the one-line takeaway.
- marley.outbox.send_file {path, caption?}: one file from this conversation's own outbox (a video, PDF, spreadsheet, document or audio file), path relative to your home. {{files_rule}}
- marley.outbox.react {emoji}: a reaction to the last message you answer (replyTo picks another message), when a word would be too much.
- marley.outbox.send_connect_link {source, text}: one message that asks the person to connect a data source and carries its link. source is the source's id from your sources list; text holds your words and no link, because the server builds the link and signs it for this person.
When you have nothing to say, put nothing and end your turn with ${NO_REPLY} alone: the person hears nothing from this turn.`,
  },
  /** Free time's closing sentences (free-time.ts). */
  end_nothing: { tags: `end your turn with ${NO_REPLY} alone`, tools: "send nothing and end your turn" },
  end_nothing_it: { tags: `end it with ${NO_REPLY} alone`, tools: "call no send tool" },
  message_last: { tags: "the message as your final reply", tools: "the message with a send tool" },
  window_closed: {
    tags: `If the server_state block says the reply window is closed, nothing you write reaches them: end with ${NO_REPLY} and keep what matters in the journal. Do everything before your final reply; nothing runs after it.`,
    tools: "If the server_state block says the reply window is closed, nothing you send reaches them: call no send tool and keep what matters in the journal.",
  },
  /** The hand-off line and the learning filing order. */
  handoff_send: {
    tags: "send it in the final reply, never first with reply_send_text, never write the call into the reply as text",
    tools: "send it with one marley.outbox.send_text call and nothing else, and never write the call as text",
  },
  filing_learning: {
    tags: "Nothing runs after your final reply, and words you write before a tool call never reach the person: when the answer goes out as your final reply rather than through the send tools, you file first and then write the whole answer as that final reply.",
    tools: "Your answer goes out with the send tools while you work and the turn ends when you stop calling tools, so you file after the answer has gone out and finish there.",
  },
  /** The Meta analysis fire's silence (routines/vm-turns.ts): what it computes is kept, nothing is sent. */
  ua_silent: {
    tags: `Your own final reply is never sent, so end your turn with ${NO_REPLY} alone.`,
    tools: "Nothing you send reaches anyone from this run: call no send tool and end your turn.",
  },
  /** The owner reports' prompts (routines/owner-reports.ts). */
  report_files: {
    tags: 'its files attached through your final reply (<file path="..."/>).',
    tools: "its files sent with one marley.outbox.send_file call each (its path).",
  },
  prepare_nothing: {
    tags: `your final reply is ${NO_REPLY} alone (this turn's reply is discarded by the server; it learns what happened from the video in the outbox and your run report).`,
    tools: "you call no send tool at all (the server learns what happened from the video in the outbox and your run report).",
  },
  brief_not_ready: {
    tags: "your final reply is the one line Your morning brief is not ready. (no figures, no reason, no text fallback).",
    tools: "you send the one line Your morning brief is not ready. with marley.outbox.send_text (no figures, no reason, no text fallback).",
  },
  brief_reply: {
    tags: `The reply when the video is attached: exactly the text Here is your morning brief (no figures, no actions, no date, no other sentence, nothing from the command's textLines), then the video as one <file path="files/outbox/..."/> directive with no caption attribute. The figures are in the video, so a reply that carries the video never repeats them.`,
    tools: "What you send when the video is attached: one marley.outbox.send_text call with exactly the text Here is your morning brief (no figures, no actions, no date, no other sentence, nothing from the command's textLines), then the video with one marley.outbox.send_file call (its path in files/outbox, no caption). The figures are in the video, so what carries the video never repeats them.",
  },
  /** A turn that ends as a message of its own. */
  closing: {
    tags: `Answer the messages marked as needing a reply (everything not marked "context only"), or answer ${NO_REPLY}.`,
    tools: "Answer the messages marked as needing a reply (everything not marked \"context only\") with the send tools, or send nothing.",
  },
};

export function fillProtocol(text: string, protocol: ReplyProtocol): string {
  return text.replace(/\{\{([a-z_0-9]+)\}\}/g, (whole, name: string) => TOKENS[name]?.[protocol] ?? whole);
}

export const tokenFor = (name: keyof typeof TOKENS | string, protocol: ReplyProtocol): string => TOKENS[name]![protocol];

/** The "Other ways to speak" section of the channel layer, for each protocol. */
export const REACT_LINE = {
  tags: `- <react emoji="👍"/> in your final reply reacts to the last message you are answering (message="m1a2b3c", the ref of another message of this turn, picks that one). A reaction says "got it" or "nice" without a word, which is sometimes exactly right.`,
  tools: `- A reaction (marley.outbox.react) reacts to the last message you are answering (replyTo is the ref of another message, such as m1a2b3c, and picks that one). A reaction says "got it" or "nice" without a word, which is sometimes exactly right.`,
};
export const QUOTE_LINE = {
  tags: `- <reply to="m1a2b3c">your answer</reply> in your final reply sends that answer as its own message quoting the person's message with that ref (each message of this turn shows its ref). Use it when the person sent several messages in a row about different things, so each answer sits under the message it answers; for one message or one topic, just write. At most 5 per reply, and only refs of this turn's messages: any other ref sends the text without a quote.`,
  tools: `- replyTo on any part quotes the person's message with that ref (each message of this turn shows its ref). Use it when the person sent several messages in a row about different things, so each answer sits under the message it answers; for one message or one topic, just write. Only refs of this conversation's messages: any other ref sends the text without a quote.`,
};
export const VOICE_LINE = {
  tags: `- <voice lang="he">words to say</voice> in your final reply sends those words as a voice note, the same as reply_send_voice, for when the voice note is the last thing you say (to="m1a2b3c" quotes that message).`,
  tools: "",
};
export const TEXT_LINE = {
  tags: "- Text outside the directives in your final reply is sent as text messages.",
  tools: "",
};
