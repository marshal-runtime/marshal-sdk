import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryFn } from "../src/agent-port.js";
import type { FireDecision, JobRequest } from "../src/automations.js";
import { createMarshalHost } from "../src/host.js";

const START = Date.parse("2026-11-16T08:00:00.000Z");
const HOUR = 3_600_000;

async function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-jobs-")));
  fs.mkdirSync(path.join(root, "workspace"));
  let now = START;
  const calls: JobRequest[] = [];
  const sessionsStarted: string[] = [];
  const policy = { decide: "go" as FireDecision };
  const query: QueryFn = ({ prompt }) => {
    sessionsStarted.push(String(prompt));
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "native" };
      yield { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, usage: {} };
    })();
  };
  const host = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    query,
    automations: {
      now: () => new Date(now),
      start: false,
      tenantLabel: "brand",
      firePolicy: () => policy.decide,
      jobs: {
        watch: async (request) => {
          calls.push(request);
          if (request.input.fail) throw new Error("the watch failed");
        },
      },
    },
  });
  return { host, calls, sessionsStarted, policy, advance: (ms: number) => (now += ms) };
}

test("a job automation runs the registered handler on its clock, starts no session and records a run", async () => {
  const r = await rig();
  try {
    const created = await r.host.automations.create({ name: "Graph watch", job: { id: "watch", input: { every: "hourly" } }, schedule: "every 1 hours", tenant: "brand-a" });
    assert.equal(created.prompt, "");
    r.advance(HOUR + 1000);
    await r.host.automations.tick();
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.tenant, "brand-a");
    assert.equal(r.calls[0]!.trigger, "schedule");
    assert.deepEqual(r.calls[0]!.input, { every: "hourly" });
    assert.deepEqual(r.sessionsStarted, [], "a job never starts an agent session");
    assert.equal(r.host.automations.get(created.id)!.runs.at(-1)!.sessionId, `job:${created.id}`);
  } finally {
    await r.host.dispose();
  }
});

test("a job honours the fire policy: hold keeps the fire owed, and it runs once the policy lets it", async () => {
  const r = await rig();
  try {
    const created = await r.host.automations.create({ name: "Graph watch", job: { id: "watch" }, schedule: "every 1 hours", tenant: "brand-a" });
    r.policy.decide = "hold";
    r.advance(HOUR + 1000);
    await r.host.automations.tick();
    assert.equal(r.calls.length, 0);
    assert.equal(r.host.automations.get(created.id)!.owed?.length, 1);
    r.policy.decide = "go";
    await r.host.automations.tick();
    assert.equal(r.calls.length, 1);
  } finally {
    await r.host.dispose();
  }
});

test("a job runs on an event of its own tenant only, with the event as data", async () => {
  const r = await rig();
  try {
    await r.host.automations.create({ name: "After publish", job: { id: "watch" }, triggerType: "event", event: "graph.published", tenant: "brand-a" });
    await r.host.automations.emit("graph.published", { revision: 3 }, "brand-b");
    assert.equal(r.calls.length, 0);
    await r.host.automations.emit("graph.published", { revision: 3 }, "brand-a");
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0]!.event, { type: "graph.published", payload: { revision: 3 } });
  } finally {
    await r.host.dispose();
  }
});

test("an unregistered job cannot be created, and a body cannot be a job and an extension", async () => {
  const r = await rig();
  try {
    await assert.rejects(() => r.host.automations.create({ name: "x", job: { id: "nope" }, schedule: "every 1 hours" }), /not registered/);
    await assert.rejects(() => r.host.automations.create({ name: "x", job: { id: "watch" }, schedule: "every 1 hours", extension: { id: "a", agent: "b" } }), /job body/);
  } finally {
    await r.host.dispose();
  }
});

test("a handler that throws is recorded as the automation's error and the next fire still runs", async () => {
  const r = await rig();
  try {
    const created = await r.host.automations.create({ name: "Graph watch", job: { id: "watch", input: { fail: true } }, schedule: "every 1 hours", tenant: "brand-a" });
    r.advance(HOUR + 1000);
    await r.host.automations.tick();
    assert.match(r.host.automations.get(created.id)!.lastError ?? "", /the watch failed/);
    r.advance(HOUR);
    await r.host.automations.tick();
    assert.equal(r.calls.length, 2);
  } finally {
    await r.host.dispose();
  }
});
