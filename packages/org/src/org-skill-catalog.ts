import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../host-deps";
import { stripYamlQuotes } from "../host-deps";
import {
  ORG_SKILL_NAME,
  ORG_SKILL_VERSION,
  parseOrgSkillEntry,
  parseOrgSkillsCatalog,
  type OrgSkillActionResult,
  type OrgSkillEntry,
  type OrgSkillFile,
  type OrgSkillHiddenBy,
  type OrgSkillInstalled,
  type OrgSkillPublishableResult,
  type OrgSkillPublishPreviewResult,
  type OrgSkillPublishRequest,
  type OrgSkillReviewFilesResult,
  type OrgSkillReviewRequest,
  type OrgSkillsCatalog,
  type OrgSkillsResult,
  type OrgSkillUpdateRequest,
} from "./common/org-skills";
import { extractTgz, OrgArchiveError, verifyArchiveBytes } from "./org-onboarding-archive";
import {
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_BYTES,
  packSkillDirectory,
  previewSkillPack,
} from "./org-skill-pack";
import {
  currentOrgSkillsDir,
  ORG_KEY,
  ORG_SKILL_STAMP_FILE,
  readOrgSkillStamp,
  recordCurrentOrg,
  type OrgSkillStamp,
} from "./org-skill-stamp";

const log = createLogger("OrgSkillCatalog");

const SKILLS_ROUTE = "/v1/onboarding/skills";
const PUBLISH_ROUTE = `${SKILLS_ROUTE}/publish`;
const PUBLISH_HEADERS = {
  name: "x-marshal-skill-name",
  version: "x-marshal-skill-version",
  sha256: "x-marshal-archive-sha256",
} as const;
/** The discovery feature the org server lists when it serves skills. */
export const ORG_SKILLS_FEATURE = "orgSkills";
const STAGING_PREFIX = ".staging-";

export interface OrgSkillCatalogDeps {
  getOrg: () => Promise<
    | { orgId?: string; orgUrl: string; orgName?: string; features: string[]; apiBase: string }
    | undefined
  >;
  requestJson: (method: "GET" | "POST" | "PUT", route: string, body?: unknown) => Promise<unknown>;
  uploadBytes: (
    route: string,
    headers: Record<string, string>,
    bytes: Uint8Array,
  ) => Promise<unknown>;
  downloadArchive: (url: string, maxBytes: number) => Promise<Uint8Array>;
  /** `<appData>/org-skills`; each organization's skills live in a folder of their own under it. */
  root: string;
  /** The person's own skills by name, to show which organization skills they hide. */
  personalSkills: () => Record<string, OrgSkillHiddenBy>;
  /** The person's own local and global skills, with their folders. */
  publishableSkills: () => {
    name: string;
    description: string;
    scope: "local" | "global";
    dir: string;
    version?: string;
  }[];
  /** Called after organization skills on this computer changed (installed, updated, removed). */
  onChanged: () => void;
  homeDir?: string;
}

function failure(error: unknown): { success: false; error: string; detail?: string } {
  if (error instanceof OrgArchiveError) {
    return { success: false, error: error.code, detail: error.message };
  }
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return { success: false, error: code ?? "request-failed" };
}

/** A folder name for the organization: its id when it has one, else the host of its URL. */
export function orgSkillsKey(org: { orgId?: string; orgUrl: string }): string {
  const fromId = (org.orgId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 128);
  if (ORG_KEY.test(fromId)) return fromId;
  let host = "";
  try {
    host = new URL(org.orgUrl).host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  } catch {
    host = "";
  }
  return ORG_KEY.test(host) ? host : "organization";
}

function skillNameOf(skillMd: string): string | undefined {
  const frontmatter = skillMd.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/)?.[1];
  const raw = frontmatter?.match(/^name:\s*(.+)$/m)?.[1];
  return raw ? stripYamlQuotes(raw.trim()) : undefined;
}

async function readTree(root: string, relative = ""): Promise<OrgSkillFile[]> {
  const files: OrgSkillFile[] = [];
  const dir = relative ? path.join(root, ...relative.split("/")) : root;
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop -- ordered walk
      files.push(...(await readTree(root, child)));
    } else if (entry.isFile()) {
      // eslint-disable-next-line no-await-in-loop -- ordered walk
      files.push({ path: child, text: await readFile(path.join(dir, entry.name), "utf8") });
    }
  }
  return files;
}

