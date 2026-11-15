/**
 * Onboarding: everything a host needs in one file, `marshal-sdk.json`, so "give the host the extensions I need" is one
 * step. Extensions come from a built package folder, a .tgz, or the organization by `identity@version`; `org` with a
 * profile loads every extension the organization admits for this host. A built-in default set (the org extension, the
 * kit's Brain, and Zyg's tools on a Zyg host) loads unless the manifest opts out.
 *
 * This module does not talk to the organization itself: an `ExtensionResolver` does (the org layer, src/org). It
 * hands back an archive with the hash the organization announced, or a package folder; this module checks the hash,
 * unpacks safely and caches.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import type { KitOptions, KitSelection } from "./kit/index.js";

export const MANIFEST_FILE = "marshal-sdk.json";
const EXTENSION_ID = /^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
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
  /** An extension the organization admits, by identity; `version` pins it, else the organization's current one. */
  id?: string;
  version?: string;
  /**
   * The extension's configuration. A string value `${env:NAME}` is read from the host's environment at start, so
   * secrets never sit in the file; a missing variable stops the host with its name.
   */
  configuration?: Record<string, unknown>;
}

/** The organization this host belongs to. */
export interface ManifestOrg {
  /** The organization's discovery URL (what a desktop signs in to). */
  discovery: string;
  /**
   * Which of the organization's admitted extensions this host loads: `allow` (identities, `*` for all; default all)
   * minus `deny`. Extensions listed in `extensions` load whatever the profile says.
   */
  profile?: { allow?: string[]; deny?: string[] };
}

/** The built-in default set; each is on unless set to false (or `defaults: false` turns all off). */
export interface ManifestDefaults {
  /** @marshal/org, when the manifest names an `org`. */
  org?: boolean;
  /** The kit's Brain (@marshal/brain). */
  brain?: boolean;
  /** Zyg's tools (@zyg/marshal-runtime-extension), on a Zyg host (`profile: "zyg"`). Marley opts out. */
  zygTools?: boolean;
}

export interface SdkManifest {
  version: 1;
  /** `zyg` marks a Zyg host: Zyg's tools join the defaults. */
  profile?: "zyg";
  model?: string;
  reasoningEffort?: string;
  kit?: KitSelection;
  org?: ManifestOrg;
  defaults?: false | ManifestDefaults;
  extensions: ManifestExtension[];
}

/** What a resolver hands back for one extension: an archive with the organization's hash, or an unpacked package. */
export type ResolvedPackage = { id: string; version: string } & ({ archive: Uint8Array; sha256: string } | { packageRoot: string });

/** The organization side of onboarding, implemented by the org layer (src/org); tests pass a fake. */
export interface ExtensionResolver {
  /** The extensions the organization admits for this host, before the manifest's profile. */
  admitted(org: ManifestOrg): Promise<{ id: string; version: string }[]>;
  /** One admitted extension; without `version`, the organization's current one. */
  fetch(request: { org: ManifestOrg; id: string; version?: string }): Promise<ResolvedPackage>;
}

/** An extension ready for createMarshalHost, with where it came from. */
export interface ResolvedExtension {
  packageRoot: string;
  configuration?: unknown;
  identity: string;
  version: string;
  source: "path" | "archive" | "org";
  /** Listed in the manifest, admitted by the organization's profile, or one of the built-in defaults. */
  origin: "listed" | "org-profile" | "default";
  /** The manifest entry or default, as written (for messages). */
  entry: string;
}

export interface ResolveOptions {
  /** Where unpacked archives are kept. Default: $MARSHAL_SDK_CACHE, else <manifest dir>/.marshal-sdk/extensions. */
  cacheDir?: string;
  /** Environment for `${env:...}` references and the default packages' variables. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Reaches the organization; needed for `id` entries and `org`. Default: the one registered with useExtensionResolver. */
  resolver?: ExtensionResolver;
}

