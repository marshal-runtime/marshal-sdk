// One installable artifact: marshal-sdk with its pinned runtime packs bundled inside it and the
// extensions it serves, as a single npm tarball. Installing it is one step and needs only the public registry:
//
//   node image/pack.mjs [--out .pack] [--packs <checkout with pins>] [--manifest marshal-sdk.json] [--extension <packageRoot>]...
//   npm install .pack/marshal-sdk-<version>.tgz         # then: npx marshal-sdk page-run --help
// Install into a folder, not with -g: a global install of a package with bundled dependencies rebuilds an optional
// native dependency (fsevents) and fails on macOS.
//
// The packs are the exact tarballs --packs pins in its package.json pnpm.overrides (default: this SDK's own
// vendor/packs; a desktop checkout works too), unpacked into the
// package's node_modules and listed in bundleDependencies, so npm installs them as shipped. Their own
// registry dependencies are declared at the top level (npm does not resolve dependencies of bundled packages),
// at the packs' own ranges. Extensions are copied file by file (no node_modules, no credential-shaped files)
// into extensions/<short name>; page-run finds Page Studio at extensions/page-studio.
// Chromium is not inside: install it after the package with its own Playwright,
//   node <install dir>/node_modules/playwright-core/cli.js install --with-deps chromium
// or point MARSHAL_SDK_CHROME at one.
//
// The extension list: --manifest <marshal-sdk.json>, resolved by the onboarding resolver (docs/onboarding.md: path,
// archive + sha256 and organization id entries, archives unpacked under --cache) and/or --extension <packageRoot>
// (repeatable); with neither, Page Studio's built package. Configuration stays in the manifest of the run.
// A manifest also brings the SDK's default extensions it does not opt out of (the Brain always, found through
// $MARSHAL_SDK_BRAIN_PACKAGE and packed into extensions/brain, where the installed SDK finds it; the org and Zyg tools where they apply); "defaults": {"brain": false} leaves the Brain out.
// The Brain needs Node 24 (FTS5) where it runs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { out: path.join(root, ".pack"), packs: root, extension: [] };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${key} needs a value`);
  if (key === "extension") args.extension.push(path.resolve(value));
  else args[key] = path.resolve(value);
}
execFileSync(process.execPath, [path.join(root, "build.mjs")], { cwd: root, stdio: "inherit" });
// A default extension (docs/onboarding.md "Default extensions") goes where the SDK looks for its bundled copy.
const bundledAt = new Map();
if (args.manifest) {
  const { resolveManifest, DEFAULT_EXTENSIONS } = await import(path.join(root, "dist", "src", "onboarding.js"));
  const resolved = await resolveManifest(args.manifest, args.cache ? { cacheDir: args.cache } : {});
  // `extensions` leaves out the Brain (it loads through the kit); `defaults` has every default, the Brain included.
  args.extension.push(...new Set([...resolved.defaults, ...resolved.extensions].map((extension) => extension.packageRoot)));
  for (const extension of resolved.defaults) {
    const spec = DEFAULT_EXTENSIONS.find((candidate) => candidate.identity === extension.identity);
    if (spec?.bundled) bundledAt.set(extension.packageRoot, spec.bundled);
  }
}
if (!args.extension.length) args.extension.push("/Users/omer/marshal-tracking/page-studio/out/package");

const sdk = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const desktop = JSON.parse(fs.readFileSync(path.join(args.packs, "package.json"), "utf8"));
const pins = { ...desktop.dependencies, ...desktop.pnpm?.overrides };
const manifestOf = (tarball) => JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));

const staging = path.join(args.out, "staging");
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, "node_modules", "@marshal"), { recursive: true });

// The @marshal closure of what marshal-sdk imports, unpacked as shipped.
const packs = {};
const registry = {};
const queue = Object.keys(sdk.dependencies).filter((name) => name.startsWith("@marshal/"));
while (queue.length) {
  const name = queue.shift();
  if (packs[name]) continue;
  const pin = pins[name];
  if (!pin?.startsWith("file:")) throw new Error(`${args.packs}/package.json pins no pack for ${name}.`);
  const tarball = path.join(args.packs, pin.slice("file:".length));
  const manifest = manifestOf(tarball);
  packs[name] = { version: manifest.version, tarball: path.basename(tarball) };
  const target = path.join(staging, "node_modules", name);
  fs.mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@marshal/")) queue.push(dependency);
    else (registry[dependency] ??= new Set()).add(range);
  }
}

