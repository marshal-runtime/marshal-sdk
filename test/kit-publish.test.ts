import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { InvocationContext } from "@marshal/runtime";

import { createSessionsProvider, prepareKit, shareAccess, shareParts, sharePayload, type CapabilityCall } from "../src/kit/index.js";
import type { SharedMessage } from "../src/kit/sessions.js";
import { SessionPublisher } from "../src/kit/publisher.js";
import { hostKit } from "../src/run-kit.js";
import { FileSessionStore } from "../src/session-store.js";

const context = { principal: { id: "test", kind: "agent" }, scope: { sessionId: "s", workspacePath: "/w" } } as unknown as InvocationContext;

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-publish-"));
  return { root, store: new FileSessionStore(path.join(root, "sessions"), { runId: "run-9", host: { id: "box", kind: "container" } }) };
}

test("sharePayload carries tool calls (name and input) on the assistant message they led to, and the context line", async () => {
  const { store } = tempStore();
  const session = store.create({ title: "Page build", runtime: "claude", native: { kind: "claude", cwd: "/w" }, workspace: "agent-sandbox" });
  store.appendMessage(session.id, { role: "user", content: "build the RAWDOG page" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.appendEvent(session.id, { type: "assistant", message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "t1", name: "mcp__marshal__runtime_exec", input: { target: "pagestudio.page.create", input: { idea: "why buy" } } }] } });
  store.appendEvent(session.id, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "SECRET OUTPUT" }] } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.appendMessage(session.id, { role: "assistant", content: "page made" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.appendEvent(session.id, { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/out/index.html" } }] } });

  const payload = sharePayload(store.get(session.id)!, store, { context: "agent-sandbox run 812 · state gs://bucket/run-812/agent/marshal-state/" });
  assert.equal(payload.source, "marshal");
  assert.equal(payload.messages[0]!.text, "agent-sandbox run 812 · state gs://bucket/run-812/agent/marshal-state/\n\nbuild the RAWDOG page");
  assert.equal(payload.title, "Page build · agent-sandbox run 812 · state gs://bucket/run-812/agent/marshal-state/");
  assert.equal(sharePayload(store.get(session.id)!, store).title, "Page build");
  const long = sharePayload({ ...store.get(session.id)!, title: "x".repeat(600) }, store, { context: "agent-sandbox run 812 · state gs://b/" });
  assert.equal(long.title.length, 500);
  assert.ok(long.title.endsWith(" · agent-sandbox run 812 · state gs://b/"));
  assert.equal(payload.messages[0]!.tools, undefined);
  const tools = payload.messages[1]!.tools!;
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__marshal__runtime_exec", "Read"]);
  assert.match(tools[0]!.input!, /pagestudio\.page\.create/);
  assert.doesNotMatch(JSON.stringify(payload), /SECRET OUTPUT/);
});

test("shareParts keeps a small session whole and splits a big one in order with message offsets", () => {
  const small = [{ role: "user" as const, text: "hi", at: "t" }];
  assert.deepEqual(shareParts(small), [{ offset: 0, messages: small }]);
  const big: SharedMessage[] = Array.from({ length: 10 }, (_, index) => ({ role: "assistant" as const, text: "x".repeat(100), at: String(index) }));
  const parts = shareParts(big, 350);
  assert.ok(parts.length > 1);
  assert.deepEqual(parts.flatMap((part) => part.messages), big);
  for (const part of parts) assert.equal(big.indexOf(part.messages[0]!), part.offset);
});

test("shareAccess: team by default, the configured people, and explicit people win", () => {
  assert.deepEqual(shareAccess(undefined), { audience: "team" });
  assert.deepEqual(shareAccess("team"), { audience: "team" });
  assert.deepEqual(shareAccess({ people: ["a@zyg.com"] }), { audience: "people", emails: ["a@zyg.com"] });
  assert.deepEqual(shareAccess("team", ["b@zyg.com"]), { audience: "people", emails: ["b@zyg.com"] });
});

test("publish turns on sessions.share with the publish audience and context, and lets cloud_share through the broker", async () => {
  const { root, store } = tempStore();
  const packageRoot = path.join(root, "brain");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "runtime-extension.json"), JSON.stringify({ identity: "@marshal/brain" }));
  const kit = prepareKit({ kit: { parts: ["sessions"], brain: { packageRoot }, sessions: { publish: true } }, sessions: store, workspacePath: "/w/zyg" });
  assert.equal(kit.publishes, false, "publishing needs the Brain part");
  const on = prepareKit({ kit: { parts: ["brain", "sessions"], brain: { packageRoot }, sessions: { publish: { audience: { people: ["omer@zyg.com"] } } } }, sessions: store, workspacePath: "/w/zyg" });
  assert.equal(on.publishes, true);
  assert.ok(!on.denied.has("sessions.cloud_share"));
  assert.ok(on.denied.has("memory.create"), "memory writes come with the memory part");

  const session = store.create({ title: "Critic", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  store.appendMessage(session.id, { role: "user", content: "review the page" });
  const calls: { target: string; input: any }[] = [];
  const call: CapabilityCall = async (target, input) => {
    calls.push({ target, input });
    return { status: "stored" };
  };
  const provider = createSessionsProvider(store, call, { publish: { audience: { people: ["omer@zyg.com"] }, context: (record) => `run ${record.runId}` } });
  await provider.invoke("sessions.share", { sessionId: session.id }, context);
  assert.deepEqual(calls[0]!.input.access, { audience: "people", emails: ["omer@zyg.com"] });
  assert.equal(calls[0]!.input.session.messages[0].text, "run run-9\n\nreview the page");
  assert.equal(calls[0]!.input.parts, undefined);
});

test("SessionPublisher uploads once per session at a time and once more for turns that ended meanwhile", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const publisher = new SessionPublisher(async (id) => {
    seen.push(id);
    if (seen.length === 1) await gate;
    if (id === "bad") throw new Error("index down");
    return { status: "stored" };
  });
  publisher.schedule("a");
  publisher.schedule("a");
  publisher.schedule("a");
  publisher.schedule("bad");
  release();
  await publisher.flush();
  assert.deepEqual(seen.sort(), ["a", "a", "bad"]);
  assert.equal(publisher.status().a!.ok, true);
  assert.equal(publisher.status().bad!.ok, false);
});

test("SessionPublisher.close finishes what is scheduled and takes nothing after", async () => {
  const seen: string[] = [];
  const publisher = new SessionPublisher(async (id) => {
    seen.push(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: "stored" };
  });
  publisher.schedule("a");
  await publisher.close();
  publisher.schedule("b");
  await publisher.flush();
  assert.deepEqual(seen, ["a"]);
});

test("a run's hostKit adds the Brain and sessions when the run publishes", () => {
  assert.deepEqual(hostKit(undefined, undefined), {});
  assert.deepEqual(hostKit(["memory"], undefined), { kit: { parts: ["memory"] } });
  assert.deepEqual(hostKit(["memory"], { audience: "team" }), { kit: { parts: ["memory", "brain", "sessions"], sessions: { publish: { audience: "team" } } } });
});

test("a run's hostKit names the Brain caller, so the host gets that person's memory home", () => {
  assert.deepEqual(hostKit(["memory"], undefined, "Omer@zyg.com "), { kit: { parts: ["memory"], brain: { callerEmail: "Omer@zyg.com" } } });
  assert.deepEqual(hostKit(undefined, { audience: "team" }, "omer@zyg.com"), {
    kit: { parts: ["brain", "sessions"], sessions: { publish: { audience: "team" } }, brain: { callerEmail: "omer@zyg.com" } },
  });
  assert.deepEqual(hostKit(["memory"], undefined, " "), { kit: { parts: ["memory"] } });
});
