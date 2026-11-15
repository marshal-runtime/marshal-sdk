import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { createProviderQuery, PROVIDER_TOOLS } from "../src/provider-query.js";
import { resolveProvider } from "../src/provider-selection.js";
import type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeSessionConfig,
  RuntimeSessionEvent,
} from "../src/providers.js";
import { FileSessionStore } from "../src/session-store.js";

/** A provider transport double: a RuntimeClient whose sessions answer `reply(prompt)` with provider events. */
function fakeProvider(options: { reply?: (text: string) => string; fail?: string; holdMs?: number } = {}) {
  const created: RuntimeSessionConfig[] = [];
  const resumed: { id: string; config: RuntimeSessionConfig }[] = [];
  const logins: unknown[] = [];
  const sent: string[] = [];
  const aborted: string[] = [];
  const workspaces: string[] = [];
  let sessions = 0;
  let stopped = 0;
  const session = (sessionId: string): RuntimeClientSession => {
    const handlers = new Set<(event: RuntimeSessionEvent) => void>();
    const emit = (type: string, data: Record<string, unknown>) => {
      const event = { id: `${type}-${Math.random()}`, timestamp: new Date().toISOString(), parentId: null, type, data } as unknown as RuntimeSessionEvent;
      for (const handler of handlers) handler(event);
    };
    let timer: NodeJS.Timeout | undefined;
    return {
      sessionId,
      on(handler: (event: RuntimeSessionEvent) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async send({ prompt }: { prompt: string }) {
        sent.push(prompt);
        timer = setTimeout(() => {
          emit("tool.execution_start", { toolCallId: "t1", toolName: "runtime_search" });
          if (options.fail) {
            emit("session.error", { message: options.fail, errorType: "provider" });
            return;
          }
          emit("assistant.message", { messageId: "m1", content: (options.reply ?? ((text) => `echo: ${text}`))(prompt) });
          emit("assistant.usage", { model: "fake-model", inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, cost: 0.02 });
          emit("session.idle", {});
        }, options.holdMs ?? 0);
        return "message-1";
      },
      async abort() {
        clearTimeout(timer);
        aborted.push(sessionId);
      },
      async disconnect() {},
      async destroy() {},
    } as unknown as RuntimeClientSession;
  };
  const client = {
    async createSession(config: RuntimeSessionConfig) {
      created.push(config);
      return session(`native-${++sessions}`);
    },
    async resumeSession(id: string, config: RuntimeSessionConfig) {
      resumed.push({ id, config });
      return session(id);
    },
    async login(request: unknown) {
      logins.push(request);
    },
    async stop() {
      stopped += 1;
    },
  } as unknown as RuntimeClient;
  const factory: RuntimeClientFactory = async (workspaceDir: string) => {
    workspaces.push(workspaceDir);
    return client;
  };
  return { factory, created, resumed, logins, sent, aborted, workspaces, stopped: () => stopped };
}

function portOn(query: ReturnType<typeof createProviderQuery>, mcpServers: () => Record<string | symbol, unknown> = () => ({})) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-providers-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  const port = new ClaudeAgentPort({
    query,
    store,
    cwd: root,
    env: {},
    defaultModel: "",
    systemPrompt: () => "You are a Marshal agent.",
    mcpServers: mcpServers as () => Record<string, unknown>,
  });
  return { port, store, root };
}

test("a session runs on a provider client: answer, usage and native id, and the next message resumes it", async () => {
  const provider = fakeProvider();
  const query = createProviderQuery({ factory: provider.factory });
  const { port, store, root } = portOn(query);
  const agent = port.launch({ task: "say hi", idempotencyKey: "k1" });
  const waited = await port.wait(agent.id);
  assert.equal(waited.state, "completed");
  assert.equal(waited.result, "echo: say hi");
  const record = store.get(agent.id)!;
  assert.equal(record.native.sessionId, "native-1");
  assert.equal(record.usage.inputTokens, 10);
  assert.equal(record.usage.outputTokens, 5);
  assert.equal(record.usage.cacheReadTokens, 3);
  assert.equal(record.usage.cacheWriteTokens, 2);
  assert.equal(record.usage.costUsd, 0.02);
  const config = provider.created[0]!;
  assert.equal(config.cwd, root);
  assert.equal(config.model, undefined, "an empty default model lets the provider choose");
  assert.deepEqual(config.systemMessage, { content: "You are a Marshal agent.", mode: "replace" });
  assert.deepEqual(config.sandbox, { mode: "danger-full-access" });
  assert.deepEqual(await config.onPermissionRequest?.({} as never, { sessionId: "native-1" }), { kind: "approve-once" });

  port.send(agent.id, "again");
  await port.wait(agent.id);
  assert.equal(provider.resumed[0]?.id, "native-1");
  assert.deepEqual(provider.sent, ["say hi", "again"]);
  assert.deepEqual(provider.workspaces, [root], "one client per working directory");
  await query.dispose();
  assert.equal(provider.stopped(), 1);
});

