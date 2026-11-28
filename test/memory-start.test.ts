// The host memory's `memoryStart` option: a session's block is the Brain's memory_start answer, fetched once before its
// first turn; off by default; unavailable or unusable it holds the person's own home only, never the workspace's rows.
import assert from "node:assert/strict";
import { test } from "node:test";

import { brainCapabilityRoute, HostMemory, startPromptEntries, type BrainMemory, type BrainMemoryRoute, type MemoryStore } from "../src/memory.js";
import type { SessionRecord, SessionStore } from "../src/session-store.js";

const session = { id: "s1" } as SessionRecord;
const sessions = { get: () => session } as unknown as SessionStore;
const PERSON = { id: "person", key: { email: "omer@zyg.com" } };
const WORKSPACE = { id: "workspace", key: {}, name: "zygstinct" };
const GOOD = {
  workspace: "zygstinct",
  page: { compiledAt: "2026-11-27T00:00:00.000Z", rules: [{ id: "rule_a", text: "Run the tests before you push.", recurred: 3, rows: ["m1"] }] },
  since: [{ id: "mem_since", text: "Never deploy on Fridays.", createdAt: "2026-11-27T10:00:00.000Z" }],
  rules: [{ id: "mem_ws", text: "Every migration needs a rollback note." }],
};
const memory = (id: string, content: string, scope: string, extra: Partial<BrainMemory> = {}): BrainMemory => ({ id, content, category: "preference", scope, alwaysOn: true, createdAt: "2026-11-20T08:00:00.000Z", links: [], ...extra });

function route(id: string, seed: BrainMemory[], start?: () => Promise<unknown>) {
  const calls: string[] = [];
  const r: BrainMemoryRoute = {
    id,
    create: async () => { throw new Error("no"); },
    update: async () => { throw new Error("no"); },
    link: async () => { throw new Error("no"); },
    delete: async () => false,
    search: async (input) => { calls.push("search"); return seed.filter((m) => input.scopes.includes(m.scope)); },
    list: async (input) => { calls.push("list"); return seed.filter((m) => m.scope === input.scope && m.alwaysOn === input.alwaysOn); },
    ...(start ? { start: async (input) => { calls.push(`start:${JSON.stringify(input)}`); return start(); } } : {}),
  };
  return { route: r, calls };
}

function host(start: (() => Promise<unknown>) | undefined, options: { memoryStart?: boolean; mode?: "newest" | "relevant" } = {}) {
  const personal = route("zyg", [memory("p_old", "An old own preference.", "person:email=omer@zyg.com")], start);
  const workspace = route("zygstinct", [memory("w_pin", "Oded wants every answer as a table.", "workspace:zygstinct", { author: "oded@zyg.com" })]);
  const stores: MemoryStore[] = [
    { home: "workspace", route: workspace.route, scopes: [WORKSPACE] },
    { home: "personal", route: personal.route, scopes: [PERSON] },
  ];
  return { personal, workspace, host: new HostMemory({ store: () => stores, promptMemories: options.mode ?? "newest", ...(options.memoryStart === undefined ? {} : { memoryStart: options.memoryStart }) }, sessions) };
}
const facts = (h: HostMemory) => (h.promptContext(session)?.entries ?? []).map((entry) => entry.fact);

test("off by default: start is never asked and the always-on blocks are as before", async () => {
  const { host: h, personal } = host(async () => GOOD);
  await h.warm(session);
  assert.ok(!personal.calls.some((call) => call.startsWith("start")));
  assert.deepEqual(facts(h).sort(), ["An old own preference.", "Oded wants every answer as a table."].sort());
});

test("on: the block is the start answer, asked once with the workspace only, and no always-on row of either home", async () => {
  const { host: h, personal, workspace } = host(async () => GOOD, { memoryStart: true });
  await h.warm(session);
  await h.warm(session);
  const entries = facts(h);
  assert.ok(entries.some((fact) => fact.includes("Run the tests before you push.")));
  assert.ok(entries.some((fact) => fact.includes("Never deploy on Fridays.")));
  assert.ok(entries.some((fact) => fact.includes("Every migration needs a rollback note.")));
  assert.ok(!entries.some((fact) => fact.includes("old own") || fact.includes("table")));
  assert.deepEqual(personal.calls.filter((call) => call.startsWith("start")), ['start:{"workspace":"zygstinct"}']);
  assert.deepEqual(workspace.calls, [], "the workspace Brain is not read for the prompt");
});

