import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { declaredAgents, dryQuery, findAgent, runAgent } from "../src/agent-run.js";
import { readExtensionAgents, resolveAgent } from "../src/agent-entries.js";
import { checkManifest } from "../src/check.js";
import { browserEnv, chromeFlags, chromeWrapper } from "../src/chrome.js";
import { parseManifest } from "../src/onboarding.js";
import { turnSessions, writeRunLogs } from "../src/run-contract.js";
import { declaredHost } from "../src/run-kit.js";
import { FileSessionStore } from "../src/session-store.js";

// Tests run from dist/test/: the fixtures stay in the repository's test/fixtures/.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "agents");
const HELLO = path.join(FIXTURES, "hello");
const PAGES = path.join(FIXTURES, "pages");

/** An empty package (an @marshal/brain stand-in: the kit's Brain is never called here). */
function extensionPackage(identity: string, version: string, fields: Record<string, unknown> = {}): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-ext-")), "package");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime-extension.json"), JSON.stringify({ schemaVersion: 1, identity, version, entrypoint: "dist/index.cjs", moduleFormat: "commonjs-bundle-v1", contributes: {}, ...fields }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: identity, version, type: "commonjs", main: "dist/index.cjs" }));
  fs.writeFileSync(path.join(root, "dist", "index.cjs"), "module.exports = { activate() { return {}; } };");
  return root;
}
const BRAIN_STUB = extensionPackage("@marshal/brain", "0.0.0-stub");

