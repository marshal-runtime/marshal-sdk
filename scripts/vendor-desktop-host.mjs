// packages/host/src is the Marshal runtime host both shells run: the desktop's electron/marshal-runtime and the
// files it loads at run time, kept at their desktop paths so the code is byte-identical in both repositories.
//
//   node scripts/vendor-desktop-host.mjs sync <desktop checkout>   copy the set in, write FILES.json + SOURCE.json
//   node scripts/vendor-desktop-host.mjs check <desktop checkout>  fail when the desktop's copy differs
//   node scripts/vendor-desktop-host.mjs hash                      print the content hash of packages/host/src
//
// Modules the host only names in types (desktop sessions, IPC, relay...) are not part of the set; sync writes a
// generated declaration stub for each (`*.d.ts` with a `// generated-stub` first line) so the package typechecks
// here. Stubs are not hashed and never copied back.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_ROOT = path.join(repoRoot, "packages", "host");
export const HOST_SOURCE = path.join(HOST_ROOT, "src");
const FILES_RECORD = path.join(HOST_ROOT, "FILES.json");
const SOURCE_RECORD = path.join(HOST_ROOT, "SOURCE.json");
const STUB_MARK = "// generated-stub";
const ENTRY_DIR = "electron/marshal-runtime";
// Contract files the host types against, shared whole rather than stubbed.
const ENTRY_EXTRA = ["electron/backend/ports.ts", "electron/backend/runtime-contract.ts"];

const IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?\sfrom\s+)?["']([^"']+)["']/g;

/** Relative specifier for a local import (the desktop's `@common/*` alias included), else null. */
function toRelative(fromRel, spec) {
  if (spec.startsWith(".")) return spec;
  if (spec.startsWith("@common/")) {
    const rel = path.posix.relative(path.posix.dirname(fromRel), `common/${spec.slice("@common/".length)}`);
    return rel.startsWith(".") ? rel : `./${rel}`;
  }
  return null;
}

function resolveRelative(root, fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base.replace(/\.js$/, ".ts"), base]) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate;
  }
  return null;
}

function listEntry(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(child);
    }
  };
  walk(ENTRY_DIR);
  return out;
}

/** The value-import closure of electron/marshal-runtime, plus every type-only import that leaves it. */
export function computeSet(desktop) {
  const files = new Set();
  const typeOnly = new Map(); // rel -> Set of names (or "*")
  const stack = [...listEntry(desktop), ...ENTRY_EXTRA];
  while (stack.length) {
    const rel = stack.pop();
    if (files.has(rel)) continue;
    files.add(rel);
    const src = fs.readFileSync(path.join(desktop, rel), "utf8");
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = toRelative(rel, match[4]);
      if (!spec) continue;
      if (spec.endsWith("?raw")) {
        const raw = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.slice(0, -4)));
        if (fs.existsSync(path.join(desktop, raw))) files.add(raw);
        continue;
      }
      const target = resolveRelative(desktop, rel, spec);
      if (!target) continue;
      if (match[2]) {
        const names = typeOnly.get(target) ?? new Set();
        const clause = match[3] ?? "";
        const braces = clause.match(/\{([^}]*)\}/);
        if (braces) {
          for (const part of braces[1].split(",")) {
            const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
            if (name) names.add(name);
          }
        } else names.add("*");
        typeOnly.set(target, names);
      } else stack.push(target);
    }
    for (const match of src.matchAll(/(?<![.\w])import\(\s*["']([^"']+)["']\s*\)(?!\.\w)/g)) {
      const spec = toRelative(rel, match[1]);
      const target = spec && resolveRelative(desktop, rel, spec);
      if (target) stack.push(target);
    }
  }
  // Inline `import("…").Name` type references.
  for (const rel of files) {
    const src = fs.readFileSync(path.join(desktop, rel), "utf8");
    for (const match of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)\.(\w+)/g)) {
      const spec = toRelative(rel, match[1]);
      const target = spec && resolveRelative(desktop, rel, spec);
      if (!target) continue;
      const names = typeOnly.get(target) ?? new Set();
      names.add(match[2]);
      typeOnly.set(target, names);
    }
  }
  for (const rel of files) typeOnly.delete(rel);
  return { files: [...files].sort(), typeOnly };
}

