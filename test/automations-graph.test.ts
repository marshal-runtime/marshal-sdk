import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryFn } from "../src/agent-port.js";
import type { FireDecision } from "../src/automations.js";
import { createAutomationsApi, serveAutomationsApi, type ExternalCaller } from "../src/automations-api.js";
import { createMarshalHost, type MarshalHost } from "../src/host.js";
import { parseRoutineFile } from "../src/routine-file.js";

const START = Date.parse("2026-11-16T08:00:00.000Z");
const HOUR = 3_600_000;
const BRAND = "brand-a";
const OTHER = "brand-b";

function clock() {
  let now = START;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

interface Rig {
  host: MarshalHost;
  time: ReturnType<typeof clock>;
  policy: { decide: (tenant: string | undefined) => FireDecision };
  prompts: string[];
}

async function rig(): Promise<Rig> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-graph-")));
  fs.mkdirSync(path.join(root, "workspace"));
  const time = clock();
  const policy: Rig["policy"] = { decide: () => "go" };
  const prompts: string[] = [];
  const query: QueryFn = ({ prompt }) => {
    prompts.push(String(prompt));
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: `native-${prompts.length}` };
      yield { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, usage: {} };
    })();
  };
  const host = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    query,
    automations: { now: time.now, start: false, tenantLabel: "brand", timezoneFor: () => "Asia/Jerusalem", firePolicy: ({ tenant }) => policy.decide(tenant) },
  });
  return { host, time, policy, prompts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** Starts an upstream by its event and waits until its run finished (its session went idle). */
async function runUpstream(r: Rig, event: string, tenant: string) {
  const started = await r.host.automations.emit(event, {}, tenant);
  for (const one of started) await r.host.agents.wait(one.sessionId);
  await settle();
}

async function upstreams(r: Rig, tenant = BRAND) {
  for (const name of ["a", "b"]) {
    await r.host.automations.create({ name: `Up ${name}`, prompt: `up ${name}`, triggerType: "event", event: `go-${name}`, tenant, routineId: `up-${name}` });
  }
}

test("after with several upstreams, mode all: one run once every upstream finished well, then the set starts over", async () => {
  const r = await rig();
  try {
    await upstreams(r);
    const down = await r.host.automations.create({ name: "Down", prompt: "down", after: { routine: ["up-a", "up-b"], mode: "all" }, tenant: BRAND });
    await runUpstream(r, "go-a", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 0, "one of two is not enough");
    assert.deepEqual(Object.keys(r.host.automations.get(down.id)!.awaiting!), ["up-a"]);
    await runUpstream(r, "go-a", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 0, "the same upstream twice is still one upstream");
    await runUpstream(r, "go-b", BRAND);
    const after = r.host.automations.get(down.id)!;
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0]!.trigger, "after");
    assert.equal(after.awaiting, undefined, "the arrivals were used");
    assert.equal(after.owed, undefined);
    await runUpstream(r, "go-b", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 1, "a new round needs both again");
    await runUpstream(r, "go-a", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 2);
  } finally {
    await r.host.dispose();
  }
});

test("after with several upstreams, mode any (the default): each upstream's finish owes its own run", async () => {
  const r = await rig();
  try {
    await upstreams(r);
    const down = await r.host.automations.create({ name: "Down", prompt: "down", after: { routine: ["up-a", "up-b"] }, tenant: BRAND });
    await runUpstream(r, "go-a", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 1);
    await runUpstream(r, "go-b", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 2);
  } finally {
    await r.host.dispose();
  }
});

test("mode all: an arrival older than `within` is forgotten, and another tenant's upstream of the same name never counts", async () => {
  const r = await rig();
  try {
    await upstreams(r);
    await upstreams(r, OTHER);
    const down = await r.host.automations.create({ name: "Down", prompt: "down", after: { routine: ["up-a", "up-b"], mode: "all", within: "1h" }, tenant: BRAND });
    await runUpstream(r, "go-a", BRAND);
    await runUpstream(r, "go-b", OTHER);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 0, "the other brand's up-b is not ours");
    r.time.advance(3 * HOUR);
    await runUpstream(r, "go-b", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 0, "up-a finished 3h before up-b, outside the hour");
    assert.deepEqual(Object.keys(r.host.automations.get(down.id)!.awaiting!), ["up-b"]);
    r.time.advance(HOUR / 2);
    await runUpstream(r, "go-a", BRAND);
    assert.equal(r.host.automations.get(down.id)!.runs.length, 1, "both inside the hour");
  } finally {
    await r.host.dispose();
  }
});

