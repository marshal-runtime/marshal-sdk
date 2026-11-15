import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider } from "@marshal/runtime";
import { createRuntimeServiceContainer, createRuntimeServiceToken } from "@marshal/runtime/host";
import { z } from "zod";

import { ClaudeAgentPort, TURN_EXTRAS, type QueryFn } from "../src/agent-port.js";
import { createMarshalHost, type MarshalHostOptions } from "../src/host.js";
import { composeBrokers, desktopDirectTools, withSecrets, type MarshalHostTelemetryEvent } from "../src/host-options.js";
import { createProviderQuery } from "../src/provider-query.js";
import { PROVIDER_TOOLS } from "../src/provider-selection.js";
import type { RuntimeClient, RuntimeClientFactory, RuntimePermissionRequest, RuntimeSessionConfig } from "../src/providers.js";
import { FileSessionStore } from "../src/session-store.js";

/** A Claude Agent SDK double that records each turn's options. */
function recording(): { query: QueryFn; turns: Record<string | symbol, any>[] } {
  const turns: Record<string | symbol, any>[] = [];
  let count = 0;
  const query: QueryFn = ({ options }) =>
    (async function* () {
      turns.push(options);
      yield { type: "system", subtype: "init", session_id: `native-${++count}` };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
    })();
  return { query, turns };
}

function dirs(): { workspacePath: string; stateRoot: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-ports-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  return { root, workspacePath, stateRoot: path.join(root, "state") };
}

async function host(options: Partial<MarshalHostOptions> = {}) {
  const { root, workspacePath, stateRoot } = dirs();
  const backend = recording();
  const created = await createMarshalHost({
    workspacePath,
    stateRoot,
    query: backend.query,
    browser: false,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    automations: { start: false },
    ...options,
  });
  return { host: created, turns: backend.turns, root, workspacePath };
}

/** One turn's tools as providers that take tools directly see them: name, parameters, handler. */
async function sessionTools(created: Awaited<ReturnType<typeof host>>) {
  const session = created.host.agents.launch({ task: "t", idempotencyKey: `tools-${Date.now()}` });
  await created.host.agents.wait(session.id);
  const options = created.turns.at(-1)!;
  return { session, tools: options.mcpServers[PROVIDER_TOOLS] as { name: string; parameters: unknown; handler(args: unknown): Promise<string> }[] };
}

function echoProvider(seen: unknown[]): CapabilityProvider {
  const descriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "test.echo",
    version: "1.0.0",
    title: "Echo",
    description: "Echoes its input.",
    tags: ["test"],
    inputSchema: { type: "object", additionalProperties: false, properties: { value: { type: "string" } } },
    outputSchema: { type: "object", additionalProperties: false, properties: { value: { type: "string" } } },
    permissions: [{ permission: "test.echo", risk: "low" }],
  };
  return {
    id: "test.echo",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name: string) => (name === descriptor.name ? descriptor : undefined),
    invoke: async (_name: string, input: unknown) => {
      seen.push(input);
      return { output: input };
    },
  } as unknown as CapabilityProvider;
}

test("permissions.canUseTool: the Agent SDK path drops bypassPermissions and asks the handler in the desktop's request shape", async () => {
  const requests: { request: RuntimePermissionRequest; sessionId: string }[] = [];
  const { query, turns } = recording();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-perm-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r", host: { id: "t", kind: "local" } });
  const agents = new ClaudeAgentPort({
    query,
    store,
    cwd: root,
    env: {},
    defaultModel: "m",
    systemPrompt: () => "p",
    mcpServers: () => ({}),
    permissionHandler: (request, { sessionId }) => {
      requests.push({ request, sessionId });
      return request.kind === "shell" ? { kind: "reject", feedback: "no shell" } : { kind: "approve-once" };
    },
  });
  const session = agents.launch({ task: "a", idempotencyKey: "a" });
  await agents.wait(session.id);
  const options = turns[0]!;
  assert.equal(options.permissionMode, "default");
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  const denied = await options.canUseTool("Bash", { command: "rm -rf /" }, { toolUseID: "u1", signal: new AbortController().signal });
  assert.equal(denied.behavior, "deny");
  assert.equal(denied.message, "no shell");
  const allowed = await options.canUseTool("Read", { file_path: "/tmp/x" }, { toolUseID: "u2", signal: new AbortController().signal });
  assert.equal(allowed.behavior, "allow");
  assert.deepEqual(requests.map((entry) => [entry.request.kind, entry.request.toolName, entry.sessionId]), [
    ["shell", "Bash", session.id],
    ["read", "Read", session.id],
  ]);
  assert.equal(requests[0]!.request.command, "rm -rf /");

  const bare = recording();
  const open = new ClaudeAgentPort({ query: bare.query, store, cwd: root, env: {}, defaultModel: "m", systemPrompt: () => "p", mcpServers: () => ({}) });
  await open.wait(open.launch({ task: "b", idempotencyKey: "b" }).id);
  assert.equal(bare.turns[0]!.permissionMode, "bypassPermissions", "without a handler the unattended default stays");
  assert.equal(bare.turns[0]!.canUseTool, undefined);
});

