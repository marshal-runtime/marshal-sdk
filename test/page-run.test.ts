import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { activityWarnings, browserGate, chromeFlags, chromeWrapper, extraExtensions, fakeAnswer, followActivity, pageShots, finishPage, markSections, readPageRunRecord, readSandboxInput, runPage, runPageEdit } from "../src/page-run.js";
import { turnSessions, writeRunLogs } from "../src/run-contract.js";
import { FileSessionStore } from "../src/session-store.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PAGE_STUDIO = process.env.MARSHAL_SDK_PAGE_STUDIO ?? "/Users/omer/marshal-tracking/page-studio/out/package";

/** A page-agent input folder the way agent-sandbox's workspace writes it, cut down to what a run reads. */
function inputFolder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-run-"));
  const input = path.join(root, "work", "input");
  const write = (file: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(input, file)), { recursive: true });
    fs.writeFileSync(path.join(input, file), body);
  };
  write("README.md", "# Input: Acme / Night Balm\n");
  write("brand/brand.json", JSON.stringify({ brand_id: 7, name: "Acme", existing_website: "https://www.acme.example" }));
  write(
    "page/brief.json",
    JSON.stringify({ brand_id: "7", product_id: "321", brand_name: "Acme", product_name: "NIGHT BALM", positioning: { brief_markdown: "## Positioning\n\nSleep better." } }),
  );
  write("page/operator-request.md", "A page for tired parents.\n");
  write("products/321/product.json", JSON.stringify({ core: { product_id: 321, name: "NIGHT BALM", product_handle: "night-balm" } }));
  write("products/321/offers.json", JSON.stringify({ domain: "acme.example", offers: [{ price: 30 }] }));
  write("products/321/facts.md", "- F1 (input): Night Balm costs $30.\n");
  write("products/321/pictures.json", JSON.stringify([{ key: "A01", file: "pictures/jar.png", description: "The jar on a white table.", scope: "product" }]));
  write("products/321/pictures/jar.png", PNG);
  return input;
}

