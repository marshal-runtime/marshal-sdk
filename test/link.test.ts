import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { LinkClient, LinkError } from "../src/link/client.js";
import { startLinkServer, type LinkServer } from "../src/link/server.js";
import { FileSessionStore } from "../src/session-store.js";

const TOKEN = "test-token-0123456789abcdef";

interface Rig {
  root: string;
  store: FileSessionStore;
  server: LinkServer;
  client: LinkClient;
  ids: { plan: string; hero: string };
  nativeFile: string;
}

/** A finished run on disk (two sessions, events with tools and results, a Claude file) served store-only. */
async function storeRig(): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-"));
  const configDir = path.join(root, "claude");
  const store = new FileSessionStore(path.join(root, "state", "sessions"), { runId: "run-1", host: { id: "e2b-7", kind: "e2b" } });
  const plan = store.create({ title: "Page Studio · plan", runtime: "claude", model: "claude-haiku-5-5", native: { kind: "claude", sessionId: "native-plan", cwd: "/sandbox/ws", configDir }, labels: { page: "rawdog" } });
  store.appendMessage(plan.id, { role: "user", content: "Plan the eye cream page" });
  store.appendMessage(plan.id, { role: "assistant", content: "Hero, proof, buy box" });
  store.appendEvent(plan.id, { type: "system", subtype: "init", session_id: "native-plan" });
  store.appendEvent(plan.id, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t1", input: {} }, { type: "tool_use", name: "Read", id: "t2", input: {} }] } });
  store.appendEvent(plan.id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit 1" }] } });
  store.appendEvent(plan.id, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "t3", input: {} }] } });
  store.appendEvent(plan.id, {
    type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 4000, total_cost_usd: 0.02,
    usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    modelUsage: { "claude-haiku-5-5": { costUSD: 0.02, outputTokens: 200 } },
  });
  store.update(plan.id, { state: "idle" });
  const hero = store.create({ title: "Page Studio · hero", runtime: "claude", native: { kind: "claude", cwd: "/sandbox/ws" }, parentId: plan.id });
  store.appendEvent(hero.id, { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, duration_ms: 1000, total_cost_usd: 0.01, usage: { output_tokens: 5 } });
  const nativeFile = path.join(configDir, "projects", "-sandbox-ws", "native-plan.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.writeFileSync(nativeFile, '{"type":"user","sessionId":"native-plan"}\n');
  const out = path.join(root, "out");
  fs.mkdirSync(path.join(out, "shots"), { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), '{"ok":true}');
  fs.writeFileSync(path.join(out, "big.txt"), "x".repeat(5000));
  fs.writeFileSync(path.join(out, "shots", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  fs.writeFileSync(path.join(root, "secret.txt"), "outside");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(out, "escape.txt"));
  const server = await startLinkServer({
    token: TOKEN,
    port: 0,
    sessionsRoot: store.root,
    host: { id: "e2b-7", kind: "e2b" },
    files: { output: out },
    maxFileBytes: 1000,
  });
  return { root, store, server, client: new LinkClient({ url: server.url, token: TOKEN }), ids: { plan: plan.id, hero: hero.id }, nativeFile };
}

async function rejects(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LinkError, String(error));
    assert.equal(error.status, status, `${error.code}: ${error.message}`);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("the link refuses to start without a token, and every request needs it", async () => {
  await assert.rejects(startLinkServer({ token: "", sessionsRoot: os.tmpdir(), host: { id: "x", kind: "local" } }), /token/);
  await assert.rejects(startLinkServer({ token: "short", sessionsRoot: os.tmpdir(), host: { id: "x", kind: "local" } }), /16 characters/);
  const rig = await storeRig();
  try {
    await rejects(new LinkClient({ url: rig.server.url, token: "wrong-token-0123456789" }).info(), 401, "unauthorized");
    await rejects(new LinkClient({ url: rig.server.url, token: `${TOKEN}x` }).runs(), 401);
  } finally {
    await rig.server.close();
  }
});

test("store-only: info, runs, sessions with filters, search and transcript pages", async () => {
  const rig = await storeRig();
  try {
    const info = await rig.client.info();
    assert.equal(info.mode, "store");
    assert.deepEqual(info.host, { id: "e2b-7", kind: "e2b" });
    assert.deepEqual(info.runs, ["run-1"]);
    assert.deepEqual(info.files, ["output"]);
    assert.match(info.sdkVersion, /^\d+\.\d+\.\d+/);
    const { runs } = await rig.client.runs();
    assert.equal(runs[0].sessions, 2);
    assert.equal(runs[0].running, 1);
    assert.equal((await rig.client.sessions({ runId: "run-1", state: "idle" })).sessions.length, 1);
    assert.equal((await rig.client.sessions({ labels: { page: "rawdog" } })).sessions[0].id, rig.ids.plan);
    assert.equal((await rig.client.sessions({ parentId: rig.ids.plan })).sessions[0].id, rig.ids.hero);
    const { hits } = await rig.client.sessions({ q: "buy box" });
    assert.equal(hits[0].session.id, rig.ids.plan);
    const page = await rig.client.transcript(rig.ids.plan, { since: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.cursor, 2);
    assert.deepEqual(page.messages.map((message: any) => [message.index, message.role]), [[1, "assistant"]]);
    assert.equal((await rig.client.transcript(rig.ids.plan, { tail: 1 })).messages[0].content, "Hero, proof, buy box");
    await rejects(rig.client.session("../../etc"), 404, "not-found");
    await rejects(rig.client.send(rig.ids.plan, "more"), 409, "store-only");
    await rejects(rig.client.invoke("marshal.agent.list"), 409, "store-only");
  } finally {
    await rig.server.close();
  }
});

test("telemetry per session and per run comes from events.jsonl", async () => {
  const rig = await storeRig();
  try {
    const { telemetry } = await rig.client.sessionTelemetry(rig.ids.plan);
    assert.deepEqual(telemetry.toolCalls, { Bash: 2, Read: 1 });
    assert.equal(telemetry.toolErrors, 1);
    assert.equal(telemetry.turns, 1);
    assert.equal(telemetry.modelRoundTrips, 3);
    assert.deepEqual(telemetry.tokens, { input: 10, output: 200, cacheRead: 1000, cacheWrite: 50 });
    assert.equal(telemetry.turnDurations.medianMs, 4000);
    assert.equal(telemetry.models["claude-haiku-5-5"].outputTokens, 200);
    const run = await rig.client.runTelemetry("run-1");
    assert.equal(run.telemetry.sessions, 2);
    assert.equal(run.telemetry.turns, 2);
    assert.ok(Math.abs(run.telemetry.costUsd - 0.03) < 1e-9);
    assert.equal(run.telemetry.errors.count, 1);
    assert.equal(run.telemetry.turnDurations.maxMs, 4000);
    assert.equal(run.sessions.find((session: any) => session.id === rig.ids.hero).errors, 1);
    await rejects(rig.client.runTelemetry("nope"), 404);
  } finally {
    await rig.server.close();
  }
});

test("files are bounded, typed, and never reach outside their root", async () => {
  const rig = await storeRig();
  try {
    const listing = await rig.client.files("output");
    assert.deepEqual(listing.entries.map((entry: any) => [entry.name, entry.type]), [["shots", "directory"], ["big.txt", "file"], ["escape.txt", "other"], ["summary.json", "file"]]);
    assert.equal((await rig.client.readFile("output", "summary.json")).content, '{"ok":true}');
    const big = await rig.client.readFile("output", "big.txt");
    assert.equal(big.truncated, true);
    assert.equal(big.content.length, 1000);
    assert.equal(big.size, 5000);
    assert.equal((await rig.client.readFile("output", "shots/a.png")).encoding, "base64");
    await rejects(rig.client.readFile("output", "escape.txt"), 403, "outside-root");
    await rejects(rig.client.readFile("output", "../secret.txt"), 404);
    assert.equal((await rig.client.files("output", "../../..")).path, "", "climbing above the root stops at the root");
    await rejects(rig.client.files("workspace"), 404, "unknown-root");
  } finally {
    await rig.server.close();
  }
});

test("native export is the envelope importNative takes, and waits for a running session", async () => {
  const rig = await storeRig();
  try {
    const envelope = await rig.client.native(rig.ids.plan);
    assert.equal(envelope.state.format, "claude-jsonl");
    assert.equal(envelope.state.encoding, "gzip-base64");
    assert.equal(gunzipSync(Buffer.from(envelope.state.data, "base64")).toString("utf8"), fs.readFileSync(rig.nativeFile, "utf8"));
    assert.equal(envelope.bytes, fs.statSync(rig.nativeFile).size);
    await rejects(rig.client.native(rig.ids.hero), 409, "running");
    rig.store.update(rig.ids.hero, { state: "idle" });
    await rejects(rig.client.native(rig.ids.hero), 404, "no-native-state");
  } finally {
    await rig.server.close();
  }
});

test("a long poll and the session and run streams see new messages as they are written", async () => {
  const rig = await storeRig();
  try {
    const before = Date.now();
    const polled = rig.client.transcript(rig.ids.hero, { since: 0, waitMs: 5000 });
    setTimeout(() => rig.store.appendMessage(rig.ids.hero, { role: "user", content: "Write the hero" }), 300);
    const page = await polled;
    assert.equal(page.messages[0].content, "Write the hero");
    assert.ok(Date.now() - before < 4000);

    const sessionEvents: [string, any][] = [];
    const runEvents: [string, any][] = [];
    const sessionStream = rig.client.stream(`sessions/${rig.ids.hero}/stream`, (event, data) => sessionEvents.push([event, data]));
    const runStream = rig.client.stream("runs/run-1/stream", (event, data) => runEvents.push([event, data]));
    await new Promise((resolve) => setTimeout(resolve, 600));
    rig.store.appendEvent(rig.ids.hero, { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", id: "t9", input: {} }] } });
    rig.store.appendMessage(rig.ids.hero, { role: "assistant", content: "Done: hero.html" });
    rig.store.update(rig.ids.hero, { state: "idle" });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(sessionEvents.some(([event, data]) => event === "session" && data.state === "idle") && runEvents.some(([event]) => event === "message"))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    sessionStream.close();
    runStream.close();
    const messages = sessionEvents.filter(([event]) => event === "message").map(([, data]) => data.content);
    assert.deepEqual(messages, ["Done: hero.html"], "the stream starts at the end unless asked for history");
    assert.ok(sessionEvents.some(([event, data]) => event === "activity" && data.kind === "tool" && data.name === "Write"));
    assert.ok(sessionEvents.some(([event, data]) => event === "session" && data.state === "idle"));
    const runMessage = runEvents.find(([event]) => event === "message")![1];
    assert.equal(runMessage.sessionId, rig.ids.hero);
    assert.equal(runMessage.content, "Done: hero.html");
    assert.equal(runMessage.index, 1);
  } finally {
    await rig.server.close();
  }
});

/** A Claude backend stand-in: answers "echo: <prompt>" and reports a result with usage. */
function echoBackend(): QueryFn {
  let sessions = 0;
  return ({ prompt, options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${++sessions}` };
      await new Promise((resolve) => setTimeout(resolve, 150));
      const answer = `echo: ${String(prompt)}`;
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: answer }] } };
      yield { type: "result", subtype: "success", is_error: false, result: answer, num_turns: 1, duration_ms: 150, total_cost_usd: 0.001, usage: { input_tokens: 3, output_tokens: 4 } };
    })();
}

test("a live host serves its sessions and takes messages, cancels and capability calls over the link", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-live-"));
  fs.mkdirSync(path.join(root, "ws"));
  fs.writeFileSync(path.join(root, "ws", "notes.md"), "# notes");
  await assert.rejects(
    createMarshalHost({ workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state"), browser: false, query: echoBackend(), link: { token: "short" } }),
    /16 characters/,
  );
  const host = await createMarshalHost({
    workspacePath: path.join(root, "ws"),
    stateRoot: path.join(root, "state"),
    browser: false,
    query: echoBackend(),
    host: { id: "mac", kind: "local" },
    link: { token: TOKEN, port: 0 },
  });
  try {
    assert.ok(host.link);
    const client = new LinkClient({ url: host.link.url, token: TOKEN });
    const info = await client.info();
    assert.equal(info.mode, "live");
    assert.deepEqual(info.files, ["workspace"]);
    assert.ok(info.capabilities.includes("marshal.agent.launch"), info.capabilities.join(","));
    assert.equal((await client.readFile("workspace", "notes.md")).content, "# notes");

    const agent = host.agents.launch({ task: "first", idempotencyKey: "k1" });
    await host.agents.wait(agent.id);
    const accepted = await client.send(agent.id, "second");
    assert.equal(accepted.accepted, true);
    const page = await client.transcript(agent.id, { since: 2, waitMs: 5000 });
    assert.equal(page.messages[0].content, "second");
    await host.agents.wait(agent.id);
    const all = await client.transcript(agent.id);
    assert.deepEqual(all.messages.map((message: any) => message.content), ["first", "echo: first", "second", "echo: second"]);
    assert.equal(all.session.native.sessionId, "native-1", "the follow-up resumed the same conversation");
    assert.equal((await client.sessionTelemetry(agent.id)).telemetry.turns, 2);
    assert.equal((await client.cancel(agent.id)).agent.id, agent.id);

    const listed = await client.invoke("marshal.agent.list", {});
    assert.ok(JSON.stringify(listed.output).includes(agent.id));
    await assert.rejects(client.invoke("no.such.capability", {}), (error: unknown) => error instanceof LinkError && error.status === 500);
  } finally {
    await host.dispose();
  }
});

test("a session stored by an earlier run of the host resumes when a message arrives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "link-adopt-"));
  fs.mkdirSync(path.join(root, "ws"));
  const options = { workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state"), browser: false, query: echoBackend() };
  const first = await createMarshalHost(options);
  const agent = first.agents.launch({ task: "remember 7", idempotencyKey: "a" });
  await first.agents.wait(agent.id);
  await first.dispose();
  const second = await createMarshalHost({ ...options, link: { token: TOKEN } });
  try {
    const client = new LinkClient({ url: second.link!.url, token: TOKEN });
    await client.send(agent.id, "what number?");
    await second.agents.wait(agent.id);
    const { messages, session } = await client.transcript(agent.id);
    assert.deepEqual(messages.map((message: any) => message.content).slice(-2), ["what number?", "echo: what number?"]);
    assert.equal(session.state, "idle");
  } finally {
    await second.dispose();
  }
});
