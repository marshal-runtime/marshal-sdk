import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { OrgClient, fetchOrgDiscovery, type UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { createOrgBridge, isTestOrg, type OrgBridgeClient } from "../src/org-bridge.js";
import { FileSessionStore } from "../src/session-store.js";

const ADA: UserPrincipal = "user:ada@example.test";
const BOB: UserPrincipal = "user:bob@example.test";
const CAROL: UserPrincipal = "user:carol@example.test";
const WORKSPACE = "ws:pages" as const;
const HOST = "e2b-42";

/** The contract's in-memory organization with the inbox and live sessions on. */
async function org() {
  const provider = createInMemoryOrgProvider({
    users: [
      { principal: ADA, email: "ada@example.test", displayName: "Ada" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
      { principal: CAROL, email: "carol@example.test", displayName: "Carol" },
    ],
    workspaces: [{ id: WORKSPACE, displayName: "Pages", repositories: [] }],
    features: ["signIn", "workspaces", "sessions", "leases", "cloudRuns", "forks", "messages", "liveSessions", "multiUser"],
    cloud: { formats: ["claude-jsonl"] },
  });
  const discovery = await fetchOrgDiscovery(provider.orgUrl, { fetch: provider.fetch });
  const clientFor = (principal: UserPrincipal) =>
    new OrgClient({ discovery, accessToken: async () => provider.issueToken(principal), fetch: provider.fetch });
  return { ada: clientFor(ADA), bob: clientFor(BOB), carol: clientFor(CAROL) };
}

/** Answers `echo: <last line>`, no model. */
const echo: QueryFn = ({ prompt, options }) =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? "native-1" };
    yield { type: "result", subtype: "success", is_error: false, result: `echo: ${String(prompt).split("\n").at(-1)}`, usage: {} };
  })();

function host() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-bridge-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-7", host: { id: HOST, kind: "e2b" } });
  const session = store.create({ title: "Page Studio · section hero", runtime: "claude", native: { kind: "claude", sessionId: "native-1", cwd: root } });
  store.appendMessage(session.id, { role: "user", content: "Write the hero" });
  store.appendMessage(session.id, { role: "assistant", content: "<section>hero</section>" });
  store.update(session.id, { state: "idle" });
  const agents = new ClaudeAgentPort({
    query: echo,
    store,
    cwd: root,
    env: {},
    defaultModel: "test-model",
    systemPrompt: () => undefined,
    mcpServers: () => ({}),
  });
  // The native state grows with the transcript, so every turn leaves a new checkpoint.
  const nativeState = () => new TextEncoder().encode(JSON.stringify(store.messages(session.id)));
  return { store, agents, session, nativeState };
}

test("a person granted the session drives it from their own Marshal through the org inbox", async () => {
  const { ada, bob, carol } = await org();
  const { store, agents, session, nativeState } = host();
  const bridge = createOrgBridge({ client: ada, store, agents, owner: ADA, workspaceId: WORKSPACE, host: HOST, nativeState, nameOf: (who) => (who === BOB ? "Bob" : undefined) });

  await bridge.sync();
  const [entry] = bridge.sessions();
  assert.deepEqual([entry!.orgSessionId, entry!.lease, entry!.live], [`msdk-${session.id}`, "held", true]);
  assert.deepEqual(await ada.getSessionLive(entry!.orgSessionId), { enabled: true, participantTurnsPerDay: 20, host: HOST });

  await ada.grantSession(entry!.orgSessionId, { principal: BOB, role: "driver" });
  const posted = await bob.postMessage(entry!.orgSessionId, { clientMsgId: "bob-1", text: "Make the hero shorter" });
  assert.equal(posted.status, "queued");
  // Carol has no role: the org refuses her before anything reaches the host.
  await assert.rejects(carol.postMessage(entry!.orgSessionId, { clientMsgId: "carol-1", text: "Delete everything" }), (error: { status?: number }) => error.status === 404);

  const { started } = await bridge.poll();
  assert.deepEqual(started, [session.id]);
  const [turn] = await bridge.idle();
  assert.equal(turn!.error, undefined);
  assert.equal(turn!.final, "echo: Make the hero shorter");
  assert.deepEqual(turn!.messages.map((message) => message.author), [BOB]);

  // In the host's session: Bob's message with his sender line, and the answer.
  const local = store.messages(session.id);
  assert.equal(local.at(-2)!.content, "Message from Bob:\n\nMake the hero shorter");
  assert.deepEqual(local.at(-2)!.from, { kind: "person", personId: BOB, name: "Bob" });
  assert.equal(local.at(-1)!.content, "echo: Make the hero shorter");

  // In the org: Bob's message is done with the turn, the transcript names him, and a checkpoint covers the turn.
  const inbox = await bob.listMessages(entry!.orgSessionId);
  assert.deepEqual(inbox.messages.map((message) => [message.status, message.turnId]), [["done", turn!.turnId]]);
  const transcript = await bob.getTranscript(entry!.orgSessionId);
  const bobs = transcript.messages.find((message) => message.text.endsWith("Make the hero shorter"));
  assert.equal(bobs?.author, BOB);
  assert.equal(transcript.messages.at(-1)!.text, "echo: Make the hero shorter");
  const lease = await ada.getLease(entry!.orgSessionId);
  assert.equal(lease.lease?.holder.host, HOST, "the host holds the lease again after the checkpoint");
  assert.equal(lease.checkpoint?.messageCount, transcript.messages.length);

  // The owner's own instruction runs the same way, and nothing is left pending.
  await ada.postMessage(entry!.orgSessionId, { clientMsgId: "ada-1", text: "Ship it" });
  await bridge.poll();
  const [second] = await bridge.idle();
  assert.equal(second!.final, "echo: Ship it");
  assert.deepEqual((await ada.listLivePending({ host: HOST })).sessions, []);

  await bridge.close();
  assert.equal((await ada.getLease(entry!.orgSessionId)).lease, null, "close gives the lease back");
});

