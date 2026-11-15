import {
  OrgApiError,
  OrgFeatureUnavailableError,
  type OrgSessionView,
} from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { OrgCloudSessionSummary } from "../../../common/marshal-ipc-contract";
import { testDouble } from "../../../electron/testing/harness";
import { OrgCloudSessions, type OrgCloudSessionsClient } from "./org-cloud-sessions";
import { OrgNotSignedInError, type OrgFlags } from "./org-service";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  cloudGroup: true,
};
const OFF: OrgFlags = { ...ON, cloudGroup: false };
const ADA = "user:ada";

function view(
  id: string,
  extra: Partial<OrgSessionView> = {},
  updatedAt = "2026-11-04T10:00:00.000Z",
) {
  return {
    session: {
      id,
      workspaceId: "ws:platform",
      title: `Session ${id}`,
      owner: ADA,
      createdAt: updatedAt,
      updatedAt,
      labels: "team",
      runtime: "claude",
      transcript: { messageCount: 1, bytes: 10 },
    },
    role: "owner",
    placement: "cloud",
    ...extra,
  } satisfies OrgSessionView;
}

function make(
  options: {
    flags?: OrgFlags;
    supports?: (feature: string) => boolean;
    views?: OrgSessionView[];
    movedHere?: string[];
    local?: string[];
    stranded?: OrgCloudSessionSummary[];
    fail?: unknown;
    signedOut?: boolean;
  } = {},
) {
  const listSessions = vi.fn<OrgCloudSessionsClient["listSessions"]>(async () => {
    if (options.fail) throw options.fail;
    return { sessions: options.views ?? [] };
  });
  const getClient = vi.fn<() => Promise<OrgCloudSessionsClient | null>>(async () =>
    options.signedOut
      ? null
      : testDouble<OrgCloudSessionsClient>({
          supports: options.supports ?? (() => true),
          listSessions,
        }),
  );
  const openExternal = vi.fn<(url: string) => boolean>(() => true);
  const forgetStranded = vi.fn<(id: string) => void>();
  const service = new OrgCloudSessions({
    getFlags: () => options.flags ?? ON,
    getClient,
    listMovedHere: () => options.movedHere ?? [],
    hasLocalSession: (id) => options.local?.includes(id) ?? false,
    listStranded: () => options.stranded ?? [],
    forgetStranded,
    openExternal,
  });
  return { service, getClient, listSessions, openExternal, forgetStranded };
}

