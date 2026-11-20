// Regenerates packages/providers/src/backend/antigravity/bridge-source.ts from bridge.py, so the
// bridge ships inside any bundle of the providers package. `--check` fails when the string in
// bridge-source.ts (however a formatter quoted it) is not bridge.py.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages/providers/src/backend/antigravity",
);
const source = readFileSync(path.join(dir, "bridge.py"), "utf8");
const target = path.join(dir, "bridge-source.ts");
const DECLARATION = "export const ANTIGRAVITY_BRIDGE_SOURCE =";

if (process.argv.includes("--check")) {
  let embedded;
  try {
    const text = readFileSync(target, "utf8");
    const literal = text
      .slice(text.indexOf(DECLARATION) + DECLARATION.length)
      .trim()
      .replace(/;$/, "");
    embedded = vm.runInNewContext(`(${literal})`);
  } catch {
    embedded = undefined;
  }
  if (embedded !== source) {
    console.error("bridge-source.ts is stale: run node scripts/antigravity-bridge-source.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(
    target,
    "// Generated from bridge.py by scripts/antigravity-bridge-source.mjs. Edit bridge.py, then rerun it.\n" +
      `${DECLARATION} ${JSON.stringify(source)};\n`,
  );
}
