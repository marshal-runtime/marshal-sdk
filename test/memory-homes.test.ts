// Two memory homes (Omer R8): a personal home in the default Brain and the workspace's own Brain. Writes go to one
// home, reads merge both, the prompt block shows personal always-on memories first, and a single-store host (Marley)
// behaves as before.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { InvocationContext } from "@marshal/runtime";

import { brainConfiguration } from "../src/kit/brain.js";
import {
  brainCapabilityRoute,
  companyBrainStores,
  createMemoryToolsProvider,
  HostMemory,
  scopeString,
  type BrainMemory,
  type BrainMemoryRoute,
  type MemoryScope,
  type MemoryStore,
} from "../src/memory.js";
import type { SessionRecord, SessionStore } from "../src/session-store.js";

const session = { id: "s1" } as SessionRecord;
const sessions = { get: (id: string) => (id === "s1" ? session : undefined) } as unknown as SessionStore;
const context = { principal: { id: "test", kind: "agent" }, scope: { sessionId: "s1", workspacePath: "/w/zygstinct" } } as unknown as InvocationContext;

/** An in-memory Brain store: what it holds, the calls it got, and a switch that makes every call fail. */
function fakeRoute(id: string, seed: BrainMemory[] = []) {
  const held = [...seed];
  const calls: { op: string; input: any }[] = [];
  let next = 0;
  let down = false;
  const guard = (op: string, input: any) => {
    calls.push({ op, input });
    if (down) throw Object.assign(new Error(`${id} is down`), { code: "unavailable" });
  };
  const find = (memoryId: string, scopes: string[]) => {
    const found = held.find((record) => record.id === memoryId && scopes.includes(record.scope));
    if (!found) throw Object.assign(new Error(`no memory ${memoryId} in ${id}`), { code: "not-found" });
    return found;
  };
  const route: BrainMemoryRoute = {
    id,
    create: async (input) => {
      guard("create", input);
      const record: BrainMemory = { id: `${id}-${++next}`, content: input.content, category: input.category, scope: input.scope, alwaysOn: input.alwaysOn, createdAt: new Date(Date.now() + next).toISOString(), links: input.links, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
      held.push(record);
      return record;
    },
    update: async (input) => {
      guard("update", input);
      const record = find(input.id, input.scopes);
      if (input.content) record.content = input.content;
      if (input.links) record.links = input.links;
      return { ...record };
    },
    link: async (input) => {
      guard("link", input);
      const record = find(input.id, input.scopes);
      record.links = [...record.links, ...input.links];
      return { ...record };
    },
    delete: async (input) => {
      guard("delete", input);
      const index = held.findIndex((record) => record.id === input.id && input.scopes.includes(record.scope));
      if (index < 0) return false;
      held.splice(index, 1);
      return true;
    },
    search: async (input) => {
      guard("search", input);
      return held.filter((record) => input.scopes.includes(record.scope) && record.content.toLowerCase().includes(input.query.toLowerCase())).slice(0, input.limit);
    },
    list: async (input) => {
      guard("list", input);
      return held
        .filter((record) => record.scope === input.scope && (input.alwaysOn === undefined || record.alwaysOn === input.alwaysOn) && (!input.since || record.createdAt >= input.since))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, input.limit);
    },
  };
  return { route, held, calls, setDown: (value: boolean) => (down = value) };
}

const PERSON = { id: "person", key: { email: "omer@zyg.com" } };
const WORKSPACE = { id: "workspace", key: {}, name: "zygstinct" };
const memory = (id: string, content: string, scope: string, extra: Partial<BrainMemory> = {}): BrainMemory => ({ id, content, category: "fact", scope, alwaysOn: false, createdAt: "2026-11-17T08:00:00.000Z", links: [], ...extra });

function twoHomes(personal = fakeRoute("zyg"), workspace = fakeRoute("zygstinct")) {
  const stores: MemoryStore[] = [
    { home: "workspace", route: workspace.route, scopes: [WORKSPACE] },
    { home: "personal", route: personal.route, scopes: [PERSON] },
  ];
  return { personal, workspace, host: new HostMemory({ store: () => stores }, sessions) };
}

test("a person scope keeps the @ of the email, the form the Brain checks the writer against", () => {
  assert.equal(scopeString(PERSON), "person:email=omer@zyg.com");
  assert.equal(scopeString(WORKSPACE), "workspace:zygstinct");
  assert.equal(scopeString({ id: "workspace", key: {}, name: "my repo" }), "workspace:my repo", "the desktop writes the name as is");
  assert.equal(scopeString({ id: "person", key: { brand: "b 1", member: "m/2" } }), "person:brand=b-1/member=m-2");
});

