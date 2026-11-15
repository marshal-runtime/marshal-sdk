import type { FetchLike, OrgClient, OrgWorkspace } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { SessionMessage } from "../../../common/marshal-ipc-contract";
import type { ShareableSession } from "./cloud-session-sanitizer";
import type { OrgFlags } from "./org-service";
import { OrgSessionSharing, paginateTranscript } from "./org-session-sharing";
import { InMemoryOrgSessionWorkspaceStore } from "./org-session-workspace-store";
import { InMemoryOrgShareOutbox } from "./org-share-outbox";
import { ALICE, BOB, OUTSIDER, createTestOrg } from "./org-test-harness";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
};
const OFF: OrgFlags = { enabled: true, signIn: true, workspaces: true, remoteSessions: false };
const HOME = "/Users/alice";
const WORKSPACES: OrgWorkspace[] = [
  {
    id: "ws:platform",
    displayName: "Platform",
    repositories: [{ repository: "acme/platform", defaultBranch: "main" }],
  },
  { id: "ws:research", displayName: "Research", repositories: [] },
  { id: "ws:vault", displayName: "Vault", repositories: [], dataBoundary: "vault" },
];
const PAT = `ghp_${"b".repeat(36)}`;

function message(id: string, role: SessionMessage["role"], content: string): SessionMessage {
  return { id, role, content, timestamp: "2026-11-03T10:00:00.000Z" };
}

function localSession(
  messages: SessionMessage[],
  overrides: Partial<ShareableSession> = {},
): ShareableSession {
  return {
    id: "sess-1",
    name: "Fix the build",
    createdAt: "2026-11-03T09:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    runtimeId: "claude",
    workspaceName: "Platform",
    repoPath: `${HOME}/code/platform`,
    messages,
    ...overrides,
  };
}

async function setup(
  options: {
    flags?: OrgFlags;
    session?: ShareableSession | null;
    linked?: boolean;
    principal?: `user:${string}`;
    unservedWorkspace?: boolean;
    fetchWrapper?: (inner: FetchLike) => FetchLike;
    choices?: InMemoryOrgSessionWorkspaceStore;
    orgId?: string;
  } = {},
) {
  const org = createTestOrg({ fetchWrapper: options.fetchWrapper, workspaces: WORKSPACES });
  const principal = options.principal ?? ALICE;
  const client = await org.clientFor(principal);
  const outbox = new InMemoryOrgShareOutbox();
  const loadSession = vi.fn<(id: string) => Promise<ShareableSession | null>>(async () =>
    options.session === undefined
      ? localSession([
          message("1", "user", `fix /Users/alice/code/platform/a.ts with ${PAT}`),
          message("2", "assistant", "done"),
        ])
      : options.session,
  );
  const getClient = vi.fn<() => Promise<OrgClient | null>>(async () => client);
  const outboxLoad = vi.spyOn(outbox, "load");
  const sharing = new OrgSessionSharing({
    getFlags: () => options.flags ?? ON,
    getClient,
    getSignedInOrgId: () => options.orgId ?? "acme",
    loadSession,
    resolveOrgWorkspace: async (name) =>
      name === "Platform" && options.linked !== false
        ? {
            mapped: true,
            orgWorkspaceId: options.unservedWorkspace ? "ws:not-served" : "ws:platform",
            orgWorkspaceName: "Platform",
            repo: "acme/platform",
          }
        : {
            mapped: false,
            reason: "repo-not-in-org",
            message: "acme/other isn't in any organization workspace; ask an admin to add it.",
            repo: "acme/other",
          },
    outbox,
    workspaceChoices: options.choices,
    homeDir: () => HOME,
  });
  return { org, client, outbox, sharing, getClient, loadSession, outboxLoad };
}

describe("OrgSessionSharing with org.sessionSharing off", () => {
  it("does no network, session or disk work", async () => {
    const { sharing, org, getClient, loadSession, outboxLoad } = await setup({ flags: OFF });
    const before = org.provider.requests.length;
    expect(await sharing.preview("sess-1")).toEqual({ success: false, error: "disabled" });
    expect(await sharing.share("sess-1")).toEqual({ success: false, error: "disabled" });
    await sharing.flushOutbox();
    expect(getClient).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    expect(outboxLoad).not.toHaveBeenCalled();
    expect(org.provider.requests.length).toBe(before);
  });
});

