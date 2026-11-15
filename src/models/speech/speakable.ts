// Lifted from packages/speech/src/speakable.ts (zygstinct 940a0c6d5) so every SDK host gets Marley's speech providers natively.
import { shortLanguage } from "./language.js";
import { SpeechError } from "./types.js";

/*
 * Makes reply text safer for a speech model. This is a backstop, not an editor: Marley's rule is that voice carries the
 * take and text carries the exact figures, so a figure is spoken as words only when it is whole and isolated, and
 * everything else keeps its digits for the voice to read. A digit-heavy note read oddly is an acceptable cost; a wrong
 * figure is not.
 *
 * Conversion is an allowlist. A figure is converted only when the characters on both sides are from a small set:
 *   before: start of text or line, or a plain space that follows a Hebrew word (or starts the line);
 *   after:  a recognised unit (percent, ₪ $ €, or a lexicon noun with its gender), then the end of the phrase or a plain
 *           space and a Hebrew word that is not a scale word.
 * Anything else leaves the digits: other Unicode spaces and format characters, dashes and sign glyphs, brackets, a Hebrew
 * prefix hyphen, a neighbouring number, an unknown qualifier, a Latin or unknown follower. A symbol-first amount ("₪500")
 * converts only before the end of the phrase or a known safe word, because no list of scale words can be complete.
 *
 * Removed material (markdown marks, emoji, links) first becomes a marker. Markers are present while figures are
 * converted, so a removal can never bring two sides together into one figure or let a figure convert across it; they are
 * resolved afterwards, always leaving a separator where text or digits would otherwise join.
 *
 * Measured on the production Gemini voice (docs/knowledge/voice-natural-20261030.md): Hebrew digits can be read with the
 * wrong gender ("14 הזמנות" came back as "ארבעה עשר הזמנות").
 */

