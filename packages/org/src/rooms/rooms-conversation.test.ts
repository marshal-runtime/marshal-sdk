import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createInMemoryRoomsProvider,
  type InMemoryRoomsProvider,
} from "@marshal/agent-runtime-org/testing";
import type { InvocationContext } from "@marshal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createOrgRoomsProvider } from "../../../../electron/marshal-runtime/org-rooms-provider";
import { OrgRoomsService } from "./org-rooms-service";
import { conversationRoomId } from "./rooms-conversation";

const DANA = "user:dana@example.com";
const GUY = "user:guy@example.com";
const SESSION = "os-7f3a";
const ROOM = conversationRoomId(SESSION);
const WORKSPACE = { workspaceId: "ws:platform", title: "Pricing page" };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await cleanup
    .splice(0)
    .reverse()
    .reduce<Promise<void>>((previous, step) => previous.then(step), Promise.resolve());
});

async function rooms(): Promise<InMemoryRoomsProvider> {
  const provider = await createInMemoryRoomsProvider({ drainMs: 5 });
  cleanup.push(() => provider.close());
  return provider;
}

/** One desktop as main.ts composes the rooms service; `s-agent` is a local Claude session. */
async function desktop(provider: InMemoryRoomsProvider, person: `user:${string}`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-conversation-"));
  const token = provider.issueToken(person);
  const service = new OrgRoomsService({
    endpoint: async () => ({
      orgId: "org-test",
      apiBase: provider.apiBase,
      socketUrl: provider.socketUrl,
    }),
    token: async () => token,
    person: async () => person,
    root,
    createSocket: (url) => new WebSocket(url),
    declarationsOf: async () => [
      {
        kind: "conversation",
        schemaVersion: 1,
        records: { message: { fields: { text: "value" } } },
      },
    ],
    applicationOf: (context) =>
      context.metadata?.marshalApplicationInvocation === "app-token"
        ? { foreground: true, extension: "marshal" }
        : undefined,
    describeSession: (sessionId) =>
      sessionId === "s-agent" ? { runtime: "claude", model: "opus" } : undefined,
  });
  cleanup.push(() => {
    service.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.start();
  const room = service.conversation(SESSION);
  if (!room) throw new Error("rooms should be on");
  return { service, room, token };
}

async function sharedConversation() {
  const provider = await rooms();
  const dana = await desktop(provider, DANA);
  const guy = await desktop(provider, GUY);
  expect(await dana.room.open(WORKSPACE)).toMatchObject({ id: ROOM, role: "owner" });
  // Pack 85's in-memory service has no session memberships yet; a grant stands in for the session's.
  const grant = await fetch(`${provider.apiBase}/v1/rooms/${encodeURIComponent(ROOM)}/grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${dana.token}`, "content-type": "application/json" },
    body: JSON.stringify({ principal: GUY, role: "viewer" }),
  });
  expect(grant.ok).toBe(true);
  expect(await guy.room.open(WORKSPACE)).toMatchObject({ id: ROOM, role: "viewer" });
  await vi.waitFor(() => {
    expect(dana.service.manager?.socket.isJoined(ROOM)).toBe(true);
    expect(guy.service.manager?.socket.isJoined(ROOM)).toBe(true);
  });
  return { provider, dana, guy };
}

