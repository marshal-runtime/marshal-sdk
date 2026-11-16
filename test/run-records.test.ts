import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMarshalHost } from "../src/host.js";
import {
  buildRun,
  directoryRunSink,
  gcsRunSink,
  labelRunGrouping,
  RunRecordsPublisher,
  type RunRecordSink,
} from "../src/run-records.js";
import { FileSessionStore } from "../src/session-store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-records-"));
  return { root, store: new FileSessionStore(path.join(root, "sessions"), { runId: "pod-1", host: { id: "marley-agent-server-0", kind: "service" } }) };
}

/** A Marley-like conversation: a front session and one worker fork, with tool use, a secret and a local path in the text. */
function marleyChat(store: FileSessionStore, brand: string, conversation: string, cwd = "/srv/brands/b1/work") {
  const front = store.create({
    title: "DM with the owner",
    runtime: "claude",
    model: "claude-sonnet-5-5",
    native: { kind: "claude", cwd, sessionId: `native-${conversation}` },
    labels: { procedure: "marley-chat", brand, brandName: `Brand ${brand}`, conversation, channel: "whatsapp", kind: "dm", role: "front" },
  });
  store.appendMessage(front.id, { role: "user", content: "how were sales yesterday?" });
  store.appendEvent(front.id, { type: "system", subtype: "init", session_id: `native-${conversation}` });
  store.appendEvent(front.id, { type: "user", message: { role: "user", content: [{ type: "text", text: "how were sales yesterday?" }] } });
  store.appendEvent(front.id, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: `checking ${cwd}/orders.csv` }, { type: "tool_use", id: "t1", name: "mcp__marshal__runtime_exec", input: { target: "zs.data.query" } }] },
  });
  store.appendEvent(front.id, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "timeout" }] } });
  store.appendEvent(front.id, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Yesterday: 41 orders. key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD" }] } });
  store.appendEvent(front.id, { type: "result", subtype: "success", result: "Yesterday: 41 orders." });
  store.appendMessage(front.id, { role: "assistant", content: "Yesterday: 41 orders." });
  store.update(front.id, { state: "idle", usage: { ...store.get(front.id)!.usage, costUsd: 0.12, turns: 1 } });
  const worker = store.create({
    title: "worker: weekly report",
    runtime: "claude",
    native: { kind: "claude", cwd, sessionId: `native-${conversation}-w` },
    parentId: front.id,
    labels: { role: "worker", brand, conversation },
  });
  store.appendMessage(worker.id, { role: "user", content: "build the weekly report" });
  store.appendEvent(worker.id, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "report ready" }] } });
  store.appendMessage(worker.id, { role: "assistant", content: "report ready" });
  store.update(worker.id, { state: "idle", usage: { ...store.get(worker.id)!.usage, costUsd: 0.3, turns: 2 } });
  return { front: store.get(front.id)!, worker: store.get(worker.id)! };
}