function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const rel of [...files].sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readRecord() {
  return {
    files: JSON.parse(fs.readFileSync(FILES_RECORD, "utf8")),
    source: JSON.parse(fs.readFileSync(SOURCE_RECORD, "utf8")),
  };
}

export function hashHost() {
  return hashFiles(HOST_SOURCE, readRecord().files);
}

function writeStub(rel, names) {
  const declRel = rel.replace(/\.tsx?$/, ".d.ts");
  const abs = path.join(HOST_SOURCE, declRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = [STUB_MARK, "// Desktop-only module the host names in types; not part of the shared host source."];
  const generic = "<T0 = any, T1 = any, T2 = any, T3 = any>";
  for (const name of [...names].sort()) {
    if (name === "*") continue;
    lines.push(`export type ${name}${generic} = any;`);
  }
  if (names.has("*")) lines.push("declare const stub: any;", "export = stub;");
  fs.writeFileSync(abs, `${lines.join("\n")}\n`);
}

function sync(desktop) {
  const commit = execFileSync("git", ["-C", desktop, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const { files, typeOnly } = computeSet(desktop);
  fs.rmSync(HOST_SOURCE, { recursive: true, force: true });
  for (const rel of files) {
    const abs = path.join(HOST_SOURCE, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(desktop, rel), abs);
  }
  for (const [rel, names] of typeOnly) writeStub(rel, names);
  fs.writeFileSync(FILES_RECORD, `${JSON.stringify(files, null, 2)}\n`);
  const sha256 = hashFiles(HOST_SOURCE, files);
  fs.writeFileSync(
    SOURCE_RECORD,
    `${JSON.stringify({ repository: "OmerMachluf/marshal", entry: ENTRY_DIR, commit, files: files.length, sha256 }, null, 2)}\n`,
  );
  process.stdout.write(`synced ${files.length} files (${typeOnly.size} stubs) from ${commit}\nsha256 ${sha256}\n`);
}

function check(desktop) {
  const { files, source } = readRecord();
  const missing = files.filter((rel) => !fs.existsSync(path.join(desktop, rel)));
  if (missing.length) throw new Error(`desktop is missing ${missing.length} host files, e.g. ${missing[0]}`);
  const desktopHash = hashFiles(desktop, files);
  const ours = hashFiles(HOST_SOURCE, files);
  if (ours !== source.sha256) throw new Error(`packages/host/src does not match SOURCE.json (${ours})`);
  if (desktopHash !== ours) {
    const differ = files.filter(
      (rel) => !fs.readFileSync(path.join(desktop, rel)).equals(fs.readFileSync(path.join(HOST_SOURCE, rel))),
    );
    throw new Error(`desktop host differs in ${differ.length} files: ${differ.slice(0, 5).join(", ")}`);
  }
  const { files: now } = computeSet(desktop);
  const added = now.filter((rel) => !files.includes(rel));
  if (added.length) throw new Error(`desktop host now loads ${added.length} files not in the set: ${added.slice(0, 5).join(", ")}`);
  process.stdout.write(`desktop host matches (${files.length} files)\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [command, desktop] = process.argv.slice(2);
  if (command === "sync" && desktop) sync(path.resolve(desktop));
  else if (command === "check" && desktop) check(path.resolve(desktop));
  else if (command === "hash") process.stdout.write(`${hashHost()}\n`);
  else {
    process.stderr.write("usage: node scripts/vendor-desktop-host.mjs sync|check <desktop checkout> | hash\n");
    process.exit(2);
  }
}