test("remember: a preference goes to the personal home, anything else to the workspace's own Brain", async () => {
  const { personal, workspace, host } = twoHomes();
  const preference = await host.remember(session, { fact: "Answers in three lines.", category: "preference" });
  assert.equal(preference.home, "personal");
  assert.equal(preference.scope, "person:email=omer@zyg.com");
  assert.equal(preference.alwaysOn, true);
  const gotcha = await host.remember(session, { fact: "Never edit packages/db migrations by hand.", category: "decision", links: [{ path: "packages/db/migrations-pgroll" }] });
  assert.equal(gotcha.home, "workspace");
  assert.equal(gotcha.scope, "workspace:zygstinct");
  assert.deepEqual(gotcha.links, [{ path: "packages/db/migrations-pgroll" }]);
  assert.deepEqual(personal.calls.map((call) => call.op), ["create"]);
  assert.deepEqual(workspace.calls.map((call) => call.op), ["create"]);
});

test("remember: an explicit home wins (a birthday is a personal fact, not workspace knowledge)", async () => {
  const { personal, host } = twoHomes();
  const birthday = await host.remember(session, { fact: "My wife's birthday is March 3.", category: "fact", home: "personal" });
  assert.equal(birthday.home, "personal");
  assert.equal(birthday.alwaysOn, false);
  assert.equal(personal.held.length, 1);
});

test("remember: a home the session lacks is refused, and an unknown home is invalid", async () => {
  const workspace = fakeRoute("zygstinct");
  const host = new HostMemory({ store: () => [{ home: "workspace", route: workspace.route, scopes: [WORKSPACE] }] }, sessions);
  await assert.rejects(host.remember(session, { fact: "x", home: "personal" }), /no personal memory home/);
  await assert.rejects(host.remember(session, { fact: "x", home: "brand" }), /home must be one of/);
  // Without a personal home, a preference falls back to the home the session has.
  const preference = await host.remember(session, { fact: "Short answers.", category: "preference" });
  assert.equal(preference.home, "workspace");
});

test("recall merges both homes by rank, tags each memory with its home, and dedupes", async () => {
  const personal = fakeRoute("zyg", [memory("p1", "deploy only with Omer's ok", "person:email=omer@zyg.com"), memory("p2", "deploy notes", "person:email=omer@zyg.com")]);
  const workspace = fakeRoute("zygstinct", [memory("w1", "deploy runs through Argo", "workspace:zygstinct")]);
  const { host } = twoHomes(personal, workspace);
  const found = await host.recallWithStatus(session, { query: "deploy" });
  assert.deepEqual(found.memories.map((record) => [record.id, record.home]), [
    ["p1", "personal"],
    ["w1", "workspace"],
    ["p2", "personal"],
  ]);
  assert.deepEqual(found.degraded, []);
  assert.deepEqual(personal.calls.at(-1)!.input.scopes, ["person:email=omer@zyg.com"]);
  assert.deepEqual(workspace.calls.at(-1)!.input.scopes, ["workspace:zygstinct"]);
});

test("recall keeps the healthy home's memories and names the one that could not be read", async () => {
  const personal = fakeRoute("zyg", [memory("p1", "deploy only with Omer's ok", "person:email=omer@zyg.com")]);
  const workspace = fakeRoute("zygstinct");
  workspace.setDown(true);
  const { host } = twoHomes(personal, workspace);
  const found = await host.recallWithStatus(session, { query: "deploy" });
  assert.deepEqual(found.memories.map((record) => record.id), ["p1"]);
  assert.deepEqual(found.degraded, ["workspace"]);
  personal.setDown(true);
  await assert.rejects(host.recall(session, { query: "deploy" }), /down/);
});

