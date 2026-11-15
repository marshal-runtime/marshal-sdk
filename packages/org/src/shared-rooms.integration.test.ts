/* eslint-disable no-await-in-loop -- the scripted desktops sync one after another, like the real loop */
/**
 * Shared sessions as rooms, end to end in one process: the in-memory organization (shared transcripts)
 * and the in-memory rooms service (HTTP and socket on 127.0.0.1), and two desktops that each run the
 * real `OrgSharedSessions`, `OrgRoomsService` and `OrgSharedRooms` over scripted local sessions. The
 * room is the live path; the transcript still carries every message, and nothing shows twice.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OrgClient,
  fetchOrgDiscovery,
  type OrgDiscoveryDocument,
  type OrgFeature,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";
import {
  createInMemoryOrgProvider,
  createInMemoryRoomsProvider,
  type InMemoryOrgProvider,
  type InMemoryRoomsProvider,
} from "@marshal/agent-runtime-org/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import type { OrgSharedLiveView, SessionMessage } from "../../../common/marshal-ipc-contract";
import type { OrgFlags } from "./org-service";
import { OrgSessionSharing } from "./org-session-sharing";
import { InMemoryOrgShareOutbox } from "./org-share-outbox";
import { InMemoryOrgSharedLinkStore } from "./org-shared-link-store";
import { OrgSharedRooms, conversationRoomId, type SharedAgentSummary } from "./org-shared-rooms";
import { conversationRoomsOf } from "./org-shared-rooms-adapter";
import { OrgSharedSessions, type SharedSessionHost } from "./org-shared-sessions";
import { OrgRoomsService } from "./rooms/org-rooms-service";

const GUY: UserPrincipal = "user:Guy";
const OMER: UserPrincipal = "user:Omer";
const ORG_ID = "zyg";
const WORKSPACE = "ws:platform";
const FEATURES: OrgFeature[] = [
  "signIn",
  "workspaces",
  "directory",
  "sessions",
  "sharedTranscript",
];
const FLAGS: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: true,
  sessionSharing: true,
  mentions: true,
  liveSessions: true,
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type HostEvent = { type: string; origin?: string; delta?: string; message?: SessionMessage };

/** One person's computer: scripted local sessions, the real transcript sync, and the real rooms path. */
class Desktop {
  readonly sessions = new Map<string, { id: string; name: string; messages: SessionMessage[] }>();
  readonly busy = new Set<string>();
  readonly views = new Map<string, OrgSharedLiveView>();
  summary: SharedAgentSummary = { busy: false };
  roomsOn = true;
  private readonly listeners = new Set<(sessionId: string, event: HostEvent) => void>();
  private sequence = 0;
  readonly client: OrgClient;
  readonly shared: OrgSharedSessions;
  readonly rooms: OrgRoomsService;
  readonly live: OrgSharedRooms;
  readonly roomToken: string;