test("permissions.canUseTool: provider clients get it as onPermissionRequest, with the Marshal session id", async () => {
  const configs: RuntimeSessionConfig[] = [];
  const factory: RuntimeClientFactory = async () =>
    ({
      async createSession(config: RuntimeSessionConfig) {
        configs.push(config);
        const handlers = new Set<(event: any) => void>();
        return {
          sessionId: "provider-own-id",
          on: (handler: (event: any) => void) => (handlers.add(handler), () => handlers.delete(handler)),
          async send() {
            setTimeout(() => {
              for (const handler of handlers) handler({ type: "assistant.message", data: { content: "ok" } });
              for (const handler of handlers) handler({ type: "session.idle", data: {} });
            }, 0);
            return "m";
          },
          async abort() {},
          async disconnect() {},
        };
      },
      async resumeSession() {
        throw new Error("not in this test");
      },
      async stop() {},
    }) as unknown as RuntimeClient;
  const seen: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-perm-client-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r", host: { id: "t", kind: "local" } });
  const agents = new ClaudeAgentPort({
    query: createProviderQuery({ factory }),
    store,
    cwd: root,
    env: {},
    defaultModel: "m",
    systemPrompt: () => "p",
    mcpServers: () => ({}),
    permissionHandler: (_request, { sessionId }) => (seen.push(sessionId), { kind: "reject" }),
  });
  const session = agents.launch({ task: "a", idempotencyKey: "a" });
  await agents.wait(session.id);
  const decision = await configs[0]!.onPermissionRequest!({ kind: "shell" }, { sessionId: "provider-own-id" });
  assert.deepEqual(decision, { kind: "reject" });
  assert.deepEqual(seen, [session.id]);
});

test("permissions.broker, ui.applicationAuthority and providerSources: the embedder's broker decides capability calls after the authority", async () => {
  const seen: unknown[] = [];
  const decided: string[] = [];
  const created = await host({
    providerSources: [() => echoProvider(seen)],
    permissions: {
      broker: {
        decide: (check) => {
          decided.push(check.capability.name);
          return String((check.request.input as { value?: string } | undefined)?.value) === "blocked"
            ? { decision: "deny", reason: "blocked by the host policy" }
            : { decision: "allow" };
        },
      },
    },
    ui: {
      applicationAuthority: {
        decide: (check) => ((check.request.input as { value?: string } | undefined)?.value === "app-owned" ? { decision: "allow", reason: "app" } : undefined),
      },
    },
  });
  try {
    assert.deepEqual(await created.host.invoke("test.echo", { value: "hi" }), { value: "hi" });
    await assert.rejects(created.host.invoke("test.echo", { value: "blocked" }), /blocked by the host policy|denied/);
    assert.deepEqual(await created.host.invoke("test.echo", { value: "app-owned" }), { value: "app-owned" });
    assert.deepEqual(seen, [{ value: "hi" }, { value: "app-owned" }]);
    assert.equal(decided.filter((name) => name === "test.echo").length, 2, "the authority answered the app-owned call before the broker");
  } finally {
    await created.host.dispose();
  }
});

