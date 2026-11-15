import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { HostSessions } from "../src/org-host-sessions.js";
import type { SessionEnvelope } from "../src/session-messages.js";

const envelope = (body: string): SessionEnvelope => ({
  messageId: "m-1",
  from: { kind: "person", personId: "user:bob@example.test", name: "Bob" },
  to: { sessionId: "s-1" },
  body,
  deliveryMode: "queue",
  sentAt: new Date().toISOString(),
  waitForResponse: true,
  timeoutMs: 5_000,
});

test("an org instruction runs through marshal.agent.*; a failed turn (idle with an error message) is reported as a failure", async () => {
  const sent: string[] = [];
  let failNext = false;
  const call = async (name: string, input: Record<string, unknown>) => {
    if (name === "marshal.agent.send") {
      sent.push(String(input.message));
      return { agent: { id: "s-1", state: "running" }, accepted: true };
    }
    if (name === "marshal.agent.wait") return { state: "completed", agent: { id: "s-1", state: "idle" }, ...(failNext ? {} : { result: "done: hero written" }) };
    if (name === "marshal.agent.transcript") {
      assert.equal(input.limit, 1);
      const last = failNext ? { id: "e", role: "assistant", content: "Turn failed: rate limited", timestamp: "t", error: true } : { id: "a", role: "assistant", content: "done: hero written", timestamp: "t" };
      return { agent: { id: "s-1", state: "idle" }, messageCount: 2, showing: 1, messages: [last] };
    }
    throw new Error(`unexpected ${name}`);
  };
  const sessions = new HostSessions({ call, root: fs.mkdtempSync(path.join(os.tmpdir(), "host-sessions-")), host: { id: "h", kind: "container" } });

  const ok = await sessions.deliver(envelope("Write the hero"));
  assert.deepEqual([ok.success, ok.response], [true, "done: hero written"]);
  assert.match(sent[0]!, /^Message from Bob through the organization:\n\nWrite the hero$/);

  failNext = true;
  const failed = await sessions.deliver(envelope("Again"));
  assert.deepEqual([failed.success, failed.accepted, failed.error], [false, true, "Turn failed: rate limited"]);
});
