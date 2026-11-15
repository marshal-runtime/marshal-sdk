import { OrgClient, fetchOrgDiscovery, type FetchLike } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OrgRemoteSessions, type OrgRemoteSessionsClient } from "./org-remote-sessions";

const ADA = "user:ada";
const BOB = "user:bob";

describe("M1 gate: a notification of a kind this desktop does not know", () => {
  it("is skipped, and the rest of the list still reaches the person", async () => {
    const org = createInMemoryOrgProvider({
      users: [
        { principal: ADA, email: "ada@example.test", displayName: "Ada" },
        { principal: BOB, email: "bob@example.test", displayName: "Bob" },
      ],
      workspaces: [{ id: "ws:platform", displayName: "Platform", repositories: [] }],
      features: ["signIn", "workspaces", "sessions", "notifications"],
    });
    const discovery = await fetchOrgDiscovery(org.orgUrl, { fetch: org.fetch });
    const at = "2026-11-03T09:00:00Z";
    const withUnknown: FetchLike = async (url, init) => {
      const response = await org.fetch(url, init);
      if (!new URL(url).pathname.endsWith("/v1/notifications") || init?.method === "POST")
        return response;
      const page = z.object({ notifications: z.array(z.unknown()) }).parse(await response.json());
      page.notifications.unshift({
        id: "n-future",
        kind: "future-kind",
        sessionId: "s1",
        from: ADA,
        at,
        read: false,
      });
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ada = new OrgClient({
      discovery,
      accessToken: async () => org.issueToken(ADA),
      fetch: org.fetch,
    });
    await ada.putSession({
      id: "s1",
      workspaceId: "ws:platform",
      title: "t",
      owner: ADA,
      createdAt: at,
      updatedAt: at,
      labels: "team",
      runtime: "claude",
    });
    await ada.grantSession("s1", { principal: BOB, role: "viewer", notify: true });
    const bob: OrgRemoteSessionsClient = new OrgClient({
      discovery,
      accessToken: async () => org.issueToken(BOB),
      fetch: withUnknown,
    });
    const service = new OrgRemoteSessions({
      getFlags: () => ({ enabled: true, signIn: true, workspaces: true, remoteSessions: true }),
      getClient: async () => bob,
      getSignedInOrgId: () => "fake",
    });
    const result = await service.listNotifications();
    expect(result).toMatchObject({ success: true, unreadCount: 1 });
    expect(result.success && result.notifications.map((entry) => entry.kind)).toEqual(["share"]);
    expect(await service.markSessionRead("s1")).toMatchObject({ success: true });
  });
});