test("composeBrokers: the first broker that does not allow decides", async () => {
  const deny = { decide: () => ({ decision: "deny" as const, reason: "kit" }) };
  const allow = { decide: () => ({ decision: "allow" as const }) };
  const composed = composeBrokers([allow, deny, allow])!;
  assert.equal((await composed.decide({} as never)).decision, "deny");
  assert.equal((await composeBrokers([allow])!.decide({} as never)).decision, "allow");
  assert.equal(composeBrokers([undefined]), undefined);
});

test("runtimeRoot: runtime state lives in the host's folder, not the workspace; capabilities still work in the workspace", async () => {
  const { root } = dirs();
  const runtimeRoot = path.join(root, "runtime");
  const notified: unknown[] = [];
  const created = await host({ runtimeRoot, notifications: (note) => void notified.push(note) });
  try {
    assert.ok(fs.existsSync(path.join(runtimeRoot, "state")), "state under runtimeRoot");
    assert.equal(fs.existsSync(path.join(created.workspacePath, ".marshal")), false, "nothing in the workspace");
    assert.deepEqual(await created.host.invoke("marshal.tool.sendNotification", { title: "t", body: "b" }), { success: true });
    assert.equal(notified.length, 1);
    assert.match(String((notified[0] as { sessionId?: string }).sessionId), /^host-/, "the host's own call");
  } finally {
    await created.host.dispose();
  }
  const plain = await host();
  try {
    assert.ok(fs.existsSync(path.join(plain.workspacePath, ".marshal", "runtime")), "default stays workspace-relative");
    await assert.rejects(plain.host.invoke("marshal.tool.sendNotification", { title: "t", body: "b" }), /not_found|not found|failed/);
  } finally {
    await plain.host.dispose();
  }
  await assert.rejects(host({ runtimeRoot: "relative/runtime" }), /absolute/);
});

test("worktreeRoot inside the workspace is refused", async () => {
  const { workspacePath, stateRoot } = dirs();
  await assert.rejects(
    createMarshalHost({ workspacePath, stateRoot, query: recording().query, browser: false, worktreeRoot: path.join(workspacePath, "wt") }),
    /outside the workspace/,
  );
});

test("directTools with runtimeTools false: sessions see the desktop's tool names, run on this host's runtime, and the prompt names them", async () => {
  const notified: unknown[] = [];
  const { root } = dirs();
  const created = await host({
    directTools: desktopDirectTools(z),
    runtimeTools: false,
    runtimeRoot: path.join(root, "runtime"),
    notifications: (note) => void notified.push(note),
  });
  try {
    const { session, tools } = await sessionTools(created);
    assert.deepEqual(tools.map((entry) => entry.name), ["runtimeSearch", "runtimeInvoke", "runtimeExecuteTypeScript", "runtimeReadResource", "forkSubagents"]);
    const byName = new Map(tools.map((entry) => [entry.name, entry]));
    const ts = await byName.get("runtimeExecuteTypeScript")!.handler({ source: "return 20 + 22;" });
    assert.deepEqual(JSON.parse(ts), { ok: true, value: 42 });
    await byName.get("runtimeInvoke")!.handler({ capability: "marshal.tool.sendNotification", input: { title: "a", body: "b" } });
    assert.deepEqual(notified, [{ title: "a", body: "b", sessionId: session.id }], "the call carries the calling session");
    const found = await byName.get("runtimeSearch")!.handler({ name: "marshal.tool.sendNotification" });
    assert.match(found, /sendNotification/);
    const prompt = created.host.systemPrompt() ?? "";
    assert.match(prompt, /mcp__marshal__runtimeExecuteTypeScript/);
    assert.doesNotMatch(prompt, /mcp__marshal__runtime_exec\b/);
  } finally {
    await created.host.dispose();
  }
});

test("trustedTypeScript: full-Node imports in TypeScript blocks only when the host trusts them", async () => {
  const source = 'import fs from "node:fs";\nreturn typeof fs.readFileSync;';
  const run = async (trustedTypeScript: boolean) => {
    const created = await host({ directTools: desktopDirectTools(z), trustedTypeScript });
    try {
      const { tools } = await sessionTools(created);
      const exec = tools.find((entry) => entry.name === "runtimeExecuteTypeScript")!;
      return await exec.handler({ source }).then((text) => text, (error: Error) => `error: ${error.message}`);
    } finally {
      await created.host.dispose();
    }
  };
  assert.deepEqual(JSON.parse(await run(true)), { ok: true, value: "function" });
  const brokered = await run(false);
  assert.match(brokered, /IMPORT_DENIED|denied/, brokered);
});