describe("OrgSessionSharing share", () => {
  it("uploads a scrubbed envelope and transcript the owner can read back", async () => {
    const { sharing, client } = await setup();
    expect(await sharing.share("sess-1")).toEqual({
      success: true,
      state: "uploaded",
      messageCount: 2,
    });
    const view = await client.getSession("sess-1");
    expect(view.role).toBe("owner");
    expect(view.session).toMatchObject({
      owner: ALICE,
      workspaceId: "ws:platform",
      runtime: "claude",
      labels: "team",
      transcript: { messageCount: 2 },
    });
    const transcript = await client.getTranscript("sess-1");
    const text = transcript.messages.map((entry) => entry.text).join("\n");
    expect(text).toContain("./a.ts");
    expect(text).not.toContain(PAT);
    expect(text).not.toContain("/Users/alice");
  });

  it("gives a teammate with no grant a 404, so the upload leaks nothing", async () => {
    const { sharing, org } = await setup();
    await sharing.share("sess-1");
    const bob = await org.clientFor(BOB);
    await expect(bob.getSession("sess-1")).rejects.toMatchObject({
      status: 404,
      code: "not-found",
    });
    await expect(bob.getTranscript("sess-1")).rejects.toMatchObject({ status: 404 });
  });

  it("uploads a long transcript as one replace and then appends", async () => {
    const messages = Array.from({ length: 450 }, (_, index) =>
      message(`m${index}`, "user", `line ${index}`),
    );
    const { sharing, client } = await setup({ session: localSession(messages) });
    expect(await sharing.share("sess-1")).toMatchObject({ success: true, messageCount: 450 });
    expect((await client.getSession("sess-1")).session.transcript.messageCount).toBe(450);
    await sharing.share("sess-1");
    expect((await client.getSession("sess-1")).session.transcript.messageCount).toBe(450);
  });

  it("reports an unlinked workspace, a missing session and a signed-out person", async () => {
    expect(await (await setup({ linked: false })).sharing.share("sess-1")).toEqual({
      success: false,
      error: "workspace-repo-not-in-org",
    });
    expect(await (await setup({ session: null })).sharing.share("sess-1")).toEqual({
      success: false,
      error: "session-not-found",
    });
    const signedOut = await setup();
    signedOut.getClient.mockResolvedValue(null);
    expect(await signedOut.sharing.share("sess-1")).toEqual({
      success: false,
      error: "not-signed-in",
    });
  });

  it("surfaces 403 not-a-member without queuing it", async () => {
    const { sharing, outbox } = await setup({ principal: OUTSIDER });
    const result = await sharing.share("sess-1");
    expect(result).toEqual({ success: false, error: "not-a-member" });
    expect(outbox.entries).toEqual([]);
  });

  it("surfaces a permanent refusal (unserved workspace) without queuing it", async () => {
    const { sharing, outbox } = await setup({ unservedWorkspace: true });
    expect(await sharing.share("sess-1")).toEqual({ success: false, error: "invalid-request" });
    expect(outbox.entries).toEqual([]);
  });
});

describe("OrgSessionSharing review sessions", () => {
  it.each([
    ["a reviewer role", { runtimeAgentRole: "reviewer" }],
    ["the read-only reviewer mode", { permissionMode: "read-only-reviewer" }],
  ])("refuses to preview, share or queue a session with %s", async (_label, overrides) => {
    const { sharing, org, outboxLoad } = await setup({
      session: localSession(
        [message("1", "user", "<external_content>a run</external_content>")],
        overrides,
      ),
    });
    const before = org.provider.requests.length;
    expect(await sharing.preview("sess-1")).toEqual({ success: false, error: "not-shareable" });
    expect(await sharing.share("sess-1")).toEqual({ success: false, error: "not-shareable" });
    expect(await sharing.share("sess-1", { strict: true })).toEqual({
      success: false,
      error: "not-shareable",
    });
    expect(org.provider.requests.length).toBe(before);
    expect((await outboxLoad.mock.results[0]?.value) ?? []).toEqual([]);
  });
});

