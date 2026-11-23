import { VOICE_CAP_CHARS } from "./persona.js";
import { capVoice } from "./reply-text.js";

/**
 * What a turn's final reply may ask the server to send besides text. Nothing the VM can call sends a message: the model
 * writes directives in its final reply, and the server sends them to that turn's own conversation.
 *
 *   <react emoji="👍"/>                          react to the last message of the turn (or message="<ref>" for one of the turn's messages)
 *   <file path="files/outbox/report.pdf" caption="…"/>  send a file from this conversation's outbox
 *   <voice lang="he">text to speak</voice>       send the text as a voice note (to="<ref>" quotes one of the turn's messages)
 *   <reply to="<ref>">text</reply>               send that text as its own message, quoting one of the turn's messages
 *
 * Text outside the directives is sent as text messages. A ref is resolved by the server against the turn's own messages
 * only (message-ref.ts); one that names none of them sends without a quote.
 */
export type ReplyAction =
  | { kind: "react"; emoji: string; messageId?: string }
  | { kind: "file"; path: string; caption?: string }
  /** An existing brand file by id (marley.outbox.send_artifact on a turn the server delivers): resolved by FileService.prepareArtifact, sent to this turn's own chat only. */
  | { kind: "artifact"; artifactId: string; caption?: string }
  | { kind: "voice"; text: string; language?: string; /** The whole text when it was cut to fit the speech limit; the text fallback sends it. */ fullText?: string; to?: string };

/** One run of the reply's text, in the order written: a `<reply to>` block carries its target ref. */
export interface ReplySegment {
  text: string;
  to?: string;
}

export interface ParsedReply {
  /** All the text people read, `<reply>` blocks included (their tags removed). */
  text: string;
  /** The same text cut where `<reply>` blocks start and end; one segment equal to `text` when there are none. */
  segments: ReplySegment[];
  actions: ReplyAction[];
  /** Directives that were removed without being sent: missing attributes or over the per-reply limit. */
  dropped: number;
}

export const MAX_FILES_PER_REPLY = 4;
export const MAX_VOICES_PER_REPLY = 3;
export const MAX_REPLY_BLOCKS = 5;
/** The most a voice note carries: our own cap, cut at a sentence end. Text beyond it is not spoken. */
export const MAX_VOICE_CHARS = VOICE_CAP_CHARS;
const MAX_REACTIONS = 1;

const ATTRS = String.raw`((?:\s+[a-z]+="[^"]*")*)`;
const SELF_CLOSING = new RegExp(String.raw`<(react|file)\b${ATTRS}\s*/?>`, "g");
const VOICE = new RegExp(String.raw`<voice\b${ATTRS}\s*>([\s\S]*?)</voice>`, "g");
const REPLY = new RegExp(String.raw`<reply\b${ATTRS}\s*>([\s\S]*?)</reply>`, "g");
/** A `<reply>` tag left without its pair, or malformed (`to='m1'`, `to=m1`, `/>`), is removed, never sent as text; other text that starts with `<reply` (an address such as `<reply@shop.com>`, `<reply-all>`) stays. */
const STRAY_REPLY_TAG = /<\/reply\s*>|<reply(?=[\s>/])[^>]*>/g;
const tidy = (value: string): string => value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const unescape = (value: string): string => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function attributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-z]+)="([^"]*)"/g)) out[match[1]!] = unescape(match[2]!);
  return out;
}

/** Splits a final reply into its text and its directives, ordered reactions, files, voice notes. A directive that is malformed or over the limit is removed and counted in `dropped`. */
export function parseReply(reply: string): ParsedReply {
  const reactions: ReplyAction[] = [];
  const files: ReplyAction[] = [];
  const voices: ReplyAction[] = [];
  let dropped = 0;
  let text = reply.replace(VOICE, (_whole, rawAttrs: string, body: string) => {
    const spoken = unescape(body).trim();
    if (!spoken || voices.length >= MAX_VOICES_PER_REPLY) {
      dropped += 1;
      return "";
    }
    const { lang: language, to } = attributes(rawAttrs);
    const capped = capVoice(spoken, MAX_VOICE_CHARS);
    voices.push({
      kind: "voice",
      text: capped,
      ...([...spoken].length > MAX_VOICE_CHARS ? { fullText: spoken } : {}),
      ...(language ? { language } : {}),
      ...(to?.trim() ? { to: to.trim() } : {}),
    });
    return "";
  });
  text = text.replace(SELF_CLOSING, (_whole, tag: string, rawAttrs: string) => {
    const attrs = attributes(rawAttrs);
    if (tag === "react") {
      if (!attrs.emoji || [...attrs.emoji].length > 8 || reactions.length >= MAX_REACTIONS) {
        dropped += 1;
        return "";
      }
      reactions.push({ kind: "react", emoji: attrs.emoji, ...(attrs.message ? { messageId: attrs.message } : {}) });
      return "";
    }
    if (!attrs.path || files.length >= MAX_FILES_PER_REPLY) {
      dropped += 1;
      return "";
    }
    files.push({ kind: "file", path: attrs.path, ...(attrs.caption ? { caption: [...attrs.caption].slice(0, 1000).join("") } : {}) });
    return "";
  });
  const segments: ReplySegment[] = [];
  const plain = (value: string) => {
    const cleaned = tidy(value.replace(STRAY_REPLY_TAG, ""));
    if (cleaned) segments.push({ text: cleaned });
  };
  let at = 0;
  let blocks = 0;
  for (const match of text.matchAll(REPLY)) {
    plain(text.slice(at, match.index));
    at = match.index! + match[0].length;
    const to = attributes(match[1]!).to?.trim();
    const body = tidy(match[2]!.replace(STRAY_REPLY_TAG, ""));
    if (!to || blocks >= MAX_REPLY_BLOCKS) {
      dropped += 1;
      if (body) segments.push({ text: body });
      continue;
    }
    blocks += 1;
    if (body) segments.push({ text: body, to });
  }
  plain(text.slice(at));
  return { text: segments.map((segment) => segment.text).join("\n\n"), segments, actions: [...reactions, ...files, ...voices], dropped };
}
