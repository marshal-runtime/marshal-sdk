import { gzipSync } from "node:zlib";

import { OrgApiError } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { SessionImportTarget } from "../../../electron/session-import/importer";
import { testDouble } from "../../../electron/testing/harness";
import { OrgRunChats, runChatRef, type RunChatClient } from "./org-run-chats";

const RUN_ID = "run-1";
const SESSION = "1-investigator";
const AT = "2026-11-07T10:00:00.000Z";

const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const MAIN = [
  line({
    type: "user",
    sessionId: "cloud-session",
    uuid: "u1",
    timestamp: AT,
    cwd: "/workspace/zyg",
    message: { role: "user", content: "Why did checkout time out?" },
  }),
  line({
    type: "assistant",
    sessionId: "cloud-session",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: AT,
    cwd: "/workspace/zyg",
    message: { role: "assistant", content: [{ type: "text", text: "The pool was exhausted." }] },
  }),
].join("");
const SUBAGENT = [
  line({
    type: "user",
    isSidechain: true,
    agentId: "a1b2",
    sessionId: "cloud-session",
    uuid: "s1",
    timestamp: AT,
    cwd: "/workspace/zyg",
    message: { role: "user", content: "Read the pool settings" },
  }),
  line({
    type: "assistant",
    isSidechain: true,
    agentId: "a1b2",
    sessionId: "cloud-session",
    uuid: "s2",
    parentUuid: "s1",
    timestamp: AT,
    cwd: "/workspace/zyg",
    message: { role: "assistant", content: [{ type: "text", text: "max=10" }] },
  }),
].join("");

const download = (text: string) => {
  const body = new Uint8Array(gzipSync(text));
  return {
    envelope: {
      format: "claude-jsonl",
      sha256: "0".repeat(64),
      bytes: body.length,
      messageCount: 2,
    },
    body,
  };
};

type Client = RunChatClient;

function fakeClient(overrides: Partial<Client> = {}) {
  const getRunEnvelope = vi.fn<Client["getRunEnvelope"]>(async () => download(MAIN));
  const client: Client = {
    supports: vi.fn<Client["supports"]>((feature) => feature === "runEnvelopes"),
    getRun: vi.fn<Client["getRun"]>(async () =>
      testDouble<Awaited<ReturnType<Client["getRun"]>>>({
        run: { title: "Checkout\ntimeouts", workspace: "ws:zyg" },
        sessions: [{ session: SESSION, hasEnvelope: true }],
      }),
    ),
    getRunEnvelope,
    listRunSubagents: vi.fn<Client["listRunSubagents"]>(async () => ["a1b2"]),
    getRunSubagentEnvelope: vi.fn<Client["getRunSubagentEnvelope"]>(async () => download(SUBAGENT)),
    ...overrides,
  };
  return { client, getRunEnvelope };
}

function fakeTarget() {
  const imported = new Map<string, string>();
  const requests: Parameters<SessionImportTarget["importExternalSession"]>[0][] = [];
  const target: SessionImportTarget = {
    listImportedSessions: () => new Map(imported),
    importExternalSession: async (request) => {
      requests.push(request);
      const sessionId = `local-${requests.length}`;
      imported.set(`${request.importedFrom.source}:${request.importedFrom.externalId}`, sessionId);
      return { sessionId, mode: request.claudeNative ? "native" : "transcript" };
    },
  };
  return { target, requests };
}

function chats(client: RunChatClient | null, target: SessionImportTarget, enabled = true) {
  const openSession = vi.fn<(sessionId: string) => void>();
  const notifySessionsChanged = vi.fn<() => void>();
  const service = new OrgRunChats({
    enabled: () => enabled,
    getClient: async () => client,
    target,
    workspaceFolder: async (id) => (id === "ws:zyg" ? "/Users/me/zyg" : undefined),
    notifySessionsChanged,
    openSession,
  });
  return { service, openSession, notifySessionsChanged };
}

