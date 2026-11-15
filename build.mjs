import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
// The provider layer (packages/providers, the same source the Marshal desktop vendors) uses extensionless
// imports, so it is bundled into dist/src/providers.js with its npm dependencies left external.
const providersEntry = path.join(root, "src", "providers.ts");
// The permission engine (packages/permissions, also vendored by the desktop) is bundled the same way into
// dist/src/permissions.js. Its logger is the one in providers.js, so log sinks a host adds see its lines too.
const permissionsEntry = path.join(root, "src", "permissions.ts");
const sharedLogger = {
  name: "shared-logger",
  setup(context) {
    context.onResolve({ filter: /providers\/src\/common\/marshal-logger$/ }, () => ({ path: "./providers.js", external: true }));
  },
};
// The organization layer (packages/org, the same source the desktop vendors as packages/marshal-org): bundled the
// same way into dist/src/org-package.js, with narrow bundles of its rooms client (org-rooms.js) and sanitizer
// (org-scrub.js) for code that should not load the whole layer. They share providers.js's logger too.
const orgEntry = path.join(root, "src", "org-package.ts");
const orgRoomsEntry = path.join(root, "src", "org-rooms.ts");
const orgScrubEntry = path.join(root, "src", "org-scrub.ts");
// SessionManager (packages/providers/src/engine) is bundled into dist/src/session-engine.js. The engine's ports
// module is bundled alone into dist/src/engine-host.js and both providers.js and session-engine.js import it, so a
// host configures both with one configureEngineHost call.
const sessionEngineEntry = path.join(root, "src", "session-engine.ts");
const engineHostEntry = path.join(root, "src", "engine-host.ts");
const sharedEngineHost = {
  name: "shared-engine-host",
  setup(context) {
    const portsModule = path.join(root, "packages", "providers", "src", "backend", "engine-host");
    context.onResolve({ filter: /engine-host$/ }, (args) =>
      args.importer === engineHostEntry || path.resolve(args.resolveDir, args.path) !== portsModule
        ? undefined
        : { path: "./engine-host.js", external: true },
    );
  },
};
const sources = ["src", "test", "packages/prompt/src"]
  .flatMap((directory) =>
    readdirSync(path.join(root, directory), { recursive: true })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => path.join(root, directory, name)),
  )
  .filter((source) => ![providersEntry, permissionsEntry, orgEntry, orgRoomsEntry, orgScrubEntry, sessionEngineEntry, engineHostEntry].includes(source));

const common = { outbase: root, format: "esm", platform: "node", target: "node22", sourcemap: true, logLevel: "warning" };
rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({ ...common, entryPoints: sources, outdir: path.join(root, "dist") });
await build({
  ...common,
  entryPoints: [providersEntry, engineHostEntry],
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
  plugins: [sharedEngineHost],
});
await build({
  ...common,
  entryPoints: [sessionEngineEntry],
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
  plugins: [sharedLogger, sharedEngineHost],
});
await build({
  ...common,
  entryPoints: [permissionsEntry, orgEntry, orgRoomsEntry, orgScrubEntry],
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
  plugins: [sharedLogger],
});
// The runtime host shared with the desktop (packages/host): bundled into dist/host-runtime.js. `electron` resolves to
// the host platform shim, `@common/*` to the shared common folder, and `?raw` imports load as text, as in the desktop's
// Vite build.
const hostRoot = path.join(root, "packages", "host");
await build({
  ...common,
  entryPoints: { "host-runtime": path.join(hostRoot, "index.ts") },
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
  alias: { electron: path.join(hostRoot, "platform", "electron.ts") },
  plugins: [
    {
      name: "host-source",
      setup(context) {
        context.onResolve({ filter: /^@common\// }, (args) => ({
          path: path.join(hostRoot, "src", "common", `${args.path.slice("@common/".length)}.ts`),
        }));
        context.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.join(args.resolveDir, args.path.slice(0, -"?raw".length)),
          namespace: "raw-text",
        }));
        context.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({
          contents: (await import("node:fs")).readFileSync(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