test("the session's marshal tools and stdio and HTTP MCP servers reach the provider; in-process servers do not", async () => {
  const provider = fakeProvider();
  const tool = { name: "runtime_search", description: "search", handler: async () => "found" };
  const { port } = portOn(createProviderQuery({ factory: provider.factory }), () => ({
    marshal: { type: "sdk", name: "marshal", instance: {} },
    playwright: { command: "npx", args: ["@playwright/mcp"], env: { A: "1" } },
    remote: { type: "http", url: "https://mcp.example/x", headers: { Authorization: "Bearer t" } },
    [PROVIDER_TOOLS]: [tool],
  }));
  const agent = port.launch({ task: "x", idempotencyKey: "k2", model: "gpt-5.5" });
  await port.wait(agent.id);
  const config = provider.created[0]!;
  assert.equal(config.model, "gpt-5.5");
  assert.deepEqual(config.tools, [tool]);
  assert.deepEqual(config.mcpServers, {
    playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp"], env: { A: "1" } },
    remote: { type: "http", url: "https://mcp.example/x", headers: { Authorization: "Bearer t" } },
  });
});

test("a provider error ends the turn with an error answer carrying the provider's message, as on Claude", async () => {
  const provider = fakeProvider({ fail: "rate limited" });
  const { port } = portOn(createProviderQuery({ factory: provider.factory }));
  const agent = port.launch({ task: "x", idempotencyKey: "k3" });
  assert.equal((await port.wait(agent.id)).result, "rate limited");
  const last = port.transcript(agent.id, 1).messages.at(-1) as { content: string; error?: boolean };
  assert.equal(last.content, "rate limited");
  assert.equal(last.error, true);
});

