// Builds @marshal/org into out/package (manifest, dist/runtime.cjs, README, package.json), the package the SDK loads
// by default when its manifest names an org (src/onboarding.ts, MARSHAL_SDK_ORG_PACKAGE overrides).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));

// The host loader provides a fixed list of built-ins, some only bare (fs, path, os, zlib, http, https, stream, url,
// util, events, buffer) and some only under node: (crypto, fs/promises, child_process, async_hooks).
const BARE = new Set(["fs", "path", "os", "zlib", "http", "https", "stream", "url", "util", "events", "buffer", "tty"]);
const PREFIXED = new Set(["crypto", "fs/promises", "child_process", "async_hooks", "sqlite"]);
const loaderBuiltins = {
  name: "loader-builtins",
  setup(context) {
    context.onResolve({ filter: /^(node:)?stream\/promises$/ }, () => ({ path: "stream-promises", namespace: "loader-shim" }));
    context.onLoad({ filter: /.*/, namespace: "loader-shim" }, () => ({ contents: 'module.exports = require("stream").promises;', loader: "js" }));
    context.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, "");
      if (BARE.has(name)) return { path: name, external: true };
      if (PREFIXED.has(name)) return { path: `node:${name}`, external: true };
      return undefined;
    });
  },
};

// src/onboarding.ts reaches the provider layer; the org modules need only its error class.
const onboardingShim = {
  name: "onboarding-shim",
  setup(context) {
    context.onResolve({ filter: /\/onboarding\.js$/ }, (args) =>
      path.resolve(args.resolveDir, args.path) === path.resolve(root, "..", "..", "src", "onboarding.js") ? { path: path.join(root, "src", "onboarding-shim.ts") } : undefined,
    );
  },
};

const out = path.join(root, "out", "package");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile: path.join(out, "dist", "runtime.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  plugins: [onboardingShim, loaderBuiltins],
  // Modules the bundle shares with the SDK read import.meta.url (the SDK's own folder); in a bundle that is this file.
  define: { "import.meta.url": "__marshalOrgModuleUrl" },
  banner: { js: 'const __marshalOrgModuleUrl = require("url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});
const bundle = createRequire(import.meta.url)(path.join(out, "dist", "runtime.cjs"));
const manifest = JSON.parse(readFileSync(path.join(root, "runtime-extension.json"), "utf8"));
manifest.contributes.capabilities = bundle.CAPABILITY_NAMES;
manifest.contributes.rooms = bundle.ROOM_KINDS;
writeFileSync(path.join(out, "runtime-extension.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(path.join(root, "README.md"), path.join(out, "README.md"));
writeFileSync(path.join(out, "package.json"), `${JSON.stringify({ name: manifest.identity, version: manifest.version, private: true, type: "commonjs", main: manifest.entrypoint }, null, 2)}\n`);
