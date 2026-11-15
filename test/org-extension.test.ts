import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { OrgClient, fetchOrgDiscovery, type UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider, createInMemoryRoomsProvider } from "@marshal/agent-runtime-org/testing";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { withManifest } from "../src/onboarding-cli.js";
import { ORG_EXTENSION, writeManifest } from "../src/onboarding.js";
import { HOST_ROOM_SCHEMA, hostRoomId } from "../src/org-host-room.js";
import { claudeNativePath } from "../src/org-publish.js";
import { connectOrgRooms } from "../src/org/rooms/index.js";

const ADA: UserPrincipal = "user:ada@example.test";
const BOB: UserPrincipal = "user:bob@example.test";
const WORKSPACE = "ws:pages" as const;
const HOST = "sdk-host-1";
const SDK_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "extensions", "org", "runtime-extension.json")) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
})();
const ORG_PACKAGE = path.join(SDK_ROOT, "extensions", "org", "out", "package");

/** Answers `echo: <last line>`, no model. */
const echo: QueryFn = ({ prompt, options }) =>
  (async function* () {
    yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? "native-1" };
    yield { type: "result", subtype: "success", is_error: false, result: `echo: ${String(prompt).split("\n").at(-1)}`, usage: {} };
  })();

/**
 * The contract's in-memory organization at https://org.fake.test, reached through the process's fetch: the extension
 * runs in this process and uses the global fetch like any host would.
 */