export interface OnboardingHostOptions {
  /** What createMarshalHost installs: defaults, then listed entries, then the org profile's (the Brain goes through `kit`). */
  extensions: ResolvedExtension[];
  /** Every default that loads, the Brain included (an image packs these too). */
  defaults: ResolvedExtension[];
  kit?: KitSelection;
  model?: string;
  reasoningEffort?: string;
  /** Identities that came from the built-in defaults (the start-up report marks them). */
  defaultExtensions: string[];
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

let registeredResolver: ExtensionResolver | undefined;

/** The org layer registers how this process reaches the organization; resolveManifest uses it unless given another. */
export function useExtensionResolver(resolver: ExtensionResolver | undefined): void {
  registeredResolver = resolver;
}

export const ORG_EXTENSION = "@marshal/org";
export const BRAIN_EXTENSION = "@marshal/brain";
export const ZYG_TOOLS_EXTENSION = "@zyg/marshal-runtime-extension";
/** The SDK's own folder (the nearest package.json above this module, from src/ or dist/src/). */
const SDK_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "package.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
})();

export interface DefaultSpec {
  key: keyof ManifestDefaults;
  identity: string;
  /** Whether this default applies to the manifest at all. */
  applies: (manifest: SdkManifest) => boolean;
  /** Environment variable naming a built package. */
  env: string;
  /** A package that ships inside the SDK, relative to its root. */
  bundled?: string;
  why: string;
}

/** The built-in default set, in load order. */
export const DEFAULT_EXTENSIONS: readonly DefaultSpec[] = [
  { key: "org", identity: ORG_EXTENSION, applies: (manifest) => manifest.org !== undefined, env: "MARSHAL_SDK_ORG_PACKAGE", bundled: "extensions/org/out/package", why: "the manifest names an org" },
  { key: "brain", identity: BRAIN_EXTENSION, applies: () => true, env: "MARSHAL_SDK_BRAIN_PACKAGE", why: "every host carries the kit's Brain" },
  { key: "zygTools", identity: ZYG_TOOLS_EXTENSION, applies: (manifest) => manifest.profile === "zyg", env: "MARSHAL_SDK_ZYG_EXTENSION", why: "this is a Zyg host (profile zyg)" },
];

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
  if (root.profile !== undefined && root.profile !== "zyg") throw new OnboardingError("manifest-invalid", `${file}: profile is "zyg" or absent.`);
  const org = record(root.org);
  if (root.org !== undefined && (!org || typeof org.discovery !== "string" || !org.discovery)) {
    throw new OnboardingError("manifest-invalid", `${file}: org needs {"discovery": "<url>"}.`);
  }
  const profile = record(org?.profile);
  const strings = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (item !== "*" && !EXTENSION_ID.test(item)))) {
      throw new OnboardingError("manifest-invalid", `${file}: org.profile.${name} is a list of identities (or "*").`);
    }
    return value as string[];
  };
  const allow = strings(profile?.allow, "allow");
  const deny = strings(profile?.deny, "deny");
  let defaults: SdkManifest["defaults"];
  if (root.defaults === false) defaults = false;
  else if (root.defaults !== undefined) {
    const value = record(root.defaults);
    const unknown = Object.keys(value ?? { x: 1 }).filter((key) => !["org", "brain", "zygTools"].includes(key));
    if (!value || unknown.length || Object.values(value).some((item) => typeof item !== "boolean")) {
      throw new OnboardingError("manifest-invalid", `${file}: defaults is false or {"org"?, "brain"?, "zygTools"?: boolean}.`);
    }
    defaults = value as ManifestDefaults;
  }
  const kit = root.kit;
  return {
    version: 1,
    ...(root.profile === "zyg" ? { profile: "zyg" as const } : {}),
    ...(typeof root.model === "string" ? { model: root.model } : {}),
    ...(typeof root.reasoningEffort === "string" ? { reasoningEffort: root.reasoningEffort } : {}),
    ...(kit !== undefined ? { kit: kit as KitSelection } : {}),
    ...(org
      ? { org: { discovery: org.discovery as string, ...(allow || deny ? { profile: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } } : {}) } }
      : {}),
    ...(defaults !== undefined ? { defaults } : {}),
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
 * or a package folder.
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

