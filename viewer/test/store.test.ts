import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { FileSessionStore } from "../../src/session-store";
import { createExtension } from "../src/index";
import { findStores, searchSessions, summarizeRuns } from "../src/store";

/** Two hosts' stores written by the SDK's own store, the way a run leaves them on disk. */
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-sessions-"));
  const cloud = new FileSessionStore(path.join(root, "cloud", "state", "sessions"), { runId: "run-a", host: { id: "e2b-1", kind: "e2b" } });
  const plan = cloud.create({ title: "Page Studio · plan", runtime: "claude", model: "claude-sonnet-5-5", native: { kind: "claude", sessionId: "n1", cwd: "/ws" }, labels: { page: "rawdog" } });
  cloud.appendMessage(plan.id, { role: "user", content: "Plan the eye cream page" });
  cloud.appendMessage(plan.id, { role: "assistant", content: "Hero, proof, buy box" });
  cloud.addUsage(plan.id, { outputTokens: 100, costUsd: 0.25, turns: 1 });
  cloud.update(plan.id, { state: "idle" });
  const writer = cloud.create({ title: "Page Studio · hero", runtime: "claude", native: { kind: "claude", cwd: "/ws" }, parentId: plan.id });
  cloud.appendMessage(writer.id, { role: "user", content: "Write the hero section" });
  const local = new FileSessionStore(path.join(root, "local", "state", "sessions"), { runId: "run-b", host: { id: "mac", kind: "local" } });
  local.update(local.create({ title: "Smoke", runtime: "claude", native: { kind: "claude", cwd: "/ws" } }).id, { state: "failed" });
  return root;
}

test("finds every store under a root and summarizes its runs", () => {
  const root = fixture();
  const stores = findStores([root]);
  assert.equal(stores.length, 2);
  const runs = summarizeRuns(stores);
  const cloud = runs.find((run) => run.runId === "run-a")!;
  assert.equal(cloud.sessions, 2);
  assert.equal(cloud.running, 1);
  assert.equal(cloud.costUsd, 0.25);
  assert.deepEqual(cloud.host, { id: "e2b-1", kind: "e2b" });
  assert.equal(cloud.firstTitle, "Page Studio · plan");
  assert.equal(runs.find((run) => run.runId === "run-b")!.failed, 1);
});

test("search scores titles, labels and transcripts", () => {
  const root = fixture();
  const hits = searchSessions(findStores([root]), "rawdog buy", 10);
  assert.equal(hits[0]!.session.title, "Page Studio · plan");
  assert.match(hits[0]!.snippet, /buy box/i);
});

test("capabilities answer through the provider with the result envelope", async () => {
  const root = fixture();
  const extension = createExtension({ configuration: { roots: [root] } });
  const provider = extension.capabilityProviders[0]!;
  const runs = (await provider.invoke("sdksessions.runs", {}, {})) as { output: { result: any } };
  assert.equal(runs.output.result.runs.length, 2);
  const sessions = (await provider.invoke("sdksessions.sessions", { runId: "run-a" }, {})) as { output: { result: any } };
  assert.equal(sessions.output.result.sessions.length, 2);
  const child = sessions.output.result.sessions.find((session: any) => session.parentId);
  assert.ok(child);
  const transcript = (await provider.invoke("sdksessions.transcript", { sessionId: child.parentId }, {})) as { output: { result: any } };
  assert.equal(transcript.output.result.found, true);
  assert.deepEqual(
    transcript.output.result.messages.map((message: any) => message.role),
    ["user", "assistant"],
  );
  const missing = (await provider.invoke("sdksessions.transcript", { sessionId: "../../etc" }, {})) as { output: { result: any } };
  assert.equal(missing.output.result.found, false);
  assert.equal(extension.uiApplications[0]!.metadata["marshal.ui.viewports"].length, 2);
});

