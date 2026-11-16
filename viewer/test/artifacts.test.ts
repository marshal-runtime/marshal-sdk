import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { artifactDir, commitPageVersion, extendRunJson, legacyPage, manifestProblems, parseArtifactManifest, picturesOfPage, readArtifactManifest, readVersion } from "../src/artifacts";
import { gcsRead, gcsWrite, PreconditionFailed } from "../src/gcs";
import { fakeBucket } from "./fake-gcs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ROOT = "gs://dev-bucket/runs/run-1";
const STATE = `${ROOT}/agent/marshal-state`;

const doc = (version: number, hero = "Hello") => ({
  id: "brand--page", title: "Brand page", brand: { id: "brand", name: "Brand" }, version, notes: [],
  sections: [{ key: "hero", kind: "html", src: `<section><h1>${hero}</h1><img src="https://pagestudio.library/brand/A01-jar.png"></section>` }],
});

function legacyRun(gcs: string) {
  const root = path.join(gcs, "dev-bucket", "runs", "run-1");
  const studio = path.join(root, "agent", "marshal-state", "page-studio");
  fs.mkdirSync(path.join(studio, "pages"), { recursive: true });
  fs.writeFileSync(path.join(studio, "pages", "brand--page.json"), JSON.stringify(doc(5)));
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "images", "A01-jar.png"), PNG);
  fs.mkdirSync(path.join(root, "preview"), { recursive: true });
  fs.writeFileSync(path.join(root, "preview", "index.html"), '<html><img src="../images/A01-jar.png"></html>');
  return root;
}

const input = (dir: string, baseVersion: number, heading: string, extra: Record<string, unknown> = {}) => {
  const lib = path.join(dir, "studio", "brand", "pictures");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "A01-jar.png"), PNG);
  return { root: ROOT, state: STATE, app: "page", kind: "landing-page", id: "brand--page", title: "Brand page", baseVersion, doc: doc(6, heading), previewHtml: `<html>${heading}</html>`, pictures: [{ brand: "brand", name: "A01-jar.png", file: path.join(lib, "A01-jar.png") }], by: { name: "Omer" }, ...extra };
};

test("run manifest v1: a valid manifest has no problems, each wrong field is named, and extending run.json keeps what the platform wrote", () => {
  const manifest = extendRunJson({ schemaVersion: 1, runId: "900014", title: "Aura", brand: "Hey Mila", startedBy: "omer@zyg.com", status: "done", costUsd: 20.6, models: { model: "opus" } }, { runId: "900014", labels: { brand: "Hey Mila" }, artifacts: [{ app: "page", kind: "landing-page", id: "hey-mila--aura", title: "Aura", current: 1 }], sessions: [{ id: "s1", role: "builder", bytes: 10, hasEnvelope: false }] });
  assert.deepEqual(manifestProblems(manifest), []);
  assert.equal(manifest.costUsd, 20.6);
  assert.equal((manifest as any).models.model, "opus");
  assert.equal(manifest.workspace, "pages");
  assert.equal(manifest.workflow, "page-generation");
  assert.equal(manifest.visibility, "team");
  assert.equal(manifest.requester, "omer@zyg.com");
  // Their values win over ours: a run that already says restricted stays restricted.
  assert.equal(extendRunJson({ runId: "r", visibility: "restricted", workspace: "marley" }, { runId: "r", workspace: "pages", visibility: "public" }).visibility, "restricted");
  assert.equal(extendRunJson({ runId: "r", workspace: "marley" }, { runId: "r", workspace: "pages" }).workspace, "marley");

  const broken = { ...manifest, visibility: "everyone", workspace: "", artifacts: [{ app: "page", id: "../x", kind: "k", title: "t", current: 1 }], sessions: [{ id: "s", role: "r", bytes: "10", hasEnvelope: false }], labels: { a: 1 } };
  const problems = manifestProblems(broken).join("|");
  for (const word of ["visibility", "workspace", "artifacts", "sessions", "labels"]) assert.match(problems, new RegExp(word));
  assert.deepEqual(manifestProblems("nope"), ["not an object"]);
  assert.match(manifestProblems({ ...manifest, schemaVersion: 2 }).join(), /schemaVersion/);
});

test("artifact manifest: needs a listed current version and a safe folder name", () => {
  const ok = { schemaVersion: 1, app: "page", kind: "landing-page", id: "p", title: "P", versions: [{ v: 1, dir: "versions/1", at: "t", by: {}, summary: "", pictures: 0 }], current: 1 };
  assert.equal(parseArtifactManifest(ok).current, 1);
  assert.throws(() => parseArtifactManifest({ ...ok, current: 2 }), /not a listed version/);
  assert.throws(() => parseArtifactManifest({ ...ok, versions: [{ ...ok.versions[0], dir: "../../etc" }] }), /needs v and dir/);
  assert.throws(() => parseArtifactManifest({ ...ok, id: "a/b" }), /required/);
  assert.throws(() => parseArtifactManifest({ ...ok, schemaVersion: 9 }), /schemaVersion/);
});

test("the pictures a page record shows are found by Page Studio's library URLs", () => {
  assert.deepEqual(picturesOfPage(doc(1)), [{ brand: "brand", name: "A01-jar.png" }]);
  assert.deepEqual(picturesOfPage({ sections: [{ src: '<img src="/library/b/pictures/x%20y.jpg"><img src="https://x.test/other.png">' }] }), [{ brand: "b", name: "x y.jpg" }]);
});

