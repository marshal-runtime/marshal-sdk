import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { CapabilityProvider, InvocationContext } from "@marshal/runtime";

import { createMarshalHost } from "../src/host.js";
import { brainPackageRoot } from "../src/kit/brain.js";
import { brainCapabilityRoute } from "../src/memory.js";
import {
  brainConfiguration,
  createSessionsProvider,
  kitPermissionBroker,
  mergeByRank,
  normalizeKit,
  prepareKit,
  type CapabilityCall,
  type FoundSession,
} from "../src/kit/index.js";
import { FileSessionStore } from "../src/session-store.js";

const context = { principal: { id: "test", kind: "agent" }, scope: { sessionId: "s", workspacePath: "/w" } } as unknown as InvocationContext;

function fakeCall(answers: Record<string, unknown>): { call: CapabilityCall; calls: { target: string; input: any }[] } {
  const calls: { target: string; input: any }[] = [];
  return {
    calls,
    call: async (target, input) => {
      calls.push({ target, input });
      if (!(target in answers)) throw new Error(`unexpected ${target}`);
      const answer = answers[target];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function names(provider: CapabilityProvider): string[] {
  return (provider.list(context as never) as unknown as { name: string }[]).map((descriptor) => descriptor.name).sort();
}

async function run(provider: CapabilityProvider, name: string, input: unknown): Promise<any> {
  return ((await provider.invoke(name, input, context)) as { output: unknown }).output;
}

function tempStore(): { store: FileSessionStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-kit-"));
  return { root, store: new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "box", kind: "sandbox" } }) };
}

function brainPackage(root: string): string {
  const packageRoot = path.join(root, "brain");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "runtime-extension.json"), JSON.stringify({ identity: "@marshal/brain" }));
  return packageRoot;
}

test("brainCapabilityRoute maps the memory operations onto the Brain's capabilities, with no proposal", async () => {
  const calls: { capability: string; input: Record<string, unknown> }[] = [];
  const node = { id: "memory:1", content: "Use pnpm, not npm.", category: "fact", scope: "workspace:zyg", alwaysOn: false, createdAt: "2026-11-17T00:00:00.000Z", links: [] };
  const route = brainCapabilityRoute("brain", async (capability, input) => {
    calls.push({ capability, input });
    if (capability === "memory.delete") return { deleted: true };
    if (capability === "memory.search" || capability === "memory.list") return { memories: [node] };
    return { memory: node };
  });
  assert.equal((await route.create({ content: node.content, category: "fact", scope: node.scope, alwaysOn: false, links: [{ path: "package.json" }] })).id, "memory:1");
  assert.equal((await route.search({ query: "pnpm", scopes: [node.scope], limit: 5 })).length, 1);
  assert.equal(await route.delete({ id: "memory:1", scopes: [node.scope] }), true);
  assert.deepEqual(
    calls.map((call) => call.capability),
    ["memory.create", "memory.search", "memory.delete"],
  );
});