/** SKILL.md first, then the rest in path order. */
function skillFirst(files: OrgSkillFile[]): OrgSkillFile[] {
  return [
    ...files.filter((file) => file.path === "SKILL.md"),
    ...files.filter((file) => file.path !== "SKILL.md"),
  ];
}

export class OrgSkillCatalog {
  constructor(private readonly deps: OrgSkillCatalogDeps) {}

  private async org() {
    const org = await this.deps.getOrg();
    if (!org) throw Object.assign(new Error("not signed in"), { code: "not-signed-in" });
    if (!org.features.includes(ORG_SKILLS_FEATURE)) {
      throw Object.assign(new Error("not supported"), { code: "not-supported" });
    }
    const key = orgSkillsKey(org);
    recordCurrentOrg(this.deps.root, key);
    return { ...org, key, dir: path.join(this.deps.root, key) };
  }

  private async fetchCatalog(): Promise<OrgSkillsCatalog> {
    const catalog = parseOrgSkillsCatalog(await this.deps.requestJson("GET", SKILLS_ROUTE));
    if (!catalog) throw Object.assign(new Error("invalid catalog"), { code: "invalid-catalog" });
    return catalog;
  }

  /** The installed organization skills of one organization folder, by name. */
  private async installedStamps(dir: string): Promise<Map<string, OrgSkillStamp>> {
    const stamps = new Map<string, OrgSkillStamp>();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return stamps;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ORG_SKILL_NAME.test(entry.name)) continue;
      const stamp = readOrgSkillStamp(path.join(dir, entry.name));
      if (stamp?.name === entry.name) stamps.set(entry.name, stamp);
    }
    return stamps;
  }

  async get(): Promise<OrgSkillsResult> {
    try {
      const org = await this.org();
      const catalog = await this.fetchCatalog();
      const live = new Map(
        [...catalog.recommended, ...catalog.available].map((entry) => [entry.name, entry]),
      );
      const personal = this.deps.personalSkills();
      const installed: Record<string, OrgSkillInstalled> = {};
      for (const [name, stamp] of await this.installedStamps(org.dir)) {
        const served = live.get(name);
        const hiddenBy = personal[name];
        installed[name] = {
          version: stamp.version,
          state: served && served.version !== stamp.version ? "update" : "current",
          ...(hiddenBy ? { hiddenBy } : {}),
        };
      }
      return {
        success: true,
        orgName: org.orgName ?? "your organization",
        catalog,
        installed,
        personal,
      };
    } catch (error) {
      return failure(error);
    }
  }

  /** Installs (or updates to) the approved version the organization serves; an unapproved version never installs. */
  async install(name: string): Promise<OrgSkillActionResult> {
    try {
      if (!ORG_SKILL_NAME.test(name)) return { success: false, error: "invalid-name" };
      const org = await this.org();
      const catalog = await this.fetchCatalog();
      const entry = [...catalog.recommended, ...catalog.available].find(
        (candidate) => candidate.name === name && candidate.status === "approved",
      );
      if (!entry) return { success: false, error: "not-available" };
      await this.installEntry(org, entry);
      this.deps.onChanged();
      return { success: true, entry };
    } catch (error) {
      return failure(error);
    }
  }

  private async installEntry(
    org: { key: string; dir: string },
    entry: OrgSkillEntry,
  ): Promise<void> {
    const bytes = await this.deps.downloadArchive(entry.delivery.url, MAX_SKILL_TOTAL_BYTES);
    verifyArchiveBytes(bytes, entry.delivery);
    await mkdir(org.dir, { recursive: true, mode: 0o700 });
    const staging = path.join(org.dir, `${STAGING_PREFIX}${randomUUID()}`);
    const target = path.join(org.dir, entry.name);
    try {
      await mkdir(staging, { mode: 0o700 });
      await extractTgz(bytes, staging, {
        maxBytes: MAX_SKILL_TOTAL_BYTES,
        maxEntries: MAX_SKILL_FILES * 4,
      });
      let skillMd: string;
      try {
        skillMd = await readFile(path.join(staging, "SKILL.md"), "utf8");
      } catch {
        throw new OrgArchiveError("no-skill", "the archive has no SKILL.md");
      }
      if (skillNameOf(skillMd) !== entry.name) {
        throw new OrgArchiveError("name-mismatch", "SKILL.md names another skill");
      }
      const stamp: OrgSkillStamp = {
        name: entry.name,
        version: entry.version,
        sha256: entry.delivery.sha256,
        org: org.key,
      };
      await writeFile(path.join(staging, ORG_SKILL_STAMP_FILE), JSON.stringify(stamp), {
        mode: 0o600,
      });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    log.info("installed an organization skill", {
      files: entry.files,
      bytes: entry.delivery.bytes,
    });
  }

  /** Removes an installed organization skill from this computer; only ever inside the organization folder. */
  async remove(name: string): Promise<OrgSkillActionResult> {
    try {
      if (!ORG_SKILL_NAME.test(name)) return { success: false, error: "invalid-name" };
      // Signed out, the last recorded organization's skills are still loaded, so they can still be removed.
      const org = await this.deps.getOrg();
      const orgDir = org
        ? path.join(this.deps.root, orgSkillsKey(org))
        : currentOrgSkillsDir(this.deps.root);
      if (!orgDir) return { success: false, error: "not-installed" };
      const dir = path.join(orgDir, name);
      if (!readOrgSkillStamp(dir)) return { success: false, error: "not-installed" };
      await rm(dir, { recursive: true, force: true });
      this.deps.onChanged();
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Brings installed organization skills in line with the organization: a skill it serves in another
   * version is replaced, a skill it no longer serves to this person is removed. Nothing changes when the
   * catalog cannot be read (signed out, offline, server without skills).
   */
  async sync(): Promise<{ updated: string[]; removed: string[] }> {
    const outcome = { updated: [] as string[], removed: [] as string[] };
    let org;
    let catalog;
    try {
      org = await this.org();
      catalog = await this.fetchCatalog();
    } catch {
      return outcome;
    }
    const live = new Map(
      [...catalog.recommended, ...catalog.available]
        .filter((entry) => entry.status === "approved")
        .map((entry) => [entry.name, entry]),
    );
    for (const [name, stamp] of await this.installedStamps(org.dir)) {
      const served = live.get(name);
      try {
        if (!served) {
          // eslint-disable-next-line no-await-in-loop -- few skills; one change at a time
          await rm(path.join(org.dir, name), { recursive: true, force: true });
          outcome.removed.push(name);
        } else if (served.version !== stamp.version || served.delivery.sha256 !== stamp.sha256) {
          // eslint-disable-next-line no-await-in-loop -- few skills; one change at a time
          await this.installEntry(org, served);
          outcome.updated.push(name);
        }
      } catch (error) {
        log.warn("organization skill sync step failed", { code: failure(error).error });
      }
    }
    if (outcome.updated.length > 0 || outcome.removed.length > 0) {
      log.info("synced organization skills", {
        updated: outcome.updated.length,
        removed: outcome.removed.length,
      });
      this.deps.onChanged();
    }
    return outcome;
  }

  /** The person's own local and global skills that could be published. */
  publishable(): OrgSkillPublishableResult {
    try {
      const skills = this.deps
        .publishableSkills()
        .filter((skill) => ORG_SKILL_NAME.test(skill.name))
        .map(({ dir: _dir, ...skill }) => skill);
      return { success: true, skills };
    } catch (error) {
      return failure(error);
    }
  }

  private source(name: string): { dir: string } | { error: string } {
    if (!ORG_SKILL_NAME.test(name)) return { error: "invalid-name" };
    const found = this.deps.publishableSkills().find((skill) => skill.name === name);
    return found ? { dir: found.dir } : { error: "not-publishable" };
  }

  /** The files an upload would hold, after the same checks as publishing (a secret refuses it). */
  async publishPreview(name: string): Promise<OrgSkillPublishPreviewResult> {
    try {
      await this.org();
      const source = this.source(name);
      if ("error" in source) return { success: false, error: source.error };
      const plan = await previewSkillPack(source.dir, { homeDir: this.deps.homeDir });
      return {
        success: true,
        files: plan.files.map((file) => ({ path: file.relative, bytes: file.bytes })),
        totalBytes: plan.totalBytes,
        skipped: plan.skipped,
      };
    } catch (error) {
      return failure(error);
    }
  }

  /** Packs one of the person's skills and uploads it as a pending version for an admin to review. */
  async publish(request: OrgSkillPublishRequest): Promise<OrgSkillActionResult> {
    try {
      await this.org();
      if (!ORG_SKILL_VERSION.test(request.version)) {
        return { success: false, error: "invalid-version" };
      }
      const source = this.source(request.name);
      if ("error" in source) return { success: false, error: source.error };
      const packed = await packSkillDirectory(source.dir, { homeDir: this.deps.homeDir });
      const answer = await this.deps.uploadBytes(
        PUBLISH_ROUTE,
        {
          [PUBLISH_HEADERS.name]: request.name,
          [PUBLISH_HEADERS.version]: request.version,
          [PUBLISH_HEADERS.sha256]: packed.sha256,
        },
        packed.bytes,
      );
      log.info("published an organization skill", {
        files: packed.files,
        bytes: packed.bytes.length,
      });
      const entry = parseOrgSkillEntry(answer);
      return { success: true, ...(entry ? { entry } : {}) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Admin: approve or reject a pending version. The server checks the admin role. */
  async review(request: OrgSkillReviewRequest): Promise<OrgSkillActionResult> {
    try {
      await this.org();
      if (!ORG_SKILL_NAME.test(request.name) || !ORG_SKILL_VERSION.test(request.version)) {
        return { success: false, error: "invalid-name" };
      }
      const answer = await this.deps.requestJson(
        "POST",
        `${SKILLS_ROUTE}/${request.name}/${encodeURIComponent(request.version)}/review`,
        { decision: request.decision, ...(request.reason ? { reason: request.reason } : {}) },
      );
      const entry = parseOrgSkillEntry(answer);
      return { success: true, ...(entry ? { entry } : {}) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Admin: change a skill's tier, pin a version, or remove it from the organization. */
  async update(request: OrgSkillUpdateRequest): Promise<OrgSkillActionResult> {
    try {
      await this.org();
      if (!ORG_SKILL_NAME.test(request.name)) return { success: false, error: "invalid-name" };
      if (request.version !== undefined && !ORG_SKILL_VERSION.test(request.version)) {
        return { success: false, error: "invalid-version" };
      }
      const body = request.remove
        ? { remove: true }
        : {
            ...(request.tier ? { tier: request.tier } : {}),
            ...(request.version ? { version: request.version } : {}),
          };
      const answer = await this.deps.requestJson("PUT", `${SKILLS_ROUTE}/${request.name}`, body);
      const entry = parseOrgSkillEntry(answer);
      return { success: true, ...(entry ? { entry } : {}) };
    } catch (error) {
      return failure(error);
    }
  }

  private async archiveFiles(entry: OrgSkillEntry): Promise<OrgSkillFile[]> {
    const bytes = await this.deps.downloadArchive(entry.delivery.url, MAX_SKILL_TOTAL_BYTES);
    verifyArchiveBytes(bytes, entry.delivery);
    const dir = await mkdtemp(path.join(os.tmpdir(), "marshal-org-skill-"));
    try {
      await extractTgz(bytes, dir, {
        maxBytes: MAX_SKILL_TOTAL_BYTES,
        maxEntries: MAX_SKILL_FILES * 4,
      });
      return skillFirst(await readTree(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Every file of a version, SKILL.md first, plus the approved version served today for comparison. */
  async reviewFiles(name: string, version: string): Promise<OrgSkillReviewFilesResult> {
    try {
      await this.org();
      const catalog = await this.fetchCatalog();
      const all = [...catalog.pending, ...catalog.recommended, ...catalog.available];
      const entry = all.find(
        (candidate) => candidate.name === name && candidate.version === version,
      );
      if (!entry) return { success: false, error: "not-found" };
      const files = await this.archiveFiles(entry);
      const served = [...catalog.recommended, ...catalog.available].find(
        (candidate) => candidate.name === name && candidate.version !== version,
      );
      const previous = served
        ? { version: served.version, files: await this.archiveFiles(served) }
        : undefined;
      return { success: true, files, ...(previous ? { previous } : {}) };
    } catch (error) {
      return failure(error);
    }
  }
}
