// The personal home's reads are bound to the signed-in person throughout: the startup fallback (memory_start off, refused or failed)
// and the ordinary reads (`newest` lists, `relevant` search) keep no personal content on an uncertain or changed identity,
// and the workspace home keeps its own routing. Synthetic people and routes only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { HostMemory, type BrainMemory, type BrainMemoryRoute, type MemoryStore } from "../src/memory.js";
import type { SessionRecord, SessionStore } from "../src/session-store.js";

const session = { id: "s1" } as SessionRecord;
const sessions = { get: () => session } as unknown as SessionStore;
const A = "person-a@zyg.com";
const B = "person-b@zyg.com";
const PERSON_A = { id: "person", key: { email: A } };
const WORKSPACE = { id: "workspace", key: {}, name: "zygstinct" };
const memory = (id: string, content: string, scope: string, alwaysOn = true): BrainMemory => ({ id, content, category: "preference", scope, alwaysOn, createdAt: "2026-11-20T08:00:00.000Z", links: [] });
const mineA = memory("a1", "A: own preference", `person:email=${A}`);
const ofB = memory("b1", "B: other person's preference", `person:email=${B}`);
const team = memory("w1", "TEAM: another person's always-on rule", "workspace:zygstinct");

function route(id: string, rows: () => BrainMemory[], hooks: { onList?: () => Promise<void> | void; start?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const r: BrainMemoryRoute = {
    id,
    create: async () => { throw new Error("no"); },
    update: async () => { throw new Error("no"); },
    link: async () => { throw new Error("no"); },
    delete: async () => false,
    search: async (input) => { calls.push("search"); await hooks.onList?.(); return rows().filter((m) => input.scopes.includes(m.scope) || m.scope.startsWith("person:")); },
    // A Brain that ignores the scope it is given answers whatever the caller it knows can read: the rows below, whatever the scope asked.
    list: async (input) => { calls.push("list"); await hooks.onList?.(); return rows().filter((m) => m.alwaysOn === input.alwaysOn); },
    ...(hooks.start ? { start: async () => { calls.push("start"); return hooks.start!(); } } : {}),
  };
  return { route: r, calls };
}

function rig(options: { personalRows: () => BrainMemory[]; signedIn?: () => Promise<string | undefined>; memoryStart?: boolean; mode?: "newest" | "relevant"; onList?: () => Promise<void> | void; start?: () => Promise<unknown> }) {
  const personal = route("zyg", options.personalRows, { onList: options.onList, start: options.start });
  const workspace = route("zygstinct", () => [team]);
  const stores: MemoryStore[] = [
    { home: "workspace", route: workspace.route, scopes: [WORKSPACE] },
    { home: "personal", route: personal.route, scopes: [PERSON_A] },
  ];
  const logs: string[] = [];
  const host = new HostMemory({
    store: () => stores,
    promptMemories: options.mode ?? "newest",
    relevance: async ({ memories }) => new Set(memories.map((m) => m.id)),
    queries: async () => ({ queries: ["x"], task: "x" }),
    ...(options.signedIn ? { signedIn: options.signedIn } : {}),
    ...(options.memoryStart ? { memoryStart: true } : {}),
  }, sessions);
  const facts = () => (host.promptContext(session)?.entries ?? []).map((entry) => entry.fact);
  return { host, personal, workspace, logs, facts, warm: () => host.warm(session, (line) => logs.push(line), "do the task") };
}

test("no sign-in probe, fallback reads: an answer carrying another person's memory is discarded whole; the workspace routing is unchanged", async () => {
  const r = rig({ personalRows: () => [mineA, ofB] });
  await r.warm();
  assert.ok(!r.facts().some((f) => f.includes("A: own") || f.includes("B: other")), r.facts().join("|"));
  assert.ok(r.facts().some((f) => f.includes("TEAM:")), "the workspace home is still read in the ordinary mode");
  assert.ok(r.logs.some((l) => l.includes("another person's memories")));
});

test("no sign-in probe: the person's own rows load as before, and a workspace row through the personal route is not theirs", async () => {
  const r = rig({ personalRows: () => [mineA, team] });
  await r.warm();
  assert.ok(r.facts().includes("A: own preference"));
  assert.equal(r.facts().filter((f) => f.includes("TEAM:")).length, 1, "the team row is shown once, from the workspace home, not through the personal route");
});

test("start refused (fallback): the block holds the person's own rows only, and nothing at all when the answer carries another person's", async () => {
  const own = rig({ personalRows: () => [mineA, team], memoryStart: true, start: async () => { throw new Error("refused"); } });
  await own.warm();
  assert.deepEqual(own.facts(), ["A: own preference"]);
  const foreign = rig({ personalRows: () => [mineA, ofB], memoryStart: true, start: async () => { throw new Error("refused"); } });
  await foreign.warm();
  assert.deepEqual(foreign.facts(), []);
});

test("relevant mode, fallback after a refused start: another person's hit discards the personal hits whole; the workspace is not read for it", async () => {
  const r = rig({ personalRows: () => [mineA, ofB], memoryStart: true, mode: "relevant", start: async () => { throw new Error("refused"); } });
  await r.warm();
  assert.deepEqual(r.facts(), []);
  const ok = rig({ personalRows: () => [mineA], memoryStart: true, mode: "relevant", start: async () => { throw new Error("refused"); } });
  await ok.warm();
  assert.deepEqual(ok.facts(), ["A: own preference (memory a1)"]);
});

test("signed-in probe: another person (or none, or an unreadable sign-in) is not asked at all; the workspace home is still read", async () => {
  for (const who of [B, undefined, "throw"]) {
    const r = rig({ personalRows: () => [mineA], signedIn: async () => { if (who === "throw") throw new Error("unreadable"); return who; } });
    await r.warm();
    assert.deepEqual(r.personal.calls, [], `${who}: personal home never asked`);
    assert.ok(!r.facts().some((f) => f.includes("A: own")));
    assert.ok(r.facts().some((f) => f.includes("TEAM:")));
  }
});

test("signed-in probe, the person is confirmed before and after: the rows load; the probe is case-insensitive", async () => {
  const r = rig({ personalRows: () => [mineA], signedIn: async () => A.toUpperCase() });
  await r.warm();
  assert.ok(r.facts().includes("A: own preference"));
});

test("the sign-in changes DURING the read: nothing from that read is kept or shown, and the held rows are dropped", async () => {
  let who: string | undefined = A;
  const r = rig({ personalRows: () => [mineA], signedIn: async () => who, onList: () => { who = B; } });
  await r.warm();
  assert.ok(!r.facts().some((f) => f.includes("A: own")), r.facts().join("|"));
  assert.ok(r.logs.some((l) => l.includes("sign-in changed during the read")));
  who = A; // back to the host's person: the next turn reads afresh
  const again = rig({ personalRows: () => [mineA], signedIn: async () => A });
  await again.warm();
  assert.ok(again.facts().includes("A: own preference"));
});

test("held personal rows do not outlive the sign-in: the next turn after a change shows none of them", async () => {
  let who: string | undefined = A;
  const r = rig({ personalRows: () => [mineA], signedIn: async () => who });
  await r.warm();
  assert.ok(r.facts().includes("A: own preference"));
  who = B;
  await r.warm();
  assert.ok(!r.facts().some((f) => f.includes("A: own")));
  who = A;
  await r.warm();
  assert.ok(r.facts().includes("A: own preference"));
});

test("a start answer in flight when the sign-in changes is dropped, and the fallback then reads nothing personal", async () => {
  let who: string | undefined = A;
  const r = rig({ personalRows: () => [mineA], memoryStart: true, signedIn: async () => who, start: async () => { who = B; return { workspace: "zygstinct", current: true, rules: [{ id: "r1", text: "STARTRULE" }] }; } });
  await r.warm();
  assert.deepEqual(r.facts(), []);
  assert.ok(r.logs.some((l) => l.includes("start answer was read; it was dropped")));
});

test("a start answer for the confirmed person is shown (the binding does not disturb the start path)", async () => {
  const r = rig({ personalRows: () => [mineA], memoryStart: true, signedIn: async () => A, start: async () => ({ workspace: "zygstinct", current: true, rules: [{ id: "r1", text: "STARTRULE" }] }) });
  await r.warm();
  assert.ok(r.facts().some((f) => f.includes("STARTRULE")));
});

test("a held start answer does not outlive the sign-in either: after a change the next turn shows none of it", async () => {
  let who: string | undefined = A;
  const r = rig({ personalRows: () => [mineA], memoryStart: true, signedIn: async () => who, start: async () => ({ workspace: "zygstinct", current: true, rules: [{ id: "r1", text: "STARTRULE" }] }) });
  await r.warm();
  assert.ok(r.facts().some((f) => f.includes("STARTRULE")));
  who = B;
  await r.warm();
  assert.deepEqual(r.facts(), []);
});

import { defaultSignedInOf } from "../src/memory.js";

test("the default personal home's identity: a delegated or service-key principal confirms its person; a desktop sign-in cannot be confirmed from a configured address", async () => {
  const kit = { kitMemory: true, ownStore: false, ownProbe: false };
  assert.equal(await defaultSignedInOf({ callerMode: "delegated", callerEmail: " Person-A@zyg.com " }, kit)!(), A);
  assert.equal(await defaultSignedInOf({ callerMode: "service-key", callerEmail: A }, kit)!(), A);
  for (const brain of [{ callerEmail: A }, { callerMode: "desktop", callerEmail: A }, { callerMode: "delegated" }, undefined])
    assert.equal(await defaultSignedInOf(brain, kit)!(), undefined, "no live identity: the configured address is not proof");
  assert.equal(defaultSignedInOf({ callerMode: "desktop", callerEmail: A }, { ...kit, ownProbe: true }), undefined, "a host's own probe is used as given");
  assert.equal(defaultSignedInOf({ callerMode: "desktop", callerEmail: A }, { ...kit, ownStore: true }), undefined, "a host's own store is not touched");
  assert.equal(defaultSignedInOf({ callerMode: "desktop", callerEmail: A }, { ...kit, kitMemory: false }), undefined);
});

test("with the default probe (desktop mode) the personal fallback keeps no personal rows and the workspace rules stay; with a confirming probe the person's own rows are kept", async () => {
  const unconfirmed = rig({ personalRows: () => [mineA], signedIn: defaultSignedInOf({ callerMode: "desktop", callerEmail: A }, { kitMemory: true, ownStore: false, ownProbe: false }) });
  await unconfirmed.warm();
  assert.ok(!unconfirmed.facts().some((f) => f.includes("A: own")), unconfirmed.facts().join("|"));
  assert.ok(unconfirmed.facts().some((f) => f.includes("TEAM:")), "the workspace path is unchanged");
  const fixed = rig({ personalRows: () => [mineA], signedIn: defaultSignedInOf({ callerMode: "delegated", callerEmail: A }, { kitMemory: true, ownStore: false, ownProbe: false }) });
  await fixed.warm();
  assert.ok(fixed.facts().some((f) => f.includes("A: own")), fixed.facts().join("|"));
  assert.ok(fixed.facts().some((f) => f.includes("TEAM:")));
});

test("a personal list that carries the person's own project and page scopes under their scope is kept (the Brain lists what is under a scope); another person's scope still discards the whole read", async () => {
  const project = memory("a2", "A: project preference", `person:email=${A}/project=zygstinct`);
  const own = rig({ personalRows: () => [mineA, project] });
  await own.warm();
  assert.ok(own.facts().some((f) => f.includes("A: own preference")), own.facts().join("|"));
  assert.ok(!own.facts().some((f) => f.includes("A: project preference")), "only the scope asked for is this block");
  const mixed = rig({ personalRows: () => [mineA, project, ofB] });
  await mixed.warm();
  assert.ok(!mixed.facts().some((f) => f.includes("A: own") || f.includes("B: other")), mixed.facts().join("|"));
});
