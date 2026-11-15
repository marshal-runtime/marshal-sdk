import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { OrgApiError } from "@marshal/agent-runtime-org";
import {
  isCloudHostId,
  type OrgClient,
  type OrgFeature,
  type OrgSessionMessage,
} from "@marshal/agent-runtime-org";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrgReturnedMessage, SessionMessage } from "../../../common/marshal-ipc-contract";
import {
  readClaudeNativeState,
  writeClaudeNativeState,
} from "../../../electron/backend/claude/native-state";
import type { ShareableSession } from "./cloud-session-sanitizer";
import {
  OrgCloudMove,
  type CloudOnlyContinue,
  restorePersistedCloudLocks,
  type CloudMoveSessions,
  readReturnedMessages,
  type OrgCloudMoveDeps,
} from "./org-cloud-move";
import { InMemoryOrgCloudMoveStore, type OrgCloudMoveStore } from "./org-cloud-move-store";
import { InMemoryOrgCloudStrandedStore } from "./org-cloud-stranded-store";
import { FakeOrgInbox } from "./org-inbox-fake";
import { InMemoryOrgMessageOutbox } from "./org-message-outbox";
import { type OrgInboxClient, OrgRemoteSend } from "./org-remote-send";
import type { OrgFlags } from "./org-service";
import { OrgSessionSharing } from "./org-session-sharing";
import { InMemoryOrgShareOutbox } from "./org-share-outbox";
import { ALICE, BOB, createTestOrg } from "./org-test-harness";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
};
const OFF: OrgFlags = { ...ON, cloudMove: false };
const SESSION_ID = "sess-1";
const NATIVE_ID = "native-1";
const CWD = "/repo";
const SECRET_PAT = `ghp_${"c".repeat(36)}`;
const IMAGE_DATA = "A".repeat(6000);
const NATIVE_V1 =
  [
    { type: "attachment", attachment: { type: "prompt_snapshot", text: "SYSTEM PROMPT TEXT" } },
    { type: "api-request", body: "captured request with the system prompt" },
    { type: "user", uuid: "u1", message: { role: "user", content: "show the env" } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check .env", signature: "SIG+/=abc" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat .env" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: `password=hunter2hunter2\nTOKEN=${SECRET_PAT}`,
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: IMAGE_DATA },
          },
        ],
      },
    },
    { type: "assistant", uuid: "a2", message: { role: "assistant", content: "done" } },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function message(id: string, role: SessionMessage["role"], content: string): SessionMessage {
  return { id, role, content, timestamp: "2026-11-03T10:00:00.000Z" };
}

const localSession = (messages: SessionMessage[]): ShareableSession => ({
  id: SESSION_ID,
  name: "Fix the build",
  createdAt: "2026-11-03T09:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  runtimeId: "claude",
  workspaceName: "Platform",
  repoPath: "/Users/alice/code/platform",
  messages,
});

const beginReturn = () => () => undefined;

const FEATURES = [
  "signIn",
  "directory",
  "workspaces",
  "sessions",
  "notifications",
  "leases",
  "cloudRuns",
] as const;

async function setup(
  options: {
    flags?: OrgFlags;
    messages?: SessionMessage[];
    principal?: `user:${string}`;
    native?: null;
    shareSession?: boolean;
    onSleep?: () => void;
    heartbeatMs?: number;
    afterDetach?: () => void;
    startWithDestination?: OrgCloudMoveDeps["startCloudRunWithDestination"];
    remote?: OrgCloudMoveDeps["remote"];
    features?: readonly OrgFeature[];
  } = {},
) {
  const org = createTestOrg({ features: [...(options.features ?? FEATURES)] });
  const principal = options.principal ?? ALICE;
  const client = await org.clientFor(principal);
  let messages = options.messages ?? [
    message("1", "user", "hello"),
    message("2", "assistant", "hi"),
  ];
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-cloud-move-"));
  tempDirs.push(configDir);
  const nativeFile = path.join(configDir, "projects", "-repo", `${NATIVE_ID}.jsonl`);
  if (options.native !== null) {
    fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
    fs.writeFileSync(nativeFile, NATIVE_V1);
  }
  const outbox = new InMemoryOrgShareOutbox();
  const sharing = new OrgSessionSharing({
    getFlags: () => ON,
    getClient: async () => client,
    getSignedInOrgId: () => "fake",
    loadSession: async () => localSession(messages),
    resolveOrgWorkspace: async () => ({
      mapped: true as const,
      orgWorkspaceId: "ws:platform",
      orgWorkspaceName: "Platform",
      repo: "acme/platform",
    }),
    outbox,
    homeDir: () => "/Users/alice",
  });
  const shareResult =
    options.shareSession === false
      ? { success: true, state: "uploaded" }
      : await sharing.share(SESSION_ID);
  expect(shareResult).toMatchObject({ success: true, state: "uploaded" });
  const locked = new Set<string>();
  const imported: Uint8Array[] = [];
  const events: string[] = [];
  const sessions: CloudMoveSessions = {
    detach: vi.fn<CloudMoveSessions["detach"]>(async (id) => {
      events.push("detach");
      locked.add(id);
      options.afterDetach?.();
    }),
    setLocked: vi.fn<CloudMoveSessions["setLocked"]>((id, value) => {
      if (value) locked.add(id);
      else locked.delete(id);
    }),
    exportNative: vi.fn<CloudMoveSessions["exportNative"]>(() =>
      readClaudeNativeState(configDir, NATIVE_ID, CWD),
    ),
    importNative: vi.fn<CloudMoveSessions["importNative"]>(async (_id, state) => {
      events.push("import");
      await writeClaudeNativeState(configDir, NATIVE_ID, CWD, state);
      imported.push(state.bytes);
      return true;
    }),
  };
  const store = new InMemoryOrgCloudMoveStore();
  const getClient = vi.fn<() => Promise<OrgClient | null>>(async () => client);
  const cloudMove = new OrgCloudMove({
    getFlags: () => options.flags ?? ON,
    getClient,
    getSignedInOrgId: () => "fake",
    ...(options.startWithDestination
      ? { startCloudRunWithDestination: options.startWithDestination }
      : {}),
    sharing,
    sessions,
    store,
    remote: options.remote,
    hostId: "desktop-test",
    sleep: async () => options.onSleep?.(),
    pollIntervalMs: 0,
    handoverTimeoutMs: 50,
    heartbeatMs: options.heartbeatMs ?? 60_000,
  });
  return {
    outbox,
    setMessages: (next: SessionMessage[]) => {
      messages = next;
    },
    events,
    nativeFile,
    configDir,
    org,
    client,
    cloudMove,
    sessions,
    store,
    locked,
    imported,
    getClient,
    clientFor: org.clientFor,
  };
}

