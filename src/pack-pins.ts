import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * One pack manifest for two shells: the SDK vendors the Marshal runtime packs from a desktop checkout
 * (scripts/vendor-packs.mjs), and these checks fail when the two stop resolving the same builds.
 */

export interface VendoredPack {
  name: string;
  archive: string;
  sha256: string;
}

export interface PackDrift {
  name: string;
  problem: string;
}

const VENDOR_DIR = path.join("vendor", "packs");
const SPEC_PREFIX = `file:${VENDOR_DIR.split(path.sep).join("/")}/`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function readVendoredPacks(sdkRoot: string): VendoredPack[] {
  const source = JSON.parse(fs.readFileSync(path.join(sdkRoot, VENDOR_DIR, "SOURCE.json"), "utf8")) as { archives?: VendoredPack[] };
  return source.archives ?? [];
}

/** package.json, vendor/packs and SOURCE.json agree: every @marshal spec is a vendored tarball with its recorded hash. */
export function checkSdkPins(sdkRoot: string): PackDrift[] {
  const drift: PackDrift[] = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
  };
  const vendored = new Map(readVendoredPacks(sdkRoot).map((pack) => [pack.name, pack]));
  const overrides = Object.entries(pkg.pnpm?.overrides ?? {}).filter(([name]) => name.startsWith("@marshal/"));
  const direct = Object.entries(pkg.dependencies ?? {}).filter(([name]) => name.startsWith("@marshal/"));
  for (const [where, entries] of [["pnpm.overrides", overrides], ["dependencies", direct]] as const) {
    for (const [name, spec] of entries) {
      const pack = vendored.get(name);
      if (!pack) drift.push({ name, problem: `${where} pins ${spec}, but vendor/packs/SOURCE.json lists no such pack` });
      else if (spec !== `${SPEC_PREFIX}${pack.archive}`) drift.push({ name, problem: `${where} pins ${spec}, SOURCE.json has ${pack.archive}` });
    }
  }
  const overridden = new Set(overrides.map(([name]) => name));
  for (const pack of vendored.values()) {
    if (!overridden.has(pack.name)) drift.push({ name: pack.name, problem: "vendored but missing from pnpm.overrides" });
    const file = path.join(sdkRoot, VENDOR_DIR, pack.archive);
    if (!fs.existsSync(file)) drift.push({ name: pack.name, problem: `vendor/packs/${pack.archive} is missing` });
    else if (sha256(fs.readFileSync(file)) !== pack.sha256) drift.push({ name: pack.name, problem: `vendor/packs/${pack.archive} does not match its SOURCE.json hash` });
  }
  return drift;
}

export interface DesktopPins {
  /** The desktop commit read (the working tree reads as HEAD plus local changes). */
  commit: string;
  /** Pack name to its pinned archive path, relative to the desktop root. */
  pins: Record<string, string>;
  read(relativePath: string): Uint8Array;
}

/**
 * A desktop checkout's pack pins (package.json dependencies and pnpm.overrides, overrides winning, as
 * vendor-packs.mjs reads them), from its working tree or from `ref` without touching the checkout.
 */
export function readDesktopPins(desktopRoot: string, ref?: string): DesktopPins {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: desktopRoot, maxBuffer: 1 << 28 });
  const read = ref
    ? (relativePath: string) => new Uint8Array(git("show", `${ref}:${relativePath}`))
    : (relativePath: string) => new Uint8Array(fs.readFileSync(path.join(desktopRoot, relativePath)));
  const pkg = JSON.parse(Buffer.from(read("package.json")).toString("utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
  };
  const pins: Record<string, string> = {};
  for (const [name, spec] of Object.entries({ ...pkg.devDependencies, ...pkg.dependencies, ...pkg.pnpm?.overrides })) {
    if (name.startsWith("@marshal/") && spec.startsWith("file:")) pins[name] = spec.slice("file:".length);
  }
  let commit = ref ?? "working tree";
  try {
    commit = git("rev-parse", "--short", ref ?? "HEAD").toString("utf8").trim() + (ref ? "" : " (working tree)");
  } catch {
    // Not a git checkout: the label stays as is.
  }
  return { commit, pins, read };
}

/** Every pack the SDK vendors is pinned by the desktop to the same archive, byte for byte. */
export function checkAgainstDesktop(sdkRoot: string, desktop: DesktopPins): PackDrift[] {
  const drift: PackDrift[] = [];
  for (const pack of readVendoredPacks(sdkRoot)) {
    const pin = desktop.pins[pack.name];
    if (!pin) {
      drift.push({ name: pack.name, problem: `the desktop (${desktop.commit}) pins no ${pack.name}` });
      continue;
    }
    if (path.posix.basename(pin) !== pack.archive) {
      drift.push({ name: pack.name, problem: `SDK ${pack.archive}, desktop (${desktop.commit}) ${path.posix.basename(pin)}` });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = desktop.read(pin);
    } catch {
      drift.push({ name: pack.name, problem: `the desktop (${desktop.commit}) pins ${pin}, which it does not have` });
      continue;
    }
    if (sha256(bytes) !== pack.sha256) drift.push({ name: pack.name, problem: `${pack.archive} differs from the desktop's (${desktop.commit}) file of that name` });
  }
  return drift;
}