describe("OrgRunChats", () => {
  it("imports the run's own conversation and its subagents into the mapped workspace and opens it", async () => {
    const { client } = fakeClient();
    const { target, requests } = fakeTarget();
    const { service, openSession, notifySessionsChanged } = chats(client, target);

    const result = await service.open(`run:${RUN_ID}`);

    expect(result).toEqual({ success: true, sessionId: "local-1", reused: false });
    expect(requests).toHaveLength(2);
    const [main, child] = requests;
    if (!main?.claudeNative) throw new Error("expected a native import");
    expect(main).toMatchObject({
      name: "Fork of run: Checkout timeouts",
      cwd: "/Users/me/zyg",
      addWorkspace: false,
      importedFrom: { source: "claude-code", externalId: `org-run:${RUN_ID}/${SESSION}` },
    });
    expect(main.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const native = new TextDecoder().decode(main.claudeNative.jsonl);
    expect(native).toContain(`"sessionId":"${main.claudeNative.backendId}"`);
    expect(native).not.toContain("cloud-session");
    expect(child).toMatchObject({
      parentSessionId: "local-1",
      cwd: "/Users/me/zyg",
      importedFrom: { externalId: `org-run:${RUN_ID}/${SESSION}/a1b2` },
    });
    expect(openSession).toHaveBeenCalledWith("local-1");
    expect(notifySessionsChanged).toHaveBeenCalledOnce();
  });

  it("reuses the session an earlier open made without downloading again", async () => {
    const { client, getRunEnvelope } = fakeClient();
    const { target } = fakeTarget();
    const { service, openSession } = chats(client, target);
    await service.open(`run:${RUN_ID}`);

    const again = await service.open(`run:${RUN_ID}:${SESSION}`);

    expect(again).toEqual({ success: true, sessionId: "local-1", reused: true });
    expect(getRunEnvelope).toHaveBeenCalledOnce();
    expect(openSession).toHaveBeenLastCalledWith("local-1");
  });

  it("imports without switching to the copy when asked not to show it, then shows the same copy later", async () => {
    const { client, getRunEnvelope } = fakeClient();
    const { target } = fakeTarget();
    const { service, openSession } = chats(client, target);

    const first = await service.open(`run:${RUN_ID}`, { show: false });

    expect(first).toEqual({ success: true, sessionId: "local-1", reused: false });
    expect(openSession).not.toHaveBeenCalled();

    const shown = await service.open(`run:${RUN_ID}`);
    expect(shown).toEqual({ success: true, sessionId: "local-1", reused: true });
    expect(getRunEnvelope).toHaveBeenCalledOnce();
    expect(openSession).toHaveBeenCalledWith("local-1");
  });

  it("refuses without the runEnvelopes feature, when off, and for ids that are not runs", async () => {
    const { target, requests } = fakeTarget();
    const client = fakeClient({ supports: vi.fn<Client["supports"]>(() => false) }).client;
    expect(await chats(client, target).service.open(`run:${RUN_ID}`)).toEqual({
      success: false,
      error: "unsupported",
    });
    expect(await chats(fakeClient().client, target, false).service.open(`run:${RUN_ID}`)).toEqual({
      success: false,
      error: "disabled",
    });
    expect(await chats(fakeClient().client, target).service.open("session-1")).toEqual({
      success: false,
      error: "invalid-request",
    });
    expect(await chats(null, target).service.open(`run:${RUN_ID}`)).toEqual({
      success: false,
      error: "not-signed-in",
    });
    expect(requests).toEqual([]);
  });

  it("answers not-found when the server hides the transcript from this reader, and keeps a subagent failure from failing the run", async () => {
    const { target } = fakeTarget();
    const hidden = fakeClient({
      getRunEnvelope: vi.fn<Client["getRunEnvelope"]>(async () => {
        throw new OrgApiError(404, "not-found", "not found");
      }),
    }).client;
    expect(await chats(hidden, target).service.open(`run:${RUN_ID}`)).toEqual({
      success: false,
      error: "not-found",
    });

    const flaky = fakeClient({
      getRunSubagentEnvelope: vi.fn<Client["getRunSubagentEnvelope"]>(async () => {
        throw new OrgApiError(409, "no-envelope", "withheld");
      }),
    }).client;
    const { target: fresh, requests } = fakeTarget();
    expect(await chats(flaky, fresh).service.open(`run:${RUN_ID}`)).toMatchObject({
      success: true,
    });
    expect(requests).toHaveLength(1);
  });

  it("keeps the import key within the import id limit for long run and session names", () => {
    const ref = runChatRef("r".repeat(120), "s".repeat(120));
    expect(ref.externalId.length).toBeLessThanOrEqual(128);
    expect(ref.externalId.startsWith("org-run:")).toBe(true);
  });
});