// Registry dependencies of the packs, hoisted. Where two packs ask for different ranges the narrower one
// that satisfies both is chosen by hand below; anything else unexpected stops the build.
const AGREED = { typescript: "^5.8.0" };
const hoisted = {};
for (const [name, ranges] of Object.entries(registry)) {
  const own = sdk.dependencies[name];
  if (own) {
    hoisted[name] = own;
    continue;
  }
  if (ranges.size === 1) hoisted[name] = [...ranges][0];
  else if (AGREED[name]) hoisted[name] = AGREED[name];
  else throw new Error(`Packs disagree on ${name}: ${[...ranges].join(", ")}; add the agreed range to AGREED.`);
}

const unshippable = (name) => name === "node_modules" || name === ".git" || /(^|\.)env($|\.)|^(auth|credentials)\.json$/i.test(name);
const copyTree = (from, to) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (unshippable(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    } else {
      throw new Error(`Only ordinary files go into the package: ${source}`);
    }
  }
};

fs.mkdirSync(path.join(staging, "dist", "src"), { recursive: true });
copyTree(path.join(root, "dist", "src"), path.join(staging, "dist", "src"));

// An extension with a package.json ships what npm would publish from it (a source checkout such as the Brain's
// carries its .git and tests otherwise); a built folder without one is copied whole.
const copyExtension = (packageRoot, target) => {
  if (!fs.existsSync(path.join(packageRoot, "package.json"))) return copyTree(packageRoot, target);
  const listed = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const [{ files }] = JSON.parse(listed);
  for (const file of new Set([...files.map((entry) => entry.path), "package.json", "runtime-extension.json"])) {
    if (file.split("/").some(unshippable)) continue;
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(packageRoot, file), path.join(target, file));
  }
};

const extensions = [];
for (const packageRoot of args.extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "runtime-extension.json"), "utf8"));
  const at = bundledAt.get(packageRoot) ?? `extensions/${manifest.identity.replace(/^@[^/]+\//, "")}`;
  fs.mkdirSync(path.join(staging, at), { recursive: true });
  copyExtension(packageRoot, path.join(staging, at));
  extensions.push({ identity: manifest.identity, version: manifest.version, path: at });
}

const dependencies = Object.fromEntries(
  Object.entries({ ...sdk.dependencies, ...hoisted }).map(([name, version]) => [name, packs[name]?.version ?? version]),
);
const bundled = Object.keys(packs).sort();
for (const name of bundled) dependencies[name] = packs[name].version;
const inventory = { sdk: sdk.version, builtAt: new Date().toISOString(), packs, hoisted, extensions };
fs.writeFileSync(path.join(staging, "inventory.json"), JSON.stringify(inventory, null, 2));
fs.writeFileSync(
  path.join(staging, "package.json"),
  JSON.stringify(
    {
      name: sdk.name,
      version: sdk.version,
      description: sdk.description,
      type: "module",
      main: sdk.main,
      bin: sdk.bin,
      engines: { node: ">=24.14.0" },
      files: ["dist/src", "extensions", "inventory.json"],
      dependencies: Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))),
      bundleDependencies: bundled,
    },
    null,
    2,
  ),
);
const packed = execFileSync("npm", ["pack", "--json", "--pack-destination", args.out], { cwd: staging, encoding: "utf8" });
const [{ filename, size, entryCount }] = JSON.parse(packed);
const artifact = path.join(args.out, filename.replace(/^@marshal-/, "marshal-"));
if (path.join(args.out, filename) !== artifact) fs.renameSync(path.join(args.out, filename), artifact);
fs.writeFileSync(path.join(args.out, "inventory.json"), JSON.stringify({ ...inventory, artifact: path.basename(artifact) }, null, 2));
process.stdout.write(
  `${artifact}: ${(size / 1e6).toFixed(1)} MB, ${entryCount} files, ${bundled.length} bundled packs, ${extensions.length} extension(s): ${extensions.map((extension) => `${extension.identity}@${extension.version}`).join(", ")}\n`,
);