test("readSandboxInput maps agent-sandbox's input folder to a brand, a product pack and the request", () => {
  const input = inputFolder();
  const read = readSandboxInput(input);
  assert.equal(read.productId, "321");
  assert.equal(read.brandId, "7", "the brief's brand_id, the id a brand-data provider serves");
  assert.equal(read.productDir, path.join(input, "products", "321"));
  assert.equal(read.brandName, "Acme");
  assert.equal(read.domain, "acme.example");
  assert.equal(read.productHandle, "night-balm");
  assert.equal(read.productName, "NIGHT BALM");
  assert.match(read.idea, /^A page for tired parents\.\n\nThe positioning this page sells:\n## Positioning/);
});

test("readSandboxInput refuses a folder without the brief's product", () => {
  const input = inputFolder();
  fs.rmSync(path.join(input, "products", "321"), { recursive: true });
  assert.throws(() => readSandboxInput(input), /no products\/<id>\//);
});

test("markSections keys every top-level section by its own key and leaves nested ones alone", () => {
  const html = [
    `<html><body><header class="site">top</header>`,
    `<section id="shopify-section-template--1__design-tokens" class="shopify-section"><style>.x{}</style></section>`,
    `<section class="shopify-section"><section id="hero" class="zs-pg-hero"><footer>inner</footer></section></section>`,
    `<script>const t = "<section id='fake'>";</script>`,
    `<section class="shopify-section"><div id="hero">again</div></section>`,
    `<section data-zyg-section="kept"><p>x</p></section>`,
    `<section class="shopify-section"><p>no ids</p></section>`,
    `<template><section id="tpl"></section></template>`,
    `</body></html>`,
  ].join("\n");
  const marked = markSections(html);
  assert.deepEqual(marked.keys, ["section-1", "design-tokens", "hero", "hero-2", "kept", "section-6"]);
  assert.match(marked.html, /<header data-zyg-section="section-1" class="site">/);
  assert.match(marked.html, /<section data-zyg-section="design-tokens" id="shopify-section-template--1__design-tokens"/);
  assert.match(marked.html, /<section data-zyg-section="hero" class="shopify-section"><section id="hero" class="zs-pg-hero"><footer>inner<\/footer>/);
  assert.match(marked.html, /<script>const t = "<section id='fake'>";<\/script>/);
  assert.match(marked.html, /<template><section id="tpl"><\/section><\/template>/);
  assert.equal((marked.html.match(/data-zyg-section=/g) ?? []).length, 6);
});

test("finishPage copies library pictures into out/assets and links them relatively", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-run-finish-"));
  const library = path.join(root, "state", "page-studio", "library");
  fs.mkdirSync(path.join(library, "acme", "pictures"), { recursive: true });
  fs.writeFileSync(path.join(library, "acme", "pictures", "jar.png"), PNG);
  const out = path.join(root, "out");
  const html = `<section id="a"><img src="file://${library}/acme/pictures/jar.png"><div style="background:url(https://pagestudio.library/acme/jar.png)"></div><img src="file://${library}/acme/pictures/gone.png"><img src="https://cdn.shopify.com/x.png"></section>`;
  const finished = finishPage(html, { libraryRoot: library, outDir: out });
  assert.deepEqual(finished.assets, ["jar.png"]);
  assert.deepEqual(finished.missingAssets, ["acme/gone.png"]);
  assert.ok(fs.existsSync(path.join(out, "assets", "jar.png")));
  assert.match(finished.html, /<img src="assets\/jar\.png">/);
  assert.match(finished.html, /url\(assets\/jar\.png\)/);
  assert.match(finished.html, /https:\/\/cdn\.shopify\.com\/x\.png/);
  assert.deepEqual(finished.sections, ["a"]);
});

test("the fake backend answers each of Page Studio's protocols in its format", () => {
  assert.equal(fakeAnswer("You are going to work as part of ZyG Page Studio inside Marshal. Reply with the single word ready."), "ready");
  const critic = JSON.parse(fakeAnswer("You are a fresh-eyes critic of a landing page that another team built."));
  assert.equal(critic.verdict, "pass");
  assert.deepEqual(critic.findings, []);
  assert.deepEqual(JSON.parse(fakeAnswer("You look at a brand's pictures before a designer plans")), { pictures: [] });
  const page = fakeAnswer("You design and write one long, mobile-first DTC landing page ... - https://pagestudio.library/acme/jar.png — A01");
  assert.match(page, /^<!--page title="Dry run page"-->/);
  assert.match(page, /<!--section key="hero" label="Hero"-->/);
  assert.match(page, /src="https:\/\/pagestudio\.library\/acme\/jar\.png"/);
  assert.equal(fakeAnswer("You design and write one long ... You are FIXING the page."), "");
});

test("writeRunLogs keeps agent-sandbox's RunSummary fields and counts Skill calls against the required skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-run-logs-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r1", host: { id: "t", kind: "local" } });
  const session = store.create({ title: "whole page", runtime: "claude", model: "m", native: { kind: "claude", cwd: root }, labels: {} });
  store.appendEvent(session.id, { type: "system", subtype: "init", skills: ["lp-design"] });
  store.appendEvent(session.id, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "lp-design" } }] } });
  store.appendEvent(session.id, { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "lp-review" } }] } });
  store.appendEvent(session.id, { type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 10, duration_api_ms: 8, total_cost_usd: 0.5, result: "done" });
  const summary = writeRunLogs({
    logDir: path.join(root, "logs"),
    storeRoot: path.join(root, "sessions"),
    sessions: store.list({ runId: "r1" }),
    model: "m",
    effort: "xhigh",
    started: Date.now() - 2_000,
    requiredSkills: ["lp-design", "lp-roles"],
  });
  for (const key of ["model", "effort", "wall_seconds", "skills", "skills_required", "skills_used", "skills_missing", "subagent_skills_used", "launch_issues", "message_counts", "results", "totals", "error"]) {
    assert.ok(key in summary, key);
  }
  assert.deepEqual(summary.skills, ["lp-design"]);
  assert.deepEqual(summary.skills_used, ["lp-design"]);
  assert.deepEqual(summary.subagent_skills_used, ["lp-review"]);
  assert.deepEqual(summary.skills_missing, ["lp-roles"]);
  assert.deepEqual(summary.message_counts, { system: 1, assistant: 2, result: 1 });
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0]!.final_text, "done");
  const rows = fs.readFileSync(path.join(root, "logs", "run.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => typeof row.type === "string" && typeof row.at === "number" && row.session === session.id));
});