test("the prompt block shows personal always-on memories first, then the workspace's, then the newest others", async () => {
  const personal = fakeRoute("zyg", [
    memory("p-pref", "Answers in three lines.", "person:email=omer@zyg.com", { category: "preference", alwaysOn: true, createdAt: "2026-11-10T00:00:00.000Z" }),
    memory("p-fact", "Wife's birthday March 3.", "person:email=omer@zyg.com", { createdAt: "2026-11-12T00:00:00.000Z" }),
  ]);
  const workspace = fakeRoute("zygstinct", [
    memory("w-pref", "Use pnpm here.", "workspace:zygstinct", { category: "preference", alwaysOn: true, createdAt: "2026-11-16T00:00:00.000Z" }),
    memory("w-fact", "Argo tracks main.", "workspace:zygstinct", { createdAt: "2026-11-15T00:00:00.000Z" }),
  ]);
  const { host } = twoHomes(personal, workspace);
  await host.warm(session);
  const block = host.promptContext(session)!;
  assert.deepEqual(
    block.entries.map((entry) => entry.fact),
    ["Answers in three lines.", "Use pnpm here.", "Argo tracks main.", "Wife's birthday March 3."],
  );
  // A later turn reads nothing: both homes come from the cache.
  const before = personal.calls.length + workspace.calls.length;
  await host.warm(session);
  host.promptContext(session);
  assert.equal(personal.calls.length + workspace.calls.length, before);
});

test("update, link and forget find the id in either home, trying the home that holds it first", async () => {
  const personal = fakeRoute("zyg", [memory("p1", "old", "person:email=omer@zyg.com")]);
  const workspace = fakeRoute("zygstinct", [memory("w1", "old", "workspace:zygstinct")]);
  const { host } = twoHomes(personal, workspace);
  const updated = await host.update(session, { id: "w1", fact: "new" });
  assert.equal(updated.content, "new");
  assert.equal(updated.home, "workspace");
  const linked = await host.link(session, { id: "p1", links: [{ sessionId: "s1" }] });
  assert.equal(linked.home, "personal");
  assert.equal(await host.forget(session, "w1"), true);
  assert.equal(workspace.held.length, 0);
  assert.equal(await host.forget(session, "nothing"), false);
  // A remembered id is tried in its own home first: no call goes to the other home.
  const record = await host.remember(session, { fact: "Argo tracks main.", category: "fact" });
  const personalCalls = personal.calls.length;
  await host.update(session, { id: record.id, fact: "Argo tracks main (zygstinct-services-values)." });
  assert.equal(personal.calls.length, personalCalls);
});

test("forget reports a failed home instead of saying the memory does not exist", async () => {
  const personal = fakeRoute("zyg");
  const workspace = fakeRoute("zygstinct", [memory("w1", "x", "workspace:zygstinct")]);
  workspace.setDown(true);
  const { host } = twoHomes(personal, workspace);
  await assert.rejects(host.forget(session, "w1"), /down/);
});

test("a single store without a home behaves as before (Marley's brand graph)", async () => {
  const brand = fakeRoute("brand:b1");
  const host = new HostMemory(
    { store: () => ({ route: brand.route, scopes: [{ id: "brand", key: { brand: "b1" } }, { id: "person", key: { brand: "b1", member: "m1" } }] as MemoryScope[] }) },
    sessions,
  );
  const fact = await host.remember(session, { fact: "Ships from Tel Aviv.", category: "fact", home: "workspace" });
  assert.equal(fact.scope, "brand:brand=b1");
  assert.equal(fact.home, undefined);
  const preference = await host.remember(session, { fact: "Voice notes, please.", category: "preference" });
  assert.equal(preference.scope, "person:brand=b1/member=m1");
  assert.equal((await host.recall(session, { query: "tel aviv" })).length, 1);
});

test("several stores must each name a distinct home", () => {
  const one = fakeRoute("a");
  const two = fakeRoute("b");
  const missing = new HostMemory({ store: () => [{ route: one.route, scopes: [WORKSPACE] }, { home: "personal", route: two.route, scopes: [PERSON] }] }, sessions);
  assert.throws(() => missing.storesOf(session), /needs a home/);
  const twice = new HostMemory({ store: () => [{ home: "personal", route: one.route, scopes: [WORKSPACE] }, { home: "personal", route: two.route, scopes: [PERSON] }] }, sessions);
  assert.throws(() => twice.storesOf(session), /Two memory stores/);
});

