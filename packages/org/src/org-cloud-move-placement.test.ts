import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { OrgApiError, collectEnvelope, type OrgClient } from "@marshal/agent-runtime-org";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionMessage } from "../../../common/marshal-ipc-contract";
import type { ShareableSession } from "./cloud-session-sanitizer";
import {
  OrgCloudMove,
  type CloudMovePlacementSessions,
  type CloudMoveSessions,
} from "./org-cloud-move";
import { InMemoryOrgCloudMoveStore } from "./org-cloud-move-store";
import type { OrgFlags } from "./org-service";
import { OrgSessionSharing } from "./org-session-sharing";
import { InMemoryOrgShareOutbox } from "./org-share-outbox";
import { ALICE, createTestOrg } from "./org-test-harness";

const SESSION_ID = "sess-1";
const GIT = { mode: "git" } as const;
const NATIVE_ID = "native-1";
const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  placement: true,
};
const FEATURES = [
  "signIn",
  "directory",
  "workspaces",
  "sessions",
  "notifications",
  "leases",
  "cloudRuns",
  "placement",
] as const;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function makeRepo(remote = "https://github.com/acme/platform.git") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "org-placement-")));
  tempDirs.push(base);
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");
  git(base, "init", "--bare", "-q", "-b", "main", bare);
  git(base, "init", "-q", "-b", "main", work);
  fs.writeFileSync(path.join(work, "README.md"), "hello\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "config", "remote.origin.url", remote);
  git(work, "config", "remote.origin.pushurl", bare);
  return work;
}

const line = (value: unknown) => JSON.stringify(value);