test("an edit turn counts a session it resumed, with only this turn's usage and events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-edit-logs-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "earlier-turn", host: { id: "t", kind: "local" } });
  const hands = store.create({ title: "Page Studio fast hands", runtime: "claude", model: "haiku", native: { kind: "claude", cwd: root }, labels: {} });
  const critic = store.create({ title: "critic", runtime: "claude", model: "m", native: { kind: "claude", cwd: root }, labels: {} });
  store.appendEvent(hands.id, { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.02, result: "first" });
  store.addUsage(hands.id, { costUsd: 0.02, turns: 1 });
  store.addUsage(critic.id, { costUsd: 1, turns: 3 });
  const before = new Map(store.list().map((session) => [session.id, { ...session.usage }]));
  await new Promise((resolve) => setTimeout(resolve, 15));
  const started = Date.now();
  store.appendEvent(hands.id, { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.01, result: "second" });
  store.addUsage(hands.id, { costUsd: 0.01, turns: 1 });

  const sessions = turnSessions(store.list(), before, "this-turn", started);

  assert.deepEqual(sessions.map((session) => session.id), [hands.id], "the untouched critic is not this turn's");
  assert.ok(Math.abs(sessions[0]!.usage.costUsd - 0.01) < 1e-9);
  assert.equal(sessions[0]!.usage.turns, 1);
  const summary = writeRunLogs({ logDir: path.join(root, "logs"), storeRoot: path.join(root, "sessions"), sessions, started, since: started });
  assert.deepEqual(summary.results.map((result) => result.final_text), ["second"]);
  assert.equal((summary.totals as { total_cost_usd: number }).total_cost_usd, 0.01);
});

test("page-run loads a bundled brand-data provider (and no other bundled extension) next to Page Studio, or the caller's or env's list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-run-ext-"));
  const manifests: Record<string, unknown> = {
    "page-studio": { contributes: { capabilities: ["pagestudio.brand.learn"] } },
    brain: { contributes: { capabilities: ["knowledge.search"] } },
    org: { contributes: { capabilities: ["org.rooms.join"] } },
    "brand-data-pack": { contributes: { capabilities: ["zygbrand.pack"] } },
  };
  for (const [name, manifest] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "runtime-extension.json"), JSON.stringify(manifest));
  }
  fs.mkdirSync(path.join(root, "not-an-extension"));
  assert.deepEqual(extraExtensions(undefined, {}, root), [path.join(root, "brand-data-pack")]);
  assert.deepEqual(extraExtensions(undefined, { MARSHAL_SDK_EXTENSIONS: `/a${path.delimiter}/b` }, root), ["/a", "/b"]);
  assert.deepEqual(extraExtensions([], { MARSHAL_SDK_EXTENSIONS: "/a" }, root), [], "an explicit empty list loads none");
  assert.deepEqual(extraExtensions(undefined, {}, path.join(root, "missing")), []);
});

test("a browser that cannot launch skips the screenshots with a warning instead of failing the run", async () => {
  const logged: string[] = [];
  const missing = async () => {
    throw new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell-1212/chrome\nLooks like Playwright was just installed");
  };

  const taken = await pageShots("/page/index.html", "/page/shots", undefined, (line) => logged.push(line), missing);

  assert.deepEqual(taken.shots, []);
  assert.match(taken.error ?? "", /^screenshots skipped \(the page is written\): browserType\.launch: Executable doesn't exist/);
  assert.ok(!taken.error?.includes("Looks like"), "only the first line of the browser's error");
  assert.equal(logged.length, 1);
  const ok = await pageShots("/page/index.html", "/page/shots", undefined, () => undefined, async () => [{ name: "mobile" }]);
  assert.deepEqual(ok, { shots: [{ name: "mobile" }] });
});

test("a required skill Page Studio loads into its own prompts is not reported missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "page-run-loaded-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r1", host: { id: "t", kind: "local" } });
  store.create({ title: "writer", runtime: "claude", model: "m", native: { kind: "claude", cwd: root }, labels: {} });

  const summary = writeRunLogs({
    logDir: path.join(root, "logs"),
    storeRoot: path.join(root, "sessions"),
    sessions: store.list({ runId: "r1" }),
    requiredSkills: ["lp-design", "lp-roles", "page-builder-qa"],
    loadedSkills: ["lp-design", "lp-roles", "lp-review"],
  });

  assert.deepEqual(summary.skills_used, [], "used still means a Skill tool call");
  assert.deepEqual(summary.skills_missing, ["page-builder-qa"]);
});

