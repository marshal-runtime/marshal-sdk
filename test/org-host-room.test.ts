import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  HOST_ROOM_FULL_KIND,
  HostRoomEndpoint,
  hostRoomId,
  httpLinkRelay,
  parseHostRoomRequest,
  type HostRoomLike,
  type HostRoomsLike,
} from "../src/org-host-room.js";
import { orgSessionIdOf } from "../src/org-publish.js";
import { startLinkServer } from "../src/link/server.js";
import { FileSessionStore } from "../src/session-store.js";

const TOKEN = "host-room-link-token-0123456789";

/** A room as the runtime's rooms API shows one, in memory: records, presence, one subscriber list. */
function fakeRooms() {
  const rooms = new Map<string, ReturnType<typeof fakeRoom>>();
  const created: { id: string; kind: string }[] = [];
  const api: HostRoomsLike = {
    async open(id) {
      const room = rooms.get(id);
      if (!room) throw new Error(`no room ${id}`);
      return room;
    },
    async createRoom(input) {
      created.push({ id: input.id, kind: input.kind });
      if (!rooms.has(input.id)) rooms.set(input.id, fakeRoom(input.id));
      return rooms.get(input.id)!;
    },
  };
  return { api, rooms, created };
}

function fakeRoom(id: string) {
  const records = new Map<string, { fields: Record<string, unknown>; updatedBy: string }>();
  const listeners = new Set<(event: { kind: string }) => void>();
  const presence: unknown[] = [];
  const files = new Map<string, string>();
  const write = (key: string, fields: Record<string, unknown>, by: string) => {
    records.set(key, { fields: { ...(records.get(key)?.fields ?? {}), ...fields }, updatedBy: by });
    for (const listener of listeners) listener({ kind: "records" });
  };
  const room: HostRoomLike & { write: typeof write; presenceLog: unknown[]; files: NonNullable<HostRoomLike["files"]>; stored: Map<string, string> } = {
    id,
    get: (key) => records.get(key),
    query: ({ type }) => [...records].filter(([key]) => key.startsWith(`${type}:`)).map(([key, value]) => ({ key, ...value })),
    set: async (key, fields) => write(key, fields, "user:ada@example.test"),
    delete: async (key) => {
      records.delete(key);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    presence: { set: (state) => presence.push(state) },
    files: {
      async put(file, contentType) {
        const text = fs.readFileSync(file, "utf8");
        const sha256 = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
        files.set(sha256, text);
        return { sha256, bytes: Buffer.byteLength(text), contentType };
      },
    },
    write,
    presenceLog: presence,
    stored: files,
  };
  return room;
}

function hostState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-room-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-h", host: { id: "coder-1", kind: "container" } });
  const session = store.create({ title: "Page Studio · section hero", runtime: "claude", native: { kind: "claude", cwd: root } });
  store.appendMessage(session.id, { role: "user", content: "Write the hero" });
  store.appendMessage(session.id, { role: "assistant", content: "x".repeat(70_000) });
  store.update(session.id, { state: "running" });
  fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(root, "workspace", "notes.md"), "# notes\n");
  return { root, store, session };
}

const request = (body: Record<string, unknown>) => JSON.stringify({ v: 1, ...body });