  constructor(
    readonly principal: UserPrincipal,
    readonly home: string,
    org: InMemoryOrgProvider,
    discovery: OrgDiscoveryDocument,
    roomsProvider: InMemoryRoomsProvider,
  ) {
    const token = org.issueToken(principal);
    this.client = new OrgClient({ discovery, accessToken: async () => token, fetch: org.fetch });
    const host: SharedSessionHost = {
      loadSession: (id) => this.sessions.get(id) ?? null,
      sessionInfo: (id) => {
        const session = this.sessions.get(id);
        return session
          ? { name: session.name, repoPath: `${this.home}/code/platform`, usableHere: true }
          : null;
      },
      canTakePart: () => true,
      isBusy: (id) => this.busy.has(id),
      isOpen: () => true,
      appendRemote: (id, message) => this.appendRemote(id, message),
      createLinkedSession: async ({ title, initialMessages }) => {
        const id = randomUUID();
        this.sessions.set(id, { id, name: title, messages: [...initialMessages] });
        return id;
      },
      localWorkspaceFor: async () => "platform",
      subscribe: (listener) => this.listen(listener),
      changed: () => undefined,
      renameSession: async () => undefined,
      refreshEnvelope: async () => true,
    };
    this.shared = new OrgSharedSessions({
      getFlags: () => FLAGS,
      getClient: async () => this.client,
      getSignedInOrgId: () => ORG_ID,
      store: new InMemoryOrgSharedLinkStore(),
      host,
      homeDir: () => this.home,
      setTimer: () => ({}),
    });

    this.roomToken = roomsProvider.issueToken(principal);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-rooms-"));
    this.rooms = new OrgRoomsService({
      endpoint: async () =>
        this.roomsOn
          ? { orgId: ORG_ID, apiBase: roomsProvider.apiBase, socketUrl: roomsProvider.socketUrl }
          : undefined,
      token: async () => this.roomToken,
      person: async () => principal,
      root,
      createSocket: (url) => new WebSocket(url),
      declarationsOf: async () => [],
      applicationOf: () => undefined,
      describeSession: () => ({ runtime: "claude", model: "opus" }),
    });
    this.live = new OrgSharedRooms({
      rooms: () => conversationRoomsOf(this.rooms, this.rooms.manager),
      links: () => this.shared.liveLinks(),
      describe: (orgSessionId) => this.shared.describeForRoom(orgSessionId),
      labelOf: (who) => this.shared.labelOf(who),
      learnNames: (principals) => this.shared.learnNamesOf(principals),
      notePerson: (localSessionId, who) => this.shared.notePersonFor(localSessionId, who),
      loadSession: (id) => this.sessions.get(id) ?? null,
      repoPath: () => `${this.home}/code/platform`,
      isOpen: () => true,
      isBusy: (id) => this.busy.has(id),
      agentSummary: () => this.summary,
      appendRemote: (id, message) => this.appendRemote(id, message),
      subscribe: (listener) => this.listen(listener),
      liveChanged: (id, view) => this.views.set(id, view),
      homeDir: () => this.home,
    });
    this.shared.attachLive(this.live);
    cleanup.push(() => {
      this.live.stop();
      this.rooms.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  async start(): Promise<void> {
    this.shared.start();
    await this.rooms.start();
    this.live.start();
  }

  private listen(listener: (sessionId: string, event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(sessionId: string, event: HostEvent): void {
    for (const listener of this.listeners) listener(sessionId, event);
  }

  private appendRemote(id: string, message: SessionMessage): boolean {
    const session = this.sessions.get(id);
    if (!session || session.messages.some((existing) => existing.id === message.id)) return false;
    session.messages.push(message);
    this.emit(id, { type: "turn:message-committed", origin: "external", message });
    return true;
  }

  private message(role: SessionMessage["role"], content: string): SessionMessage {
    this.sequence += 1;
    return {
      id: `${this.principal.slice(5)}-${this.sequence}-${randomUUID().slice(0, 8)}`,
      role,
      content,
      timestamp: new Date().toISOString(),
    };
  }

  newSession(messages: Array<Pick<SessionMessage, "role" | "content">>): string {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      name: "Fix the login bug",
      messages: messages.map((message) => this.message(message.role, message.content)),
    });
    return id;
  }

  send(sessionId: string, text: string): void {
    const message = this.message("user", text);
    this.sessions.get(sessionId)!.messages.push(message);
    this.busy.add(sessionId);
    this.emit(sessionId, { type: "turn:message-committed", message });
  }

  delta(sessionId: string, text: string): void {
    this.emit(sessionId, { type: "turn:text-delta", delta: text });
  }

  reply(sessionId: string, text: string): void {
    const message = this.message("assistant", text);
    this.sessions.get(sessionId)!.messages.push(message);
    this.emit(sessionId, { type: "turn:message-committed", message });
    this.busy.delete(sessionId);
    this.emit(sessionId, { type: "turn:idle" });
  }

  view(sessionId: string): string[] {
    return this.sessions.get(sessionId)!.messages.map((message) => {
      const remote = message.orgRemote;
      if (!remote) return `me/${message.role}: ${message.content}`;
      return `${remote.authorLabel}${remote.fromAgent ? "'s Marshal" : ""}: ${message.content}`;
    });
  }
}

async function world() {
  const org = createInMemoryOrgProvider({
    orgId: ORG_ID,
    features: FEATURES,
    users: [
      { principal: GUY, email: "guy@zyg.test", displayName: "Guy" },
      { principal: OMER, email: "omer@zyg.test", displayName: "Omer" },
    ],
    workspaces: [
      {
        id: WORKSPACE,
        displayName: "Platform",
        repositories: [{ repository: "zyg/platform", defaultBranch: "main" }],
      },
    ],
  });
  const roomsProvider = await createInMemoryRoomsProvider({ drainMs: 5 });
  cleanup.push(() => roomsProvider.close());
  const discovery = await fetchOrgDiscovery(org.orgUrl, { fetch: org.fetch });
  const guy = new Desktop(GUY, "/Users/guy", org, discovery, roomsProvider);
  const omer = new Desktop(OMER, "/Users/omer", org, discovery, roomsProvider);

  /** Guy shares a session with one exchange and grants Omer; Omer joins it locally. */
  async function share() {
    await guy.start();
    await omer.start();
    const sessionId = guy.newSession([
      { role: "user", content: "The login page loops after sign-in." },
      { role: "assistant", content: "The redirect drops the session cookie." },
    ]);
    const sharing = new OrgSessionSharing({
      getFlags: () => FLAGS,
      getClient: async () => guy.client,
      getSignedInOrgId: () => ORG_ID,
      loadSession: async (id) => {
        const session = guy.sessions.get(id);
        return session
          ? {
              ...session,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              runtimeId: "claude",
              workspaceName: "platform",
              repoPath: "/Users/guy/code/platform",
            }
          : null;
      },
      resolveOrgWorkspace: async () => ({
        mapped: true,
        orgWorkspaceId: WORKSPACE,
        orgWorkspaceName: "Platform",
        repo: "zyg/platform",
      }),
      outbox: new InMemoryOrgShareOutbox(),
      sharedSessions: {
        ownerMayReplace: (id) => guy.shared.ownerMayReplace(id),
        ownerShared: (id) => guy.shared.ownerShared(id),
      },
      homeDir: () => guy.home,
    });
    expect(await sharing.share(sessionId)).toMatchObject({ success: true });
    await guy.client.grantSession(sessionId, { principal: OMER, role: "collaborator" });
    const joined = await omer.shared.join(sessionId);
    if (!joined.success) throw new Error(`join failed: ${joined.error}`);
    return { sessionId, omerId: joined.localSessionId };
  }

  /** Both desktops open the session's room: the owner creates it, then Omer is a member. */
  async function shareLive() {
    const { sessionId, omerId } = await share();
    // Only the owner creates the room; the in-memory service has no session memberships, so a room
    // grant stands in for the session's (the real service derives members from the session grants).
    await vi.waitFor(async () => {
      await guy.live.tick();
      expect(guy.live.isLive(sessionId)).toBe(true);
    });
    const roomId = conversationRoomId(sessionId);
    await roomGrant(roomsProvider, guy, roomId, OMER, "collaborator");
    await vi.waitFor(async () => {
      await omer.live.tick();
      expect(omer.live.isLive(omerId)).toBe(true);
    });
    return { sessionId, omerId, roomId };
  }

  return { org, roomsProvider, guy, omer, share, shareLive };
}

async function roomGrant(
  provider: InMemoryRoomsProvider,
  owner: Desktop,
  roomId: string,
  principal: UserPrincipal,
  role: "viewer" | "collaborator",
): Promise<void> {
  const response = await fetch(
    `${provider.apiBase}/v1/rooms/${encodeURIComponent(roomId)}/grants`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${owner.roomToken}`, "content-type": "application/json" },
      body: JSON.stringify({ principal, role }),
    },
  );
  expect(response.ok).toBe(true);
}

async function transcriptSync(...desktops: Desktop[]): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const desktop of desktops) {
      for (const id of desktop.sessions.keys()) {
        if (desktop.shared.isLinked(id)) await desktop.shared.syncNow(id);
      }
    }
  }
}

describe("shared sessions as rooms", () => {
  it("a message reaches the other desktop through the room, the reply streams in place, and the transcript doubles nothing", async () => {
    const { guy, omer, shareLive } = await world();
    const { sessionId, omerId } = await shareLive();

    omer.send(omerId, "Does it happen on Safari too? See /Users/omer/code/platform/src/auth.ts");
    await vi.waitFor(() =>
      expect(guy.view(sessionId).at(-1)).toBe(
        "Omer: Does it happen on Safari too? See ./src/auth.ts",
      ),
    );
    omer.delta(omerId, "Yes: Safari blocks ");
    omer.delta(omerId, "the third-party cookie when ");
    await vi.waitFor(() =>
      expect(guy.views.get(sessionId)?.streaming[0]?.text).toBe(
        "Yes: Safari blocks the third-party cookie when",
      ),
    );
    expect(guy.views.get(sessionId)?.streaming[0]).toMatchObject({
      author: OMER,
      authorLabel: "Omer",
    });

    omer.delta(omerId, "ITP is on.");
    omer.reply(omerId, "Yes: Safari blocks the third-party cookie when ITP is on.");
    await vi.waitFor(() => {
      expect(guy.view(sessionId).at(-1)).toBe(
        "Omer's Marshal: Yes: Safari blocks the third-party cookie when ITP is on.",
      );
      expect(guy.views.get(sessionId)?.streaming).toEqual([]);
    });

    // The phase-1 transcript still carries both messages; reading it adds nothing on either side.
    await transcriptSync(omer, guy);
    expect(guy.view(sessionId)).toEqual([
      "me/user: The login page loops after sign-in.",
      "me/assistant: The redirect drops the session cookie.",
      "Omer: Does it happen on Safari too? See ./src/auth.ts",
      "Omer's Marshal: Yes: Safari blocks the third-party cookie when ITP is on.",
    ]);
    expect(omer.view(omerId).filter((line) => line.startsWith("Guy"))).toHaveLength(2);
    expect(
      (await guy.client.getTranscript(sessionId)).messages.map((message) => message.author),
    ).toEqual([GUY, GUY, OMER, OMER]);
  });

  it("presence carries who is here, composing, and the agent strip from host state", async () => {
    const { guy, omer, shareLive } = await world();
    const { sessionId, omerId } = await shareLive();

    omer.live.setComposing(omerId, true);
    await vi.waitFor(() =>
      expect(guy.views.get(sessionId)?.people).toEqual([
        { principal: OMER, label: "Omer", open: true, composing: true },
      ]),
    );

    omer.busy.add(omerId);
    omer.summary = {
      busy: true,
      todos: [
        { title: "Reproduce on Safari", status: "done" },
        { title: "Patch the cookie flags", status: "in_progress" },
      ],
      filesChanged: 2,
      subagents: 1,
    };
    omer.live.setComposing(omerId, false);
    await vi.waitFor(() =>
      expect(guy.views.get(sessionId)?.agents).toEqual([
        {
          principal: OMER,
          label: "Omer's Marshal",
          cloud: false,
          step: "Patch the cookie flags",
          tasks: [
            { text: "Reproduce on Safari", done: true },
            { text: "Patch the cookie flags", done: false },
          ],
          filesChanged: 2,
          subagents: 1,
        },
      ]),
    );
    expect(guy.views.get(sessionId)?.people[0]?.composing).toBe(false);
  });

  it("what was written while a desktop was away arrives once when it joins the room again", async () => {
    const { guy, omer, shareLive } = await world();
    const { sessionId, omerId } = await shareLive();

    guy.live.stop();
    omer.send(omerId, "first while Guy is away");
    omer.reply(omerId, "answered while Guy is away");
    await vi.waitFor(() => {
      const records =
        omer.rooms.manager?.query(conversationRoomId(sessionId), { type: "message" }) ?? [];
      expect(records.filter((record) => record.fields.state === "final")).toHaveLength(2);
    });
    expect(guy.view(sessionId)).toHaveLength(2);

    guy.live.start();
    await vi.waitFor(async () => {
      await guy.live.tick();
      expect(guy.view(sessionId).slice(2)).toEqual([
        "Omer: first while Guy is away",
        "Omer's Marshal: answered while Guy is away",
      ]);
    });
    await transcriptSync(omer, guy);
    expect(guy.view(sessionId)).toHaveLength(4);
  });

  it("a revoked collaborator's room closes, and the transcript keeps the rest of the session", async () => {
    const { roomsProvider, guy, omer, shareLive } = await world();
    const { sessionId, omerId, roomId } = await shareLive();

    await guy.client.revokeSessionGrant(sessionId, OMER);
    const response = await fetch(
      `${roomsProvider.apiBase}/v1/rooms/${encodeURIComponent(roomId)}/grants/${encodeURIComponent(OMER)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${guy.roomToken}` } },
    );
    expect(response.ok).toBe(true);
    await transcriptSync(omer);
    await vi.waitFor(async () => {
      await omer.live.tick();
      expect(omer.live.isLive(omerId)).toBe(false);
      expect(omer.views.get(omerId)?.live).toBe(false);
    });

    guy.send(sessionId, "Omer can no longer see this");
    guy.reply(sessionId, "Right.");
    await transcriptSync(guy, omer);
    expect(omer.view(omerId).some((line) => line.includes("no longer see"))).toBe(false);
  });

  it("with rooms off nothing goes live and the transcript alone carries the session, at the open rate", async () => {
    const { guy, omer, share } = await world();
    guy.roomsOn = false;
    omer.roomsOn = false;
    const { sessionId, omerId } = await share();
    expect(conversationRoomsOf(guy.rooms, guy.rooms.manager)).toBeUndefined();
    await guy.live.tick();
    await omer.live.tick();
    expect(guy.live.isLive(sessionId)).toBe(false);
    expect(omer.live.isLive(omerId)).toBe(false);

    omer.send(omerId, "Does it happen on Safari too?");
    omer.reply(omerId, "Yes.");
    await transcriptSync(omer, guy);
    expect(guy.view(sessionId).slice(2)).toEqual([
      "Omer: Does it happen on Safari too?",
      "Omer's Marshal: Yes.",
    ]);
    expect(guy.views.size).toBe(0);
  });
});