test("nodeExecutable runs the browser MCP server; serviceContainer: services the embedder bound reach its providers", async () => {
  const container = createRuntimeServiceContainer();
  const rooms = createRuntimeServiceToken<{ name: string }>("@marshal/sdk-test:rooms");
  await container.bind(rooms, { useValue: { name: "org rooms" } });
  const seen: unknown[] = [];
  const created = await host({
    browser: true,
    nodeExecutable: "/opt/marshal/node",
    serviceContainer: container,
    providerSources: [
      (context) => {
        seen.push(context.serviceContainer.tryGet(rooms));
        return echoProvider([]);
      },
    ],
  });
  try {
    const session = created.host.agents.launch({ task: "t", idempotencyKey: "browser" });
    await created.host.agents.wait(session.id);
    const playwright = created.turns.at(-1)!.mcpServers.playwright as { command: string } | undefined;
    assert.ok(playwright, "@playwright/mcp is a dependency");
    assert.equal(playwright.command, "/opt/marshal/node");
    assert.deepEqual(seen, [{ name: "org rooms" }]);
  } finally {
    await created.host.dispose();
  }
});

test("settings and telemetry: new sessions take the live model; host, session and settings events reach the sink", async () => {
  const events: MarshalHostTelemetryEvent[] = [];
  let current = { model: "claude-live-1", reasoningEffort: "high" };
  let listener: ((settings: typeof current) => void) | undefined;
  const created = await host({
    telemetry: (event) => void events.push(event),
    settings: {
      read: () => current,
      subscribe: (next) => ((listener = next), () => (listener = undefined)),
    },
  });
  try {
    const first = created.host.agents.launch({ task: "a", idempotencyKey: "a" });
    await created.host.agents.wait(first.id);
    assert.equal(created.turns[0]!.model, "claude-live-1");
    assert.equal(created.turns[0]!.effort, "high");
    current = { model: "claude-live-2", reasoningEffort: "low" };
    listener!(current);
    const second = created.host.agents.launch({ task: "b", idempotencyKey: "b" });
    await created.host.agents.wait(second.id);
    assert.equal(created.turns[1]!.model, "claude-live-2");
    const names = events.map((event) => event.name);
    assert.ok(names.includes("host.started"), names.join(","));
    assert.ok(names.includes("session.idle"), names.join(","));
    assert.ok(names.includes("settings.changed"), names.join(","));
    for (const event of events) assert.doesNotMatch(JSON.stringify(event.details), /"task"|"a"|"b"/, "metadata only");
  } finally {
    await created.host.dispose();
  }
  assert.equal(listener, undefined, "unsubscribed on dispose");
});

test("secrets: provider keys come from the host's store, and never enumerate into a child environment", async () => {
  const env = withSecrets({ HOME: "/h" } as Record<string, string | undefined>, (name) => (name === "OPENAI_API_KEY" ? "sk-store" : undefined));
  assert.equal(env.OPENAI_API_KEY, "sk-store");
  assert.equal(env.HOME, "/h");
  assert.deepEqual(Object.keys({ ...env }), ["HOME"]);
  const lines: string[] = [];
  const created = await host({
    query: undefined,
    provider: { id: "openai" },
    env: {},
    secrets: (name) => (name === "OPENAI_API_KEY" ? "sk-store" : undefined),
    log: (line) => void lines.push(line),
  });
  try {
    assert.ok(lines.some((line) => /provider openai .*API key from OPENAI_API_KEY/.test(line)), lines.join("\n"));
  } finally {
    await created.host.dispose();
  }
  await assert.rejects(host({ query: undefined, provider: { id: "openai" }, env: {} }), /OPENAI_API_KEY/);
});

test("TURN_EXTRAS carries no handler when the host has none", async () => {
  const created = await host();
  try {
    const session = created.host.agents.launch({ task: "t", idempotencyKey: "x" });
    await created.host.agents.wait(session.id);
    assert.equal(created.turns[0]![TURN_EXTRAS].permissionHandler, undefined);
  } finally {
    await created.host.dispose();
  }
});