test("buildRun writes the run index's format: summary, record and one stream per session, grouped by procedure with the brand as a chat link", () => {
  const { store } = tempStore();
  const { front } = marleyChat(store, "brand-a", "conv-1");
  const group = labelRunGrouping({ titlePrefix: "Marley" })(front)!;
  assert.equal(group.workflow, "marley-chat");
  assert.deepEqual(group.links, [{ kind: "chat", key: "brand-a:conv-1", role: "origin" }]);
  assert.equal(group.title, "Marley · Brand brand-a · whatsapp · dm · DM with the owner");

  const run = buildRun(store, front, group);
  const day = front.createdAt.slice(0, 10);
  assert.match(run.runId, new RegExp(`^${day}-marley-chat-[0-9a-f]{12}$`));
  assert.equal(buildRun(store, front, group).runId, run.runId, "the id is stable across publishes");

  const names = run.files.map((file) => file.name);
  assert.deepEqual(names.slice(-2), ["record.jsonl", "summary.json"], "the summary is written last");
  const s = run.summary;
  assert.equal(s.version, 1);
  assert.equal(s.runId, run.runId);
  assert.equal(s.workflow, "marley-chat");
  assert.equal(s.source, "chat");
  assert.equal(s.status, "succeeded");
  assert.equal(s.costUsd, 0.42);
  assert.equal(s.user, undefined, "no requester: only the workspace's auditors read it");
  assert.deepEqual(s.sessions.map((session) => [session.role, session.status, session.toolCalls, session.toolErrors]), [
    ["front", "succeeded", 1, 1],
    ["worker", "succeeded", 0, 0],
  ]);
  assert.equal(s.sessions[0]!.conversation, "conv-1");
  assert.equal(s.sessions[0]!.sessionId, "native-conv-1");
  assert.deepEqual(s.counts, { events: 7, toolCalls: 1, toolErrors: 1, evidenceCalls: 0, publications: 0, failedPublications: 0 });

  const stream = run.files.find((file) => file.name === `sessions/${s.sessions[0]!.session}.jsonl`)!;
  const lines = String(stream.body).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.type), ["user", "assistant", "user", "assistant"], "only the conversation lines, no system or result");
  const text = String(stream.body);
  assert.doesNotMatch(text, /sk-ant-api03/, "secrets are scrubbed");
  assert.doesNotMatch(text, /\/srv\/brands\/b1\/work/, "the session's working folder is scrubbed");

  const record = String(run.files.find((file) => file.name === "record.jsonl")!.body).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(record.map((event) => event.type), ["run_started", "session_started", "session_finished", "session_started", "session_finished", "run_finished"]);
  assert.equal(record[1].task, "how were sales yesterday?");
  assert.equal(record[2].output, "Yesterday: 41 orders.");
  assert.equal(run.files.some((file) => file.name.endsWith(".claude.jsonl")), false, "no envelope unless asked");
});

test("a run with a session still running is running, has no finish and no session_finished for it", () => {
  const { store } = tempStore();
  const { front } = marleyChat(store, "brand-a", "conv-2");
  store.update(front.id, { state: "running" });
  const run = buildRun(store, store.get(front.id)!, labelRunGrouping()(front)!);
  assert.equal(run.summary.status, "running");
  assert.equal(run.summary.finishedAt, undefined);
  assert.equal(run.summary.sessions[0]!.finishedAt, undefined);
});

test("envelopes: the native Claude transcript goes beside the stream only when asked", () => {
  const { store } = tempStore();
  const { front } = marleyChat(store, "brand-a", "conv-3");
  const run = buildRun(store, front, labelRunGrouping()(front)!, { envelopes: true, nativeState: (record) => new TextEncoder().encode(`{"native":"${record.native.sessionId}"}\n`) });
  const envelopes = run.files.filter((file) => file.name.endsWith(".claude.jsonl"));
  assert.equal(envelopes.length, 2);
});

test("the publisher writes only allowed runs, republishes the whole run when a fork goes idle, and never throws", async () => {
  const { root, store } = tempStore();
  const a = marleyChat(store, "brand-a", "conv-a");
  const b = marleyChat(store, "brand-b", "conv-b");
  const unlabeled = store.create({ title: "no procedure", runtime: "claude", native: { kind: "claude", cwd: "/w" }, labels: { brand: "brand-a" } });

  const out = path.join(root, "records");
  const lines: string[] = [];
  const nothing = new RunRecordsPublisher({ store, sink: directoryRunSink(out), log: (line) => lines.push(line) });
  nothing.schedule(a.front.id);
  await nothing.flush();
  assert.equal(fs.existsSync(out), false, "no allow rule: nothing leaves the host");

  const publisher = new RunRecordsPublisher({ store, sink: directoryRunSink(out), allow: (rootSession) => rootSession.labels.brand === "brand-a", log: (line) => lines.push(line) });
  publisher.schedule(a.worker.id);
  publisher.schedule(b.front.id);
  publisher.schedule(unlabeled.id);
  await publisher.flush();
  const runs = fs.readdirSync(path.join(out, "runs"));
  assert.equal(runs.length, 1, "brand-b is not allowed; an unlabeled session has no run");
  const summary = JSON.parse(fs.readFileSync(path.join(out, "runs", runs[0]!, "summary.json"), "utf8"));
  assert.equal(summary.sessions.length, 2, "a fork going idle publishes its root's whole run");
  assert.deepEqual(summary.links, [{ kind: "chat", key: "brand-a:conv-a", role: "origin" }]);
  assert.equal(Object.values(publisher.status())[0]!.runId, runs[0]);

  const failing: RunRecordSink = { put: async () => { throw new Error("bucket down"); } };
  const broken = new RunRecordsPublisher({ store, sink: failing, allow: () => true, log: (line) => lines.push(line) });
  broken.schedule(a.front.id);
  await broken.flush();
  assert.ok(lines.some((line) => line.includes("to the run records failed: bucket down")), lines.join("\n"));
});

