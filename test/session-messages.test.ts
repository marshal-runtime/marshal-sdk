import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import type { SessionEnvelope } from "../src/session-messages.js";
import { FileSessionStore } from "../src/session-store.js";

/** Answers `echo: <prompt>` after `delayMs`; stops when aborted. */
function echoBackend(delayMs = 0): QueryFn {
  let count = 0;
  return ({ prompt, options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${++count}` };
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          (options.abortController as AbortController).signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
      const answer = `echo: ${String(prompt).split("\n").at(-1)}`;
      yield { type: "result", subtype: "success", is_error: false, result: answer, usage: {} };
    })();
}

function port(delayMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-messages-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "host-a", kind: "local" } });
  const agents = new ClaudeAgentPort({
    query: echoBackend(delayMs),
    store,
    cwd: root,
    env: {},
    defaultModel: "test-model",
    systemPrompt: () => undefined,
    mcpServers: () => ({}),
  });
  return { agents, store };
}

const envelope = (to: SessionEnvelope["to"], body: string, extra: Partial<SessionEnvelope> = {}): SessionEnvelope => ({
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  from: { kind: "session", sessionId: "sender-1", name: "Planner" },
  to,
  body,
  deliveryMode: "queue",
  sentAt: new Date().toISOString(),
  ...extra,
});

test("a message from another session carries its sender line and `from`, queues behind a running turn, and can wait for the reply", async () => {
  const { agents, store } = port(30);
  const target = agents.launch({ task: "work", idempotencyKey: "t" });
  const result = await agents.deliver(envelope({ sessionId: target.id }, "status?", { waitForResponse: true, timeoutMs: 5_000 }));
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryState, "queued");
  assert.equal(result.response, "echo: status?");
  const delivered = store.messages(target.id).find((message) => message.from);
  assert.equal(delivered?.content, "Message from session Planner (sender-1):\n\nstatus?");
  assert.deepEqual(delivered?.from, { kind: "session", sessionId: "sender-1", name: "Planner" });
});

test("interrupt stops the running turn and delivers at once; replaceQueued drops the sender's undelivered messages", async () => {
  const { agents, store } = port(200);
  const target = agents.launch({ task: "long work", idempotencyKey: "t" });
  const first = await agents.deliver(envelope({ sessionId: target.id }, "first note"));
  const second = await agents.deliver(envelope({ sessionId: target.id }, "second note", { replaceQueued: true }));
  assert.deepEqual(second.replacedMessageIds, [first.messageId]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const steer = await agents.deliver(envelope({ sessionId: target.id }, "stop and steer", { deliveryMode: "interrupt" }));
  assert.equal(steer.deliveryState, "started");
  await agents.wait(target.id);
  const lines = store.messages(target.id).map((message) => `${message.role}:${message.content.split("\n").at(-1)}`);
  assert.deepEqual(lines, [
    "user:long work",
    "system:Turn cancelled.",
    "user:stop and steer",
    "assistant:echo: stop and steer",
    "user:second note",
    "assistant:echo: second note",
  ]);
});

test("refusals: self, unknown session, and a host with no route; a registered transport carries the envelope", async () => {
  const { agents } = port();
  const self = agents.launch({ task: "x", idempotencyKey: "s" });
  await agents.wait(self.id);
  const fromSelf = { kind: "session" as const, sessionId: self.id, name: "x" };
  assert.match((await agents.deliver(envelope({ sessionId: self.id }, "hi", { from: fromSelf }))).error!, /cannot message itself/);
  assert.match((await agents.deliver(envelope({ sessionId: "nope" }, "hi"))).error!, /Session not found/);
  assert.match((await agents.deliver(envelope({ host: "host-b", sessionId: "s-b" }, "hi"))).error!, /No route to host host-b/);
  const carried: SessionEnvelope[] = [];
  const remove = agents.addTransport({
    hostId: "host-b",
    deliver: async (sent) => {
      carried.push(sent);
      return { success: true, accepted: true, messageId: sent.messageId, deliveryState: "queued" };
    },
  });
  const sent = await agents.deliver(envelope({ host: "host-b", sessionId: "s-b" }, "over the link"));
  assert.equal(sent.accepted, true);
  assert.deepEqual(carried.map((item) => [item.to, item.body, item.from.sessionId]), [[{ host: "host-b", sessionId: "s-b" }, "over the link", "sender-1"]]);
  remove();
  assert.equal((await agents.deliver(envelope({ host: "host-b", sessionId: "s-b" }, "again"))).accepted, false);
  // This host's own id is local: no transport needed.
  assert.equal((await agents.deliver(envelope({ host: "host-a", sessionId: self.id }, "local by id"))).accepted, true);
  await agents.wait(self.id);
});

/** A backend whose sessions act through their own `marshal` MCP server, the way a model would. */
function scriptedBackend(script: (prompt: string, call: (target: string, input: unknown) => Promise<any>) => Promise<string>): QueryFn {
  let count = 0;
  return ({ prompt, options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${++count}` };
      const tools = (options.mcpServers as any).marshal.instance._registeredTools;
      const call = async (target: string, input: unknown) => {
        const result = await tools.runtime_exec.handler({ targetType: "operation", target, input }, {});
        const response = JSON.parse(result.content[0].text);
        if (response.status !== "success") throw new Error(`${target}: ${JSON.stringify(response.error)}`);
        return response.result.output;
      };
      const answer = await script(String(prompt), call);
      yield { type: "result", subtype: "success", is_error: false, result: answer, usage: {} };
    })();
}

