import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startLinkServer } from "../../src/link/server";
import { FileSessionStore } from "../../src/session-store";
import { createExtension } from "../src/index";
import { summarizeRuns, findStores } from "../src/store";

const LINK_TOKEN = "viewer-pages-token-0123456789";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PAGE_ID = "rawdog--headless-quick-6dqua";

/** A run folder the way a headless Page Studio run leaves it: state/sessions, and data/ as its PAGE_STUDIO_DIR. */
function pageRun(runFolder: string, runId: string) {
  const store = new FileSessionStore(path.join(runFolder, "state", "sessions"), { runId, host: { id: "poc", kind: "local" } });
  const plan = store.create({ title: "Page Studio · plan", runtime: "claude", native: { kind: "claude", cwd: "/ws" } });
  store.addUsage(plan.id, { outputTokens: 50, costUsd: 0.1, turns: 1 });
  store.update(plan.id, { state: "idle" });
  const hero = store.create({ title: "Page Studio · section hero", runtime: "claude", native: { kind: "claude", cwd: "/ws" }, parentId: plan.id });
  store.update(hero.id, { state: "idle" });
  const data = path.join(runFolder, "data");
  fs.mkdirSync(path.join(data, "pages"), { recursive: true });
  fs.mkdirSync(path.join(data, "library", "1617", "pictures"), { recursive: true });
  fs.writeFileSync(path.join(data, "library", "1617", "pictures", "A01-jar.png"), PNG);
  fs.writeFileSync(path.join(data, "library", "1617", "brand.json"), JSON.stringify({ brand: "1617", pictures: [{ key: "A01", url: "https://pagestudio.library/1617/A01-jar.png", shows: "the jar" }] }));
  fs.writeFileSync(path.join(data, "pages", `${PAGE_ID}.json`), JSON.stringify({
    id: PAGE_ID, title: "RAWDOG · Awake On Camera", brand: { id: "1617", name: "RAWDOG" }, product: null, source: "made in Page Studio",
    sections: [{ key: "hero", label: "Hero", src: '<img src="https://pagestudio.library/1617/A01-jar.png">' }, { key: "faq", label: "FAQ", src: "<section></section>" }],
    tokens: {}, notes: [], version: 13, updatedAt: new Date().toISOString(), updatedBy: "agent",
  }));
  return { store, data, ids: [plan.id, hero.id] };
}

/** A copy of a run's sessions pulled from a host: the same records, labelled pulledFrom. */
function pulledCopy(fromStore: string, target: string, hostId: string) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(fromStore, target, { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(target, "index.json"), "utf8"));
  fs.writeFileSync(path.join(target, "index.json"), JSON.stringify(index.map((record: any) => ({ ...record, labels: { ...record.labels, pulledFrom: hostId } }))));
}

/** Page Studio as the extension reaches it through context.execute; records what was asked. */
function fakeStudio(options: { hasImport?: boolean } = {}) {
  const requests: Record<string, any>[] = [];
  const execute = async (request: Record<string, any>) => {
    requests.push(request);
    if (request.target === "pagestudio.page.import") {
      if (options.hasImport === false) return { status: "error", error: { code: "not-found", message: 'Capability "pagestudio.page.import" was not found.' } };
      const file = path.join(request.input.dataDir, "pages", `${request.input.pageId}.json`);
      const page = JSON.parse(fs.readFileSync(file, "utf8"));
      const pictures = fs.readdirSync(path.join(request.input.dataDir, "library", "1617", "pictures")).length;
      return { status: "success", result: { output: { result: { pageId: page.id, title: page.title, sections: page.sections.length, pictures: { copied: pictures, reused: 0, renamed: 0, missing: [] } } } } };
    }
    if (request.target === "pagestudio.open") return { status: "success", result: { output: { result: { opened: true } } } };
    return { status: "error", error: { code: "not-found", message: "unknown" } };
  };
  return { requests, execute };
}

test("a run and a copy pulled from a host are one row that names both, and its sessions count once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-dupe-"));
  const run = pageRun(path.join(root, ".runs", "quick1"), "run-q");
  pulledCopy(run.store.root, path.join(root, ".pulled", "coder", "run-q", "state", "sessions"), "coder");
  const roots = [path.join(root, ".runs"), path.join(root, ".pulled")];
  const runs = summarizeRuns(findStores(roots), roots);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.sessions, 2);
  assert.equal(runs[0]!.costUsd, 0.1);
  assert.equal(runs[0]!.store, run.store.root);
  assert.deepEqual(runs[0]!.sources.map((source) => [source.label, source.pulledFrom ?? null]), [[path.join(".runs", "quick1"), null], [path.join(".pulled", "coder", "run-q"), "coder"]]);

  const extension = createExtension({ configuration: { roots } });
  const call = async (name: string, input: Record<string, unknown>) => ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;
  assert.equal((await call("sdksessions.runs", {})).runs.length, 1);
  assert.deepEqual((await call("sdksessions.sessions", { runId: "run-q" })).sessions.map((session: any) => session.id).sort(), [...run.ids].sort());
  assert.equal((await call("sdksessions.telemetry", { runId: "run-q" })).telemetry.sessions, 2);
  assert.equal((await call("sdksessions.search", { query: "hero" })).hits.length, 1);
  // The original's labels win over the copy's.
  assert.equal((await call("sdksessions.sessions", { runId: "run-q" })).sessions.some((session: any) => session.labels?.pulledFrom), false);
});

