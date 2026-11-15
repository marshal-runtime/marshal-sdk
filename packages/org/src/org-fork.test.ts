import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { OrgClient } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeNativeSessionState } from "../../../electron/backend/runtime-contract";
import { OrgFork, type ForkSessions } from "./org-fork";
import type { OrgFlags } from "./org-service";
import { ALICE, createTestOrg } from "./org-test-harness";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: true,
  fork: true,
};
const FEATURES = [
  "signIn",
  "directory",
  "workspaces",
  "sessions",
  "notifications",
  "leases",
  "cloudRuns",
  "forks",
] as const;
const AT = "2026-11-04T10:00:00.000Z";
const NATIVE = '{"type":"user","uuid":"u1","sessionId":"src"}\n';

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function setup(
  options: {
    flags?: OrgFlags;
    features?: readonly (typeof FEATURES)[number][];
    checkpoint?: boolean;
    createFromNative?: ForkSessions["createFromNative"];
    maxDecompressedBytes?: number;
  } = {},
) {
  const { clientFor } = createTestOrg({ features: [...(options.features ?? FEATURES)] });
  const owner: OrgClient = await clientFor(ALICE);
  await owner.putSession({
    id: "s1",
    workspaceId: "ws:platform",
    title: "Fix the build",
    owner: ALICE,
    createdAt: AT,
    updatedAt: AT,
    labels: "team",
    runtime: "claude",
  });
  if (options.checkpoint !== false) {
    const body = new Uint8Array(gzipSync(Buffer.from(NATIVE)));
    await owner.acquireLease("s1", { host: "desk" });
    await owner.putTranscript("s1", {
      mode: "replace",
      messages: [
        { role: "user", text: "hi", at: AT },
        { role: "assistant", text: "hello", at: AT },
      ],
    });
    await owner.putEnvelope("s1", {
      host: "desk",
      format: "claude-jsonl",
      messageCount: 2,
      sha256: sha256(body),
      bytes: body.length,
      body,
    });
    await owner.releaseLease("s1", { host: "desk", checkpoint: { messageCount: 2 } });
  }
  const created: { name: string; state: RuntimeNativeSessionState }[] = [];
  const createFromNative = vi.fn<ForkSessions["createFromNative"]>(
    options.createFromNative ??
      (async (request) => {
        created.push(request);
        return { success: true, sessionId: "local-1" };
      }),
  );
  const openSession = vi.fn<(sessionId: string) => void>();
  const forkSession = vi.spyOn(owner, "forkSession");
  const service = new OrgFork({
    getFlags: () => options.flags ?? ON,
    getSignedInOrgId: () => "org-1",
    getClient: async () => owner,
    sessions: { createFromNative },
    openSession,
    maxDecompressedBytes: options.maxDecompressedBytes,
  });
  return { service, createFromNative, created, forkSession, owner, openSession };
}