function nativeFor(repo: string, options: { interrupted?: boolean } = {}): string {
  const lines: unknown[] = [
    {
      type: "user",
      uuid: "u1",
      sessionId: NATIVE_ID,
      cwd: repo,
      version: "2.1.0",
      message: { role: "user", content: `look at ${repo}/README.md` },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: NATIVE_ID,
      cwd: repo,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${repo}/README.md` } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: NATIVE_ID,
      cwd: repo,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "hello" }],
      },
    },
  ];
  if (options.interrupted) {
    lines.push({
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: NATIVE_ID,
      cwd: repo,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "sleep 60" } }],
      },
    });
  } else {
    lines.push({
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: NATIVE_ID,
      cwd: repo,
      message: { role: "assistant", content: "done" },
    });
  }
  return `${lines.map(line).join("\n")}\n`;
}

function message(id: string, role: SessionMessage["role"], content: string): SessionMessage {
  return { id, role, content, timestamp: "2026-11-03T10:00:00.000Z" };
}

async function setup(
  options: {
    repo?: string;
    flags?: OrgFlags;
    interrupted?: boolean;
    runningChildren?: number;
    stagingTimeoutMs?: number;
    firstDescribe?: () => Promise<void>;
    waitForIdle?: CloudMovePlacementSessions["waitForIdle"];
  } = {},
) {
  const repo = options.repo ?? makeRepo();
  const org = createTestOrg({ features: [...FEATURES] });
  const client = await org.clientFor(ALICE);
  const native = nativeFor(repo, { interrupted: options.interrupted });
  const messages = [message("1", "user", "hello"), message("2", "assistant", "hi")];
  const session: ShareableSession = {
    id: SESSION_ID,
    name: "Fix the build",
    createdAt: "2026-11-03T09:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    runtimeId: "claude",
    workspaceName: "Platform",
    repoPath: "/Users/alice/code/platform",
    messages,
  };
  const sharing = new OrgSessionSharing({
    getFlags: () => ON,
    getClient: async () => client,
    getSignedInOrgId: () => "fake",
    loadSession: async () => session,
    resolveOrgWorkspace: async () => ({
      mapped: true as const,
      orgWorkspaceId: "ws:platform",
      orgWorkspaceName: "Platform",
      repo: "acme/platform",
    }),
    outbox: new InMemoryOrgShareOutbox(),
    homeDir: () => "/Users/alice",
  });
  expect(await sharing.share(SESSION_ID)).toMatchObject({ success: true });
  const locked = new Set<string>();
  const events: string[] = [];
  const sessions: CloudMoveSessions = {
    detach: vi.fn<CloudMoveSessions["detach"]>(async (id) => {
      events.push("detach");
      locked.add(id);
    }),
    setLocked: vi.fn<CloudMoveSessions["setLocked"]>((id, value) => {
      if (value) locked.add(id);
      else locked.delete(id);
    }),
    exportNative: vi.fn<CloudMoveSessions["exportNative"]>(async () => ({
      format: "claude-jsonl",
      bytes: new Uint8Array(Buffer.from(native, "utf8")),
    })),
    importNative: vi.fn<CloudMoveSessions["importNative"]>(async () => true),
  };
  let described = 0;
  const placement: CloudMovePlacementSessions = {
    describe: vi.fn<CloudMovePlacementSessions["describe"]>(async () => {
      if (described++ === 0) await options.firstDescribe?.();
      return { cwd: repo, runningChildren: options.runningChildren ?? 0 };
    }),
    waitForIdle:
      options.waitForIdle ??
      vi.fn<CloudMovePlacementSessions["waitForIdle"]>(async () => undefined),
  };
  const store = new InMemoryOrgCloudMoveStore();
  const cloudMove = new OrgCloudMove({
    getFlags: () => options.flags ?? ON,
    getClient: async () => client,
    getSignedInOrgId: () => "fake",
    sharing,
    sessions,
    placement,
    store,
    hostId: "desktop-test",
    sleep: async () => undefined,
    pollIntervalMs: 0,
    handoverTimeoutMs: 50,
    heartbeatMs: 60_000,
    ...(options.stagingTimeoutMs ? { stagingTimeoutMs: options.stagingTimeoutMs } : {}),
  });
  return { repo, org, client, cloudMove, sessions, placement, store, locked, events };
}

async function downloadEnvelope(client: OrgClient): Promise<string> {
  // The owner takes the lease back before the fake cloud runs, so the envelope is what the move uploaded.
  await client.acquireLease(SESSION_ID, { host: "desktop-test", force: true });
  const info = await client.getEnvelopeInfo(SESSION_ID);
  const download = await client.getEnvelope(SESSION_ID, {
    host: "desktop-test",
    maxBytes: 8 * 1024 * 1024,
  });
  const bytes = await collectEnvelope(download.body, 8 * 1024 * 1024);
  expect(bytes.byteLength).toBe(info.bytes);
  return gunzipSync(bytes).toString("utf8");
}

describe("OrgCloudMove placement (org.placement)", () => {
  it("carries the unpushed work as a bundle, rewrites the transcript paths and sends the manifest", async () => {
    const { repo, client, cloudMove, events, store } = await setup();
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
    fs.writeFileSync(path.join(repo, ".env"), "TOKEN=1\n");
    const result = await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT });
    expect(result).toMatchObject({ success: true });
    expect(events).toEqual(["detach"]);
    expect(store.load()).toHaveLength(1);

    const view = await client.getPlacement(SESSION_ID);
    const mount = view.placement?.mounts[0];
    expect(mount).toMatchObject({
      kind: "git",
      cloudPath: "/work/m1",
      repo: "acme/platform",
      wip: {
        transport: "bundle",
        tracked: 1,
        untracked: 1,
        localCommits: 0,
        skipped: [{ path: ".env", why: "secret" }],
      },
    });
    expect(view.placement?.boundary).toBe("ws:platform");
    expect(view.placement?.midTurn).toBeUndefined();

    const envelope = await downloadEnvelope(client);
    expect(envelope).toContain("/work/m1/README.md");
    expect(envelope).not.toContain(repo);
    expect(git(repo, "status", "--porcelain")).toContain("README.md");
  });

  it("moves a clean, fully pushed tree with a manifest and no bundle", async () => {
    const { client, cloudMove } = await setup();
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: true,
    });
    const mount = (await client.getPlacement(SESSION_ID)).placement?.mounts[0];
    expect(mount).toMatchObject({ kind: "git", repo: "acme/platform" });
    expect(mount).not.toHaveProperty("wip");
  });

  it("closes an unanswered tool call with a note and records midTurn", async () => {
    const { client, cloudMove } = await setup({ interrupted: true });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: true,
    });
    const envelope = await downloadEnvelope(client);
    const last: {
      parentUuid: string;
      message: { content: Array<{ tool_use_id: string; content: string; is_error: boolean }> };
    } = JSON.parse(envelope.trim().split("\n").at(-1) ?? "{}");
    expect(last.parentUuid).toBe("a2");
    expect(last.message.content[0]).toMatchObject({
      tool_use_id: "t2",
      is_error: true,
      content: expect.stringContaining("interrupted by a move"),
    });
    expect((await client.getPlacement(SESSION_ID)).placement?.midTurn).toEqual({
      interrupted: true,
      tool: "Bash",
    });
  });

  it("refuses before the turn is touched when a changed file holds a secret", async () => {
    const { repo, client, cloudMove, sessions, store, locked } = await setup();
    fs.writeFileSync(path.join(repo, "README.md"), "-----BEGIN PRIVATE KEY-----\n");
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: false,
      error: "placement-refused",
    });
    expect(sessions.detach).not.toHaveBeenCalled();
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(store.load()).toEqual([]);
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
  });

  it("refuses while child sessions are running", async () => {
    const { cloudMove, sessions } = await setup({ runningChildren: 2 });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: false,
      error: "placement-refused",
    });
    expect(sessions.detach).not.toHaveBeenCalled();
  });

  it("moves the conversation only when the person chose local-only", async () => {
    const { repo, client, cloudMove, placement } = await setup();
    fs.writeFileSync(path.join(repo, "README.md"), "-----BEGIN PRIVATE KEY-----\n");
    expect(
      await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: { mode: "local-only" } }),
    ).toMatchObject({ success: true });
    expect(placement.describe).not.toHaveBeenCalled();
    expect((await client.getPlacement(SESSION_ID)).placement).toBeNull();
    expect(await downloadEnvelope(client)).toContain(repo);
  });

  it("refuses a session outside a repository of the workspace unless local-only is chosen", async () => {
    const { cloudMove } = await setup({
      repo: makeRepo("https://github.com/someone/else.git"),
    });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: false,
      error: "placement-refused",
    });
    expect(
      await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: { mode: "local-only" } }),
    ).toMatchObject({ success: true });
  });

  it("rolls back and keeps the session local when the bundle upload fails", async () => {
    const { repo, client, cloudMove, store, locked } = await setup();
    fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
    client.putMountBundle = async () => {
      throw new OrgApiError(413, "bundle-too-large", "too big");
    };
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: false,
      error: "bundle-too-large",
    });
    expect(store.load()).toEqual([]);
    expect(locked.has(SESSION_ID)).toBe(false);
    expect((await client.getLease(SESSION_ID)).lease).toBeNull();
  });

  it("stops a move that is waiting for the turn to end when staging is cancelled", async () => {
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { cloudMove, sessions } = await setup({
      waitForIdle: (_id, _max, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const moving = cloudMove.moveToCloud({
      sessionId: SESSION_ID,
      placement: { ...GIT, when: "after-turn" },
    });
    await waiting;
    cloudMove.cancelPlacementStaging(SESSION_ID);
    expect(await moving).toMatchObject({ success: false, error: "placement-cancelled" });
    expect(sessions.detach).not.toHaveBeenCalled();
  });

  it("moves the conversation only when the request carries no placement, flag on", async () => {
    const { repo, client, cloudMove, placement, store } = await setup();
    fs.writeFileSync(path.join(repo, "new.txt"), "n\n");
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID })).toMatchObject({ success: true });
    expect(placement.describe).not.toHaveBeenCalled();
    expect((await client.getPlacement(SESSION_ID)).placement).toBeNull();
    expect(store.load()).toHaveLength(1);
  });

  it("times out a re-plan that outlasts the staging timeout and leaves the session local", async () => {
    const { cloudMove, sessions, store, locked } = await setup({ stagingTimeoutMs: 1 });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: false,
      error: "placement-staging-timeout",
    });
    expect(store.load()).toEqual([]);
    expect(locked.has(SESSION_ID)).toBe(false);
    expect(sessions.exportNative).not.toHaveBeenCalled();
  });

  it("does not abort a running move when the dialog opens a preview for the same session", async () => {
    let idleSignal!: AbortSignal;
    let enteredWait!: () => void;
    const inWait = new Promise<void>((resolve) => {
      enteredWait = resolve;
    });
    const { cloudMove, sessions } = await setup({
      waitForIdle: (_id, _max, signal) =>
        new Promise((_resolve, reject) => {
          idleSignal = signal;
          enteredWait();
          signal.addEventListener("abort", () => reject(new Error("cancelled")));
        }),
    });
    const moving = cloudMove.moveToCloud({
      sessionId: SESSION_ID,
      placement: { ...GIT, when: "after-turn" },
    });
    await inWait;
    expect(await cloudMove.placementPreview({ sessionId: SESSION_ID })).toMatchObject({
      success: true,
    });
    expect(idleSignal.aborted).toBe(false);
    cloudMove.cancelPlacementStaging(SESSION_ID);
    expect(await moving).toMatchObject({ success: false, error: "placement-cancelled" });
    expect(sessions.detach).not.toHaveBeenCalled();
  });

  it("cancels a preview that is planning", async () => {
    let release!: () => void;
    let enteredPlan!: () => void;
    const inPlan = new Promise<void>((resolve) => {
      enteredPlan = resolve;
    });
    const { cloudMove } = await setup({
      firstDescribe: async () => {
        enteredPlan();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const previewing = cloudMove.placementPreview({ sessionId: SESSION_ID });
    await inPlan;
    cloudMove.cancelPlacementStaging(SESSION_ID);
    release();
    expect(await previewing).toMatchObject({ success: false, error: "placement-cancelled" });
  });

  it("is inert with org.placement off: no git, no manifest, no bundle", async () => {
    const { client, cloudMove, placement } = await setup({
      flags: { ...ON, placement: false },
    });
    expect(await cloudMove.moveToCloud({ sessionId: SESSION_ID, placement: GIT })).toMatchObject({
      success: true,
    });
    expect(placement.describe).not.toHaveBeenCalled();
    expect((await client.getPlacement(SESSION_ID)).placement).toBeNull();
    expect(await cloudMove.placementPreview({ sessionId: SESSION_ID })).toEqual({
      success: false,
      error: "disabled",
    });
  });

  it("previews what would move, and says when there is no git work", async () => {
    const { repo, cloudMove } = await setup();
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    const preview = await cloudMove.placementPreview({ sessionId: SESSION_ID });
    expect(preview).toMatchObject({
      success: true,
      preview: { repo: "acme/platform", tracked: 1, untracked: 1, refusals: [] },
    });
    const foreign = await setup({ repo: makeRepo("https://github.com/someone/else.git") });
    expect(await foreign.cloudMove.placementPreview({ sessionId: SESSION_ID })).toMatchObject({
      success: false,
      error: "no-git-work",
      reason: "repo-not-in-workspace",
    });
  });
});
