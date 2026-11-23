
/**
 * Removes secret-looking spans from text, leaving everything around them. Pure and shared: the agent server applies it to every inbound
 * message before it is stored or any turn reads it, and the channel gateway applies it before text goes to the reaction picker.
 *
 * It is a heuristic and misses keys; the model's own rule (extensions/persona/layers/reference.md) is the backstop. It replaces only the secret itself,
 * never the whole message. What it matches:
 *   1. a known token shape: a provider prefix (`sk_live_`, `ghp_`, `SG.`, `xox`, `AKIA`, ...), a JWT, a private-key block, a Bearer
 *      credential, a Slack or Discord webhook path or a Telegram bot token, whose body looks random. A body of hyphen- or underscore-separated words
 *      (`sk-this-is-a-long-product-handle`) is not a key. Only this makes `confident` true;
 *   2. a label (api key, password, pass, pw, login, token, secret, key, Hebrew labels) followed by `:`/`=`, "is", a possessive or nothing, then
 *      ONE token of 12+ characters that mixes letters and digits and is neither a date nor hyphenated words (`password: hunter2hunter2`);
 *   3. `user:password@host` in a link, and the same label-and-value rule for `?key=` style parameters;
 *   4. a long run of letters and digits with high entropy anywhere in a sentence, unless it is a UUID, a SKU-style code of short parts, a
 *      hash-shaped number, a path, words run together, or an id with one of the provider's own id prefixes (`trk_...`). Never inside a link:
 *      a link's path, query values and fragment carry ids the owner wants opened (a Google Sheets or Drive file id, a Notion page id, a
 *      Figma file key), so a link loses only what 1 to 3 find in it.
 * Marley's own recall ids are exempt from 4 (and, as a labelled value, from rule 2), exactly and nowhere else (`RECALL_ID_SHAPES`): `tsk_` plus a
 * 26-character Crockford ULID (`newTaskId`), and `recall:<kind>:<key>` with the key the ledger mints (UUID for an artifact, `tsk_<ULID>` for a task,
 * 32 lowercase hex for a report or session; the hex forms are exempt as a whole token by `scanAround`). A different length or alphabet is still a
 * key, and a strong label (`password: tsk_...`, Hebrew `סיסמה`, `secret token: tsk_...`, any link parameter) still wins; only a bare `key` or `token` does not.
 * `confident` is true only for 1. A weaker match is still scrubbed, but never makes the agent speak in a group that did not mention it.
 *
 * Fixed-format secrets (`SG.`, `ghp_`, `AKIA`, `shpat_`, JWT, private key, Slack webhook) never depend on the word check; only the
 * shapes with a loose body (`sk-`, Bearer, `xox`, `AIza`, `EA*`, `EZ*`) do. A word body is separated words and plain numbers only: one random part makes it a key.
 *
 * Accepted and stated misses: a plain word after a label (`the password is correcthorse`, `token: abcdefghijklmnop`), a lowercase or
 * mixed-case token with no digit (also a prefixed `sk-`, Bearer, `xox` or `AIza` body of letters only), a value made only of separated words
 * and plain numbers (`password: correct-horse-battery-2026`, a passphrase), a label-less value in a link (`?foo=hunter2hunter2`) or a bare key in a link's path
 * that has no known shape (`https://api.example.com/<key>/x`), a key split in pieces or spelled out, and
 * anything in an image or a document.
 */
export const CREDENTIAL_MARKER = "[the server removed a secret key or password from this message]";

/** A body made ONLY of separated words (in any case) and plain numbers, with at least two words (`this-is-a-long-product-handle`, `Black-Friday-Landing-Page`, `customers_table_export_2026_full`) is a name, not a key. */
function wordy(body: string): boolean {
  const parts = body.split(/[-_/.]/).filter(Boolean);
  return parts.filter((part) => /^[A-Za-z]{2,12}$/.test(part)).length >= 2 && parts.every((part) => /^[A-Za-z]{2,12}$/.test(part) || /^[0-9]+$/.test(part));
}

/** The body of a prefixed token (`sk_live_X`, `Bearer X`, `xoxb-X`, `ghp_X`): what follows its provider prefix. */
const bodyOf = (token: string): string => token.replace(/^[A-Za-z]+[-_.\s]+(?:(?:live|test|proj|ant)[-_])?/, "");

/** A prefixed token is a key only if its body really mixes letters and digits and is not separated words: a name, a plain word or a number is none. */
const randomBody = (body: string): boolean => /[A-Za-z]/.test(body) && /[0-9]/.test(body) && !wordy(body);