export interface PackageSummary {
  identity: string;
  version: string;
  capabilities: string[];
  skills: string[];
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

/**
 * Resolves the manifest to package folders: the built-in defaults first, then the listed entries, then what the
 * organization's profile admits. An identity loads once; a listed entry replaces a default or a profile one.
 */
export async function resolveManifest(file: string, options: ResolveOptions = {}): Promise<OnboardingHostOptions> {
  const manifest = readManifest(file);
  const manifestDir = path.dirname(path.resolve(file));
  const env = options.env ?? process.env;
  const cacheDir = path.resolve(options.cacheDir ?? env.MARSHAL_SDK_CACHE ?? path.join(manifestDir, ".marshal-sdk", "extensions"));
  const resolver = options.resolver ?? registeredResolver;
  const needResolver = (label: string): ExtensionResolver => {
    if (!manifest.org) throw new OnboardingError("org-missing", `${label}: an extension by id comes from the organization, and ${MANIFEST_FILE} has no "org".`);
    if (!resolver) throw new OnboardingError("resolver-missing", `${label}: reaching the organization needs the org layer (src/org), which this SDK build does not have.`);
    return resolver;
  };

  const listed: ResolvedExtension[] = [];
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
      packageRoot = unpack(bytes, path.join(cacheDir, `sha256-${digest.slice(0, 32)}`), label);
      source = "archive";
    } else {
      const fetched = await needResolver(label).fetch({ org: manifest.org!, id: entry.id!, ...(entry.version ? { version: entry.version } : {}) });
      packageRoot = materialize(fetched, cacheDir, label);
      source = "org";
    }
    listed.push(finish(packageRoot, entry, label, source, "listed", env));
  }

  // The organization's admitted extensions, through the manifest's profile, unless listed already.
  const fromProfile: ResolvedExtension[] = [];
  if (manifest.org && resolver) {
    const allow = manifest.org.profile?.allow ?? ["*"];
    const deny = new Set(manifest.org.profile?.deny ?? []);
    const listedIds = new Set(listed.map((extension) => extension.identity));
    for (const admitted of await resolver.admitted(manifest.org)) {
      if (deny.has(admitted.id) || listedIds.has(admitted.id) || !(allow.includes("*") || allow.includes(admitted.id))) continue;
      const label = `${admitted.id}@${admitted.version} (org profile)`;
      const fetched = await resolver.fetch({ org: manifest.org, id: admitted.id, version: admitted.version });
      fromProfile.push(finish(materialize(fetched, cacheDir, label), { id: admitted.id }, label, "org", "org-profile", env));
    }
  } else if (manifest.org?.profile?.allow?.length && !resolver) {
    throw new OnboardingError("resolver-missing", `org.profile admits extensions from the organization, which needs the org layer (src/org); this SDK build does not have it.`);
  }

  // The built-in defaults the manifest does not opt out of and does not already list.
  const taken = new Set([...listed, ...fromProfile].map((extension) => extension.identity));
  const defaults: ResolvedExtension[] = [];
  let kit = manifest.kit;
  for (const spec of DEFAULT_EXTENSIONS) {
    if (!defaultOn(manifest, spec) || taken.has(spec.identity)) continue;
    // A kit that already asks for the Brain (or memory, which needs it) loads it itself: not a default then.
    if (spec.key === "brain" && kitAsksForBrain(kit)) continue;
    const label = `default ${spec.identity}`;
    let packageRoot = (spec.key === "brain" ? brainFromKit(kit) : undefined) ?? envPackage(env[spec.env]);
    let source: ResolvedExtension["source"] = "path";
    if (!packageRoot && spec.bundled && fs.existsSync(path.join(SDK_ROOT, spec.bundled, "runtime-extension.json"))) packageRoot = path.join(SDK_ROOT, spec.bundled);
    if (!packageRoot && manifest.org && resolver) {
      packageRoot = await fetchDefault(resolver, manifest.org, spec, cacheDir, label);
      source = "org";
    }
    if (!packageRoot) {
      throw new OnboardingError(
        "default-missing",
        `${label} is on because ${spec.why}, but no package was found: set ${spec.env} to a built package${spec.bundled ? `, build ${spec.bundled}` : ""}${manifest.org ? "" : ", or name the org that serves it"}, or opt out with "defaults": {"${spec.key}": false}.`,
      );
    }
    const resolved = finish(packageRoot, { id: spec.identity }, label, source, "default", env);
    // The kit loads the Brain with its cloud configuration; the default turns that part on, at this package.
    if (spec.key === "brain") kit = withBrain(kit, resolved.packageRoot);
    defaults.push(resolved);
  }

  const all = [...defaults.filter((extension) => extension.identity !== BRAIN_EXTENSION), ...listed, ...fromProfile];
  const seen = new Map<string, string>();
  for (const extension of all) {
    const earlier = seen.get(extension.identity);
    if (earlier) throw new OnboardingError("duplicate-extension", `${extension.identity} is listed twice (${earlier} and ${extension.entry}).`);
    seen.set(extension.identity, extension.entry);
  }
  return {
    extensions: all,
    ...(kit !== undefined ? { kit } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
    ...(manifest.reasoningEffort ? { reasoningEffort: manifest.reasoningEffort } : {}),
    defaults,
    defaultExtensions: defaults.map((extension) => extension.identity),
  };
}

