// The agent port alone as an npm tarball, for a host that runs Claude sessions through ClaudeAgentPort without the
// rest of the SDK (zyg-agents' engine):
//
//   node scripts/pack-agent-port.mjs [--out .pack]
//
// It holds two ESM entries, `@marshal/sdk/agent-port` and `@marshal/sdk/session-store`, bundled with the provider
// layer they reach, and their declarations. The only packages left external are the ones the host already has:
// `@marshal/agent-runtime-claude` and `zod` at runtime, `@anthropic-ai/claude-agent-sdk` for types. They are peers, so
// the host's own copies (its own patched runtime packs) are the ones used. Any other external import fails the pack.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(root, ".pack"));
const sdk = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const entries = { "agent-port": "src/agent-port.ts", "session-store": "src/session-store.ts" };
// The range each peer accepts: any runtime pack, zod 4 (the bundle imports zod/v4), the SDK's own Agent SDK pin.
const peers = {
  "@marshal/agent-runtime-claude": "*",
  zod: "^4.0.0",
  "@anthropic-ai/claude-agent-sdk": sdk.dependencies["@anthropic-ai/claude-agent-sdk"],
};

const stage = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "marshal-sdk-agent-port-"));
const result = await build({
  entryPoints: Object.fromEntries(Object.entries(entries).map(([name, source]) => [name, path.join(root, source)])),
  outdir: path.join(stage, "dist"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  metafile: true,
  logLevel: "warning",
});
const external = new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:") && !entry.path.startsWith("."))
    .map((entry) => entry.path),
);
const builtins = new Set((await import("node:module")).builtinModules);
const stray = [...external].filter((name) => !builtins.has(name) && !Object.keys(peers).some((peer) => name === peer || name.startsWith(`${peer}/`)));
if (stray.length) throw new Error(`The agent port reaches packages a host does not provide: ${stray.join(", ")}`);

// Declarations: tsc writes every file of the closure (the desktop-only typings of the provider layer report errors but
// still emit); only the files the two entries reach are packed.
const declarations = path.join(stage, "declarations");
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--ignoreConfig",
      ...Object.values(entries),
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      declarations,
      "--rootDir",
      ".",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2023",
      "--lib",
      "es2023,dom",
      "--types",
      "node",
      "--skipLibCheck",
      "--strict",
      "--verbatimModuleSyntax",
      "--resolveJsonModule",
    ],
    { cwd: root, stdio: "pipe" },
  );
} catch {
  // Emitted anyway; checked below.
}
// A provider-layer module tsc could not declare (desktop-only typings) is packed as an empty module: its types read as
// `any` in a host with skipLibCheck. The two entries themselves must be declared.
const entryDeclarations = Object.values(entries).map((source) => path.join(declarations, source.replace(/\.ts$/, ".d.ts")));
for (const file of entryDeclarations) if (!fs.existsSync(file)) throw new Error(`tsc wrote no declaration ${path.relative(declarations, file)}`);
const reached = new Set();
const pending = [...entryDeclarations];
while (pending.length) {
  const file = pending.pop();
  if (reached.has(file)) continue;
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "// Not declared: desktop-only typings.\nexport {};\n");
    console.warn(`pack-agent-port: ${path.relative(declarations, file)} has no declaration; packed as an empty module`);
  }
  reached.add(file);
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = path.resolve(path.dirname(file), match[1]).replace(/\.js$/, "");
    const index = path.join(target, "index.d.ts");
    pending.push(!fs.existsSync(`${target}.d.ts`) && fs.existsSync(index) ? index : `${target}.d.ts`);
  }
}
for (const file of reached) {
  const destination = path.join(stage, "types", path.relative(declarations, file));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}
fs.rmSync(declarations, { recursive: true, force: true });

const manifest = {
  name: sdk.name,
  version: `${sdk.version}-port.${sha.slice(0, 7)}`,
  description: "The Marshal SDK's Claude agent port and session store, for hosts that bring their own runtime packs.",
  type: "module",
  exports: Object.fromEntries(
    Object.entries(entries).map(([name, source]) => [
      `./${name}`,
      { types: `./types/${source.replace(/\.ts$/, ".d.ts")}`, import: `./dist/${name}.js` },
    ]),
  ),
  peerDependencies: peers,
  engines: sdk.engines,
  marshalSdk: { gitSha: sha },
};
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.mkdirSync(out, { recursive: true });
const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: stage, encoding: "utf8" }).trim().split("\n").pop();
fs.rmSync(stage, { recursive: true, force: true });
console.log(path.join(out, tarball));
