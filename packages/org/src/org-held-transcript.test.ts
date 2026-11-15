import { OrgApiError, type OrgTranscriptMessage } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import { InMemoryOrgCloudMoveStore } from "./org-cloud-move-store";
import { OrgHeldTranscript, type OrgTranscriptClient } from "./org-held-transcript";
import type { OrgFlags } from "./org-service";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  remoteMode: true,
};
const SESSION = "sess-1";

function line(
  index: number,
  role: OrgTranscriptMessage["role"] = "assistant",
): OrgTranscriptMessage {
  return { role, text: `message ${index}`, at: "2026-11-04T10:00:00Z" };
}

/** A cloud transcript the test can grow; pages of `pageSize` with an opaque cursor. */
function fakeClient(initial: OrgTranscriptMessage[], pageSize = 100) {
  const state = { messages: initial, updatedAt: 1, failWith: undefined as Error | undefined };
  const getSession = vi.fn<OrgTranscriptClient["getSession"]>(async () => {
    if (state.failWith) throw state.failWith;
    return {
      role: "owner",
      session: {
        id: SESSION,
        workspaceId: "ws:w",
        title: "t",
        owner: "user:u",
        createdAt: "2026-11-04T09:00:00Z",
        updatedAt: `2026-11-04T10:00:0${state.updatedAt}Z`,
        labels: "team",
        runtime: "claude",
        transcript: { messageCount: state.messages.length, bytes: 0 },
      },
    };
  });
  const getTranscript = vi.fn<OrgTranscriptClient["getTranscript"]>(async (_id, input) => {
    const from = Number(input?.cursor ?? 0);
    const to = Math.min(from + (input?.limit ?? pageSize), state.messages.length);
    return {
      messages: state.messages.slice(from, to),
      total: state.messages.length,
      ...(to < state.messages.length ? { nextCursor: String(to) } : {}),
    };
  });
  const client: OrgTranscriptClient = { supports: () => true, getSession, getTranscript };
  return { client, state, getSession, getTranscript };
}

function setup(options: { flags?: OrgFlags; held?: boolean; messageCount?: number } = {}) {
  const moves = new InMemoryOrgCloudMoveStore();
  if (options.held !== false) {
    moves.save([
      {
        sessionId: SESSION,
        orgId: "org",
        runId: "r",
        host: "h",
        movedAt: 1,
        messageCount: options.messageCount ?? 2,
        state: "cloud",
      },
    ]);
  }
  const cloud = fakeClient([line(0, "user"), line(1), line(2, "tool"), line(3), line(4, "user")]);
  const service = new OrgHeldTranscript({
    getFlags: () => options.flags ?? ON,
    getClient: async () => cloud.client,
    getSignedInOrgId: () => "org",
    moves,
  });
  return { service, cloud, moves };
}

describe("OrgHeldTranscript", () => {
  it("returns only what the cloud wrote after the move, tool steps included", async () => {
    const { service } = setup();
    const result = await service.get(SESSION);
    expect(result).toMatchObject({ success: true, total: 3, truncated: false });
    expect(result.success && result.messages.map((m) => [m.id, m.role, m.text])).toEqual([
      [`${SESSION}:2`, "tool", "message 2"],
      [`${SESSION}:3`, "assistant", "message 3"],
      [`${SESSION}:4`, "user", "message 4"],
    ]);
  });

  it("polls an unchanged session with one small request and reads again when it grew", async () => {
    const { service, cloud } = setup();
    await service.get(SESSION);
    await service.get(SESSION);
    expect(cloud.getSession).toHaveBeenCalledTimes(2);
    expect(cloud.getTranscript).toHaveBeenCalledTimes(1);
    cloud.state.messages = [...cloud.state.messages, line(5)];
    const grown = await service.get(SESSION);
    expect(cloud.getTranscript).toHaveBeenCalledTimes(2);
    expect(grown.success && grown.total).toBe(4);
  });

  it("keeps the newest 200 and says how many there were", async () => {
    const { service, cloud } = setup({ messageCount: 0 });
    cloud.state.messages = Array.from({ length: 450 }, (_, i) => line(i));
    const result = await service.get(SESSION);
    expect(result.success && result.total).toBe(450);
    expect(result.success && result.messages).toHaveLength(200);
    expect(result.success && result.messages[0]?.text).toBe("message 250");
    expect(result.success && result.messages.at(-1)?.text).toBe("message 449");
  });

  it("shows the new messages of a session that was moved with 5000 or more, once the read has caught up", async () => {
    const { service, cloud } = setup({ messageCount: 5200 });
    cloud.state.messages = [
      ...Array.from({ length: 5200 }, (_, i) => line(i)),
      line(5200),
      line(5201, "user"),
      line(5202),
    ];
    const first = await service.get(SESSION);
    expect(first).toMatchObject({ success: true, truncated: true });
    const second = await service.get(SESSION);
    expect(second).toMatchObject({ success: true, total: 3, truncated: false });
    expect(second.success && second.messages.map((m) => [m.id, m.text])).toEqual([
      [`${SESSION}:5200`, "message 5200"],
      [`${SESSION}:5201`, "message 5201"],
      [`${SESSION}:5202`, "message 5202"],
    ]);
  });

  it("reads one page, not the whole history, when a long session grows", async () => {
    const { service, cloud } = setup({ messageCount: 1000 });
    cloud.state.messages = Array.from({ length: 1010 }, (_, i) => line(i));
    const first = await service.get(SESSION);
    expect(first).toMatchObject({ success: true, total: 10, truncated: false });
    expect(cloud.getTranscript).toHaveBeenCalledTimes(6);
    cloud.getTranscript.mockClear();
    cloud.state.messages = [...cloud.state.messages, line(1010), line(1011)];
    const grown = await service.get(SESSION);
    expect(cloud.getTranscript).toHaveBeenCalledTimes(1);
    expect(grown).toMatchObject({ success: true, total: 12, truncated: false });
    expect(grown.success && grown.messages.map((m) => m.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `${SESSION}:${1000 + i}`),
    );
  });

  it("starts over when the session was moved again", async () => {
    const { service, cloud, moves } = setup({ messageCount: 2 });
    await service.get(SESSION);
    moves.save([
      {
        sessionId: SESSION,
        orgId: "org",
        runId: "r2",
        host: "h",
        movedAt: 2,
        messageCount: 4,
        state: "cloud",
      },
    ]);
    const again = await service.get(SESSION);
    expect(again).toMatchObject({ success: true, total: 1 });
    expect(again.success && again.messages[0]?.text).toBe("message 4");
    expect(cloud.getTranscript).toHaveBeenCalledTimes(2);
  });

  it("is inert with the flag off and never reads a session the cloud does not hold", async () => {
    const off = setup({ flags: { ...ON, remoteMode: false } });
    expect(await off.service.get(SESSION)).toEqual({ success: false, error: "disabled" });
    expect(off.cloud.getSession).not.toHaveBeenCalled();
    const notHeld = setup({ held: false });
    expect(await notHeld.service.get(SESSION)).toEqual({ success: false, error: "not-in-cloud" });
    expect(notHeld.cloud.getSession).not.toHaveBeenCalled();
  });

  it("reports an unreachable organization as a short code, not the server's message", async () => {
    const { service, cloud } = setup();
    cloud.state.failWith = new OrgApiError(0, "unreachable", "secret detail");
    expect(await service.get(SESSION)).toEqual({ success: false, error: "unreachable" });
  });
});
