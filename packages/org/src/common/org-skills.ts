/** Organization skills: the skills catalog an organization serves at `GET {apiBase}/v1/onboarding/skills`. */

export type OrgSkillTier = "recommended" | "available";
export type OrgSkillStatus = "approved" | "pending" | "rejected";

export interface OrgSkillEntry {
  name: string;
  version: string;
  tier: OrgSkillTier;
  description: string;
  delivery: { kind: "archive"; sha256: string; bytes: number; url: string };
  files: number;
  status: OrgSkillStatus;
  publisher: string;
  approver?: string;
  publishedAt: string;
  reviewedAt?: string;
  reason?: string;
}

export interface OrgSkillsCatalog {
  isAdmin: boolean;
  recommended: OrgSkillEntry[];
  available: OrgSkillEntry[];
  /** The caller's own pending or rejected versions; every open version for an admin. */
  pending: OrgSkillEntry[];
}

/** Where a personal skill of the same name comes from, when one hides an organization skill. */
export type OrgSkillHiddenBy = "local" | "global" | "bundled";

export interface OrgSkillInstalled {
  version: string;
  /** `update`: the organization serves another version than the one on this computer. */
  state: "current" | "update";
  hiddenBy?: OrgSkillHiddenBy;
}

export type OrgSkillsResult =
  | {
      success: true;
      orgName: string;
      catalog: OrgSkillsCatalog;
      /** By skill name, for the organization skills installed on this computer. */
      installed: Record<string, OrgSkillInstalled>;
      /** Names of this person's own skills (local, global, bundled), to show which org skills they would hide. */
      personal: Record<string, OrgSkillHiddenBy>;
    }
  | { success: false; error: string };

export type OrgSkillActionResult =
  | { success: true; entry?: OrgSkillEntry }
  | { success: false; error: string; detail?: string };

export interface OrgSkillPublishable {
  name: string;
  description: string;
  scope: "local" | "global";
  /** The `version` field of SKILL.md, when it has one. */
  version?: string;
}

export type OrgSkillPublishableResult =
  | { success: true; skills: OrgSkillPublishable[] }
  | { success: false; error: string };

export interface OrgSkillPublishRequest {
  name: string;
  version: string;
}

export type OrgSkillPublishPreviewResult =
  | {
      success: true;
      files: { path: string; bytes: number }[];
      totalBytes: number;
      skipped: string[];
    }
  | { success: false; error: string; detail?: string };

export interface OrgSkillReviewRequest {
  name: string;
  version: string;
  decision: "approve" | "reject";
  reason?: string;
}

export interface OrgSkillUpdateRequest {
  name: string;
  tier?: OrgSkillTier;
  version?: string;
  remove?: boolean;
}

export interface OrgSkillFile {
  path: string;
  text: string;
}

export type OrgSkillReviewFilesResult =
  | {
      success: true;
      files: OrgSkillFile[];
      /** The approved version served today, for comparison; absent for a new skill. */
      previous?: { version: string; files: OrgSkillFile[] };
    }
  | { success: false; error: string; detail?: string };

export const ORG_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ORG_SKILL_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 512;
const MAX_TEXT = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT
    ? value
    : undefined;
}

export function parseOrgSkillEntry(value: unknown): OrgSkillEntry | undefined {
  if (!isRecord(value)) return undefined;
  const delivery = isRecord(value.delivery) ? value.delivery : undefined;
  const { name, version, tier, status, publisher, publishedAt, files } = value;
  if (
    typeof name !== "string" ||
    !ORG_SKILL_NAME.test(name) ||
    typeof version !== "string" ||
    !ORG_SKILL_VERSION.test(version) ||
    (tier !== "recommended" && tier !== "available") ||
    (status !== "approved" && status !== "pending" && status !== "rejected") ||
    typeof publisher !== "string" ||
    typeof publishedAt !== "string" ||
    typeof files !== "number" ||
    !delivery ||
    delivery.kind !== "archive" ||
    typeof delivery.sha256 !== "string" ||
    !SHA256.test(delivery.sha256) ||
    typeof delivery.bytes !== "number" ||
    typeof delivery.url !== "string"
  ) {
    return undefined;
  }
  const approver = optionalText(value.approver);
  const reviewedAt = optionalText(value.reviewedAt);
  const reason = optionalText(value.reason);
  return {
    name,
    version,
    tier,
    description: typeof value.description === "string" ? value.description.slice(0, MAX_TEXT) : "",
    delivery: {
      kind: "archive",
      sha256: delivery.sha256,
      bytes: delivery.bytes,
      url: delivery.url,
    },
    files,
    status,
    publisher,
    publishedAt,
    ...(approver ? { approver } : {}),
    ...(reviewedAt ? { reviewedAt } : {}),
    ...(reason ? { reason } : {}),
  };
}

function entries(value: unknown): OrgSkillEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ENTRIES)
    .map(parseOrgSkillEntry)
    .filter((entry): entry is OrgSkillEntry => entry !== undefined);
}

/** Parses the skills catalog; unknown fields are ignored. Undefined when it is not one. */
export function parseOrgSkillsCatalog(value: unknown): OrgSkillsCatalog | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  return {
    isAdmin: value.isAdmin === true,
    recommended: entries(value.recommended),
    available: entries(value.available),
    pending: entries(value.pending),
  };
}
