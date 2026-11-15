import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { RoomKindSchema, UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryRoomsProvider } from "@marshal/agent-runtime-org/testing";

import { connectOrgRooms, type OrgRoomsConnection } from "../src/org/rooms/index.js";

const ADA: UserPrincipal = "user:ada@zyg.com";
const BOB: UserPrincipal = "user:bob@zyg.com";
const KINDS: (RoomKindSchema & { identity: string })[] = [{ identity: "@test/board", kind: "board", schemaVersion: 1, records: { card: { fields: { title: "value", n: "value" } } } }];

async function waitFor<T>(read: () => T | undefined | false, what: string, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function world() {
  const provider = await createInMemoryRoomsProvider({ drainMs: 20 });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "org-rooms-client-"));
  const connect = (principal: UserPrincipal, name: string): OrgRoomsConnection =>
    connectOrgRooms({
      endpoints: { apiBase: provider.apiBase, socketUrl: provider.socketUrl },
      orgId: "org-test",
      accessToken: async () => provider.issueToken(principal),
      principal,
      name,
      clientId: `host-${name}`,
      dir: path.join(base, name),
      kinds: KINDS,
      socket: { baseBackoffMs: 20, maxBackoffMs: 60 },
    });
  const ada = connect(ADA, "ada");
  const bob = connect(BOB, "bob");
  const close = async () => {
    ada.close();
    bob.close();
    await provider.close();
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { provider, ada, bob, close };
}

test("rooms client: a chosen id is idempotent, a grant lets Bob in, records and requests travel both ways, presence is seen", async () => {
  const { ada, bob, close } = await world();
  try {
    const id = "board-1";
    const first = await ada.createRoom({ id, kind: "@test/board/board", schemaVersion: 1, workspaceId: "ws:pages", title: "Board" });
    const second = await ada.createRoom({ id, kind: "@test/board/board", schemaVersion: 1, workspaceId: "ws:pages", title: "Board" });
    assert.equal(first.id, id);
    assert.equal(second.id, id);
    assert.equal((await ada.list({ workspaceId: "ws:pages" })).filter((room) => room.id === id).length, 1);

    await assert.rejects(bob.open(id), (error: { code?: string }) => error.code === "forbidden" || error.code === "gone");
    await ada.grant(id, BOB, "driver");
    const bobRoom = await bob.open(id);
    assert.equal(bobRoom.role, "driver");

    const seen: string[] = [];
    bobRoom.subscribe((event) => {
      if (event.kind === "records") for (const change of event.changes) if (!change.pending) seen.push(change.record);
    });
    await first.set("card:1", { title: "Hello", n: 1 });
    await waitFor(() => bobRoom.get("card:1")?.fields.title === "Hello", "Bob to see Ada's card");
    assert.ok(seen.includes("card:1"));

    // A request: Bob asks, Ada claims and finishes it.
    await bobRoom.set("request:r1", { to: ADA, text: "Please review", status: "open", about: "card:1" });
    await waitFor(() => first.get("request:r1")?.fields.status === "open", "Ada to see the request");
    await first.set("request:r1", { status: "claimed", claimedBy: ADA });
    await first.set("request:r1", { status: "done", result: "looks good" });
    const done = await waitFor(() => (bobRoom.get("request:r1")?.fields.status === "done" ? bobRoom.get("request:r1") : undefined), "Bob to see the request done");
    assert.equal(done.fields.result, "looks good");
    assert.equal(done.fields.claimedBy, ADA);

    // A card the kind does not declare is refused before it leaves.
    await assert.rejects(first.set("card:2", { nope: 1 }), (error: { code?: string }) => error.code === "unknown-field");

    first.presence.set({ at: "card:1" });
    await waitFor(() => bobRoom.presence.all().some((entry) => entry.principal === ADA && (entry.state as { at?: string }).at === "card:1"), "Ada's presence");
  } finally {
    await close();
  }
});

test("rooms client: a conversation room carries a message whose text grows by appends, and survives the bus losing its state", async () => {
  const { provider, ada, bob, close } = await world();
  try {
    const id = "session:msdk-s1";
    const room = await ada.createRoom({ id, kind: "marshal/conversation", schemaVersion: 1, workspaceId: "ws:pages", title: "Session" });
    await ada.grant(id, BOB, "collaborator");
    const bobRoom = await bob.open(id);

    await room.set("message:m1", { role: "user", author: ADA, text: "Hello", state: "streaming", turn: "t1" });
    const text = room.text("message:m1", "text");
    await text.splice(text.value().length, 0, ", world");
    await room.set("message:m1", { state: "final" });
    await waitFor(() => bobRoom.get("message:m1")?.fields.state === "final" && bobRoom.text("message:m1", "text").value() === "Hello, world", "Bob to read the final message");

    // The bus forgets everything (as a Redis failover would); the records stay and new writes still arrive.
    await provider.loseBusState();
    await room.set("message:m2", { role: "assistant", author: ADA, text: "after the reset", state: "final", turn: "t1", replyTo: "message:m1" });
    await waitFor(() => bobRoom.get("message:m2") !== undefined, "Bob to see a message written after the reset");
    assert.equal(bobRoom.query({ type: "message" }).length, 2);
    assert.equal(bobRoom.text("message:m1", "text").value(), "Hello, world");
  } finally {
    await close();
  }
});