test("a turn that ends during an upload queues exactly one more upload of the run", async () => {
  const { store } = tempStore();
  const a = marleyChat(store, "brand-a", "conv-q");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const puts: string[] = [];
  const sink: RunRecordSink = {
    put: async (name) => {
      puts.push(name);
      await gate;
    },
  };
  const publisher = new RunRecordsPublisher({ store, sink, allow: () => true });
  publisher.schedule(a.front.id);
  publisher.schedule(a.worker.id);
  publisher.schedule(a.front.id);
  await sleep(10);
  release();
  await publisher.flush();
  const summaries = puts.filter((name) => name.endsWith("/summary.json"));
  assert.equal(summaries.length, 2);
});

test("gcsRunSink uploads over the JSON API with the host's token and never puts the token in an error", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const sink = gcsRunSink({
    bucket: "zyg-records",
    accessToken: async () => "TOKEN-123",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: calls.length === 1 ? 200 : 403 });
    }) as typeof fetch,
  });
  await sink.put("runs/2026-11-16-marley-chat-abc/summary.json", "{}", "application/json");
  assert.equal(calls[0]!.url, "https://storage.googleapis.com/upload/storage/v1/b/zyg-records/o?uploadType=media&name=runs%2F2026-11-16-marley-chat-abc%2Fsummary.json");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer TOKEN-123");
  await assert.rejects(sink.put("runs/x/summary.json", "{}", "application/json"), (error: Error) => {
    assert.match(error.message, /answered 403/);
    assert.doesNotMatch(error.message, /TOKEN-123/);
    return true;
  });
});

test("directoryRunSink refuses an object name that leaves its folder", async () => {
  const { root } = tempStore();
  await assert.rejects(directoryRunSink(path.join(root, "out")).put("../escape.json", "{}", "application/json"), /escapes/);
});

test("a host with runRecords publishes a labelled session's run when it goes idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-records-host-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const out = path.join(root, "records");
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    browser: false,
    automations: { start: false },
    runRecords: { sink: directoryRunSink(out), allow: (session) => session.labels.brand === "brand-test" },
    query: () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "native-host-1" };
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hello owner" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: "hello owner", usage: {}, total_cost_usd: 0.01 };
      })(),
  });
  try {
    const launched = await host.agents.launch({
      task: "hi",
      idempotencyKey: "chat-1",
      labels: { procedure: "marley-chat", brand: "brand-test", conversation: "c-1", channel: "whatsapp" },
    });
    const id = (launched as { id?: string; agent?: { id: string } }).agent?.id ?? (launched as { id: string }).id;
    for (let i = 0; i < 100 && host.sessions.get(id)?.state !== "idle"; i++) await sleep(20);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(out, "runs")); i++) await sleep(20);
    await sleep(50);
    const runs = fs.readdirSync(path.join(out, "runs"));
    assert.equal(runs.length, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(out, "runs", runs[0]!, "summary.json"), "utf8"));
    assert.equal(summary.workflow, "marley-chat");
    assert.equal(summary.status, "succeeded");
    assert.deepEqual(summary.links, [{ kind: "chat", key: "brand-test:c-1", role: "origin" }]);
  } finally {
    await host.dispose();
  }
});
