import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  configureEngineHost,
  isEngineHostConfigured,
  LocalBackend,
  type BackendEvent,
  type EngineHostServices,
  type LocalRuntimeStrategy,
  type RuntimeClient,
  type RuntimeClientSession,
  type RuntimeSessionConfig,
  type RuntimeSessionEvent,
} from "../src/providers.js";

// The session engine is the desktop's own code (electron/backend/local), lifted unchanged except that its
// imports of desktop services became ports. This drives it end to end with a host made of plain functions
// and a provider double: no Electron, no desktop, no model.

function testHost(appData: string, calls: string[]): Partial<EngineHostServices> {
  const record = (name: string) => (..._args: unknown[]) => {
    calls.push(name);
  };
  return {
    app: { getVersion: () => "9.9.9-test", isPackaged: false },
    APP_NAME: "MarshalSDKTest",
    DEFAULT_PERMISSIONS: { tools: {}, servers: {} },
    sessionErrors: { INFER_FAILED: "INFER_FAILED" },
    NEVER_BACKGROUND_TOOL_NAMES: new Set<string>(),
    AskUserToolResultSchema: { safeParse: () => ({ success: false, error: { message: "unused" } }) },
    applyGuardrails: (pattern: unknown) => pattern,
    backgroundToolObservation: (toolName: string, handle: string) => `${toolName} ${handle}`,
    buildMcpConfig: () => ({}),
    buildUserPromptContext: (prompt: unknown) => prompt,
    describeRequestCompaction: () => "",
    describeSessionViews: () => "",
    extractPattern: () => null,
    getActiveWorkspaceRoot: () => appData,
    getAppDataDir: () => appData,
    getCommandText: () => "",
    getSelfFsTools: () => [],
    getSelfTools: () => [],
    getSessionClientViewport: () => undefined,
    isReadOnlyCommand: () => false,
    loadMcpBrokerManager: async () => {
      throw new Error("no MCP broker in this host");
    },
    makeSessionError: (code: unknown) => code,
    normalizeDiscoveredModels: (models: unknown[]) => models,
    normalizePermissionRequest: (request: unknown) => request,
    resolveSessionToolAllowlist: () => undefined,
    runToolWithBackgrounding: async (opts) => opts.run(undefined),
    sanitizeForTelemetry: (value: unknown) => value,
    secureAppendFile: async (file: string, data: string) => fs.appendFileSync(file, data),
    secureMkdir: async (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    secureMkdirSync: (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    secureWriteFileSync: (file: string, data: string) => fs.writeFileSync(file, data),
    sendErrorTelemetry: record("sendErrorTelemetry"),
    takeSessionMentionContext: () => undefined,
    takeSharedSessionContext: () => undefined,
  };
}

function providerDouble() {
  const created: RuntimeSessionConfig[] = [];
  const sent: string[] = [];
  const session = (sessionId: string): RuntimeClientSession => {
    const handlers = new Set<(event: RuntimeSessionEvent) => void>();
    const emit = (type: string, data: Record<string, unknown>) => {
      const event = { id: `${type}-${sent.length}`, timestamp: new Date().toISOString(), parentId: null, type, data } as unknown as RuntimeSessionEvent;
      for (const handler of handlers) handler(event);
    };
    return {
      sessionId,
      on(handler: (event: RuntimeSessionEvent) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async send({ prompt }: { prompt: string }) {
        sent.push(prompt);
        setTimeout(() => {
          emit("assistant.message_delta", { messageId: "m1", deltaContent: "echo: " });
          emit("assistant.message", { messageId: "m1", content: `echo: ${prompt}` });
          emit("session.idle", {});
        }, 0);
        return "message-1";
      },
      async sendAndWait() {
        return undefined;
      },
      async abort() {},
      async disconnect() {},
      async destroy() {},
      async setModel() {},
      async getMessages() {
        return [];
      },
    } as unknown as RuntimeClientSession;
  };
  const client = {
    async createSession(config: RuntimeSessionConfig) {
      created.push(config);
      return session(`native-${created.length}`);
    },
    async resumeSession(id: string) {
      return session(id);
    },
    async listModels() {
      return [{ id: "fake-model", name: "Fake" }];
    },
    async getAuthStatus() {
      return { isAuthenticated: true, login: "test" };
    },
    async deleteSession() {},
    async stop() {
      return [];
    },
  } as unknown as RuntimeClient;
  return { client, created, sent };
}

const strategy: LocalRuntimeStrategy = {
  runtimeId: "fake",
  origin: "claude" as LocalRuntimeStrategy["origin"],
  displayName: "Fake",
  sessionConfigTraceFilename: "engine-test-trace.jsonl",
  defaultInferenceModel: "fake-model",
  preferredDefaultModelIds: ["fake-model"],
  accountIdentityPrefix: "fake",
  capabilities: {} as LocalRuntimeStrategy["capabilities"],
  loadWorkspaceFiles: () => null,
};

test("the engine refuses to run without a host", async () => {
  assert.equal(isEngineHostConfigured(), false);
  const { client } = providerDouble();
  const backend = new LocalBackend({ workspaceDir: os.tmpdir(), clientFactory: async () => client, strategy });
  await assert.rejects(backend.sessions.create({ sessionId: "early" }), /configureEngineHost/);
});

test("the desktop's session engine runs a turn on an SDK host: create, send, streamed events, idle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-engine-"));
  const calls: string[] = [];
  configureEngineHost(testHost(root, calls));
  const provider = providerDouble();
  const backend = new LocalBackend({ workspaceDir: root, clientFactory: async () => provider.client, strategy });

  const handle = await backend.sessions.create({ sessionId: "s1", systemMessage: "You are a Marshal agent." });
  assert.equal(handle.sessionId, "s1");
  assert.equal(handle.backendId, "native-1");
  const config = provider.created[0]!;
  assert.equal(config.clientName, "MarshalSDKTest/9.9.9-test", "the host's name and version reach the provider");
  assert.equal(config.workingDirectory, root);

  const events: BackendEvent[] = [];
  const idle = new Promise<void>((resolve) => {
    backend.sessions.subscribe("s1", (event) => {
      events.push(event);
      if (event.type === "idle") resolve();
    });
  });
  await backend.sessions.send("s1", { prompt: "hello engine" });
  await idle;

  assert.deepEqual(provider.sent.length, 1);
  assert.match(provider.sent[0]!, /hello engine/);
  const kinds = events.map((event) => event.type);
  assert.ok(kinds.includes("text-delta"), `streamed delta in ${kinds.join(",")}`);
  const complete = events.find((event) => event.type === "turn-complete");
  assert.ok(complete && complete.type === "turn-complete");
  assert.equal(complete.message.content, `echo: ${provider.sent[0]}`);
  assert.equal(calls.includes("sendErrorTelemetry"), false);
  assert.ok(fs.existsSync(path.join(root, "engine-test-trace.jsonl")), "the session config trace lands in the host's app data dir");
  await backend.sessions.destroy("s1");
});
