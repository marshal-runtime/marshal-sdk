import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { commitPageVersion, extendRunJson } from "../src/artifacts";
import { CloudCache } from "../src/cache";
import { cloudHost } from "../src/cloud";
import { filterRows, openPage, pageRows } from "../src/cloud-pages";
import { fakeBucket } from "./fake-gcs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const BIG = Buffer.alloc(200_000, 7);

const page = (id: string, version: number, pictures: string[]) => ({
  id, title: `Page ${id}`, brand: { id: "brand", name: "Brand" }, version, notes: [],
  sections: [{ key: "hero", kind: "html", src: pictures.map((name) => `<img src="https://pagestudio.library/brand/${name}">`).join("") }],
});

/** A finished run on the Marshal SDK with a manifest, a page with two versions, and plenty of other files that opening must not touch. */
async function world() {
  const { gcs, dir } = fakeBucket();
  const root = path.join(gcs, "dev-bucket", "runs", "run-a");
  const state = path.join(root, "agent", "marshal-state");
  fs.mkdirSync(path.join(state, "claude"), { recursive: true });
  fs.writeFileSync(path.join(state, "claude", "session.jsonl"), BIG);
  fs.mkdirSync(path.join(state, "page-studio", "pages"), { recursive: true });
  fs.writeFileSync(path.join(state, "page-studio", "pages", "brand--a.json"), JSON.stringify(page("brand--a", 1, ["hero.png", "second.png"])));
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "images", "hero.png"), PNG);
  fs.writeFileSync(path.join(root, "images", "second.png"), Buffer.concat([PNG, Buffer.from("2")]));
  fs.writeFileSync(path.join(root, "images", "unrelated.png"), BIG);
  fs.mkdirSync(path.join(root, "preview"), { recursive: true });
  fs.writeFileSync(path.join(root, "preview", "index.html"), "<html>v1</html>");
  fs.writeFileSync(path.join(root, "output.json"), "{}");
  const lib = path.join(dir, "studio", "brand", "pictures");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "hero.png"), PNG);
  const fresh = Buffer.concat([PNG, Buffer.from("fresh")]);
  fs.writeFileSync(path.join(lib, "fresh.png"), fresh);
  const rootUri = "gs://dev-bucket/runs/run-a";
  const committed = await commitPageVersion({
    root: rootUri, state: `${rootUri}/agent/marshal-state`, app: "page", kind: "landing-page", id: "brand--a", title: "Page A", baseVersion: 0,
    doc: page("brand--a", 2, ["hero.png", "fresh.png"]), previewHtml: "<html>v2</html>",
    pictures: [{ brand: "brand", name: "hero.png", file: path.join(lib, "hero.png") }, { brand: "brand", name: "fresh.png", file: path.join(lib, "fresh.png") }],
    by: { name: "Omer" }, summary: "second",
  });
  assert.ok(committed.ok);
  const manifest = extendRunJson({ schemaVersion: 1, runId: "run-a", title: "Hey Mila · Aura", brand: "Hey Mila", startedBy: "omer@zyg.com", status: "done", startedAt: "2026-11-16T02:00:00Z", pageId: "brand--a" }, { runId: "run-a", artifacts: [{ app: "page", kind: "landing-page", id: "brand--a", title: "Page A", current: 2 }], labels: { brand: "Hey Mila" } });
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(manifest));
  // A run that has no manifest fields yet, an older pipeline's run, and a restricted run.
  const bare = path.join(gcs, "dev-bucket", "runs", "run-b");
  fs.mkdirSync(path.join(bare, "agent", "marshal-state", "page-studio", "pages"), { recursive: true });
  fs.writeFileSync(path.join(bare, "agent", "marshal-state", "run.json"), JSON.stringify({ schemaVersion: 1, runId: "run-b", title: "Bare run", status: "running", pageId: "brand--b", startedAt: "2026-11-15T10:00:00Z" }));
  const older = path.join(gcs, "dev-bucket", "runs", "theirs-1");
  fs.mkdirSync(path.join(older, "preview"), { recursive: true });
  fs.writeFileSync(path.join(older, "preview", "index.html"), "<html></html>");
  const host = cloudHost({ id: "sandbox", uri: "gs://dev-bucket/runs" }, path.join(dir, "pulled"));
  return { gcs, dir, host, root, rootUri, lib };
}