describe("OrgCloudSessions", () => {
  it("builds no client and makes no request with org.cloudGroup off", async () => {
    const { service, getClient, listSessions } = make({ flags: OFF });
    expect(await service.list()).toEqual({ success: false, error: "disabled" });
    expect(getClient).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("asks for the caller's cloud sessions, 50 at most, in one call", async () => {
    const { service, listSessions } = make({ views: [] });
    await service.list();
    expect(listSessions).toHaveBeenCalledOnce();
    expect(listSessions).toHaveBeenCalledWith({ placement: "cloud", owner: "me", limit: 50 });
  });

  it("reports not-signed-in without listing", async () => {
    const signedOut = make({ signedOut: true });
    expect(await signedOut.service.list()).toEqual({ success: false, error: "not-signed-in" });
  });

  it.each(["sessions", "cloudList"])("reports unsupported without %s", async (missing) => {
    const { service, listSessions } = make({ supports: (feature) => feature !== missing });
    expect(await service.list()).toEqual({ success: false, error: "unsupported" });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("hides the sessions moved from this computer and counts them", async () => {
    const { service } = make({
      views: [
        view("moved", { turnState: "running", placement: "cloud", queued: 0 }),
        view("slack-run", {
          turnState: "queued",
          queued: 2,
          lastActivityAt: "2026-11-04T12:00:00.000Z",
        }),
        view("older", { turnState: "idle", lastActivityAt: "2026-11-04T09:00:00.000Z" }),
      ],
      movedHere: ["moved"],
    });
    expect(await service.list()).toEqual({
      success: true,
      movedCount: 1,
      moved: [{ id: "moved", turnState: "running", queued: 0 }],
      sessions: [
        {
          id: "slack-run",
          title: "Session slack-run",
          workspaceId: "ws:platform",
          turnState: "queued",
          queued: 2,
          lastActivityAt: "2026-11-04T12:00:00.000Z",
        },
        {
          id: "older",
          title: "Session older",
          workspaceId: "ws:platform",
          turnState: "idle",
          queued: 0,
          lastActivityAt: "2026-11-04T09:00:00.000Z",
        },
      ],
    });
  });

  it("falls back to idle and the session's update time when the cloud sends no summary", async () => {
    const { service } = make({ views: [view("bare")] });
    const result = await service.list();
    expect(result).toMatchObject({
      success: true,
      sessions: [
        { id: "bare", turnState: "idle", queued: 0, lastActivityAt: "2026-11-04T10:00:00.000Z" },
      ],
    });
  });

  it.each([
    [new OrgNotSignedInError(), "unauthorized"],
    [new OrgFeatureUnavailableError("cloudList"), "unsupported"],
    [new OrgApiError(401, "unauthorized", "unauthorized"), "unauthorized"],
    [new OrgApiError(503, "org-unavailable", "unavailable"), "unavailable"],
    [new Error("boom"), "unreachable"],
  ] as const)("maps %s to %s without the server's message", async (failure, code) => {
    const { service } = make({ fail: failure });
    expect(await service.list()).toEqual({ success: false, error: code });
  });

  it("opens a run link only when the last list served it", async () => {
    const link = "https://github.example/run/1";
    const { service, openExternal } = make({ views: [view("a", { runLink: link })] });
    expect(service.openRunLink(link)).toEqual({ success: false });
    await service.list();
    expect(service.openRunLink("https://evil.example/")).toEqual({ success: false });
    expect(service.openRunLink(link)).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(link);
  });

  it("reports failure when the URL is refused when opening it", async () => {
    const link = "https://github.example/run/1";
    const { service, openExternal } = make({ views: [view("a", { runLink: link })] });
    await service.list();
    openExternal.mockReturnValue(false);
    expect(service.openRunLink(link)).toEqual({ success: false });
  });

  it("does not report a shared or local-placement session as moved, even when its id is in the moved set", async () => {
    const { service } = make({
      views: [
        view("viewer", { role: "viewer" }),
        view("local", { placement: "local" }),
        view("mine"),
      ],
      movedHere: ["viewer", "local"],
    });
    const result = await service.list();
    expect(result.success && result.moved).toEqual([]);
    expect(result.success && result.movedCount).toBe(0);
    expect(result.success && result.sessions.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("drops a session this computer already has in Threads, as Continue here makes one", async () => {
    const { service } = make({
      views: [view("continued"), view("cloud-only")],
      local: ["continued"],
    });
    const result = await service.list();
    expect(result.success && result.sessions.map((entry) => entry.id)).toEqual(["cloud-only"]);
    expect(result.success && result.movedCount).toBe(0);
  });

  it("keeps a session whose Continue here was refused, once, until it is local", async () => {
    const row: OrgCloudSessionSummary = {
      id: "stranded-1",
      title: "Stuck",
      workspaceId: "ws:platform",
      turnState: "idle",
      queued: 0,
      lastActivityAt: "2026-11-04T10:00:00.000Z",
    };
    const kept = make({ views: [], stranded: [row] });
    const result = await kept.service.list();
    expect(result).toMatchObject({ success: true, sessions: [{ ...row, stranded: true }] });
    const local = make({ views: [], stranded: [row], local: ["stranded-1"] });
    expect(await local.service.list()).toMatchObject({ success: true, sessions: [] });
    expect(local.forgetStranded).toHaveBeenCalledWith("stranded-1");
    expect(kept.forgetStranded).not.toHaveBeenCalled();
  });

  it("dismisses a stranded row only with the flag on", async () => {
    const on = make();
    expect(on.service.dismissStranded("s1")).toEqual({ success: true });
    expect(on.forgetStranded).toHaveBeenCalledWith("s1");
    const off = make({ flags: OFF });
    expect(off.service.dismissStranded("s1")).toEqual({ success: false });
    expect(off.forgetStranded).not.toHaveBeenCalled();
  });

  it("keeps only the caller's own cloud sessions, whatever the server sent", async () => {
    const { service } = make({
      views: [
        view("mine"),
        view("shared", { role: "viewer" }),
        view("local", { placement: "local" }),
        view("unplaced", { placement: undefined }),
      ],
    });
    const result = await service.list();
    expect(result.success && result.sessions.map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("does not open a link with the flag off, even one it served before", async () => {
    const link = "https://github.example/run/1";
    let flags = ON;
    const service = new OrgCloudSessions({
      getFlags: () => flags,
      getClient: async () =>
        testDouble<OrgCloudSessionsClient>({
          supports: () => true,
          listSessions: async () => ({ sessions: [view("a", { runLink: link })] }),
        }),
      listMovedHere: () => [],
      openExternal: vi.fn<(url: string) => boolean>(() => true),
    });
    await service.list();
    flags = OFF;
    expect(service.openRunLink(link)).toEqual({ success: false });
  });
});