test("a page a local run made opens in Page Studio straight from the run's own folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-pages-local-"));
  const run = pageRun(path.join(root, ".runs", "quick1"), "run-q");
  // A later run in another folder whose time window covers the page must not claim it.
  const later = new FileSessionStore(path.join(root, ".runs", "later", "state", "sessions"), { runId: "run-later", host: { id: "poc", kind: "local" } });
  later.create({ title: "Smoke", runtime: "claude", native: { kind: "claude", cwd: "/ws" } });
  const studio = fakeStudio();
  const extension = createExtension({ configuration: { roots: [path.join(root, ".runs")] }, execute: studio.execute });
  const call = async (name: string, input: Record<string, unknown>) => ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;

  const listed = await call("sdksessions.pages", { runId: "run-q" });
  assert.equal(listed.pageStudio, true);
  assert.deepEqual(listed.pages.map((page: any) => [page.id, page.runId, page.from, page.sections, page.pictures.library]), [[PAGE_ID, "run-q", path.join(".runs", "quick1"), 2, 1]]);
  assert.deepEqual((await call("sdksessions.pages", { runId: "other" })).pages, []);

  const out = await call("sdksessions.openInPageStudio", { runId: "run-q", pageId: PAGE_ID });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.pageId, out.sections, out.opened], [PAGE_ID, 2, true]);
  assert.equal(studio.requests[0]!.target, "pagestudio.page.import");
  assert.equal(fs.realpathSync(studio.requests[0]!.input.dataDir), fs.realpathSync(run.data));
  assert.match(studio.requests[0]!.input.origin, /\.runs\/quick1 · run run-q/);
  assert.deepEqual(studio.requests[1], { protocolVersion: "1.0.0", targetType: "operation", target: "pagestudio.open", input: { pageId: PAGE_ID } });

  const refused = await call("sdksessions.openInPageStudio", { pageId: "../../etc/passwd" });
  assert.equal(refused.ok, false);
});

test("a linked host's page is pulled with its pictures before Page Studio takes it in, and pull brings pages too", async () => {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-pages-host-"));
  const run = pageRun(path.join(hostRoot, "run"), "run-x");
  const server = await startLinkServer({ token: LINK_TOKEN, sessionsRoot: run.store.root, host: { id: "coder-omer-dev", kind: "container" }, pageStudioDir: run.data });
  const pullRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-pages-pulled-"));
  const configuration = { roots: [fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))], pullRoot, hosts: [{ id: "coder", name: "Coder", url: server.url, token: LINK_TOKEN }] };
  try {
    const studio = fakeStudio();
    const extension = createExtension({ configuration, execute: studio.execute });
    const call = async (name: string, input: Record<string, unknown>) => ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;
    assert.deepEqual((await call("sdksessions.pages", { hostId: "coder", runId: "run-x" })).pages.map((page: any) => page.id), [PAGE_ID]);

    const out = await call("sdksessions.openInPageStudio", { hostId: "coder", pageId: PAGE_ID, open: false });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.opened, false);
    assert.deepEqual(out.pulled, { pictures: 1, bytes: PNG.length });
    const target = path.join(pullRoot, "coder", "run-x", "data");
    assert.equal(studio.requests[0]!.input.dataDir, target);
    assert.match(studio.requests[0]!.input.origin, /^Coder \(http:\/\/127\.0\.0\.1:\d+\) · run run-x$/);
    assert.deepEqual(fs.readFileSync(path.join(target, "library", "1617", "pictures", "A01-jar.png")), PNG);
    assert.equal(studio.requests.length, 1, "open:false leaves the Page Studio tab alone");
    assert.ok(!JSON.stringify(out).includes(LINK_TOKEN));

    const missing = fakeStudio({ hasImport: false });
    const older = createExtension({ configuration, execute: missing.execute });
    const unavailable = ((await older.capabilityProviders[0]!.invoke("sdksessions.openInPageStudio", { hostId: "coder", pageId: PAGE_ID }, {})) as { output: { result: any } }).output.result;
    assert.equal(unavailable.reason, "unavailable");
    assert.match(unavailable.message, /pagestudio\.page\.import/);
    assert.match(unavailable.message, /coder\/run-x\/data/);

    fs.rmSync(path.join(pullRoot, "coder"), { recursive: true, force: true });
    const pulled = await call("sdksessions.pull", { hostId: "coder", runId: "run-x" });
    assert.deepEqual([pulled.sessions, pulled.pages], [2, 1]);
    const local = createExtension({ configuration: { roots: [pullRoot] }, execute: studio.execute });
    const localPages = ((await local.capabilityProviders[0]!.invoke("sdksessions.pages", { runId: "run-x" }, {})) as { output: { result: any } }).output.result;
    assert.deepEqual(localPages.pages.map((page: any) => [page.id, page.from]), [[PAGE_ID, path.join(path.basename(pullRoot), "coder", "run-x")]]);
  } finally {
    await server.close();
  }
});