test("cancel aborts the provider session", async () => {
  const provider = fakeProvider({ holdMs: 5_000 });
  const { port } = portOn(createProviderQuery({ factory: provider.factory }));
  const agent = port.launch({ task: "long", idempotencyKey: "k4" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  port.cancel(agent.id);
  await port.wait(agent.id);
  assert.deepEqual(provider.aborted, ["native-1"]);
});

test("forking a session on a non-Claude provider fails with a clear message", async () => {
  const provider = fakeProvider();
  const query = createProviderQuery({ factory: provider.factory });
  await assert.rejects(async () => {
    for await (const _ of query({ prompt: "x", options: { forkSession: true, resume: "native-1" } })) void _;
  }, /Forking a session needs the Claude provider/);
});

// Credentials: each provider on a subscription account from the desktop registry, and on an API key.

function desktopHome(accounts: Record<string, string[]>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-home-"));
  const dataDir = path.join(home, ".marshal-dev");
  fs.mkdirSync(dataDir, { recursive: true });
  const runtimeAccounts = Object.fromEntries(
    Object.entries(accounts).map(([runtime, ids]) => [runtime, { accounts: ids.map((id) => ({ id, label: id })) }]),
  );
  fs.writeFileSync(path.join(dataDir, "marshal-settings.json"), JSON.stringify({ runtimeAccounts }));
  const privateRoot = path.join(home, "state", ".private");
  fs.mkdirSync(privateRoot, { recursive: true });
  return { home, dataDirs: [path.join(home, ".marshal"), dataDir], privateRoot };
}

function capture<T>() {
  const seen: T[] = [];
  const provider = fakeProvider();
  return { seen, provider, make: (options: T) => (seen.push(options), provider.factory) };
}

test("Claude on a subscription account: that account's config dir, launch-environment keys removed", () => {
  const { home, dataDirs, privateRoot } = desktopHome({ claude: ["omer-max"] });
  const resolved = resolveProvider(
    { id: "claude", account: "omer-max" },
    { env: { ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin" }, privateRoot, homeDir: home, desktopDataDirs: dataDirs },
  );
  assert.equal(resolved.credential, "subscription");
  assert.equal(resolved.query, undefined, "Claude keeps the Agent SDK path by default");
  assert.deepEqual(resolved.env, { PATH: "/bin", CLAUDE_CONFIG_DIR: path.join(home, ".marshal", "marshal-claude-accounts", "omer-max") });
  assert.doesNotMatch(resolved.description, /sk-ant/);
});

test("Claude on an API key: the key from the named variable, and nothing else changes", () => {
  const { home, dataDirs, privateRoot } = desktopHome({});
  const resolved = resolveProvider(
    { id: "claude", apiKeyEnv: "TEAM_ANTHROPIC_KEY" },
    { env: { TEAM_ANTHROPIC_KEY: "sk-ant-team", PATH: "/bin" }, privateRoot, homeDir: home, desktopDataDirs: dataDirs },
  );
  assert.equal(resolved.credential, "api-key");
  assert.equal(resolved.env.ANTHROPIC_API_KEY, "sk-ant-team");
  assert.equal(resolved.env.CLAUDE_CONFIG_DIR, undefined);
  assert.doesNotMatch(resolved.description, /sk-ant-team/);
});

test("Claude without a selection detail keeps the host environment exactly as given", () => {
  const { home, dataDirs, privateRoot } = desktopHome({});
  const env = { CLAUDE_CONFIG_DIR: "/accounts/x", PATH: "/bin" };
  const resolved = resolveProvider({ id: "claude" }, { env, privateRoot, homeDir: home, desktopDataDirs: dataDirs });
  assert.deepEqual(resolved.env, env);
});

test("Claude on the desktop's client: the account goes to the client factory, which runs turns", async () => {
  const { home, dataDirs, privateRoot } = desktopHome({ claude: ["omer-zyg1"] });
  const claude = capture<Record<string, unknown>>();
  const resolved = resolveProvider(
    { id: "claude", account: "omer-zyg1", engine: "client" },
    { env: {}, privateRoot, homeDir: home, desktopDataDirs: dataDirs, factories: { claude: claude.make as never } },
  );
  assert.equal(claude.seen[0]!.accountId, "omer-zyg1");
  assert.equal(claude.seen[0]!.accountHomeDir, home);
  const { port } = portOn(resolved.query!);
  const agent = port.launch({ task: "hi", idempotencyKey: "c1" });
  assert.equal((await port.wait(agent.id)).result, "echo: hi");
});

test("Codex on a subscription account: that account's CODEX_HOME, no sign-in", async () => {
  const { home, dataDirs, privateRoot } = desktopHome({ codex: ["work"] });
  const codex = capture<Record<string, unknown>>();
  const resolved = resolveProvider(
    { id: "codex", account: "work" },
    { env: {}, privateRoot, homeDir: home, desktopDataDirs: dataDirs, factories: { codex: codex.make as never } },
  );
  assert.equal(resolved.credential, "subscription");
  assert.equal(resolved.defaultModel, "");
  assert.equal(codex.seen[0]!.codexHome, path.join(home, ".marshal", "marshal-codex-accounts", "work"));
  const { port } = portOn(resolved.query!);
  await port.wait(port.launch({ task: "hi", idempotencyKey: "x1" }).id);
  assert.deepEqual(codex.provider.logins, []);
});

test("Codex on an API key: a private CODEX_HOME under the host state, signed in with the key once per client", async () => {
  const { home, dataDirs, privateRoot } = desktopHome({});
  const codex = capture<Record<string, unknown>>();
  const resolved = resolveProvider(
    { id: "codex", apiKeyEnv: "OPENAI_API_KEY" },
    { env: { OPENAI_API_KEY: "sk-openai" }, privateRoot, homeDir: home, desktopDataDirs: dataDirs, factories: { codex: codex.make as never } },
  );
  assert.equal(resolved.credential, "api-key");
  assert.equal(codex.seen[0]!.codexHome, path.join(privateRoot, "providers", "codex"));
  const { port } = portOn(resolved.query!);
  const agent = port.launch({ task: "one", idempotencyKey: "x2" });
  await port.wait(agent.id);
  port.send(agent.id, "two");
  await port.wait(agent.id);
  assert.deepEqual(codex.provider.logins, [{ type: "api-key", apiKey: "sk-openai" }]);
});

test("Cursor on a subscription account: that account's credential store in the desktop data folder", async () => {
  const { home, dataDirs, privateRoot } = desktopHome({ cursor: ["team"] });
  const cursor = capture<Record<string, unknown>>();
  const resolved = resolveProvider(
    { id: "cursor", account: "team" },
    { env: { CURSOR_API_KEY: "launch-key" }, privateRoot, homeDir: home, desktopDataDirs: dataDirs, factories: { cursor: cursor.make as never } },
  );
  assert.equal(resolved.credential, "subscription");
  assert.equal(cursor.seen[0]!.accountId, "team", "an account drops the launch key (in the factory)");
  assert.match(String(cursor.seen[0]!.credentialStorePath), new RegExp(`cursor-accounts/team/`));
  const { port } = portOn(resolved.query!);
  assert.equal((await port.wait(port.launch({ task: "hi", idempotencyKey: "u1" }).id)).result, "echo: hi");
});

test("Cursor on an API key: the key in the client environment and an empty private store", () => {
  const { home, dataDirs, privateRoot } = desktopHome({});
  const cursor = capture<Record<string, unknown>>();
  const resolved = resolveProvider(
    { id: "cursor", apiKeyEnv: "TEAM_CURSOR_KEY" },
    { env: { TEAM_CURSOR_KEY: "cur-key" }, privateRoot, homeDir: home, desktopDataDirs: dataDirs, factories: { cursor: cursor.make as never } },
  );
  assert.equal(resolved.credential, "api-key");
  assert.equal((cursor.seen[0]!.env as Record<string, string>).CURSOR_API_KEY, "cur-key");
  assert.ok(String(cursor.seen[0]!.credentialStorePath).startsWith(path.join(privateRoot, "providers", "cursor")));
  assert.equal(cursor.seen[0]!.accountId, undefined);
});

test("a selection that cannot work fails before the host starts, saying why", () => {
  const { home, dataDirs, privateRoot } = desktopHome({ claude: ["omer-max"] });
  const base = { env: {}, privateRoot, homeDir: home, desktopDataDirs: dataDirs };
  assert.throws(() => resolveProvider({ id: "claude", account: "nobody" }, base), /No claude account "nobody".*omer-max/);
  assert.throws(() => resolveProvider({ id: "codex", apiKeyEnv: "MISSING_KEY" }, base), /MISSING_KEY is not set/);
  assert.throws(() => resolveProvider({ id: "gemini" as never }, base), /Unknown provider/);
  assert.throws(() => resolveProvider({ id: "codex", engine: "client" }, base), /Claude provider only/);
  assert.throws(() => resolveProvider({ id: "claude", account: "omer-max", apiKeyEnv: "K" }, base), /not both/);
});

test("a host on a provider client gives sessions the marshal tools, and they call the host's runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-provider-host-"));
  fs.mkdirSync(path.join(dir, "ws"));
  const provider = fakeProvider();
  const host = await createMarshalHost({
    workspacePath: path.join(dir, "ws"),
    stateRoot: path.join(dir, "state"),
    query: createProviderQuery({ factory: provider.factory }),
    browser: false,
    env: {},
    ...({ automations: { start: false } } as object),
  });
  try {
    await host.agents.wait(host.agents.launch({ task: "look around", idempotencyKey: "h1" }).id);
    const tools = provider.created[0]!.tools ?? [];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["runtime_exec", "runtime_read_resource", "runtime_search"]);
    assert.equal(provider.created[0]!.mcpServers, undefined, "the in-process marshal server stays on the Claude path");
    const search = tools.find((tool) => tool.name === "runtime_search")!;
    const found = await search.handler({ query: "launch an agent session" }, {} as never);
    assert.match(found, /marshal\.agent/);
  } finally {
    await host.dispose();
  }
});

