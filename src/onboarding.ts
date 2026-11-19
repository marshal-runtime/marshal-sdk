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
import { createHash, createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { BRAIN_INDEXES, DEFAULT_BRAIN_INDEX } from "./kit/brain.js";
import type { KitOptions, KitSelection } from "./kit/index.js";
import type { ModelsConfig } from "./models/index.js";
import { PROVIDER_IDS, type ProviderSelection } from "./provider-selection.js";

export const MANIFEST_FILE = "marshal-sdk.json";
const EXTENSION_ID = /^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One extension in the manifest: exactly one of `path`, `archive`, `url` or `id`. */
export interface ManifestExtension {
  /** A built package folder (holding runtime-extension.json), relative to the manifest. */
  path?: string;
  /** A packed extension (.tgz), relative to the manifest. */
  archive?: string;
  /**
   * A packed extension (.tgz) at gs://bucket/object or https://…, fetched with the host's own credentials (Google
   * credentials for gs://) and cached by its sha256. `sha256` is required with it.
   */
  url?: string;
  /** Expected sha256 of `archive` (checked when given) or `url` (required). */
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

/**
 * Which Brain the host's kit uses and how it signs in. Turns the kit's Brain on. `index` names the Brain (the company
 * Brain is "zyg"); `auth` is "person" (the person's own Google credentials: a laptop, a Coder workspace) or "service"
 * (a service on Google Cloud signs as itself and names the person each run works for). `url` and `audience` override
 * the index's address for a Brain the SDK does not know by name yet.
 */
export interface ManifestBrain {
  index?: string;
  auth?: "person" | "service";
  url?: string;
  audience?: string;
  /** auth "service": the service account key file (relative to the manifest); default: the environment's key, else the metadata server. */
  credentialsFile?: string;
  /**
   * The person a run works for when it names none (Python `user=`, `--person`, $MARSHAL_SDK_BRAIN_CALLER all come
   * first): an email or `${env:NAME}`. An unset variable means no person; a service sign-in then runs without the Brain.
   */
  person?: string;
}

export interface SdkManifest {
  version: 1;
  /** `zyg` marks a Zyg host: Zyg's tools join the defaults. */
  profile?: "zyg";
  model?: string;
  reasoningEffort?: string;
  /** The model provider of this host's sessions and its credentials (docs/providers.md). */
  provider?: ProviderSelection;
  kit?: KitSelection;
  brain?: ManifestBrain;
  /** Which provider answers decide / embed / speech on this host (docs/models.md). */
  models?: ModelsConfig;
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
  source: "path" | "archive" | "url" | "org";
  /** Listed in the manifest, admitted by the organization's profile, or one of the built-in defaults. */
  origin: "listed" | "org-profile" | "default";
  /** The manifest entry or default, as written (for messages). */
  entry: string;
}

export interface ResolveOptions {
  /** Where unpacked archives are kept. Default: $MARSHAL_SDK_CACHE, else <manifest dir>/.marshal-sdk/extensions. */
  cacheDir?: string;
  /** Downloads a `url` entry's bytes. Default: gs:// through the GCS JSON API with a Google access token, https:// with fetch. */
  fetchUrl?: (url: string) => Promise<Uint8Array>;
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
  models?: ModelsConfig;
  model?: string;
  reasoningEffort?: string;
  provider?: ProviderSelection;
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
  { key: "brain", identity: BRAIN_EXTENSION, applies: () => true, env: "MARSHAL_SDK_BRAIN_PACKAGE", bundled: "extensions/brain", why: "every host carries the kit's Brain" },
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
    const sources = ["path", "archive", "url", "id"].filter((key) => typeof entry[key] === "string" && entry[key]);
    if (sources.length !== 1) throw new OnboardingError("manifest-invalid", `${where} needs exactly one of path, archive, url or id.`);
    if (typeof entry.url === "string") {
      if (!/^(gs:\/\/[a-z0-9][a-z0-9._-]{1,220}\/.+|https:\/\/.+)$/.test(entry.url)) {
        throw new OnboardingError("manifest-invalid", `${where}: url is gs://bucket/object or https://….`);
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(entry.sha256)) {
        throw new OnboardingError("manifest-invalid", `${where}: a url entry needs its sha256 (64 hex characters).`);
      }
    }
    if (typeof entry.id === "string" && !EXTENSION_ID.test(entry.id)) throw new OnboardingError("manifest-invalid", `${where}: "${entry.id}" is not an extension identity (@scope/name).`);
    if (entry.version !== undefined && (typeof entry.version !== "string" || !VERSION.test(entry.version))) {
      throw new OnboardingError("manifest-invalid", `${where}: version must look like 1.2.3.`);
    }
    if (entry.configuration !== undefined && !record(entry.configuration)) throw new OnboardingError("manifest-invalid", `${where}: configuration must be an object.`);
    return {
      ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      ...(typeof entry.archive === "string" ? { archive: entry.archive } : {}),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
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
  const provider = record(root.provider);
  if (root.provider !== undefined) {
    const fields = ["id", "account", "apiKeyEnv", "home", "engine"];
    if (
      !provider ||
      !(PROVIDER_IDS as readonly unknown[]).includes(provider.id) ||
      Object.keys(provider).some((key) => !fields.includes(key) || (key !== "id" && typeof provider[key] !== "string"))
    ) {
      throw new OnboardingError("manifest-invalid", `${file}: provider is {"id": "${PROVIDER_IDS.join("\" | \"")}", "account"?, "apiKeyEnv"?, "home"?, "engine"?: string}.`);
    }
  }
  let brain: ManifestBrain | undefined;
  if (root.brain !== undefined) {
    const value = record(root.brain);
    const fields = ["index", "auth", "url", "audience", "credentialsFile", "person"];
    if (
      !value ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      (value.index !== undefined && (typeof value.index !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.index))) ||
      (value.auth !== undefined && value.auth !== "person" && value.auth !== "service") ||
      (value.url !== undefined && (typeof value.url !== "string" || !value.url.startsWith("https://"))) ||
      (value.audience !== undefined && typeof value.audience !== "string") ||
      (value.credentialsFile !== undefined && (typeof value.credentialsFile !== "string" || value.auth !== "service")) ||
      (value.person !== undefined && (typeof value.person !== "string" || !(ENV_REFERENCE.test(value.person) || EMAIL.test(value.person.trim()))))
    ) {
      throw new OnboardingError(
        "manifest-invalid",
        `${file}: brain is {"index"?: "zyg" | <brain name>, "auth"?: "person" | "service", "url"?: "https://…", "audience"?: string, "credentialsFile"?: <key file, with auth "service">, "person"?: <email> | "\${env:NAME}"}.`,
      );
    }
    brain = value as ManifestBrain;
  }
  return {
    version: 1,
    ...(root.profile === "zyg" ? { profile: "zyg" as const } : {}),
    ...(brain ? { brain } : {}),
    ...(typeof root.model === "string" ? { model: root.model } : {}),
    ...(typeof root.reasoningEffort === "string" ? { reasoningEffort: root.reasoningEffort } : {}),
    ...(provider ? { provider: provider as unknown as ProviderSelection } : {}),
    ...(kit !== undefined ? { kit: kit as KitSelection } : {}),
    ...(record(root.models) ? { models: root.models as ModelsConfig } : {}),
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
  if (entry.url) return entry.url;
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
  /** Extensions it needs on the same host (runtime-extension.json dependencies.extensions). */
  dependencies: { id: string; version?: string }[];
  /** Configuration keys its schema requires (configuration.schema.required). */
  requiredConfiguration: string[];
  /** Keys its own configuration defaults fill (configuration.defaults). */
  configurationDefaults: string[];
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
  const declaredDependencies = record(raw.dependencies)?.extensions;
  const dependencies = (Array.isArray(declaredDependencies) ? declaredDependencies : [])
    .map(record)
    .filter((item): item is Record<string, unknown> => typeof item?.id === "string")
    .map((item) => ({ id: item.id as string, ...(typeof item.version === "string" ? { version: item.version } : {}) }));
  const configuration = record(raw.configuration);
  const required = record(configuration?.schema)?.required;
  return {
    identity: raw.identity,
    version: raw.version,
    capabilities,
    skills,
    dependencies,
    requiredConfiguration: Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [],
    configurationDefaults: Object.keys(record(configuration?.defaults) ?? {}),
  };
}

/** One extension as the requirement check sees it: what it declares, and the configuration the host gives it. */
export interface RequirementSubject {
  packageRoot: string;
  configuration?: unknown;
}

/**
 * Every unmet requirement of the extensions a host is about to load, in one list: a dependency that is not among them
 * (or not at the version asked for), and a required configuration key that neither the host's configuration nor the
 * extension's own defaults give. Empty when the host can start.
 */
export function unmetRequirements(subjects: readonly RequirementSubject[]): string[] {
  const summaries = subjects.map((subject) => ({ subject, summary: readPackageManifest(subject.packageRoot) }));
  const loaded = new Map(summaries.map(({ summary }) => [summary.identity, summary.version]));
  const problems: string[] = [];
  for (const { subject, summary } of summaries) {
    const name = `${summary.identity}@${summary.version}`;
    for (const dependency of summary.dependencies) {
      const version = loaded.get(dependency.id);
      if (version === undefined) problems.push(`${name} needs the extension ${dependency.id}${dependency.version ? `@${dependency.version}` : ""}, which this host does not load.`);
      else if (dependency.version && dependency.version !== version) problems.push(`${name} needs ${dependency.id}@${dependency.version}; this host loads ${version}.`);
    }
    const given = record(subject.configuration) ?? {};
    for (const key of summary.requiredConfiguration) {
      if (!(key in given) && !summary.configurationDefaults.includes(key)) problems.push(`${name} needs the setting "${key}" in its configuration.`);
    }
  }
  return problems;
}

/** Load order where every dependency comes before what needs it (otherwise the order given). */
export function dependencyOrder<T extends RequirementSubject>(subjects: readonly T[]): T[] {
  const identities = subjects.map((subject) => readPackageManifest(subject.packageRoot));
  const index = new Map(identities.map((summary, at) => [summary.identity, at]));
  const ordered: T[] = [];
  const state = new Map<number, "visiting" | "done">();
  const visit = (at: number) => {
    if (state.get(at) === "done" || state.get(at) === "visiting") return;
    state.set(at, "visiting");
    for (const dependency of identities[at]!.dependencies) {
      const target = index.get(dependency.id);
      if (target !== undefined) visit(target);
    }
    state.set(at, "done");
    ordered.push(subjects[at]!);
  };
  subjects.forEach((_, at) => visit(at));
  return ordered;
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

  // Missing environment variables and unmet requirements are gathered and reported together, so one start names them all.
  const problems: string[] = [];
  const finish = (packageRoot: string, entry: ManifestExtension, label: string, source: ResolvedExtension["source"], origin: ResolvedExtension["origin"]) =>
    finishEntry(packageRoot, entry, label, source, origin, env, problems);

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
    } else if (entry.url) {
      // Cached by the hash the manifest pins: a repeat start reads nothing over the network.
      const target = path.join(cacheDir, `sha256-${entry.sha256!.slice(0, 32)}`);
      const cached = fs.existsSync(path.join(target, ".complete")) ? findPackageRoot(target) : undefined;
      if (cached) packageRoot = cached;
      else {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await (options.fetchUrl ?? ((url: string) => fetchUrl(url, env)))(entry.url));
        } catch (error) {
          throw new OnboardingError("url-unreachable", `${label}: could not download it (${error instanceof Error ? error.message : String(error)}).`);
        }
        const digest = sha256Hex(bytes);
        if (digest !== entry.sha256) throw new OnboardingError("archive-mismatch", `${label}: sha256 is ${digest}, the manifest expects ${entry.sha256}.`);
        packageRoot = unpack(bytes, target, label);
      }
      source = "url";
    } else {
      const fetched = await needResolver(label).fetch({ org: manifest.org!, id: entry.id!, ...(entry.version ? { version: entry.version } : {}) });
      packageRoot = materialize(fetched, cacheDir, label);
      source = "org";
    }
    listed.push(finish(packageRoot, entry, label, source, "listed"));
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
      fromProfile.push(finish(materialize(fetched, cacheDir, label), { id: admitted.id }, label, "org", "org-profile"));
    }
  } else if (manifest.org?.profile?.allow?.length && !resolver) {
    throw new OnboardingError("resolver-missing", `org.profile admits extensions from the organization, which needs the org layer (src/org); this SDK build does not have it.`);
  }

  // The built-in defaults the manifest does not opt out of and does not already list.
  const taken = new Set([...listed, ...fromProfile].map((extension) => extension.identity));
  const defaults: ResolvedExtension[] = [];
  // A `brain` block names the Brain and how the host signs in to it; it turns the kit's Brain on.
  let kit = manifest.brain ? withBrainOptions(manifest.kit, brainKitOptions(manifest.brain, file, env)) : manifest.kit;
  for (const spec of DEFAULT_EXTENSIONS) {
    if (!defaultOn(manifest, spec) || taken.has(spec.identity)) continue;
    // A kit that already asks for the Brain (or memory, which needs it) loads it itself: not a default then.
    if (spec.key === "brain" && kitAsksForBrain(kit)) {
      const shipped = spec.bundled && path.join(SDK_ROOT, spec.bundled);
      if (!brainFromKit(kit) && !envPackage(env[spec.env]) && shipped && fs.existsSync(path.join(shipped, "runtime-extension.json"))) kit = withBrain(kit, shipped);
      continue;
    }
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
        `${label} is on because ${spec.why}, but no package was found: set ${spec.env} to a built package${spec.bundled ? `, put one at ${path.join(SDK_ROOT, spec.bundled)}` : ""}${manifest.org ? "" : ", or name the org that serves it"}, or opt out with "defaults": {"${spec.key}": false}.`,
      );
    }
    const resolved = finish(packageRoot, { id: spec.identity }, label, source, "default");
    // The kit loads the Brain with its cloud configuration; the default turns that part on, at this package.
    if (spec.key === "brain") kit = withBrain(kit, resolved.packageRoot);
    defaults.push(resolved);
  }

  const all = [...defaults.filter((extension) => extension.identity !== BRAIN_EXTENSION), ...listed, ...fromProfile].map((extension) => withOrgConfiguration(extension, manifest.org));
  const seen = new Map<string, string>();
  for (const extension of all) {
    const earlier = seen.get(extension.identity);
    if (earlier) throw new OnboardingError("duplicate-extension", `${extension.identity} is listed twice (${earlier} and ${extension.entry}).`);
    seen.set(extension.identity, extension.entry);
  }
  // What the extensions declare they need, checked against what this host will load (the kit's Brain included).
  const brainSpec = DEFAULT_EXTENSIONS.find((spec) => spec.key === "brain")!;
  const shippedBrain = brainSpec.bundled ? path.join(SDK_ROOT, brainSpec.bundled) : undefined;
  const kitBrain = kitAsksForBrain(kit)
    ? (brainFromKit(kit) ?? envPackage(env[brainSpec.env]) ?? (shippedBrain && fs.existsSync(path.join(shippedBrain, "runtime-extension.json")) ? shippedBrain : undefined))
    : undefined;
  if (kitAsksForBrain(kit) && !kitBrain) problems.push(`the kit's Brain is on, but no ${BRAIN_EXTENSION} package was found: set ${brainSpec.env} to a built package.`);
  // The host loads the Brain package checked here, not whatever its own environment names later.
  if (kitBrain && !brainFromKit(kit)) kit = withBrain(kit, kitBrain);
  problems.push(...unmetRequirements([...(kitBrain ? [{ packageRoot: kitBrain }] : []), ...all]));
  if (problems.length) {
    throw new OnboardingError("requirements-missing", `${file} cannot start a host:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  return {
    extensions: all,
    ...(kit !== undefined ? { kit } : {}),
    ...(manifest.models ? { models: manifest.models } : {}),
    ...(manifest.model ? { model: manifest.model } : {}),
    ...(manifest.reasoningEffort ? { reasoningEffort: manifest.reasoningEffort } : {}),
    ...(manifest.provider ? { provider: manifest.provider } : {}),
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

/** @marshal/org learns which organization to join from the manifest; configuration the manifest gives it wins. */
function withOrgConfiguration(extension: ResolvedExtension, org: ManifestOrg | undefined): ResolvedExtension {
  if (extension.identity !== ORG_EXTENSION || !org) return extension;
  const given = record(extension.configuration) ?? {};
  return { ...extension, configuration: { discovery: org.discovery, ...(org.profile ? { profile: org.profile } : {}), ...given } };
}

function finishEntry(
  packageRoot: string,
  entry: ManifestExtension,
  label: string,
  source: ResolvedExtension["source"],
  origin: ResolvedExtension["origin"],
  env: Record<string, string | undefined>,
  problems: string[],
): ResolvedExtension {
  const summary = readPackageManifest(packageRoot, label);
  if (entry.id && summary.identity !== entry.id) {
    throw new OnboardingError("identity-mismatch", `${label}: the package holds ${summary.identity}, not ${entry.id}.`);
  }
  const missing = missingEnv(entry.configuration, env);
  for (const name of missing) problems.push(`${label} configuration: environment variable ${name} is not set.`);
  return {
    packageRoot: fs.realpathSync(packageRoot),
    ...(entry.configuration ? { configuration: missing.length ? entry.configuration : expandEnv(entry.configuration, env, `${label} configuration`) } : {}),
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

/** The `${env:NAME}` references in a configuration value whose variable is unset or empty, each once. */
export function missingEnv(value: unknown, env: Record<string, string | undefined>): string[] {
  const missing = new Set<string>();
  const walk = (item: unknown) => {
    if (typeof item === "string") {
      const match = ENV_REFERENCE.exec(item);
      if (match && (env[match[1]!] === undefined || env[match[1]!] === "")) missing.add(match[1]!);
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (record(item)) Object.values(record(item)!).forEach(walk);
  };
  walk(value);
  return [...missing];
}

/**
 * The kit's Brain options for a manifest's `brain` block: the index's address and the sign-in mode. `auth: "person"`
 * is desktop mode. `auth: "service"` signs with a service account key when the host has one (`credentialsFile`,
 * $GOOGLE_APPLICATION_CREDENTIALS_JSON, or a service_account file at $GOOGLE_APPLICATION_CREDENTIALS: an E2B sandbox),
 * else with the metadata server's identity (Cloud Run, GKE, a GCE VM).
 */
export function brainKitOptions(brain: ManifestBrain, file = MANIFEST_FILE, env: Record<string, string | undefined> = process.env): NonNullable<KitOptions["brain"]> {
  const index = brain.index ?? DEFAULT_BRAIN_INDEX;
  const url = brain.url ?? BRAIN_INDEXES[index];
  if (!url) {
    throw new OnboardingError(
      "brain-unknown",
      `${file}: no Brain named "${index}" (known: ${Object.keys(BRAIN_INDEXES).join(", ")}); give its address as brain.url.`,
    );
  }
  const person = manifestPerson(brain.person, env);
  const options = { cloudUrl: url, cloudAudience: brain.audience ?? url, ...(person ? { callerEmail: person } : {}) };
  if (brain.auth !== "service") return { ...options, callerMode: "desktop" };
  if (brain.credentialsFile) {
    const keyFile = path.resolve(path.dirname(path.resolve(file)), brain.credentialsFile);
    if (!isServiceAccountKey(keyFile)) throw new OnboardingError("brain-key", `${file}: brain.credentialsFile ${keyFile} is not a service_account key file.`);
    return { ...options, callerMode: "service-key", credentialsFile: keyFile };
  }
  const source = serviceAccountKeySource(env);
  // The Brain extension looks for a key only in $GOOGLE_APPLICATION_CREDENTIALS[_JSON], so a handed file is named to it.
  if (source && "file" in source && source.file === env[SERVICE_KEY_FILE_ENV]) {
    return { ...options, callerMode: "service-key", credentialsFile: source.file };
  }
  return { ...options, callerMode: source ? "service-key" : "delegated" };
}

/**
 * The host's service account key as a file, from marshal_sdk (Python) when its caller blanked
 * $GOOGLE_APPLICATION_CREDENTIALS[_JSON] for its agent's tools, as agent-sandbox does. Once the host has resolved its
 * manifest it drops the variable (forgetHandedServiceKey), so the agent's tools do not find the key's path either.
 */
export const SERVICE_KEY_FILE_ENV = "MARSHAL_SDK_SERVICE_KEY_FILE";

export function forgetHandedServiceKey(...envs: (Record<string, string | undefined> | undefined)[]): void {
  for (const env of envs) if (env) delete env[SERVICE_KEY_FILE_ENV];
}

/** brain.person with its ${env:NAME} read; an unset variable or a value that is not an email is no person. */
function manifestPerson(value: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!value) return undefined;
  const match = ENV_REFERENCE.exec(value);
  const person = (match ? env[match[1]!] : value)?.trim().toLowerCase();
  return person && EMAIL.test(person) ? person : undefined;
}

function isServiceAccountKey(file: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return record(parsed)?.type === "service_account";
  } catch {
    return false;
  }
}

/** The kit with its Brain part on and these Brain options under any the kit already gives. */
function withBrainOptions(kit: KitSelection | undefined, brain: NonNullable<KitOptions["brain"]>): KitSelection {
  const options: KitOptions = !kit ? { parts: [] } : Array.isArray(kit) ? { parts: kit as KitOptions["parts"] } : (kit as KitOptions);
  return {
    ...options,
    parts: options.parts.includes("brain") ? options.parts : ["brain", ...options.parts],
    brain: { ...brain, ...options.brain },
  };
}

/** A `url` entry's bytes: gs:// through the GCS JSON API with the host's Google credentials, https:// with fetch. */
async function fetchUrl(url: string, env: Record<string, string | undefined>): Promise<Uint8Array> {
  let target = url;
  const headers: Record<string, string> = {};
  if (url.startsWith("gs://")) {
    const [bucket, ...rest] = url.slice("gs://".length).split("/");
    target = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket!)}/o/${encodeURIComponent(rest.join("/"))}?alt=media`;
    headers.authorization = `Bearer ${await googleStorageToken(env)}`;
  }
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.startsWith("gs://") ? "Cloud Storage" : new URL(url).host}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Where the host's service account key is, found as the Brain's service-key mode finds it: the key inline in
 * $GOOGLE_APPLICATION_CREDENTIALS_JSON (what an E2B sandbox carries, from Secret Manager), else a `service_account`
 * file at $MARSHAL_SDK_SERVICE_KEY_FILE or $GOOGLE_APPLICATION_CREDENTIALS. A person's application default
 * credentials there are not a key.
 */