const MASC_ONES = ["", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה", "עשרה"];
const FEM_ONES = ["", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע", "עשר"];
const MASC_TEENS = ["עשרה", "אחד עשר", "שנים עשר", "שלושה עשר", "ארבעה עשר", "חמישה עשר", "שישה עשר", "שבעה עשר", "שמונה עשר", "תשעה עשר"];
const FEM_TEENS = ["עשר", "אחת עשרה", "שתים עשרה", "שלוש עשרה", "ארבע עשרה", "חמש עשרה", "שש עשרה", "שבע עשרה", "שמונה עשרה", "תשע עשרה"];
const TENS = ["", "", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים", "שמונים", "תשעים"];
const HUNDREDS = ["", "מאה", "מאתיים", "שלוש מאות", "ארבע מאות", "חמש מאות", "שש מאות", "שבע מאות", "שמונה מאות", "תשע מאות"];
const BOUND_TWO = { masc: "שני", fem: "שתי" } as const;
const THOUSAND_COUNTS = ["", "", "אלפיים", "שלושת אלפים", "ארבעת אלפים", "חמשת אלפים", "ששת אלפים", "שבעת אלפים", "שמונת אלפים", "תשעת אלפים", "עשרת אלפים"];

export type Gender = "masc" | "fem";

function below100(n: number, gender: Gender): string[] {
  if (n === 0) return [];
  if (n <= 10) return [(gender === "fem" ? FEM_ONES : MASC_ONES)[n]!];
  if (n < 20) return [(gender === "fem" ? FEM_TEENS : MASC_TEENS)[n - 10]!];
  const ones = n % 10;
  return ones === 0 ? [TENS[n / 10]!] : [TENS[Math.floor(n / 10)]!, (gender === "fem" ? FEM_ONES : MASC_ONES)[ones]!];
}

function below1000(n: number, gender: Gender): string[] {
  const hundreds = Math.floor(n / 100);
  return [...(hundreds ? [HUNDREDS[hundreds]!] : []), ...below100(n % 100, gender)];
}

/** "ו" goes on the last word of a group of two or more ("מאה ועשרים"). */
const joined = (words: string[]): string[] => (words.length > 1 ? [...words.slice(0, -1), `ו${words.at(-1)}`] : words);

/** An integer from 0 to 999,999 in Hebrew words. */
export function hebrewCardinal(n: number, gender: Gender): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new RangeError("hebrewCardinal supports 0 to 999999");
  if (n === 0) return "אפס";
  const rest = below1000(n % 1000, gender);
  if (n < 1000) return joined(rest).join(" ");
  const count = Math.floor(n / 1000);
  const head = count === 1 ? ["אלף"] : count <= 10 ? [THOUSAND_COUNTS[count]!] : [...joined(below1000(count, "masc")), "אלף"];
  // After thousands a single remaining word still takes "ו" ("אלף ומאה"); none remaining takes nothing ("חמישה עשר אלף").
  return [...head, ...(rest.length ? [...rest.slice(0, -1), `ו${rest.at(-1)}`] : [])].join(" ");
}

const FEM_PLURAL = "הזמנות מודעות שעות דקות שניות חולצות יחידות פעמים דרכים שנים מילים משימות הודעות קבוצות חנויות מכירות עסקאות צפיות קטגוריות גרסאות הצעות תמונות";
const MASC_PLURAL = "לקוחות שבועות מקומות חשבונות מוצרים ימים חודשים אנשים קמפיינים סטים פריטים משתמשים עובדים קליקים אתרים דפים מיילים קבצים ילדים";
const FEM_SINGULAR = "הזמנה מודעה שעה דקה שנייה חולצה יחידה פעם משימה הודעה קבוצה חנות מכירה עסקה צפייה קטגוריה גרסה הצעה תמונה";
const MASC_SINGULAR = "לקוח מקום חשבון מוצר יום חודש שבוע קמפיין סט פריט משתמש עובד קליק אתר דף מייל קובץ ילד";

const entries = (list: string, gender: Gender) => list.split(" ").map((word) => [word, gender] as const);
const PLURALS = new Map<string, Gender>([...entries(FEM_PLURAL, "fem"), ...entries(MASC_PLURAL, "masc")]);
const SINGULARS = new Map<string, Gender>([...entries(FEM_SINGULAR, "fem"), ...entries(MASC_SINGULAR, "masc")]);

/** Gender of a noun from the lexicon, or undefined when the word is not listed. There is no guess from the ending. */
export function hebrewNounGender(noun: string): Gender | undefined {
  return PLURALS.get(noun) ?? SINGULARS.get(noun);
}

const SYMBOLS = new Set(["₪", "$", "€"]);
const HEBREW_LETTER = /[א-ת]/;
const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g;
const DIGIT_WORDS = ["אפס", "אחת", "שתיים", "שלוש", "ארבע", "חמש", "שש", "שבע", "שמונה", "תשע"];
const SCALE_HEBREW = /^[ובכלמשה]{0,2}(?:אלף|אלפ|מיל|מלי|ביל|טריל|טרי)/;
/** Words that may follow a symbol-first amount ("₪500 לחודש"). Not a scale word of any language. */
const SAFE_AFTER_SYMBOL = new Set(["לחודש", "בחודש", "לשבוע", "בשבוע", "ליום", "ביום", "לשנה", "בשנה", "להזמנה", "ללקוח", "על"]);

function currencyWords(symbol: string, value: number): string {
  const [one, two, many] = symbol === "₪" ? ["שקל", "שקלים", "שקלים"] : symbol === "$" ? ["דולר", "דולרים", "דולר"] : ["יורו", "יורו", "יורו"];
  if (value === 1) return `${one} אחד`;
  if (value === 2) return `${BOUND_TWO.masc} ${two}`;
  return `${hebrewCardinal(value, "masc")} ${many}`;
}

type Spoken = { from: number; to: number; words: string; figure: string };

/** Hebrew number words (both genders, bound forms, thousands), so a figure is never written next to one and read as a larger number. */
const NUMBER_WORDS = new Set<string>(["מינוס", "נקודה", "שני", "שתי", "שניים", "שנים", "שתים", "אלפיים", "אלפים", "מאות", "מאתיים", "שלושת", "ארבעת", "חמשת", "ששת", "שבעת", "שמונת", "תשעת", "עשרת"]);
for (let n = 0; n <= 1000; n += n < 20 ? 1 : n < 100 ? 10 : 100) {
  for (const gender of ["masc", "fem"] as const) for (const word of hebrewCardinal(n, gender).split(" ")) NUMBER_WORDS.add(word.replace(/^ו(?=.)/, ""));
}
const isNumberWord = (word: string): boolean => [word, word.slice(1), word.slice(2)].some((form) => NUMBER_WORDS.has(form) || (form.length > 2 && SCALE_HEBREW.test(form)));

/** Start of text or line, or one plain space after a Hebrew word that is not a number word. Nothing else may precede a figure. */
function isolatedBefore(text: string, from: number): boolean {
  if (from === 0 || text[from - 1] === "\n") return true;
  if (text[from - 1] !== " ") return false;
  if (from === 1 || text[from - 2] === "\n") return true;
  const word = /([א-ת]+) $/.exec(text.slice(Math.max(0, from - 21), from))?.[1];
  return word !== undefined && !isNumberWord(word);
}

const endsPhrase = (rest: string): boolean => rest === "" || rest[0] === "\n" || /^[.,;:!?](?:$|[ \n])/.test(rest);
/** One plain space, then a Hebrew word that is neither a scale word nor a number word (spoken "אחד" must not run into "עשר"). */
const hebrewFollower = (rest: string): boolean => {
  if (rest[0] !== " " || !HEBREW_LETTER.test(rest[1] ?? "")) return false;
  const word = /^[א-ת]+/.exec(rest.slice(1))![0];
  return !SCALE_HEBREW.test(rest.slice(1)) && !isNumberWord(word);
};
const safeAfterSymbol = (rest: string): boolean => {
  if (endsPhrase(rest)) return true;
  if (rest[0] !== " ") return false;
  const word = /^[א-ת]+/.exec(rest.slice(1))?.[0];
  return word !== undefined && SAFE_AFTER_SYMBOL.has(word) && /^(?:$|[ \n.,;:!?])/.test(rest.slice(1 + word.length));
};

/** The words for one digit string and what surrounds it, or undefined to leave the text exactly as written. */
function speak(text: string, start: number, digits: string, decimals: string | undefined): Spoken | undefined {
  const end = start + digits.length + (decimals?.length ?? 0);
  const plain = digits.replace(/,/g, "");
  if (plain.length > 6 || (plain.length > 1 && plain.startsWith("0"))) return undefined;
  const value = Number(plain);
  const figure = plain + (decimals ?? "");

  let from = start;
  let negative = false;
  let symbolFirst = "";
  if (text[from - 1] === "-") {
    negative = true;
    from -= 1;
  }
  if (SYMBOLS.has(text[from - 1] ?? "")) {
    symbolFirst = text[from - 1]!;
    from -= 1;
    if (!negative && text[from - 1] === "-") {
      negative = true;
      from -= 1;
    }
  }
  if (!isolatedBefore(text, from)) return undefined;
  const sign = negative ? "מינוס " : "";
  const rest = text.slice(end);

  if (rest[0] === "%") {
    const after = rest.slice(1);
    if (symbolFirst || !(endsPhrase(after) || hebrewFollower(after))) return undefined;
    const words = decimals ? `${hebrewCardinal(value, "fem")} נקודה ${[...decimals.slice(1)].map((d) => DIGIT_WORDS[Number(d)]).join(" ")} אחוז` : value === 1 ? "אחוז אחד" : value === 2 ? "שני אחוזים" : `${hebrewCardinal(value, "masc")} אחוז`;
    return { from, to: end + 1, words: sign + words, figure };
  }
  if (decimals) return undefined;

  if (symbolFirst) {
    return safeAfterSymbol(rest) ? { from, to: end, words: sign + currencyWords(symbolFirst, value), figure } : undefined;
  }
  const trailing = /^ ?([₪$€])/.exec(rest);
  if (trailing) {
    const after = rest.slice(trailing[0].length);
    return endsPhrase(after) || hebrewFollower(after) ? { from, to: end + trailing[0].length, words: sign + currencyWords(trailing[1]!, value), figure } : undefined;
  }
  if (negative) return undefined;

  const noun = /^ ([א-ת]+)/.exec(rest);
  if (noun) {
    const word = noun[1]!;
    const after = rest.slice(noun[0].length);
    const plural = PLURALS.get(word);
    const singular = SINGULARS.get(word);
    const to = end + noun[0].length;
    if (plural && value !== 1 && (endsPhrase(after) || hebrewFollower(after))) {
      return { from, to, words: value === 2 ? `${BOUND_TWO[plural]} ${word}` : `${hebrewCardinal(value, plural)} ${word}`, figure };
    }
    // "1 דף נחיתה" is a compound: a singular is rewritten only when the noun ends the phrase.
    if (singular && value === 1 && endsPhrase(after)) return { from, to, words: `${word} ${singular === "fem" ? "אחת" : "אחד"}`, figure };
  }
  // "בן/בת N" only at the end of the phrase, never before a noun ("דירה בת 5 חדרים").
  if (value >= 2 && value <= 120 && endsPhrase(rest) && text[from - 1] === " " && /(?:^|[\n ])ב[ןת]$/.test(text.slice(0, from - 1))) {
    return { from, to: end, words: hebrewCardinal(value, "fem"), figure };
  }
  return undefined;
}

/** Converts what is fully recognised and reports which figures (digits without commas) were written as words. */
export function spellHebrewNumbersTraced(text: string): { text: string; figures: string[] } {
  let out = "";
  let cursor = 0;
  const figures: string[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const spoken = speak(text, match.index!, match[1]!, match[2]);
    if (!spoken || spoken.from < cursor) continue;
    out += text.slice(cursor, spoken.from) + spoken.words;
    cursor = spoken.to;
    figures.push(spoken.figure);
  }
  return { text: out + text.slice(cursor), figures };
}

/** Writes digits as words where the whole figure is isolated and recognised; everything else is unchanged. */
export function spellHebrewNumbers(text: string): string {
  return spellHebrewNumbersTraced(text).text;
}

/** Latin names a Hebrew-speaking owner says in Hebrew. Anything not listed is left as typed. */
const HEBREW_LOANWORDS: Record<string, string> = {
  roas: "רואס",
  meta: "מטא",
  shopify: "שופיפיי",
  facebook: "פייסבוק",
  instagram: "אינסטגרם",
  google: "גוגל",
  whatsapp: "וואטסאפ",
  tiktok: "טיקטוק",
  klaviyo: "קלאביו",
  ok: "אוקיי",
  okay: "אוקיי",
};

const LATIN_WORD = /[A-Za-z]+/g;
const SINGLE_PREFIX = /^ו?[הבכלמש]$/;

/**
 * Spells known Latin names in Hebrew letters, only as whole words inside a Hebrew sentence. A one-letter Hebrew prefix
 * written with a hyphen joins the name ("ה-ROAS" becomes "הרואס"); a longer word keeps its hyphen ("של-Meta" becomes
 * "של-מטא"). Emails, domains, paths, hashtags and words with digits or other letters attached are never touched.
 */
export function spellHebrewLoanwords(text: string): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(LATIN_WORD)) {
    const word = HEBREW_LOANWORDS[match[0].toLowerCase()];
    const at = match.index!;
    const end = at + match[0].length;
    if (!word) continue;
    const next = text[end] ?? "";
    const previous = text[at - 1] ?? "";
    if (/[\p{L}\p{N}_@/:#]/u.test(next) || (next === "." && /[\p{L}\p{N}]/u.test(text[end + 1] ?? ""))) continue;
    if (/^[-־][A-Za-z0-9_]/.test(text.slice(end, end + 2)) || /@/.test(/\S*$/.exec(text.slice(0, end))![0] + /^\S*/.exec(text.slice(end))![0])) continue;
    let from = at;
    let joinPrefix = false;
    if (previous === "-" || previous === "־") {
      const hebrewBefore = /([א-ת]+)$/.exec(text.slice(0, at - 1))?.[1];
      if (!hebrewBefore) continue;
      joinPrefix = SINGLE_PREFIX.test(hebrewBefore);
      if (joinPrefix) from = at - 1;
    } else if (previous && /[\p{L}\p{N}_@.:/#]/u.test(previous)) continue;
    const sentenceStart = Math.max(text.lastIndexOf(".", at), text.lastIndexOf("!", at), text.lastIndexOf("?", at), text.lastIndexOf("\n", at)) + 1;
    const sentenceEndRaw = [".", "!", "?", "\n"].map((mark) => text.indexOf(mark, end)).filter((i) => i >= 0);
    const sentence = text.slice(sentenceStart, sentenceEndRaw.length ? Math.min(...sentenceEndRaw) : text.length);
    if (!HEBREW_LETTER.test(sentence)) continue;
    if (from < cursor) continue;
    out += text.slice(cursor, from) + word;
    cursor = end;
  }
  return out + text.slice(cursor);
}

const SPACE = "\uE000";
const BLOCK = "\uE001";
const EMOJI = "(?:[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u{1F3FB}-\\u{1F3FF}\\u200d\\ufe0e\\ufe0f\\u{E0020}-\\u{E007F}])+";
/** A digit keycap that starts a line and is followed by text. */
const KEYCAP_LINE = /^[ \t]*([0-9])\ufe0f?\u20e3[ \t]+(?=\p{L})/gmu;
const KEYCAP = /[0-9#*]\ufe0f?\u20e3/gu;
const URL_CORE = "(?:https?:\\/\\/|www\\.)[^\\s<>\"')\\]\\uE000\\uE001]*[^\\s<>\"')\\].,;:!?׳״\\uE000\\uE001]";

/**
 * Line-start keycaps are list markers only when they run 1, 2, 3, ... from 1 on at least two adjacent lines (blank lines
 * may sit between them; a list with continuation lines keeps its digits, which is cheaper than losing a figure). Any other keycap
 * carries a figure and stays a digit ("1️⃣ לקוח" then "2️⃣ הזמנות" counts as a list: a known ambiguity).
 */
function markKeycapList(text: string): string {
  const lines = [...text.matchAll(KEYCAP_LINE)].map((match) => ({ at: match.index!, digit: Number(match[1]), after: match.index! + match[0].length }));
  const list = new Set<number>();
  for (let i = 0; i < lines.length; ) {
    let last = i;
    // The numbered lines must be adjacent: the rest of one line, then only blank lines, then the next keycap line.
    const adjacent = (k: number): boolean => /^[^\n]*\n(?:[ \t]*\n)*$/.test(text.slice(lines[k]!.after, lines[k + 1]!.at));
    if (lines[i]!.digit === 1) while (last + 1 < lines.length && lines[last + 1]!.digit === lines[last]!.digit + 1 && adjacent(last)) last++;
    if (last > i) for (let k = i; k <= last; k++) list.add(lines[k]!.at);
    i = last + 1;
  }
  return text.replace(KEYCAP_LINE, (all, _digit: string, at: number) => (list.has(at) ? SPACE : all));
}

/**
 * First phase of cleaning: replaces what a person never says (markdown marks, emoji, links, list markers) with a marker.
 * The text of a markdown link is kept between markers. Markers block figure conversion and are resolved afterwards.
 */
function markRemovals(raw: string): string {
  const emoji = new RegExp(EMOJI, "gu");
  return markKeycapList(raw
    .replace(/[\uE000\uE001]/g, SPACE)
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp(`\\[([^\\]\\n]+)\\]\\(\\s*${URL_CORE}(?:\\s+"[^"\\n]*")?\\s*\\)`, "giu"), `${SPACE}$1${SPACE}`)
    .replace(new RegExp(`[<("'“”‘’]\\s*${URL_CORE}\\s*[>)"'“”‘’]`, "giu"), SPACE)
    .replace(/`+/g, SPACE)
    .replace(/\*\*([^*\n]+)\*\*/g, `${SPACE}$1${SPACE}`)
    .replace(/__([^_\n]+)__/g, `${SPACE}$1${SPACE}`)
    .replace(/~~([^~\n]+)~~/g, `${SPACE}$1${SPACE}`)
    .replace(/(^|[\s(]|[א-ת][-־])\*([^*\s][^*\n]*?)\*(?=$|[\s.,!?;:)])/g, `$1${SPACE}$2${SPACE}`)
    .replace(new RegExp(`(^|[\\s:,;\\uE000])(?:[הובכלמש]{1,2}[-־])?${URL_CORE}`, "giu"), (_all, lead: string) => `${lead}${SPACE}`)
    .replace(/^[ \t]*#{1,6}[ \t]+(?=\p{L})/gmu, SPACE)
    .replace(/^[ \t]*>[ \t]+(?=\p{L})/gmu, SPACE)
    .replace(/^[ \t]*-[ \t]+(?=\p{L})/gmu, SPACE)
    .replace(/^[ \t]*[•*][ \t]+/gm, SPACE)
    )
    .replace(KEYCAP, (cap) => `${BLOCK}${cap[0]}${BLOCK}`)
    .replace(/\u{1F51F}\ufe0f?/gu, `${SPACE}10${SPACE}`)
    .replace(emoji, SPACE);
}

/** True when removing a marker between these two pieces would write one number out of two, or attach a sign to a figure. */
const wouldJoinNumbers = (before: string, after: string): boolean =>
  (/\d$/.test(before) && /^[.,]?\d/.test(after)) || (/\d[.,]$/.test(before) && /^\d/.test(after)) || (/[-־]$/.test(before) && /^[₪$€]?[.,]?\d/.test(after));

/** Second phase: markers become a separator, or nothing at a line edge or before punctuation. Digits never join. */
function resolveRemovals(marked: string): string {
  return marked
    .replace(/[ \t]*\uE000(?:[ \t]*\uE000)*[ \t]*/g, (all, offset: number, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 6), offset).replace(/\uE001/g, "").slice(-3);
      const after = whole.slice(offset + all.length, offset + all.length + 6).replace(/\uE001/g, "").slice(0, 3);
      if (wouldJoinNumbers(before, after)) return " ";
      if (before === "" || after === "" || /[\s\-־([]$/.test(before) || /^[\s.,!?;:)\]]/.test(after)) return "";
      return " ";
    })
    .replace(/\uE001/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes what a person never says: markdown marks, emoji (skin tones, flags, list keycaps) and links, including a Hebrew
 * prefix glued to one and a link wrapped in quotes, brackets or emphasis. The text of a markdown link is kept. A keycap
 * carrying a figure stays as the digit. Qualifiers (# ~ > <) and dashes between figures are left alone.
 */
export function stripNonSpeech(text: string): string {
  return resolveRemovals(markRemovals(text));
}

/** prepareSpokenText, also reporting the figures (digits without commas) that were written as words. */
export function prepareSpokenTextTraced(text: string, language: string): { text: string; figures: string[] } {
  const he = shortLanguage(language) === "he";
  const marked = markRemovals(text);
  const converted = he ? spellHebrewNumbersTraced(marked) : { text: marked, figures: [] };
  const spoken = resolveRemovals(converted.text);
  return { text: he ? spellHebrewLoanwords(spoken) : spoken, figures: converted.figures };
}

/** The text to send to a speech model: cleaned for speech, and for Hebrew also with whole recognised figures and known names written as words. */
export function prepareSpokenText(text: string, language: string): string {
  return prepareSpokenTextTraced(text, language).text;
}

/**
 * The text to synthesize, within the provider's limit. Writing figures as words makes text longer, and audio size follows the spoken length, so the limit is checked on what is
 * spoken: if the expanded text is over it, the note is spoken with the digits as written; if that is over it too, the
 * reply is refused so the caller sends text. Text with no letter or digit after cleaning has nothing to say.
 */
export function speakableWithinLimit(text: string, language: string, maxChars: number): string {
  if (!text.trim()) throw new SpeechError("bad-request", "text is empty");
  const clean = stripNonSpeech(text);
  if (!/[\p{L}\p{N}]/u.test(clean)) throw new SpeechError("bad-request", "text has nothing to say");
  const prepared = prepareSpokenText(text, language);
  if (prepared.length <= maxChars) return prepared;
  if (clean.length <= maxChars) return clean;
  throw new SpeechError("text-too-long", `text is ${clean.length} characters, limit ${maxChars}; shorten the reply`);
}
