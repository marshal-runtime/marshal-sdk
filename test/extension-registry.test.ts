import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ExtensionRegistry,
  FileExtensionRegistryStore,
  hashExtensionFiles,
  RegistryConflict,
  RegistryRefusal,
  RELEASE_TENANT,
  type ExtensionFiles,
} from "../src/extension-registry.js";

const BRAND = "b1111111-1111-4111-8111-111111111111";
const OTHER = "b2222222-2222-4222-8222-222222222222";
const EXT = "@marley/meta-analysis";

function pkg(prompt: string): ExtensionFiles {
  return {
    "runtime-extension.json": JSON.stringify({ identity: EXT, contributes: { agents: [{ id: "meta-analysis" }] } }),
    "profiles/meta-analysis.prompt.md": prompt,
    "skills/meta-analysis/SKILL.md": "# skill",
  };
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-registry-"));
  let clock = Date.parse("2026-11-16T10:00:00Z");
  const reg = new ExtensionRegistry({ store: new FileExtensionRegistryStore(root), now: () => new Date((clock += 1000)) });
  return { root, reg };
}

test("hash is stable across key order and changes with content", () => {
  const a = hashExtensionFiles({ "b.md": "x", "runtime-extension.json": "{}" });
  const b = hashExtensionFiles({ "runtime-extension.json": "{}", "b.md": "x" });
  assert.equal(a, b);
  assert.notEqual(a, hashExtensionFiles({ "runtime-extension.json": "{}", "b.md": "y" }));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test("a brand runs the release until its own fork is activated; resolve and run pins name the copy", async () => {
  const { reg } = registry();
  const release = await reg.publishRelease(EXT, pkg("release v1"), { authorRef: "release-20261116" });
  assert.deepEqual([release.tenant, release.version, release.status, release.author], [RELEASE_TENANT, 1, "active", "release"]);
  await reg.bind({ tenant: BRAND, routineId: "meta-analysis", extensionId: EXT, agentId: "meta-analysis", enabled: true });

  let resolved = await reg.resolve(BRAND, "meta-analysis");
  assert.equal(resolved.version.tenant, RELEASE_TENANT);

  const draft = await reg.draft(BRAND, EXT, pkg("brand edit"), { author: "marley", authorRef: "session-1" });
  assert.deepEqual(draft.forkOf, { tenant: RELEASE_TENANT, extensionId: EXT, version: 1 });
  assert.equal(draft.status, "draft");
  // A draft never runs.
  assert.equal((await reg.resolve(BRAND, "meta-analysis")).version.tenant, RELEASE_TENANT);

  await reg.propose(draft);
  assert.equal((await reg.resolve(BRAND, "meta-analysis")).version.tenant, RELEASE_TENANT, "a proposal never runs either");
  await reg.activate(draft, "member:owner-1");
  resolved = await reg.resolve(BRAND, "meta-analysis");
  assert.deepEqual([resolved.version.tenant, resolved.version.version, resolved.version.approvedBy], [BRAND, 1, "member:owner-1"]);

  // Another brand is unaffected.
  await reg.bind({ tenant: OTHER, routineId: "meta-analysis", extensionId: EXT, agentId: "meta-analysis", enabled: true });
  assert.equal((await reg.resolve(OTHER, "meta-analysis")).version.tenant, RELEASE_TENANT);

  const pin = await reg.pinRun({ runId: "run-1", tenant: BRAND, routineId: "meta-analysis", resolved });
  assert.equal(pin.copyTenant, BRAND);
  assert.equal(pin.contentHash, hashExtensionFiles(pkg("brand edit")));
  assert.deepEqual((await reg.runPins(BRAND)).map((p) => p.runId), ["run-1"]);
  assert.deepEqual(await reg.runPins(OTHER), []);
});

test("activating a second version retires the first; a pin holds an exact version", async () => {
  const { reg } = registry();
  await reg.publishRelease(EXT, pkg("r1"));
  const v1 = await reg.draft(BRAND, EXT, pkg("one"), { author: "owner" });
  await reg.propose(v1);
  await reg.activate(v1, "member:o");
  const v2 = await reg.draft(BRAND, EXT, pkg("two"), { author: "marley" });
  assert.deepEqual(v2.forkOf, { tenant: BRAND, extensionId: EXT, version: 1 }, "a second edit forks the brand's running copy");
  await reg.propose(v2);
  await reg.activate(v2, "member:o");
  const versions = await reg.versions(BRAND, EXT);
  assert.deepEqual(versions.map((v) => `${v.version}:${v.status}`), ["1:retired", "2:active"]);

  await reg.bind({ tenant: BRAND, routineId: "meta-analysis", extensionId: EXT, agentId: "meta-analysis", enabled: true, pin: { tenant: RELEASE_TENANT, version: 1 } });
  assert.equal((await reg.resolve(BRAND, "meta-analysis")).version.tenant, RELEASE_TENANT);
  // The other brand has a real, active version 1, so only the tenant check can refuse this pin.
  const foreign = await reg.draft(OTHER, EXT, pkg("other brand"), { author: "owner" });
  await reg.propose(foreign);
  await reg.activate(foreign, "member:other");
  await assert.rejects(
    reg.bind({ tenant: BRAND, routineId: "meta-analysis", extensionId: EXT, agentId: "meta-analysis", enabled: true, pin: { tenant: OTHER, version: 1 } }),
    RegistryRefusal,
    "a pin cannot name another brand's copy",
  );
});

test("status changes are compare-and-set; activation needs an approver", async () => {
  const { reg } = registry();
  await reg.publishRelease(EXT, pkg("r1"));
  const draft = await reg.draft(BRAND, EXT, pkg("x"), { author: "marley" });
  await assert.rejects(reg.activate(draft, "member:o"), RegistryConflict, "a draft cannot be activated without a proposal");
  await reg.propose(draft);
  await assert.rejects(reg.propose(draft), RegistryConflict);
  await assert.rejects(reg.activate(draft, ""), RegistryRefusal);
});

test("refusals: bad paths, missing manifest, release drafts, unknown or off routines", async () => {
  const { reg } = registry();
  for (const bad of ["../x", "/etc/passwd", "a/../b", "a\\b", "a//b", "./a"]) {
    await assert.rejects(reg.publishRelease(EXT, { "runtime-extension.json": "{}", [bad]: "x" }), RegistryRefusal, bad);
  }
  await assert.rejects(reg.publishRelease(EXT, { "a.md": "x" }), RegistryRefusal);
  await assert.rejects(reg.draft(RELEASE_TENANT, EXT, pkg("x"), { author: "marley" }), RegistryRefusal);
  await assert.rejects(reg.draft("../evil", EXT, pkg("x"), { author: "marley" }), RegistryRefusal);
  await assert.rejects(reg.resolve(BRAND, "nothing"), RegistryRefusal);
  await reg.publishRelease(EXT, pkg("r"));
  await reg.bind({ tenant: BRAND, routineId: "meta-analysis", extensionId: EXT, agentId: "meta-analysis", enabled: false });
  await assert.rejects(reg.resolve(BRAND, "meta-analysis"), /off/);
});

test("concurrent drafts get distinct version numbers", async () => {
  const { reg } = registry();
  await reg.publishRelease(EXT, pkg("r"));
  const drafts = await Promise.all([1, 2, 3, 4].map((n) => reg.draft(BRAND, EXT, pkg(`d${n}`), { author: "marley" })));
  assert.deepEqual(drafts.map((d) => d.version).sort(), [1, 2, 3, 4]);
});

test("files are checked against the hash; materialize writes a read-only copy", async () => {
  const { root, reg } = registry();
  const release = await reg.publishRelease(EXT, pkg("r"));
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ext-copy-")), "copy");
  const hash = await reg.materialize(release, target);
  assert.equal(hash, release.contentHash);
  assert.equal(fs.readFileSync(path.join(target, "profiles", "meta-analysis.prompt.md"), "utf8"), "r");
  assert.equal(fs.statSync(path.join(target, "profiles", "meta-analysis.prompt.md")).mode & 0o777, 0o444);
  assert.equal(fs.statSync(path.join(target, "profiles")).mode & 0o777, 0o555);
  assert.equal(fs.statSync(target).mode & 0o777, 0o555);
  await assert.rejects(reg.materialize(release, target), /EEXIST/);

  // Tampering with stored content is refused on read.
  const stored = fs.readdirSync(path.join(root, RELEASE_TENANT)).find((name) => name.startsWith("x_"))!;
  fs.writeFileSync(path.join(root, RELEASE_TENANT, stored, "1", "files", "profiles", "meta-analysis.prompt.md"), "tampered");
  await assert.rejects(reg.files(release), /does not match its hash/);
});
