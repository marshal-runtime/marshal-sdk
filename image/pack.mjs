// One installable artifact: marshal-sdk with the desktop's pinned runtime packs bundled inside it and the
// extensions it serves, as a single npm tarball. Installing it is one step and needs only the public registry:
//
//   node image/pack.mjs [--out .pack] [--packs <desktop checkout>] [--extension <packageRoot>]...
//   npm install -g .pack/marshal-sdk-<version>.tgz      # then: marshal-sdk page-run --help
//
// The packs are the exact tarballs the desktop pins (its package.json pnpm.overrides), unpacked into the
// package's node_modules and listed in bundleDependencies, so npm installs them as shipped. Their own
// registry dependencies are declared at the top level (npm does not resolve dependencies of bundled packages),
// at the packs' own ranges. Extensions are copied file by file (no node_modules, no credential-shaped files)
// into extensions/<short name>; page-run finds Page Studio at extensions/page-studio.
// Chromium is not inside: install it after the package with its own Playwright,
//   node "$(npm root -g)/@marshal/sdk/node_modules/playwright-core/cli.js" install --with-deps chromium
// or point MARSHAL_SDK_CHROME at one.
//
// TODO(extension onboarding): take the extension list from the onboarding manifest once that lane lands its
// format; until then the list is --extension (repeatable), default Page Studio's built package.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { out: path.join(root, ".pack"), packs: "/Users/omer/marshal/marshal", extension: [] };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  const value = process.argv[index + 1];
  if (!value) throw new Error(`--${key} needs a value`);
  if (key === "extension") args.extension.push(path.resolve(value));
  else args[key] = path.resolve(value);
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
  if (!pin?.startsWith("file:")) throw new Error(`The desktop at ${args.packs} pins no pack for ${name}.`);
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

const copyTree = (from, to) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || /(^|\.)env($|\.)|^(auth|credentials)\.json$/i.test(entry.name)) continue;
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

execFileSync(process.execPath, [path.join(root, "build.mjs")], { cwd: root, stdio: "inherit" });
fs.mkdirSync(path.join(staging, "dist", "src"), { recursive: true });
copyTree(path.join(root, "dist", "src"), path.join(staging, "dist", "src"));

const extensions = [];
for (const packageRoot of args.extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "runtime-extension.json"), "utf8"));
  const name = manifest.identity.replace(/^@[^/]+\//, "");
  fs.mkdirSync(path.join(staging, "extensions", name), { recursive: true });
  copyTree(packageRoot, path.join(staging, "extensions", name));
  extensions.push({ identity: manifest.identity, version: manifest.version, path: `extensions/${name}` });
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
