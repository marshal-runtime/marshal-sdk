// Builds the image context for a Linux marshal-sdk host: real dependencies, never the dev node_modules.
//
//   node image/prepare.mjs [--out .image] [--packs <checkout with pins>] [--extension <packageRoot>]...
//
// The runtime packs are the exact tarballs --packs pins in its package.json pnpm.overrides (default: this SDK's
// own vendor/packs; a desktop checkout works too), copied into
// vendor/ and wired as file: dependencies plus overrides, as zyg-agents' vendor/runtime does. Only the
// closure of what marshal-sdk imports is copied. Extensions are copied file by file from their built package
// (no node_modules, no credential-shaped files) into extensions/<name>.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { out: path.join(root, ".image"), packs: root, extension: [] };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  const value = process.argv[index + 1];
  if (key === "extension") args.extension.push(path.resolve(value));
  else args[key] = path.resolve(value);
}
if (!args.extension.length) args.extension.push("/Users/omer/marshal-tracking/page-studio/out/package");

const sdk = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const desktop = JSON.parse(fs.readFileSync(path.join(args.packs, "package.json"), "utf8"));
const pins = { ...desktop.dependencies, ...desktop.pnpm?.overrides };

fs.rmSync(args.out, { recursive: true, force: true });
fs.mkdirSync(path.join(args.out, "vendor"), { recursive: true });

const manifestOf = (tarball) => JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
const overrides = {};
const queue = Object.keys(sdk.dependencies).filter((name) => name.startsWith("@marshal/"));
while (queue.length) {
  const name = queue.shift();
  if (overrides[name]) continue;
  const pin = pins[name];
  if (!pin?.startsWith("file:")) throw new Error(`${args.packs}/package.json pins no pack for ${name}.`);
  const tarball = path.join(args.packs, pin.slice("file:".length));
  fs.copyFileSync(tarball, path.join(args.out, "vendor", path.basename(tarball)));
  overrides[name] = `file:vendor/${path.basename(tarball)}`;
  for (const dependency of Object.keys(manifestOf(tarball).dependencies ?? {})) {
    if (dependency.startsWith("@marshal/")) queue.push(dependency);
  }
}

const dependencies = Object.fromEntries(
  Object.entries(sdk.dependencies).map(([name, version]) => [name, overrides[name] ?? version]),
);
fs.writeFileSync(
  path.join(args.out, "package.json"),
  JSON.stringify(
    {
      name: "@marshal/sdk-image",
      version: sdk.version,
      private: true,
      type: "module",
      // Corepack otherwise fetches the newest pnpm, which no longer reads the pnpm field below.
      packageManager: desktop.packageManager,
      dependencies,
      pnpm: { overrides, onlyBuiltDependencies: ["esbuild"] },
    },
    null,
    2,
  ),
);

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
      throw new Error(`Only ordinary files go into the image: ${source}`);
    }
  }
};

execFileSync(process.execPath, [path.join(root, "build.mjs")], { cwd: root, stdio: "inherit" });
for (const directory of ["dist/src", "poc"]) {
  fs.mkdirSync(path.join(args.out, directory), { recursive: true });
  copyTree(path.join(root, directory), path.join(args.out, directory));
}
const extensions = [];
for (const packageRoot of args.extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "runtime-extension.json"), "utf8"));
  const name = manifest.identity.replace(/^@/, "").replaceAll("/", "__");
  fs.mkdirSync(path.join(args.out, "extensions", name), { recursive: true });
  copyTree(packageRoot, path.join(args.out, "extensions", name));
  extensions.push({ identity: manifest.identity, version: manifest.version, packageRoot: `/opt/marshal-sdk/extensions/${name}` });
}
fs.writeFileSync(path.join(args.out, "inventory.json"), JSON.stringify({ packs: overrides, extensions }, null, 2));
fs.copyFileSync(path.join(root, "image", "Dockerfile"), path.join(args.out, "Dockerfile"));
process.stdout.write(`image context at ${args.out}: ${Object.keys(overrides).length} runtime packs, ${extensions.length} extension(s)\n`);