test("Page Studio's skipped critic rounds and failed steps reach the run's warnings once each", () => {
  const skipped = "critic rounds skipped: 2 of 2 did not run (no browser)";
  assert.deepEqual(activityWarnings({ failed: ["copy pass"], warnings: [skipped, skipped] }), ["copy pass", skipped]);
  assert.deepEqual(activityWarnings({}), []);
  assert.deepEqual(activityWarnings({ warnings: "not a list" }), []);
});

test("a look round whose browser failed twice fails the run with Page Studio's reason; steps are reported once each", async () => {
  const lookFailed = "look failed: Target closed (round 1 of 2, retried once)";
  const polls = [{ step: "Writing the page" }, { step: "Writing the page" }, { step: "Critic round 1" }, { error: lookFailed }];
  const steps: string[] = [];
  const call = async (capability: string, args: Record<string, unknown>) => {
    assert.equal(capability, "pagestudio.activity");
    assert.equal(args.id, "act-1");
    return polls.shift();
  };
  await assert.rejects(followActivity(call, "act-1", (step) => steps.push(step)), { message: `Page Studio stopped: ${lookFailed}` });
  assert.deepEqual(steps, ["Writing the page", "Critic round 1"]);

  const done = { doneAt: "2026-11-16T00:00:00Z", reply: "ok", warnings: ["look round 1: the browser failed once and the retry worked (Target closed)"] };
  const finished = [{ step: "Critic round 1" }, done];
  assert.equal(await followActivity(async () => finished.shift(), "act-2"), done);
});

test("single and deep pages refuse to start without a usable browser unless --no-look", () => {
  const run = { depth: "single", noLook: false, usable: false, fake: false };
  assert.match(browserGate(run) ?? "", /^No usable browser: depth single looks at the rendered page.*--no-look/);
  assert.match(browserGate({ ...run, depth: "deep" }) ?? "", /depth deep/);
  assert.equal(browserGate({ ...run, usable: true }), undefined);
  assert.equal(browserGate({ ...run, noLook: true }), undefined, "an explicit --no-look builds without critic rounds");
  assert.equal(browserGate({ ...run, depth: "quick" }), undefined, "quick has no look rounds");
  assert.equal(browserGate({ ...run, fake: true }), undefined, "the dry path never looks");
});

test("Chrome gets --disable-dev-shm-usage on Linux and --no-sandbox when asked, also through Page Studio's wrapper", () => {
  assert.deepEqual(chromeFlags("linux", { MARSHAL_SDK_CHROME_NO_SANDBOX: "1" }), ["--no-sandbox", "--disable-dev-shm-usage"]);
  assert.deepEqual(chromeFlags("linux", {}, 1000), ["--disable-dev-shm-usage"]);
  assert.deepEqual(chromeFlags("linux", {}, 0), ["--no-sandbox", "--disable-dev-shm-usage"], "root on Linux (Coder, E2B) needs no env var");
  assert.deepEqual(chromeFlags("darwin", {}, 0), []);
  assert.deepEqual(chromeFlags("darwin", {}), []);
  assert.deepEqual(chromeFlags("win32", { MARSHAL_SDK_CHROME_NO_SANDBOX: "1" }), []);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-wrapper-"));
  assert.equal(chromeWrapper("/usr/bin/chromium", state, []), "/usr/bin/chromium", "no flags, no wrapper");
  if (process.platform !== "win32") {
    const wrapper = chromeWrapper("/opt/it's/chrome", state, ["--no-sandbox", "--disable-dev-shm-usage"]);
    assert.equal(fs.readFileSync(wrapper, "utf8"), `#!/bin/sh\nexec '/opt/it'\\''s/chrome' --no-sandbox --disable-dev-shm-usage "$@"\n`);
  }
});

