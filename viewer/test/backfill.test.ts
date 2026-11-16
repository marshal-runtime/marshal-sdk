import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { manifestProblems, readArtifactManifest, readVersion } from "../src/artifacts";
import { backfillRun } from "../src/backfill";
import { fakeBucket } from "./fake-gcs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const page = (id: string) => ({ id, title: `Title ${id}`, brand: { id: "b", name: "B" }, version: 7, notes: [], sections: [{ key: "hero", kind: "html", src: '<img src="https://pagestudio.library/b/hero.png">' }] });

test("backfill gives an old run its manifest v1 and version 1 of its page and board, keeps their fields, and is safe to repeat", async () => {
  const { gcs, dir } = fakeBucket();
  const root = path.join(gcs, "dev-bucket", "runs", "900014");
  const state = path.join(root, "agent", "marshal-state");
  fs.mkdirSync(path.join(state, "page-studio", "pages"), { recursive: true });
  fs.writeFileSync(path.join(state, "page-studio", "pages", "b--page.json"), JSON.stringify(page("b--page")));
  fs.writeFileSync(path.join(state, "page-studio", "pages", "b--board.json"), JSON.stringify(page("b--board")));
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "images", "hero.png"), PNG);
  fs.mkdirSync(path.join(state, "host", "sessions", "s1"), { recursive: true });
  fs.writeFileSync(path.join(state, "host", "sessions", "index.json"), JSON.stringify([{ id: "s1", title: "Page Studio · build" }]));
  fs.writeFileSync(path.join(state, "host", "sessions", "s1", "events.jsonl"), "{}\n");
  fs.mkdirSync(path.join(root, "preview"), { recursive: true });
  fs.writeFileSync(path.join(root, "preview", "index.html"), "<html>landing</html>");
  const original = { schemaVersion: 1, runId: "900014", title: "Aura", brand: "Hey Mila", startedBy: "omer@zyg.com", status: "done", costUsd: 20.6, depth: "single", pageId: "b--page", boardId: "b--board" };
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(original));
  const uri = "gs://dev-bucket/runs/900014";

  const dry = await backfillRun({ root: uri, dryRun: true });
  assert.equal(dry.wrote, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8")), original);
  assert.equal(fs.existsSync(path.join(root, "artifacts")), false);

  const out = await backfillRun({ root: uri });
  assert.deepEqual(out.artifacts.map((a) => [a.id, a.kind, a.created, a.versions]), [["b--page", "landing-page", true, 1], ["b--board", "brand-board", true, 1]]);
  const written = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  assert.deepEqual(manifestProblems(written), []);
  assert.deepEqual([written.costUsd, written.brand, written.startedBy, written.workspace, written.workflow, written.visibility, written.requester, written.labels.brand], [20.6, "Hey Mila", "omer@zyg.com", "pages", "page-generation", "team", "omer@zyg.com", "Hey Mila"]);
  assert.deepEqual(written.sessions.map((s: any) => [s.id, s.role, s.hasEnvelope]), [["s1", "Page Studio · build", false]]);
  assert.deepEqual(written.artifacts.map((a: any) => [a.id, a.current]), [["b--page", 1], ["b--board", 1]]);
  assert.equal((await readArtifactManifest(uri, "page", "b--page")).manifest?.versions[0]?.docVersion, 7);
  // The run's preview belongs to its landing page, not to the brand board.
  const versionOf = async (id: string) => {
    const { manifest } = await readArtifactManifest(uri, "page", id);
    return readVersion(uri, "page", id, manifest!.versions[0]!);
  };
  assert.match((await versionOf("b--page")).previewHtml, /landing/);
  assert.equal((await versionOf("b--board")).previewHtml, "");

  const again = await backfillRun({ root: uri });
  assert.deepEqual(again.artifacts.map((a) => a.created), [false, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an edit conversation keeps its state beside the root and is backfilled as a page-edit procedure", async () => {
  const { gcs, dir } = fakeBucket();
  const root = path.join(gcs, "dev-bucket", "page-edit-conversations", "1");
  const state = path.join(root, "marshal-state");
  fs.mkdirSync(path.join(state, "page-studio", "pages"), { recursive: true });
  fs.writeFileSync(path.join(state, "page-studio", "pages", "b--page.json"), JSON.stringify(page("b--page")));
  fs.writeFileSync(path.join(state, "page-run.json"), JSON.stringify({ pageId: "b--page" }));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ schemaVersion: 1, runId: "900001", title: "sdk-784-biovelvet", brand: "BioVelvet", status: "done", starter: { email: "omer@zyg.com" } }));
  const out = await backfillRun({ root: "gs://dev-bucket/page-edit-conversations/1", state: "gs://dev-bucket/page-edit-conversations/1/marshal-state", workflow: "page-edit" });
  assert.equal(out.manifest.workflow, "page-edit");
  assert.equal(out.manifest.requester, "omer@zyg.com");
  assert.deepEqual(out.artifacts.map((a) => [a.id, a.created]), [["b--page", true]]);
  assert.equal(fs.existsSync(path.join(root, "artifacts", "page", "b--page", "manifest.json")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
