import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { OrgArchiveError, sha256Hex } from "./org-onboarding-archive";

/** The most a published archive may weigh; the org server caps uploads below its 30 MiB body limit. */
export const MAX_PUBLISH_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_PACKED_FILES = 20_000;
const MAX_PACKED_BYTES = 200 * 1024 * 1024;
/** A single file above this is left out of the archive. */
export const MAX_PUBLISH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;
const BLOCK = 512;
const ALWAYS_INCLUDED = /^(?:README|LICENSE|LICENCE|NOTICE|CHANGELOG)(?:\.[A-Za-z0-9]+)?$/u;
const SECRET_FILE = /(?:\.(?:pem|key|p12|pfx|map)$|^id_(?:rsa|dsa|ecdsa|ed25519))/iu;
const SECRET_PATTERNS: { reason: string; pattern: RegExp }[] = [
  { reason: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { reason: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  {
    reason: "a GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
  },
  { reason: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { reason: "an API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { reason: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  {
    reason: "a credential assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/iu,
  },
];

export interface PlannedFile {
  relative: string;
  absolute: string;
  bytes: number;
}

export interface PackPlan {
  files: PlannedFile[];
  totalBytes: number;
  /** Files left out on purpose: dotfiles, key files, source maps, oversized files. */
  skipped: string[];
}

export interface PackedExtension {
  bytes: Buffer;
  sha256: string;
  files: number;
}

export interface PackOptions {
  /** The home folder whose path must not appear in a published file; defaults to the current user's. */
  homeDir?: string;
}

function header(name: string, size: number, type: "0" | "5" | "L", mode: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name.length > 100 ? name.slice(0, 100) : name, 0, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(data: Buffer): Buffer[] {
  return [data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)];
}

function hiddenOrSecret(relative: string): boolean {
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return segments.some((segment) => segment.startsWith(".")) || SECRET_FILE.test(name);
}

/** Relative path-like strings anywhere in the manifest (entrypoint, assets, icons, ...). */
function declaredPaths(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    const normal = value.replace(/^\.\//u, "");
    if (
      normal !== "" &&
      normal.length < 256 &&
      !normal.startsWith("/") &&
      !normal.includes("://") &&
      !normal.split("/").includes("..") &&
      !normal.includes("\0")
    ) {
      out.add(normal.replace(/\/+$/u, ""));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) declaredPaths(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) declaredPaths(item, out);
  }
}

async function readManifest(root: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path.join(root, "runtime-extension.json"), "utf8");
  } catch {
    throw new OrgArchiveError("no-manifest", "the extension has no runtime-extension.json");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OrgArchiveError("no-manifest", "runtime-extension.json is not valid JSON");
  }
}

async function walk(
  root: string,
  relative: string,
  declared: boolean,
  plan: PackPlan,
  seen: Set<string>,
): Promise<void> {
  const absolute = path.join(root, ...relative.split("/"));
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    throw new OrgArchiveError(
      "link-entry",
      `${relative} is a symbolic link; archives cannot hold links`,
    );
  }
  if (info.isDirectory()) {
    const entries = (await readdir(absolute)).sort();
    for (const name of entries) {
      const child = `${relative}/${name}`;
      if (name === "node_modules" && !declared) continue;
      // eslint-disable-next-line no-await-in-loop -- directory walk is ordered so the archive is reproducible
      await walk(root, child, declared, plan, seen);
    }
    return;
  }
  if (!info.isFile()) {
    throw new OrgArchiveError("unsupported-entry", `${relative} is not a regular file`);
  }
  if (seen.has(relative)) return;
  seen.add(relative);
  if (hiddenOrSecret(relative) || info.size > MAX_PUBLISH_FILE_BYTES) {
    plan.skipped.push(relative);
    return;
  }
  plan.files.push({ relative, absolute, bytes: info.size });
}

/**
 * Chooses what a published archive holds: the manifest, package.json, README/LICENSE files, the declared
 * entrypoint and its folder, `dist/`, and files or folders the manifest names. Dotfiles (`.env`, `.npmrc`,
 * `.git`, ...), key files, source maps, undeclared `node_modules` and oversized files are never included.
 */
