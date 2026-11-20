// Regenerates packages/providers/src/backend/antigravity/bridge-source.ts from bridge.py, so the
// bridge ships inside any bundle of the providers package. `--check` fails when they differ.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages/providers/src/backend/antigravity");
const source = readFileSync(path.join(dir, "bridge.py"), "utf8");
const generated =
  "// Generated from bridge.py by scripts/antigravity-bridge-source.mjs. Edit bridge.py, then rerun it.\n" +
  `export const ANTIGRAVITY_BRIDGE_SOURCE = ${JSON.stringify(source)};\n`;
const target = path.join(dir, "bridge-source.ts");
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(target, "utf8"); } catch {}
  if (current !== generated) {
    console.error("bridge-source.ts is stale: run node scripts/antigravity-bridge-source.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
