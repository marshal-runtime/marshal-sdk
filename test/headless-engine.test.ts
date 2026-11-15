// A headless host runs its sessions on the desktop's session engine (LocalBackend, packages/providers backend/local):
// createMarshalHost -> agent port -> engine -> provider client. The client is a double, so no model runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEngineQuery } from "../src/engine-query.js";
import { createMarshalHost } from "../src/host.js";
import type {
  RuntimeClient,
  RuntimeClientSession,
  RuntimePermissionRequest,
  RuntimeSessionConfig,
  RuntimeSessionEvent,
} from "../src/providers.js";

function providerDouble() {
  const created: RuntimeSessionConfig[] = [];
  const resumed: { id: string; config: RuntimeSessionConfig }[] = [];
  const sent: string[] = [];
  const permissions: { kind: string }[] = [];
  const session = (sessionId: string, config: RuntimeSessionConfig): RuntimeClientSession => {
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
        // The model asks to run a shell command; the host's permission handler decides it, as on the desktop.
        const decision = await config.onPermissionRequest?.({ kind: "shell", fullCommandText: "ls", toolCallId: `call-${sent.length}` } as never, { sessionId } as never);
        permissions.push(decision as { kind: string });
        setTimeout(() => {
          emit("assistant.message_delta", { messageId: `m${sent.length}`, deltaContent: "echo" });
          emit("assistant.message", { messageId: `m${sent.length}`, content: `echo ${sent.length}` });
          emit("session.idle", {});
        }, 0);
        return `message-${sent.length}`;
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
      return session(`native-${created.length}`, config);
    },
    async resumeSession(id: string, config: RuntimeSessionConfig) {
      resumed.push({ id, config });
      return session(id, config);
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
  return { factory: async () => client, created, resumed, sent, permissions };
}

test("a headless host runs its turns on the desktop's session engine: tools, prompt, permissions, one live session, resume", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "msdk-headless-engine-"));
  const workspacePath = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(workspacePath, { recursive: true });
  const provider = providerDouble();
  const asked: RuntimePermissionRequest[] = [];
  const query = createEngineQuery({ runtime: "claude", factory: provider.factory, appDataDir: path.join(root, "engine") });
  const host = await createMarshalHost({
    workspacePath,
    stateRoot,
    browser: false,
    query,
    model: "fake-model",
    automations: { start: false },
    permissions: {
      canUseTool: (request) => {
        asked.push(request);
        return { kind: "reject", feedback: "not on this host" };
      },
    },
  });
  let agentId: string;
  try {
    const launched = host.agents.launch({ task: "first", idempotencyKey: "k1" });
    agentId = launched.id;
    const first = await host.agents.wait(agentId, 10_000);
    assert.equal(first.state, "completed");
    assert.equal(first.result, "echo 1");

    // The engine created the native session with the host's prompt (replacing the provider's own) and its Marshal tools.
    assert.equal(provider.created.length, 1);
    const config = provider.created[0]!;
    assert.equal(config.systemMessage?.mode, "replace");
    assert.equal(config.systemMessage?.content, host.systemPrompt(agentId));
    const toolNames = (config.tools ?? []).map((tool) => tool.name);
    for (const name of ["runtime_search", "runtime_exec", "runtime_read_resource"]) assert.ok(toolNames.includes(name), `${name} in ${toolNames.join(",")}`);
    assert.equal(config.workingDirectory, fs.realpathSync(workspacePath));
    assert.match(config.clientName ?? "", /^Marshal\//);
    assert.equal(provider.sent[0], "first");
    // The engine's own per-turn hook (the desktop's date anchor) is on the session for the client to call.
    const submitted = (config.hooks as { onUserPromptSubmitted?: (input: { prompt: string }) => { modifiedPrompt?: string } } | undefined)?.onUserPromptSubmitted?.({ prompt: "first" });
    assert.match(submitted?.modifiedPrompt ?? "", /^first\n\n\[Marshal context: Current date and time is /);
    // The model's shell request went through the engine's permission path to the host's handler, and its no came back.
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.kind, "shell");
    assert.deepEqual(provider.permissions[0], { kind: "reject", feedback: "not on this host" });

    // A second message continues the same live engine session: no new native session.
    host.agents.send(agentId, "second");
    const second = await host.agents.wait(agentId, 10_000);
    assert.equal(second.result, "echo 2");
    assert.equal(provider.created.length, 1, "one live session across turns, as on the desktop");

    const record = host.sessions.get(agentId)!;
    assert.equal(record.runtimeId, "claude");
    assert.equal(record.backendOrigin, "copilot", "the desktop's compatibility origin for a local runtime");
    assert.equal(record.native.sessionId, "native-1");
  } finally {
    await host.dispose();
    await query.dispose();
  }

  // A later run of the host resumes the stored session on the engine by its native id.
  const again = createEngineQuery({ runtime: "claude", factory: provider.factory, appDataDir: path.join(root, "engine") });
  const next = await createMarshalHost({ workspacePath, stateRoot, browser: false, query: again, model: "fake-model", automations: { start: false } });
  try {
    next.agents.send(agentId!, "third");
    const third = await next.agents.wait(agentId!, 10_000);
    assert.equal(third.result, "echo 3");
    assert.equal(provider.resumed.length, 1);
    assert.equal(provider.resumed[0]!.id, "native-1");
  } finally {
    await next.dispose();
    await again.dispose();
  }
});