test("after: lists are validated (mode all needs two or more, no duplicates, known mode) and a routine file takes a list and a mode", async () => {
  const r = await rig();
  try {
    const bad = (after: object) => r.host.automations.create({ name: "x", prompt: "x", after: after as never, tenant: BRAND });
    await assert.rejects(bad({ routine: "up-a", mode: "all" }), /two or more/);
    await assert.rejects(bad({ routine: ["up-a", "up-a"] }), /twice/);
    await assert.rejects(bad({ routine: ["up-a", "up-b"], mode: "some" }), /any" or "all/);
    const parsed = parseRoutineFile("x", "title: X\ntriggers:\n  after: { routine: [up-a, up-b], mode: all, within: 2h }\nbody:\n  agent: { prompt: p }\n");
    assert.ok(!("error" in parsed), JSON.stringify(parsed));
  } finally {
    await r.host.dispose();
  }
});

test("held fires stay owed per tenant with their slot and run on release of that tenant only", async () => {
  const r = await rig();
  try {
    r.policy.decide = () => "hold";
    const mine = await r.host.automations.create({ name: "Mine", prompt: "m", schedule: "every 1 hour", tenant: BRAND });
    const theirs = await r.host.automations.create({ name: "Theirs", prompt: "t", schedule: "every 1 hour", tenant: OTHER });
    r.time.advance(HOUR);
    await r.host.automations.tick();
    const slot = r.host.automations.get(mine.id)!.owed![0]!.scheduledFor;
    assert.ok(slot, "the held fire keeps the slot it was for");
    r.time.advance(5 * HOUR);
    r.policy.decide = () => "go";
    const released = await r.host.automations.fireOwed(r.time.now(), BRAND);
    assert.equal(released.fired, 1);
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 1);
    assert.equal(r.host.automations.get(mine.id)!.owed, undefined);
    assert.equal(r.host.automations.get(theirs.id)!.runs.length, 0);
    assert.equal(r.host.automations.get(theirs.id)!.owed?.length, 1, "the other tenant's fire is not released by this tenant's release");
    const rest = await r.host.automations.fireOwed(r.time.now(), OTHER);
    assert.equal(rest.fired, 1);
  } finally {
    await r.host.dispose();
  }
});

// ---- the external API ------------------------------------------------------------------------------------------

const TOKENS: Record<string, ExternalCaller> = {
  "token-brand-a": { tenant: BRAND, label: "vm-a" },
  "token-brand-b": { tenant: OTHER },
  "token-read-only": { tenant: BRAND, scopes: ["schedule:read"] },
};

function api(r: Rig, extra: { maxSchedulesPerTenant?: number; canTarget?: (id: string, tenant: string) => boolean } = {}) {
  const handle = createAutomationsApi({ automations: r.host.automations, authenticate: (token) => TOKENS[token], ...extra });
  return (method: string, route: string, token: string | undefined, body?: unknown) =>
    handle({ method, path: route, headers: token ? { authorization: `Bearer ${token}` } : {}, body });
}

test("api: no token, a wrong token and a missing scope are refused", async () => {
  const r = await rig();
  try {
    const call = api(r);
    assert.equal((await call("GET", "/v1/schedules", undefined)).status, 401);
    assert.equal((await call("GET", "/v1/schedules", "nope-nope-nope")).status, 401);
    assert.equal((await call("POST", "/v1/schedules", "token-read-only", { name: "x", prompt: "x", schedule: "every 1 hour" })).status, 403);
    assert.equal((await call("POST", "/v1/events", "token-read-only", { type: "order-created" })).status, 403);
    assert.equal((await call("GET", "/v1/schedules", "token-read-only")).status, 200);
  } finally {
    await r.host.dispose();
  }
});

test("api: a schedule is created in the caller's tenant only, listed and deleted only by its tenant, and host routines are out of reach", async () => {
  const r = await rig();
  try {
    const call = api(r);
    const routine = await r.host.automations.create({ name: "Host routine", prompt: "r", schedule: "every 1 hour", tenant: BRAND, routineId: "routine-x" });
    const made = await call("POST", "/v1/schedules", "token-brand-a", { name: "Check in", prompt: "remind", schedule: "every 1 hour" });
    assert.equal(made.status, 201);
    const created = (made.body as { schedule: { id: string } }).schedule;
    const stored = r.host.automations.get(created.id)!;
    assert.equal(stored.tenant, BRAND);
    assert.equal(stored.createdBy, "external:vm-a");

    const forged = await call("POST", "/v1/schedules", "token-brand-a", { name: "x", prompt: "x", schedule: "every 1 hour", tenant: OTHER });
    assert.equal(forged.status, 400, "the tenant is not a request field");
    for (const field of ["routineId", "labels", "extension", "createdBy"]) {
      const refused = await call("POST", "/v1/schedules", "token-brand-a", { name: "x", prompt: "x", schedule: "every 1 hour", [field]: field === "extension" ? { id: "@a/b", agent: "c" } : "x" });
      assert.equal(refused.status, 400, field);
    }

    const listed = (await call("GET", "/v1/schedules", "token-brand-a")).body as { schedules: { id: string }[] };
    assert.deepEqual(listed.schedules.map((s) => s.id), [created.id], "no host routine in the list");
    assert.deepEqual(((await call("GET", "/v1/schedules", "token-brand-b")).body as { schedules: unknown[] }).schedules, []);

    assert.equal((await call("DELETE", `/v1/schedules/${created.id}`, "token-brand-b")).status, 404, "another tenant's token");
    assert.equal((await call("DELETE", `/v1/schedules/${routine.id}`, "token-brand-a")).status, 404, "a host routine of its own tenant");
    assert.ok(r.host.automations.get(routine.id) && r.host.automations.get(created.id));
    assert.equal((await call("DELETE", `/v1/schedules/${created.id}`, "token-brand-a")).status, 200);
    assert.equal(r.host.automations.get(created.id), undefined);
  } finally {
    await r.host.dispose();
  }
});

