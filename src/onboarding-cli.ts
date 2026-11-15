import fs from "node:fs";
import path from "node:path";

import type { MarshalHostOptions } from "./host.js";
import {
  BRAIN_EXTENSION,
  DEFAULT_EXTENSIONS,
  MANIFEST_FILE,
  OnboardingError,
  describeEntry,
  entryFromSpec,
  maskConfiguration,
  readManifest,
  readPackageManifest,
  resolveManifest,
  writeManifest,
  type ManifestExtension,
  type ResolvedExtension,
  type SdkManifest,
} from "./onboarding.js";

export const ONBOARDING_USAGE = `  init        Write ${MANIFEST_FILE}: the extensions, kit and model every host command here loads.
                [--manifest <file>] [--force] [--kit brain,memory,sessions] [--model <id>] [--effort <level>]
                [--org <discovery url>] [--allow <identity>]... [--deny <identity>]... [--profile zyg]
                [--no-defaults | --no-default org|brain|zygTools]... [--extension <spec>]...
  extensions  Manage the manifest's extensions. <spec> is a package folder, a .tgz, or @scope/name[@version]
              from the organization.
                add <spec> [--config key=value]... [--config-env key=ENV_NAME]... [--config-json <json>]
                remove <identity | spec>
                list [--resolve]      (--resolve adds the defaults and the org's admitted extensions, fetches
                                       and checks every package)
                fetch                 (resolves and unpacks everything now, e.g. while building an image)
                all take [--manifest <file>] [--cache <dir>]

  Host commands (exec, agent, serve) load ${MANIFEST_FILE} from --manifest, $MARSHAL_SDK_MANIFEST, or the
  current folder; --extension, --model and --effort add to or override it. Built-in defaults (the org
  extension when an org is named, the kit's Brain, Zyg's tools on a Zyg host) load unless the manifest opts out.
`;

interface Parsed {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parse(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.add(name);
    else {
      values.set(name, [...(values.get(name) ?? []), next]);
      index += 1;
    }
  }
  return { positionals, values, flags };
}

const one = (parsed: Parsed, name: string) => parsed.values.get(name)?.at(-1);
const print = (value: unknown) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

