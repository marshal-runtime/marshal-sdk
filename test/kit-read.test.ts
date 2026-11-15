import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { InvocationContext } from "@marshal/runtime";

import { createSessionsProvider, runOrigin, type CapabilityCall } from "../src/kit/index.js";
import { FileSessionStore } from "../src/session-store.js";

const context = { principal: { id: "test", kind: "agent" }, scope: { sessionId: "s", workspacePath: "/w" } } as unknown as InvocationContext;

function tempStore(runId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-read-"));
  return { root, store: new FileSessionStore(path.join(root, "sessions"), { runId, host: { id: "box", kind: "container" } }) };
}

function seed(store: FileSessionStore, text: string) {
  const session = store.create({ title: "Page build", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  store.appendMessage(session.id, { role: "user", content: text });
  store.appendMessage(session.id, { role: "assistant", content: "done" });
  return session;
}

const out = async (pending: unknown) => ((await pending) as { output: unknown }).output;

type Read = { found: boolean; from?: string; total?: number; messages?: { role: string; content: string }[]; session?: { id: string }; tried?: string[] };

test("sessions.read opens a session from this host, then from another SDK store on this machine", async () => {
  const own = tempStore("run-1");
  const other = tempStore("run-2");
  const mine = seed(own.store, "hello from this host");
  const theirs = seed(other.store, "hello from another store");
  const provider = createSessionsProvider(own.store, undefined, { readRoots: [other.root] });

  const first = (await out(provider.invoke("sessions.read", { sessionId: mine.id }, context))) as Read;
  assert.equal(first.found, true);
  assert.equal(first.from, "this-host");
  assert.equal(first.total, 2);
  assert.match(first.messages![0]!.content, /hello from this host/);

  const second = (await out(provider.invoke("sessions.read", { sessionId: theirs.id }, context))) as Read;
  assert.equal(second.from, "local-store");
  assert.equal(second.session?.id, theirs.id);
  assert.match(second.messages![0]!.content, /^<untrusted_session>hello from another store<\/untrusted_session>$/);
});

test("sessions.read opens a published sandbox session from the run state it names, and says where it looked when nothing has it", async () => {
  const own = tempStore("run-1");
  const cloud = tempStore("812");
  const published = seed(cloud.store, "agent-sandbox run 812 · state gs://bucket/run-812/agent/marshal-state/\n\nbuild the page");
  const objects = new Map<string, string>([
    ["gs://bucket/run-812/agent/marshal-state/host/sessions/index.json", fs.readFileSync(path.join(cloud.root, "sessions", "index.json"), "utf8")],
    [`gs://bucket/run-812/agent/marshal-state/host/sessions/${published.id}/transcript.jsonl`, fs.readFileSync(path.join(cloud.root, "sessions", published.id, "transcript.jsonl"), "utf8")],
  ]);
  const asked: string[] = [];
  const provider = createSessionsProvider(own.store, undefined, {
    readCloudObject: async (url) => {
      asked.push(url);
      return objects.get(url);
    },
  });
  const read = (await out(provider.invoke("sessions.read", { sessionId: published.id, stateLocation: "gs://bucket/run-812/agent/marshal-state/" }, context))) as Read;
  assert.equal(read.found, true);
  assert.equal(read.from, "cloud-state");
  assert.equal(read.session?.id, published.id);
  assert.match(read.messages![0]!.content, /build the page/);

  const missing = (await out(provider.invoke("sessions.read", { sessionId: "nope", stateLocation: "gs://bucket/run-812/agent/marshal-state" }, context))) as Read;
  assert.equal(missing.found, false);
  assert.deepEqual(missing.tried, ["this host", "gs://bucket/run-812/agent/marshal-state/state/sessions", "gs://bucket/run-812/agent/marshal-state/host/sessions", "gs://bucket/run-812/agent/marshal-state/sessions"]);
  await assert.rejects(async () => provider.invoke("sessions.read", { sessionId: "../etc" }, context));
  await assert.rejects(async () => provider.invoke("sessions.read", { sessionId: "x", stateLocation: "/etc" }, context));
  assert.ok(asked.every((url) => url.startsWith("gs://bucket/run-812/agent/marshal-state/")));
});

test("cloud hits from sessions.search carry the run and state a published session names", async () => {
  const own = tempStore("run-1");
  const call: CapabilityCall = async () => ({
    hits: [
      { sessionId: "a", source: "marshal", title: "RAWDOG page", snippet: "agent-sandbox run 812 · state gs://bucket/run-812/agent/marshal-state/ build the page" },
      { sessionId: "b", source: "marshal", title: "Chat", snippet: "we should run it again tomorrow" },
    ],
  });
  const provider = createSessionsProvider(own.store, call);
  const answer = (await out(provider.invoke("sessions.search", { query: "page", scope: "cloud" }, context))) as { results: Record<string, unknown>[] };
  assert.equal(answer.results[0]!.runId, "812");
  assert.equal(answer.results[0]!.stateLocation, "gs://bucket/run-812/agent/marshal-state/");
  assert.equal(answer.results[1]!.runId, undefined);
  assert.equal(answer.results[1]!.stateLocation, undefined);
  assert.deepEqual(runOrigin("no line here"), {});
});