/** One idle session whose Claude file sits where Claude keeps it, and a host that answers importNative as told. */
function continueRig(answer: (request: Record<string, any>) => { status: string; error?: { code?: string; message?: string }; result?: { output?: any } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-continue-"));
  const configDir = path.join(root, "account");
  const store = new FileSessionStore(path.join(root, "run", "state", "sessions"), { runId: "run-c", host: { id: "e2b", kind: "e2b" } });
  const session = store.create({ title: "Page Studio · hero", runtime: "claude", native: { kind: "claude", sessionId: "native-9", cwd: "/sandbox/ws", configDir } });
  store.update(session.id, { state: "idle" });
  const file = path.join(configDir, "projects", "-sandbox-ws", "native-9.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"user","sessionId":"native-9"}\n');
  const requests: Record<string, any>[] = [];
  const extension = createExtension({
    configuration: { roots: [root] },
    execute: async (request) => {
      requests.push(request);
      return answer(request);
    },
  });
  const run = async (sessionId = session.id) =>
    ((await extension.capabilityProviders[0]!.invoke("sdksessions.continue", { sessionId }, {})) as { output: { result: any } }).output.result;
  return { store, session, run, requests };
}

test("continue says plainly when this Marshal has no importNative yet", async () => {
  const rig = continueRig(() => ({ status: "error", error: { code: "not-found", message: 'Capability "marshal.sessions.importNative" was not found.' } }));
  const result = await rig.run();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.match(result.message, /can't continue a session yet.*pull\/155/);
});

test("continue sends the Claude file gzipped to importNative and reports the new session", async () => {
  const rig = continueRig(() => ({ status: "success", result: { output: { ok: true, sessionId: "local-7" } } }));
  const result = await rig.run();
  assert.deepEqual(result, { ok: true, sessionId: "local-7", message: "Opened as a new session in Marshal." });
  const sent = rig.requests[0]!;
  assert.equal(sent.target, "marshal.sessions.importNative");
  assert.equal(sent.input.name, "Page Studio · hero");
  assert.equal(sent.input.state.format, "claude-jsonl");
  assert.equal(sent.input.state.encoding, "gzip-base64");
  assert.equal(zlib.gunzipSync(Buffer.from(sent.input.state.data, "base64")).toString("utf8"), '{"type":"user","sessionId":"native-9"}\n');
});

test("continue explains refusals, approvals, running sessions and missing files without calling twice", async () => {
  const refused = continueRig(() => ({ status: "success", result: { output: { ok: false, error: "runtime-unavailable" } } }));
  assert.match((await refused.run()).message, /Claude runtime isn't set up/);
  const approval = continueRig(() => ({ status: "error", error: { code: "approval-required", message: "needs approval" } }));
  assert.equal((await approval.run()).reason, "approval");
  const running = continueRig(() => ({ status: "success", result: { output: { ok: true, sessionId: "x" } } }));
  running.store.update(running.session.id, { state: "running" });
  assert.equal((await running.run()).reason, "running");
  const missing = continueRig(() => ({ status: "success", result: { output: { ok: true, sessionId: "x" } } }));
  missing.store.update(missing.session.id, { native: { kind: "claude", sessionId: "gone", cwd: "/sandbox/ws", configDir: "/nowhere" } });
  assert.equal((await missing.run()).reason, "no-native-state");
  assert.equal(running.requests.length + missing.requests.length, 0);
});

const LINK_TOKEN = "viewer-link-token-0123456789";

/** The fixture's cloud store served over a real link (store-only), with an output folder, and the extension pointed at it. */
async function linkedRig() {
  const { startLinkServer } = await import("../../src/link/server");
  const root = fixture();
  const out = path.join(root, "cloud", "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "page.html"), "<h1>Rawdog</h1>");
  const nativeRoot = path.join(root, "claude");
  const nativeFile = path.join(nativeRoot, "projects", "-ws", "n1.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.writeFileSync(nativeFile, '{"type":"user","sessionId":"n1"}\n');
  const server = await startLinkServer({
    token: LINK_TOKEN,
    sessionsRoot: path.join(root, "cloud", "state", "sessions"),
    host: { id: "e2b-1", kind: "e2b" },
    files: { output: out },
    nativeRoots: [nativeRoot],
  });
  const requests: Record<string, any>[] = [];
  const pullRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-pulled-"));
  const extension = createExtension({
    configuration: {
      roots: [path.join(root, "local")],
      pullRoot,
      hosts: [
        { id: "cloud", name: "Cloud sandbox", url: server.url, token: LINK_TOKEN },
        { id: "gone", url: "http://127.0.0.1:9", token: "unreachable-host-token-000" },
        { id: "Bad Id", url: server.url, token: LINK_TOKEN },
      ],
    },
    execute: async (request) => {
      requests.push(request);
      return { status: "success", result: { output: { ok: true, sessionId: "local-9" } } };
    },
  });
  const call = async (name: string, input: Record<string, unknown>) =>
    ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;
  return { root, server, call, requests, pullRoot, nativeFile };
}

test("linked hosts: listed with a redacted token, browsed like folders, and offline hosts say so", async () => {
  const rig = await linkedRig();
  try {
    const listed = await rig.call("sdksessions.hosts", {});
    assert.ok(!JSON.stringify(listed).includes(LINK_TOKEN), "the token never leaves the extension");
    const cloud = listed.hosts.find((host: any) => host.id === "cloud");
    assert.equal(cloud.status, "online");
    assert.equal(cloud.mode, "store");
    assert.equal(cloud.token, "••••6789");
    assert.deepEqual(cloud.remote, { id: "e2b-1", kind: "e2b" });
    assert.equal(listed.hosts.find((host: any) => host.id === "gone").status, "offline");
    assert.equal(listed.hosts[0].id, "local");
    assert.equal(listed.problems.length, 1);

    const runs = await rig.call("sdksessions.runs", { hostId: "cloud" });
    assert.deepEqual(runs.runs.map((run: any) => [run.hostId, run.runId]), [["cloud", "run-a"]]);
    const everywhere = await rig.call("sdksessions.runs", {});
    assert.deepEqual(everywhere.runs.map((run: any) => run.hostId).sort(), ["cloud", "local"]);
    assert.equal(everywhere.problems[0].hostId, "gone");
    const sessions = await rig.call("sdksessions.sessions", { hostId: "cloud", runId: "run-a" });
    const plan = sessions.sessions.find((session: any) => !session.parentId);
    const transcript = await rig.call("sdksessions.transcript", { hostId: "cloud", sessionId: plan.id, since: 1 });
    assert.deepEqual(transcript.messages.map((message: any) => message.content), ["Hero, proof, buy box"]);
    const telemetry = await rig.call("sdksessions.telemetry", { hostId: "cloud", runId: "run-a" });
    assert.equal(telemetry.telemetry.sessions, 2);
    const files = await rig.call("sdksessions.files", { hostId: "cloud", root: "output" });
    assert.deepEqual(files.entries.map((entry: any) => entry.name), ["page.html"]);
    assert.equal((await rig.call("sdksessions.files", { hostId: "cloud", root: "output", path: "page.html", read: true })).content, "<h1>Rawdog</h1>");
    const escaped = await rig.call("sdksessions.files", { hostId: "cloud", root: "output", path: "../state/sessions/index.json", read: true });
    assert.equal(escaped.ok, false);
    const sent = await rig.call("sdksessions.send", { hostId: "cloud", sessionId: plan.id, text: "more" });
    assert.deepEqual([sent.ok, sent.reason], [false, "store-only"]);
    const unknown = await rig.call("sdksessions.runs", { hostId: "nope" });
    assert.match(unknown.error, /No host "nope"/);
    const hits = await rig.call("sdksessions.search", { query: "rawdog" });
    assert.ok(hits.hits.some((hit: any) => hit.hostId === "cloud"));
  } finally {
    await rig.server.close();
  }
});

test("a linked session continues in Marshal from the host's conversation file, and pulls to this Mac", async () => {
  const rig = await linkedRig();
  try {
    const sessions = await rig.call("sdksessions.sessions", { hostId: "cloud", runId: "run-a" });
    const plan = sessions.sessions.find((session: any) => !session.parentId);
    const continued = await rig.call("sdksessions.continue", { hostId: "cloud", sessionId: plan.id });
    assert.deepEqual(continued, { ok: true, sessionId: "local-9", message: "Opened as a new session in Marshal." });
    const state = rig.requests[0]!.input.state;
    assert.equal(zlib.gunzipSync(Buffer.from(state.data, "base64")).toString("utf8"), fs.readFileSync(rig.nativeFile, "utf8"));
    const writer = sessions.sessions.find((session: any) => session.parentId);
    assert.equal((await rig.call("sdksessions.continue", { hostId: "cloud", sessionId: writer.id })).reason, "running");

    const pulled = await rig.call("sdksessions.pull", { hostId: "cloud", runId: "run-a" });
    assert.equal(pulled.ok, true);
    assert.deepEqual([pulled.sessions, pulled.messages, pulled.native], [2, 3, 1]);
    const localRuns = (await rig.call("sdksessions.runs", { hostId: "local", roots: [rig.pullRoot] })).runs;
    assert.deepEqual(localRuns.map((run: any) => run.runId), ["run-a"]);
    const local = (await rig.call("sdksessions.sessions", { hostId: "local", runId: "run-a", roots: [rig.pullRoot] })).sessions;
    assert.equal(local.find((session: any) => session.id === plan.id).labels.pulledFrom, "cloud");
    const offline = await rig.call("sdksessions.continue", { hostId: "local", sessionId: plan.id, roots: [rig.pullRoot] });
    assert.equal(offline.ok, true, "the pulled copy carries its conversation file");
  } finally {
    await rig.server.close();
  }
});

test("watch returns as soon as a linked session writes, with what the backend did", async () => {
  const rig = await linkedRig();
  try {
    const sessions = await rig.call("sdksessions.sessions", { hostId: "cloud", runId: "run-a" });
    const writer = sessions.sessions.find((session: any) => session.parentId);
    const store = new FileSessionStore(path.join(rig.root, "cloud", "state", "sessions"), { runId: "run-a", host: { id: "e2b-1", kind: "e2b" } });
    const started = Date.now();
    const waiting = rig.call("sdksessions.watch", { hostId: "cloud", sessionId: writer.id, since: 1, eventCursor: 0, waitMs: 8000 });
    setTimeout(() => {
      store.appendEvent(writer.id, { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", id: "t", input: {} }] } });
      store.appendMessage(writer.id, { role: "assistant", content: "hero.html written" });
    }, 300);
    const out = await waiting;
    assert.ok(Date.now() - started < 6000);
    assert.deepEqual(out.messages.map((message: any) => message.content), ["hero.html written"]);
    assert.ok(out.activity.some((activity: any) => activity.kind === "tool" && activity.name === "Write"));
    assert.ok(out.eventCursor > 0);
  } finally {
    await rig.server.close();
  }
});
