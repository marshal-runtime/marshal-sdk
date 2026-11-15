import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { OrgClient } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import { OrgFork, type ForkSessions } from "./org-fork";
import { ALICE, createTestOrg } from "./org-test-harness";

vi.mock("../../../electron/backend/claude/native-state", () => ({ MAX_NATIVE_STATE_BYTES: 8 }));

const AT = "2026-11-04T10:00:00.000Z";

describe("OrgFork default unpack limit", () => {
  it("is the native-state cap: a state that unpacks past it is refused without starting a session", async () => {
    const { clientFor } = createTestOrg({
      features: ["signIn", "sessions", "leases", "forks", "cloudRuns", "notifications"],
    });
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
    const body = new Uint8Array(gzipSync(Buffer.from('{"type":"user","sessionId":"src"}\n')));
    await owner.acquireLease("s1", { host: "desk" });
    await owner.putTranscript("s1", {
      mode: "replace",
      messages: [{ role: "user", text: "hi", at: AT }],
    });
    await owner.putEnvelope("s1", {
      host: "desk",
      format: "claude-jsonl",
      messageCount: 1,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
      body,
    });
    await owner.releaseLease("s1", { host: "desk", checkpoint: { messageCount: 1 } });
    const createFromNative = vi.fn<ForkSessions["createFromNative"]>();
    const service = new OrgFork({
      getFlags: () => ({
        enabled: true,
        signIn: true,
        workspaces: true,
        remoteSessions: true,
        fork: true,
      }),
      getSignedInOrgId: () => "org-1",
      getClient: async () => owner,
      sessions: { createFromNative },
      openSession: vi.fn<(sessionId: string) => void>(),
    });
    expect(await service.fork({ sessionId: "s1" })).toEqual({
      success: false,
      error: "envelope-invalid",
    });
    expect(createFromNative).not.toHaveBeenCalled();
  });
});
