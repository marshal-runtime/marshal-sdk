// The kit's bindings as Marshal runtime extension packages, one directory each, ready for a host's RuntimeExtensionManager:
//
//   node extensions/agent-kit/scripts/build-extensions.mjs [--out .extensions]
//
// Each package is runtime-extension.json, package.json and dist/runtime.cjs (commonjs-bundle-v1: one CommonJS bundle that requires only the
// Node builtins the runtime's loader reviews). A bundle that requires anything else fails the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(kit, ".extensions"));
const kitPackage = JSON.parse(fs.readFileSync(path.join(kit, "package.json"), "utf8"));
const version = kitPackage.version;

// The runtime loader's reviewed builtins (agent-runtime-extensions loader.ts DEFAULT_NODE_BUILTIN_MODULES).
const LOADER_BUILTINS = new Set(["buffer", "events", "fs", "http", "https", "node:async_hooks", "node:child_process", "node:crypto", "node:fs/promises", "node:os", "node:path", "node:sqlite", "node:url", "node:util", "os", "path", "stream", "tty", "url", "util", "zlib"]);

const aliases = {
  "@zygstinct/marshal-sdk-port": "src/compat/sdk-port-core.ts",
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
const extensions = [
  {
    name: "slack",
    identity: "@marshal/agent-kit-slack",
    displayName: "Agent kit: Slack channel",
    guidance: {
      purpose: "Sends the agent kit outbox's words to Slack as the bot in the conversation's thread, and reacts to a person's message to say it was taken.",
      when: "A host whose agents talk to people on Slack binds it as one of its channels.",
      recipe: "Host binds @marshal/agent-kit:slack-host {token, pickReaction?}; reads services.getAll(Symbol.for('@marshal/agent-kit:channel')).",
      boundaries: "Text parts only; a voice part is refused. Posts only where the conversation key points.",
    },
  },
  {
    name: "github",
    identity: "@marshal/agent-kit-github",
    displayName: "Agent kit: GitHub channel",
    guidance: {
      purpose: "Sends the agent kit outbox's words to GitHub as comments on the conversation's pull request or issue.",
      when: "A host whose agents answer people on GitHub binds it as one of its channels.",
      recipe: "Host binds @marshal/agent-kit:github-host {comment(repo, number, body)}; reads services.getAll(Symbol.for('@marshal/agent-kit:channel')).",
      boundaries: "Comments only where the conversation key points; the host's App or token stays in its comment call.",
    },
  },
  {
    name: "daytona",
    identity: "@marshal/agent-kit-daytona",
    displayName: "Agent kit: Daytona sandbox",
    guidance: {
      purpose: "Runs agent sessions in a scope's Daytona sandbox: Marley's provider starts it, ssh starts Claude Code there behind the model proxy.",
      when: "A host whose sessions run in Daytona sandboxes binds it as its sandbox.",
      recipe: "Host binds @marshal/agent-kit:daytona-host {provider, ssh, proxy}; reads services.get(Symbol.for('@marshal/agent-kit:sandbox')).",
      boundaries: "The host's credentials stay in its provider, ssh runner and proxy; the extension only routes through them.",
    },
  },
];

fs.rmSync(out, { recursive: true, force: true });
for (const extension of extensions) {
  const dir = path.join(out, extension.name);
  const entrypoint = "dist/runtime.cjs";
  const result = await build({
    entryPoints: [path.join(kit, "src/extensions", `${extension.name}.ts`)],
    outfile: path.join(dir, entrypoint),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    loader: { ".map": "empty" },
    metafile: true,
    logLevel: "warning",
    plugins: [aliasResolver],
    external: [...LOADER_BUILTINS],
    // Marley's files import types with `import { type X }`; under the SDK's verbatimModuleSyntax esbuild would keep each as a side-effect import and
    // bundle the whole module (store.ts brings sqlite). The bundle drops imports used only as types.
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: false } },
  });
  const required = new Set(Object.values(result.metafile.outputs).flatMap((output) => output.imports).filter((entry) => entry.external).map((entry) => entry.path));
  const stray = [...required].filter((name) => !LOADER_BUILTINS.has(name));
  if (stray.length) throw new Error(`${extension.name}: the bundle requires modules the runtime loader does not provide: ${stray.join(", ")}`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: extension.identity, version, private: true, type: "commonjs", main: entrypoint }, null, 2) + "\n");
  const manifest = {
    schemaVersion: 1,
    identity: extension.identity,
    displayName: extension.displayName,
    version,
    entrypoint,
    moduleFormat: "commonjs-bundle-v1",
    agentGuidance: extension.guidance,
  };
  fs.writeFileSync(path.join(dir, "runtime-extension.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bytes = fs.statSync(path.join(dir, entrypoint)).size;
  console.log(`${extension.identity}@${version}: ${path.relative(process.cwd(), dir)} (${Math.round(bytes / 1024)} KB, requires ${[...required].sort().join(" ") || "nothing"})`);
}