test("brainCapabilityRoute with a home sends it on every memory call, and only on memory calls", async () => {
  const calls: { capability: string; input: Record<string, unknown> }[] = [];
  const route = brainCapabilityRoute(
    "brain:personal",
    async (capability, input) => {
      calls.push({ capability, input });
      if (capability === "memory.delete") return { deleted: true };
      if (capability === "memory.search" || capability === "memory.list") return { memories: [] };
      return { memory: memory("m", "x", "person:email=omer@zyg.com") };
    },
    { home: "personal" },
  );
  await route.create({ content: "x", category: "fact", scope: "person:email=omer@zyg.com", alwaysOn: false, links: [] });
  await route.update({ id: "m", scopes: [], content: "y" });
  await route.link({ id: "m", scopes: [], links: [] });
  await route.delete({ id: "m", scopes: [] });
  await route.search({ query: "x", scopes: [], limit: 1 });
  await route.list({ scope: "person:email=omer@zyg.com", limit: 1 });
  assert.deepEqual(
    calls.map((call) => [call.capability, call.input.home]),
    [
      ["memory.create", "personal"],
      ["memory.update", "personal"],
      ["memory.link", "personal"],
      ["memory.delete", "personal"],
      ["memory.search", "personal"],
      ["memory.list", "personal"],
    ],
  );
  // Without a home the input is passed through unchanged.
  const plain: Record<string, unknown>[] = [];
  await brainCapabilityRoute("brain", async (_capability, input) => (plain.push(input), { memories: [] })).list({ scope: "s", limit: 1 });
  assert.equal("home" in plain[0]!, false);
});

test("the memory tools take home on remember and answer each memory's home and the degraded homes", async () => {
  const personal = fakeRoute("zyg", [memory("p1", "deploy only with Omer's ok", "person:email=omer@zyg.com")]);
  const workspace = fakeRoute("zygstinct");
  const { host } = twoHomes(personal, workspace);
  const provider = createMemoryToolsProvider(host) as unknown as {
    get(name: string): { inputSchema: { properties: Record<string, { enum?: string[] }> } };
    invoke(name: string, input: unknown, context: InvocationContext): Promise<unknown>;
  };
  const schema = provider.get("marshal.tool.remember");
  assert.deepEqual(schema.inputSchema.properties.home!.enum, ["personal", "workspace"]);
  const saved = (await provider.invoke("marshal.tool.remember", { fact: "Wife's birthday March 3.", home: "personal" }, context)) as { output: { memory: { home: string } } };
  assert.equal(saved.output.memory.home, "personal");
  workspace.setDown(true);
  const recalled = (await provider.invoke("marshal.tool.recall", { query: "deploy" }, context)) as { output: { memories: { id: string; home: string }[]; degraded?: string[]; scopes: string[] } };
  assert.deepEqual(recalled.output.memories.map((record) => [record.id, record.home]), [["p1", "personal"]]);
  assert.deepEqual(recalled.output.degraded, ["workspace"]);
  assert.deepEqual(recalled.output.scopes, ["person", "workspace"]);
});

test("the kit's default stores: a workspace home, plus a personal home only when the person is known", async () => {
  const calls: { capability: string; input: Record<string, unknown> }[] = [];
  const call = async (capability: string, input: Record<string, unknown>) => (calls.push({ capability, input }), { memories: [] });
  assert.deepEqual(companyBrainStores(call, { workspace: "page-run" }).map((store) => store.home), ["workspace"]);
  const stores = companyBrainStores(call, { workspace: "zygstinct", personEmail: " Omer@Zyg.com " });
  assert.deepEqual(stores.map((store) => [store.home, store.scopes.map(scopeString)]), [
    ["personal", ["person:email=omer@zyg.com"]],
    ["workspace", ["workspace:zygstinct"]],
  ]);
  const host = new HostMemory({ store: () => stores }, sessions);
  await host.warm(session);
  assert.deepEqual(
    calls.map((entry) => [entry.input.scope, entry.input.home]),
    [
      ["person:email=omer@zyg.com", "personal"],
      ["person:email=omer@zyg.com", "personal"],
      ["workspace:zygstinct", "workspace"],
      ["workspace:zygstinct", "workspace"],
    ],
  );
});

test("the kit's Brain configuration pins the company Brain as the personal home and keeps the workspace's own route", () => {
  const config = brainConfiguration({ brain: { cloudUrl: "https://zygstinct-front.example" }, workspaceName: "zygstinct", memoryWrites: true });
  assert.equal(config.memoryRoute, "zyg");
  const routes = config.brainRoutes as Record<string, { cloudUrl: string; memory: boolean }>;
  assert.equal(routes.zyg!.memory, true);
  assert.notEqual(routes.zyg!.cloudUrl, "https://zygstinct-front.example");
  assert.deepEqual(routes.zygstinct, { cloudUrl: "https://zygstinct-front.example", cloudAudience: "https://zygstinct-front.example", memory: true });
  const readOnly = brainConfiguration({ brain: {}, workspaceName: "zygstinct", memoryWrites: false });
  assert.equal(readOnly.memoryRoute, undefined);
});
