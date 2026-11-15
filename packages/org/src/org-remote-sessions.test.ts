import { OrgClient, fetchOrgDiscovery, type OrgSessionUpload } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import {
  OrgRemoteSessions,
  remoteSessionErrorCode,
  type OrgRemoteSessionsClient,
} from "./org-remote-sessions";
import { OrgNotSignedInError, type OrgFlags } from "./org-service";

const ON: OrgFlags = { enabled: true, signIn: true, workspaces: false, remoteSessions: true };
const OFF: OrgFlags = { enabled: true, signIn: true, workspaces: false, remoteSessions: false };
const ADA = "user:ada";
const BOB = "user:bob";
const CAL = "user:cal";
type Principal = `user:${string}`;

const upload = (
  id: string,
  owner: Principal = ADA,
  updatedAt = "2026-11-03T10:00:00Z",
): OrgSessionUpload => ({
  id,
  workspaceId: "ws:platform",
  title: `Session ${id}`,
  owner,
  createdAt: "2026-11-03T09:00:00Z",
  updatedAt,
  labels: "team",
  runtime: "claude",
});

async function setup(
  options: {
    flags?: OrgFlags;
    features?: (
      | "signIn"
      | "workspaces"
      | "directory"
      | "sessions"
      | "notifications"
      | "mentions"
      | "leases"
    )[];
  } = {},
) {
  const org = createInMemoryOrgProvider({
    users: [
      { principal: ADA, email: "ada@example.test", displayName: "Ada" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
      { principal: CAL, email: "cal@example.test", displayName: "Cal" },
    ],
    workspaces: [{ id: "ws:platform", displayName: "Platform", repositories: [] }],
    features: options.features ?? ["signIn", "workspaces", "sessions", "notifications"],
  });
  const discovery = await fetchOrgDiscovery(org.orgUrl, { fetch: org.fetch });
  const clientFor = (principal: Principal) =>
    new OrgClient({
      discovery,
      accessToken: async () => org.issueToken(principal),
      fetch: org.fetch,
    });
  const ada = clientFor(ADA);
  await ada.putSession(upload("s1"));
  await ada.putTranscript("s1", {
    mode: "replace",
    messages: [
      { role: "user", text: "hello", at: "2026-11-03T09:00:00Z" },
      { role: "assistant", text: "hi", at: "2026-11-03T09:00:01Z" },
    ],
  });
  await ada.putSession(upload("s2", ADA, "2026-11-03T11:00:00Z"));
  await ada.grantSession("s1", { principal: BOB, role: "viewer", notify: true });
  await ada.grantSession("s2", { principal: CAL, role: "viewer" });
  const getClient = vi.fn<() => Promise<OrgRemoteSessionsClient | null>>(async () =>
    clientFor(BOB),
  );
  const service = new OrgRemoteSessions({
    getFlags: () => options.flags ?? ON,
    getClient,
    getSignedInOrgId: () => "fake",
  });
  return { org, ada, service, getClient, clientFor };
}

describe("OrgRemoteSessions with org.remoteSessions off", () => {
  it("makes no client lookup and no network call", async () => {
    const { service, getClient, org } = await setup({ flags: OFF });
    const before = org.requests.length;
    const disabled = { success: false, error: "disabled" };
    expect(await service.list()).toEqual(disabled);
    expect(await service.get("s1")).toEqual(disabled);
    expect(await service.listNotifications()).toEqual(disabled);
    expect(await service.markSessionRead("s1")).toEqual(disabled);
    expect(getClient).not.toHaveBeenCalled();
    expect(org.requests.length).toBe(before);
  });
});

describe("OrgRemoteSessions with org.remoteSessions on", () => {
  it("lists only sessions the caller has a role on, with owner, workspace and role", async () => {
    const { service } = await setup();
    const result = await service.list();
    expect(result).toEqual({
      success: true,
      sessions: [
        {
          id: "s1",
          title: "Session s1",
          owner: ADA,
          workspaceId: "ws:platform",
          workspaceName: "Platform",
          role: "viewer",
          updatedAt: "2026-11-03T10:00:00Z",
          runtime: "claude",
          messageCount: 2,
        },
      ],
    });
  });

  it("never lists sessions the caller owns, shared or not", async () => {
    const { service, clientFor } = await setup();
    const bob = clientFor(BOB);
    await bob.putSession(upload("mine", BOB, "2026-11-03T12:00:00Z"));
    await bob.putSession(upload("mine-shared", BOB, "2026-11-03T13:00:00Z"));
    await bob.grantSession("mine-shared", { principal: CAL, role: "viewer" });
    const result = await service.list();
    if (!result.success) throw new Error("unreachable");
    expect(result.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("leaves marshal-sdk runs to the SDK hosts list", async () => {
    const { service, ada } = await setup();
    await ada.putSession({ ...upload("msdk-1"), runtime: "marshal-sdk" });
    await ada.grantSession("msdk-1", { principal: BOB, role: "viewer" });
    const result = await service.list();
    if (!result.success) throw new Error("unreachable");
    expect(result.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("returns the transcript of a shared session and reuses it while unchanged", async () => {
    const { service, org } = await setup();
    const first = await service.get("s1");
    expect(first).toMatchObject({ success: true, truncated: false, session: { role: "viewer" } });
    if (!first.success) throw new Error("unreachable");
    expect(first.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
    ]);
    const transcriptCalls = () => org.requests.filter((r) => r.url.includes("/transcript")).length;
    const before = transcriptCalls();
    await service.get("s1");
    expect(transcriptCalls()).toBe(before);
  });

  it("refetches the transcript after the owner appends", async () => {
    const { service, ada } = await setup();
    await service.get("s1");
    await ada.putTranscript("s1", {
      mode: "append",
      expectedCount: 2,
      messages: [{ role: "user", text: "more", at: "2026-11-03T09:05:00Z" }],
    });
    const next = await service.get("s1");
    if (!next.success) throw new Error("unreachable");
    expect(next.messages).toHaveLength(3);
  });

  it("answers not-shared for a session the caller has no role on, and for an unknown id", async () => {
    const { service } = await setup();
    expect(await service.get("s2")).toEqual({ success: false, error: "not-shared" });
    expect(await service.get("nope")).toEqual({ success: false, error: "not-shared" });
  });

  it("offers no write path", () => {
    const methods = Object.getOwnPropertyNames(OrgRemoteSessions.prototype);
    expect(methods.filter((name) => /^(put|grant|revoke|send|write|append)/i.test(name))).toEqual(
      [],
    );
  });

  it("reports unauthorized when signed out and not-signed-in without a client", async () => {
    const { service, getClient } = await setup();
    getClient.mockResolvedValueOnce(null);
    expect(await service.list()).toEqual({ success: false, error: "not-signed-in" });
    getClient.mockRejectedValueOnce(new OrgNotSignedInError());
    expect(await service.list()).toEqual({ success: false, error: "unauthorized" });
  });

  it("reports unsupported when the organization does not serve sessions", async () => {
    const { service, getClient } = await setup();
    getClient.mockResolvedValueOnce(testDouble<OrgRemoteSessionsClient>({ supports: () => false }));
    expect(await service.list()).toEqual({ success: false, error: "unsupported" });
  });

  it("lists unread notifications and marks a session's notifications read", async () => {
    const { service } = await setup();
    const unread = await service.listNotifications();
    expect(unread).toMatchObject({ success: true, unreadCount: 1 });
    await service.markSessionRead("s1");
    expect(await service.listNotifications()).toMatchObject({ success: true, unreadCount: 0 });
  });

  it("accepts a handover-request notification instead of rejecting the whole list", async () => {
    const { service, ada, clientFor, getClient } = await setup({
      features: ["signIn", "workspaces", "sessions", "notifications", "leases"],
    });
    await ada.grantSession("s1", { principal: BOB, role: "driver" });
    await ada.acquireLease("s1", { host: "ada-desktop" });
    await clientFor(BOB).requestLeaseHandover("s1", { host: "bob-desktop" });
    getClient.mockImplementation(async () => clientFor(ADA));
    const result = await service.listNotifications();
    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error("unreachable");
    expect(result.notifications.map((notification) => notification.kind)).toContain(
      "handover-request",
    );
  });
});

describe("remoteSessionErrorCode", () => {
  it("maps 401, 404 and 503 and falls back to unreachable", async () => {
    const { OrgApiError } = await import("@marshal/agent-runtime-org");
    expect(remoteSessionErrorCode(new OrgApiError(401, "unauthorized", "x"))).toBe("unauthorized");
    expect(remoteSessionErrorCode(new OrgApiError(404, "not-found", "x"))).toBe("not-shared");
    expect(remoteSessionErrorCode(new OrgApiError(403, "forbidden", "x"))).toBe("not-shared");
    expect(remoteSessionErrorCode(new OrgApiError(503, "unavailable", "x"))).toBe("unavailable");
    expect(remoteSessionErrorCode(new Error("boom"))).toBe("unreachable");
  });
});

describe("OrgRemoteSessions on a live session", () => {
  it("says the session is live and who wrote each user message, when the organization sends both", async () => {
    const { clientFor } = await setup();
    const bob = clientFor(BOB);
    // The in-memory provider's sessions are not live; this client adds what a live session's server sends.
    const client: OrgRemoteSessionsClient = {
      supports: (feature) => bob.supports(feature),
      listSessions: async (input) => {
        const page = await bob.listSessions(input);
        return {
          ...page,
          sessions: page.sessions.map((view) => ({ ...view, live: { enabled: true } })),
        };
      },
      getSession: async (id) => ({ ...(await bob.getSession(id)), live: { enabled: true } }),
      getTranscript: async (id, input) => {
        const page = await bob.getTranscript(id, input);
        return {
          ...page,
          messages: page.messages.map((message) =>
            message.role === "system" ? message : { ...message, author: CAL },
          ),
        };
      },
      listWorkspaces: () => bob.listWorkspaces(),
      listNotifications: (input) => bob.listNotifications(input),
      markNotificationRead: (id) => bob.markNotificationRead(id),
    };
    const service = new OrgRemoteSessions({
      getFlags: () => ON,
      getClient: async () => client,
      getSignedInOrgId: () => "fake",
    });
    const listed = await service.list();
    expect(listed).toMatchObject({ success: true, sessions: [{ id: "s1", live: true }] });
    const detail = await service.get("s1");
    expect(detail).toMatchObject({
      success: true,
      session: { live: true },
      messages: [
        { role: "user", text: "hello", author: CAL },
        { role: "assistant", text: "hi", author: CAL },
      ],
    });
  });

  it("leaves both out for a pack or a server without live sessions", async () => {
    const { service } = await setup();
    const detail = await service.get("s1");
    if (!detail.success) throw new Error("unreachable");
    expect(detail.session).not.toHaveProperty("live");
    expect(detail.messages[0]).not.toHaveProperty("author");
  });
});