describe("OrgCloudMove Move to cloud", () => {
  it("takes the lease, stops the turn, uploads the gzipped native state and starts a cloud run", async () => {
    const { client, cloudMove, sessions, store, locked } = await setup();
    const result = await cloudMove.moveToCloud({ sessionId: SESSION_ID });
    expect(result).toMatchObject({
      success: true,
      run: { status: expect.stringMatching(/starting|running/) },
    });
    expect(sessions.detach).toHaveBeenCalledWith(SESSION_ID);
    expect(locked.has(SESSION_ID)).toBe(true);
    const caps = await client.getCloudCapabilities();
    const lease = await client.getLease(SESSION_ID);
    expect(isCloudHostId(lease.lease!.holder.host, caps.cloudHost)).toBe(true);
    const info = await client.getEnvelopeInfo(SESSION_ID);
    expect(info).toMatchObject({ format: "claude-jsonl", messageCount: 2 });
    expect(store.load()).toHaveLength(1);
    const status = await cloudMove.getStatus(SESSION_ID);
    expect(status).toMatchObject({
      success: true,
      placement: "cloud",
      run: { id: expect.any(String) },
      moveId: store.load()[0] ? String(store.load()[0]?.movedAt) : undefined,
    });
  });

  it("does not even take the lease when the cloud advertises itself unavailable", async () => {
    const { org, client, cloudMove, locked, store } = await setup();
    org.provider.cloud.setAvailable(false);
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "cloud-unavailable",
    });
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(store.load()).toEqual([]);
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
  });

  it("keeps the lease when the cloud turns unavailable between the check and the move", async () => {
    const { org, client, cloudMove, locked, store } = await setup();
    const original = client.getCloudCapabilities.bind(client);
    client.getCloudCapabilities = async () => {
      const caps = await original();
      org.provider.cloud.setAvailable(false);
      return caps;
    };
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "cloud-unavailable",
      orgCopyUpdated: true,
    });
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(store.load()).toEqual([]);
    const view = await client.getLease(SESSION_ID);
    expect(view.lease?.holder.host).toBe("desktop-test");
  });

  it("refuses a session with restricted Brain results before touching the lease", async () => {
    const restricted: SessionMessage = {
      ...message("2", "assistant", "result"),
      toolCalls: [
        {
          id: "t1",
          name: "knowledge.search",
          description: "",
          output: JSON.stringify({ hits: [{ title: "Board notes", audience: "staff" }] }),
        },
      ],
    };
    const { client, cloudMove, sessions } = await setup({
      messages: [message("1", "user", "hi"), restricted],
    });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "restricted-content",
    });
    expect(sessions.detach).not.toHaveBeenCalled();
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
  });

  it("answers lease-held when another host drives the session", async () => {
    const { client, clientFor, cloudMove, sessions } = await setup();
    await client.grantSession(SESSION_ID, { principal: BOB, role: "driver" });
    await (await clientFor(BOB)).acquireLease(SESSION_ID, { host: "bob-desktop" });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "lease-held",
    });
    expect(sessions.detach).not.toHaveBeenCalled();
  });

  it("publishes a never-shared session owner-only before moving it, without any grant", async () => {
    const { client, cloudMove, org, store } = await setup({ shareSession: false });
    await expect(client.getSession(SESSION_ID)).rejects.toMatchObject({ status: 404 });
    const result = await cloudMove.moveToCloud({ sessionId: SESSION_ID });
    expect(result).toMatchObject({ success: true });
    const view = await client.getSession(SESSION_ID);
    expect(view.role).toBe("owner");
    expect(await (await org.clientFor(BOB)).getSession(SESSION_ID).catch((e) => e.status)).toBe(
      404,
    );
    expect(org.provider.requests.some((r) => r.url.includes("/grants"))).toBe(false);
    expect(store.load()).toHaveLength(1);
  });

  it("publishes nothing when a check refuses the move", async () => {
    const noNative = await setup({ shareSession: false, native: null });
    expect(await noNative.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "no-native-state",
    });
    await expect(noNative.client.getSession(SESSION_ID)).rejects.toMatchObject({ status: 404 });
    expect(noNative.locked.has(SESSION_ID)).toBe(false);
  });

  it("never queues the publish on a network blip: the move fails and no outbox entry is left", async () => {
    const ctx = await setup({ shareSession: false });
    const put = ctx.client.putSession.bind(ctx.client);
    ctx.client.putSession = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID });
    expect(result).toMatchObject({ success: false });
    expect(await ctx.outbox.load()).toEqual([]);
    ctx.client.putSession = put;
    await expect(ctx.client.getSession(SESSION_ID)).rejects.toMatchObject({ status: 404 });
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
  });

  it("reports uploaded when the move fails after the publish", async () => {
    const ctx = await setup({ shareSession: false });
    ctx.client.moveToCloud = async () => {
      throw new OrgApiError(503, "unavailable", "down");
    };
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: false,
      uploaded: true,
    });
  });

  it("reports uploaded when the record landed but the transcript upload failed in the first publish", async () => {
    const ctx = await setup({ shareSession: false });
    ctx.client.putTranscript = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: false,
      uploaded: true,
    });
  });

  it("says the org copy was updated when the refresh of an already-shared session succeeded and the move failed", async () => {
    const ctx = await setup();
    ctx.client.moveToCloud = async () => {
      throw new OrgApiError(503, "unavailable", "down");
    };
    const result = await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID });
    expect(result).toMatchObject({ success: false, orgCopyUpdated: true });
    expect(result).not.toHaveProperty("uploaded");
  });

  it("lists every locked session, pending ones included", async () => {
    const ctx = await setup();
    ctx.store.save([
      {
        sessionId: "a",
        orgId: "fake",
        runId: "",
        host: "h",
        movedAt: 1,
        messageCount: 0,
        state: "pending",
      },
      {
        sessionId: "b",
        orgId: "fake",
        runId: "r",
        host: "h",
        movedAt: 1,
        messageCount: 0,
        state: "cloud",
      },
    ]);
    expect(ctx.cloudMove.listHeld()).toEqual({ success: true, sessionIds: ["a", "b"] });
  });

  it("starts the run through the destination path only when a channel was picked", async () => {
    const plain = await setup();
    const spy = vi.spyOn(plain.client, "moveToCloud");
    expect(await plain.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);

    let sent: Record<string, unknown> | undefined;
    const picked = await setup({
      startWithDestination: async (sessionId, body) => {
        sent = body;
        return picked.client.moveToCloud(sessionId, {
          host: String(body.host),
          envelopeSha256: String(body.envelopeSha256),
        });
      },
    });
    expect(
      await picked.cloudMove.moveToCloud({ sessionId: SESSION_ID, slackDestination: "C0123ABCD" }),
    ).toMatchObject({ success: true });
    expect(sent).toMatchObject({ slackDestination: "C0123ABCD" });
  });

  it("reports a 400 as a refused destination only when the server names the destination", async () => {
    const run = async (error: OrgApiError) => {
      const ctx = await setup({
        startWithDestination: async () => {
          throw error;
        },
      });
      return ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID, slackDestination: "C0123ABCD" });
    };
    expect(await run(new OrgApiError(400, "invalid-destination", "x"))).toMatchObject({
      error: "invalid-destination",
    });
    expect(
      await run(new OrgApiError(400, "invalid-request", "answered 400 (field slackDestination)")),
    ).toMatchObject({ error: "invalid-destination" });
    expect(
      await run(new OrgApiError(400, "invalid-request", "answered 400 (field host)")),
    ).toMatchObject({ error: "invalid-request" });
  });

  it("refuses a malformed destination before touching the cloud, and keeps the session local when the server refuses one", async () => {
    const ctx = await setup({
      startWithDestination: async () => {
        throw new OrgApiError(422, "invalid-destination", "x");
      },
    });
    expect(
      await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID, slackDestination: "../x" }),
    ).toEqual({ success: false, error: "invalid-destination" });
    expect(ctx.sessions.detach).not.toHaveBeenCalled();
    expect(
      await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID, slackDestination: "C0123ABCD" }),
    ).toMatchObject({ success: false, error: "invalid-destination" });
    expect(ctx.store.load()).toEqual([]);
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
  });

  it("refuses a session without native state", async () => {
    const noNative = await setup({ native: null });
    expect(await noNative.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "no-native-state",
    });
    expect(noNative.locked.has(SESSION_ID)).toBe(false);
    expect((await noNative.client.getLease(SESSION_ID)).lease).toBeNull();
  });
});