test("a run's page without versions is read from its own folders, pictures from images/", async () => {
  const { gcs, dir } = fakeBucket();
  legacyRun(gcs);
  const page = await legacyPage(ROOT, STATE, "brand--page");
  assert.equal(page?.doc.version, 5);
  assert.deepEqual(page?.pictures.map((p) => p.path), ["images/A01-jar.png"]);
  assert.match(page?.previewHtml ?? "", /A01-jar/);
  assert.equal(await legacyPage(ROOT, STATE, "nope"), undefined);
  assert.equal(await legacyPage(ROOT, STATE, "../escape"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a push to a run without versions writes its build as version 1, then the edit as version 2, and moves current last", async () => {
  const { gcs, dir } = fakeBucket();
  legacyRun(gcs);
  const first = await commitPageVersion(input(dir, 0, "Edited"));
  assert.ok(first.ok);
  assert.deepEqual([first.version, first.seeded, first.dir], [2, true, "versions/2"]);
  const { manifest } = await readArtifactManifest(ROOT, "page", "brand--page");
  assert.deepEqual(manifest?.versions.map((v) => [v.v, v.summary]), [[1, "The page as the run built it"], [2, ""]]);
  assert.equal(manifest?.current, 2);
  // Version 1 is the run's page as built (record version 5); the picture it names stays in images/.
  const v1 = await readVersion(ROOT, "page", "brand--page", manifest!.versions[0]!);
  assert.equal(v1.doc.version, 5);
  assert.deepEqual(v1.pictures.map((p) => p.path), ["images/A01-jar.png"]);
  const v2 = await readVersion(ROOT, "page", "brand--page", manifest!.versions[1]!);
  assert.equal(v2.doc.version, 6);
  assert.match(v2.previewHtml, /Edited/);
  // The stand-in bucket reports no sizes, so an unchanged picture can't be proven the same and is stored by content (a real bucket reports them and it is reused).
  assert.deepEqual([first.uploaded, first.reused], [1, 0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new picture is stored by content under the artifact; the same picture again is not uploaded twice", async () => {
  const { gcs, dir } = fakeBucket();
  legacyRun(gcs);
  const fresh = Buffer.concat([PNG, Buffer.from("new")]);
  const lib = path.join(dir, "studio", "brand", "pictures");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "A02-new.png"), fresh);
  const make = (base: number) => ({ ...input(dir, base, "x"), pictures: [{ brand: "brand", name: "A02-new.png", file: path.join(lib, "A02-new.png") }] });
  const a = await commitPageVersion(make(0));
  assert.ok(a.ok && a.uploaded === 1);
  const entry = (await readVersion(ROOT, "page", "brand--page", a.manifest.versions.at(-1)!)).pictures[0]!;
  assert.match(entry.path, /^artifacts\/page\/brand--page\/pictures\/[0-9a-f]{64}\.png$/);
  assert.equal(fs.existsSync(path.join(gcs, "dev-bucket", "runs", "run-1", entry.path)), true);
  const b = await commitPageVersion(make(2));
  assert.ok(b.ok && b.uploaded === 0 && b.reused === 1 && b.version === 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a push made from an older version is refused with 'pull the latest' and writes nothing", async () => {
  const { gcs, dir } = fakeBucket();
  legacyRun(gcs);
  const mine = await commitPageVersion(input(dir, 0, "Mine"));
  assert.ok(mine.ok);
  // Another person opened version 2 too, and pushed first; this one was made from version 1 ... then 2:
  const theirs = await commitPageVersion(input(dir, 2, "Theirs"));
  assert.ok(theirs.ok && theirs.version === 3);
  const late = await commitPageVersion(input(dir, 2, "Late"));
  assert.ok(!late.ok);
  assert.deepEqual([late.reason, late.current, late.baseVersion], ["cloud-moved", 3, 2]);
  assert.match(late.message, /pull the latest/);
  const { manifest } = await readArtifactManifest(ROOT, "page", "brand--page");
  assert.equal(manifest?.current, 3);
  assert.equal(manifest?.versions.length, 3);
  // A copy that never knew versions (base 0) is also refused once the run has them.
  assert.equal((await commitPageVersion(input(dir, 0, "Old"))).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the manifest write is conditional on the generation that was read", async () => {
  const { dir } = fakeBucket();
  const uri = `${ROOT}/artifacts/page/x/manifest.json`;
  await gcsWrite(uri, "one", { ifGenerationMatch: "0" });
  await assert.rejects(() => gcsWrite(uri, "again", { ifGenerationMatch: "0" }), PreconditionFailed);
  const read = await gcsRead(uri);
  await assert.rejects(() => gcsWrite(uri, "two", { ifGenerationMatch: "c-wrong" }), PreconditionFailed);
  await gcsWrite(uri, "two", { ifGenerationMatch: read!.generation });
  assert.equal((await gcsRead(uri))?.data.toString(), "two");
  assert.equal(await gcsRead(`${ROOT}/artifacts/page/none/manifest.json`), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a version folder a crashed push left behind is skipped, never overwritten", async () => {
  const { gcs, dir } = fakeBucket();
  const root = legacyRun(gcs);
  const orphan = path.join(root, "artifacts", "page", "brand--page", "versions", "2");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "page.json"), '{"orphan":true}');
  const out = await commitPageVersion(input(dir, 0, "Fresh"));
  assert.ok(out.ok);
  assert.match(out.dir, /^versions\/2-[0-9a-f]{6}$/);
  assert.equal(fs.readFileSync(path.join(orphan, "page.json"), "utf8"), '{"orphan":true}');
  assert.equal((await readVersion(ROOT, "page", "brand--page", out.manifest.versions.at(-1)!)).doc.version, 6);
  assert.ok(artifactDir(ROOT, "page", "brand--page").endsWith("/artifacts/page/brand--page"));
  fs.rmSync(dir, { recursive: true, force: true });
});
