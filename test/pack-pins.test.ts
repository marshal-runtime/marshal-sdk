import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkAgainstDesktop, checkSdkPins, readDesktopPins } from "../src/pack-pins.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** An SDK root vendoring one pack, and a desktop pinning packs from `desktopArchives` (archive name to bytes). */
function fixture(desktopArchives: Record<string, string>, desktopPins: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-packs-"));
  const sdk = path.join(root, "sdk");
  const desktop = path.join(root, "desktop");
  const archive = "marshal-runtime-0.1.0-marshal-host-88.tgz";
  fs.mkdirSync(path.join(sdk, "vendor", "packs"), { recursive: true });
  fs.writeFileSync(path.join(sdk, "vendor", "packs", archive), "runtime-88");
  fs.writeFileSync(
    path.join(sdk, "vendor", "packs", "SOURCE.json"),
    JSON.stringify({ archives: [{ name: "@marshal/runtime", archive, sha256: sha("runtime-88") }] }),
  );
  const spec = `file:vendor/packs/${archive}`;
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ dependencies: { "@marshal/runtime": spec }, pnpm: { overrides: { "@marshal/runtime": spec } } }));
  fs.mkdirSync(path.join(desktop, ".marshal-runtime-packs", "archives"), { recursive: true });
  for (const [name, bytes] of Object.entries(desktopArchives)) fs.writeFileSync(path.join(desktop, ".marshal-runtime-packs", "archives", name), bytes);
  fs.writeFileSync(
    path.join(desktop, "package.json"),
    JSON.stringify({
      pnpm: { overrides: Object.fromEntries(Object.entries(desktopPins).map(([name, file]) => [name, `file:.marshal-runtime-packs/archives/${file}`])) },
    }),
  );
  return { sdk, desktop, archive };
}

test("pack pins: this SDK's package.json, vendor/packs and SOURCE.json agree", () => {
  assert.deepEqual(checkSdkPins(repoRoot), []);
});

test("pack pins: same archive and bytes pass; a newer desktop build, other bytes or a dropped pin fail", () => {
  const same = fixture({ "marshal-runtime-0.1.0-marshal-host-88.tgz": "runtime-88" }, { "@marshal/runtime": "marshal-runtime-0.1.0-marshal-host-88.tgz" });
  assert.deepEqual(checkSdkPins(same.sdk), []);
  assert.deepEqual(checkAgainstDesktop(same.sdk, readDesktopPins(same.desktop)), []);

  const newer = fixture({ "marshal-runtime-0.1.0-marshal-host-89.tgz": "runtime-89" }, { "@marshal/runtime": "marshal-runtime-0.1.0-marshal-host-89.tgz" });
  const [moved] = checkAgainstDesktop(newer.sdk, readDesktopPins(newer.desktop));
  assert.match(moved!.problem, /SDK marshal-runtime-0\.1\.0-marshal-host-88\.tgz, desktop .* marshal-runtime-0\.1\.0-marshal-host-89\.tgz/);

  const rebuilt = fixture({ "marshal-runtime-0.1.0-marshal-host-88.tgz": "rebuilt" }, { "@marshal/runtime": "marshal-runtime-0.1.0-marshal-host-88.tgz" });
  assert.match(checkAgainstDesktop(rebuilt.sdk, readDesktopPins(rebuilt.desktop))[0]!.problem, /differs from the desktop/);

  const dropped = fixture({}, {});
  assert.match(checkAgainstDesktop(dropped.sdk, readDesktopPins(dropped.desktop))[0]!.problem, /pins no @marshal\/runtime/);
});

test("pack pins: a tampered vendored tarball or an override to another file fails the SDK's own check", () => {
  const { sdk, archive } = fixture({}, {});
  fs.writeFileSync(path.join(sdk, "vendor", "packs", archive), "tampered");
  assert.match(checkSdkPins(sdk)[0]!.problem, /does not match its SOURCE\.json hash/);
  fs.writeFileSync(path.join(sdk, "vendor", "packs", archive), "runtime-88");
  const pkg = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8"));
  pkg.pnpm.overrides["@marshal/runtime"] = "file:vendor/packs/marshal-runtime-0.1.0-marshal-host-72.tgz";
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify(pkg));
  assert.match(checkSdkPins(sdk)[0]!.problem, /pnpm\.overrides pins .*host-72\.tgz, SOURCE\.json has .*host-88\.tgz/);
});

// The real desktop, when one is checked out: MARSHAL_DESKTOP_DIR, or the sibling `marshal` folder of this repo.
// MARSHAL_DESKTOP_REF picks the desktop ref read (default origin/main), without touching that checkout.
const desktopRoot = process.env.MARSHAL_DESKTOP_DIR ?? path.resolve(repoRoot, "..", "marshal");
const hasDesktop = fs.existsSync(path.join(desktopRoot, ".marshal-runtime-packs"));
test(
  "pack pins: the SDK vendors exactly the desktop's builds",
  { skip: hasDesktop ? false : `no desktop checkout at ${desktopRoot} (set MARSHAL_DESKTOP_DIR)` },
  () => {
    const desktop = readDesktopPins(desktopRoot, process.env.MARSHAL_DESKTOP_REF ?? "origin/main");
    const drift = checkAgainstDesktop(repoRoot, desktop);
    assert.deepEqual(drift, [], `re-vendor: node scripts/vendor-packs.mjs --from ${desktopRoot}`);
  },
);