describe("OrgCloudMove Continue here", () => {
  async function moved() {
    const ctx = await setup();
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    return ctx;
  }

  it("asks the cloud to hand over and restores from the fresh envelope it released with", async () => {
    let advance = () => {};
    const ctx = await setup({ onSleep: () => advance() });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    const { org, client, cloudMove, imported, locked, store } = ctx;
    advance = () => org.provider.cloud.advance(SESSION_ID);
    const result = await cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({ success: true, verdict: "fresh" });
    expect(imported).toHaveLength(1);
    expect(new TextDecoder().decode(imported[0])).not.toBe(NATIVE_V1);
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(store.load()).toEqual([]);
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
  });

  it("says the cloud's native state is missing when it crashed after a turn, and restores only when accepted", async () => {
    const { org, client, cloudMove, imported, locked, store } = await moved();
    org.provider.cloud.advance(SESSION_ID, { uploadEnvelope: false });
    org.provider.cloud.crash(SESSION_ID);
    const first = await cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(first).toMatchObject({
      success: false,
      error: "stale-state",
      reason: expect.any(String),
    });
    expect(imported).toHaveLength(0);
    expect(locked.has(SESSION_ID)).toBe(true);
    expect(store.load()).toHaveLength(1);
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
    const accepted = await cloudMove.continueHere({ sessionId: SESSION_ID, acceptStale: true });
    expect(accepted).toMatchObject({ success: true, verdict: "stale-accepted" });
    expect(imported).toHaveLength(1);
    expect(locked.has(SESSION_ID)).toBe(false);
  });

  it("lets only the owner force the lease from a running cloud host", async () => {
    const owner = await moved();
    const forced = await owner.cloudMove.continueHere({
      sessionId: SESSION_ID,
      force: true,
      acceptUnverified: true,
    });
    expect(forced).toMatchObject({ success: true });
    expect(owner.imported).toHaveLength(1);

    const driverCtx = await moved();
    await driverCtx.client.grantSession(SESSION_ID, { principal: BOB, role: "driver" });
    const bobClient = await driverCtx.clientFor(BOB);
    const bobMove = new OrgCloudMove({
      getFlags: () => ON,
      getClient: async () => bobClient,
      getSignedInOrgId: () => "fake",
      sharing: {
        preview: vi.fn<OrgSessionSharing["preview"]>(),
        share: vi.fn<OrgSessionSharing["share"]>(),
      },
      sessions: driverCtx.sessions,
      store: new InMemoryOrgCloudMoveStore(driverCtx.store.load()),
      hostId: "bob-desktop",
      sleep: async () => {},
      pollIntervalMs: 0,
      handoverTimeoutMs: 50,
    });
    expect(await bobMove.continueHere({ sessionId: SESSION_ID, force: true })).toEqual({
      success: false,
      error: "forbidden",
    });
  });

  it("without force, reports the cloud still running when it never releases", async () => {
    const { cloudMove, imported } = await moved();
    expect(await cloudMove.continueHere({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "cloud-still-running",
    });
    expect(imported).toHaveLength(0);
  });

  it("refuses a session that is not in the cloud", async () => {
    const { cloudMove } = await setup();
    expect(await cloudMove.continueHere({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "not-in-cloud",
    });
  });
});

describe("OrgCloudMove returned messages", () => {
  const returnedMessage = (seq: number, clientMsgId: string, text: string): OrgSessionMessage => ({
    id: `m${seq}`,
    seq,
    clientMsgId,
    author: "user:me",
    source: "desktop",
    roleAtSend: "owner",
    text,
    status: "cancelled",
    at: "2026-11-04T10:00:00Z",
  });
  const RETURNED = [
    returnedMessage(1, "desktop-a", "first, never run"),
    returnedMessage(2, "desktop-b", "second, never run"),
  ];

  async function movedWith(options: Parameters<typeof setup>[0] = {}) {
    let advance = () => {};
    const ctx = await setup({ ...options, onSleep: () => advance() });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    advance = () => ctx.org.provider.cloud.advance(SESSION_ID);
    return ctx;
  }

  /** The cloud gives the messages back once, on the first acquire that takes the lease from it. */
  function answerWithReturned(client: OrgClient) {
    const original = client.acquireLease.bind(client);
    let given = false;
    client.acquireLease = async (id, request) => {
      const view = await original(id, request);
      if (given) return view;
      given = true;
      return { ...view, returnedMessages: RETURNED };
    };
  }

  it("hands back the messages the cloud returned on the lease answer, in order", async () => {
    const ctx = await movedWith();
    answerWithReturned(ctx.client);
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({
      success: true,
      verdict: "fresh",
      returnedMessages: [
        { clientMsgId: "desktop-a", text: "first, never run" },
        { clientMsgId: "desktop-b", text: "second, never run" },
      ],
    });
  });

  it("adds what never left this computer after the cloud's, and only on success", async () => {
    const reclaim = vi.fn<() => Promise<OrgReturnedMessage[]>>(async () => [
      { clientMsgId: "desktop-c", text: "offline one" },
    ]);
    const ctx = await movedWith({ remote: { reclaim, beginReturn, settleSends: async () => {} } });
    answerWithReturned(ctx.client);
    vi.mocked(ctx.sessions.importNative).mockRejectedValueOnce(new Error("disk full"));
    const failed = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(failed).toMatchObject({
      success: false,
      returnedMessages: [{ text: "first, never run" }, { text: "second, never run" }],
    });
    expect(reclaim).not.toHaveBeenCalled();
    const retry = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(retry).toEqual({
      success: true,
      verdict: "fresh",
      returnedMessages: [{ clientMsgId: "desktop-c", text: "offline one" }],
    });
  });

  it("returns a post that timed out here but was stored by the cloud once, not twice", async () => {
    const reclaim = vi.fn<() => Promise<OrgReturnedMessage[]>>(async () => [
      { clientMsgId: "desktop-a", text: "first, never run" },
      { clientMsgId: "desktop-c", text: "offline one" },
    ]);
    const ctx = await movedWith({ remote: { reclaim, beginReturn, settleSends: async () => {} } });
    answerWithReturned(ctx.client);
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({
      success: true,
      verdict: "fresh",
      returnedMessages: [
        { clientMsgId: "desktop-a", text: "first, never run" },
        { clientMsgId: "desktop-b", text: "second, never run" },
        { clientMsgId: "desktop-c", text: "offline one" },
      ],
    });
  });

  it("keeps a message out of the cloud while Continue here runs: a flush and a send during it post nothing, and the offline text comes back once", async () => {
    const inbox = new FakeOrgInbox();
    const base = inbox.client();
    let online = false;
    const remoteClient: OrgInboxClient = {
      ...base,
      postMessage: (...args) =>
        online
          ? base.postMessage(...args)
          : Promise.reject(new OrgApiError(0, "unreachable", "offline")),
    };
    let moves: Pick<OrgCloudMoveStore, "load"> = { load: () => [] };
    const remote = new OrgRemoteSend({
      getFlags: () => ({ ...ON, remoteMode: true }),
      getClient: async () => remoteClient,
      getSignedInOrgId: () => "fake",
      moves: { load: () => moves.load() },
      outbox: new InMemoryOrgMessageOutbox(),
    });
    const ctx = await movedWith({ remote });
    moves = ctx.store;
    expect(await remote.send({ sessionId: SESSION_ID, text: "written offline" })).toMatchObject({
      success: true,
      message: { status: "offline" },
    });

    let duringSend: unknown;
    const acquire = ctx.client.acquireLease.bind(ctx.client);
    ctx.client.acquireLease = async (id, request) => {
      online = true;
      duringSend = await remote.send({ sessionId: SESSION_ID, text: "typed during the return" });
      await remote.flushOutbox();
      return acquire(id, request);
    };

    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });

    expect(duringSend).toEqual({ success: false, error: "not-in-cloud" });
    expect(inbox.posts).toEqual([]);
    expect(result).toMatchObject({
      success: true,
      returnedMessages: [{ text: "written offline" }],
    });
    expect(result.success && result.returnedMessages).toHaveLength(1);
    expect(await remote.reclaim(SESSION_ID)).toEqual([]);
  });

  /** A real OrgRemoteSend over a fake inbox whose posts can wait or fail, bound to the move store of the test. */
  function remoteHarness() {
    const inbox = new FakeOrgInbox();
    const base = inbox.client();
    const control = {
      online: true,
      hold: undefined as Promise<void> | undefined,
      started: () => {},
    };
    const client: OrgInboxClient = {
      ...base,
      postMessage: async (...args) => {
        control.started();
        await control.hold;
        if (!control.online) throw new OrgApiError(0, "unreachable", "offline");
        return base.postMessage(...args);
      },
    };
    let moves: Pick<OrgCloudMoveStore, "load"> = { load: () => [] };
    const remote = new OrgRemoteSend({
      getFlags: () => ({ ...ON, remoteMode: true }),
      getClient: async () => client,
      getSignedInOrgId: () => "fake",
      moves: { load: () => moves.load() },
      outbox: new InMemoryOrgMessageOutbox(),
    });
    return {
      inbox,
      remote,
      control,
      bind: (store: Pick<OrgCloudMoveStore, "load">) => void (moves = store),
    };
  }

  it("waits for a send that is already posting before it takes the lease, and the text stays in the composer", async () => {
    const h = remoteHarness();
    const ctx = await movedWith({ remote: h.remote });
    h.bind(ctx.store);
    let release: () => void = () => {};
    h.control.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posting = new Promise<void>((resolve) => {
      h.control.started = resolve;
    });
    const sending = h.remote.send({ sessionId: SESSION_ID, text: "slow one" });
    await posting;
    const acquire = vi.spyOn(ctx.client, "acquireLease");

    const returning = ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquire).not.toHaveBeenCalled();
    release();

    expect(await sending).toEqual({ success: false, error: "not-in-cloud" });
    const result = await returning;
    expect(result).toMatchObject({ success: true });
    expect(result.success && result.returnedMessages).toBeUndefined();
    expect(h.inbox.messages.map((m) => m.status)).toEqual(["cancelled"]);
    expect(await h.remote.reclaim(SESSION_ID)).toEqual([]);
  });

  it("still returns the cloud's messages and says so when the local outbox cannot be read back", async () => {
    const reclaim = vi.fn<() => Promise<OrgReturnedMessage[]>>(async () => {
      throw new Error("keychain locked");
    });
    const ctx = await movedWith({ remote: { reclaim, beginReturn, settleSends: async () => {} } });
    answerWithReturned(ctx.client);
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({
      success: true,
      verdict: "fresh",
      unsentNotRecovered: true,
      returnedMessages: [
        { clientMsgId: "desktop-a", text: "first, never run" },
        { clientMsgId: "desktop-b", text: "second, never run" },
      ],
    });
  });

  it("lets a later flush post the pending entries when Continue here failed and the chat stayed in the cloud", async () => {
    const h = remoteHarness();
    h.control.online = false;
    const ctx = await movedWith({ remote: h.remote });
    h.bind(ctx.store);
    expect(await h.remote.send({ sessionId: SESSION_ID, text: "written offline" })).toMatchObject({
      success: true,
      message: { status: "offline" },
    });
    h.control.online = true;
    vi.mocked(ctx.sessions.importNative).mockRejectedValueOnce(new Error("disk full"));
    const failed = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(failed).toMatchObject({ success: false });
    expect(h.inbox.posts).toEqual([]);

    await h.remote.flushOutbox();
    expect(h.inbox.posts).toMatchObject([{ sessionId: SESSION_ID, source: "desktop" }]);
  });

  it("tolerates a transcript that is ahead of the envelope: the executor appends a turn's messages before it uploads the envelope", async () => {
    const ctx = await movedWith();
    const original = ctx.client.getTranscript.bind(ctx.client);
    ctx.client.getTranscript = async (id, input) => {
      const page = await original(id, input);
      return { ...page, total: page.total + 1 };
    };
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({ success: true, verdict: "fresh" });
  });

  it("returns none when the answer carries none, the case for a pack that predates the field", async () => {
    const ctx = await movedWith();
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toEqual({ success: true, verdict: "fresh" });
  });

  it("drops entries without text and caps each text", () => {
    const view = {
      returnedMessages: [
        { clientMsgId: "x", text: "" },
        { clientMsgId: 7, text: "kept" },
        null,
        { text: "a".repeat(70_000) },
      ],
    };
    const read = readReturnedMessages(view);
    expect(read.map((m) => m.text.length)).toEqual([4, 64 * 1024]);
    expect(read[0]).toEqual({ clientMsgId: "", text: "kept" });
    expect(readReturnedMessages(undefined)).toEqual([]);
    expect(readReturnedMessages({ returnedMessages: "no" })).toEqual([]);
  });

  it("releaseLock hands back what never left this computer", async () => {
    const reclaim = vi.fn<() => Promise<OrgReturnedMessage[]>>(async () => [
      { clientMsgId: "desktop-c", text: "offline one" },
    ]);
    const { store, cloudMove, locked } = await setup({
      remote: { reclaim, beginReturn, settleSends: async () => {} },
    });
    store.save([
      {
        sessionId: SESSION_ID,
        orgId: "fake",
        runId: "r",
        host: "h",
        movedAt: 1,
        messageCount: 1,
        state: "cloud",
      },
    ]);
    locked.add(SESSION_ID);
    await expect(cloudMove.releaseLock(SESSION_ID)).resolves.toEqual({
      success: true,
      returnedMessages: [{ clientMsgId: "desktop-c", text: "offline one" }],
    });
    expect(reclaim).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe("OrgCloudMove with org.cloudMove off", () => {
  it("makes no client lookup, network call or session change", async () => {
    const { org, cloudMove, sessions, getClient } = await setup({ flags: OFF });
    const before = org.provider.requests.length;
    const disabled = { success: false, error: "disabled" };
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual(disabled);
    expect(await cloudMove.continueHere({ sessionId: SESSION_ID })).toEqual(disabled);
    expect(await cloudMove.getStatus(SESSION_ID)).toEqual(disabled);
    cloudMove.restoreLocks();
    expect(getClient).not.toHaveBeenCalled();
    expect(sessions.detach).not.toHaveBeenCalled();
    expect(sessions.setLocked).not.toHaveBeenCalled();
    expect(org.provider.requests.length).toBe(before);
  });
});

describe("persisted locks", () => {
  const entry = { runId: "r", host: "h", movedAt: 1, messageCount: 1, state: "cloud" as const };

  it("re-locks every stored move at boot whatever the flag, sign-in state or organization", async () => {
    const { store, sessions, getClient } = await setup({ flags: OFF });
    store.save([
      { ...entry, sessionId: "a", orgId: "fake" },
      { ...entry, sessionId: "b", orgId: "another-org" },
    ]);
    const setLocked = vi.fn<(sessionId: string, locked: boolean) => void>();
    restorePersistedCloudLocks(store, setLocked);
    expect(setLocked).toHaveBeenCalledWith("a", true);
    expect(setLocked).toHaveBeenCalledWith("b", true);
    expect(getClient).not.toHaveBeenCalled();
    expect(sessions.detach).not.toHaveBeenCalled();
  });

  it("releaseLock unlocks without a network call, flag on or off", async () => {
    const { store, cloudMove, locked, org } = await setup({ flags: OFF });
    store.save([{ ...entry, sessionId: SESSION_ID, orgId: "fake" }]);
    locked.add(SESSION_ID);
    const before = org.provider.requests.length;
    await expect(cloudMove.releaseLock(SESSION_ID)).resolves.toEqual({ success: true });
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(store.load()).toEqual([]);
    expect(org.provider.requests.length).toBe(before);
  });
});

describe("locks that outlive the feature", () => {
  it("reports a stored lock as release-only when the flag is off, the org is signed out or another", async () => {
    const entry = {
      sessionId: SESSION_ID,
      runId: "r",
      host: "h",
      movedAt: 1,
      messageCount: 1,
      state: "cloud" as const,
    };
    const off = await setup({ flags: OFF });
    off.store.save([{ ...entry, orgId: "fake" }]);
    expect(await off.cloudMove.getStatus(SESSION_ID)).toEqual({
      success: true,
      placement: "cloud",
      releaseOnly: true,
    });
    const other = await setup();
    other.store.save([{ ...entry, orgId: "another-org" }]);
    expect(await other.cloudMove.getStatus(SESSION_ID)).toMatchObject({ releaseOnly: true });
    await expect(other.cloudMove.releaseLock(SESSION_ID)).resolves.toEqual({ success: true });
    expect(other.store.load()).toEqual([]);
  });

  it("keeps the lock and the stored entry together when Continue here cannot detach", async () => {
    let advance = () => {};
    const ctx = await setup({ onSleep: () => advance() });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    advance = () => ctx.org.provider.cloud.advance(SESSION_ID);
    vi.mocked(ctx.sessions.detach).mockImplementationOnce(() => {
      ctx.locked.delete(SESSION_ID);
      return Promise.reject(new Error("did not stop"));
    });
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toMatchObject({ success: false, error: "session-busy" });
    expect(ctx.locked.has(SESSION_ID)).toBe(true);
    expect(ctx.store.load()).toHaveLength(1);
  });
});

describe("OrgCloudMove envelope content", () => {
  it("uploads a sanitized envelope: no prompt snapshot, no secrets, no inline image, structure kept", async () => {
    const { client, cloudMove } = await setup();
    const uploaded: Uint8Array[] = [];
    const put = client.putEnvelope.bind(client);
    client.putEnvelope = async (id, upload) => {
      if (upload.body instanceof Uint8Array) uploaded.push(upload.body);
      return put(id, upload);
    };
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({ success: true });
    const text = gunzipSync(Buffer.from(uploaded[0] ?? new Uint8Array())).toString("utf8");
    expect(text).not.toContain("SYSTEM PROMPT TEXT");
    expect(text).not.toContain("captured request");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain(SECRET_PAT);
    expect(text).not.toContain(IMAGE_DATA);
    expect(text).toContain("[image omitted: image/png");
    expect(text).toContain("SIG+/=abc");
    expect(text).toContain('"uuid":"a2"');
    expect(text).toContain("cat .env");
  });
});

describe("OrgCloudMove move edge cases", () => {
  it("runs the restricted check after the turn stopped, so a result read in the last turn is caught", async () => {
    const restricted: SessionMessage = {
      ...message("3", "assistant", "result"),
      toolCalls: [
        {
          id: "t9",
          name: "recall",
          description: "",
          output: JSON.stringify([{ fact: "private", audience: "user:alice" }]),
        },
      ],
    };
    const ctx = await setup({
      afterDetach: () => ctx.setMessages([message("1", "user", "hi"), restricted]),
    });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "restricted-content",
    });
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
    expect((await ctx.client.getLease(SESSION_ID)).lease).toBeNull();
    expect(ctx.store.load()).toEqual([]);
  });

  it("counts the messages written by the turn that was still running when the move started", async () => {
    const ctx = await setup({
      afterDetach: () =>
        ctx.setMessages([
          message("1", "user", "hello"),
          message("2", "assistant", "hi"),
          message("3", "user", "more"),
          message("4", "assistant", "late answer"),
        ]),
    });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    expect((await ctx.client.getEnvelopeInfo(SESSION_ID)).messageCount).toBe(4);
    expect(ctx.store.load()[0]).toMatchObject({ messageCount: 4, state: "cloud" });
  });

  it("keeps renewing the lease while a slow upload runs past its ttl", async () => {
    const ctx = await setup({ heartbeatMs: 5 });
    const heartbeat = vi.spyOn(ctx.client, "heartbeatLease");
    const put = ctx.client.putEnvelope.bind(ctx.client);
    ctx.client.putEnvelope = async (id, upload) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return put(id, upload);
    };
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    expect(heartbeat.mock.calls.length).toBeGreaterThan(3);
  });

  it("saves the pending lock before the cloud is asked, and a failed upload removes it", async () => {
    const ctx = await setup();
    const seen: string[] = [];
    const put = ctx.client.putEnvelope.bind(ctx.client);
    ctx.client.putEnvelope = async (id, upload) => {
      seen.push(...ctx.store.load().map((entry) => entry.state));
      return put(id, upload);
    };
    ctx.client.moveToCloud = async () => {
      throw new Error("network died");
    };
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: false,
    });
    expect(seen).toEqual(["pending"]);
    expect(ctx.store.load()).toEqual([]);
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
  });

  it("after a crash between the move and the save, a pending entry resolves from the cloud's run", async () => {
    const ctx = await setup();
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    ctx.store.save(
      ctx.store.load().map((entry) => ({ ...entry, runId: "", state: "pending" as const })),
    );
    const status = await ctx.cloudMove.getStatus(SESSION_ID);
    expect(status).toMatchObject({
      success: true,
      placement: "cloud",
      run: { id: expect.any(String) },
    });
    expect(ctx.store.load()[0]).toMatchObject({ state: "cloud" });

    const never = await setup();
    never.store.save([
      {
        sessionId: SESSION_ID,
        orgId: "fake",
        runId: "",
        host: "h",
        movedAt: 1,
        messageCount: 1,
        state: "pending",
      },
    ]);
    never.locked.add(SESSION_ID);
    expect(await never.cloudMove.getStatus(SESSION_ID)).toEqual({
      success: true,
      placement: "local",
    });
    expect(never.store.load()).toEqual([]);
    expect(never.locked.has(SESSION_ID)).toBe(false);
  });
});

