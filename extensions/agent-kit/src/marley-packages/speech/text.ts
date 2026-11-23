/** Splits text into pieces of at most maxChars, preferring sentence ends, then commas, then spaces. */
export function splitForSpeech(text: string, requestedMax: number): string[] {
  // A size that is not a whole number of at least one would never advance splitLong.
  const maxChars = Number.isFinite(requestedMax) && requestedMax >= 1 ? Math.floor(requestedMax) : 250;
  const clean = text.replace(/[ \t]+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const sentences = sentencesOf(clean);
  // A piece that ended a line keeps the line break when joined, so words from two lines never run into one phrase.
  const pieces: { text: string; br: boolean }[] = [];
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    const br = sentence.endsWith("\n");
    if (s.length <= maxChars) pieces.push({ text: s, br });
    else {
      const parts = splitLong(s, maxChars);
      parts.forEach((part, index) => pieces.push({ text: part, br: br && index === parts.length - 1 }));
    }
  }
  const chunks: string[] = [];
  let current = "";
  let currentBr = false;
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.text.length > maxChars) {
      chunks.push(current);
      current = piece.text;
    } else {
      current = current ? `${current}${currentBr ? "\n" : " "}${piece.text}` : piece.text;
    }
    currentBr = piece.br;
  }
  if (current) chunks.push(current);
  return chunks;
}

const TERMINATORS = ".!?…";
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";

/** Sentences with their end marks, split at line breaks (a sentence that ended a line keeps its "\n"). A "." before a digit ("3.5", ".5") is part of a figure, never an end. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (TERMINATORS.includes(char) && !(char === "." && isDigit(text[i + 1]))) {
      let end = i;
      while (end + 1 < text.length && TERMINATORS.includes(text[end + 1]!) && !(text[end + 1] === "." && isDigit(text[end + 2]))) end++;
      out.push(text.slice(start, end + 1));
      start = end + 1;
      i = end;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** True when cutting at this index would split a figure: between digits, or at a "." or "," that sits between digits or before one. */
function insideFigure(text: string, cut: number): boolean {
  const before = text[cut - 1];
  const after = text[cut];
  return (isDigit(before) && (isDigit(after) || ((after === "." || after === ",") && isDigit(text[cut + 1])))) || ((before === "." || before === ",") && isDigit(after));
}

function splitLong(sentence: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": ")) + 1;
    if (cut <= 0) cut = window.lastIndexOf(" ");
    if (cut <= 0) {
      cut = maxChars;
      let start = cut;
      while (start > 1 && insideFigure(rest, start)) start--;
      if (start > 1) cut = start;
    }
    cut = Math.min(Math.max(cut, 1), rest.length);
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Runs fn over items with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const wordKey = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Joins transcripts of chunks that overlap in time. The same words appear at the end of one chunk and the start of the
 * next, so this finds the longest run they share (allowing up to two cut-off words at each seam) and keeps it once.
 */
export function joinOverlappingTranscripts(parts: string[]): string {
  let words: string[] = [];
  for (const part of parts) {
    const next = part.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      words = next;
      continue;
    }
    const tail = words.map(wordKey);
    const head = next.map(wordKey);
    let joined = false;
    search: for (let k = Math.min(16, words.length, next.length); k >= 2; k -= 1) {
      for (let trimA = 0; trimA <= 2; trimA += 1) {
        for (let trimB = 0; trimB <= 2; trimB += 1) {
          const aStart = tail.length - trimA - k;
          if (aStart < 0 || trimB + k > head.length) continue;
          let equal = true;
          for (let i = 0; i < k; i += 1) {
            if (tail[aStart + i] !== head[trimB + i]) {
              equal = false;
              break;
            }
          }
          if (equal) {
            words = words.slice(0, tail.length - trimA).concat(next.slice(trimB + k));
            joined = true;
            break search;
          }
        }
      }
    }
    if (!joined) words = words.concat(next);
  }
  return words.join(" ");
}
