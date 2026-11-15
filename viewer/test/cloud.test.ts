import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FileSessionStore } from "../../src/session-store";
import { cloudHost, listEdits, previewHtml, pushToCloud, readLinks, writeLink } from "../src/cloud";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PAGE_ID = "rawdog--headless-quick-6dqua";
const RUN_ID = "6ca64536-1b35-4a34-bc1f-8ae64b676744";

/**
 * A stand-in for the gcloud CLI over a folder: gs://<bucket>/<path> is <root>/<bucket>/<path>. It covers the calls the
 * cloud host makes (storage ls with ** and *, rsync -r, cp of files into a file or a folder/, cat).
 */
const FAKE_GCLOUD = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const root = process.env.FAKE_GCS_ROOT;
const local = (uri) => uri.startsWith("gs://") ? path.join(root, uri.slice(5)) : uri;
const [, , group, verb, ...rest] = process.argv;
const args = rest.filter((arg) => !arg.startsWith("--") && arg !== "-r");
const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : [];
if (group !== "storage") process.exit(2);
if (verb === "ls") {
  const pattern = args[0];
  const base = pattern.slice(0, pattern.search(/\\*/));
  const re = new RegExp("^" + pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*\\*\\//g, "(?:.*/)?").replace(/\\*/g, "[^/]*") + "$");
  const hits = walk(local(base.replace(/\\/[^/]*$/, ""))).map((file) => "gs://" + path.relative(root, file)).filter((uri) => re.test(uri));
  if (!hits.length) { process.stderr.write("ERROR: One or more URLs matched no objects.\\n"); process.exit(1); }
  process.stdout.write(hits.join("\\n") + "\\n");
} else if (verb === "cat") {
  const file = local(args[0]);
  if (!fs.existsSync(file)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(file));
} else if (verb === "rsync") {
  const from = local(args[0]), to = local(args[1]);
  if (!fs.existsSync(from)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
} else if (verb === "cp") {
  const target = args.at(-1);
  for (const source of args.slice(0, -1)) {
    const from = local(source);
    if (!fs.existsSync(from)) { process.stderr.write("ERROR: not found\\n"); process.exit(1); }
    const to = target.endsWith("/") ? path.join(local(target), path.basename(from)) : local(target);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
} else process.exit(2);
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-cloud-"));
  const gcs = path.join(dir, "gcs");
  const bin = path.join(dir, "gcloud");
  fs.writeFileSync(bin, FAKE_GCLOUD, { mode: 0o755 });
  process.env.MARSHAL_SDK_GCLOUD = bin;
  process.env.FAKE_GCS_ROOT = gcs;
  const runRoot = path.join(gcs, "dev-bucket", "runs", "demo-1");
  const state = path.join(runRoot, "agent", "marshal-state");
  // The SDK store as the sandbox leaves it, with sandbox paths in native.cwd/configDir.
  const store = new FileSessionStore(path.join(state, "state", "sessions"), { runId: RUN_ID, host: { id: "agent-sandbox", kind: "sandbox" } });
  const review = store.create({ title: "Page Studio · review", runtime: "claude", native: { kind: "claude", cwd: "/home/user/run/ws", configDir: "/home/user/.claude", sessionId: "66ba11cf-9854-4c52-8677-73b1363ef19d" } });
  store.update(review.id, { state: "idle" });
  const nativeFile = path.join(state, "claude", "projects", "-home-user-run-ws", "66ba11cf-9854-4c52-8677-73b1363ef19d.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.writeFileSync(nativeFile, `${JSON.stringify({ type: "user", message: { role: "user", content: "review the page" } })}\n`);
  const startedAt = "2026-11-15T15:09:48.947Z";
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ schemaVersion: 1, runId: RUN_ID, title: "Rawdog quick", brand: "rawdog", status: "done", startedAt }));
  fs.mkdirSync(path.join(state, "data", "pages"), { recursive: true });
  const page = (id: string, updatedAt: string) => ({
    id, title: id, brand: { id: "1617", name: "RAWDOG" }, product: null, source: "made in Page Studio", version: 1, updatedAt, updatedBy: "agent", notes: [],
    sections: [{ key: "hero", label: "Hero", kind: "html", src: "<section><h1>Look awake on camera.</h1></section>" }],
  });
  fs.writeFileSync(path.join(state, "data", "pages", `${PAGE_ID}.json`), JSON.stringify(page(PAGE_ID, "2026-11-15T15:11:10.814Z")));
  fs.writeFileSync(path.join(state, "data", "pages", "rawdog--base.json"), JSON.stringify(page("rawdog--base", "1970-01-01T00:00:00.000Z")));
  fs.mkdirSync(path.join(runRoot, "preview"), { recursive: true });
  fs.writeFileSync(path.join(runRoot, "preview", "index.html"), "<html><body><h1>Look awake on camera.</h1></body></html>");
  // A run of their older pipeline: a preview and its pictures only.
  const theirs = path.join(gcs, "dev-bucket", "runs", "theirs-766");
  fs.mkdirSync(path.join(theirs, "preview"), { recursive: true });
  fs.mkdirSync(path.join(theirs, "images"), { recursive: true });
  fs.writeFileSync(path.join(theirs, "images", "hero.png"), PNG);
  fs.writeFileSync(path.join(theirs, "preview", "index.html"), '<html><body><img src="../images/hero.png"><img src="../images/gone.png"></body></html>');
  fs.mkdirSync(path.join(theirs, "agent"), { recursive: true });
  fs.writeFileSync(path.join(theirs, "agent", "plan.json"), JSON.stringify({ product: "RAWDOG Caffeine Under Eye Cream", page_idea: "A '15 seconds a day' argument" }));
  return { dir, gcs, runRoot, pullRoot: path.join(dir, "pulled") };
}

