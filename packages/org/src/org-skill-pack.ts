import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  gzipTarFiles,
  scanForSecrets,
  type PackOptions,
  type PackPlan,
} from "./org-extension-pack";
import { OrgArchiveError, sha256Hex } from "./org-onboarding-archive";

/** The org server's skill limits (zyg-agents `src/shared/org-onboarding/skills.ts`). */
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const SECRET_FILE = /(?:\.(?:pem|key|p12|pfx)$|^id_(?:rsa|dsa|ecdsa|ed25519))/iu;

export interface PackedSkill {
  bytes: Buffer;
  sha256: string;
  files: number;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function isText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    strictUtf8.decode(data);
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string, relative: string, depth: number, plan: PackPlan): Promise<void> {
  if (depth > MAX_DEPTH) throw new OrgArchiveError("too-large", `${relative} is nested too deep`);
  const absolute = relative ? path.join(root, ...relative.split("/")) : root;
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    throw new OrgArchiveError(
      "link-entry",
      `${relative} is a symbolic link; skills cannot hold links`,
    );
  }
  if (info.isDirectory()) {
    for (const name of (await readdir(absolute)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      if (name.startsWith(".")) {
        plan.skipped.push(child);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- ordered so the archive is reproducible
      await walk(root, child, depth + 1, plan);
    }
    return;
  }
  if (!info.isFile()) {
    throw new OrgArchiveError("unsupported-entry", `${relative} is not a regular file`);
  }
  if (SECRET_FILE.test(path.posix.basename(relative))) {
    plan.skipped.push(relative);
    return;
  }
  if (info.size > MAX_SKILL_FILE_BYTES) {
    throw new OrgArchiveError("file-too-large", `${relative} is over 256 KiB`);
  }
  plan.files.push({ relative, absolute, bytes: info.size });
}

/**
 * Chooses what a published skill holds: every file in the skill folder except dotfiles (`.env`,
 * `.git`, Marshal's own stamps) and key files. Links, files over 256 KiB, binary files, more than 64
 * files or more than 1 MiB in all refuse the publish; so does a file holding the person's home path
 * or something that looks like a secret.
 */
export async function previewSkillPack(
  skillDir: string,
  options: PackOptions = {},
): Promise<PackPlan> {
  const root = await realpath(skillDir);
  const plan: PackPlan = { files: [], totalBytes: 0, skipped: [] };
  await walk(root, "", 0, plan);
  plan.files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
  plan.skipped.sort();
  plan.totalBytes = plan.files.reduce((total, file) => total + file.bytes, 0);
  if (!plan.files.some((file) => file.relative === "SKILL.md")) {
    throw new OrgArchiveError("no-skill", "the skill has no SKILL.md");
  }
  if (plan.files.length > MAX_SKILL_FILES) {
    throw new OrgArchiveError("too-many-files", `a skill holds at most ${MAX_SKILL_FILES} files`);
  }
  if (plan.totalBytes > MAX_SKILL_TOTAL_BYTES) {
    throw new OrgArchiveError("too-large", "a skill holds at most 1 MiB of files");
  }
  for (const file of plan.files) {
    // eslint-disable-next-line no-await-in-loop -- files are read one at a time to bound memory
    if (!isText(await readFile(file.absolute))) {
      throw new OrgArchiveError("not-text", `${file.relative} is not a UTF-8 text file`);
    }
  }
  await scanForSecrets(plan, options);
  return plan;
}

/** Packs a skill folder into the gzip tar the org server accepts, after the checks of `previewSkillPack`. */
export async function packSkillDirectory(
  skillDir: string,
  options: PackOptions = {},
): Promise<PackedSkill> {
  const plan = await previewSkillPack(skillDir, options);
  const bytes = await gzipTarFiles(plan.files);
  return { bytes, sha256: sha256Hex(bytes), files: plan.files.length };
}