/** A caller's folders: <root>/work (cwd, with a page brief), <root>/state and <root>/logs, and a manifest naming `agent`. */
function caller(agent: string | undefined): { root: string; cwd: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-"));
  const cwd = path.join(root, "work");
  fs.mkdirSync(path.join(cwd, "input", "page"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "input", "page", "brief.json"), JSON.stringify({ product_name: "NIGHT BALM", source: { page_generation_run_id: 900301 } }));
  const manifest = path.join(root, "marshal-sdk.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, defaults: false, ...(agent ? { agent } : {}), extensions: [{ path: HELLO }, { path: PAGES }] }));
  return { root, cwd, manifest };
}

test("the same caller runs whichever agent its manifest names: changing only `agent` switches hello and the page agent", { timeout: 120_000 }, async () => {
  const hello = caller("@fixture/hello");
  const helloSummary = await runAgent({ cwd: hello.cwd, prompt: "the brief", state: path.join(hello.root, "state"), logs: path.join(hello.root, "logs"), manifest: hello.manifest, fake: true, env: {} });
  assert.equal(helloSummary.error, "");
  assert.equal(fs.readFileSync(path.join(hello.cwd, "out", "hello.txt"), "utf8"), "hello from @fixture/hello: the brief\n");
  assert.equal(fs.existsSync(path.join(hello.cwd, "out", "index.html")), false);
  const helloMarshal = helloSummary.marshal as Record<string, unknown>;
  assert.equal(helloMarshal.agent, "@fixture/hello:hello");
  assert.deepEqual(helloMarshal.outputs, ["out/hello.txt"]);
  assert.equal(helloMarshal.reply, "said hello");
  assert.equal(fs.readFileSync(path.join(hello.root, "logs", "progress.log"), "utf8"), "wrote out/hello.txt\n");
  assert.ok(fs.existsSync(path.join(hello.root, "logs", "summary.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(hello.root, "logs", "query", "options.json"), "utf8")).capability, "hello.agent.run");

  const pages = caller("@fixture/pages");
  const pageSummary = await runAgent({ cwd: pages.cwd, prompt: "the brief", state: path.join(pages.root, "state"), logs: path.join(pages.root, "logs"), manifest: pages.manifest, stateLink: "gs://bucket/900301/output/agent/marshal-state", runLabel: "900301", fake: true, env: {} });
  assert.equal(pageSummary.error, "");
  const html = fs.readFileSync(path.join(pages.cwd, "out", "index.html"), "utf8");
  assert.match(html, /<h1>NIGHT BALM<\/h1>/);
  assert.match(html, /<meta name="marshal-page-state" content="gs:\/\/bucket\/900301\/output\/agent\/marshal-state">/);
  assert.equal(fs.existsSync(path.join(pages.cwd, "out", "hello.txt")), false);
  const pageMarshal = pageSummary.marshal as Record<string, unknown>;
  assert.equal(pageMarshal.agent, "@fixture/pages:page");
  assert.equal(pageMarshal.engine, "fake-pages", "the agent's own details land in the summary");
  assert.equal(pageMarshal.runLabel, "900301");
});

test("--agent overrides the manifest's, and a run continues the state an earlier run left", { timeout: 120_000 }, async () => {
  const run = caller("@fixture/hello");
  const state = path.join(run.root, "state");
  const first = await runAgent({ agent: "@fixture/pages:page", cwd: run.cwd, state, logs: path.join(run.root, "logs-1"), manifest: run.manifest, fake: true, env: {} });
  assert.equal(first.error, "");
  assert.match(fs.readFileSync(path.join(run.cwd, "out", "index.html"), "utf8"), /version 1/);
  const second = await runAgent({ agent: "@fixture/pages", cwd: run.cwd, state, logs: path.join(run.root, "logs-2"), manifest: run.manifest, resumed: true, fake: true, env: {} });
  assert.equal(second.error, "");
  assert.match(fs.readFileSync(path.join(run.cwd, "out", "index.html"), "utf8"), /version 2/);
  const fresh = caller(undefined);
  const refused = await runAgent({ agent: "@fixture/pages", cwd: fresh.cwd, state: path.join(fresh.root, "state"), logs: path.join(fresh.root, "logs"), manifest: fresh.manifest, resumed: true, fake: true, env: {} });
  assert.equal(refused.error, "nothing to continue", "an agent's refusal is the run's error");
});

test("an agent that answers {running} is called again with {poll} until it is done (one call is capped at 300 s)", { timeout: 120_000 }, async () => {
  const run = caller("@fixture/hello");
  const summary = await runAgent({ cwd: run.cwd, prompt: "slow brief", state: path.join(run.root, "state"), logs: path.join(run.root, "logs"), manifest: run.manifest, fake: true, env: {} });
  assert.equal(summary.error, "");
  assert.equal(fs.readFileSync(path.join(run.cwd, "out", "hello.txt"), "utf8"), "hello from @fixture/hello: slow brief\n");
  assert.equal(fs.readFileSync(path.join(run.root, "logs", "progress.log"), "utf8"), "still working\nwrote out/hello.txt\n");
  const input = JSON.parse(fs.readFileSync(path.join(run.root, "logs", "query", "options.json"), "utf8")).input;
  assert.ok(input.waitMs > 0 && input.waitMs < 300_000);
});

test("without a named agent there is nothing to run; an unknown agent names what the host has", async () => {
  const run = caller(undefined);
  await assert.rejects(runAgent({ cwd: run.cwd, state: path.join(run.root, "state"), logs: path.join(run.root, "logs"), manifest: run.manifest, env: {} }), /No agent to run/);
  const extensions = [
    { identity: "@fixture/hello", packageRoot: HELLO },
    { identity: "@fixture/pages", packageRoot: PAGES },
  ];
  assert.equal(findAgent("@fixture/hello", extensions).ref, "@fixture/hello:hello");
  assert.equal(findAgent("@fixture/pages:page", extensions).entry.capability, "pages.agent.run");
  assert.throws(() => findAgent("@fixture/other", extensions), /not among its extensions \(@fixture\/hello, @fixture\/pages\)/);
  assert.throws(() => findAgent("@fixture/pages:nope", extensions), /declares no agent "nope" \(it declares: @fixture\/pages:page\)/);
  assert.throws(() => findAgent("pages", extensions), /is not an agent/);
  assert.deepEqual(declaredAgents(extensions).map((agent) => [agent.ref, agent.kind]), [["@fixture/hello:hello", "capability"], ["@fixture/pages:page", "capability"]]);
});

test("a capability agent entry carries its run id and resume declarations; a profile agent stays a profile", () => {
  const declared = readExtensionAgents(PAGES).agents[0]!;
  assert.deepEqual(declared.runId, { file: "input/page/brief.json", field: "source.page_generation_run_id" });
  assert.deepEqual(declared.resume, { file: "input/page/base-page/index.html", meta: "marshal-page-state" });
  assert.equal(declared.fake, "pages.agent.fake");
  assert.throws(() => resolveAgent(PAGES, "page"), /is a capability agent/);
  const both = extensionPackage("@fixture/both", "0.1.0", { contributes: { agents: [{ id: "x", capability: "a.b", profile: { prompt: "p.md" } }] } });
  assert.throws(() => readExtensionAgents(both), /a profile or a capability, not both/);
  const bad = extensionPackage("@fixture/bad", "0.1.0", { contributes: { agents: [{ id: "x", capability: "a.b", resume: { file: "../up", meta: "m" } }] } });
  assert.throws(() => readExtensionAgents(bad), /portable path/);
});

test("the manifest's agent is checked at init: the report lists every declared agent and the chosen one", async () => {
  const run = caller("@fixture/pages");
  const report = await checkManifest({ manifest: run.manifest, env: {}, pingBrain: false });
  assert.equal(report.ok, true, report.problems.join("; "));
  assert.deepEqual(report.agents.map((agent) => agent.ref), ["@fixture/hello:hello", "@fixture/pages:page"]);
  assert.equal(report.agent?.ref, "@fixture/pages:page");
  assert.equal(report.agent?.capability, "pages.agent.run");
  const overridden = await checkManifest({ manifest: run.manifest, agent: "@fixture/hello", env: {}, pingBrain: false });
  assert.equal(overridden.agent?.ref, "@fixture/hello:hello");
  const none = await checkManifest({ manifest: run.manifest, agent: "none", env: {}, pingBrain: false });
  assert.equal(none.agent, undefined);
  const missing = await checkManifest({ manifest: run.manifest, agent: "@fixture/gone", env: {}, pingBrain: false });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /@fixture\/gone is not among its extensions/);
  assert.throws(() => parseManifest({ version: 1, agent: "page", extensions: [] }), /agent is "@scope\/name"/);
});

test("a dry run's sessions answer from the agent's fake capability", async () => {
  const query = dryQuery(async (prompt) => `dry: ${prompt}`);
  const messages: any[] = [];
  for await (const message of query({ prompt: "plan the page", options: { model: "m", cwd: "/w" } } as never)) messages.push(message);
  assert.deepEqual(messages.map((message) => message.type), ["system", "assistant", "result"]);
  assert.equal(messages[2].result, "dry: plan the page");
});

test("a run's host is what marshal-sdk.json declares: its configuration, the model, the agent and the person", async () => {
  await assert.rejects(declaredHost({ env: {} }), /needs a marshal-sdk\.json/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-host-"));
  const manifest = path.join(root, "marshal-sdk.json");
  const studio = extensionPackage("@acme/pages", "0.3.0", { dependencies: { extensions: [{ id: "@marshal/brain" }] } });
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      defaults: false,
      agent: "@acme/pages",
      model: "claude-opus-5-5",
      reasoningEffort: "xhigh",
      kit: ["brain", "memory"],
      brain: { index: "zyg", auth: "service" },
      extensions: [{ path: studio, configuration: { openaiApiKey: "${env:OPENAI_API_KEY}" } }],
    }),
  );
  await assert.rejects(declaredHost({ manifest, env: { MARSHAL_SDK_BRAIN_PACKAGE: BRAIN_STUB } }), /environment variable OPENAI_API_KEY is not set/);
  const declared = await declaredHost({ manifest, person: "Omer@Zyg.com", env: { OPENAI_API_KEY: "sk-test", MARSHAL_SDK_BRAIN_PACKAGE: BRAIN_STUB } });
  assert.deepEqual(declared.extensions, [{ packageRoot: studio, identity: "@acme/pages", configuration: { openaiApiKey: "sk-test" } }]);
  assert.equal(declared.agent, "@acme/pages");
  assert.equal(declared.model, "claude-opus-5-5");
  assert.equal(declared.effort, "xhigh");
  assert.equal(declared.manifest, manifest);
  assert.deepEqual(declared.kit?.parts, ["brain", "memory"]);
  assert.equal(declared.kit?.brain?.callerMode, "delegated");
  assert.equal(declared.kit?.brain?.callerEmail, "omer@zyg.com");
  const dev = await declaredHost({ extensions: [HELLO], env: {} });
  assert.deepEqual(dev.extensions, [{ packageRoot: HELLO, identity: "@fixture/hello" }], "package folders without a manifest");
});

test("the run's person: --person (Python user=) first, then $MARSHAL_SDK_BRAIN_CALLER, then the manifest's brain.person", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-person-"));
  const manifest = path.join(root, "marshal-sdk.json");
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, defaults: false, kit: ["brain"], brain: { auth: "service", person: "${env:MARSHAL_BRAIN_PERSON}" }, extensions: [{ path: HELLO }] }));
  const env = { MARSHAL_SDK_BRAIN_PACKAGE: BRAIN_STUB, MARSHAL_BRAIN_PERSON: "Fallback@zyg.com" };
  const person = async (given: { person?: string; env: Record<string, string | undefined> }) => (await declaredHost({ manifest, ...given })).kit?.brain?.callerEmail;
  assert.equal(await person({ env }), "fallback@zyg.com");
  assert.equal(await person({ env: { ...env, MARSHAL_SDK_BRAIN_CALLER: "Caller@zyg.com" } }), "caller@zyg.com");
  assert.equal(await person({ person: "User@zyg.com", env: { ...env, MARSHAL_SDK_BRAIN_CALLER: "caller@zyg.com" } }), "user@zyg.com");
  assert.equal(await person({ env: { MARSHAL_SDK_BRAIN_PACKAGE: BRAIN_STUB } }), undefined, "none: the host runs without the Brain and warns");
});

