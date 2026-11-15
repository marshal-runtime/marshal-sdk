import type { FetchLike, OrgClient } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { SessionMessage } from "../../../common/marshal-ipc-contract";
import type { ShareableSession } from "./cloud-session-sanitizer";
import { OrgMentions } from "./org-mentions";
import type { OrgFlags } from "./org-service";
import { OrgSessionSharing } from "./org-session-sharing";
import { InMemoryOrgShareOutbox } from "./org-share-outbox";
import { ALICE, BOB, CAROL, createTestOrg } from "./org-test-harness";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  mentions: true,
};
const SHARING_ONLY: OrgFlags = { ...ON, mentions: undefined };

function message(id: string, content: string): SessionMessage {
  return { id, role: "user", content, timestamp: "2026-11-03T10:00:00.000Z" };
}

const SESSION: ShareableSession = {
  id: "sess-1",
  name: "Fix the build",
  createdAt: "2026-11-03T09:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  runtimeId: "claude",
  workspaceName: "Platform",
  messages: [message("1", "hello")],
};

const RESTRICTED_SESSION: ShareableSession = {
  ...SESSION,
  messages: [
    {
      ...message("2", "found"),
      role: "assistant",
      toolCalls: [
        {
          id: "t1",
          name: "knowledge.search",
          description: "",
          output: JSON.stringify({ hits: [{ title: "Board notes", audience: "staff" }] }),
        },
      ],
    },
  ],
};

async function setup(
  options: {
    flags?: OrgFlags;
    caller?: `user:${string}`;
    session?: ShareableSession;
    fetchWrapper?: (inner: FetchLike) => FetchLike;
    features?: NonNullable<Parameters<typeof createTestOrg>[0]>["features"];
  } = {},
) {
  const org = createTestOrg({ fetchWrapper: options.fetchWrapper, features: options.features });
  const client = await org.clientFor(options.caller ?? ALICE);
  const getClient = vi.fn<() => Promise<OrgClient | null>>(async () => client);
  const loadSession = vi.fn<(id: string) => Promise<ShareableSession | null>>(
    async () => options.session ?? SESSION,
  );
  const sharing = new OrgSessionSharing({
    getFlags: () => options.flags ?? ON,
    getClient,
    getSignedInOrgId: () => "acme",
    loadSession,
    resolveOrgWorkspace: async () => ({
      mapped: true as const,
      orgWorkspaceId: "ws:platform",
      orgWorkspaceName: "Platform",
      repo: "acme/platform",
    }),
    outbox: new InMemoryOrgShareOutbox(),
    homeDir: () => "/Users/alice",
  });
  const mentions = new OrgMentions({ getFlags: () => options.flags ?? ON, getClient, sharing });
  return { org, client, getClient, loadSession, sharing, mentions };
}

function fakeSharing(restricted = false): ConstructorParameters<typeof OrgMentions>[0]["sharing"] {
  return {
    preview: vi.fn<OrgSessionSharing["preview"]>(async () => ({
      success: true,
      title: "t",
      orgWorkspaceId: "ws:platform",
      messageCount: 1,
      label: restricted ? "restricted" : "team",
      restrictedItems: [],
      queued: false,
    })),
    share: vi.fn<OrgSessionSharing["share"]>(async () => ({
      success: true,
      state: "uploaded",
      messageCount: 1,
    })),
  };
}

describe("OrgMentions with org.mentions off", () => {
  it("makes no network call and loads nothing", async () => {
    const { mentions, org, getClient, loadSession } = await setup({ flags: SHARING_ONLY });
    const before = org.provider.requests.length;
    expect(await mentions.searchDirectory("bo")).toEqual({ success: false, error: "disabled" });
    expect(await mentions.mention({ sessionId: "sess-1", principal: BOB, role: "viewer" })).toEqual(
      { success: false, error: "disabled" },
    );
    expect(getClient).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    expect(org.provider.requests.length).toBe(before);
  });
});

