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
const sources = ["src", "test"]
  .flatMap((directory) =>
    readdirSync(path.join(root, directory), { recursive: true })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => path.join(root, directory, name)),
  )
  .filter((source) => source !== providersEntry && source !== permissionsEntry);

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
await build({
  ...common,
  entryPoints: [permissionsEntry],
  outdir: path.join(root, "dist"),
  bundle: true,
  packages: "external",
  plugins: [sharedLogger],
});