test("Chrome gets --disable-dev-shm-usage on Linux and --no-sandbox when asked, also through the launcher", () => {
  assert.deepEqual(chromeFlags("linux", { MARSHAL_SDK_CHROME_NO_SANDBOX: "1" }), ["--no-sandbox", "--disable-dev-shm-usage"]);
  assert.deepEqual(chromeFlags("linux", {}, 1000), ["--disable-dev-shm-usage"]);
  assert.deepEqual(chromeFlags("linux", {}, 0), ["--no-sandbox", "--disable-dev-shm-usage"], "root on Linux (Coder, E2B) needs no env var");
  assert.deepEqual(chromeFlags("darwin", {}, 0), []);
  assert.deepEqual(chromeFlags("win32", { MARSHAL_SDK_CHROME_NO_SANDBOX: "1" }), []);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-wrapper-"));
  assert.equal(chromeWrapper("/usr/bin/chromium", state, []), "/usr/bin/chromium", "no flags, no wrapper");
  if (process.platform !== "win32") {
    const wrapper = chromeWrapper("/opt/it's/chrome", state, ["--no-sandbox", "--disable-dev-shm-usage"]);
    assert.equal(fs.readFileSync(wrapper, "utf8"), `#!/bin/sh\nexec '/opt/it'\\''s/chrome' --no-sandbox --disable-dev-shm-usage "$@"\n`);
  }
});

