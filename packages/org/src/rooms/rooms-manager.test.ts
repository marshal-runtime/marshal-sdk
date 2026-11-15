import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RoomEvent, RoomKindSchema } from "@marshal/agent-runtime-org";
import {
  createInMemoryRoomsProvider,
  type InMemoryRoomsProvider,
} from "@marshal/agent-runtime-org/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";

import { OrgRoomsManager, type RoomsCaller } from "./rooms-manager";

const EXTENSION = "@test/shared-page";
const SCHEMA: RoomKindSchema = {
  kind: "page",
  schemaVersion: 1,
  records: { section: { fields: { headline: "value", body: "value", pos: "position" } } },
};
const PERSON: RoomsCaller = {
  extension: EXTENSION,
  actor: { kind: "person" },
  declarations: [SCHEMA],
};
const DANA = "user:dana@example.com";
const GUY = "user:guy@example.com";

const managers: OrgRoomsManager[] = [];
const dirs: string[] = [];
const providers: InMemoryRoomsProvider[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function service(): Promise<InMemoryRoomsProvider> {
  const provider = await createInMemoryRoomsProvider({ drainMs: 5 });
  providers.push(provider);
  return provider;
}

/** A desktop's network: sockets it opened, and a switch that drops them and refuses new ones. */
class Network {
  online = true;
  connects = 0;
  private readonly live = new Set<WebSocket>();
  constructor(private readonly provider: InMemoryRoomsProvider) {}
  connect = (url: string): WebSocket => {
    this.connects += 1;
    const socket = new WebSocket(this.online ? url : url.replace(/:\d+\//, ":1/"));
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
    socket.on("error", () => undefined);
    return socket;
  };
  down(): void {
    this.online = false;
    for (const socket of this.live) socket.terminate();
  }
  get socketUrl(): string {
    return this.provider.socketUrl;
  }
}

function desktop(provider: InMemoryRoomsProvider, person: `user:${string}`, root?: string) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
  if (!root) dirs.push(dir);
  const network = new Network(provider);
  const token = provider.issueToken(person);
  const manager = new OrgRoomsManager({
    endpoint: { orgId: "org-test", apiBase: provider.apiBase, socketUrl: provider.socketUrl },
    token: async () => token,
    person: async () => person,
    root: dir,
    createSocket: network.connect,
    socket: { baseBackoffMs: 5, maxBackoffMs: 40, random: () => 0.5, retryMs: 20 },
  });
  managers.push(manager);
  manager.start();
  return { manager, network, token };
}

async function grant(
  provider: InMemoryRoomsProvider,
  ownerToken: string,
  roomId: string,
  principal: string,
  role: string,
) {
  const response = await fetch(`${provider.apiBase}/v1/rooms/${roomId}/grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ principal, role }),
  });
  expect(response.status).toBeLessThan(300);
}

async function revoke(
  provider: InMemoryRoomsProvider,
  ownerToken: string,
  roomId: string,
  principal: string,
) {
  const response = await fetch(
    `${provider.apiBase}/v1/rooms/${roomId}/grants/${encodeURIComponent(principal)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerToken}` },
    },
  );
  expect(response.status).toBeLessThan(300);
}

async function joined(manager: OrgRoomsManager, roomId: string): Promise<void> {
  await vi.waitFor(() => expect(manager.socket.isJoined(roomId)).toBe(true), { timeout: 3000 });
}

/** Dana creates a page room and grants Guy `guyRole`; both desktops have it open. */
async function pair(guyRole: "viewer" | "collaborator" | "driver" = "collaborator") {
  const provider = await service();
  const dana = desktop(provider, DANA);
  const guy = desktop(provider, GUY);
  const room = await dana.manager.create(PERSON, {
    kind: "page",
    workspaceId: "ws-1",
    title: "Launch page",
  });
  await grant(provider, dana.token, room.id, GUY, guyRole);
  await guy.manager.open(room.id);
  await joined(dana.manager, room.id);
  await joined(guy.manager, room.id);
  return { provider, dana, guy, roomId: room.id };
}

describe("OrgRoomsManager: two desktops against the contract's in-memory rooms service", () => {
  it("creates a room of the extension's full kind and lists it for both people", async () => {
    const { dana, guy, roomId } = await pair();
    expect(dana.manager.roomSummary(roomId)?.kind).toBe(`${EXTENSION}/page`);
    expect((await guy.manager.list({ kind: `${EXTENSION}/page` })).map((room) => room.id)).toEqual([
      roomId,
    ]);
    expect(
      (await guy.manager.members(roomId)).map((member) => [member.principal, member.role]),
    ).toEqual([
      [DANA, "owner"],
      [GUY, "collaborator"],
    ]);
  });

  it("shows a local write at once (pending) and the other desktop receives the change itself", async () => {
    const { dana, guy, roomId } = await pair();
    const danaEvents: RoomEvent[] = [];
    const guyEvents: RoomEvent[] = [];
    dana.manager.subscribe(roomId, (event) => danaEvents.push(event));
    guy.manager.subscribe(roomId, (event) => guyEvents.push(event));

    await dana.manager.write(PERSON, roomId, "section:hero", "set", {
      headline: "Ship faster",
      pos: "a",
    });
    expect(dana.manager.get(roomId, "section:hero")).toMatchObject({
      fields: { headline: "Ship faster" },
      pending: true,
    });
    const first = danaEvents[0];
    expect(first?.kind === "records" ? first.changes[0] : undefined).toMatchObject({
      seq: null,
      pending: true,
    });

    await vi.waitFor(() =>
      expect(guy.manager.get(roomId, "section:hero")?.fields.headline).toBe("Ship faster"),
    );
    const records = guyEvents.find((event) => event.kind === "records");
    const change = records?.kind === "records" ? records.changes[0] : undefined;
    expect(change).toMatchObject({
      set: { headline: "Ship faster", pos: "a" },
      author: DANA,
      actor: { kind: "person" },
    });
    expect(change?.seq).toBeGreaterThan(0);
    await vi.waitFor(() => expect(dana.manager.replica.outbox(roomId)).toHaveLength(0));
    expect(dana.manager.get(roomId, "section:hero")?.pending).toBe(false);
  });

  it("concurrent edits converge to the same records on both desktops", async () => {
    const { provider, dana, guy, roomId } = await pair();
    await Promise.all([
      dana.manager.write(PERSON, roomId, "section:hero", "set", { headline: "Dana" }),
      guy.manager.write(PERSON, roomId, "section:hero", "set", {
        headline: "Guy",
        body: "from Guy",
      }),
      dana.manager.write(PERSON, roomId, "section:faq", "set", { headline: "FAQ" }),
    ]);
    await vi.waitFor(() => {
      expect(dana.manager.replica.outbox(roomId)).toHaveLength(0);
      expect(guy.manager.replica.outbox(roomId)).toHaveLength(0);
      const a = dana.manager.query(roomId, { type: "section" });
      expect(a).toHaveLength(2);
      expect(guy.manager.query(roomId, { type: "section" })).toEqual(a);
    });
    const log = provider.store.after(roomId, 0);
    const lastHeadline = log.filter((change) => change.record === "section:hero").at(-1)
      ?.set?.headline;
    expect(dana.manager.get(roomId, "section:hero")?.fields).toMatchObject({
      headline: lastHeadline,
      body: "from Guy",
    });
  });

  it("keeps working offline and sends the outbox on reconnect", async () => {
    const { dana, guy, roomId } = await pair();
    dana.network.down();
    await vi.waitFor(() => expect(dana.manager.socket.connected).toBe(false));
    await dana.manager.write(PERSON, roomId, "section:offline", "set", {
      headline: "Written offline",
    });
    expect(dana.manager.get(roomId, "section:offline")?.fields.headline).toBe("Written offline");
    expect(dana.manager.replica.pending(roomId)).toHaveLength(1);
    dana.network.online = true;
    await vi.waitFor(
      () =>
        expect(guy.manager.get(roomId, "section:offline")?.fields.headline).toBe("Written offline"),
      {
        timeout: 5000,
      },
    );
    await vi.waitFor(() => expect(dana.manager.replica.outbox(roomId)).toHaveLength(0));
  });

  it("an epoch change loses nothing: changes above durable are resent and both desktops converge", async () => {
    const { provider, dana, guy, roomId } = await pair();
    await dana.manager.write(PERSON, roomId, "section:kept", "set", { headline: "durable" });
    await vi.waitFor(() => expect(dana.manager.replica.outbox(roomId)).toHaveLength(0));
    const epochBefore = dana.manager.replica.getRoom(roomId)?.epoch;

    provider.holdDurable(true);
    await dana.manager.write(PERSON, roomId, "section:shown", "set", {
      headline: "shown, not stored",
    });
    await vi.waitFor(() => expect(guy.manager.get(roomId, "section:shown")).toBeDefined());
    expect(dana.manager.replica.outbox(roomId)).toHaveLength(1);

    await provider.loseBusState();
    provider.holdDurable(false);
    await vi.waitFor(
      () => {
        expect(
          provider.store.after(roomId, 0).some((change) => change.record === "section:shown"),
        ).toBe(true);
        expect(dana.manager.replica.outbox(roomId)).toHaveLength(0);
        expect(guy.manager.get(roomId, "section:shown")?.fields.headline).toBe("shown, not stored");
        expect(dana.manager.get(roomId, "section:shown")?.fields.headline).toBe(
          "shown, not stored",
        );
        expect(guy.manager.get(roomId, "section:kept")?.fields.headline).toBe("durable");
      },
      { timeout: 5000 },
    );
    expect(dana.manager.replica.getRoom(roomId)?.epoch).not.toBe(epochBefore);
    expect(guy.manager.replica.getRoom(roomId)?.epoch).toBe(
      dana.manager.replica.getRoom(roomId)?.epoch,
    );
  });

  it("a lowered role refuses writes locally; a revoke marks the room revoked", async () => {
    const { provider, dana, guy, roomId } = await pair();
    const statuses: string[] = [];
    guy.manager.subscribe(roomId, (event) => {
      if (event.kind === "status") statuses.push(event.status);
    });
    await grant(provider, dana.token, roomId, GUY, "viewer");
    await vi.waitFor(() => expect(guy.manager.replica.getRoom(roomId)?.role).toBe("viewer"));
    await expect(
      guy.manager.write(PERSON, roomId, "section:x", "set", { headline: "no" }),
    ).rejects.toMatchObject({
      code: "read-only",
    });
    await revoke(provider, dana.token, roomId, GUY);
    await vi.waitFor(() => expect(statuses).toContain("revoked"));
    await expect(
      guy.manager.write(PERSON, roomId, "section:x", "set", { headline: "no" }),
    ).rejects.toMatchObject({
      code: "revoked",
    });
  });

  it("a write made offline before the role dropped is refused on reconnect and rolled back", async () => {
    const { provider, dana, guy, roomId } = await pair();
    guy.network.down();
    await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
    await guy.manager.write(PERSON, roomId, "section:x", "set", { headline: "too late" });
    expect(guy.manager.get(roomId, "section:x")).toBeDefined();
    await grant(provider, dana.token, roomId, GUY, "viewer");
    const refused: RoomEvent[] = [];
    guy.manager.subscribe(roomId, (event) => {
      if (event.kind === "refused") refused.push(event);
    });
    guy.network.online = true;
    await vi.waitFor(
      () =>
        expect(refused).toMatchObject([
          { kind: "refused", record: "section:x", code: "forbidden" },
        ]),
      {
        timeout: 5000,
      },
    );
    expect(guy.manager.get(roomId, "section:x")).toBeUndefined();
    expect(guy.manager.replica.outbox(roomId)).toHaveLength(0);
  });

  it("ifSeq: a conditional write waits for the answer and rejects on conflict", async () => {
    const { dana, roomId } = await pair();
    await dana.manager.write(PERSON, roomId, "section:a", "set", { headline: "one" });
    await vi.waitFor(() =>
      expect(dana.manager.replica.confirmed(roomId, "section:a")).toBeDefined(),
    );
    const seq = dana.manager.replica.confirmed(roomId, "section:a")?.updatedSeq ?? 0;
    await dana.manager.write(
      PERSON,
      roomId,
      "section:a",
      "set",
      { headline: "two" },
      { ifSeq: seq },
    );
    await expect(
      dana.manager.write(PERSON, roomId, "section:a", "set", { headline: "three" }, { ifSeq: seq }),
    ).rejects.toMatchObject({ code: "conflict" });
    await vi.waitFor(() =>
      expect(dana.manager.get(roomId, "section:a")?.fields.headline).toBe("two"),
    );
  });

  it("refuses kinds, record types and fields the calling extension does not declare", async () => {
    const { dana, roomId } = await pair();
    const other: RoomsCaller = {
      extension: "@other/x",
      actor: { kind: "person" },
      declarations: [],
    };
    await expect(
      dana.manager.write(other, roomId, "section:a", "set", { headline: "x" }),
    ).rejects.toMatchObject({
      code: "unknown-type",
    });
    await expect(
      dana.manager.write(PERSON, roomId, "hero:a", "set", { headline: "x" }),
    ).rejects.toMatchObject({
      code: "unknown-type",
    });
    await expect(
      dana.manager.write(PERSON, roomId, "section:a", "set", { color: "x" }),
    ).rejects.toMatchObject({
      code: "unknown-field",
    });
    await expect(
      dana.manager.write(PERSON, roomId, "section:a", "set", { pos: 3 }),
    ).rejects.toMatchObject({
      code: "invalid-value",
    });
    await expect(
      dana.manager.write(PERSON, roomId, "request:a", "set", {
        to: "agent:team",
        text: "do it",
        status: "open",
      }),
    ).resolves.toBeUndefined();
    await expect(
      dana.manager.create(other, { kind: "page", workspaceId: "ws-1", title: "x" }),
    ).rejects.toMatchObject({
      code: "unknown-type",
    });
  });

  it("stamps the agent actor the host chose on the change the other desktop receives", async () => {
    const { dana, guy, roomId } = await pair();
    const agent: RoomsCaller = {
      ...PERSON,
      actor: { kind: "agent", host: "desktop", session: "s-1", runtime: "claude", model: "opus" },
    };
    await dana.manager.write(agent, roomId, "section:agent", "set", { headline: "by the agent" });
    await vi.waitFor(() => {
      const change = guy.manager.history(roomId, { key: "section:agent" })[0];
      expect(change).toMatchObject({
        author: DANA,
        actor: { kind: "agent", host: "desktop", session: "s-1" },
      });
    });
  });

  it("follows bye with an immediate reconnect and rejoins with have", async () => {
    const { provider, dana, roomId } = await pair();
    await dana.manager.write(PERSON, roomId, "section:a", "set", { headline: "before" });
    await vi.waitFor(() => expect(dana.manager.replica.outbox(roomId)).toHaveLength(0));
    const connectsBefore = dana.network.connects;
    provider.sayBye("deploy");
    await vi.waitFor(() => expect(dana.network.connects).toBe(connectsBefore + 1));
    await joined(dana.manager, roomId);
    expect(dana.manager.history(roomId)).toHaveLength(1);
  });

  it("presence reaches the other desktop with the stamped actor", async () => {
    const { dana, guy, roomId } = await pair();
    dana.manager.setPresence(roomId, { cursor: "section:hero" }, { kind: "person" });
    await vi.waitFor(() =>
      expect(guy.manager.presenceOf(roomId)).toMatchObject([
        {
          principal: DANA,
          state: { cursor: "section:hero" },
          actor: { kind: "person" },
          self: false,
        },
      ]),
    );
  });

  it("keeps the replica across a restart and resumes from it", async () => {
    const provider = await service();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
    dirs.push(root);
    const first = desktop(provider, DANA, root);
    const room = await first.manager.create(PERSON, {
      kind: "page",
      workspaceId: "ws-1",
      title: "Page",
    });
    await joined(first.manager, room.id);
    await first.manager.write(PERSON, room.id, "section:a", "set", { headline: "persisted" });
    await vi.waitFor(() => expect(first.manager.replica.outbox(room.id)).toHaveLength(0));
    first.manager.stop();
    managers.splice(managers.indexOf(first.manager), 1);
    const second = desktop(provider, DANA, root);
    expect(second.manager.get(room.id, "section:a")?.fields.headline).toBe("persisted");
    await joined(second.manager, room.id);
  });
});

describe("room files", () => {
  it("moves a multi-megabyte file between desktops; the token goes only to the service's own routes", async () => {
    const provider = await service();
    // The in-memory service has no file routes; these stand in for a store that uploads to a signed
    // address on another origin and serves downloads from the service's own content route.
    const stored = new Map<string, Uint8Array>();
    const uploads: { url: string; headers: Record<string, string> }[] = [];
    const downloads: { url: string; authorization: string | null }[] = [];
    let tamper = false;
    const fileRoutes = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const posted = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/files$/);
      if (posted && init?.method === "POST") {
        const ref = z
          .object({ sha256: z.string(), bytes: z.number(), contentType: z.string() })
          .parse(JSON.parse(typeof init.body === "string" ? init.body : ""));
        return Response.json({
          ref,
          upload: {
            url: `https://storage.example/rooms/${ref.sha256}?signature=x`,
            method: "PUT",
            headers: { "content-type": ref.contentType },
          },
        });
      }
      const content = url.pathname.match(
        /^\/v1\/rooms\/([^/]+)\/files\/([0-9a-f]{64})(\/content)?$/,
      );
      if (content?.[2] && !content[3])
        return Response.json({ url: `${provider.apiBase}${url.pathname}/content` });
      if (content?.[2] && content[3]) {
        downloads.push({
          url: input,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        const data = stored.get(content[2]);
        if (!data) return new Response(null, { status: 404 });
        return new Response(Buffer.from(tamper ? data.map((byte) => byte ^ 1) : data));
      }
      return fetch(input, init);
    };
    const withFiles = (person: `user:${string}`) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-files-"));
      dirs.push(root);
      const token = provider.issueToken(person);
      const manager = new OrgRoomsManager({
        endpoint: { orgId: "org-test", apiBase: provider.apiBase, socketUrl: provider.socketUrl },
        token: async () => token,
        person: async () => person,
        root,
        createSocket: (url) => new WebSocket(url),
        fetch: fileRoutes,
        uploadFile: async (url, headers, filePath) => {
          uploads.push({ url, headers });
          const data = new Uint8Array(fs.readFileSync(filePath));
          stored.set(url.split("/").at(-1)?.split("?")[0] ?? "", data);
          return 200;
        },
      });
      managers.push(manager);
      manager.start();
      return { manager, token, root };
    };
    const dana = withFiles(DANA);
    const guy = withFiles(GUY);
    const room = await dana.manager.create(PERSON, {
      kind: "page",
      workspaceId: "ws-1",
      title: "Files",
    });
    await grant(provider, dana.token, room.id, GUY, "viewer");
    await guy.manager.open(room.id);

    const source = path.join(dana.root, "cut.mp4");
    const data = new Uint8Array(6 * 1024 * 1024).map((_, index) => (index * 31) % 256);
    fs.writeFileSync(source, data);
    const ref = await dana.manager.putFile(room.id, source, "video/mp4");
    expect(ref.bytes).toBe(data.byteLength);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.headers.authorization).toBeUndefined();

    const local = await guy.manager.filePath(room.id, ref);
    expect(new Uint8Array(fs.readFileSync(local))).toEqual(data);
    expect(downloads).toEqual([expect.objectContaining({ authorization: `Bearer ${guy.token}` })]);
    expect(await guy.manager.filePath(room.id, ref)).toBe(local);
    expect(downloads).toHaveLength(1);

    // A download that does not match its reference never enters the cache.
    fs.rmSync(local);
    tamper = true;
    await expect(guy.manager.filePath(room.id, ref)).rejects.toMatchObject({ code: "mismatch" });
    expect(guy.manager.files.lookup(ref.sha256)).toBeUndefined();
    await expect(dana.manager.putFile(room.id, dana.root, "text/plain")).rejects.toMatchObject({
      code: "not-a-file",
    });
  });
});

describe("built-in rooms", () => {
  it("a refused create (400) is the caller's to see, not hidden behind a join", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
    dirs.push(root);
    const calls: string[] = [];
    const manager = new OrgRoomsManager({
      endpoint: {
        orgId: "org-test",
        apiBase: "http://127.0.0.1:1/api",
        socketUrl: "ws://127.0.0.1:1/s",
      },
      token: async () => "t",
      person: async () => DANA,
      root,
      createSocket: (url) => new WebSocket(url),
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ error: "bad-request" }), { status: 400 });
      },
    });
    managers.push(manager);
    await expect(
      manager.openOrCreateBuiltin({
        id: "session:os-1",
        kind: "marshal/conversation",
        schemaVersion: 1,
        workspaceId: "ws-1",
        title: "Pricing",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(calls).toEqual(["POST http://127.0.0.1:1/api/v1/rooms"]);
  });
});