function defaultOn(manifest: SdkManifest, spec: DefaultSpec): boolean {
  if (manifest.defaults === false) return false;
  if (manifest.defaults?.[spec.key] === false) return false;
  return spec.applies(manifest);
}

function envPackage(value: string | undefined): string | undefined {
  return value && fs.existsSync(path.join(value, "runtime-extension.json")) ? path.resolve(value) : undefined;
}

function kitAsksForBrain(kit: KitSelection | undefined): boolean {
  const parts = !kit ? [] : Array.isArray(kit) ? kit : (kit as KitOptions).parts;
  return parts.includes("brain") || parts.includes("memory");
}

function brainFromKit(kit: KitSelection | undefined): string | undefined {
  if (!kit || Array.isArray(kit)) return undefined;
  return envPackage((kit as KitOptions).brain?.packageRoot);
}

/** The kit with its Brain part on, at this package (memory and sessions stay as the manifest set them). */
function withBrain(kit: KitSelection | undefined, packageRoot: string): KitSelection {
  const options: KitOptions = !kit ? { parts: [] } : Array.isArray(kit) ? { parts: kit as KitOptions["parts"] } : (kit as KitOptions);
  return {
    ...options,
    parts: options.parts.includes("brain") ? options.parts : ["brain", ...options.parts],
    brain: { ...options.brain, packageRoot },
  };
}

async function fetchDefault(resolver: ExtensionResolver, org: ManifestOrg, spec: DefaultSpec, cacheDir: string, label: string): Promise<string | undefined> {
  try {
    return materialize(await resolver.fetch({ org, id: spec.identity }), cacheDir, label);
  } catch {
    return undefined;
  }
}

function finish(
  packageRoot: string,
  entry: ManifestExtension,
  label: string,
  source: ResolvedExtension["source"],
  origin: ResolvedExtension["origin"],
  env: Record<string, string | undefined>,
): ResolvedExtension {
  const summary = readPackageManifest(packageRoot, label);
  if (entry.id && summary.identity !== entry.id) {
    throw new OnboardingError("identity-mismatch", `${label}: the package holds ${summary.identity}, not ${entry.id}.`);
  }
  return {
    packageRoot: fs.realpathSync(packageRoot),
    ...(entry.configuration ? { configuration: expandEnv(entry.configuration, env, `${label} configuration`) } : {}),
    identity: summary.identity,
    version: summary.version,
    source,
    origin,
    entry: label,
  };
}

/** A resolver's answer as a package folder: archives are checked against the organization's hash and unpacked once. */
function materialize(fetched: ResolvedPackage, cacheDir: string, label: string): string {
  if ("packageRoot" in fetched) return fetched.packageRoot;
  const bytes = Buffer.from(fetched.archive);
  const digest = sha256Hex(bytes);
  if (digest !== fetched.sha256.toLowerCase()) {
    throw new OnboardingError("archive-mismatch", `${label}: the archive's sha256 is ${digest}, the organization announced ${fetched.sha256}.`);
  }
  return unpack(bytes, path.join(cacheDir, `${fetched.id.replace("/", "__")}@${fetched.version}-${digest.slice(0, 16)}`), label);
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

/** Unpacks into `target` once (the folder name carries the hash) and returns the package folder inside it. */
function unpack(bytes: Buffer, target: string, label: string): string {
  const existing = fs.existsSync(path.join(target, ".complete")) ? findPackageRoot(target) : undefined;
  if (existing) return existing;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
