import { MAX_FILES_PER_REPLY, MAX_VOICES_PER_REPLY, MAX_VOICE_CHARS, type ReplyAction, type ReplySegment } from "./reply-directives.js";
import type { LiveMessage } from "./live-sends.js";
import { capVoice } from "./reply-text.js";

/**
 * What a server-delivered turn (an owner report fire) said through the reply tools, in the typed shape the router's `reply()` already sends: the queued VM send
 * envelopes read after the turn, never the model's final text. `dropped` counts envelopes that this path does not deliver (a connect link, a team invite) or that are
 * over the per-reply limits; each is logged by the caller, never silently lost.
 */
export interface ReplyParts {
  segments: ReplySegment[];
  actions: ReplyAction[];
  dropped: { kind: string; reason: "unsupported_here" | "over_limit" }[];
  /**
   * Server-written text that goes out after the files and voice notes (the morning brief's question after its video). Only the server sets it; a model's
   * reply tools never fill it. It goes out only when the reply's own words do (a second brief video of the day sends neither).
   */
  after?: ReplySegment[];
  /** The `after` text goes as fixed pieces, sent exactly (a free-time ask's grounds): the composer neither rewrites nor drops them. */
  afterFixed?: boolean;
}

const MAX_REACTIONS = 1;

export function replyPartsOf(messages: readonly LiveMessage[]): ReplyParts {
  const segments: ReplySegment[] = [];
  const reactions: ReplyAction[] = [];
  const files: ReplyAction[] = [];
  const voices: ReplyAction[] = [];
  const dropped: ReplyParts["dropped"] = [];
  for (const message of messages) {
    if (message.kind === "text") segments.push({ text: message.input.text, ...(message.input.to ? { to: message.input.to } : {}) });
    else if (message.kind === "voice") {
      if (voices.length >= MAX_VOICES_PER_REPLY) { dropped.push({ kind: message.kind, reason: "over_limit" }); continue; }
      const spoken = message.input.text.trim();
      voices.push({ kind: "voice", text: capVoice(spoken, MAX_VOICE_CHARS), ...([...spoken].length > MAX_VOICE_CHARS ? { fullText: spoken } : {}),
        ...(message.input.lang ? { language: message.input.lang } : {}), ...(message.input.to ? { to: message.input.to } : {}) });
    } else if (message.kind === "image" || message.kind === "file") {
      if (files.length >= MAX_FILES_PER_REPLY) { dropped.push({ kind: message.kind, reason: "over_limit" }); continue; }
      files.push({ kind: "file", path: message.input.path, ...(message.input.caption ? { caption: message.input.caption } : {}) });
    } else if (message.kind === "artifact") {
      if (files.length >= MAX_FILES_PER_REPLY) { dropped.push({ kind: message.kind, reason: "over_limit" }); continue; }
      files.push({ kind: "artifact", artifactId: message.input.artifactId, ...(message.input.caption ? { caption: message.input.caption } : {}) });
    } else if (message.kind === "react") {
      if ([...message.input.emoji].length > 8 || reactions.length >= MAX_REACTIONS) { dropped.push({ kind: message.kind, reason: "over_limit" }); continue; }
      reactions.push({ kind: "react", emoji: message.input.emoji, ...(message.input.to ? { messageId: message.input.to } : {}) });
    } else dropped.push({ kind: message.kind, reason: "unsupported_here" });
  }
  return { segments, actions: [...reactions, ...files, ...voices], dropped };
}

export const replyPartsCount = (parts: ReplyParts): number => parts.segments.length + parts.actions.length + (parts.after?.length ?? 0);
/** The words the parts carry, for the places that only need to know what was said (logs, the routine page). Never parsed back. */
export const replyPartsText = (parts: ReplyParts): string => [...parts.segments, ...(parts.after ?? [])].map((segment) => segment.text).join("\n\n");

/** Typed parts for a reply the server wrote itself: its text, at most one voice note (already within the speech cap) and files of the conversation's outbox by path. */
export function serverReplyParts(input: { text: string; voice?: { text: string; language?: string }; files?: { path: string; caption?: string }[] }): ReplyParts {
  return {
    segments: input.text ? [{ text: input.text }] : [],
    actions: [...(input.files ?? []).map((file): ReplyAction => ({ kind: "file", path: file.path, ...(file.caption ? { caption: file.caption } : {}) })),
      ...(input.voice ? [{ kind: "voice" as const, text: input.voice.text, ...(input.voice.language ? { language: input.voice.language } : {}) }] : [])],
    dropped: [],
  };
}