describe("OrgSessionSharing outbox", () => {
  it("queues a share when the organization is unreachable and delivers it on the next flush", async () => {
    let offline = false;
    const { sharing, outbox, client } = await setup({
      fetchWrapper: (inner) => async (input, init) => {
        if (offline && input.includes("/v1/sessions")) throw new TypeError("offline");
        return inner(input, init);
      },
    });
    offline = true;
    expect(await sharing.share("sess-1")).toEqual({
      success: true,
      state: "queued",
      messageCount: 2,
    });
    expect(outbox.entries).toHaveLength(1);
    expect(outbox.entries[0]).toMatchObject({ sessionId: "sess-1", orgId: "acme", attempts: 1 });
    await sharing.flushOutbox();
    expect(outbox.entries[0]?.attempts).toBe(2);
    offline = false;
    await sharing.flushOutbox();
    expect(outbox.entries).toEqual([]);
    expect((await client.getSession("sess-1")).session.transcript.messageCount).toBe(2);
  });

  it("keeps a queued share for another organization untouched", async () => {
    const { sharing, outbox } = await setup();
    outbox.entries = [
      {
        sessionId: "other",
        orgId: "other-org",
        queuedAt: 1,
        attempts: 1,
        upload: {
          id: "other",
          workspaceId: "ws:platform",
          title: "t",
          owner: ALICE,
          createdAt: "2026-11-03T09:00:00.000Z",
          updatedAt: "2026-11-03T09:00:00.000Z",
          labels: "team",
          runtime: "claude",
        },
        messages: [],
      },
    ];
    await sharing.flushOutbox();
    expect(outbox.entries).toHaveLength(1);
  });
});

describe("OrgSessionSharing preview", () => {
  it("lists the Brain and memory results a teammate could not read", async () => {
    const assistant: SessionMessage = {
      ...message("2", "assistant", "found it"),
      toolCalls: [
        {
          id: "t1",
          name: "knowledge.search",
          description: "",
          output: JSON.stringify({
            hits: [
              { title: "Team handbook", audience: "team" },
              { title: "Board notes", audience: "staff" },
            ],
          }),
        },
        {
          id: "t2",
          name: "recall",
          description: "",
          output: JSON.stringify([{ fact: "Alice's private note", audience: "user:alice" }]),
        },
      ],
    };
    const { sharing } = await setup({
      session: localSession([message("1", "user", "q"), assistant]),
    });
    const preview = await sharing.preview("sess-1");
    expect(preview).toMatchObject({
      success: true,
      label: "restricted",
      orgWorkspaceId: "ws:platform",
      messageCount: 2,
      queued: false,
    });
    if (!preview.success) return;
    expect(preview.restrictedItems.map((item) => [item.source, item.label])).toEqual([
      ["brain", "Board notes"],
      ["memory", "Alice's private note"],
    ]);
  });

  it("is empty for a session with nothing restricted", async () => {
    const { sharing } = await setup();
    expect(await sharing.preview("sess-1")).toMatchObject({
      success: true,
      label: "team",
      restrictedItems: [],
    });
  });
});

describe("paginateTranscript", () => {
  it("respects the 200-message page cap and always returns a page", () => {
    const messages = Array.from({ length: 401 }, (_, index) => ({
      role: "user" as const,
      text: `m${index}`,
      at: "2026-11-03T10:00:00.000Z",
    }));
    expect(paginateTranscript(messages).map((page) => page.length)).toEqual([200, 200, 1]);
    expect(paginateTranscript([])).toEqual([[]]);
  });
});