function orgInProcess() {
  const provider = createInMemoryOrgProvider({
    users: [
      { principal: ADA, email: "ada@example.test", displayName: "Ada" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
    ],
    workspaces: [{ id: WORKSPACE, displayName: "Pages", repositories: [] }],
    features: ["signIn", "workspaces", "sessions", "leases", "cloudRuns", "forks", "messages", "liveSessions", "multiUser"],
    cloud: { formats: ["claude-jsonl"] },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(provider.orgUrl) ? provider.fetch(url, init as never) : realFetch(input, init);
  }) as typeof fetch;
  const clientFor = async (principal: UserPrincipal) =>
    new OrgClient({ discovery: await fetchOrgDiscovery(provider.orgUrl), accessToken: async () => provider.issueToken(principal) });
  return { orgUrl: provider.orgUrl, provider, clientFor, close: () => void (globalThis.fetch = realFetch) };
}

test("@marshal/org in a headless host: joins as the person, publishes, runs a teammate's instruction, serves the host room", async () => {
  assert.ok(fs.existsSync(path.join(ORG_PACKAGE, "runtime-extension.json")), "build the extension first (node extensions/org/build.mjs)");
  const org = orgInProcess();
  const rooms = await createInMemoryRoomsProvider();
  let marshal: Awaited<ReturnType<typeof createMarshalHost>> | undefined;
  let bobRooms: ReturnType<typeof connectOrgRooms> | undefined;
  try {
  const ada = await org.clientFor(ADA);
  const bob = await org.clientFor(BOB);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-extension-"));
  fs.mkdirSync(path.join(root, "workspace"));
  // The person's own tokens, as files the run is handed (never in configuration).
  const tokenFile = path.join(root, "ada-org.token");
  fs.writeFileSync(tokenFile, `${org.provider.issueToken(ADA)}\n`, { mode: 0o600 });
  const roomsTokenFile = path.join(root, "ada-rooms.token");
  fs.writeFileSync(roomsTokenFile, rooms.issueToken(ADA), { mode: 0o600 });

  marshal = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    host: { id: HOST, kind: "container" },
    query: echo,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    extensions: [
      {
        packageRoot: ORG_PACKAGE,
        configuration: { discovery: org.orgUrl, tokenFile, workspaceId: WORKSPACE, start: false, rooms: { apiBase: rooms.apiBase, socketUrl: rooms.socketUrl, tokenFile: roomsTokenFile } },
      },
    ],
    defaultExtensions: [ORG_EXTENSION],
  });
    assert.deepEqual(
      marshal.extensions.map((extension) => [extension.identity, extension.health, extension.fromDefaults]),
      [[ORG_EXTENSION, "healthy", true]],
    );
    const launched = marshal.agents.launch({ task: "Write the hero", idempotencyKey: "hero" });
    await marshal.agents.wait(launched.id, 5_000);
    const orgSessionId = `msdk-${launched.id}`;
    // The conversation file Claude would have written; the link serves it as the checkpoint.
    const nativeFile = claudeNativePath(marshal.sessions.get(launched.id)!)!;
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, '{"type":"user","message":"Write the hero"}\n');

    const status = await marshal.invoke<Record<string, any>>("marshal.org.status");
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.deepEqual([status.person.principal, status.workspaceId, status.link, status.rooms.on, status.host.id], [ADA, WORKSPACE, true, true, HOST]);
    assert.equal(status.rooms.hostRoom, hostRoomId(HOST));

    const synced = await marshal.invoke<Record<string, any>>("marshal.org.sync");
    assert.equal(synced.ok, true, JSON.stringify(synced));
    const published = synced.published.find((result: { sessionId: string }) => result.sessionId === launched.id);
    assert.deepEqual([published.orgSessionId, published.error, published.envelope], [orgSessionId, undefined, "uploaded"]);
    const view = await ada.getSession(orgSessionId);
    assert.equal(view.session.owner, ADA, "published as the person, from their own token");
    assert.ok(view.session.title.startsWith("Write the hero"));
    assert.deepEqual((await marshal.invoke<Record<string, any>>("marshal.org.status")).sessions.map((entry: any) => [entry.orgSessionId, entry.lease, entry.live]), [[orgSessionId, "held", true]]);

    // Bob, granted the session, posts from his own Marshal; the host runs it through marshal.agent.send.
    await ada.grantSession(orgSessionId, { principal: BOB, role: "driver" });
    await bob.postMessage(orgSessionId, { clientMsgId: "bob-1", text: "Add a price" });
    const polled = await marshal.invoke<Record<string, any>>("marshal.org.poll");
    assert.equal(polled.ok, true, JSON.stringify(polled));
    assert.deepEqual(polled.turns.map((turn: any) => [turn.messages[0].author, turn.final, turn.error]), [[BOB, "echo: Add a price", undefined]]);
    const transcript = await ada.getTranscript(orgSessionId);
    const asked = transcript.messages.find((message) => message.role === "user" && message.text.endsWith("Add a price"));
    assert.equal(asked?.author, BOB, "the org names Bob as the author of the instruction he posted");
    assert.match(asked!.text, /Message from .* through the organization/);

    // The desktop-named capabilities.
    const found = await marshal.invoke<Record<string, any>>("marshal.org.sessions.search", { q: "hero" });
    assert.deepEqual(found.rows.map((row: any) => row.id), [orgSessionId]);
    assert.match(found.rows[0].title, /^<external-content source="org-session">/);
    const page = await marshal.invoke<Record<string, any>>("marshal.org.sessions.transcript", { id: orgSessionId, limit: 2 });
    assert.deepEqual([page.ok, page.messages.length, page.nextFrom], [true, 2, 2]);
    assert.ok(page.total >= 4);
    const shown = await marshal.invoke<Record<string, any>>("marshal.org.sessions.view", { targets: [{ id: orgSessionId }], idempotencyKey: "v1" });
    assert.equal(shown.ok, false);

    // The host room: Ada grants Bob driver; Bob sees the host and its session, asks for telemetry and a cancel.
    const granted = await marshal.invoke<Record<string, any>>("marshal.org.hostRoom.grant", { principal: BOB, role: "driver" });
    assert.deepEqual(granted, { ok: true, roomId: hostRoomId(HOST) });
    bobRooms = connectOrgRooms({
      endpoints: { apiBase: rooms.apiBase, socketUrl: rooms.socketUrl },
      accessToken: async () => rooms.issueToken(BOB),
      principal: BOB,
      dir: path.join(root, "bob-rooms"),
      actor: { kind: "person" },
      // A client that writes into a host room declares its kind, as @marshal/org does (the desktop transport too).
      kinds: [{ ...HOST_ROOM_SCHEMA, identity: ORG_EXTENSION }],
    });
    const room = await bobRooms.open(hostRoomId(HOST));
    const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = read();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const info = await waitFor(() => room.get("info:host")?.fields, "info:host");
    assert.equal((info.info as any).host.id, HOST);
    const record = await waitFor(() => room.get(`session:${launched.id}`)?.fields, "the session record");
    assert.deepEqual([record.orgSessionId, record.room], [orgSessionId, `session:${orgSessionId}`]);

    await room.set("request:bob-telemetry", { to: ADA, about: "info:host", text: JSON.stringify({ v: 1, method: "GET", path: `/v1/sessions/${launched.id}/telemetry` }), status: "open" });
    const done = await waitFor(() => {
      const fields = room.get("request:bob-telemetry")?.fields;
      return fields && (fields.status === "done" || fields.status === "failed") ? fields : undefined;
    }, "the telemetry answer");
    assert.equal(done.status, "done", String(done.result));
    assert.equal(done.claimedBy, ADA);
    const result = JSON.parse(String(done.result));
    assert.deepEqual([result.v, result.status, result.body.sessionId], [1, 200, launched.id]);

    // Closing the host publishes the last turn with a checkpoint and gives the lease back.
    await marshal.dispose();
    marshal = undefined;
    const lease = await ada.getLease(orgSessionId);
    assert.equal(lease.lease, null);
    // The checkpoint is the conversation file as it was published; the fake file did not change after Bob's turn.
    assert.deepEqual([lease.checkpoint?.releasedBy?.host, lease.checkpoint?.messageCount], [HOST, 3]);
  } finally {
    bobRooms?.close();
    await marshal?.dispose();
    await rooms.close();
    await org.close();
  }
});