test("on a host: a session starts a lane (no parent, launchedBy, brief only), the lane messages it back, and both are found and read", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-lanes-")));
  fs.mkdirSync(path.join(root, "workspace"));
  const seen: Record<string, any> = {};
  const host = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    host: { id: "host-a", kind: "local" },
    query: scriptedBackend(async (prompt, call) => {
      if (prompt === "coordinate the release") {
        seen.lane = await call("marshal.tool.startLane", { task: "Check the changelog, then tell me.", name: "Changelog lane" });
        seen.child = await call("marshal.agent.launch", { task: "child work", idempotencyKey: "child-1" });
        return "lane started";
      }
      if (prompt.endsWith("Check the changelog, then tell me.")) {
        const launcher = /messageSession \{sessionId: "([^"]+)"\}/.exec(prompt)![1]!;
        seen.reply = await call("marshal.tool.messageSession", { sessionId: launcher, message: "Changelog is complete." });
        return "reported";
      }
      if (prompt.includes("Changelog is complete.")) {
        seen.found = await call("marshal.tool.searchSessions", { query: "changelog" });
        seen.transcript = await call("marshal.tool.getSessionTranscript", { sessionId: seen.lane.sessionId });
        return "thanks";
      }
      return "ok";
    }),
  });
  try {
    const coordinator = host.agents.launch({ task: "coordinate the release", idempotencyKey: "c", name: "Release coordinator" });
    await host.agents.wait(coordinator.id);
    await host.agents.wait(seen.lane.sessionId);
    await host.agents.wait(coordinator.id);

    assert.equal(seen.lane.success, true);
    assert.equal(seen.lane.host, "host-a");
    const lane = host.sessions.get(seen.lane.sessionId)!;
    assert.equal(lane.title, "Changelog lane");
    assert.equal(lane.parentId, undefined);
    assert.equal(lane.launchedBy, coordinator.id);
    const brief = host.sessions.messages(lane.id)[0]!;
    assert.match(brief.content, /^You are a new Marshal session \(a lane\) started by session "Release coordinator"/);
    assert.deepEqual(brief.from, { kind: "session", sessionId: coordinator.id, name: "Release coordinator" });
    assert.equal(host.sessions.messages(lane.id).filter((message) => message.content.includes("coordinate the release")).length, 0);

    // marshal.agent.launch from a session makes a child of it.
    assert.equal(host.sessions.get(seen.child.agent.id)!.parentId, coordinator.id);

    assert.equal(seen.reply.accepted, true);
    const back = host.sessions.messages(coordinator.id).find((message) => message.from?.sessionId === lane.id)!;
    assert.equal(back.content, `Message from session Changelog lane (${lane.id}):\n\nChangelog is complete.`);

    assert.ok(seen.found.results.some((hit: any) => hit.sessionId === lane.id && hit.launchedBy === coordinator.id));
    assert.ok(seen.found.results.every((hit: any) => hit.sessionId !== coordinator.id), "search leaves out the caller");
    assert.equal(seen.transcript.name, "Changelog lane");
    assert.equal(seen.transcript.messages[0].from.sessionId, coordinator.id);
  } finally {
    await host.dispose();
  }
});