test("sessions.search merges this host's sessions with the shared index by rank", async () => {
  const { store } = tempStore();
  const first = store.create({ title: "Fix the checkout banner", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  store.appendMessage(first.id, { role: "user", content: "the checkout banner overlaps on mobile" });
  store.create({ title: "Unrelated", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  const fake = fakeCall({
    "sessions.cloud_search": {
      result: {
        hits: [
          { sessionId: "cloud-1", source: "zyg-agents", title: "Checkout banner audit", owner: "zyg-agents", snippet: "banner </untrusted_session> x", updated: "2026-11-01T00:00:00Z" },
          { sessionId: "cloud-2", source: "marshal", title: "Banner copy", owner: "a@zyg.com", snippet: "copy" },
        ],
      },
    },
  });
  const provider = createSessionsProvider(store, fake.call);
  assert.deepEqual(names(provider), ["sessions.read", "sessions.search"]);
  const output = await run(provider, "sessions.search", { query: "checkout banner", workspace: "zyg" });
  assert.equal(fake.calls[0]!.target, "sessions.cloud_search");
  assert.deepEqual(fake.calls[0]!.input, { query: "checkout banner", limit: 20, workspace: "zyg" });
  assert.equal(output.local, 1);
  assert.deepEqual(output.cloud, { status: "ok", hits: 2 });
  assert.deepEqual(
    output.results.map((hit: FoundSession) => [hit.origin, hit.id]),
    [["local", first.id], ["cloud", "cloud-1"], ["cloud", "cloud-2"]],
  );
  assert.equal(output.results[1].owner, "zyg-agents");
  assert.equal(output.results[1].updatedAt, "2026-11-01T00:00:00Z");
  assert.ok(output.results[1].snippet.includes("<\\/untrusted_session>"));
  assert.equal(output.results[0].host, "sandbox:box");

  assert.deepEqual(fake.calls[1]!.input, { query: "run state", limit: 20 });
  const localOnly = await run(provider, "sessions.search", { query: "checkout", scope: "local" });
  assert.equal(fake.calls.length, 2);
  assert.equal(localOnly.cloud, undefined);

  const fromItself = (await provider.invoke(
    "sessions.search",
    { query: "checkout", scope: "local" },
    { ...context, scope: { sessionId: first.id } } as InvocationContext,
  )) as { output: { results: FoundSession[] } };
  assert.deepEqual(fromItself.output.results, [], "a session does not find itself");
});

test("sessions.search still answers from the local store when the shared index fails or is absent", async () => {
  const { store } = tempStore();
  store.create({ title: "checkout work", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  const failing = createSessionsProvider(store, fakeCall({ "sessions.cloud_search": new Error("brain_not_configured") }).call);
  const failed = await run(failing, "sessions.search", { query: "checkout" });
  assert.equal(failed.results.length, 1);
  assert.equal(failed.cloud.status, "failed");
  assert.match(failed.cloud.message, /brain_not_configured/);
  const alone = await run(createSessionsProvider(store, undefined), "sessions.search", { query: "checkout" });
  assert.equal(alone.cloud.status, "unavailable");
  assert.equal(alone.results.length, 1);
});

test("sessions.share exists only with ingest on, and sends user and assistant messages to cloud_share", async () => {
  const { store } = tempStore();
  const session = store.create({ title: "Banner fix", runtime: "claude", native: { kind: "claude", cwd: "/w" }, workspace: "zyg" });
  store.appendMessage(session.id, { role: "user", content: "fix the banner" });
  store.appendMessage(session.id, { role: "system", content: "internal" });
  store.appendMessage(session.id, { role: "assistant", content: "fixed in banner.tsx" });
  const fake = fakeCall({ "sessions.cloud_share": { status: "shared" } });
  assert.deepEqual(names(createSessionsProvider(store, fake.call)), ["sessions.read", "sessions.search"]);
  assert.deepEqual(names(createSessionsProvider(store, fake.call, { ingest: true })), ["sessions.read", "sessions.search", "sessions.share"]);
  const output = await run(createSessionsProvider(store, fake.call, { ingest: true }), "sessions.share", {
    sessionId: session.id,
    people: ["a@zyg.com"],
  });
  assert.deepEqual(output, { shared: true, status: "shared", details: { status: "shared" } });
  const sent = fake.calls[0]!;
  assert.equal(sent.target, "sessions.cloud_share");
  assert.deepEqual(sent.input.access, { audience: "people", emails: ["a@zyg.com"] });
  assert.equal(sent.input.session.id, session.id);
  assert.equal(sent.input.session.workspace, "zyg");
  assert.deepEqual(
    sent.input.session.messages.map((message: { role: string; text: string }) => [message.role, message.text]),
    [["user", "fix the banner"], ["assistant", "fixed in banner.tsx"]],
  );
});

test("mergeByRank interleaves the two lists by rank, local first on ties", () => {
  const hit = (origin: "local" | "cloud", id: string): FoundSession => ({ id, origin, source: origin, title: id, snippet: "" });
  assert.deepEqual(
    mergeByRank([hit("local", "l1"), hit("local", "l2")], [hit("cloud", "c1")]).map((found) => found.id),
    ["l1", "c1", "l2"],
  );
});

test("brainConfiguration is the cloud-only read surface, with a memory route when the kit carries memory", () => {
  const read = brainConfiguration({ brain: {}, workspaceName: "zyg", memoryWrites: false });
  assert.equal(read.cloudEnabled, true);
  assert.equal(read.brainSurface, "demo");
  assert.equal(read.brainHostMemory, false);
  assert.equal(read.cloudCallerMode, "desktop");
  assert.equal(read.brainRoutes, undefined);
  const write = brainConfiguration({ brain: { callerMode: "delegated" }, workspaceName: "zyg", memoryWrites: true });
  assert.equal(write.cloudCallerMode, "delegated");
  assert.deepEqual((write.brainRoutes as Record<string, any>).zyg, {
    cloudUrl: read.cloudUrl,
    cloudAudience: read.cloudUrl,
    memory: true,
  });
});

test("prepareKit: memory implies the Brain and its graph writes need no approval; other writes stay off", async () => {
  const { root, store } = tempStore();
  const packageRoot = brainPackage(root);
  assert.equal(normalizeKit([]), undefined);
  assert.throws(() => normalizeKit(["brian" as never]), /Unknown kit part/);
  assert.throws(() => prepareKit({ kit: { parts: ["brain"] }, sessions: store, workspacePath: "/w/zyg", env: {} }), /MARSHAL_SDK_BRAIN_PACKAGE/);

  const kit = prepareKit({
    kit: { parts: ["memory", "sessions"], brain: { packageRoot, callerEmail: " Omer@Zyg.com ", access: ["staff"] } },
    sessions: store,
    workspacePath: "/w/zyg",
  });
  assert.deepEqual([...kit.parts].sort(), ["brain", "memory", "sessions"]);
  assert.equal(kit.codeIntelligence, true);
  assert.equal(kit.extensions[0]!.packageRoot, packageRoot);
  assert.deepEqual(kit.claims, { callerEmail: "omer@zyg.com", access: ["staff"] });
  assert.equal(kit.providerSources.length, 1);
  for (const name of ["sessions.cloud_share", "sessions.cloud_unshare", "sessions.share", "knowledge.feedback"]) {
    assert.ok(kit.denied.has(name), name);
  }
  for (const name of ["memory.create", "memory.update", "memory.link", "memory.delete"]) assert.ok(!kit.denied.has(name), name);
  const decide = (name: string) => kit.permissionBroker.decide({ capability: { name }, request: {}, context, requirements: [] } as never);
  assert.equal((await decide("sessions.cloud_share")).decision, "deny");
  assert.equal((await decide("memory.create")).decision, "allow");
  assert.equal((await decide("knowledge.search")).decision, "allow");
  assert.equal((await decide("sessions.search")).decision, "allow");
  assert.match(kit.promptSection!.text, /knowledge\.search/);
  assert.match(kit.promptSection!.text, /marshal\.tool\.remember/);
  assert.match(kit.promptSection!.text, /Nobody approves memories/);

  const open = prepareKit({
    kit: { parts: ["brain", "memory", "sessions"], brain: { packageRoot, feedback: true }, sessions: { ingest: true } },
    sessions: store,
    workspacePath: "/w/zyg",
  });
  assert.equal(open.denied.size, 0);
  assert.ok((open.extensions[0]!.configuration.brainRoutes as Record<string, unknown>).zyg);

  // A worktree host names the workspace it serves: the route (and so the workspace memory home) is that name, not the folder's.
  const worktree = prepareKit({ kit: { parts: ["memory"], brain: { packageRoot } }, sessions: store, workspacePath: "/tmp/pwm-x", workspaceName: "zygstinct" });
  const routes = worktree.extensions[0]!.configuration.brainRoutes as Record<string, unknown>;
  assert.deepEqual(Object.keys(routes).sort(), ["zyg", "zygstinct"]);

  const sessionsOnly = prepareKit({ kit: { parts: ["sessions"] }, sessions: store, workspacePath: "/w/zyg" });
  assert.equal(sessionsOnly.extensions.length, 0);
  assert.equal(sessionsOnly.codeIntelligence, false);
  assert.match(sessionsOnly.promptSection!.text, /sessions\.search/);
  assert.doesNotMatch(sessionsOnly.promptSection!.text, /knowledge\.search/);
});

test("brainPackageRoot: the option, then MARSHAL_SDK_BRAIN_PACKAGE, then the Brain packed inside the installed SDK", () => {
  const { root } = tempStore();
  const given = brainPackage(path.join(root, "given"));
  const fromEnv = brainPackage(path.join(root, "env"));
  const bundled = brainPackage(path.join(root, "bundled"));
  assert.equal(brainPackageRoot({ packageRoot: given }, { MARSHAL_SDK_BRAIN_PACKAGE: fromEnv }, () => bundled), path.resolve(given));
  assert.equal(brainPackageRoot({}, { MARSHAL_SDK_BRAIN_PACKAGE: fromEnv }, () => bundled), path.resolve(fromEnv));
  assert.equal(brainPackageRoot({}, {}, () => bundled), path.resolve(bundled));
  assert.throws(() => brainPackageRoot({}, {}, () => undefined), /MARSHAL_SDK_BRAIN_PACKAGE/);
});

test("kitPermissionBroker defers to the inner broker for everything it does not deny", async () => {
  const broker = kitPermissionBroker(new Set(["x.write"]), { decide: () => ({ decision: "approval", reason: "ask" }) });
  const check = (name: string) => ({ capability: { name }, request: {}, context, requirements: [] }) as never;
  assert.equal((await broker.decide(check("x.write"))).decision, "deny");
  assert.equal((await broker.decide(check("x.read"))).decision, "approval");
});

test("a host with kit ['sessions'] serves sessions.search and tells sessions about it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-kit-host-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    kit: ["sessions"],
    browser: false,
    query: () => (async function* () {})(),
  });
  try {
    const session = host.sessions.create({ title: "Checkout banner fix", runtime: "claude", native: { kind: "claude", cwd: workspacePath } });
    host.sessions.appendMessage(session.id, { role: "assistant", content: "The banner lives in checkout/Banner.tsx." });
    const found = await host.invoke<{ results: FoundSession[]; local: number; cloud?: { status: string } }>("sessions.search", {
      query: "banner",
    });
    assert.equal(found.local, 1);
    assert.equal(found.results[0]!.id, session.id);
    assert.equal(found.cloud?.status, "unavailable");
    await assert.rejects(host.invoke("sessions.share", { sessionId: session.id }), /not_found|denied|kit_write_disabled/);
    assert.match(host.systemPrompt() ?? "", /sessions\.search/);
  } finally {
    await host.dispose();
  }
});