test("marshal-sdk.json picks the provider: parsed, checked, and handed to the host by withManifest", async () => {
  const { parseManifest } = await import("../src/onboarding.js");
  const { withManifest } = await import("../src/onboarding-cli.js");
  const manifest = parseManifest({ version: 1, provider: { id: "codex", account: "work" }, defaults: false, extensions: [] });
  assert.deepEqual(manifest.provider, { id: "codex", account: "work" });
  assert.throws(() => parseManifest({ version: 1, provider: { id: "gemini" }, extensions: [] }), /provider is/);
  assert.throws(() => parseManifest({ version: 1, provider: { id: "codex", apiKey: "sk-inline" }, extensions: [] }), /provider is/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-provider-manifest-"));
  const file = path.join(dir, "marshal-sdk.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, provider: { id: "cursor", apiKeyEnv: "TEAM_CURSOR_KEY" }, defaults: false, extensions: [] }));
  const base = { workspacePath: dir, stateRoot: path.join(dir, "state"), env: {} };
  assert.deepEqual((await withManifest(base, { manifest: file })).provider, { id: "cursor", apiKeyEnv: "TEAM_CURSOR_KEY" });
  const inCode = { id: "claude" as const, account: "omer-max" };
  assert.deepEqual((await withManifest({ ...base, provider: inCode }, { manifest: file })).provider, inCode, "a provider given in code wins");
});
