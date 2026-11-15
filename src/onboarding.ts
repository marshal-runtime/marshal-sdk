/**
 * Onboarding: everything a host needs in one file, `marshal-sdk.json`, so "give the host the extensions I need" is one
 * step. Extensions come from a built package folder, a .tgz, or an organization registry by `identity@version`, the
 * same catalog and archive format the desktop installs from (Plugins > Organization, electron/org/org-extension-catalog.ts
 * and org-onboarding.ts): `GET {registry}/v1/onboarding/catalog`, archives at
 * `{registry}/v1/onboarding/extensions/{id}/{version}.tgz`, checked against the announced size and sha256.
 *
 * A registry may also be a folder with the same layout (`v1/onboarding/catalog` as a JSON file and the archives
 * beside it), which serves as an offline mirror inside an image and as the fake registry in tests.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { KitSelection } from "./kit/index.js";

export const MANIFEST_FILE = "marshal-sdk.json";
const CATALOG_ROUTE = "/v1/onboarding/catalog";
const EXTENSION_ID = /^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** One extension in the manifest: exactly one of `path`, `archive` or `id`. */
export interface ManifestExtension {
  /** A built package folder (holding runtime-extension.json), relative to the manifest. */
  path?: string;
  /** A packed extension (.tgz), relative to the manifest. */
  archive?: string;
  /** Expected sha256 of `archive`; checked when given. */
  sha256?: string;
  /** An extension from the registry by identity; `version` pins it, else the latest approved one. */
  id?: string;
  version?: string;
  /**
   * The extension's configuration. A string value `${env:NAME}` is read from the host's environment at start, so
   * secrets never sit in the file; a missing variable stops the host with its name.
   */
  configuration?: Record<string, unknown>;
}

export interface ManifestRegistry {
  /** The organization's API base (https), or a folder with the same layout. */
  url?: string;
  dir?: string;
  /** Environment variable holding the bearer token for `url`. */
  tokenEnv?: string;
}

export interface SdkManifest {
  version: 1;
  model?: string;
  reasoningEffort?: string;
  kit?: KitSelection;
  registry?: ManifestRegistry;
  extensions: ManifestExtension[];
}

/** An extension ready for createMarshalHost, with where it came from. */
export interface ResolvedExtension {
  packageRoot: string;
  configuration?: unknown;
  identity: string;
  version: string;
  source: "path" | "archive" | "registry";
  /** The manifest entry, as written (for messages). */
  entry: string;
}

export interface ResolveOptions {
  /** Where unpacked archives are kept. Default: $MARSHAL_SDK_CACHE, else <manifest dir>/.marshal-sdk/extensions. */
  cacheDir?: string;
  /** Environment for `${env:...}` references and the registry token. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Replaces HTTP(S) GET for the registry (tests). */
  fetchBytes?: (url: string, headers: Record<string, string>, maxBytes: number) => Promise<Buffer>;
}

export interface OnboardingHostOptions {
  extensions: ResolvedExtension[];
  kit?: KitSelection;
  model?: string;
  reasoningEffort?: string;
}

export class OnboardingError extends Error {
  override readonly name = "OnboardingError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function readManifest(file: string): SdkManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new OnboardingError("manifest-unreadable", `${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseManifest(raw, file);
}

export function parseManifest(raw: unknown, file = MANIFEST_FILE): SdkManifest {
  const root = record(raw);
  if (!root || root.version !== 1) throw new OnboardingError("manifest-invalid", `${file}: expected {"version": 1, "extensions": [...]}.`);
  const extensions = Array.isArray(root.extensions) ? root.extensions : [];
  const parsed: ManifestExtension[] = extensions.map((item, index) => {
    const entry = record(item);
    const where = `${file}: extensions[${index}]`;
    if (!entry) throw new OnboardingError("manifest-invalid", `${where} must be an object.`);
    const sources = ["path", "archive", "id"].filter((key) => typeof entry[key] === "string" && entry[key]);
    if (sources.length !== 1) throw new OnboardingError("manifest-invalid", `${where} needs exactly one of path, archive or id.`);
    if (typeof entry.id === "string" && !EXTENSION_ID.test(entry.id)) throw new OnboardingError("manifest-invalid", `${where}: "${entry.id}" is not an extension identity (@scope/name).`);
    if (entry.version !== undefined && (typeof entry.version !== "string" || !VERSION.test(entry.version))) {
      throw new OnboardingError("manifest-invalid", `${where}: version must look like 1.2.3.`);
    }
    if (entry.configuration !== undefined && !record(entry.configuration)) throw new OnboardingError("manifest-invalid", `${where}: configuration must be an object.`);
    return {
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      ...(typeof entry.archive === "string" ? { archive: entry.archive } : {}),
      ...(typeof entry.sha256 === "string" ? { sha256: entry.sha256.toLowerCase() } : {}),
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      ...(entry.configuration ? { configuration: entry.configuration as Record<string, unknown> } : {}),
    };
  });
  const registry = record(root.registry);
  const kit = root.kit;
  return {
    version: 1,
    ...(typeof root.model === "string" ? { model: root.model } : {}),
    ...(typeof root.reasoningEffort === "string" ? { reasoningEffort: root.reasoningEffort } : {}),
    ...(kit !== undefined ? { kit: kit as KitSelection } : {}),
    ...(registry
      ? {
          registry: {
            ...(typeof registry.url === "string" ? { url: registry.url } : {}),
            ...(typeof registry.dir === "string" ? { dir: registry.dir } : {}),
            ...(typeof registry.tokenEnv === "string" ? { tokenEnv: registry.tokenEnv } : {}),
          },
        }
      : {}),
    extensions: parsed,
  };
}

