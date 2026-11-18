// Memories loaded when needed (Omer R153): with the kit's company Brain, a session's memory block holds only the memories
// a search with its task finds and a judgement keeps, with their ids; a host's own store (Marley) keeps the newest block.
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideRelevance, HostMemory, RELEVANT_FALLBACK, type BrainMemory, type BrainMemoryRoute, type MemoryStore, type RelevanceJudge } from "../src/memory.js";
import type { SessionRecord, SessionStore } from "../src/session-store.js";

const session = { id: "s1", title: "Page" } as SessionRecord;
const other = { id: "s2", title: "Page" } as SessionRecord;
const sessions = { get: (id: string) => (id === "s1" ? session : id === "s2" ? other : undefined) } as unknown as SessionStore;

const memory = (id: string, content: string, scope: string, extra: Partial<BrainMemory> = {}): BrainMemory => ({ id, content, category: "fact", scope, alwaysOn: false, createdAt: "2026-11-17T08:00:00.000Z", links: [], ...extra });

/** A Brain store whose search returns its memories in order (rank = position) and records every call. */
function rankedRoute(id: string, held: BrainMemory[]) {
  const calls: { op: string; input: any }[] = [];
  let down = false;
  const route: BrainMemoryRoute = {
    id,
    create: async () => assert.fail("no writes here"),
    update: async () => assert.fail("no writes here"),
    link: async () => assert.fail("no writes here"),
    delete: async (input) => (calls.push({ op: "delete", input }), true),
    search: async (input) => {
      calls.push({ op: "search", input });
      if (down) throw new Error(`${id} is down`);
      return held.filter((record) => input.scopes.includes(record.scope)).slice(0, input.limit);
    },
    list: async (input) => (
      calls.push({ op: "list", input }),
      held.filter((record) => record.scope === input.scope && (input.alwaysOn === undefined || record.alwaysOn === input.alwaysOn)).slice(0, input.limit)
    ),
  };
  return { route, calls, setDown: (value: boolean) => (down = value) };
}

const personal = () =>
  rankedRoute("zyg", [
    memory("p-rawdog", "RAWDOG hero CTA reads 'Get My Morning Eye Fix'.", "person:email=omer@zyg.com", { category: "preference", alwaysOn: true }),
    memory("p-three", "Answers in three lines.", "person:email=omer@zyg.com", { category: "preference", alwaysOn: true }),
  ]);
const workspace = () =>
  rankedRoute("page-run", [
    memory("w-guarantee", "RAWDOG pages: the guarantee line reads '60-day empty-jar guarantee'.", "workspace:page-run"),
    memory("w-argo", "Argo tracks main.", "workspace:page-run"),
    memory("w-bio", "BioVelvet pages use the lilac palette.", "workspace:page-run"),
    memory("w-gcs", "Runs live under page-generation-runs/.", "workspace:page-run"),
  ]);

/** The kit's default stores reach HostMemory as its fallback, which turns on `relevant` mode. */
function kitHost(options: { judge?: RelevanceJudge; personalRoute?: ReturnType<typeof rankedRoute>; workspaceRoute?: ReturnType<typeof rankedRoute> } = {}) {
  const p = options.personalRoute ?? personal();
  const w = options.workspaceRoute ?? workspace();
  const stores: MemoryStore[] = [
    { home: "personal", route: p.route, scopes: [{ id: "person", key: { email: "omer@zyg.com" } }] },
    { home: "workspace", route: w.route, scopes: [{ id: "workspace", key: {}, name: "page-run" }] },
  ];
  const host = new HostMemory({ fallback: () => stores, ...(options.judge ? { relevance: options.judge } : {}) }, sessions);
  return { host, personal: p, workspace: w };
}

const keeps = (...ids: string[]): RelevanceJudge => async () => new Set(ids);

test("a session's first turn searches both homes with its task; only the memories the judgement keeps are rendered, with ids", async () => {
  const seen: { task: string; ids: string[] }[] = [];
  const judge: RelevanceJudge = async ({ task, memories }) => (seen.push({ task, ids: memories.map((record) => record.id) }), new Set(["w-guarantee", "p-rawdog"]));
  const { host, personal: p, workspace: w } = kitHost({ judge });
  const lines: string[] = [];
  await host.warm(session, (line) => lines.push(line), "Build a RAWDOG eye cream landing page.");
  assert.deepEqual(p.calls.map((call) => [call.op, call.input.query, call.input.scopes]), [["search", "Build a RAWDOG eye cream landing page.", ["person:email=omer@zyg.com"]]]);
  assert.deepEqual(w.calls.map((call) => call.op), ["search"], "no blanket list read");
  assert.deepEqual(seen[0]!.ids, ["p-rawdog", "w-guarantee", "p-three", "w-argo", "w-bio", "w-gcs"], "homes interleaved by rank");
  const block = host.promptContext(session)!;
  assert.deepEqual(
    block.entries.map((entry) => entry.fact),
    ["RAWDOG hero CTA reads 'Get My Morning Eye Fix'. (memory p-rawdog)", "RAWDOG pages: the guarantee line reads '60-day empty-jar guarantee'. (memory w-guarantee)"],
  );
  assert.ok(lines.some((line) => /2 of 6 memories loaded by relevance \(judged\).*p-rawdog \[personal\].*w-guarantee \[workspace\]/.test(line)), lines.join("\n"));
  // Later turns reuse the choice: no new search.
  await host.warm(session, undefined, "Now make the hero bolder.");
  assert.equal(p.calls.length + w.calls.length, 2);
});