describe("OrgFork", () => {
  it("forks the last checkpoint into a new local session from the downloaded state", async () => {
    const { service, created, openSession } = await setup();
    const result = await service.fork({ sessionId: "s1" });
    expect(openSession).toHaveBeenCalledExactlyOnceWith("local-1");
    expect(result).toMatchObject({
      success: true,
      sessionId: "local-1",
      forkedFrom: { sessionId: "s1", messageCount: 2 },
      codeNotIncluded: true,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe("Fork of Fix the build");
    expect(created[0]?.state.format).toBe("claude-jsonl");
    expect(Buffer.from(created[0]?.state.bytes ?? []).toString()).toBe(NATIVE);
  });

  it("does not switch the app to a session that was not created", async () => {
    const { service, openSession } = await setup({
      createFromNative: async () => ({ success: false, error: "start-failed" }),
    });
    await service.fork({ sessionId: "s1" });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("still reports the fork as made when showing the new session fails", async () => {
    const { service, createFromNative, openSession } = await setup();
    openSession.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    expect(await service.fork({ sessionId: "s1" })).toMatchObject({
      success: true,
      sessionId: "local-1",
    });
    expect(createFromNative).toHaveBeenCalledTimes(1);
  });

  it("makes a second fork after a finished one even when showing it failed", async () => {
    const { service, createFromNative, forkSession, openSession } = await setup();
    openSession.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    await service.fork({ sessionId: "s1" });
    await service.fork({ sessionId: "s1" });
    expect(createFromNative).toHaveBeenCalledTimes(2);
    const keys = forkSession.mock.calls.map(([, request]) => request.clientForkId);
    expect(new Set(keys).size).toBe(2);
  });

  it("does nothing while the flag is off", async () => {
    const { service, forkSession, createFromNative } = await setup({
      flags: { ...ON, fork: false },
    });
    expect(await service.fork({ sessionId: "s1" })).toEqual({ success: false, error: "disabled" });
    expect(forkSession).not.toHaveBeenCalled();
    expect(createFromNative).not.toHaveBeenCalled();
  });

  it("says unsupported when the organization does not serve forks", async () => {
    const { service, forkSession } = await setup({
      features: FEATURES.filter((feature) => feature !== "forks"),
    });
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "unsupported",
    });
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("reports a session with no completed turn", async () => {
    const { service, createFromNative } = await setup({ checkpoint: false });
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "no-checkpoint",
    });
    expect(createFromNative).not.toHaveBeenCalled();
  });

  it("refuses downloaded state that is not what the organization described", async () => {
    const { service, createFromNative, owner } = await setup();
    vi.spyOn(owner, "getForkEnvelope").mockImplementation(async () => ({
      envelope: { format: "claude-jsonl", sha256: "0".repeat(64), bytes: 3, messageCount: 2 },
      body: new Blob([new Uint8Array([1, 2, 3])]).stream(),
    }));
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "envelope-mismatch",
    });
    expect(createFromNative).not.toHaveBeenCalled();
  });

  it("retries with the same key after a transient local failure, so the organization makes one fork", async () => {
    let attempt = 0;
    const { service, forkSession } = await setup({
      createFromNative: async () => {
        attempt += 1;
        return attempt === 1
          ? { success: false, error: "start-failed" }
          : { success: true, sessionId: "local-2" };
      },
    });
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "start-failed",
    });
    expect(await service.fork({ sessionId: "s1" })).toMatchObject({
      success: true,
      sessionId: "local-2",
    });
    const keys = forkSession.mock.calls.map(([, request]) => request.clientForkId);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it.each([
    ["unsupported-format", "unsupported-runtime"],
    ["runtime-unavailable", "runtime-unavailable"],
    ["state-too-large", "state-too-large"],
    ["invalid-state", "envelope-invalid"],
    ["workspace-unavailable", "start-failed"],
    ["already-local", "start-failed"],
    ["start-failed", "start-failed"],
  ] as const)("reports a local %s failure as %s", async (local, expected) => {
    const { service } = await setup({
      createFromNative: async () => ({ success: false, error: local }),
    });
    expect(await service.fork({ sessionId: "s1" })).toEqual({ success: false, error: expected });
  });

  it.each(["unsupported-format", "state-too-large", "invalid-state"] as const)(
    "does not reuse the fork after a final local %s failure, so a later fork copies the current state",
    async (local) => {
      const { service, forkSession } = await setup({
        createFromNative: async () => ({ success: false, error: local }),
      });
      await service.fork({ sessionId: "s1" });
      await service.fork({ sessionId: "s1" });
      const keys = forkSession.mock.calls.map(([, request]) => request.clientForkId);
      expect(new Set(keys).size).toBe(2);
    },
  );

  it("refuses state that unpacks past the limit without starting a session", async () => {
    const { service, createFromNative } = await setup({ maxDecompressedBytes: 8 });
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "envelope-invalid",
    });
    expect(createFromNative).not.toHaveBeenCalled();
  });

  it("starts one fork for a second click while the first is running", async () => {
    const { service, forkSession } = await setup();
    const [first, second] = await Promise.all([
      service.fork({ sessionId: "s1" }),
      service.fork({ sessionId: "s1" }),
    ]);
    expect(first).toEqual(second);
    expect(forkSession).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh key for the next fork of the same session once one has finished", async () => {
    const { service, forkSession } = await setup();
    await service.fork({ sessionId: "s1" });
    await service.fork({ sessionId: "s1" });
    const keys = forkSession.mock.calls.map(([, request]) => request.clientForkId);
    expect(new Set(keys).size).toBe(2);
  });
});