test("the host room shows the host and its sessions and answers cancel, telemetry and files requests with link payloads", async () => {
  const { root, store, session } = hostState();
  const cancelled: string[] = [];
  const link = await startLinkServer({
    token: TOKEN,
    sessionsRoot: store.root,
    host: { id: "coder-1", kind: "container" },
    files: { workspace: path.join(root, "workspace") },
    live: {
      send: () => ({}),
      cancel: (id) => {
        cancelled.push(id);
        store.update(id, { state: "idle" });
        return {};
      },
      invoke: async () => ({}),
      extensions: () => [{ identity: "@marshal/org", version: "0.1.0" }],
      capabilities: async () => ["marshal.agent.list"],
    },
  });
  const { api, rooms, created } = fakeRooms();
  const endpoint = new HostRoomEndpoint({
    rooms: api,
    hostId: "coder-1",
    workspaceId: "ws:pages",
    owner: "user:ada@example.test",
    relay: httpLinkRelay(link.url, () => TOKEN),
    orgSessionIdOf,
    refreshMs: 60_000,
  });
  try {
    await endpoint.start();
    assert.deepEqual(created, [{ id: hostRoomId("coder-1"), kind: HOST_ROOM_FULL_KIND }]);
    const room = rooms.get("host.coder-1")!;
    const info = room.get("info:host")!.fields;
    assert.equal((info.info as { host: { id: string } }).host.id, "coder-1");
    assert.equal(info.owner, "user:ada@example.test");
    const record = room.get(`session:${session.id}`)!.fields;
    assert.equal((record.session as { state: string }).state, "running");
    assert.equal(record.orgSessionId, `msdk-${session.id}`);
    assert.equal(record.room, `session:msdk-${session.id}`);
    assert.deepEqual(room.presenceLog.at(-1), { ...(room.presenceLog.at(-1) as object), v: 1, host: "coder-1", running: 1 });

    // Bob (a driver) asks; the host claims and answers each one.
    const ask = (id: string, body: Record<string, unknown>) => room.write(`request:${id}`, { to: "user:ada@example.test", text: request(body), status: "open" }, "user:bob@example.test");
    ask("t1", { method: "GET", path: `/v1/sessions/${session.id}/telemetry` });
    ask("f1", { method: "GET", path: "/v1/files", query: { root: "workspace", path: "" } });
    ask("r1", { method: "GET", path: "/v1/files/read", query: { root: "workspace", path: "notes.md" } });
    ask("big", { method: "GET", path: `/v1/sessions/${session.id}/transcript` });
    ask("bad", { method: "POST", path: "/v1/invoke", body: { capability: "x" } });
    ask("other", { method: "GET", path: "/v1/info" });
    room.write("request:other", { to: "user:carol@example.test" }, "user:bob@example.test");
    ask("missing", { method: "GET", path: "/v1/sessions/nope/telemetry" });
    ask("c1", { method: "POST", path: `/v1/sessions/${session.id}/cancel` });
    await endpoint.drain();

    const result = (key: string) => {
      const fields = room.get(`request:${key}`)!.fields;
      return { status: fields.status, claimedBy: fields.claimedBy, result: fields.result ? JSON.parse(String(fields.result)) : undefined };
    };
    const telemetry = result("t1");
    assert.deepEqual([telemetry.status, telemetry.claimedBy, telemetry.result.status, telemetry.result.body.sessionId], ["done", "user:ada@example.test", 200, session.id]);
    assert.ok("telemetry" in telemetry.result.body);
    assert.deepEqual(result("f1").result.body.entries.map((entry: { name: string }) => entry.name), ["notes.md"]);
    assert.equal(result("r1").result.body.content ?? result("r1").result.body.text, "# notes\n");
    const big = result("big");
    assert.equal(big.status, "done");
    assert.ok(big.result.file && big.result.bytes > 31_000, "a transcript over the record size goes as a room file");
    assert.equal(JSON.parse(room.stored.get(big.result.file.sha256)!).messages.length, 2);
    assert.deepEqual([result("bad").status, result("bad").result.error.code], ["failed", "invalid-request"]);
    assert.equal(result("other").status, "open", "a request to someone else is left alone");
    assert.deepEqual([result("missing").status, result("missing").result.status, result("missing").result.error.code], ["failed", 404, "not-found"]);
    assert.equal(result("c1").status, "done");
    assert.deepEqual(cancelled, [session.id]);
    assert.equal((room.get(`session:${session.id}`)!.fields.session as { state: string }).state, "idle", "a POST refreshes the session records");
    assert.ok(!JSON.stringify([...rooms.values()].map((value) => value.query({ type: "info" }))).includes(TOKEN));
  } finally {
    await endpoint.stop();
    await link.close();
  }
});

test("only v1 requests on offered link routes are accepted, and long polls are dropped", () => {
  assert.equal(parseHostRoomRequest("not json"), undefined);
  assert.equal(parseHostRoomRequest(JSON.stringify({ v: 2, method: "GET", path: "/v1/info" })), undefined);
  assert.equal(parseHostRoomRequest(JSON.stringify({ v: 1, method: "GET", path: "/v1/sessions/a/events" })), undefined);
  assert.equal(parseHostRoomRequest(JSON.stringify({ v: 1, method: "DELETE", path: "/v1/info" })), undefined);
  assert.deepEqual(parseHostRoomRequest(JSON.stringify({ v: 1, method: "GET", path: "/v1/sessions/a/transcript", query: { waitMs: "30000", tail: "20", n: 3 } })), {
    v: 1,
    method: "GET",
    path: "/v1/sessions/a/transcript",
    query: { tail: "20" },
  });
  assert.equal(hostRoomId("coder 1/x"), "host.coder-1-x");
});
