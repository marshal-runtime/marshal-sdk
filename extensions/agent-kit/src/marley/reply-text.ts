import { VOICE_CAP_CHARS } from "./persona.js";

/** A voice note is cut at the cap, at the last sentence end (or word) before it, so a long take never goes out as a monologue. */
export function capVoice(text: string, cap = VOICE_CAP_CHARS): string {
  const letters = [...text.trim()];
  if (letters.length <= cap) return letters.join("");
  const head = letters.slice(0, cap).join("");
  let sentence = -1;
  for (const end of head.matchAll(/[.!?。…]["'”’)»]*(?=\s|$)/g)) sentence = end.index + end[0].length;
  if (sentence >= Math.min(80, cap / 4)) return head.slice(0, sentence).trim();
  const word = head.lastIndexOf(" ");
  return (word >= cap / 2 ? head.slice(0, word) : head).trim();
}

/** Whitespace, format characters and the blank-looking fillers that render as an empty message (Hangul filler U+3164, Braille blank U+2800, variation selector U+FE0F, combining grapheme joiner U+034F). */
const INVISIBLE = /[\s\p{Cf}\p{Zs}\p{Zl}\p{Zp}ㅤᅟᅠﾠ⠀️͏]/gu;
export const isBlank = (text: string): boolean => text.replace(INVISIBLE, "") === "";
/** The model's "nothing to say" sentinel, alone, with or without wrapping or final punctuation (`**NO_REPLY**`, `"NO_REPLY"`). */
export const isNoReply = (text: string): boolean => /^[^\p{L}\p{N}]*no_reply[^\p{L}\p{N}]*$/iu.test(text.replace(INVISIBLE, ""));
/** Text with nothing the owner could read: empty, invisible characters only, or the sentinel. */
export const isEmptyText = (text: string): boolean => isBlank(text) || isNoReply(text);

/** A sentinel that ends a line: after a space or sentence punctuation, maybe wrapped (`**`, quotes, brackets), maybe followed by punctuation and invisible format characters (a right-to-left mark). */
const TRAILING_SENTINEL = /(?<![\p{L}\p{N}])([(\[*_"'`~]*)NO_REPLY([)\]*_"'`~.!?]*)[\s\p{Cf}]*$/iu;
const MARKDOWN_CLOSER = /[*_~`"]+/;

function withoutTrailingSentinel(line: string): string {
  let current = line;
  for (let pass = 0; pass < 50; pass++) {
    const match = TRAILING_SENTINEL.exec(current);
    if (!match) return current;
    let rest = current.slice(0, match.index).replace(/[\s\p{Cf},;:\-–—]+$/u, "");
    // `**Real text. NO_REPLY**` keeps its bold: the closing marker that went with the sentinel is put back when the text still has its opening one.
    const closer = MARKDOWN_CLOSER.exec(match[2]!)?.[0];
    if (closer && rest !== "" && rest.split(closer).length % 2 === 0) rest += closer;
    current = rest;
  }
  return current;
}

/** Removes every line that is only the sentinel and a sentinel that ends a line (also repeated, wrapped or in brackets), keeping the real text (in any script) around it. A sentence that ends in the literal token loses that word. */
export function withoutSentinel(text: string): string {
  return text.split(/\r?\n|\u2028|\u2029/).filter(line => !isNoReply(line)).map(withoutTrailingSentinel).join("\n");
}

const TOKEN = "N[\\p{Cf}]*O[\\p{Cf}]*_[\\p{Cf}]*R[\\p{Cf}]*E[\\p{Cf}]*P[\\p{Cf}]*L[\\p{Cf}]*Y";
/** A quoted sentinel goes with its own quotes (never the quotes of an attribute value (`caption="NO_REPLY"` becomes `caption=""`)); other wrapping is markdown or brackets. */
const QUOTED_SENTINEL = new RegExp(`(?<!=)(["'\`])${TOKEN}\\1`, "giu");
const SENTINEL_ANYWHERE = new RegExp(`(?<![\\p{L}\\p{N}])[(\\[*_~]*${TOKEN}[)\\]*_~.!?]*(?![\\p{L}\\p{N}])`, "giu");

/**
 * Delivery-boundary scrub: removes the sentinel wherever it stands (inside `<reply>`/`<voice>` bodies, a caption attribute, mid-sentence,
 * with zero-width characters between its letters), keeps the rest. A reply of text plus the sentinel sends the text; nothing is sent
 * when only the sentinel and blanks remain (the caller checks `isEmptyText`). Applied to every outbound text, voice and caption.
 */
export function scrubSentinel(text: string): string {
  if (!new RegExp(TOKEN, "iu").test(text)) return text;
  return text.replace(QUOTED_SENTINEL, "").replace(SENTINEL_ANYWHERE, "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "");
}