test("page-run's dry path writes the whole run contract from an input folder, with no model", { skip: !fs.existsSync(path.join(PAGE_STUDIO, "runtime-extension.json")) && "Page Studio package not found", timeout: 90_000 }, async () => {
  const input = inputFolder();
  const work = path.dirname(input);
  const root = path.dirname(work);
  const out = path.join(work, "out");
  const logs = path.join(root, "page-agent-logs");
  const summary = await runPage({ input, out, logs, state: path.join(root, "state"), extension: PAGE_STUDIO, fake: true, offline: true, requiredSkills: ["lp-design"] });
  assert.equal(summary.error, "", summary.error);
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /A page written without a model/);
  assert.match(html, /src="assets\/jar\.png"/);
  assert.ok(fs.existsSync(path.join(out, "assets", "jar.png")));
  assert.ok(!html.includes("file://"), "no absolute file links left");
  const marshal = summary.marshal as { sections: string[]; fake: boolean };
  assert.equal(marshal.fake, true);
  assert.ok(marshal.sections.includes("hero") && marshal.sections.includes("proof"), marshal.sections.join(","));
  for (const file of ["run.jsonl", "summary.json", "query/system_prompt.md", "query/task.md", "query/options.json"]) assert.ok(fs.existsSync(path.join(logs, file)), file);
  for (const file of ["shots/mobile.png", "shots/desktop.png"]) assert.ok(fs.existsSync(path.join(out, file)), file);
  assert.deepEqual(summary.skills_missing, [], "Page Studio loads lp-design into its own prompts");
  assert.ok((summary.marshal as { pageStudio: { skills?: string[] } }).pageStudio.skills?.includes("lp-design"));
  assert.ok(summary.results.length >= 2, "the whole-page writer and the critic ran as sessions");
  const build = (summary.marshal as { pageStudio: { version?: string; contentHash?: string; drift?: string } }).pageStudio;
  assert.match(build.contentHash ?? "", /^[0-9a-f]{64}$/, "the run records the Page Studio build it ran");
  assert.equal(build.drift, undefined);
});

test("page-edit reopens a finished run's state and edits its page through Page Studio's ask, with no model", { skip: !fs.existsSync(path.join(PAGE_STUDIO, "runtime-extension.json")) && "Page Studio package not found", timeout: 120_000 }, async () => {
  const input = inputFolder();
  const work = path.dirname(input);
  const root = path.dirname(work);
  const state = path.join(root, "state");
  const built = await runPage({ input, out: path.join(work, "out"), logs: path.join(root, "page-agent-logs"), state, extension: PAGE_STUDIO, fake: true, offline: true, quickModel: "haiku" });
  assert.equal(built.error, "", built.error);
  const record = readPageRunRecord(state);
  assert.ok(record?.pageId, "page-run keeps the page it made in the state folder");
  assert.equal(record?.settings.quickModel, "haiku");
  const editOut = path.join(root, "edit-1", "out");
  const editLogs = path.join(root, "edit-1", "logs");
  const env = { ...(process.env as Record<string, string>), MARSHAL_PAGE_STUDIO_HASH: "0".repeat(64) };
  const edited = await runPageEdit({ state, out: editOut, logs: editLogs, request: "Make the hero title shorter.", extension: PAGE_STUDIO, fake: true, env });
  assert.equal(edited.error, "", edited.error);
  assert.match((edited.marshal as { pageStudio: { drift?: string } }).pageStudio.drift ?? "", /Page Studio drift: .*continuing/, "a different build only warns");
  assert.match(fs.readFileSync(path.join(editOut, "index.html"), "utf8"), /A page written without a model/);
  for (const file of ["summary.json", "run.jsonl", "query/task.md"]) assert.ok(fs.existsSync(path.join(editLogs, file)), file);
  assert.equal((edited.marshal as { job: string }).job, "edit");
  assert.equal(readPageRunRecord(state)?.edits?.length, 1, "the edit is recorded on the run");
});
