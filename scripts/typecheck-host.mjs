// Typechecks packages/host. Desktop-only modules the host names in types are generated `any` stubs there, so the
// package checks with noImplicitAny off; the desktop typechecks the same files strictly against the real types.
// Turning noImplicitAny off changes how TypeScript types one empty array literal in session-import/importer.ts
// (never[] instead of an evolving array); those diagnostics are allowed here by file and code, nothing else is.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = [{ file: "packages/host/src/electron/session-import/importer.ts", codes: ["TS2345", "TS2322"] }];

let output = "";
try {
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "packages/host/tsconfig.json"], {
    cwd: root,
    encoding: "utf8",
  });
} catch (error) {
  output = String(error.stdout ?? "") + String(error.stderr ?? "");
}
const errors = output
  .split("\n")
  .filter((line) => /error TS\d+/.test(line))
  .filter((line) => !ALLOWED.some((entry) => line.startsWith(`${entry.file}(`) && entry.codes.some((code) => line.includes(`error ${code}`))));
if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("packages/host typechecks\n");
