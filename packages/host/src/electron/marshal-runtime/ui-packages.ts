import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARSHAL_UI_STANDARD_ALIASES,
  MARSHAL_UI_THEME_TOKENS,
} from "../../common/runtime-ui-theme";

/**
 * Offline package allowlist for agent-authored UI. Everything here is bundled
 * by the runtime compiler from the installation's own node_modules; nothing is
 * fetched (the sandbox CSP stays `connect-src 'none'`).
 */
export const MARSHAL_UI_KIT_PACKAGE = "@marshal/ui-kit";

export const MARSHAL_UI_PACKAGE_IMPORTS: readonly string[] = Object.freeze([
  "recharts",
  "lucide-react",
  "date-fns",
  "motion",
  "d3-scale",
  "d3-shape",
  "clsx",
  MARSHAL_UI_KIT_PACKAGE,
]);

/**
 * Compiled once into shared vendor modules instead of per view (the react
 * family is implicit). lucide-react and date-fns stay per view on purpose:
 * they tree-shake to a few KB, whereas a whole-library vendor module would add
 * ~0.8 MB to every document that uses them.
 */
export const MARSHAL_UI_VENDOR_PACKAGES: readonly string[] = Object.freeze([
  "recharts",
  "motion",
  "d3-scale",
  "d3-shape",
  "clsx",
  MARSHAL_UI_KIT_PACKAGE,
]);

/** Stateless libraries that vendor modules bundle (tree-shaken) rather than share. */
export const MARSHAL_UI_VENDOR_PRIVATE_DEPENDENCIES: readonly string[] = Object.freeze([
  "d3-scale",
  "d3-shape",
  "clsx",
]);

export const MARSHAL_UI_PROFILE_ID = "marshal-ui";
export const MARSHAL_UI_PROFILE_VERSION = "1.0.0";

const RESOLVE_CONDITIONS = ["import", "browser", "module", "default"] as const;

export interface MarshalUiPackageRoots {
  /** Directory holding `node_modules/` with real files (app.asar.unpacked when packaged). */
  readonly packagesRoot: string;
  /** Directory holding `packages/marshal-ui-kit`. */
  readonly uiKitRoot: string;
}

function findAppPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Unable to locate the app package root from ${startDir}`);
    dir = parent;
  }
  return dir;
}

export function resolveMarshalUiPackageRoots(
  startDir = path.dirname(fileURLToPath(import.meta.url)),
): MarshalUiPackageRoots {
  const appRoot = findAppPackageRoot(startDir);
  const packagesRoot = path.basename(appRoot) === "app.asar" ? `${appRoot}.unpacked` : appRoot;
  return { packagesRoot, uiKitRoot: path.join(packagesRoot, "packages", "marshal-ui-kit") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(manifestPath: string): Record<string, unknown> {
  // SF-4: manifests ship inside the app bundle and are not user-writable.
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function pickCondition(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const entry of target) {
      const picked = pickCondition(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  if (isRecord(target)) {
    for (const key of Object.keys(target)) {
      if (!RESOLVE_CONDITIONS.some((condition) => condition === key)) continue;
      const picked = pickCondition(target[key]);
      if (picked) return picked;
    }
  }
  return undefined;
}

function resolveExportsTarget(exportsField: unknown, subpath: string): string | undefined {
  if (exportsField === undefined || exportsField === null) return undefined;
  if (!isRecord(exportsField) || !Object.keys(exportsField).some((key) => key.startsWith("."))) {
    return subpath === "." ? pickCondition(exportsField) : undefined;
  }
  const map = exportsField;
  if (subpath in map) return pickCondition(map[subpath]);
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const target = pickCondition(map[key]);
      if (target)
        return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return undefined;
}

const LUCIDE_PACKAGE = "lucide-react";
const LUCIDE_ICON_SUBPATH = /^\.\/icons\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * The lucide-react root barrel re-exports every icon, so the compiler would load
 * about 8,000 files (~10 s). `lucide-react/icons/<kebab-name>` loads one icon file.
 */
function resolveLucideIcon(subpath: string): string | undefined {
  const match = LUCIDE_ICON_SUBPATH.exec(subpath);
  return match ? `./dist/esm/icons/${match[1]}.mjs` : undefined;
}

function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

/**
 * Resolves an allow-listed bare import to an absolute file path, preferring
 * ESM entry points so the bundler can tree-shake. Returns undefined for any
 * package outside the allowlist.
 */
export function resolveMarshalUiPackage(
  specifier: string,
  roots: MarshalUiPackageRoots = resolveMarshalUiPackageRoots(),
): string | undefined {
  const { name, subpath } = splitSpecifier(specifier);
  if (!MARSHAL_UI_PACKAGE_IMPORTS.includes(name)) return undefined;
  const packageDir =
    name === MARSHAL_UI_KIT_PACKAGE
      ? roots.uiKitRoot
      : path.join(roots.packagesRoot, "node_modules", name);
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest = readManifest(manifestPath);
  const exported =
    name === LUCIDE_PACKAGE
      ? resolveLucideIcon(subpath)
      : resolveExportsTarget(manifest.exports, subpath);
  const declaredEntry = [manifest.module, manifest.main].find(
    (entry): entry is string => typeof entry === "string",
  );
  const relative = exported ?? (subpath === "." ? (declaredEntry ?? "index.js") : subpath.slice(2));
  const resolved = path.resolve(packageDir, relative);
  if (resolved !== packageDir && !resolved.startsWith(packageDir + path.sep)) return undefined;
  return fs.existsSync(resolved) ? resolved : undefined;
}

export function createMarshalUiPackageResolver(
  roots: MarshalUiPackageRoots = resolveMarshalUiPackageRoots(),
): (specifier: string) => string | undefined {
  return (specifier) => resolveMarshalUiPackage(specifier, roots);
}

const GUIDANCE =
  "Import from recharts, lucide-react, date-fns, motion, d3-scale, d3-shape, clsx and @marshal/ui-kit (Button, Card, Table, Tabs, Stat, charts theme). Style with the Marshal CSS variables (var(--card), var(--border), var(--chart-1)); never hard-code colors.";

/** The Marshal authoring profile handed to the runtime compiler (react-ui provider options). */
export function createMarshalUiAuthoringProfile() {
  return {
    id: MARSHAL_UI_PROFILE_ID,
    version: MARSHAL_UI_PROFILE_VERSION,
    portable: false,
    packageImports: MARSHAL_UI_PACKAGE_IMPORTS,
    designTokens: Object.fromEntries([
      ...MARSHAL_UI_THEME_TOKENS.map((entry) => [entry.name, entry.role]),
      ...MARSHAL_UI_STANDARD_ALIASES.map(([name, value]) => [name, value]),
    ]),
    templates: [],
    authoringGuidance: GUIDANCE,
    accessibilityRequirements: [
      "Meet WCAG 2.2 AA contrast in light and dark; use theme variables so both themes work.",
      "Every control is keyboard reachable with a visible focus ring and an accessible name; prefer @marshal/ui-kit controls.",
      "Honor prefers-reduced-motion for motion/framer-motion animations.",
    ],
    layoutConstraints: [
      "Usable from 320 CSS pixels; avoid fixed widths; charts use a responsive container with a fixed height.",
    ],
    requiredHostCapabilities: [],
    optionalHostExtensions: [],
  } as const;
}

const LUCIDE_BARREL_EXPORT = /export \{([^}]+)\} from '\.\/icons\/([a-z0-9-]+)\.mjs'/g;
const DATE_FNS_FUNCTION = /^[a-z][A-Za-z0-9]*$/;
const DATE_FNS_PACKAGE = "date-fns";

function packageVersion(roots: MarshalUiPackageRoots, name: string): string {
  const manifestPath = path.join(roots.packagesRoot, "node_modules", name, "package.json");
  if (!fs.existsSync(manifestPath)) return "missing";
  const version = readManifest(manifestPath).version;
  return typeof version === "string" ? version : "unknown";
}

/** Icon export name (Activity, ActivityIcon, LucideActivity, ...) to its `lucide-react/icons/<file>` specifier. */
function createLucideIconMap(roots: MarshalUiPackageRoots): Map<string, string> {
  const icons = new Map<string, string>();
  const barrel = path.join(
    roots.packagesRoot,
    "node_modules",
    LUCIDE_PACKAGE,
    "dist/esm/lucide-react.mjs",
  );
  if (!fs.existsSync(barrel)) return icons;
  for (const match of fs.readFileSync(barrel, "utf8").matchAll(LUCIDE_BARREL_EXPORT)) {
    for (const part of match[1].split(",")) {
      const name = /default as ([A-Za-z0-9_$]+)/.exec(part)?.[1];
      if (name) icons.set(name, `${LUCIDE_PACKAGE}/icons/${match[2]}`);
    }
  }
  return icons;
}

/**
 * Maps `import { Activity } from "lucide-react"` and `import { format } from "date-fns"`
 * to per-icon / per-function default imports, so the bundler never walks the
 * thousands-of-files barrels. Anything not in a map keeps its original import.
 */
export function createMarshalUiDefaultImportRewrites(
  roots: MarshalUiPackageRoots = resolveMarshalUiPackageRoots(),
) {
  let lucideIcons: Map<string, string> | undefined;
  const dateFnsCache = new Map<string, string | undefined>();
  const dateFnsExports = (() => {
    const manifestPath = path.join(
      roots.packagesRoot,
      "node_modules",
      DATE_FNS_PACKAGE,
      "package.json",
    );
    if (!fs.existsSync(manifestPath)) return {};
    const exported = readManifest(manifestPath).exports;
    return typeof exported === "object" && exported !== null ? exported : {};
  })();
  return {
    rewrites: {
      [LUCIDE_PACKAGE]: (name: string) => (lucideIcons ??= createLucideIconMap(roots)).get(name),
      [DATE_FNS_PACKAGE]: (name: string): string | undefined => {
        if (!DATE_FNS_FUNCTION.test(name) || !(`./${name}` in dateFnsExports)) return undefined;
        if (!dateFnsCache.has(name)) {
          const file = resolveMarshalUiPackage(`${DATE_FNS_PACKAGE}/${name}`, roots);
          const hasDefault =
            file !== undefined && /\bexport default\b/.test(fs.readFileSync(file, "utf8"));
          dateFnsCache.set(name, hasDefault ? `${DATE_FNS_PACKAGE}/${name}` : undefined);
        }
        return dateFnsCache.get(name);
      },
    },
    version: `lucide@${packageVersion(roots, LUCIDE_PACKAGE)};date-fns@${packageVersion(roots, DATE_FNS_PACKAGE)};r1`,
  };
}

/** `reactUi` options for `createRuntimeBuiltinsSource`. */
export function createMarshalReactUiOptions(
  roots: MarshalUiPackageRoots = resolveMarshalUiPackageRoots(),
) {
  const profile = createMarshalUiAuthoringProfile();
  const importRewrites = createMarshalUiDefaultImportRewrites(roots);
  return {
    defaultImportRewrites: importRewrites.rewrites,
    defaultImportRewritesVersion: importRewrites.version,
    allowedPackages: MARSHAL_UI_PACKAGE_IMPORTS,
    vendorPackages: MARSHAL_UI_VENDOR_PACKAGES,
    vendorBundledDependencies: MARSHAL_UI_VENDOR_PRIVATE_DEPENDENCIES,
    authoringProfiles: [profile],
    preferredAuthoringProfile: { id: profile.id, version: profile.version },
    packageImportResolver: createMarshalUiPackageResolver(roots),
  };
}