export function writeManifest(file: string, manifest: SdkManifest): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

/** How an entry reads in messages and lists. */
export function describeEntry(entry: ManifestExtension): string {
  if (entry.path) return entry.path;
  if (entry.archive) return entry.archive;
  return entry.version ? `${entry.id}@${entry.version}` : entry.id!;
}

/**
 * Turns `add`'s argument into a manifest entry: an extension identity (`@scope/name` or `@scope/name@1.2.3`), a .tgz,
 * or a package folder. Paths are stored relative to the manifest.
 */
export function entryFromSpec(spec: string, manifestDir: string): ManifestExtension {
  const pinned = /^(@[^@/\s]+\/[^@\s]+)(?:@([^@\s]+))?$/.exec(spec);
  if (pinned && !fs.existsSync(path.resolve(manifestDir, spec))) {
    if (!EXTENSION_ID.test(pinned[1]!)) throw new OnboardingError("spec-invalid", `"${pinned[1]}" is not an extension identity (@scope/name).`);
    if (pinned[2] && !VERSION.test(pinned[2])) throw new OnboardingError("spec-invalid", `"${pinned[2]}" is not a version (1.2.3).`);
    return { id: pinned[1]!, ...(pinned[2] ? { version: pinned[2] } : {}) };
  }
  const absolute = path.resolve(manifestDir, spec);
  if (!fs.existsSync(absolute)) throw new OnboardingError("spec-missing", `${spec}: no such folder or file, and not an extension identity.`);
  const relative = manifestPathFor(fs.realpathSync(absolute), manifestDir);
  if (fs.statSync(absolute).isFile()) {
    if (!/\.(tgz|tar\.gz)$/i.test(absolute)) throw new OnboardingError("spec-invalid", `${spec}: an archive must be a .tgz.`);
    return { archive: relative, sha256: sha256Hex(fs.readFileSync(absolute)) };
  }
  readPackageManifest(absolute, spec);
  return { path: relative };
}

/**
 * How a local package is written in the manifest: relative when it sits inside the manifest's folder (the manifest
 * and its packages move together, into an image for example), absolute otherwise. Both sides are real paths, so a
 * symlinked folder (macOS /tmp is /private/tmp) cannot produce a relative path that resolves elsewhere.
 */
function manifestPathFor(absolute: string, manifestDir: string): string {
  const base = fs.existsSync(manifestDir) ? fs.realpathSync(manifestDir) : path.resolve(manifestDir);
  const relative = path.relative(base, absolute);
  return relative === "" ? "." : relative.startsWith("..") || path.isAbsolute(relative) ? absolute : relative;
}

/** The identity, version, capabilities and declared skills of a built package; throws a clear error when it is not one. */
export function readPackageManifest(packageRoot: string, label = packageRoot): PackageSummary {
  const file = path.join(packageRoot, "runtime-extension.json");
  let raw: Record<string, unknown> | undefined;
  try {
    raw = record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new OnboardingError(
      missing ? "package-missing" : "package-invalid",
      missing ? `${label}: no runtime-extension.json in ${packageRoot} (is it a built extension package?).` : `${label}: runtime-extension.json is not valid JSON.`,
    );
  }
  if (!raw || typeof raw.identity !== "string" || typeof raw.version !== "string") {
    throw new OnboardingError("package-invalid", `${label}: runtime-extension.json has no identity and version.`);
  }
  const contributes = record(raw.contributes) ?? {};
  const capabilities = Array.isArray(contributes.capabilities) ? contributes.capabilities.filter((item): item is string => typeof item === "string") : [];
  const skills = (Array.isArray(contributes.catalog) ? contributes.catalog : [])
    .filter((item): item is string => typeof item === "string" && item.startsWith("skill:") && !item.startsWith("skill://"))
    .map((item) => path.basename(item.slice("skill:".length)));
  return { identity: raw.identity, version: raw.version, capabilities, skills };
}