export async function planExtensionPack(packageRoot: string): Promise<PackPlan> {
  const root = await realpath(packageRoot);
  const manifest = await readManifest(root);
  const wanted = new Set<string>(["runtime-extension.json", "package.json", "dist"]);
  for (const name of await readdir(root)) {
    if (ALWAYS_INCLUDED.test(name)) wanted.add(name);
  }
  const declared = new Set<string>();
  declaredPaths(manifest, declared);
  const entrypoint =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "entrypoint")
      : undefined;
  if (typeof entrypoint === "string") {
    const dir = path.posix.dirname(entrypoint.replace(/^\.\//u, ""));
    if (dir !== ".") declared.add(dir);
  }
  const plan: PackPlan = { files: [], totalBytes: 0, skipped: [] };
  const seen = new Set<string>();
  for (const relative of [...wanted]) {
    // eslint-disable-next-line no-await-in-loop -- ordered so the archive is reproducible
    await walk(root, relative, false, plan, seen);
  }
  for (const relative of [...declared].sort()) {
    if (wanted.has(relative)) continue;
    // eslint-disable-next-line no-await-in-loop -- ordered so the archive is reproducible
    await walk(root, relative, true, plan, seen);
  }
  plan.files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
  plan.skipped.sort();
  plan.totalBytes = plan.files.reduce((total, file) => total + file.bytes, 0);
  if (!plan.files.some((file) => file.relative === "runtime-extension.json")) {
    throw new OrgArchiveError("no-manifest", "the extension has no runtime-extension.json");
  }
  if (plan.files.length > MAX_PACKED_FILES || plan.totalBytes > MAX_PACKED_BYTES) {
    throw new OrgArchiveError("too-large", "the extension is too large");
  }
  return plan;
}

/** Throws `sensitive-content` when a file to be published holds the user's home path or looks like a secret. */
export async function scanForSecrets(plan: PackPlan, options: PackOptions): Promise<void> {
  const home = options.homeDir ?? os.homedir();
  const homePaths = home.length > 3 ? [home, home.replaceAll("\\", "/")] : [];
  for (const file of plan.files) {
    if (file.bytes > MAX_SCANNED_BYTES) continue;
    // eslint-disable-next-line no-await-in-loop -- files are read one at a time to bound memory
    const data = await readFile(file.absolute);
    if (data.subarray(0, 8000).includes(0)) continue;
    const text = data.toString("utf8");
    if (homePaths.some((candidate) => text.includes(candidate))) {
      throw new OrgArchiveError(
        "sensitive-content",
        `${file.relative} contains your home folder path`,
      );
    }
    const hit = SECRET_PATTERNS.find((secret) => secret.pattern.test(text));
    if (hit) {
      throw new OrgArchiveError(
        "sensitive-content",
        `${file.relative} looks like it contains ${hit.reason}`,
      );
    }
  }
}

/** What would be uploaded, after the same checks as packing; nothing is read beyond the scan. */
export async function previewExtensionPack(
  packageRoot: string,
  options: PackOptions = {},
): Promise<PackPlan> {
  const plan = await planExtensionPack(packageRoot);
  await scanForSecrets(plan, options);
  return plan;
}

/** A gzip tar of the planned files in order, with no timestamps or owners, so the same files give the same bytes. */
export async function gzipTarFiles(files: readonly PlannedFile[]): Promise<Buffer> {
  const blocks: Buffer[] = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- files are read one at a time to bound memory
    const data = await readFile(file.absolute);
    if (file.relative.length > 100) {
      const longName = Buffer.from(`${file.relative}\0`, "utf8");
      blocks.push(header("././@LongLink", longName.length, "L", 0o644), ...padded(longName));
    }
    blocks.push(header(file.relative, data.length, "0", 0o644), ...padded(data));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/**
 * Packs an installed extension folder into the archive format of contract C2: a gzip tar of regular files
 * with `runtime-extension.json` at its root (no links, no absolute or `..` paths). Only the files
 * `planExtensionPack` selects are included. Entries are sorted and carry no timestamps or owners, so the same
 * folder always gives the same bytes and sha256.
 */
export async function packExtensionDirectory(
  packageRoot: string,
  options: PackOptions = {},
): Promise<PackedExtension> {
  const plan = await previewExtensionPack(packageRoot, options);
  const bytes = await gzipTarFiles(plan.files);
  if (bytes.length > MAX_PUBLISH_ARCHIVE_BYTES) {
    throw new OrgArchiveError("too-large", "the packed extension is over the 25 MiB publish limit");
  }
  return { bytes, sha256: sha256Hex(bytes), files: plan.files.length };
}
