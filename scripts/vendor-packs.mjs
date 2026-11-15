// Vendors the Marshal runtime packs this SDK builds on, from a Marshal desktop checkout that pins them:
//
//   node scripts/vendor-packs.mjs --from <desktop checkout>    # then: pnpm install
//
// The desktop pins every @marshal package as a tarball in .marshal-runtime-packs/archives (its package.json
// dependencies and pnpm.overrides). This copies the @marshal closure of what the SDK imports into vendor/packs,
// points package.json at those files (dependencies for direct imports, pnpm.overrides for the whole closure,
// so a pack's own @marshal dependencies resolve to the same tarballs) and records where they came from in
// vendor/packs/SOURCE.json. The SDK then installs on its own, with no desktop checkout on the machine.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fromIndex = process.argv.indexOf("--from");
const desktopRoot = fromIndex > 0 ? path.resolve(process.argv[fromIndex + 1] ?? "") : undefined;
if (!desktopRoot || !fs.existsSync(path.join(desktopRoot, ".marshal-runtime-packs"))) {
  throw new Error("Usage: node scripts/vendor-packs.mjs --from <Marshal desktop checkout with .marshal-runtime-packs>");
}

const packageJsonPath = path.join(root, "package.json");
const sdk = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const desktop = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const pins = { ...desktop.dependencies, ...desktop.pnpm?.overrides };
const manifestOf = (tarball) =>
  JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));

const direct = Object.keys(sdk.dependencies).filter((name) => name.startsWith("@marshal/"));
const closure = new Map();
const queue = [...direct];
while (queue.length) {
  const name = queue.shift();
  if (closure.has(name)) continue;
  const pin = pins[name];
  if (!pin?.startsWith("file:")) throw new Error(`The desktop at ${desktopRoot} pins no pack for ${name}.`);
  const tarball = path.join(desktopRoot, pin.slice("file:".length));
  closure.set(name, tarball);
  for (const dependency of Object.keys(manifestOf(tarball).dependencies ?? {})) {
    if (dependency.startsWith("@marshal/")) queue.push(dependency);
  }
}

const vendor = path.join(root, "vendor", "packs");
fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });
const specOf = new Map();
const archives = [];
for (const [name, tarball] of [...closure].sort(([left], [right]) => left.localeCompare(right))) {
  const file = path.basename(tarball);
  fs.copyFileSync(tarball, path.join(vendor, file));
  specOf.set(name, `file:vendor/packs/${file}`);
  archives.push({
    name,
    archive: file,
    sha256: createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
  });
}

for (const name of direct) sdk.dependencies[name] = specOf.get(name);
sdk.pnpm = { ...sdk.pnpm, overrides: Object.fromEntries([...specOf].sort(([left], [right]) => left.localeCompare(right))) };
fs.writeFileSync(packageJsonPath, `${JSON.stringify(sdk, null, 2)}\n`);

const git = (...args) => execFileSync("git", args, { cwd: desktopRoot, encoding: "utf8" }).trim();
const desktopManifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, ".marshal-runtime-packs", "manifest.json"), "utf8"));
fs.writeFileSync(
  path.join(vendor, "SOURCE.json"),
  `${JSON.stringify(
    {
      desktop: { commit: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD") },
      runtimeSource: desktopManifest.source,
      archives,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Vendored ${archives.length} packs into vendor/packs:\n${archives.map((entry) => `  ${entry.archive}`).join("\n")}\n`);