export interface PackageSummary {
  identity: string;
  version: string;
  capabilities: string[];
  skills: string[];
}

/** Resolves every manifest entry to a package folder, fetching and unpacking registry and archive entries. */
export async function resolveManifest(file: string, options: ResolveOptions = {}): Promise<OnboardingHostOptions> {
  const manifest = readManifest(file);
  const manifestDir = path.dirname(path.resolve(file));
  const env = options.env ?? process.env;
  const cacheDir = path.resolve(options.cacheDir ?? env.MARSHAL_SDK_CACHE ?? path.join(manifestDir, ".marshal-sdk", "extensions"));
  const extensions: ResolvedExtension[] = [];
  const seen = new Map<string, string>();
  let catalog: Promise<CatalogEntry[]> | undefined;
  for (const entry of manifest.extensions) {
    const label = describeEntry(entry);
    let packageRoot: string;
    let source: ResolvedExtension["source"];
    if (entry.path) {
      packageRoot = path.resolve(manifestDir, entry.path);
      source = "path";
    } else if (entry.archive) {
      const bytes = readFile(path.resolve(manifestDir, entry.archive), label);
      const digest = sha256Hex(bytes);
      if (entry.sha256 && entry.sha256 !== digest) throw new OnboardingError("archive-mismatch", `${label}: sha256 is ${digest}, the manifest expects ${entry.sha256}.`);
      packageRoot = await unpack(bytes, path.join(cacheDir, `sha256-${digest.slice(0, 32)}`), label);
      source = "archive";
    } else {
      catalog ??= readCatalog(manifest.registry, manifestDir, env, options);
      packageRoot = await fetchFromRegistry(entry, await catalog, manifest.registry!, manifestDir, cacheDir, env, options);
      source = "registry";
    }
    const summary = readPackageManifest(packageRoot, label);
    if (entry.id && summary.identity !== entry.id) {
      throw new OnboardingError("identity-mismatch", `${label}: the archive holds ${summary.identity}, not ${entry.id}.`);
    }
    const earlier = seen.get(summary.identity);
    if (earlier) throw new OnboardingError("duplicate-extension", `${summary.identity} is listed twice (${earlier} and ${label}).`);
    seen.set(summary.identity, label);
    extensions.push({
      packageRoot: fs.realpathSync(packageRoot),
      ...(entry.configuration ? { configuration: expandEnv(entry.configuration, env, `${label} configuration`) } : {}),
      identity: summary.identity,
      version: summary.version,
      source,
      entry: label,
    });
  }
  return {
    extensions,
    ...(manifest.kit !== undefined ? { kit: manifest.kit } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
    ...(manifest.reasoningEffort ? { reasoningEffort: manifest.reasoningEffort } : {}),
  };
}

/** Replaces `${env:NAME}` strings anywhere in a configuration value; a missing variable is an error naming it. */
export function expandEnv(value: unknown, env: Record<string, string | undefined>, where: string): unknown {
  if (typeof value === "string") {
    const match = ENV_REFERENCE.exec(value);
    if (!match) return value;
    const found = env[match[1]!];
    if (found === undefined || found === "") throw new OnboardingError("env-missing", `${where}: environment variable ${match[1]} is not set.`);
    return found;
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, env, where));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, expandEnv(item, env, where)]));
}

/** A configuration for printing: `${env:...}` references stay as written, other strings that look secret are masked. */
export function maskConfiguration(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (ENV_REFERENCE.test(value)) return value;
    return /token|secret|key|password|credential/i.test(key) ? "••••" : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskConfiguration(item, key));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([name, item]) => [name, maskConfiguration(item, name)]));
}

interface CatalogEntry {
  id: string;
  version: string;
  status: string;
  delivery: { kind: string; url?: string; sha256?: string; bytes?: number };
}