test("a manifest that names an org loads @marshal/org by default; opting out leaves it unloaded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-default-"));
  fs.mkdirSync(path.join(root, "workspace"));
  const manifest = path.join(root, "marshal-sdk.json");
  const base = { workspacePath: path.join(root, "workspace"), stateRoot: path.join(root, "state"), browser: false as const, query: echo, env: {} };

  writeManifest(manifest, { version: 1, extensions: [], org: { discovery: "http://127.0.0.1:9/org" }, defaults: { brain: false } } as never);
  const on = await withManifest({ ...base }, { manifest, cache: path.join(root, "cache") });
  assert.deepEqual(on.defaultExtensions, [ORG_EXTENSION]);
  // No token here: the extension still loads and says why it has not joined.
  const marshal = await createMarshalHost({ ...on, extensions: on.extensions!.map((extension) => ({ ...extension, configuration: { start: false, discovery: "http://127.0.0.1:9/org" } })) });
  try {
    assert.deepEqual(marshal.extensions.map((extension) => [extension.identity, extension.health, extension.fromDefaults]), [[ORG_EXTENSION, "healthy", true]]);
    const status = await marshal.invoke<Record<string, any>>("marshal.org.status");
    assert.equal(status.ok, false);
    assert.match(status.error, /token of the person this run is for|MARSHAL_ORG_TOKEN/);
  } finally {
    await marshal.dispose();
  }

  writeManifest(manifest, { version: 1, extensions: [], org: { discovery: "http://127.0.0.1:9/org" }, defaults: { brain: false, org: false } } as never);
  const off = await withManifest({ ...base }, { manifest, cache: path.join(root, "cache") });
  assert.equal(off.defaultExtensions, undefined);
  assert.equal((off.extensions ?? []).some((extension) => extension.packageRoot.includes(`${path.sep}org${path.sep}`)), false);
});
