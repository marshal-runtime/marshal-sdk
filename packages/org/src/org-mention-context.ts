import { wrapUntrusted } from "../host-deps";
import type { OrgMentionNote } from "./contract/org-types";

/** A note not taken by a prompt within this long belongs to a message that never went out. */
const NOTE_TTL_MS = 10 * 60_000;
const MAX_NOTED_PEOPLE = 10;
const MAX_FIELD_CHARS = 120;

const notesBySession = new Map<string, { at: number; mentions: NoteInput[] }>();

/** What arrives over IPC: the role is checked here, not trusted from the type. */
type NoteInput = Omit<OrgMentionNote, "role"> & { role: string };

const ROLES = new Set<string>(["viewer", "collaborator", "driver"]);

/** Directory text is external data: no control characters, no markup, bounded. */
function cleanDirectoryText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      out += " ";
    } else if (char === "<") {
      out += "&lt;";
    } else if (char === ">") {
      out += "&gt;";
    } else if (char === "&") {
      out += "&amp;";
    } else {
      out += char;
    }
    if (out.length >= MAX_FIELD_CHARS) break;
  }
  return out.trim();
}

/**
 * The one line the model gets when the message it is answering tagged people. Names and emails come
 * from the organization's directory, so they sit inside an `external_content` envelope; the role and
 * the wording are ours.
 */
export function buildMentionContextLine(mentions: readonly NoteInput[]): string | undefined {
  const valid = mentions.filter((mention) => ROLES.has(mention.role)).slice(0, MAX_NOTED_PEOPLE);
  if (valid.length === 0) return undefined;
  const describe = (mention: NoteInput) => {
    const name = cleanDirectoryText(mention.displayName) || "(unnamed)";
    const email = mention.email ? cleanDirectoryText(mention.email) : "";
    return `${name}${email ? ` <${email}>` : ""} as ${mention.role}`;
  };
  const granting = valid.filter((mention) => mention.state === "granting");
  const waiting = valid.filter((mention) => mention.state === "waiting");
  const parts: string[] = [];
  if (granting.length > 0) {
    parts.push(
      `Marshal is giving these people access to this session and notifying them: ${wrapUntrusted("org_directory", granting.map(describe).join("; "))}`,
    );
  }
  if (waiting.length > 0) {
    parts.push(
      `These people will get access once the user picks a workspace to share in: ${wrapUntrusted("org_directory", waiting.map(describe).join("; "))}`,
    );
  }
  return (
    `The user tagged people with @ in this message. ${parts.join(". ")}. ` +
    `A tag is not a message from them: they have written nothing here, so do not answer as if they had.`
  );
}

/** Remembers, until the next prompt of the session, who the message being sent tagged. */
export function noteSessionMentions(
  sessionId: string,
  mentions: readonly NoteInput[],
  now: number = Date.now(),
): void {
  if (mentions.length === 0) {
    notesBySession.delete(sessionId);
    return;
  }
  notesBySession.set(sessionId, { at: now, mentions: [...mentions] });
}

/** The context line for the prompt being submitted now; the note is used up. */
export function takeSessionMentionContext(
  sessionId: string,
  now: number = Date.now(),
): string | undefined {
  const note = notesBySession.get(sessionId);
  if (!note) return undefined;
  notesBySession.delete(sessionId);
  if (now - note.at > NOTE_TTL_MS) return undefined;
  return buildMentionContextLine(note.mentions);
}