/** The manifest a command uses: --manifest, $MARSHAL_SDK_MANIFEST, or marshal-sdk.json in the current folder. */
export function manifestPath(explicit: string | undefined, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string | undefined {
  if (explicit) return path.resolve(explicit);
  if (env.MARSHAL_SDK_MANIFEST) return path.resolve(env.MARSHAL_SDK_MANIFEST);
  const local = path.join(cwd, MANIFEST_FILE);
  return fs.existsSync(local) ? local : undefined;
}

/**
 * Host options with the manifest's extensions, kit and model merged in. Flags win: --model and --effort override, and
 * --extension packages are added after the manifest's.
 */
export async function withManifest(
  options: MarshalHostOptions,
  explicit: { manifest?: string; cache?: string; model?: string; effort?: string },
): Promise<MarshalHostOptions> {
  const file = manifestPath(explicit.manifest, options.env ?? process.env);
  if (!file) return options;
  const resolved = await resolveManifest(file, { env: options.env ?? process.env, ...(explicit.cache ? { cacheDir: explicit.cache } : {}) });
  // A kit given in code wins over the manifest's, and with it the Brain default (the kit then decides on the Brain).
  const kitFromManifest = resolved.kit !== undefined && options.kit === undefined;
  const defaultExtensions = resolved.defaultExtensions.filter((identity) => kitFromManifest || identity !== BRAIN_EXTENSION);
  const names = [...resolved.defaults.filter((extension) => defaultExtensions.includes(extension.identity) && extension.identity === BRAIN_EXTENSION), ...resolved.extensions].map(
    (extension) => `${extension.identity}@${extension.version}${extension.origin === "default" ? " (default)" : extension.origin === "org-profile" ? " (org profile)" : ""}`,
  );
  options.log?.(`manifest ${file}: ${names.join(", ") || "no extensions"}`);
  return {
    ...options,
    extensions: [
      ...resolved.extensions.map((extension) => ({ packageRoot: extension.packageRoot, ...(extension.configuration !== undefined ? { configuration: extension.configuration } : {}) })),
      ...(options.extensions ?? []),
    ],
    ...(kitFromManifest ? { kit: resolved.kit } : {}),
    ...(resolved.models && options.models === undefined ? { models: resolved.models } : {}),
    ...(resolved.provider && options.provider === undefined ? { provider: resolved.provider } : {}),
    ...(defaultExtensions.length || options.defaultExtensions ? { defaultExtensions: [...(options.defaultExtensions ?? []), ...defaultExtensions] } : {}),
    ...(!explicit.model && resolved.model ? { model: resolved.model } : {}),
    ...(!explicit.effort && resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

/** `init` and `extensions ...`; returns the exit code. */
export async function onboardingCommand(command: string, argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  const file = path.resolve(one(parsed, "manifest") ?? process.env.MARSHAL_SDK_MANIFEST ?? MANIFEST_FILE);
  const dir = path.dirname(file);
  try {
    if (command === "init") return init(parsed, file);
    const [action, spec] = parsed.positionals;
    if (!fs.existsSync(file)) throw new OnboardingError("manifest-missing", `${file} does not exist; run marshal-sdk init first.`);
    const manifest = readManifest(file);
    switch (action) {
      case "add": {
        if (!spec) throw new OnboardingError("spec-missing", "extensions add needs a package folder, a .tgz or @scope/name[@version].");
        const entry = { ...entryFromSpec(spec, dir), ...configurationOf(parsed) };
        const identity = identityOf(entry, dir);
        const replaced = manifest.extensions.findIndex((existing) => sameExtension(existing, entry, identity, dir));
        if (replaced >= 0) manifest.extensions[replaced] = entry;
        else manifest.extensions.push(entry);
        writeManifest(file, manifest);
        print({ [replaced >= 0 ? "updated" : "added"]: describeEntry(entry), ...(identity ? { identity } : {}), manifest: file });
        return 0;
      }
      case "remove": {
        if (!spec) throw new OnboardingError("spec-missing", "extensions remove needs an identity or the spec it was added with.");
        const before = manifest.extensions.length;
        manifest.extensions = manifest.extensions.filter((entry) => !matches(entry, spec, dir));
        if (manifest.extensions.length === before) throw new OnboardingError("not-listed", `${spec} is not in ${file}.`);
        writeManifest(file, manifest);
        print({ removed: spec, remaining: manifest.extensions.map(describeEntry) });
        return 0;
      }
      case "list": {
        if (parsed.flags.has("resolve")) {
          const resolved = await resolveManifest(file, cacheOption(parsed));
          print({ manifest: file, extensions: [...resolved.defaults.filter((extension) => extension.identity === BRAIN_EXTENSION), ...resolved.extensions].map(row) });
        } else {
          print({
            manifest: file,
            ...(manifest.profile ? { profile: manifest.profile } : {}),
            ...(manifest.org ? { org: manifest.org } : {}),
            defaults: defaultsOf(manifest),
            ...(manifest.kit !== undefined ? { kit: manifest.kit } : {}),
            ...(manifest.model ? { model: manifest.model } : {}),
            extensions: manifest.extensions.map((entry) => listRow(entry, dir)),
          });
        }
        return 0;
      }
      case "fetch": {
        const resolved = await resolveManifest(file, cacheOption(parsed));
        print({ manifest: file, extensions: [...resolved.defaults.filter((extension) => extension.identity === BRAIN_EXTENSION), ...resolved.extensions].map(row) });
        return 0;
      }
      default:
        process.stdout.write(ONBOARDING_USAGE);
        return action ? 2 : 0;
    }
  } catch (error) {
    if (error instanceof OnboardingError) {
      process.stderr.write(`marshal-sdk: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function init(parsed: Parsed, file: string): number {
  if (fs.existsSync(file) && !parsed.flags.has("force")) {
    throw new OnboardingError("manifest-exists", `${file} already exists (--force replaces it).`);
  }
  const org = one(parsed, "org");
  const allow = parsed.values.get("allow");
  const deny = parsed.values.get("deny");
  const profile = one(parsed, "profile");
  if (profile !== undefined && profile !== "zyg") throw new OnboardingError("profile-invalid", `--profile is zyg (a Zyg host), got ${profile}.`);
  if ((allow || deny) && !org) throw new OnboardingError("org-missing", "--allow and --deny filter an organization's extensions; name it with --org.");
  const optOut = parsed.values.get("no-default") ?? [];
  for (const key of optOut) if (!["org", "brain", "zygTools"].includes(key)) throw new OnboardingError("default-invalid", `--no-default takes org, brain or zygTools, got ${key}.`);
  const kit = one(parsed, "kit");
  const manifest: SdkManifest = {
    version: 1,
    ...(one(parsed, "model") ? { model: one(parsed, "model")! } : {}),
    ...(one(parsed, "effort") ? { reasoningEffort: one(parsed, "effort")! } : {}),
    ...(kit ? { kit: kit.split(",").map((part) => part.trim()).filter(Boolean) as never } : {}),
    ...(profile ? { profile: "zyg" as const } : {}),
    ...(org ? { org: { discovery: org, ...(allow || deny ? { profile: { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } } : {}) } } : {}),
    ...(parsed.flags.has("no-defaults") ? { defaults: false as const } : optOut.length ? { defaults: Object.fromEntries(optOut.map((key) => [key, false])) } : {}),
    extensions: (parsed.values.get("extension") ?? []).map((spec) => entryFromSpec(spec, path.dirname(file))),
  };
  writeManifest(file, manifest);
  print({ written: file, extensions: manifest.extensions.map(describeEntry) });
  return 0;
}

function configurationOf(parsed: Parsed): Pick<ManifestExtension, "configuration"> {
  const configuration: Record<string, unknown> = {};
  const json = one(parsed, "config-json");
  if (json) {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OnboardingError("config-invalid", "--config-json must be a JSON object.");
    Object.assign(configuration, value);
  }
  for (const pair of parsed.values.get("config") ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new OnboardingError("config-invalid", `--config takes key=value, got ${pair}.`);
    const raw = pair.slice(at + 1);
    configuration[pair.slice(0, at)] = raw === "true" ? true : raw === "false" ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  for (const pair of parsed.values.get("config-env") ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.slice(at + 1))) throw new OnboardingError("config-invalid", `--config-env takes key=ENV_NAME, got ${pair}.`);
    configuration[pair.slice(0, at)] = `\${env:${pair.slice(at + 1)}}`;
  }
  return Object.keys(configuration).length ? { configuration } : {};
}

function cacheOption(parsed: Parsed): { cacheDir?: string } {
  const cache = one(parsed, "cache");
  return cache ? { cacheDir: path.resolve(cache) } : {};
}

/** Which built-in defaults this manifest turns on (before checking that their packages exist). */
function defaultsOf(manifest: SdkManifest): string[] {
  return DEFAULT_EXTENSIONS.filter((spec) => manifest.defaults !== false && manifest.defaults?.[spec.key] !== false && spec.applies(manifest)).map((spec) => spec.identity);
}

/** The identity a local entry declares (organization entries carry it). */
function identityOf(entry: ManifestExtension, dir: string): string | undefined {
  if (entry.id) return entry.id;
  if (entry.path) return readPackageManifest(path.resolve(dir, entry.path)).identity;
  return undefined;
}

function sameExtension(existing: ManifestExtension, entry: ManifestExtension, identity: string | undefined, dir: string): boolean {
  if (describeEntry(existing) === describeEntry(entry)) return true;
  if (!identity) return false;
  try {
    return identityOf(existing, dir) === identity;
  } catch {
    return false;
  }
}

function matches(entry: ManifestExtension, spec: string, dir: string): boolean {
  if (describeEntry(entry) === spec || entry.id === spec || entry.path === spec || entry.archive === spec) return true;
  if ((entry.path || entry.archive) && path.resolve(dir, entry.path ?? entry.archive!) === path.resolve(dir, spec)) return true;
  try {
    return identityOf(entry, dir) === spec;
  } catch {
    return false;
  }
}

function listRow(entry: ManifestExtension, dir: string): Record<string, unknown> {
  const base = {
    entry: describeEntry(entry),
    source: entry.path ? "path" : entry.archive ? "archive" : "org",
    ...(entry.configuration ? { configuration: maskConfiguration(entry.configuration) } : {}),
  };
  if (!entry.path) return base;
  try {
    const summary = readPackageManifest(path.resolve(dir, entry.path), entry.path);
    return { ...base, identity: summary.identity, version: summary.version, capabilities: summary.capabilities.length, skills: summary.skills };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

function row(extension: ResolvedExtension): Record<string, unknown> {
  const summary = readPackageManifest(extension.packageRoot);
  return {
    identity: extension.identity,
    version: extension.version,
    source: extension.source,
    origin: extension.origin,
    entry: extension.entry,
    packageRoot: extension.packageRoot,
    capabilities: summary.capabilities.length,
    skills: summary.skills,
    // Values may hold secrets read from the environment; only the keys are shown.
    ...(extension.configuration !== undefined && typeof extension.configuration === "object" ? { configurationKeys: Object.keys(extension.configuration as object) } : {}),
  };
}