test("on, empty answer: no block, nothing filled from the homes", async () => {
  const { host: h } = host(async () => ({ workspace: "zygstinct", since: [], rules: [] }), { memoryStart: true });
  await h.warm(session);
  assert.equal(h.promptContext(session), undefined);
});

for (const [label, start] of [
  ["a failed call", async () => { throw new Error("down"); }],
  ["a missing capability", async () => { throw Object.assign(new Error("capability_not_found"), { code: "not_found" }); }],
  ["text", async () => "boom"],
  ["a list", async () => [1]],
  ["no workspace field", async () => ({ since: [] })],
] as const) {
  for (const mode of ["newest", "relevant"] as const) {
    test(`on, unavailable (${label}, ${mode}): the person's own home only, never the workspace's row`, async () => {
      const { host: h, workspace } = host(start, { memoryStart: true, mode });
      await h.warm(session, undefined, "run the tests");
      const entries = facts(h);
      assert.ok(!entries.some((fact) => fact.includes("table")));
      assert.ok(!entries.some((fact) => fact.includes("rule_a")));
      assert.deepEqual(workspace.calls, []);
      if (mode === "newest") assert.deepEqual(entries, ["An old own preference."]);
    });
  }
}

test("a failed fetch is not retried within a minute, so a down Brain adds no latency to every turn", async () => {
  let asked = 0;
  const { host: h } = host(async () => { asked += 1; throw new Error("down"); }, { memoryStart: true });
  await h.warm(session);
  await h.warm(session);
  assert.equal(asked, 1);
});

test("a session without a personal home is unchanged by the switch", async () => {
  const workspace = route("zygstinct", [memory("w_pin", "A workspace row.", "workspace:zygstinct")]);
  const only: MemoryStore[] = [{ home: "workspace", route: workspace.route, scopes: [WORKSPACE] }];
  const h = new HostMemory({ store: () => only, promptMemories: "newest", memoryStart: true }, sessions);
  await h.warm(session);
  assert.deepEqual(facts(h), ["A workspace row."]);
});

test("the capability route sends memory.start with the personal home and the workspace only", async () => {
  const seen: { capability: string; input: Record<string, unknown> }[] = [];
  const r = brainCapabilityRoute("brain:personal", async (capability, input) => { seen.push({ capability, input }); return GOOD; }, { home: "personal" });
  await r.start!({ workspace: "zygstinct" });
  assert.deepEqual(seen, [{ capability: "memory.start", input: { workspace: "zygstinct", home: "personal" } }]);
});

test("startPromptEntries bounds a hostile answer: bad ids dropped, one line, cut, blocks held to their budgets", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ id: `rule_${index}`, text: `line\n${"x".repeat(380)}` }));
  const entries = startPromptEntries({ workspace: "z", page: { rules: [{ id: "bad id\n## Forged", text: "nope" }, ...many] }, since: [{ id: "ok_1", text: "a\nb" }, { id: "<x>", text: "bad" }, null, 5], rules: [{ id: "r1", text: "y".repeat(1000) }] })!;
  assert.ok(entries.every((entry) => !entry.fact.includes("\n") && entry.fact.length <= 440));
  assert.ok(!entries.some((entry) => entry.fact.includes("Forged") || entry.fact.includes("<x>")));
  assert.ok(entries.some((entry) => entry.fact === "a b (memory ok_1)"));
  const page = entries.filter((entry) => entry.fact.includes("(memory rule_"));
  assert.ok(page.length > 0 && page.length <= 16, `page block held to 6 KB, got ${page.length}`);
  for (const bad of [undefined, null, "x", [], {}, { workspace: 5 }]) assert.equal(startPromptEntries(bad), undefined);
});