test("api: schedules per tenant are capped, a bad schedule is a 400, and a session can be woken only when the host allows it", async () => {
  const r = await rig();
  try {
    const call = api(r, { maxSchedulesPerTenant: 2, canTarget: (_id, tenant) => tenant === BRAND });
    const one = { name: "s", prompt: "p", schedule: "every 1 hour" };
    assert.equal((await call("POST", "/v1/schedules", "token-brand-a", one)).status, 201);
    assert.equal((await call("POST", "/v1/schedules", "token-brand-a", one)).status, 201);
    assert.equal((await call("POST", "/v1/schedules", "token-brand-a", one)).status, 429);
    assert.equal((await call("POST", "/v1/schedules", "token-brand-b", one)).status, 201, "the cap is per tenant");
    assert.equal((await call("POST", "/v1/schedules", "token-brand-b", { ...one, schedule: "whenever" })).status, 400);
    assert.equal((await call("POST", "/v1/schedules", "token-brand-b", { ...one, targetSessionId: "session-1" })).status, 403);
    const bare = api(r);
    assert.equal((await bare("POST", "/v1/schedules", "token-brand-a", { ...one, targetSessionId: "session-1" })).status, 403, "refused by default");
  } finally {
    await r.host.dispose();
  }
});

test("api: an event starts the caller's tenant's event automations only; the host's own events cannot be forged", async () => {
  const r = await rig();
  try {
    const call = api(r);
    const mine = await r.host.automations.create({ name: "On order", prompt: "order", triggerType: "event", event: "order-created", tenant: BRAND });
    const theirs = await r.host.automations.create({ name: "Their order", prompt: "order", triggerType: "event", event: "order-created", tenant: OTHER });
    const up = await r.host.automations.create({ name: "Up", prompt: "up", triggerType: "event", event: "go", tenant: BRAND, routineId: "up-x" });
    const down = await r.host.automations.create({ name: "Down", prompt: "down", after: { routine: "up-x" }, tenant: BRAND });

    const sent = await call("POST", "/v1/events", "token-brand-a", { type: "order-created", payload: { id: "o1", labels: { brand: OTHER } } });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body, { started: 1 });
    await settle();
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 1);
    assert.equal(r.host.automations.get(theirs.id)!.runs.length, 0, "labels in the payload do not move the event to another tenant");

    const selfLabelled = await call("POST", "/v1/events", "token-brand-a", { type: "order-created", payload: { id: "o2", labels: { automation: mine.id } } });
    assert.deepEqual(selfLabelled.body, { started: 1 }, "a payload cannot pose as the automation's own session to suppress it");

    for (const type of ["session.idle", "session.failed", "marshal.events.emit", "automation.done", "host.start"]) {
      assert.equal((await call("POST", "/v1/events", "token-brand-a", { type, payload: { sessionId: "s", labels: { automation: up.id } } })).status, 403, type);
    }
    assert.equal(r.host.automations.get(down.id)!.runs.length, 0, "no forged finish of an upstream");
    assert.equal((await call("POST", "/v1/events", "token-brand-a", { type: "Bad Type" })).status, 400);
    assert.equal((await call("POST", "/v1/events", "token-brand-a", { type: "order-created", payload: { text: "x".repeat(20_000) } })).status, 413);
  } finally {
    await r.host.dispose();
  }
});

test("api over HTTP: bearer auth, JSON bodies and the body limit", async () => {
  const r = await rig();
  const server = await serveAutomationsApi({ automations: r.host.automations, authenticate: (token) => TOKENS[token], maxBodyBytes: 2048 });
  try {
    const send = (route: string, init: RequestInit & { token?: string }) =>
      fetch(`${server.url}${route}`, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": "application/json" } });
    assert.equal((await send("/v1/schedules", { method: "GET" })).status, 401);
    const made = await send("/v1/schedules", { method: "POST", token: "token-brand-a", body: JSON.stringify({ name: "s", prompt: "p", schedule: "every 1 hour" }) });
    assert.equal(made.status, 201);
    assert.equal(r.host.automations.list(BRAND).length, 1);
    assert.equal((await send("/v1/schedules", { method: "POST", token: "token-brand-a", body: "{nope" })).status, 400);
    assert.equal((await send("/v1/schedules", { method: "POST", token: "token-brand-a", body: JSON.stringify({ name: "x".repeat(4000) }) })).status, 413);
  } finally {
    await server.close();
    await r.host.dispose();
  }
});