describe("OrgMentions directory search", () => {
  it("returns teammates except yourself", async () => {
    const { mentions } = await setup();
    const result = await mentions.searchDirectory("a");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.entries.map((entry) => entry.principal)).not.toContain(ALICE);
    const bob = await mentions.searchDirectory("bob");
    expect(bob).toEqual({
      success: true,
      entries: [{ principal: BOB, displayName: "Bob", email: "bob@example.test" }],
    });
  });

  it("answers unavailable on 503 and keeps working afterwards", async () => {
    let down = true;
    const { mentions } = await setup({
      fetchWrapper: (inner) => async (input, init) => {
        if (down && input.includes("/v1/directory")) {
          return new Response(JSON.stringify({ error: "directory-unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return inner(input, init);
      },
    });
    expect(await mentions.searchDirectory("bob")).toEqual({
      success: false,
      error: "directory-unavailable",
    });
    down = false;
    expect(await mentions.searchDirectory("bob")).toMatchObject({ success: true });
  });

  it("reports an unsupported directory and ignores an empty query", async () => {
    const { mentions } = await setup({ features: ["signIn", "workspaces", "sessions"] });
    expect(await mentions.searchDirectory("bob")).toEqual({
      success: false,
      error: "directory-unsupported",
    });
    expect(await mentions.searchDirectory("   ")).toEqual({ success: true, entries: [] });
  });
});

describe("OrgMentions mention", () => {
  it("shares the session, grants the role and notifies the person", async () => {
    const { mentions, client, org } = await setup();
    expect(
      await mentions.mention({ sessionId: "sess-1", principal: BOB, role: "collaborator" }),
    ).toEqual({ success: true, role: "collaborator", notified: true });

    const view = await client.getSession("sess-1");
    expect(view.grants?.map((grant) => [grant.principal, grant.role])).toEqual([
      [BOB, "collaborator"],
    ]);
    const bob = await org.clientFor(BOB);
    expect((await bob.getSession("sess-1")).role).toBe("collaborator");
    const notifications = await bob.listNotifications({ unread: true });
    expect(notifications.notifications).toMatchObject([
      { kind: "mention", sessionId: "sess-1", from: ALICE, read: false },
    ]);
    expect((await (await org.clientFor(CAROL)).listNotifications()).notifications).toEqual([]);
  });

  it.each(["owner", "admin"])("rejects the role %s before any request", async (role) => {
    const { mentions, org } = await setup();
    const before = org.provider.requests.length;
    const request = Object.assign(
      {},
      { sessionId: "sess-1", principal: BOB, role: "viewer" as const },
      { role },
    );
    expect(await mentions.mention(request)).toEqual({ success: false, error: "invalid-role" });
    expect(org.provider.requests.length).toBe(before);
  });

  it("answers 403 not-a-member for a person outside the organization", async () => {
    const { mentions } = await setup();
    expect(
      await mentions.mention({ sessionId: "sess-1", principal: "user:mallory", role: "viewer" }),
    ).toEqual({ success: false, error: "not-a-member" });
  });

  it("refuses to grant yourself or the owner", async () => {
    const { mentions } = await setup();
    expect(
      await mentions.mention({ sessionId: "sess-1", principal: ALICE, role: "viewer" }),
    ).toEqual({ success: false, error: "conflict" });
  });

  it("asks for acknowledgement before granting a session with restricted results", async () => {
    const { mentions, client } = await setup({ session: RESTRICTED_SESSION });
    const first = await mentions.mention({ sessionId: "sess-1", principal: BOB, role: "viewer" });
    expect(first).toMatchObject({ success: false, error: "restricted-needs-acknowledgement" });
    expect(first.success ? [] : first.restrictedItems?.map((item) => item.label)).toEqual([
      "Board notes",
    ]);
    await expect(client.getSession("sess-1")).rejects.toMatchObject({ status: 404 });

    expect(
      await mentions.mention({
        sessionId: "sess-1",
        principal: BOB,
        role: "viewer",
        acknowledgeRestricted: true,
      }),
    ).toMatchObject({ success: true });
    expect((await client.getSession("sess-1")).session.labels).toBe("restricted");
  });

  it("does not grant when the upload could not reach the organization", async () => {
    let offline = false;
    const { mentions, client } = await setup({
      fetchWrapper: (inner) => async (input, init) => {
        if (offline && input.includes("/v1/sessions/sess-1")) throw new TypeError("offline");
        return inner(input, init);
      },
    });
    offline = true;
    expect(await mentions.mention({ sessionId: "sess-1", principal: BOB, role: "viewer" })).toEqual(
      { success: false, error: "unreachable" },
    );
    offline = false;
    await expect(client.getSession("sess-1")).rejects.toMatchObject({ status: 404 });
  });

  it("reports mentions-unsupported when the organization does not serve them", async () => {
    const { mentions } = await setup({
      features: ["signIn", "directory", "workspaces", "sessions", "notifications"],
    });
    expect(await mentions.mention({ sessionId: "sess-1", principal: BOB, role: "viewer" })).toEqual(
      { success: false, error: "mentions-unsupported" },
    );
  });
});

describe("OrgMentions authorization edges", () => {
  async function sharedSession() {
    const owner = await setup();
    await owner.mentions.mention({ sessionId: "sess-1", principal: BOB, role: "collaborator" });
    await owner.mentions.mention({ sessionId: "sess-1", principal: CAROL, role: "viewer" });
    return owner;
  }

  it("answers 404 to a person with no role on the session", async () => {
    const owner = await setup();
    await owner.sharing.share("sess-1");
    const bob = await owner.org.clientFor(BOB);
    await expect(bob.getSession("sess-1")).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    const mentions = new OrgMentions({
      getFlags: () => ON,
      getClient: async () => bob,
      sharing: fakeSharing(),
    });
    expect(
      await mentions.mention({ sessionId: "sess-1", principal: CAROL, role: "viewer" }),
    ).toEqual({ success: false, error: "not-found" });
  });

  it("caps a collaborator at their own role and blocks a viewer", async () => {
    const owner = await sharedSession();
    const asCollaborator = new OrgMentions({
      getFlags: () => ON,
      getClient: async () => owner.org.clientFor(BOB),
      sharing: fakeSharing(),
    });
    expect(
      await asCollaborator.mention({
        sessionId: "sess-1",
        principal: "user:mallory",
        role: "driver",
      }),
    ).toEqual({ success: false, error: "role-above-own" });
    const asViewer = new OrgMentions({
      getFlags: () => ON,
      getClient: async () => owner.org.clientFor(CAROL),
      sharing: fakeSharing(),
    });
    expect(await asViewer.mention({ sessionId: "sess-1", principal: BOB, role: "viewer" })).toEqual(
      { success: false, error: "forbidden" },
    );
  });

  it("lets the server enforce the same caps when the client check is bypassed", async () => {
    const owner = await sharedSession();
    const bob = await owner.org.clientFor(BOB);
    await expect(
      bob.grantSession("sess-1", { principal: "user:mallory", role: "driver" }),
    ).rejects.toMatchObject({ status: 403 });
    const carol = await owner.org.clientFor(CAROL);
    await expect(
      carol.grantSession("sess-1", { principal: BOB, role: "viewer" }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("a collaborator can grant up to their own role", async () => {
    const owner = await sharedSession();
    const asCollaborator = new OrgMentions({
      getFlags: () => ON,
      getClient: async () => owner.org.clientFor(BOB),
      sharing: fakeSharing(),
    });
    expect(
      await asCollaborator.mention({ sessionId: "sess-1", principal: CAROL, role: "collaborator" }),
    ).toEqual({ success: true, role: "collaborator", notified: true });
  });

  it("does not let a non-owner overwrite the owner's session through a mention", async () => {
    const owner = await sharedSession();
    const mentions = new OrgMentions({
      getFlags: () => ON,
      getClient: async () => owner.org.clientFor(BOB),
      sharing: new OrgSessionSharing({
        getFlags: () => ON,
        getClient: async () => owner.org.clientFor(BOB),
        getSignedInOrgId: () => "acme",
        loadSession: async () => SESSION,
        resolveOrgWorkspace: async () => ({
          mapped: true as const,
          orgWorkspaceId: "ws:platform",
          orgWorkspaceName: "Platform",
          repo: "acme/platform",
        }),
        outbox: new InMemoryOrgShareOutbox(),
      }),
    });
    const result = await mentions.mention({
      sessionId: "sess-1",
      principal: CAROL,
      role: "viewer",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/forbidden|not-found/),
    });
  });
});