describe("conversation rooms for host code", () => {
  it("opens or creates the room by org session id; opening again is idempotent", async () => {
    const { dana, guy } = await sharedConversation();
    expect(await dana.room.open(WORKSPACE)).toMatchObject({ id: ROOM, role: "owner" });
    expect(guy.room.status()).toMatchObject({
      id: ROOM,
      role: "viewer",
      kind: "marshal/conversation",
    });
  });

  it("a person's message and their agent's streamed reply reach the other desktop with their actors", async () => {
    const { dana, guy } = await sharedConversation();
    await dana.room.writeMessage({ kind: "person" }, "m-1", {
      role: "user",
      author: DANA,
      text: "Make the pricing table responsive",
      state: "final",
      turn: "t-1",
    });
    const agent = { kind: "agent", sessionId: "s-agent" } as const;
    await dana.room.writeMessage(agent, "m-2", {
      role: "assistant",
      author: DANA,
      text: "",
      state: "streaming",
      turn: "t-1",
    });
    await dana.room.appendText(agent, "m-2", "On it: ");
    await dana.room.appendText(agent, "m-2", "switching to a card grid ");
    await dana.room.appendText(agent, "m-2", "below 640px.");
    await dana.room.updateMessage(agent, "m-2", { state: "final" });

    await vi.waitFor(() => {
      expect(guy.room.messages().map((message) => [message.key, message.fields])).toEqual([
        [
          "message:m-1",
          {
            role: "user",
            author: DANA,
            text: "Make the pricing table responsive",
            state: "final",
            turn: "t-1",
          },
        ],
        [
          "message:m-2",
          {
            role: "assistant",
            author: DANA,
            text: "On it: switching to a card grid below 640px.",
            state: "final",
            turn: "t-1",
          },
        ],
      ]);
    });
    const actors = guy.service.manager
      ?.history(ROOM)
      .map((change) => [
        change.record,
        change.actor.kind,
        "session" in change.actor ? change.actor : undefined,
      ]);
    expect(actors?.[0]).toEqual(["message:m-1", "person", undefined]);
    expect(actors?.at(-1)).toEqual([
      "message:m-2",
      "agent",
      { kind: "agent", host: "desktop", session: "s-agent", runtime: "claude", model: "opus" },
    ]);
  });

  it("refuses a viewer's writes and malformed messages before they leave", async () => {
    const { dana, guy } = await sharedConversation();
    const message = { role: "user", author: GUY, text: "hi", state: "final", turn: "t-2" } as const;
    await expect(guy.room.writeMessage({ kind: "person" }, "m-9", message)).rejects.toMatchObject({
      code: "read-only",
    });
    await expect(
      // @ts-expect-error a role the conversation does not allow
      dana.room.writeMessage({ kind: "person" }, "m-9", { ...message, role: "system" }),
    ).rejects.toMatchObject({ code: "invalid-value", field: "role" });
    await expect(
      dana.room.writeMessage({ kind: "person" }, "bad key/", { ...message, author: DANA }),
    ).rejects.toMatchObject({ code: "invalid-key" });
  });

  it("deletes a message, and presence with the agent strip reaches the other desktop", async () => {
    const { dana, guy } = await sharedConversation();
    await dana.room.writeMessage({ kind: "person" }, "m-1", {
      role: "user",
      author: DANA,
      text: "draft",
      state: "final",
      turn: "t-1",
    });
    await dana.room.deleteMessage({ kind: "person" }, "m-1");
    const agent = { kind: "agent", sessionId: "s-agent" } as const;
    // @ts-expect-error a state without the presence version is not a conversation presence state
    expect(() => dana.room.setPresence(agent, { agent: { busy: true } })).toThrow(
      expect.objectContaining({ code: "invalid-value" }),
    );
    dana.room.setPresence(agent, {
      v: 1,
      open: true,
      agent: {
        busy: true,
        step: "Editing pricing.tsx",
        tasks: [{ title: "grid", status: "in-progress" }],
      },
    });
    await vi.waitFor(() => {
      expect(guy.room.messages()).toEqual([]);
      expect(guy.room.presence()).toMatchObject([
        {
          principal: DANA,
          actor: { kind: "agent", session: "s-agent", runtime: "claude" },
          state: { v: 1, open: true, agent: { busy: true, step: "Editing pricing.tsx" } },
        },
      ]);
    });
  });

  it("no extension reads or writes a conversation room, whatever it declares", async () => {
    const { guy } = await sharedConversation();
    const capabilities = createOrgRoomsProvider(guy.service);
    // An extension whose identity is "marshal" declaring "conversation" would otherwise match the kind.
    const screen: InvocationContext = {
      principal: { id: "marshal-runtime-host", kind: "agent" },
      metadata: { runtimeExtensionIdentity: "marshal", marshalApplicationInvocation: "app-token" },
    };
    const call = async (operation: string, input: unknown) =>
      (await capabilities.invoke(`marshal.org.rooms.${operation}`, input, screen)).output;
    expect(await call("query", { roomId: ROOM })).toMatchObject({
      ok: false,
      error: "unknown-type",
    });
    expect(await call("open", { roomId: ROOM })).toMatchObject({
      ok: false,
      error: "unknown-type",
    });
    expect(
      await call("set", { roomId: ROOM, key: "message:x", fields: { text: "forged" } }),
    ).toMatchObject({ ok: false, error: "unknown-type" });
    expect(await call("list", {})).toMatchObject({ ok: true, rooms: [] });
  });
});
