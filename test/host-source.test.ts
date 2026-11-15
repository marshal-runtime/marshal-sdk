// packages/host/src is the desktop's runtime host, byte for byte (scripts/vendor-desktop-host.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "vendor-desktop-host.mjs");
const desktop = process.env.MARSHAL_DESKTOP_DIR ?? path.join(repoRoot, "..", "marshal");

test("host source: packages/host/src matches SOURCE.json", () => {
  const source = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "host", "SOURCE.json"), "utf8"));
  const hash = execFileSync(process.execPath, [script, "hash"], { encoding: "utf8" }).trim();
  assert.equal(hash, source.sha256);
});

test("host source: the desktop checkout runs the same host", { skip: !fs.existsSync(path.join(desktop, "electron", "marshal-runtime")) }, () => {
  execFileSync(process.execPath, [script, "check", desktop], { encoding: "utf8" });
});