test("an always-on memory the judgement drops is not rendered: nothing is loaded just for being always-on", async () => {
  const { host } = kitHost({ judge: keeps("w-bio") });
  await host.warm(other, undefined, "BioVelvet serum page");
  assert.deepEqual(host.promptContext(other)!.entries.map((entry) => entry.fact), ["BioVelvet pages use the lilac palette. (memory w-bio)"]);
});

test("the judgement keeping nothing leaves the session without a memory block", async () => {
  const { host } = kitHost({ judge: keeps() });
  await host.warm(session, undefined, "Unrelated task");
  assert.equal(host.promptContext(session), undefined);
});

test("without a judgement (or when it fails) the top hits by search rank are kept", async () => {
  const failing: RelevanceJudge = async () => {
    throw new Error("No key for decisions");
  };
  const lines: string[] = [];
  const { host } = kitHost({ judge: failing });
  await host.warm(session, (line) => lines.push(line), "RAWDOG page");
  assert.equal(host.promptContext(session)!.entries.length, RELEVANT_FALLBACK);
  assert.ok(lines.some((line) => line.includes("search rank only (No key for decisions)")));
  const bare = kitHost();
  await bare.host.warm(session, undefined, "RAWDOG page");
  assert.equal(bare.host.promptContext(session)!.entries.length, RELEVANT_FALLBACK);
});

test("a turn with no task, or every home down, holds nothing and the next turn searches again", async () => {
  const p = personal();
  const w = workspace();
  p.setDown(true);
  w.setDown(true);
  const { host } = kitHost({ judge: keeps("w-guarantee"), personalRoute: p, workspaceRoute: w });
  await host.warm(session, undefined, "  ");
  assert.equal(p.calls.length, 0);
  await host.warm(session, undefined, "RAWDOG page");
  assert.equal(host.promptContext(session), undefined);
  p.setDown(false);
  w.setDown(false);
  await host.warm(session, undefined, "RAWDOG page");
  assert.deepEqual(host.promptContext(session)!.entries.map((entry) => entry.fact), ["RAWDOG pages: the guarantee line reads '60-day empty-jar guarantee'. (memory w-guarantee)"]);
});

test("one home down: the other home's memories still load", async () => {
  const p = personal();
  p.setDown(true);
  const { host } = kitHost({ judge: keeps("w-guarantee", "p-rawdog"), personalRoute: p });
  await host.warm(session, undefined, "RAWDOG page");
  assert.deepEqual(host.promptContext(session)!.entries.map((entry) => entry.fact), ["RAWDOG pages: the guarantee line reads '60-day empty-jar guarantee'. (memory w-guarantee)"]);
});

test("the search query is the task, whitespace folded, cut to the Brain's 500 characters", async () => {
  const { host, workspace: w } = kitHost({ judge: keeps() });
  await host.warm(session, undefined, `RAWDOG\n\n  page ${"x".repeat(900)}`);
  const query = w.calls[0]!.input.query as string;
  assert.equal(query.length, 500);
  assert.ok(query.startsWith("RAWDOG page x"));
});

test("a host's own store keeps the newest block (Marley); promptMemories switches either way", async () => {
  const w = workspace();
  const store: MemoryStore = { route: w.route, scopes: [{ id: "workspace", key: {}, name: "page-run" }] };
  const marley = new HostMemory({ store: () => store, relevance: keeps() }, sessions);
  await marley.warm(session, undefined, "anything");
  assert.equal(marley.promptContext(session)!.entries.length, 4);
  assert.ok(w.calls.every((call) => call.op === "list"));
  const opted = new HostMemory({ store: () => store, promptMemories: "relevant", relevance: keeps("w-argo") }, sessions);
  await opted.warm(session, undefined, "deploy");
  assert.deepEqual(opted.promptContext(session)!.entries.map((entry) => entry.fact), ["Argo tracks main. (memory w-argo)"]);
});

test("relevantLimit caps the block", async () => {
  const p = personal();
  const w = workspace();
  const stores: MemoryStore[] = [{ home: "workspace", route: w.route, scopes: [{ id: "workspace", key: {}, name: "page-run" }] }, { home: "personal", route: p.route, scopes: [{ id: "person", key: { email: "omer@zyg.com" } }] }];
  const host = new HostMemory({ fallback: () => stores, relevantLimit: 2, relevance: keeps("w-guarantee", "w-argo", "w-bio", "p-three") }, sessions);
  await host.warm(session, undefined, "task");
  assert.equal(host.promptContext(session)!.entries.length, 2);
});

test("decideRelevance asks one yes/no question per memory over the task and keeps those at or above the threshold", async () => {
  let request: any;
  const judge = decideRelevance(async (asked) => {
    request = asked;
    return { answers: { m0: { type: "noul", noul: 0.91 }, m1: { type: "noul", noul: 0.12 }, m2: { type: "noul", noul: 0.5 } }, model: "test", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1 };
  });
  const kept = await judge({
    task: "RAWDOG page",
    memories: [memory("a", "RAWDOG rule", "workspace:x"), memory("b", "BioVelvet rule", "workspace:x"), memory("c", "Plain words", "person:email=o@z.com")],
  });
  assert.deepEqual([...kept], ["a", "c"]);
  assert.deepEqual(request.state, { task: "RAWDOG page", memories: { m0: "RAWDOG rule", m1: "BioVelvet rule", m2: "Plain words" } });
  assert.deepEqual(Object.keys(request.questions), ["m0", "m1", "m2"]);
  assert.equal(request.questions.m0.type, "noul");
  assert.deepEqual([...(await judge({ task: "x", memories: [] }))], []);
});
