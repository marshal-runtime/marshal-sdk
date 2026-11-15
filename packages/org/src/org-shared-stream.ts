import { scrubText } from "./cloud-session-sanitizer";

type Roots = Parameters<typeof scrubText>[1];

/**
 * The part of a reply still being written that may leave the computer now, scrubbed exactly as the
 * finished message will be. Secrets, credential values and paths are single words, and a private key
 * block is whole lines, so the cut is: every complete line, plus the current line's finished words
 * when that line holds no path separator and no PEM marker (a path with spaces, or a key header still
 * being written, waits for its line to end). What the final scrub hides is never in a partial update.
 */
export function streamableReplyText(raw: string, roots: Roots): string {
  const lineEnd = raw.lastIndexOf("\n");
  const complete = lineEnd >= 0 ? raw.slice(0, lineEnd + 1) : "";
  const current = raw.slice(lineEnd + 1);
  let cut = complete;
  if (current && !/[\\/]|-----/.test(current)) {
    const wordEnd = Math.max(current.lastIndexOf(" "), current.lastIndexOf("\t"));
    if (wordEnd > 0) cut += current.slice(0, wordEnd);
  }
  return scrubText(cut, roots).trimEnd();
}