const PREFIXED: readonly RegExp[] = [
  /\b(?:sk|rk|pk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

/** Shapes whose body after the provider prefix must also look random (a mix of letters and digits, not words). */
const BODY_SHAPES: readonly RegExp[] = [
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bEA[A-Z][A-Za-z0-9]{40,}/g,
  /\b(?:EZ[A-Z]{2}|EZ[A-Z]K)[A-Za-z0-9]{24,}/g,
];

const SHAPES: readonly RegExp[] = [
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bshp(?:at|ca|pa|ss)_[A-Fa-f0-9]{32}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{8,}/g,
  // Links whose path is itself the secret, now that a link's path is otherwise kept.
  /\bhttps?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{8,}\/[A-Za-z0-9_-]{20,}/g,
  /\b(?:bot)?[0-9]{6,12}:AA[A-Za-z0-9_-]{30,40}\b/g,
];

const LABEL = String.raw`(?:api[ _-]?key|apikey|secret(?:[ _-]?key)?|access[ _-]?token|auth[ _-]?token|token|pass[ _-]?phrase|passcode|password|passwd|pwd|pw|pass|login|client[ _-]?secret|private[ _-]?key|key)`;
const OPEN = String.raw`["'“\u0060]?`;
const VALUE = String.raw`([^\s"'”\u0060,;)]{12,200})`;
const CONNECTOR = String.raw`(?:\s*[:=]\s*|\s+(?:is|are|was)\s*:?\s*|\s+)`;
/** `password: X`, `the password is X`, `my password X`, `pw X`: the label, an optional connector, then one token. */
const LABELLED = new RegExp(String.raw`(\b${LABEL}\b["']?${CONNECTOR}${OPEN})${VALUE}`, "giu");
const HEBREW = new RegExp(String.raw`((?:ה?סיסמה|ה?סיסמא|ה?מפתח|ה?טוקן)(?:\s+שלי)?(?:\s*[:=]\s*|\s+(?:הוא|היא)\s+|\s+)["'“]?)([^\s"'”,;)]{12,200})`, "gu");
const URL_PARAM = /([?&;](?:api[_-]?key|apikey|key|token|access_token|auth|auth_token|secret|client_secret|password|pwd|sig|signature)=)([^&\s#"']{12,})/gi;
const URL_USERINFO = /(\bhttps?:\/\/[^\s/@:]+:)([^\s/@]{3,})(@)/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[./]\d{1,2}[./]\d{2,4}/;
/** Prefixes of EasyPost's own object ids (`trk_<hex>`): ids, not secrets, so the paste guard leaves them alone. */
const ID_PREFIXES = new Set(["shp", "trk", "adr", "prcl", "order", "pickup", "pickuprate", "cstinfo", "batch", "rate"]);

/** The ids Marley itself mints (tasks/schema.ts `newTaskId`, recall/objects.ts): anchored by the caller, exact length and alphabet, no prefix allowlist. */
const TASK_ULID = String.raw`tsk_[0-9A-HJKMNP-TV-Z]{26}`;
const BARE_TASK_ID = new RegExp(`^${TASK_ULID}$`);
const RECALL_ID_SHAPES = String.raw`recall:(?:task:${TASK_ULID}|artifact:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:report|session):[0-9a-f]{32})`;
const EDGE = String.raw`[A-Za-z0-9]`;
/** A whole recall id inside a chunk: not glued to a letter or digit on either side (a longer run is a different length). Anything else beside it is scanned on its own by `scanAround`, so nothing can hide next to an id. */
const RECALL_ID_IN_TEXT = new RegExp(String.raw`(?<!${EDGE})${RECALL_ID_SHAPES}(?!${EDGE})`, "g");
const MARLEY_ID = new RegExp(`^(?:${TASK_ULID}|${RECALL_ID_SHAPES})$`);

const STRONG_LABEL = /\b(?:api[ _-]?key|apikey|secret|password|passwd|pwd|pw|pass|pass[ _-]?phrase|passcode|login|private[ _-]?key|access[ _-]?token|auth[ _-]?token|api[ _-]?token|client[ _-]?secret)\b/i;

/** A value after a label: one token of 12+ characters mixing letters and digits, not a date, not hyphenated words. */
const HEBREW_STRONG = /ס[יי]סמ[הא]/u;
const strongLabel = (text: string): boolean => STRONG_LABEL.test(text) || HEBREW_STRONG.test(text);
/** The two words before a match (looked for in the last 120 characters only, so the cost per label stays constant): `secret token: X` matches from `token`, but its `secret` still makes the value a password. */
const wordsBefore = (whole: string, offset: number): string => /(?:\S+\s+){0,2}$/.exec(whole.slice(Math.max(0, offset - 120), offset))?.[0] ?? "";

function labelledSecret(raw: string, head = "", before = "", marleyIdIsSecret = false): boolean {
  const value = raw.replace(/[.,;:!?)\]]+$/, "");
  // A password-like label beats an id prefix (`password: rate_<random>`); only a bare `key` or `token` may name an id. The same holds for Marley's own ids,
  // judged on the two words before the value too, and a link parameter never names one.
  const providerOk = !hasProviderIdPrefix(value) || strongLabel(head);
  const marleyOk = !MARLEY_ID.test(value) || strongLabel(before + head) || marleyIdIsSecret;
  return providerOk && marleyOk && value.length >= 12 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !DATE.test(value) && !wordy(value);
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / value.length; bits -= p * Math.log2(p); }
  return bits;
}

/** The share of a token's letters that sit in words of 3+ letters (Blue, Cream, Summer, spring): high for run-together words, low for a random key. */
function wordShare(token: string): number {
  const letters = (token.match(/[A-Za-z]/g) ?? []).length;
  if (!letters) return 0;
  const inWords = (token.match(/[A-Z][a-z]{2,}|[a-z]{3,}|[A-Z]{3,}(?![a-z])/g) ?? []).join("").length;
  return inWords / letters;
}

/** An id of the provider's own kind (`trk_...`, in any case), also as the last part of a path or a `name=` pair. */
function hasProviderIdPrefix(token: string): boolean {
  const last = token.split(/[/=:]/).pop() ?? "";
  const prefix = /^([A-Za-z]{2,12})_[A-Za-z0-9]+$/.exec(last)?.[1]?.toLowerCase();
  return prefix !== undefined && ID_PREFIXES.has(prefix);
}

/** A run of key characters anywhere in text that is, by its shape, a random token with letters and digits. */
export function looksLikeKey(raw: string): boolean {
  const token = raw.replace(/^[-_=/+]+|[-_=/+]+$/g, "");
  if (token.length < 20 || token.length > 200 || UUID.test(token) || /^[0-9]+$/.test(token) || hasProviderIdPrefix(token) || BARE_TASK_ID.test(token)) return false;
  if ((token.match(/\//g) ?? []).length >= 2) return false;
  const parts = token.split(/[-_]/);
  if (parts.length >= 3 && parts.every((part) => part.length <= 10)) return false;
  const digits = (token.match(/[0-9]/g) ?? []).length;
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  if (/^[0-9a-f]+$/i.test(token) && [32, 40, 64].includes(token.length)) return true;
  if (digits === 0 || (!hasLower && !hasUpper) || wordShare(token) >= 0.7) return false;
  return digits / token.length <= 0.7 && (hasLower && hasUpper ? entropy(token) >= 3.2 : entropy(token) >= 3.6);
}

const scanChunk = (chunk: string): string => chunk.replace(/[A-Za-z0-9_+/=-]{20,200}/g, (run) => (looksLikeKey(run) ? CREDENTIAL_MARKER : run));
/** A word that is a link: a scheme, `www.`, or a domain followed by a path (`docs.google.com/spreadsheets/d/...`). */
const LINK = /^[("'<[]*(?:https?:\/\/|www\.|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\/)/i;
/** Scans a chunk but leaves each whole recall id in it alone; every other piece is scanned as before. */
function scanAround(chunk: string, scan: (piece: string) => string): string {
  let out = "";
  let last = 0;
  for (const match of chunk.matchAll(RECALL_ID_IN_TEXT)) {
    out += scan(chunk.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + scan(chunk.slice(last));
}

/** The text with every secret-looking span replaced by the marker, whether anything was, and whether any of it was a known token shape. */
export function scrubCredentials(text: string): { text: string; found: boolean; confident: boolean } {
  let out = text;
  let confident = false;
  const mark = (): string => { confident = true; return CREDENTIAL_MARKER; };
  // Fixed formats first, then the loose prefixes, then the shapes that can sit inside another key (`EZ*`, `EA*`, `AIza`): a whole SendGrid
  // key must go before an `-EZ...` inside its secret part can take a piece of it.
  for (const shape of SHAPES) out = out.replace(shape, mark);
  for (const shape of [...PREFIXED, ...BODY_SHAPES]) out = out.replace(shape, (all) => (randomBody(bodyOf(all)) ? mark() : all));
  out = out.replace(URL_PARAM, (all, head: string, value: string) => (labelledSecret(value, "", "", true) ? head + CREDENTIAL_MARKER : all));
  out = out.replace(URL_USERINFO, (_all, head: string, _secret: string, at: string) => head + CREDENTIAL_MARKER + at);
  out = out.replace(LABELLED, (all, head: string, value: string, offset: number, whole: string) => (labelledSecret(value, head, wordsBefore(whole, offset)) ? head + CREDENTIAL_MARKER : all));
  out = out.replace(HEBREW, (all, head: string, value: string, offset: number, whole: string) => (labelledSecret(value, head, wordsBefore(whole, offset)) ? head + CREDENTIAL_MARKER : all));
  // Any other word of the message. A link was already checked for known shapes, its login and its named parameters above; the rest of it is
  // the address the owner wants opened (file ids look random by design), so it is kept whole.
  out = out.replace(/\S+/g, (chunk) => (chunk.includes(CREDENTIAL_MARKER) || LINK.test(chunk) ? chunk : scanAround(chunk, scanChunk)));
  return { text: out, found: out !== text, confident };
}
