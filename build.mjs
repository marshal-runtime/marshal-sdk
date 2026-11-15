import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const sources = ["src", "test"].flatMap((directory) =>
  readdirSync(path.join(root, directory), { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(root, directory, name)),
);

rmSync(path.join(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: sources,
  outdir: path.join(root, "dist"),
  outbase: root,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  logLevel: "warning",
});