export function serviceAccountKeySource(env: Record<string, string | undefined>): { inline: string } | { file: string } | undefined {
  const inline = env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (inline) return { inline };
  const handed = env[SERVICE_KEY_FILE_ENV];
  if (handed && isServiceAccountKey(handed)) return { file: handed };
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  return file && isServiceAccountKey(file) ? { file } : undefined;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

function readServiceAccountKey(source: { inline: string } | { file: string }): ServiceAccountKey {
  const where = "inline" in source ? "$GOOGLE_APPLICATION_CREDENTIALS_JSON" : source.file;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse("inline" in source ? source.inline : fs.readFileSync(source.file, "utf8")) as unknown);
  } catch {
    parsed = undefined;
  }
  if (parsed?.type !== "service_account" || typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") {
    throw new OnboardingError("key-invalid", `${where} is not a service_account key (type, client_email, private_key).`);
  }
  return parsed as unknown as ServiceAccountKey;
}

const STORAGE_READ_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

/** An OAuth access token for a service account key: a signed JWT exchanged at the key's token_uri (JWT bearer grant). */
async function serviceAccountAccessToken(key: ServiceAccountKey, scope: string): Promise<string> {
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) })}.${encode({
    iss: key.client_email,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown; error_description?: unknown };
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(`${key.client_email} could not sign in (HTTP ${response.status}${body.error ? `: ${String(body.error)}` : ""}${body.error_description ? `, ${String(body.error_description)}` : ""})`);
  }
  return body.access_token;
}

/**
 * A Google access token for Cloud Storage: the host's service account key when it has one (see
 * serviceAccountKeySource), else the metadata server's (a service on Google Cloud signs as its own service account),
 * else the application default credentials (GOOGLE_ACCESS_TOKEN, google-auth-library, gcloud).
 */
export async function googleStorageToken(env: Record<string, string | undefined> = process.env): Promise<string> {
  const source = serviceAccountKeySource(env);
  if (source) return serviceAccountAccessToken(readServiceAccountKey(source), STORAGE_READ_SCOPE);
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1_500),
    });
    if (response.ok) {
      const body = (await response.json()) as { access_token?: unknown };
      if (typeof body.access_token === "string" && body.access_token) return body.access_token;
    }
  } catch {
    // Not on Google Cloud: the application default credentials below.
  }
  const { googleAccessTokenProvider } = await import("./models/credentials.js");
  return googleAccessTokenProvider()();
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
