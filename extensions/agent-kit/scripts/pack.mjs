// The kit as an npm tarball for a host (zyg-agents vendors it like the agent port):
//
//   node extensions/agent-kit/scripts/pack.mjs [--out .pack]
//
// One ESM bundle of src/index.ts (Marley's copied components, the SDK pieces they reach) and its declarations. Packages the
// host already has stay external as peers; any other external import fails the pack.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(kit, "../..");
const outIndex = process.argv.indexOf("--out");
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(kit, ".pack"));
const sdk = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const kitPackage = JSON.parse(fs.readFileSync(path.join(kit, "package.json"), "utf8"));
const source = JSON.parse(fs.readFileSync(path.join(kit, "source.json"), "utf8"));
const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const aliases = {
  "@zygstinct/marshal-sdk-port": "src/compat/sdk-port-core.ts",
  "@zygstinct/marshal-sdk-port/host": "src/compat/sdk-port-host.ts",
  "@zygstinct/marshal-sdk-port/agent-sdk": "src/compat/sdk-port-agent-sdk.ts",
  "@zygstinct/shared": "src/compat/zygstinct-shared.ts",
  "@zygstinct/log": "src/compat/zygstinct-log.ts",
  "@zygstinct/routines-public": "src/compat/zygstinct-routines-public.ts",
  "@zygstinct/brand-brain": "src/compat/zygstinct-brand-brain.ts",
};
const aliasResolver = {
  name: "kit-aliases",
  setup(pack) {
    pack.onResolve({ filter: /^@zygstinct\// }, (args) => (aliases[args.path] ? { path: path.join(kit, aliases[args.path]) } : undefined));
  },
};
// As Marley's own build of the port (packages/marshal-sdk-port/vendor.mjs): the port's permission-handler translation is the only reason it
// imports the provider layer, and the kit sets no permission handler, so that import is a module that throws when used.
const providersShim = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "agent-kit-shim-")), "providers-shim.mjs");
fs.writeFileSync(providersShim, ["toClaudePermissionResult", "toRuntimePermissionRequest", "toRuntimePermissionHandler", "assertProxyEndpoint"].map((name) => `export function ${name}() { throw new Error("${name}: the agent kit's core entry has no provider layer"); }`).join("\n") + "\n");
const providersResolver = {
  name: "providers-shim",
  setup(pack) {
    pack.onResolve({ filter: /\/providers\.js$/ }, (args) => (args.importer.startsWith(path.join(root, "src")) ? { path: providersShim } : undefined));
    pack.onResolve({ filter: /^(@cursor\/sdk|@openai\/codex-sdk|@openai\/agents)(\/.*)?$/ }, () => ({ path: providersShim }));
  },
};
const peers = {
  "@anthropic-ai/claude-agent-sdk": sdk.dependencies["@anthropic-ai/claude-agent-sdk"],
  zod: "^4.0.0",
  "better-sqlite3": kitPackage.dependencies["better-sqlite3"],
  pg: kitPackage.dependencies.pg,
  yaml: "^2.0.0",
};
// Only the `./daytona` entry reaches these; a host that uses the outbox alone does not install them.
const daytonaPeers = { "@daytona/sdk": kitPackage.dependencies["@daytona/sdk"], ws: kitPackage.dependencies.ws };
const peerPrefixes = ["@marshal/agent-runtime-"];

const stage = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "marshal-agent-kit-"));
const result = await build({
  entryPoints: { index: path.join(kit, "src/index.ts"), daytona: path.join(kit, "src/daytona.ts") },
  outdir: path.join(stage, "dist"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [...Object.keys({ ...peers, ...daytonaPeers }).flatMap((name) => [name, `${name}/*`]), ...peerPrefixes.map((prefix) => `${prefix}*`)],
  loader: { ".map": "empty" },
  metafile: true,
  logLevel: "warning",
  plugins: [aliasResolver, providersResolver],
  banner: { js: "import { createRequire as __kitCreateRequire } from 'node:module'; const require = __kitCreateRequire(import.meta.url);" },
});
const builtins = new Set(builtinModules);
const external = new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:") && !entry.path.startsWith("."))
    .map((entry) => entry.path),
);
const stray = [...external].filter((name) => !builtins.has(name) && !Object.keys({ ...peers, ...daytonaPeers }).some((peer) => name === peer || name.startsWith(`${peer}/`)) && !peerPrefixes.some((prefix) => name.startsWith(prefix)));
if (stray.length) throw new Error(`The kit reaches packages a host does not provide: ${stray.join(", ")}`);