async function readCatalog(
  registry: ManifestRegistry | undefined,
  manifestDir: string,
  env: Record<string, string | undefined>,
  options: ResolveOptions,
): Promise<CatalogEntry[]> {
  if (!registry?.url && !registry?.dir) {
    throw new OnboardingError("registry-missing", `An extension is listed by id, but ${MANIFEST_FILE} has no registry ({"registry": {"url": ...}} or {"dir": ...}).`);
  }
  const bytes = registry.dir
    ? readFile(path.join(path.resolve(manifestDir, registry.dir), ...CATALOG_ROUTE.slice(1).split("/")), "registry catalog")
    : await get(registryUrl(registry.url!, CATALOG_ROUTE), registry, env, options, 8 * 1024 * 1024);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OnboardingError("registry-invalid", "The registry catalog is not JSON.");
  }
  const root = record(raw);
  if (!root || root.version !== 1) throw new OnboardingError("registry-invalid", "The registry catalog is not a version 1 catalog.");
  return ["recommended", "available", "pending"].flatMap((tier) =>
    (Array.isArray(root[tier]) ? (root[tier] as unknown[]) : []).flatMap((item) => {
      const entry = record(item);
      const delivery = record(entry?.delivery);
      if (!entry || typeof entry.id !== "string" || typeof entry.version !== "string" || !delivery || typeof delivery.kind !== "string") return [];
      return [{ id: entry.id, version: entry.version, status: typeof entry.status === "string" ? entry.status : "approved", delivery: delivery as CatalogEntry["delivery"] }];
    }),
  );
}

