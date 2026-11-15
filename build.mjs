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