test("a browser the host already set is never overridden; only unset variables get the found Chrome and the launcher", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "browser-env-"));
  const flags = ["--no-sandbox", "--disable-dev-shm-usage"];
  const found = "/ms-playwright/chromium/chrome";
  const host = { MARSHAL_SDK_CHROME: "/usr/bin/chromium", MARSHAL_SDK_CHROME_LAUNCHER: "/root/chrome-wrapper.sh" };
  assert.deepEqual(browserEnv(found, state, host, flags), host, "both set: both kept");
  assert.deepEqual(browserEnv(found, state, {}, flags), { MARSHAL_SDK_CHROME: found, MARSHAL_SDK_CHROME_LAUNCHER: path.join(state, "chrome-no-sandbox.sh") });
});

test("writeRunLogs keeps agent-sandbox's RunSummary fields and counts Skill calls against the required skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-logs-"));
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
  assert.deepEqual(summary.skills_used, ["lp-design"]);
  assert.deepEqual(summary.subagent_skills_used, ["lp-review"]);
  assert.deepEqual(summary.skills_missing, ["lp-roles"]);
  assert.equal(summary.results[0]!.final_text, "done");
});

test("a turn on reopened state counts a session it resumed, with only this turn's usage and events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-logs-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "earlier-turn", host: { id: "t", kind: "local" } });
  const hands = store.create({ title: "fast hands", runtime: "claude", model: "haiku", native: { kind: "claude", cwd: root }, labels: {} });
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
  const summary = writeRunLogs({ logDir: path.join(root, "logs"), storeRoot: path.join(root, "sessions"), sessions, started, since: started });
  assert.deepEqual(summary.results.map((result) => result.final_text), ["second"]);
  assert.equal((summary.totals as { total_cost_usd: number }).total_cost_usd, 0.01);
});