test("a cloud host lists Marshal runs and their older runs, and serves sessions, native files and the run's pages", async () => {
  const { pullRoot, dir } = setup();
  const host = cloudHost({ id: "sandbox", uri: "gs://dev-bucket/runs" }, pullRoot);
  const runs = await host.cloudRuns(true);
  assert.deepEqual(runs.map((run) => [path.basename(run.outputRoot), run.marshal]).sort(), [["demo-1", true], ["theirs-766", false]]);
  assert.equal(runs.find((run) => run.marshal)?.run?.title, "Rawdog quick");
  assert.equal(runs.find((run) => !run.marshal)?.run?.title, "RAWDOG Caffeine Under Eye Cream");
  assert.equal(runs[0]!.previewUrl.startsWith("https://storage.cloud.google.com/dev-bucket/runs/"), true);

  const listed = await host.runs();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.runId, RUN_ID);
  assert.equal((listed[0]!.cloud as { outputRoot: string }).outputRoot, "gs://dev-bucket/runs/demo-1");

  const [session] = await host.sessions(RUN_ID);
  // The conversation file comes from the run's own claude/ folder, though native.configDir names the sandbox's path.
  const native = await host.native(session!.id);
  assert.equal(native.ok, true);

  // Only pages the run touched; the brand base it started from is left out.
  const pages = await host.pages(RUN_ID);
  assert.deepEqual(pages.pages.map((page) => page.id), [PAGE_ID]);
  assert.equal(pages.pages[0]!.runId, RUN_ID);

  // The local folder host never sees the cache (no run listed twice).
  const { folderHost } = await import("../src/hosts");
  assert.equal((await folderHost([pullRoot]).runs()).length, 0);
  assert.equal((await host.send()).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a run elsewhere in the bucket is listed through its pointer under the prefix", async () => {
  const { gcs, pullRoot, dir } = setup();
  const root = path.join(gcs, "dev-bucket", "page-generation-runs", "901", "output");
  const state = path.join(root, "agent", "marshal-state");
  const store = new FileSessionStore(path.join(state, "state", "sessions"), { runId: "run-901", host: { id: "agent-sandbox", kind: "sandbox" } });
  store.update(store.create({ title: "Page Studio · build", runtime: "claude", native: { kind: "claude", cwd: "/ws" } }).id, { state: "idle" });
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ runId: "run-901", title: "SaffPro from the page generator", status: "done" }));
  fs.mkdirSync(path.join(gcs, "dev-bucket", "runs", "index"), { recursive: true });
  fs.writeFileSync(path.join(gcs, "dev-bucket", "runs", "index", "run-901.json"), JSON.stringify({ outputRoot: "gs://dev-bucket/page-generation-runs/901/output/" }));
  const host = cloudHost({ id: "sandbox", uri: "gs://dev-bucket/runs" }, pullRoot);
  const runs = await host.cloudRuns(true);
  const found = runs.find((run) => run.outputRoot === "gs://dev-bucket/page-generation-runs/901/output");
  assert.equal(found?.marshal, true);
  assert.equal(found?.run?.title, "SaffPro from the page generator");
  assert.equal((await host.sessions("run-901")).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pushToCloud replaces the preview, keeps the old one, writes the page record and an edit record, and the cloud shows the new version", async () => {
  const { pullRoot, runRoot, dir } = setup();
  const studioDir = path.join(dir, "studio");
  fs.mkdirSync(path.join(studioDir, "library", "1617", "pictures"), { recursive: true });
  fs.writeFileSync(path.join(studioDir, "library", "1617", "pictures", "A01-jar.png"), PNG);
  const rendered = `<html><body><section data-key="hero"><h1>Look awake on every call.</h1><img src="file://${studioDir}/library/1617/pictures/A01-jar.png"></section></body></html>`;
  const pageDoc = {
    id: "local-copy", title: "RAWDOG", brand: { id: "1617", name: "RAWDOG" }, product: null, source: "imported from cloud sandbox", version: 3, updatedAt: new Date().toISOString(), updatedBy: "Omer",
    notes: [{ key: "hero", body: "@Bar ok to ship?", status: "open" }],
    sections: [{ key: "hero", label: "Hero", kind: "html", src: "<section><h1>Look awake on every call.</h1></section>" }],
  };
  const result = await pushToCloud({ outputRoot: "gs://dev-bucket/runs/demo-1", cloudPageId: PAGE_ID, renderedHtml: rendered, pageDoc, studioDir, by: { name: "Omer" }, summary: "headline", workDir: path.join(dir, "work") });
  assert.equal(result.ok, true);
  const preview = fs.readFileSync(path.join(runRoot, "preview", "index.html"), "utf8");
  assert.match(preview, /every call/);
  assert.match(preview, /src="\.\.\/images\/[^"]+"/);
  assert.equal(fs.readdirSync(path.join(runRoot, "images")).length, 1);
  const editsDir = path.join(runRoot, "agent", "edits");
  const backup = fs.readdirSync(editsDir).find((name) => !name.endsWith(".json"))!;
  assert.match(fs.readFileSync(path.join(editsDir, backup, "preview.before.html"), "utf8"), /on camera/);
  const doc = JSON.parse(fs.readFileSync(path.join(runRoot, "agent", "marshal-state", "data", "pages", `${PAGE_ID}.json`), "utf8"));
  assert.equal(doc.id, PAGE_ID);
  assert.equal(doc.notes[0].body, "@Bar ok to ship?");
  const edits = await listEdits("gs://dev-bucket/runs/demo-1");
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.summary, "headline");

  const host = cloudHost({ id: "sandbox", uri: "gs://dev-bucket/runs" }, pullRoot);
  await host.cloudRuns(true);
  const [page] = (await host.pages(RUN_ID)).pages;
  assert.equal(page!.version, 3);
  assert.equal(page!.notesOpen, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("previewHtml inlines an older run's pictures and names the missing ones; links persist", async () => {
  const { pullRoot, dir } = setup();
  const out = await previewHtml("gs://dev-bucket/runs/theirs-766", path.join(dir, "work"));
  assert.match(out.html, /data:image\/png;base64,/);
  assert.equal(out.pictures, 1);
  assert.deepEqual(out.missing, ["gone.png"]);
  writeLink(pullRoot, "local-page", { hostId: "sandbox", outputRoot: "gs://dev-bucket/runs/demo-1", cloudPageId: PAGE_ID, linkedAt: "2026-11-16T00:00:00Z" });
  assert.equal(readLinks(pullRoot)["local-page"]!.cloudPageId, PAGE_ID);
  fs.rmSync(dir, { recursive: true, force: true });
});