describe("OrgSessionSharing chosen workspace", () => {
  const noWorkspace = () =>
    localSession([message("1", "user", "hello"), message("2", "assistant", "hi")], {
      workspaceName: undefined,
      repoPath: undefined,
    });

  it("offers a session without a workspace a choice instead of a dead end", async () => {
    const { sharing } = await setup({
      session: noWorkspace(),
      choices: new InMemoryOrgSessionWorkspaceStore(),
    });
    expect(await sharing.share("sess-1")).toEqual({
      success: false,
      error: "workspace-not-linked",
    });
    expect(await sharing.workspaceMapping("sess-1")).toEqual({
      success: true,
      mapping: {
        mapped: false,
        reason: "no-workspace",
        message:
          "This session has no workspace, so it can't be moved to the cloud. To share it, pick an organization workspace.",
      },
      canChoose: true,
    });
  });

  it("lists only the workspaces without a data boundary", async () => {
    const { sharing } = await setup({ choices: new InMemoryOrgSessionWorkspaceStore() });
    expect(await sharing.shareWorkspaces()).toEqual({
      success: true,
      workspaces: [
        { id: "ws:platform", displayName: "Platform" },
        { id: "ws:research", displayName: "Research" },
      ],
    });
  });

  it("shares a workspace-less session into the chosen workspace and remembers it", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore();
    const { sharing, client } = await setup({ session: noWorkspace(), choices });
    const chosen = await sharing.chooseWorkspace({
      sessionId: "sess-1",
      orgWorkspaceId: "ws:research",
    });
    expect(chosen).toMatchObject({
      success: true,
      chosen: { id: "ws:research", displayName: "Research" },
      canChoose: true,
    });
    expect(choices.choices).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        orgId: "acme",
        orgWorkspaceId: "ws:research",
      }),
    ]);
    expect(await sharing.workspaceMapping("sess-1")).toMatchObject({
      success: true,
      chosen: { id: "ws:research", displayName: "Research" },
    });
    expect(await sharing.preview("sess-1")).toMatchObject({
      success: true,
      orgWorkspaceId: "ws:research",
    });
    expect(await sharing.share("sess-1")).toMatchObject({ success: true, state: "uploaded" });
    expect((await client.getSession("sess-1")).session.workspaceId).toBe("ws:research");
  });

  it("shares an unmapped workspace's session into the chosen workspace", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore();
    const { sharing, client } = await setup({ linked: false, choices });
    expect(await sharing.workspaceMapping("sess-1")).toMatchObject({
      success: true,
      mapping: { mapped: false, reason: "repo-not-in-org" },
      canChoose: true,
    });
    await sharing.chooseWorkspace({ sessionId: "sess-1", orgWorkspaceId: "ws:research" });
    expect(await sharing.share("sess-1")).toMatchObject({ success: true, state: "uploaded" });
    expect((await client.getSession("sess-1")).session.workspaceId).toBe("ws:research");
  });

  it("refuses a bounded or unknown workspace and stores nothing", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore();
    const { sharing } = await setup({ session: noWorkspace(), choices });
    for (const orgWorkspaceId of ["ws:vault", "ws:nowhere"]) {
      // eslint-disable-next-line no-await-in-loop -- two cases, in order
      expect(await sharing.chooseWorkspace({ sessionId: "sess-1", orgWorkspaceId })).toEqual({
        success: false,
        error: "workspace-not-served",
      });
    }
    expect(choices.choices).toEqual([]);
  });

  it("never lets a choice override a mapped workspace", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore([
      { sessionId: "sess-1", orgId: "acme", orgWorkspaceId: "ws:research", chosenAt: 1 },
    ]);
    const { sharing, client } = await setup({ choices });
    expect(
      await sharing.chooseWorkspace({ sessionId: "sess-1", orgWorkspaceId: "ws:research" }),
    ).toEqual({ success: false, error: "workspace-mapped" });
    const mapping = await sharing.workspaceMapping("sess-1");
    expect(mapping).toMatchObject({ success: true, mapping: { mapped: true } });
    expect(mapping.success && mapping.chosen).toBeFalsy();
    await sharing.share("sess-1");
    expect((await client.getSession("sess-1")).session.workspaceId).toBe("ws:platform");
  });

  it("ignores the choice for callers that need the session's own mapping (Move to cloud)", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore([
      { sessionId: "sess-1", orgId: "acme", orgWorkspaceId: "ws:research", chosenAt: 1 },
    ]);
    const { sharing } = await setup({ session: noWorkspace(), choices });
    expect(await sharing.preview("sess-1", { mappedOnly: true })).toEqual({
      success: false,
      error: "workspace-not-linked",
    });
    expect(await sharing.share("sess-1", { strict: true, mappedOnly: true })).toEqual({
      success: false,
      error: "workspace-not-linked",
    });
  });

  it("ignores a choice made in another organization", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore([
      { sessionId: "sess-1", orgId: "other-org", orgWorkspaceId: "ws:research", chosenAt: 1 },
    ]);
    const { sharing } = await setup({ session: noWorkspace(), choices });
    expect(await sharing.share("sess-1")).toEqual({
      success: false,
      error: "workspace-not-linked",
    });
  });

  it("drops back to choosing when the chosen workspace is no longer served", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore([
      { sessionId: "sess-1", orgId: "acme", orgWorkspaceId: "ws:gone", chosenAt: 1 },
    ]);
    const { sharing } = await setup({ session: noWorkspace(), choices });
    expect(await sharing.share("sess-1")).toEqual({
      success: false,
      error: "workspace-not-served",
    });
  });

  it("does nothing with org.sessionSharing off", async () => {
    const choices = new InMemoryOrgSessionWorkspaceStore();
    const { sharing, org, getClient } = await setup({
      flags: OFF,
      session: noWorkspace(),
      choices,
    });
    const before = org.provider.requests.length;
    expect(
      await sharing.chooseWorkspace({ sessionId: "sess-1", orgWorkspaceId: "ws:research" }),
    ).toEqual({ success: false, error: "disabled" });
    expect(await sharing.shareWorkspaces()).toEqual({ success: false, error: "disabled" });
    expect(getClient).not.toHaveBeenCalled();
    expect(choices.choices).toEqual([]);
    expect(org.provider.requests.length).toBe(before);
  });
});