const declarations = path.join(stage, "types");
const declareConfig = path.join(kit, "tsconfig.declare.json");
fs.writeFileSync(declareConfig, `${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: declarations, rootDir: "./src" }, files: ["src/index.ts", "src/daytona.ts"], include: [] }, null, 2)}\n`);
try {
  execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", declareConfig], { cwd: kit, stdio: "pipe" });
} catch (error) {
  throw new Error(`tsc could not declare the kit: ${String(error.stdout ?? error)}`);
} finally {
  fs.rmSync(declareConfig, { force: true });
}
for (const tree of Object.keys(source.typeTrees ?? {})) fs.cpSync(path.join(kit, "src/marley-packages", tree), path.join(declarations, "marley-packages", tree), { recursive: true, filter: (file) => fs.statSync(file).isDirectory() || file.endsWith(".d.ts") });
const typeAliases = {
  "@zygstinct/marshal-sdk-port": "marley-packages/marshal-sdk-port/index.js",
  "@zygstinct/marshal-sdk-port/host": "marley-packages/marshal-sdk-port/host.js",
  "@zygstinct/marshal-sdk-port/agent-sdk": "marley-packages/marshal-sdk-port/agent-sdk.js",
  "@zygstinct/marshal-sdk-port/models": "marley-packages/marshal-sdk-port/models.js",
  "@zygstinct/shared": "compat/zygstinct-shared.js",
  "@zygstinct/log": "compat/zygstinct-log.js",
  "@zygstinct/routines-public": "compat/zygstinct-routines-public.js",
  "@zygstinct/brand-brain": "compat/zygstinct-brand-brain.js",
};
const walk = (dir) => fs.readdirSync(dir).flatMap((name) => (fs.statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name)) : [path.join(dir, name)]));
for (const file of walk(declarations).filter((name) => name.endsWith(".d.ts"))) {
  const text = fs.readFileSync(file, "utf8");
  const rewritten = text.replace(/(from\s+|import\()"(@zygstinct\/[^"]+)"/g, (whole, lead, spec) => {
    if (!typeAliases[spec]) return whole;
    let relative = path.relative(path.dirname(file), path.join(declarations, typeAliases[spec]));
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return `${lead}"${relative}"`;
  });
  if (rewritten !== text) fs.writeFileSync(file, rewritten);
}

const version = `${kitPackage.version}-${sha}`;
const manifest = {
  name: kitPackage.name,
  version,
  description: kitPackage.description,
  type: "module",
  main: "./dist/index.js",
  types: "./types/index.d.ts",
  exports: { ".": { types: "./types/index.d.ts", default: "./dist/index.js" }, "./daytona": { types: "./types/daytona.d.ts", default: "./dist/daytona.js" } },
  files: ["dist", "types", "SOURCE.json"],
  peerDependencies: { ...peers, ...daytonaPeers },
  peerDependenciesMeta: Object.fromEntries(Object.keys(daytonaPeers).map((name) => [name, { optional: true }])),
};
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(stage, "SOURCE.json"), `${JSON.stringify({ repository: "marshal-runtime/marshal-sdk", gitSha: sha, marley: { branch: source.branch, commit: source.commit }, built: "node extensions/agent-kit/scripts/pack.mjs" }, null, 2)}\n`);
fs.mkdirSync(out, { recursive: true });
const tarball = execFileSync("npm", ["pack", stage, "--pack-destination", out, "--silent"], { encoding: "utf8" }).trim().split("\n").pop();
process.stdout.write(`${path.join(out, tarball)}\n`);