describe("OrgCloudMove Continue here with the real native file", () => {
  async function inCloud(options: Parameters<typeof setup>[0] = {}) {
    let advance = () => {};
    const ctx = await setup({ ...options, onSleep: () => advance() });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    advance = () => ctx.org.provider.cloud.advance(SESSION_ID);
    return ctx;
  }

  it("detaches the session before replacing its file, writes a .bak and keeps the cloud's bytes", async () => {
    const ctx = await inCloud();
    const original = fs.readFileSync(ctx.nativeFile, "utf8");
    ctx.events.length = 0;
    expect(await ctx.cloudMove.continueHere({ sessionId: SESSION_ID })).toEqual({
      success: true,
      verdict: "fresh",
    });
    expect(ctx.events).toEqual(["detach", "import"]);
    expect(fs.readFileSync(`${ctx.nativeFile}.bak`, "utf8")).toBe(original);
    expect(fs.readFileSync(ctx.nativeFile, "utf8")).not.toBe(original);
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
    expect(ctx.store.load()).toEqual([]);
  });

  it("asks before overwriting when the state is unverified, and restores once accepted", async () => {
    const ctx = await inCloud();
    // No cloud turn ran: the envelope is the desktop's own, with no cloud checkpoint to compare.
    ctx.org.provider.cloud.crash(SESSION_ID);
    const first = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(first).toMatchObject({ success: false, error: "unverified-state" });
    expect(ctx.imported).toHaveLength(0);
    expect(ctx.locked.has(SESSION_ID)).toBe(true);
    expect(ctx.store.load()).toHaveLength(1);
    const accepted = await ctx.cloudMove.continueHere({
      sessionId: SESSION_ID,
      acceptUnverified: true,
    });
    expect(accepted).toMatchObject({ success: true, verdict: "unverified" });
    expect(ctx.locked.has(SESSION_ID)).toBe(false);
  });

  it("leaves a usable state when the restore fails after the lease was taken back", async () => {
    const ctx = await inCloud();
    vi.mocked(ctx.sessions.importNative).mockRejectedValueOnce(new Error("disk full"));
    const result = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(result).toMatchObject({ success: false });
    expect(ctx.locked.has(SESSION_ID)).toBe(true);
    expect(ctx.store.load()).toHaveLength(1);
    expect((await ctx.client.getLease(SESSION_ID)).lease).toBeNull();
    const retry = await ctx.cloudMove.continueHere({ sessionId: SESSION_ID });
    expect(retry).toMatchObject({ success: true });
  });
});

