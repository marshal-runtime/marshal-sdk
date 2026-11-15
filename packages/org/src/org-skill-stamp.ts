import * as fs from "fs";
import path from "path";

/** The stamp the org skill client writes into each installed organization skill folder. */
export const ORG_SKILL_STAMP_FILE = ".org-skill.json";

export interface OrgSkillStamp {
  name: string;
  version: string;
  sha256: string;
  org: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readJsonRecordSync(file: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8")); // SF-4: validated below
    return isRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

const CURRENT_ORG_FILE = "current-org.json";
export const ORG_KEY = /^[a-z0-9][a-z0-9.-]{0,127}$/;

/** The folder of the recorded organization's skills under `root`, or null before one was recorded. */
export function currentOrgSkillsDir(root: string): string | null {
  const org = readJsonRecordSync(path.join(root, CURRENT_ORG_FILE))?.org;
  return typeof org === "string" && ORG_KEY.test(org) ? path.join(root, org) : null;
}

/** Records which organization's skills to load; kept on disk so they keep working signed out or offline. */
export function recordCurrentOrg(root: string, orgKey: string): void {
  if (!ORG_KEY.test(orgKey)) throw new Error("invalid organization key");
  const file = path.join(root, CURRENT_ORG_FILE);
  if (readJsonRecordSync(file)?.org === orgKey) return;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ org: orgKey }), { mode: 0o600 });
}

export function readOrgSkillStamp(skillDir: string): OrgSkillStamp | undefined {
  const raw = readJsonRecordSync(path.join(skillDir, ORG_SKILL_STAMP_FILE));
  if (!raw) return undefined;
  const { name, version, sha256, org } = raw;
  return typeof name === "string" &&
    typeof version === "string" &&
    typeof sha256 === "string" &&
    typeof org === "string"
    ? { name, version, sha256, org }
    : undefined;
}