async function fetchFromRegistry(
  entry: ManifestExtension,
  catalog: CatalogEntry[],
  registry: ManifestRegistry,
  manifestDir: string,
  cacheDir: string,
  env: Record<string, string | undefined>,
  options: ResolveOptions,
): Promise<string> {
  const label = describeEntry(entry);
  const approved = catalog.filter((candidate) => candidate.id === entry.id && candidate.status === "approved");
  const chosen = entry.version
    ? approved.find((candidate) => candidate.version === entry.version)
    : approved.sort((left, right) => compareVersions(right.version, left.version))[0];
  if (!chosen) {
    const versions = approved.map((candidate) => candidate.version).join(", ");
    throw new OnboardingError("registry-unknown", `${label}: not in the registry's approved extensions${versions ? ` (approved versions: ${versions})` : ""}.`);
  }
  if (chosen.delivery.kind !== "archive" || !chosen.delivery.sha256 || typeof chosen.delivery.bytes !== "number") {
    throw new OnboardingError("registry-unsupported", `${label}: delivered as "${chosen.delivery.kind}", which only the desktop can install.`);
  }
  const target = path.join(cacheDir, `${chosen.id.replace("/", "__")}@${chosen.version}`);
  if (fs.existsSync(path.join(target, ".sha256")) && fs.readFileSync(path.join(target, ".sha256"), "utf8") === chosen.delivery.sha256.toLowerCase()) {
    const root = findPackageRoot(target);
    if (root) return root;
  }
  const route = `/v1/onboarding/extensions/${chosen.id}/${chosen.version}.tgz`;
  let bytes: Buffer;
  if (registry.dir) {
    const relative = chosen.delivery.url?.startsWith("/") ? chosen.delivery.url : route;
    bytes = readFile(path.join(path.resolve(manifestDir, registry.dir), ...relative.slice(1).split("/")), label);
  } else {
    const url = chosen.delivery.url && !chosen.delivery.url.startsWith("/") ? new URL(chosen.delivery.url).toString() : registryUrl(registry.url!, chosen.delivery.url ?? route);
    // The desktop's rule: an archive comes from the registry's own origin.
    if (new URL(url).origin !== new URL(registry.url!).origin) throw new OnboardingError("registry-untrusted", `${label}: archive host ${new URL(url).origin} is not the registry's.`);
    bytes = await get(url, registry, env, options, Math.min(chosen.delivery.bytes + 1, MAX_ARCHIVE_BYTES));
  }
  if (bytes.length !== chosen.delivery.bytes || sha256Hex(bytes) !== chosen.delivery.sha256.toLowerCase()) {
    throw new OnboardingError("archive-mismatch", `${label}: the archive does not match the size and sha256 the registry announced.`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  const root = await unpack(bytes, target, label);
  fs.writeFileSync(path.join(target, ".sha256"), chosen.delivery.sha256.toLowerCase());
  return root;
}

function registryUrl(base: string, route: string): string {
  return `${base.replace(/\/+$/, "")}${route}`;
}

async function get(url: string, registry: ManifestRegistry, env: Record<string, string | undefined>, options: ResolveOptions, maxBytes: number): Promise<Buffer> {
  const token = registry.tokenEnv ? env[registry.tokenEnv] : undefined;
  if (registry.tokenEnv && !token) throw new OnboardingError("env-missing", `The registry token variable ${registry.tokenEnv} is not set.`);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const fetchBytes = options.fetchBytes ?? httpGet;
  try {
    return await fetchBytes(url, headers, maxBytes);
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("registry-unreachable", `GET ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function httpGet(url: string, headers: Record<string, string>, maxBytes: number): Promise<Buffer> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : undefined;
  if (!client) return Promise.reject(new Error(`unsupported protocol ${parsed.protocol}`));
  // Plain HTTP only to this machine (a local mirror or a test registry); a remote registry needs TLS.
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    return Promise.reject(new OnboardingError("registry-untrusted", `${url}: a remote registry must use https.`));
  }
  return new Promise((resolve, reject) => {
    const request = client.get(parsed, { headers, timeout: 60_000 }, (response) => {
      if ((response.statusCode ?? 0) >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("response larger than announced"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

/** Unpacks into `target` (replacing an earlier unpack) and returns the package folder inside it. */
async function unpack(bytes: Buffer, target: string, label: string): Promise<string> {
  const existing = fs.existsSync(target) ? findPackageRoot(target) : undefined;
  if (existing && fs.existsSync(path.join(target, ".complete"))) return existing;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  extractTgz(bytes, target, label);
  const root = findPackageRoot(target);
  if (!root) throw new OnboardingError("package-missing", `${label}: the archive has no runtime-extension.json.`);
  fs.writeFileSync(path.join(target, ".complete"), "");
  return root;
}

/** runtime-extension.json at the top, or one level down (npm pack puts everything under package/). */
function findPackageRoot(dir: string): string | undefined {
  if (fs.existsSync(path.join(dir, "runtime-extension.json"))) return dir;
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    if (child.isDirectory() && fs.existsSync(path.join(dir, child.name, "runtime-extension.json"))) return path.join(dir, child.name);
  }
  return undefined;
}

/**
 * A .tgz into an empty folder, with the desktop's rules (electron/org/org-onboarding-archive.ts): regular files and
 * folders only; links, devices, absolute paths, `..` and oversized archives are refused before anything is written
 * outside the folder.
 */
export function extractTgz(archive: Buffer, destination: string, label = "archive"): { files: number; bytes: number } {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES + 1024 * 1024 });
  } catch {
    throw new OnboardingError("archive-invalid", `${label}: not a valid .tgz.`);
  }
  const root = path.resolve(destination);
  let offset = 0;
  let entries = 0;
  let total = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    offset += 512;
    if (++entries > MAX_ARCHIVE_ENTRIES) throw new OnboardingError("archive-invalid", `${label}: too many entries.`);
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cString(header, 345, 155);
    const baseName = cString(header, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const data = tar.subarray(offset, offset + size);
    if (offset + size > tar.length) throw new OnboardingError("archive-invalid", `${label}: truncated.`);
    offset += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    longName = undefined;
    if (type === "x" || type === "g") continue;
    if (type !== "0" && type !== "5") throw new OnboardingError("archive-unsafe", `${label}: holds a link or special file (${name}).`);
    const parts = name.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
    if (name.startsWith("/") || parts.includes("..")) throw new OnboardingError("archive-unsafe", `${label}: entry ${name} escapes the folder.`);
    if (parts.length === 0) continue;
    const target = path.resolve(root, ...parts);
    if (!target.startsWith(root + path.sep)) throw new OnboardingError("archive-unsafe", `${label}: entry ${name} escapes the folder.`);
    if (type === "5") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    total += size;
    if (total > MAX_EXTRACTED_BYTES) throw new OnboardingError("archive-invalid", `${label}: expands too large.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: (octal(header, 100, 8) & 0o755) | 0o600 });
  }
  return { files: entries, bytes: total };
}

function cString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const raw = cString(block, start, length).trim();
  return raw ? Number.parseInt(raw, 8) || 0 : 0;
}

function readFile(file: string, label: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch {
    throw new OnboardingError("file-missing", `${label}: cannot read ${file}.`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The desktop's order: 1.2.10 after 1.2.9, a prerelease before its release. */
function compareVersions(left: string, right: string): number {
  const split = (version: string) => {
    const [core = "", pre] = version.split("+")[0]!.split(/-(.*)/su);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