test("the list is one row per page artifact from the run manifests; runs without one still show their page", async () => {
  const { dir, host } = await world();
  const rows = pageRows(await host.cloudRuns(true));
  const byId = Object.fromEntries(rows.map((row) => [row.artifact.id, row]));
  assert.deepEqual([rows.length, byId["brand--a"]!.artifact.current, byId["brand--a"]!.artifact.legacy], [3, 2, false]);
  assert.deepEqual([byId["brand--a"]!.workspace, byId["brand--a"]!.workflow, byId["brand--a"]!.visibility, byId["brand--a"]!.requester, byId["brand--a"]!.labels.brand], ["pages", "page-generation", "team", "omer@zyg.com", "Hey Mila"]);
  assert.deepEqual([byId["brand--b"]!.artifact.legacy, byId["brand--b"]!.status], [true, "running"]);
  assert.equal(byId["theirs-1"]!.marshal, false);
  // Newest first, filters and search work on the rows only.
  assert.deepEqual(filterRows(rows, {}).map((row) => row.artifact.id)[0], "brand--a");
  assert.deepEqual(filterRows(rows, { query: "hey mila" }).map((row) => row.artifact.id), ["brand--a"]);
  assert.deepEqual(filterRows(rows, { status: "running" }).map((row) => row.artifact.id), ["brand--b"]);
  assert.deepEqual(filterRows(rows, { workspace: "marley" }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an artifact the runner listed with current 0 (no versions yet) is a legacy row that still opens from the run's own page", async () => {
  const { dir, host, gcs } = await world();
  const state = path.join(gcs, "dev-bucket", "runs", "run-b", "agent", "marshal-state");
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(extendRunJson({ schemaVersion: 1, runId: "run-b", title: "Bare run", status: "done", pageId: "brand--b" }, { runId: "run-b", artifacts: [{ app: "page", kind: "landing-page", id: "brand--b", title: "B", current: 0 }] })));
  const row = pageRows(await host.cloudRuns(true)).find((candidate) => candidate.artifact.id === "brand--b")!;
  assert.deepEqual([row.artifact.current, row.artifact.legacy], [null, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listing downloads nothing: no page, picture or session file reaches the cache", async () => {
  const { dir, host } = await world();
  const cache = new CloudCache(path.join(dir, "cache"));
  pageRows(await host.cloudRuns(true));
  assert.equal(cache.stats().files, 0);
  assert.equal(fs.existsSync(path.join(dir, "pulled", ".cloud-sandbox", "gs_dev-bucket_runs_run-a")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("opening a page fetches its record and only the pictures it shows, then serves them from the cache", async () => {
  const { dir, rootUri } = await world();
  const cache = new CloudCache(path.join(dir, "cache"));
  const opened = await openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, id: "brand--a", cache });
  assert.deepEqual([opened.version, opened.current, opened.pictures], [2, 2, 2]);
  // Folder shaped for pagestudio.page.import.
  assert.equal(JSON.parse(fs.readFileSync(path.join(opened.dataDir, "pages", "brand--a.json"), "utf8")).version, 2);
  assert.deepEqual(fs.readdirSync(path.join(opened.dataDir, "library", "brand", "pictures")).sort(), ["fresh.png", "hero.png"]);
  // Nothing of the run's 200 KB session file or its unrelated picture came down.
  const names = cache.stats();
  assert.ok(opened.transfer.downloaded < 5_000, `downloaded ${opened.transfer.downloaded}`);
  assert.equal(names.bytes < 5_000 + 200, true);
  const cachedFiles = fs.readdirSync(cache.runDir("sandbox", rootUri), { recursive: true }).map(String);
  assert.equal(cachedFiles.some((name) => /session\.jsonl|unrelated/.test(name)), false);
  const again = await openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, id: "brand--a", cache });
  assert.equal(again.transfer.downloaded < 400, true, "only the manifest is read again");
  assert.ok(again.transfer.cached > 0);
  // An older version opens too, from the run's own images/.
  const first = await openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, id: "brand--a", version: 1, cache });
  assert.deepEqual([first.version, first.pictures], [1, 2]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dataDir, "pages", "brand--a.json"), "utf8")).version, 1);
  await assert.rejects(() => openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, id: "brand--a", version: 9, cache }), /does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a page of a run that has no versions opens from its own record; a restricted run is marked for sign-out", async () => {
  const { gcs, dir, root } = await world();
  const bare = path.join(gcs, "dev-bucket", "runs", "run-b");
  fs.writeFileSync(path.join(bare, "agent", "marshal-state", "page-studio", "pages", "brand--b.json"), JSON.stringify(page("brand--b", 3, ["hero.png"])));
  fs.mkdirSync(path.join(bare, "images"), { recursive: true });
  fs.writeFileSync(path.join(bare, "images", "hero.png"), PNG);
  const cache = new CloudCache(path.join(dir, "cache"));
  const rootUri = "gs://dev-bucket/runs/run-b";
  const opened = await openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, visibility: "restricted", id: "brand--b", cache });
  assert.deepEqual([opened.version, opened.current, opened.pictures], [0, 0, 1]);
  assert.equal(cache.clearRestricted(), 1);
  assert.equal(fs.existsSync(opened.dataDir), false);
  await assert.rejects(() => openPage({ hostId: "sandbox", root: rootUri, state: `${rootUri}/agent/marshal-state`, runKey: rootUri, id: "nope", cache }), /no page/);
  void root;
  fs.rmSync(dir, { recursive: true, force: true });
});
