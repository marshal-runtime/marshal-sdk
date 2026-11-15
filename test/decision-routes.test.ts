import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { OrgClient, fetchOrgDiscovery, type UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { DecisionDesk } from "../src/decisions.js";
import { createMarshalHost } from "../src/host.js";
import { LinkClient, LinkError } from "../src/link/client.js";
import { startLinkServer } from "../src/link/server.js";
import { createOrgBridge } from "../src/org-bridge.js";
import { ConversationRoomRoute, parseAnswer, type ConversationRoomLike, type ConversationRoomRecord } from "../src/rooms-route.js";
import { FileSessionStore } from "../src/session-store.js";

const TOKEN = "decision-routes-token-0123456789";
const ADA: UserPrincipal = "user:ada@example.test";
const BOB: UserPrincipal = "user:bob@example.test";
const OPTIONS = [{ title: "Keep the hero" }, { title: "Shorter hero", description: "two lines" }];

/** Answers `echo: <last line>`, no model. */
const echo: QueryFn = ({ prompt, options }) =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${Math.random().toString(36).slice(2)}` };
    yield { type: "result", subtype: "success", is_error: false, result: `echo: ${String(prompt).split("\n").at(-1)}`, usage: {} };
  })();

/** A conversation room as the runtime's Room shows it: records, who the server says wrote them, change events. */
function fakeRoom(id: string) {
  const records = new Map<string, ConversationRoomRecord>();
  const listeners = new Set<(event: { kind: string }) => void>();
  const write = (writer: string, key: string, fields: Record<string, unknown>) => {
    records.set(key, { key, fields: { ...records.get(key)?.fields, ...fields }, updatedBy: writer });
    for (const listener of listeners) listener({ kind: "records" });
  };
  const room: ConversationRoomLike & { write: typeof write; records: typeof records } = {
    id,
    records,
    write,
    query: ({ type }) => [...records.values()].filter((record) => record.key.startsWith(`${type}:`)),
    set: async (key, fields) => write(ADA, key, fields),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return room;
}

function port() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-routes-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-q", host: { id: "e2b-42", kind: "e2b" } });
  const agents = new ClaudeAgentPort({ query: echo, store, cwd: root, env: {}, defaultModel: "test-model", systemPrompt: () => undefined, mcpServers: () => ({}) });
  return { root, store, agents };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a linked Marshal sees a host's open questions and answers one; the answer is a message from that person in the asking session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-link-"));
  fs.mkdirSync(path.join(root, "workspace"));
  const host = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    host: { id: "coder-1", kind: "container" },
    query: echo,
    link: { token: TOKEN },
  });
  try {
    const session = host.agents.launch({ task: "Write the hero", idempotencyKey: "hero" });
    await host.agents.wait(session.id, 5_000);
    const asked = await host.decisions.record({ kind: "question", text: "Which hero?", options: OPTIONS, recommendedIndex: 1, asked: true, sessionId: session.id });
    assert.deepEqual(asked.deliveries, [{ route: "link", delivered: true, ref: `${host.link!.url}/v1/decisions/${asked.id}` }]);
    await host.decisions.record({ kind: "decision", text: "Used the brand's green", sessionId: session.id });

    const client = new LinkClient({ url: host.link!.url, token: TOKEN });
    const open = await client.decisions({ kind: "question", status: "open" });
    assert.equal(open.answers, true);
    assert.deepEqual(open.decisions.map((entry: any) => [entry.id, entry.sessionId, entry.options.length]), [[asked.id, session.id, 2]]);
    assert.equal((await client.decisions({ sessionId: session.id })).decisions.length, 2);

    const answered = await client.answer(asked.id, { choice: 1, by: { name: "Omer", personId: "user:omer@zyg.com" } });
    assert.equal(answered.accepted, true);
    await host.agents.wait(session.id, 5_000);
    const delivered = host.sessions.messages(session.id).find((message) => message.from?.kind === "person");
    assert.equal(delivered?.content, `Message from Omer:\n\nAnswer to your question "Which hero?" (${asked.id}): Shorter hero`);
    assert.deepEqual(delivered?.from, { kind: "person", name: "Omer", personId: "user:omer@zyg.com" });

    await assert.rejects(client.answer(asked.id, { text: "again" }), (error: LinkError) => error.status === 409 && /already answered/.test(error.message));
    await assert.rejects(client.answer(asked.id, {}), (error: LinkError) => error.status === 400);
    const after = (await client.decisions({ kind: "question" })).decisions[0];
    assert.deepEqual([after.status, after.answer.text, after.answer.route, after.answer.by.name], ["answered", "Shorter hero", "link", "Omer"]);

    // A finished store served on its own shows the record and refuses answers.
    const store = await startLinkServer({ token: TOKEN, sessionsRoot: host.sessions.root, host: { id: "coder-1", kind: "container" } });
    try {
      const reader = new LinkClient({ url: store.url, token: TOKEN });
      const read = await reader.decisions({ kind: "question" });
      assert.deepEqual([read.answers, read.decisions[0].status], [false, "answered"]);
      await assert.rejects(reader.answer(asked.id, { choice: 0 }), (error: LinkError) => error.status === 409 && error.code === "store-only");
    } finally {
      await store.close();
    }
  } finally {
    await host.dispose();
  }
});

test("a question goes into the session's conversation room and a reply there answers it", async () => {
  const { store, agents } = port();
  const desk = new DecisionDesk(store, agents);
  const rooms = new Map<string, ReturnType<typeof fakeRoom>>();
  const route = new ConversationRoomRoute({
    owner: ADA,
    openRoom: async (roomId) => (roomId.startsWith("session:msdk-") ? (rooms.get(roomId) ?? rooms.set(roomId, fakeRoom(roomId)).get(roomId)) : undefined),
    nameOf: (who) => (who === BOB ? "Bob" : undefined),
  });
  await desk.addRoute(route);
  const session = agents.launch({ task: "Write the hero", idempotencyKey: "hero" });
  await agents.wait(session.id, 5_000);

  const asked = await desk.record({ kind: "question", text: "Which hero?", options: OPTIONS, asked: true, sessionId: session.id });
  const room = rooms.get(`session:msdk-${session.id}`)!;
  assert.deepEqual(asked.deliveries, [{ route: "room", delivered: true, ref: `${room.id}/message:ask.${asked.id}` }]);
  const question = room.records.get(`message:ask.${asked.id}`)!;
  assert.deepEqual([question.fields.role, question.fields.author, question.fields.state], ["assistant", ADA, "final"]);
  assert.match(String(question.fields.text), /Which hero\?\n1\. Keep the hero\n2\. Shorter hero — two lines\nReply with a number/);
  // Decisions and gaps stay out of the room.
  assert.equal((await desk.record({ kind: "gap", text: "No phone check", sessionId: session.id })).deliveries[0]!.delivered, false);

  // Bob types a reply that is still streaming, then finishes it: only the final one answers.
  room.write(BOB, "message:bob-1", { role: "user", author: BOB, text: "Sho", state: "streaming", turn: "t-bob", replyTo: `message:ask.${asked.id}` });
  await settle();
  assert.equal(desk.get(asked.id)!.status, "open");
  room.write(BOB, "message:bob-1", { text: "Shorter hero", state: "final" });
  await settle();
  await agents.wait(session.id, 5_000);
  const entry = desk.get(asked.id)!;
  assert.deepEqual([entry.status, entry.answer?.choice, entry.answer?.route, entry.answer?.by], ["answered", 1, "room", { personId: BOB, name: "Bob" }]);
  const delivered = store.messages(session.id).find((message) => message.from?.kind === "person");
  assert.equal(delivered?.content, `Message from Bob:\n\nAnswer to your question "Which hero?" (${asked.id}): Shorter hero`);

  // A session that is not shared in the org has no room: the delivery says so.
  const unshared = new ConversationRoomRoute({ id: "room2", owner: ADA, openRoom: async () => undefined });
  await desk.addRoute(unshared);
  const lonely = await desk.record({ kind: "question", text: "Anyone?", sessionId: session.id, to: ["room2"] });
  assert.match(lonely.deliveries[0]!.error ?? "", /not shared/);
  await desk.stop();
});

test("the next instruction posted to the session through the org answers its open question", async () => {
  const provider = createInMemoryOrgProvider({
    users: [
      { principal: ADA, email: "ada@example.test", displayName: "Ada" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
    ],
    workspaces: [{ id: "ws:pages", displayName: "Pages", repositories: [] }],
    features: ["signIn", "workspaces", "sessions", "leases", "cloudRuns", "forks", "messages", "liveSessions", "multiUser"],
    cloud: { formats: ["claude-jsonl"] },
  });
  const discovery = await fetchOrgDiscovery(provider.orgUrl, { fetch: provider.fetch });
  const clientFor = (principal: UserPrincipal) => new OrgClient({ discovery, accessToken: async () => provider.issueToken(principal), fetch: provider.fetch });
  const [ada, bob] = [clientFor(ADA), clientFor(BOB)];

  const { store, agents } = port();
  const desk = new DecisionDesk(store, agents);
  const route = new ConversationRoomRoute({ owner: ADA, openRoom: async (roomId) => fakeRoom(roomId) });
  await desk.addRoute(route);
  const session = agents.launch({ task: "Write the hero", idempotencyKey: "hero" });
  await agents.wait(session.id, 5_000);
  const bridge = createOrgBridge({ client: ada, store, agents, owner: ADA, workspaceId: "ws:pages", host: "e2b-42", nativeState: () => undefined, answers: route });
  await bridge.sync();
  const orgSessionId = `msdk-${session.id}`;
  await ada.grantSession(orgSessionId, { principal: BOB, role: "driver" });

  const asked = await desk.record({ kind: "question", text: "Which hero?", options: OPTIONS, asked: true, sessionId: session.id });
  await bob.postMessage(orgSessionId, { clientMsgId: "bob-1", text: "2" });
  await bridge.poll();
  const [turn] = await bridge.idle();
  assert.equal(turn!.final, "Answer recorded; the session has it.");
  await agents.wait(session.id, 5_000);
  const entry = desk.get(asked.id)!;
  assert.deepEqual([entry.status, entry.answer?.choice, entry.answer?.by.personId], ["answered", 1, BOB]);
  assert.ok(store.messages(session.id).some((message) => message.content.endsWith(`(${asked.id}): Shorter hero`)));

  // With no open question, the next instruction runs as an ordinary message.
  await bob.postMessage(orgSessionId, { clientMsgId: "bob-2", text: "Now the footer" });
  await bridge.poll();
  const [next] = await bridge.idle();
  assert.equal(next!.final, "echo: Now the footer");
  await bridge.close();
  await desk.stop();
});

test("a reply picks an option by number or title, anything else is free text", () => {
  const entry = { options: OPTIONS } as never;
  assert.deepEqual(parseAnswer(entry, " 2 "), { choice: 1 });
  assert.deepEqual(parseAnswer(entry, "1."), { choice: 0 });
  assert.deepEqual(parseAnswer(entry, "keep the hero"), { choice: 0 });
  assert.deepEqual(parseAnswer(entry, "3"), { text: "3" });
  assert.deepEqual(parseAnswer(entry, "Make it bold"), { text: "Make it bold" });
});
