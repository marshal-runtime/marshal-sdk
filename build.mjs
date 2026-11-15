import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
// The provider layer (packages/providers, the same source the Marshal desktop vendors) uses extensionless
// imports, so it is bundled into dist/src/providers.js with its npm dependencies left external.
const providersEntry = path.join(root, "src", "providers.ts");
const sources = ["src", "test"]
  .flatMap((directory) =>
    readdirSync(path.join(root, directory), { recursive: true })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => path.join(root, directory, name)),
  )
  .filter((source) => source !== providersEntry);

const common = { outbase: root, format: "esm", platform: "node", target: "node22", sourcemap: true, logLevel: "warning" };
rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({ ...common, entryPoints: sources, outdir: path.join(root, "dist") });
await build({
  ...common,
  entryPoints: [providersEntry],
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
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
