/**
 * Member preferences: the small, style-only settings a person gives Marley about how it talks to them. The server
 * renders them into every turn the person speaks in. Design: docs/plans/always-on-preferences.md.
 *
 * Dependency-free on purpose: the web app (edit form, API) and the agent server (chat intent, prompt) use the same
 * validator, so the rules cannot drift between them.
 */

export const MEMBER_PREFERENCES_VERSION = 1 as const;

export const REPLY_FORMATS = ["text", "voice", "voice+text"] as const;
export type ReplyFormat = (typeof REPLY_FORMATS)[number];

/** The same values as the brand persona (apps/agent-server/src/persona.ts); the server tests assert they match. */
export const PREFERENCE_TONES = ["warm-direct", "professional", "casual", "analytical"] as const;
export type PreferenceTone = (typeof PREFERENCE_TONES)[number];

export const PREFERENCE_LENGTHS = ["brief", "balanced", "detailed"] as const;
export type PreferenceLength = (typeof PREFERENCE_LENGTHS)[number];

export const PREFERENCE_LIMITS = {
  preferredNameMax: 40,
  noteMax: 300,
  /** Serialized size of the whole object. */
  totalBytesMax: 1024,
} as const;

/** One person's preferences. A missing field means "no preference": the brand persona and then the built-in default apply. */
export interface MemberPreferences {
  version: typeof MEMBER_PREFERENCES_VERSION;
  /** How Marley addresses the person, for example "Mr T". */
  preferredName?: string;
  /** A language tag such as "he" or "en-GB", or "match-user" to answer in the language of the message. */
  language?: string;
  replyFormat?: ReplyFormat;
  tone?: PreferenceTone;
  length?: PreferenceLength;
  /** Free text about style, quoted to the model as data. Never instructions about access, recipients, data or tools. */
  note?: string;
}

export const PREFERENCE_FIELDS = ["preferredName", "language", "replyFormat", "tone", "length", "note"] as const;
export type PreferenceField = (typeof PREFERENCE_FIELDS)[number];

/** A change to the stored preferences: fields to set, fields to remove. At least one of the two must be present. */
export interface PreferencePatch {
  set?: Partial<Omit<MemberPreferences, "version">>;
  clear?: PreferenceField[];
}

/** Who a preference change is for. "brand" edits the persona defaults and needs an owner role (see the plan). */
export type PreferenceScope = "me" | "brand";

export type PreferenceSource = "web" | "chat";

export type PreferenceValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const LANGUAGE = /^(match-user|[a-z]{2,3}(?:-[A-Za-z]{2,8})?)$/;
/** Control characters, angle brackets (they could close a prompt tag) and bidi overrides. */
const FORBIDDEN_TEXT = new RegExp("[<>\\u0000-\\u001f\\u007f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");

function textField(value: unknown, field: string, max: number, errors: string[], collapseWhitespace: boolean): string | undefined {
  if (typeof value !== "string") {
    errors.push(`${field} must be text`);
    return undefined;
  }
  const text = collapseWhitespace ? value.replace(/\s+/g, " ").trim() : value.trim();
  if (!text) {
    errors.push(`${field} must not be empty (use clear to remove it)`);
    return undefined;
  }
  if ([...text].length > max) errors.push(`${field} is longer than ${max} characters`);
  else if (FORBIDDEN_TEXT.test(text)) errors.push(`${field} has characters that are not allowed`);
  else return text;
  return undefined;
}

/** Validates the settable fields of a preference object (no version). Unknown keys are refused. Returns the cleaned fields. */
export function validatePreferenceFields(input: unknown): PreferenceValidation<Partial<Omit<MemberPreferences, "version">>> {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["preferences must be an object"] };
  const out: Partial<Omit<MemberPreferences, "version">> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    switch (key) {
      case "preferredName": {
        const name = textField(value, key, PREFERENCE_LIMITS.preferredNameMax, errors, true);
        if (name !== undefined) out.preferredName = name;
        break;
      }
      case "note": {
        const note = textField(value, key, PREFERENCE_LIMITS.noteMax, errors, true);
        if (note !== undefined) out.note = note;
        break;
      }
      case "language":
        if (typeof value === "string" && LANGUAGE.test(value)) out.language = value;
        else errors.push('language must be a language tag such as "he" or "en-GB", or "match-user"');
        break;
      case "replyFormat":
        if ((REPLY_FORMATS as readonly unknown[]).includes(value)) out.replyFormat = value as ReplyFormat;
        else errors.push(`replyFormat must be one of ${REPLY_FORMATS.join(", ")}`);
        break;
      case "tone":
        if ((PREFERENCE_TONES as readonly unknown[]).includes(value)) out.tone = value as PreferenceTone;
        else errors.push(`tone must be one of ${PREFERENCE_TONES.join(", ")}`);
        break;
      case "length":
        if ((PREFERENCE_LENGTHS as readonly unknown[]).includes(value)) out.length = value as PreferenceLength;
        else errors.push(`length must be one of ${PREFERENCE_LENGTHS.join(", ")}`);
        break;
      default:
        errors.push(`unknown preference "${key}"`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/** Parses a stored value (database or file). A damaged or unknown-version value is refused, never repaired. */
export function parseMemberPreferences(input: unknown): PreferenceValidation<MemberPreferences> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["preferences must be an object"] };
  const { version, ...fields } = input as Record<string, unknown>;
  if (version !== MEMBER_PREFERENCES_VERSION) return { ok: false, errors: [`unsupported preferences version ${String(version)}`] };
  const checked = validatePreferenceFields(fields);
  if (!checked.ok) return checked;
  const value: MemberPreferences = { version: MEMBER_PREFERENCES_VERSION, ...checked.value };
  return sizeOk(value) ? { ok: true, value } : { ok: false, errors: ["preferences are too large"] };
}

/** Applies a patch to the current preferences (null: none yet). The result is validated as a whole. */
export function applyPreferencePatch(current: MemberPreferences | null, patch: PreferencePatch): PreferenceValidation<MemberPreferences> {
  const keys = Object.keys(patch.set ?? {}).length + (patch.clear?.length ?? 0);
  if (keys === 0) return { ok: false, errors: ["nothing to change"] };
  const errors: string[] = [];
  for (const field of patch.clear ?? []) if (!(PREFERENCE_FIELDS as readonly string[]).includes(field)) errors.push(`cannot clear unknown preference "${String(field)}"`);
  const set = validatePreferenceFields(patch.set ?? {});
  if (!set.ok) errors.push(...set.errors);
  for (const field of patch.clear ?? []) if (field in (patch.set ?? {})) errors.push(`"${field}" is both set and cleared`);
  if (errors.length || !set.ok) return { ok: false, errors };
  const merged: Record<string, unknown> = { ...(current ?? {}), ...set.value };
  for (const field of patch.clear ?? []) delete merged[field];
  return parseMemberPreferences({ ...merged, version: MEMBER_PREFERENCES_VERSION });
}

function sizeOk(value: MemberPreferences): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).length <= PREFERENCE_LIMITS.totalBytesMax;
}