test("a session the owner takes to their own desktop is left to them", async () => {
  const { ada } = await org();
  const { store, agents, nativeState } = host();
  const bridge = createOrgBridge({ client: ada, store, agents, owner: ADA, workspaceId: WORKSPACE, host: HOST, nativeState });
  await bridge.sync();
  const [entry] = bridge.sessions();
  await ada.postMessage(entry!.orgSessionId, { clientMsgId: "ada-1", text: "Continue" });
  await ada.acquireLease(entry!.orgSessionId, { host: "ada-mac", force: true });
  // Her queued instruction went back to her desktop with the lease: the host has nothing to run.
  await bridge.poll();
  assert.deepEqual(await bridge.idle(), []);
  await bridge.heartbeat();
  assert.equal(bridge.sessions()[0]!.lease, "lost");
  // The next sync does not take it back.
  await bridge.sync();
  assert.equal(bridge.sessions()[0]!.lease, "elsewhere");
  assert.equal((await ada.getLease(entry!.orgSessionId)).lease?.holder.host, "ada-mac");
  await bridge.close();
});

test("writing to a real organization is off unless the owner turns it on", () => {
  const { store, agents } = host();
  const real = { discovery: { apiBase: "https://org.zyg.com/api" }, supports: () => true } as unknown as OrgBridgeClient;
  const base = { store, agents, owner: ADA, workspaceId: WORKSPACE, host: HOST };
  assert.throws(() => createOrgBridge({ ...base, client: real }), (error: { code?: string }) => error.code === "production-org-off");
  assert.doesNotThrow(() => createOrgBridge({ ...base, client: real, allowProductionOrg: true }));
  assert.deepEqual(
    ["http://127.0.0.1:9000", "https://org.fake.test", "https://acme.example", "https://org.zyg.com", "https://zyg.test.com", "not a url"].map(isTestOrg),
    [true, true, true, false, false, false],
  );
});

test("a host created with org publishes its sessions and runs what people post, until it is disposed", async () => {
  const { ada, bob } = await org();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-bridge-host-"));
  fs.mkdirSync(path.join(root, "workspace"));
  const marshal = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    host: { id: HOST, kind: "e2b" },
    query: echo,
    org: { client: ada, owner: ADA, workspaceId: WORKSPACE, start: false, nativeState: () => undefined },
  });
  try {
    const launched = marshal.agents.launch({ task: "Write the hero", idempotencyKey: "hero" });
    await marshal.agents.wait(launched.id, 5_000);
    await marshal.org!.sync();
    const orgSessionId = `msdk-${launched.id}`;
    assert.equal((await ada.getSession(orgSessionId)).session.title.startsWith("Write the hero"), true);
    await ada.grantSession(orgSessionId, { principal: BOB, role: "collaborator" });
    await bob.postMessage(orgSessionId, { clientMsgId: "bob-1", text: "Add a price" });
    await marshal.org!.poll();
    const [turn] = await marshal.org!.idle();
    assert.equal(turn!.final, "echo: Add a price");
    assert.equal((await bob.getTranscript(orgSessionId)).messages.at(-1)!.text, "echo: Add a price");
  } finally {
    await marshal.dispose();
  }
  assert.equal((await ada.getLease(`msdk-${marshal.sessions.list()[0]!.id}`)).lease, null);
});