describe("OrgCloudMove Continue here for a session with no local copy", () => {
  const CLOUD_ON: OrgFlags = { ...ON, remoteSessions: true, cloudGroup: true };
  const LINKED = [{ name: "Platform", path: "/work/platform" }];
  const garbage = new TextEncoder().encode("this is not gzip");

  async function cloudHeld(
    options: {
      flags?: OrgFlags;
      folders?: Array<{ name: string; path: string }>;
      hasLocal?: boolean;
      create?: CloudOnlyContinue["createFromNative"];
      principal?: `user:${string}`;
      runtime?: string;
      withCloudOnly?: boolean;
      release?: boolean;
      envelope?: "tampered" | "not-gzip";
      features?: readonly OrgFeature[];
      strandedStore?: InMemoryOrgCloudStrandedStore;
    } = {},
  ) {
    let advance = () => {};
    const ctx = await setup({ onSleep: () => advance(), features: options.features });
    expect(await ctx.cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    advance = () => {
      if (options.release === false) return;
      try {
        ctx.org.provider.cloud.advance(SESSION_ID);
      } catch {
        // the cloud no longer holds the session
      }
    };
    const principal = options.principal ?? ALICE;
    const base = await ctx.clientFor(principal);
    const client =
      options.runtime || options.envelope
        ? new Proxy(base, {
            get(target, key) {
              if (key === "getEnvelope" && options.envelope === "tampered") {
                return async (...args: Parameters<OrgClient["getEnvelope"]>) => {
                  const real = await target.getEnvelope(...args);
                  return {
                    ...real,
                    body: new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new Uint8Array([1, 2, 3]));
                        controller.close();
                      },
                    }),
                  };
                };
              }
              if (key === "getEnvelope" && options.envelope === "not-gzip") {
                return async (...args: Parameters<OrgClient["getEnvelope"]>) => {
                  const real = await target.getEnvelope(...args);
                  return {
                    ...real,
                    body: new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(garbage);
                        controller.close();
                      },
                    }),
                  };
                };
              }
              if (key === "getEnvelopeInfo" && options.envelope === "not-gzip") {
                return async (id: string) => ({
                  ...(await target.getEnvelopeInfo(id)),
                  sha256: createHash("sha256").update(garbage).digest("hex"),
                });
              }
              if (key === "getSession" && options.runtime) {
                return async (id: string) => {
                  const view = await target.getSession(id);
                  return { ...view, session: { ...view.session, runtime: options.runtime! } };
                };
              }
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          })
        : base;
    const created: Array<Parameters<CloudOnlyContinue["createFromNative"]>[0]> = [];
    const holders: Array<string | undefined> = [];
    const createFromNative: CloudOnlyContinue["createFromNative"] =
      options.create ??
      (async (request) => {
        created.push(request);
        holders.push((await base.getLease(SESSION_ID)).lease?.holder.host);
        return { success: true };
      });
    const cloudOnly: CloudOnlyContinue = {
      hasLocalSession: () => options.hasLocal === true,
      foldersFor: async (workspaceId) =>
        workspaceId === "ws:platform" ? (options.folders ?? LINKED) : [],
      isFolder: (folder) => folder.startsWith("/work/"),
      createFromNative,
    };
    const moveDeps: OrgCloudMoveDeps = {
      getFlags: () => options.flags ?? CLOUD_ON,
      getClient: async () => client,
      getSignedInOrgId: () => "fake",
      sharing: {
        preview: vi.fn<OrgSessionSharing["preview"]>(),
        share: vi.fn<OrgSessionSharing["share"]>(),
      },
      sessions: ctx.sessions,
      ...(options.withCloudOnly === false ? {} : { cloudOnly }),
      store: new InMemoryOrgCloudMoveStore(),
      hostId: "desktop-continue",
      sleep: async () => advance(),
      pollIntervalMs: 0,
      handoverTimeoutMs: 50,
      ...(options.strandedStore ? { strandedStore: options.strandedStore } : {}),
    };
    const cloudMove = new OrgCloudMove(moveDeps);
    const leaseHolder = async () => (await base.getLease(SESSION_ID)).lease?.holder.host;
    return { ...ctx, cloudMove, moveDeps, created, holders, leaseHolder, cloudOnly };
  }

  it("takes the lease over, hands the cloud's state to the session manager and releases the lease", async () => {
    const ctx = await cloudHeld();
    const result = await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
    expect(result).toEqual({ success: true, verdict: "fresh" });
    expect(ctx.created).toHaveLength(1);
    expect(ctx.created[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Fix the build",
      workspace: { workspaceName: "Platform" },
      state: { format: "claude-jsonl" },
    });
    expect(ctx.created[0]?.state.bytes.byteLength).toBeGreaterThan(0);
    expect(ctx.holders).toEqual(["desktop-continue"]);
    expect(await ctx.leaseHolder()).toBeUndefined();
    expect(ctx.sessions.importNative).not.toHaveBeenCalled();
    expect(ctx.sessions.detach).toHaveBeenCalledTimes(1);
  });

  it("uses a folder the person picked when no single workspace is linked", async () => {
    const ctx = await cloudHeld({ folders: [] });
    const needs = await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
    expect(needs).toEqual({ success: false, error: "needs-folder", folders: [] });
    expect(await ctx.leaseHolder()).toMatch(/^cloud/);
    const picked = await ctx.cloudMove.continueCloudSession({
      sessionId: SESSION_ID,
      repoPath: "/work/elsewhere",
    });
    expect(picked).toMatchObject({ success: true });
    expect(ctx.created[0]?.workspace).toEqual({ repoPath: "/work/elsewhere" });
  });

  it("asks which workspace when several are linked, and accepts one of them", async () => {
    const folders = [
      { name: "Platform", path: "/work/platform" },
      { name: "Platform 2", path: "/work/platform2" },
    ];
    const ctx = await cloudHeld({ folders });
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "needs-folder",
      folders,
    });
    expect(
      await ctx.cloudMove.continueCloudSession({
        sessionId: SESSION_ID,
        workspaceName: "Platform 2",
      }),
    ).toMatchObject({ success: true });
    expect(ctx.created[0]?.workspace).toEqual({ workspaceName: "Platform 2" });
  });

  it.each([
    ["a workspace that is not linked", { workspaceName: "Other" }],
    ["a folder that does not exist", { repoPath: "/nowhere" }],
  ])("refuses %s before taking the lease", async (_label, pick) => {
    const ctx = await cloudHeld();
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, ...pick })).toEqual({
      success: false,
      error: "invalid-folder",
      folders: LINKED,
    });
    expect(await ctx.leaseHolder()).toMatch(/^cloud/);
    expect(ctx.created).toEqual([]);
  });

  it("refuses with org.cloudGroup off, or without the session manager side, and touches nothing", async () => {
    const off = await cloudHeld({ flags: { ...CLOUD_ON, cloudGroup: false } });
    expect(await off.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "disabled",
    });
    expect(await off.leaseHolder()).toMatch(/^cloud/);
    const bare = await cloudHeld({ withCloudOnly: false });
    expect(await bare.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "disabled",
    });
  });

  it("refuses a session that already has a local copy", async () => {
    const ctx = await cloudHeld({ hasLocal: true });
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "already-local",
    });
    expect(await ctx.leaseHolder()).toMatch(/^cloud/);
  });

  it("refuses anyone but the owner, without taking the lease", async () => {
    const ctx = await cloudHeld({ principal: BOB });
    await ctx.client.grantSession(SESSION_ID, { principal: BOB, role: "driver" });
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "forbidden",
    });
    expect(await ctx.leaseHolder()).toMatch(/^cloud/);
    expect(ctx.created).toEqual([]);
  });

  it("refuses a runtime other than claude, with no fallback and no lease taken", async () => {
    const ctx = await cloudHeld({ runtime: "codex" });
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "unsupported-runtime",
    });
    expect(await ctx.leaseHolder()).toMatch(/^cloud/);
    expect(ctx.created).toEqual([]);
  });

  it("reports the cloud still running when it never releases, and forces only when asked", async () => {
    const ctx = await cloudHeld({ release: false });
    const stuck = await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
    expect(stuck).toEqual({ success: false, error: "cloud-still-running" });
    expect(ctx.created).toEqual([]);
    const forced = await ctx.cloudMove.continueCloudSession({
      sessionId: SESSION_ID,
      force: true,
      acceptUnverified: true,
      acceptStale: true,
    });
    expect(forced).toMatchObject({ success: true });
  });

  it("asks before using state that is stale or unverified, and releases the lease when it refuses", async () => {
    const ctx = await cloudHeld();
    ctx.org.provider.cloud.advance(SESSION_ID, { uploadEnvelope: false });
    ctx.org.provider.cloud.crash(SESSION_ID);
    const first = await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
    expect(first).toMatchObject({ success: false, error: "stale-state" });
    expect(ctx.created).toEqual([]);
    expect(await ctx.leaseHolder()).toBeUndefined();
    const accepted = await ctx.cloudMove.continueCloudSession({
      sessionId: SESSION_ID,
      acceptStale: true,
    });
    expect(accepted).toMatchObject({ success: true, verdict: "stale-accepted" });
  });

  it.each([
    "runtime-unavailable",
    "workspace-unavailable",
    "invalid-state",
    "unsupported-format",
  ] as const)(
    "gives the lease back and reports %s when the local session cannot be built",
    async (error) => {
      const ctx = await cloudHeld({ create: async () => ({ success: false, error }) });
      expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
        success: false,
        error,
      });
      expect(await ctx.leaseHolder()).toBeUndefined();
    },
  );

  it.each([
    ["tampered", "envelope-mismatch"],
    ["not-gzip", "envelope-invalid"],
  ] as const)(
    "refuses a download that is %s, builds nothing and gives the lease back",
    async (envelope, error) => {
      const ctx = await cloudHeld({ envelope });
      expect(
        await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true }),
      ).toEqual({
        success: false,
        error,
      });
      expect(ctx.created).toEqual([]);
      expect(await ctx.leaseHolder()).toBeUndefined();
    },
  );

  describe("a refused continue", () => {
    const keptIds = (ctx: { cloudMove: OrgCloudMove }) =>
      ctx.cloudMove.listStranded().map((row) => row.id);

    it("keeps the row for a retry after a stale refusal, and drops it once the retry succeeds", async () => {
      const ctx = await cloudHeld({ features: [...FEATURES, "messages", "cloudList"] });
      ctx.org.provider.cloud.advance(SESSION_ID, { uploadEnvelope: false });
      ctx.org.provider.cloud.crash(SESSION_ID);
      expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toMatchObject({
        success: false,
        error: "stale-state",
      });
      expect(ctx.cloudMove.listStranded()).toEqual([
        expect.objectContaining({
          id: SESSION_ID,
          title: "Fix the build",
          workspaceId: "ws:platform",
        }),
      ]);
      const cloud = await ctx.client.listSessions({ placement: "cloud", owner: "me" });
      expect(cloud.sessions.map((view) => view.session.id)).not.toContain(SESSION_ID);
      expect(
        await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true }),
      ).toMatchObject({ success: true });
      expect(keptIds(ctx)).toEqual([]);
    });

    it("keeps the row after a force that ends unverified, then continues on Continue anyway", async () => {
      const ctx = await cloudHeld({
        release: false,
        features: [...FEATURES, "messages", "cloudList"],
      });
      expect(
        await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, force: true }),
      ).toMatchObject({ success: false, error: "unverified-state" });
      expect(keptIds(ctx)).toEqual([SESSION_ID]);
      expect(
        await ctx.cloudMove.continueCloudSession({
          sessionId: SESSION_ID,
          force: true,
          acceptUnverified: true,
        }),
      ).toMatchObject({ success: true });
      expect(keptIds(ctx)).toEqual([]);
    });

    it("keeps the row when the local session cannot be built", async () => {
      const ctx = await cloudHeld({
        create: async () => ({ success: false, error: "start-failed" }),
      });
      expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toEqual({
        success: false,
        error: "start-failed",
      });
      expect(keptIds(ctx)).toEqual([SESSION_ID]);
    });

    it.each(["tampered", "not-gzip"] as const)(
      "keeps the row after a %s download",
      async (envelope) => {
        const ctx = await cloudHeld({ envelope });
        expect(
          await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true }),
        ).toMatchObject({ success: false });
        expect(keptIds(ctx)).toEqual([SESSION_ID]);
      },
    );

    it("survives a restart: a new OrgCloudMove on the same store still lists it, until it is forgotten", async () => {
      const strandedStore = new InMemoryOrgCloudStrandedStore();
      const ctx = await cloudHeld({ strandedStore, envelope: "tampered" });
      expect(
        await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true }),
      ).toMatchObject({ success: false });
      expect(strandedStore.sessions.map((row) => row.sessionId)).toEqual([SESSION_ID]);
      const restarted = new OrgCloudMove({ ...ctx.moveDeps, strandedStore });
      expect(restarted.listStranded()).toEqual([
        expect.objectContaining({ id: SESSION_ID, title: "Fix the build" }),
      ]);
      restarted.forgetStranded(SESSION_ID);
      expect(strandedStore.sessions).toEqual([]);
      expect(new OrgCloudMove({ ...ctx.moveDeps, strandedStore }).listStranded()).toEqual([]);
    });

    it("clears the stored record when a retry succeeds", async () => {
      const strandedStore = new InMemoryOrgCloudStrandedStore();
      const ctx = await cloudHeld({ strandedStore, envelope: "tampered" });
      await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true });
      expect(strandedStore.sessions).toHaveLength(1);
      const retry = new OrgCloudMove({
        ...ctx.moveDeps,
        strandedStore,
        getClient: async () => ctx.clientFor(ALICE),
      });
      expect(
        await retry.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true }),
      ).toMatchObject({ success: true });
      expect(strandedStore.sessions).toEqual([]);
    });

    it("writes the record as soon as the lease is taken, before the state is built", async () => {
      const strandedStore = new InMemoryOrgCloudStrandedStore();
      let during: string[] = [];
      const ctx = await cloudHeld({
        strandedStore,
        create: async () => {
          during = strandedStore.sessions.map((row) => row.sessionId);
          return { success: true };
        },
      });
      await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
      expect(during).toEqual([SESSION_ID]);
      expect(strandedStore.sessions).toEqual([]);
    });

    it("shows a stranded row only to the organization that was signed in", async () => {
      const strandedStore = new InMemoryOrgCloudStrandedStore();
      const ctx = await cloudHeld({ strandedStore, envelope: "tampered" });
      await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true });
      expect(strandedStore.sessions[0]).toMatchObject({ orgId: "fake" });
      const other = new OrgCloudMove({
        ...ctx.moveDeps,
        strandedStore,
        getSignedInOrgId: () => "other-org",
      });
      expect(other.listStranded()).toEqual([]);
      const signedOut = new OrgCloudMove({
        ...ctx.moveDeps,
        strandedStore,
        getSignedInOrgId: () => undefined,
      });
      expect(signedOut.listStranded()).toEqual([]);
      expect(new OrgCloudMove({ ...ctx.moveDeps, strandedStore }).listStranded()).toHaveLength(1);
    });

    it.each(["not-found", "forbidden"] as const)(
      "drops the record when the server says %s",
      async (code) => {
        const strandedStore = new InMemoryOrgCloudStrandedStore();
        const ctx = await cloudHeld({ strandedStore, envelope: "tampered" });
        await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID, acceptStale: true });
        expect(strandedStore.sessions).toHaveLength(1);
        const gone = new OrgCloudMove({
          ...ctx.moveDeps,
          strandedStore,
          getClient: async () => {
            const real = await ctx.clientFor(ALICE);
            return new Proxy(real, {
              get(target, key) {
                if (key === "getSession") {
                  return async () => {
                    throw code === "not-found"
                      ? new OrgApiError(404, "not-found", "gone")
                      : new OrgApiError(403, "forbidden", "no");
                  };
                }
                const value: unknown = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        });
        expect(await gone.continueCloudSession({ sessionId: SESSION_ID })).toMatchObject({
          success: false,
          error: code,
        });
        expect(strandedStore.sessions).toEqual([]);
      },
    );

    it("keeps nothing when it is refused before the lease is taken", async () => {
      const stuck = await cloudHeld({ release: false });
      await stuck.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
      expect(keptIds(stuck)).toEqual([]);
      const other = await cloudHeld({ runtime: "codex" });
      await other.cloudMove.continueCloudSession({ sessionId: SESSION_ID });
      expect(keptIds(other)).toEqual([]);
    });
  });

  it("leaves the session local after it: the cloud holds no lease and lists it as local, as after Continue here", async () => {
    const ctx = await cloudHeld({ features: [...FEATURES, "messages", "cloudList"] });
    expect(await ctx.cloudMove.continueCloudSession({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    expect(await ctx.leaseHolder()).toBeUndefined();
    const local = await ctx.client.listSessions({ placement: "local", owner: "me" });
    const cloud = await ctx.client.listSessions({ placement: "cloud", owner: "me" });
    expect(local.sessions.map((view) => view.session.id)).toContain(SESSION_ID);
    expect(cloud.sessions.map((view) => view.session.id)).not.toContain(SESSION_ID);
  });
});
