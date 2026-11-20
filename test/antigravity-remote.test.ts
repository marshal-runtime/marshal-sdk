import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TURN_EXTRAS, type QueryFn } from "../src/agent-port.js";
import { createMarshalHost, type MarshalHostOptions } from "../src/host.js";
import { PROVIDER_TOOLS, PROVIDER_TOOLS_ONLY, sessionConfig } from "../src/provider-query.js";
import { providerForModelFamily } from "../src/provider-selection.js";
import { createEngineQuery } from "../src/engine-query.js";
import {
  AntigravityBridge,
  AntigravityRuntimeClient,
  ANTIGRAVITY_BRIDGE_SOURCE,
  assertProxyEndpoint,
  type AntigravityBridgeSpawnRequest,
  type AntigravityProxyEndpoint,
  type AntigravityRemoteBridge,
} from "../src/providers.js";
import type { RemoteRuntimeConnection, RemoteToolResult } from "../src/remote-tools.js";

/**
 * A stand-in for Antigravity's Python bridge (bridge.py): the same JSON-lines protocol, driven by the real
 * AntigravityRuntimeClient and AntigravityBridge. It behaves like google-antigravity 0.1.24 where it matters here:
 * the active built-ins are `enabledBuiltinTools` when given, else the SDK's defaults minus `disabledBuiltinTools`;
 * a structured answer comes back only when the built-in `finish` is active. Each turn calls the host tool
 * `runtime_exec` when the session has it, and a model that has `run_command` uses it, as an agent with a shell would.
 */
const FAKE_BRIDGE = String.raw`
import fs from "node:fs";
import readline from "node:readline";
const LOG = process.env.FAKE_BRIDGE_LOG;
const record = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
// google.antigravity.types.BuiltinTools.default(): every built-in except ask_question and the three directory tools.
const DEFAULTS = ["view_file", "create_file", "edit_file", "run_command", "invoke_subagent", "run_workflow", "generate_image", "search_web", "read_url_content", "schedule", "finish"];
const sessions = new Map();
const pending = new Map();
let next = 0;
const ask = (session, payload) => {
  const id = "req-" + ++next;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    emit({ ev: "request", id, session, ...payload });
  });
};
async function turn(command) {
  const config = sessions.get(command.session);
  const active = config.enabledBuiltinTools ?? DEFAULTS.filter((name) => !(config.disabledBuiltinTools ?? []).includes(name));
  record({ op: "turn", session: command.session, prompt: command.prompt, active });
  if (active.includes("run_command")) {
    const pre = await ask(command.session, { kind: "pre_tool", callId: "shell-" + next, toolName: "run_command", args: { CommandLine: "id -un", Cwd: process.cwd() }, serverName: null, canonicalPath: null, hostTool: false });
    record({ op: "builtin", tool: "run_command", allowed: pre.allow === true });
  }
  let toolText = null;
  if ((config.hostTools ?? []).some((tool) => tool.name === "runtime_exec")) {
    const args = { targetType: "operation", target: "zs.data.query", input: { sql: "select 1" } };
    const callId = "call-" + next;
    const pre = await ask(command.session, { kind: "pre_tool", callId, toolName: "runtime_exec", args, serverName: null, canonicalPath: null, hostTool: true });
    if (pre.allow) {
      const reply = await ask(command.session, { kind: "host_tool", callId, toolName: "runtime_exec", args: pre.args ?? args });
      toolText = reply.text ?? "ERROR " + reply.error;
      emit({ ev: "tool_result", session: command.session, callId, toolName: "runtime_exec", result: toolText, error: reply.error ?? null });
    }
    record({ op: "host_tool", tool: "runtime_exec", allowed: pre.allow === true, text: toolText });
  }
  // The harness's model call: with a proxy endpoint it goes to baseUrl with httpHeaders, as the real harness does.
  const endpoint = config.endpoint ?? {};
  if (endpoint.baseUrl) {
    const response = await fetch(endpoint.baseUrl.replace(/\/$/, "") + "/v1/publishers/google/models/" + (config.model ?? "default") + ":streamGenerateContent", {
      method: "POST",
      headers: { "content-type": "application/json", ...(endpoint.httpHeaders ?? {}) },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: command.prompt }] }] }),
    });
    const text = await response.text();
    record({ op: "model_call", status: response.status, text });
    toolText = (toolText ?? "") + " | model: " + text;
  }
  emit({ ev: "chunk", session: command.session, turn: command.turn, kind: "text", text: "done: " + toolText });
  const structured = config.responseSchema && active.includes("finish") && !command.prompt.includes("NO_ANSWER") ? { verdict: "held", evidence: toolText } : null;
  emit({ ev: "turn_end", session: command.session, turn: command.turn, usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 7, totalTokens: 157 }, stopReason: "STOP", structured });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "reply") {
    pending.get(command.id)?.(command.result ?? {});
    pending.delete(command.id);
  } else if (command.op === "open") {
    sessions.set(command.session, command.config);
    record({ op: "open", session: command.session, config: command.config, cwd: process.cwd() });
    emit({ ev: "opened", session: command.session, conversationId: command.config.conversationId });
  } else if (command.op === "send") {
    void turn(command);
  } else if (command.op === "close") {
    sessions.delete(command.session);
    emit({ ev: "closed", session: command.session });
  }
});
emit({ ev: "ready", protocol: 1 });
`;

interface BridgeLog {
  op: string;
  session?: string;
  config?: Record<string, any>;
  prompt?: string;
  active?: string[];
  tool?: string;
  allowed?: boolean;
  text?: string | null;
  status?: number;
}

/** An Antigravity home whose "Python" runs the fake bridge, and the environment that points the provider at it. */
function fakeAntigravity(root: string) {
  const home = path.join(root, "antigravity");
  fs.mkdirSync(home, { recursive: true });
  const script = path.join(root, "fake-bridge.mjs");
  fs.writeFileSync(script, FAKE_BRIDGE);
  const python = path.join(root, "fake-python");
  // `python -I -c "import google.antigravity"` is the provider's SDK check; anything else starts the bridge.
  fs.writeFileSync(python, `#!/bin/sh\nif [ "$2" = "-c" ]; then exit 0; fi\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  const log = path.join(root, "bridge.jsonl");
  fs.writeFileSync(log, "");
  return {
    home,
    script,
    log,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GEMINI_API_KEY: "fake-gemini-key", MARSHAL_ANTIGRAVITY_PYTHON: python, FAKE_BRIDGE_LOG: log },
    entries: (): BridgeLog[] =>
      fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as BridgeLog),
  };
}

/** A brand VM's runtime: records each call; a Marley session's tools reach it, never the host's runtime. */
function vmRuntime(): RemoteRuntimeConnection & { calls: { name: string; args: Record<string, unknown> }[] } {
  const runtime = {
    calls: [] as { name: string; args: Record<string, unknown> }[],
    async callTool(name: string, args: Record<string, unknown>): Promise<RemoteToolResult> {
      runtime.calls.push({ name, args });
      return { content: [{ type: "text", text: `vm ${name} ${String(args.target ?? args.query ?? "")}`.trim() }], structuredContent: { status: "success", result: { output: 1 } } };
    },
    async readResource(uri: string) {
      return { contents: [{ uri, text: `vm body of ${uri}` }] };
    },
  };
  return runtime;
}

function recording(): { query: QueryFn; turns: Record<string | symbol, any>[] } {
  const turns: Record<string | symbol, any>[] = [];
  const query: QueryFn = ({ options }) =>
    (async function* () {
      turns.push(options);
      yield { type: "system", subtype: "init", session_id: `claude-native-${turns.length}` };
      yield { type: "result", subtype: "success", is_error: false, result: "claude ok", usage: {} };
    })();
  return { query, turns };
}

async function hostOn(options: (fake: ReturnType<typeof fakeAntigravity>) => Partial<MarshalHostOptions>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agy-remote-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  const fake = fakeAntigravity(root);
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    runtimeRoot: path.join(root, "runtime"),
    browser: false,
    env: fake.env,
    automations: { start: false },
    ...options(fake),
  });
  return { host, fake };
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["held", "partly", "failed"] }, evidence: { type: "string" } },
  required: ["verdict"],
};

test("a remote session on Antigravity gets its marshal tools, and a tool call runs on the session's VM runtime", async () => {
  const vm = vmRuntime();
  const { host, fake } = await hostOn((agy) => ({ provider: { id: "antigravity", home: agy.home }, remoteRuntime: () => vm, remoteHostToolsFor: () => [] }));
  try {
    const done = await host.agents.wait(host.agents.launch({ task: "what sold yesterday?", idempotencyKey: "r1", model: "gemini-4-neon" }).id, 60_000);
    assert.equal(done.state, "completed");
    assert.equal(done.agent.state, "idle", `turn failed: ${done.result}`);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(
      (open.config!.hostTools as { name: string }[]).map((tool) => tool.name).sort(),
      ["runtime_exec", "runtime_read_resource", "runtime_search"],
      "the marshal runtime tools reach Antigravity as host tools",
    );
    assert.equal(open.config!.model, "gemini-4-neon");
    assert.deepEqual(vm.calls, [{ name: "runtime_exec", args: { targetType: "operation", target: "zs.data.query", input: { sql: "select 1" } } }]);
    const call = fake.entries().find((entry) => entry.op === "host_tool")!;
    assert.equal(call.allowed, true);
    assert.equal(call.text, "vm runtime_exec zs.data.query", "the model got the VM runtime's answer");
    assert.match(done.result ?? "", /done: vm runtime_exec zs\.data\.query/);
  } finally {
    await host.dispose();
  }
});

test("SB01: a remote Antigravity session runs with no built-in tool, so nothing of the model's runs on the control host", async () => {
  const vm = vmRuntime();
  const { host, fake } = await hostOn((agy) => ({ provider: { id: "antigravity", home: agy.home }, remoteRuntime: () => vm, remoteHostToolsFor: () => [] }));
  try {
    const done = await host.agents.wait(host.agents.launch({ task: "check the pixel", idempotencyKey: "sb01", model: "gemini-4-neon" }).id, 60_000);
    assert.equal(done.agent.state, "idle", `turn failed: ${done.result}`);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(open.config!.enabledBuiltinTools, [], "an empty allowlist: none of Antigravity's built-ins");
    assert.deepEqual(open.config!.mcpServers, [], "and no MCP server");
    assert.deepEqual(fake.entries().find((entry) => entry.op === "turn")!.active, []);
    assert.equal(fake.entries().filter((entry) => entry.op === "builtin").length, 0, "the model never had run_command");
    const prompt = String(open.config!.system?.text ?? "");
    assert.ok(prompt.length > 0, "the host prompt reached the session");
    for (const name of ["run_command", "view_file", "write_to_file"]) assert.ok(!prompt.includes(name), `the prompt names no ${name}`);
  } finally {
    await host.dispose();
  }
});

test("Sanity: a local (non-remote) Antigravity session keeps Antigravity's built-ins, minus the ones Marshal owns", async () => {
  const { host, fake } = await hostOn((agy) => ({ provider: { id: "antigravity", home: agy.home } }));
  try {
    const done = await host.agents.wait(host.agents.launch({ task: "look around", idempotencyKey: "local", model: "gemini-4-neon" }).id, 60_000);
    assert.equal(done.agent.state, "idle", `turn failed: ${done.result}`);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.equal(open.config!.enabledBuiltinTools, undefined);
    assert.ok((open.config!.disabledBuiltinTools as string[]).includes("invoke_subagent"));
    assert.ok(fake.entries().find((entry) => entry.op === "turn")!.active!.includes("run_command"));
    assert.match(String(open.config!.system?.text ?? ""), /run_command/, "its prompt names the built-ins it has");
  } finally {
    await host.dispose();
  }
});

test("outputFormat reaches Antigravity as its response schema, and the parsed answer is the turn's structured output", async () => {
  const vm = vmRuntime();
  const { host, fake } = await hostOn((agy) => ({ provider: { id: "antigravity", home: agy.home }, remoteRuntime: () => vm, remoteHostToolsFor: () => [] }));
  try {
    const launched = host.agents.launch({
      task: "did yesterday's move hold?",
      idempotencyKey: "structured",
      model: "gemini-4-neon",
      options: { outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA } },
    });
    const done = await host.agents.wait(launched.id, 60_000);
    assert.equal(done.agent.state, "idle", `turn failed: ${done.result}`);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(open.config!.responseSchema, VERDICT_SCHEMA);
    assert.deepEqual(open.config!.enabledBuiltinTools, ["finish"], "only finish, which returns the answer and runs nothing");
    assert.deepEqual(done.structuredOutput, { verdict: "held", evidence: "vm runtime_exec zs.data.query" });
    assert.notEqual(host.sessions.messages(launched.id).at(-1)!.error, true, "the structured turn succeeded");
  } finally {
    await host.dispose();
  }
});

test("a turn that asked for structured output and got none fails, as on the Claude Agent SDK", async () => {
  const vm = vmRuntime();
  const { host } = await hostOn((agy) => ({ provider: { id: "antigravity", home: agy.home }, remoteRuntime: () => vm, remoteHostToolsFor: () => [] }));
  try {
    const launched = host.agents.launch({
      task: "NO_ANSWER this time",
      idempotencyKey: "no-answer",
      model: "gemini-4-neon",
      options: { outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA } },
    });
    const done = await host.agents.wait(launched.id, 60_000);
    assert.equal(done.structuredOutput, undefined);
    // An error result fails the turn (the reply is marked an error); the session itself stays usable, as on Claude.
    const last = host.sessions.messages(launched.id).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.equal(last.error, true, "the turn is recorded as failed, not as a success with no answer");
    assert.match(last.content, /without the structured output/);
  } finally {
    await host.dispose();
  }
});

test("providerFor: one host runs gemini-4-neon sessions on Antigravity and claude-sonnet-5-5 sessions on Claude", async () => {
  const vm = vmRuntime();
  const claude = recording();
  const { host, fake } = await hostOn((agy) => ({
    query: claude.query,
    providerFor: providerForModelFamily({ google: { id: "antigravity", home: agy.home } }),
    remoteRuntime: () => vm,
    remoteHostToolsFor: () => [],
  }));
  try {
    const neon = host.agents.launch({ task: "free time hunt", idempotencyKey: "neon", model: "gemini-4-neon" });
    const sonnet = host.agents.launch({ task: "answer the owner", idempotencyKey: "sonnet", model: "claude-sonnet-5-5" });
    const [neonDone, sonnetDone] = await Promise.all([host.agents.wait(neon.id, 60_000), host.agents.wait(sonnet.id, 60_000)]);
    assert.equal(neonDone.agent.state, "idle", `neon failed: ${neonDone.result}`);
    assert.equal(sonnetDone.agent.state, "idle", `sonnet failed: ${sonnetDone.result}`);
    assert.equal(sonnetDone.result, "claude ok");
    assert.equal(claude.turns.length, 1, "only the Claude session's turn ran on the Claude query");
    assert.equal(claude.turns[0]!.model, "claude-sonnet-5-5");
    const opens = fake.entries().filter((entry) => entry.op === "open");
    assert.equal(opens.length, 1, "only the Gemini session opened on Antigravity");
    assert.equal(opens[0]!.config!.model, "gemini-4-neon");
    assert.deepEqual(opens[0]!.config!.enabledBuiltinTools, []);
    assert.equal(host.sessions.get(neon.id)?.runtimeId, "antigravity");
    assert.equal(host.sessions.get(sonnet.id)?.runtimeId, "claude");
    // The Claude session keeps the marshal server (its Claude Code runs on the VM); the Gemini one used provider tools.
    assert.ok(claude.turns[0]!.mcpServers.marshal, "the Claude session gets its marshal server");
    assert.deepEqual(vm.calls.map((call) => call.name), ["runtime_exec"], "the Gemini session's tool call reached the VM");
  } finally {
    await host.dispose();
  }
});

test("providerFor: a session keeps its provider; a routing that names the host's own provider with other settings is refused", async () => {
  const claude = recording();
  let refuse = false;
  const { host, fake } = await hostOn((agy) => {
    const byFamily = providerForModelFamily({ google: { id: "antigravity", home: agy.home } });
    return { query: claude.query, providerFor: (session) => (refuse ? { id: "claude", account: "work" } : byFamily(session)) };
  });
  try {
    const neon = host.agents.launch({ task: "first turn", idempotencyKey: "keeps", model: "gemini-4-neon" });
    const first = await host.agents.wait(neon.id, 60_000);
    assert.notEqual(host.sessions.messages(neon.id).at(-1)!.error, true, `first turn failed: ${first.result}`);
    assert.equal(host.sessions.get(neon.id)?.runtimeId, "antigravity");
    // Switched to a Claude model, the Gemini session's next turn fails instead of quietly starting over on Claude.
    host.agents.setModel(neon.id, "claude-sonnet-5-5");
    host.agents.send(neon.id, "second turn");
    await host.agents.wait(neon.id, 60_000);
    const last = host.sessions.messages(neon.id).at(-1)!;
    assert.equal(last.error, true);
    assert.match(last.content, /a session keeps its provider/);
    assert.equal(claude.turns.length, 0, "no turn of the Gemini session ran on Claude");
    assert.equal(fake.entries().filter((entry) => entry.op === "turn").length, 1, "nor a second turn on Antigravity");
    refuse = true;
    assert.throws(() => host.agents.launch({ task: "x", idempotencyKey: "same", model: "claude-sonnet-5-5" }), /route only to other providers/);
  } finally {
    await host.dispose();
  }
});

test("sessionConfig: provider tools only becomes the runtime's strict allowlist with no MCP server; outputFormat its response schema", () => {
  const tool = { name: "runtime_exec", handler: async () => "ok" };
  const config = sessionConfig(
    {
      mcpServers: { marshal: { type: "sdk" }, browser: { command: "npx", args: ["@playwright/mcp"] }, [PROVIDER_TOOLS]: [tool], [PROVIDER_TOOLS_ONLY]: true },
      outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
    "/tmp",
    undefined,
  );
  assert.deepEqual(config.availableTools, ["runtime_exec"]);
  assert.equal(config.mcpServers, undefined);
  assert.deepEqual(config.responseSchema, VERDICT_SCHEMA);
  const open = sessionConfig({ mcpServers: { browser: { command: "npx" }, [PROVIDER_TOOLS]: [tool] } }, "/tmp", undefined);
  assert.equal(open.availableTools, undefined, "a local session keeps its provider's own tools");
  assert.ok(open.mcpServers?.browser);
  assert.throws(() => sessionConfig({ outputFormat: { type: "text" } }, "/tmp", undefined), /json_schema/);
});

// ---- An Antigravity bridge on the brand VM (antigravityBridgeFor): the bridge runs there, model calls go to a proxy ----

/** The control host's model proxy: records each call (path and headers) and answers with fixed text. */
async function fakeProxy() {
  const calls: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      response.writeHead(200, { "content-type": "text/plain" }).end("proxy answer");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { calls, baseUrl: `http://127.0.0.1:${port}/vertex`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * A brand VM in a test: spawnBridge starts the fake bridge as a separate process with the VM's own small environment
 * (no Google variable), as an ssh session to bridge.py would. Records each request and keeps each child.
 */
function vmBridge(
  fake: ReturnType<typeof fakeAntigravity>,
  endpoint: AntigravityProxyEndpoint,
  extra: Partial<AntigravityRemoteBridge> = {},
) {
  const requests: AntigravityBridgeSpawnRequest[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const bridge: AntigravityRemoteBridge = {
    key: "brand-a:vm-1",
    endpoint,
    workspaceDir: "/srv/zygstinct/brands/a/work",
    homeDir: "/srv/zygstinct/brands/a/antigravity",
    spawnBridge(request) {
      requests.push(request);
      const child = spawn(process.execPath, [fake.script], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_BRIDGE_LOG: fake.log, ...request.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    ...extra,
  };
  return { bridge, requests, children };
}

/** No Gemini credential on the host, and a "Python" that marks the file if a local bridge is ever started. */
function hostWithoutGoogleCredentials(fake: ReturnType<typeof fakeAntigravity>, root: string) {
  const marker = path.join(root, "local-bridge-started");
  const python = path.join(root, "local-python");
  fs.writeFileSync(python, `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  return { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MARSHAL_ANTIGRAVITY_PYTHON: python, FAKE_BRIDGE_LOG: fake.log }, marker };
}

async function vmHost(build: (fake: ReturnType<typeof fakeAntigravity>, root: string) => Partial<MarshalHostOptions>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agy-vm-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  const fake = fakeAntigravity(root);
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    runtimeRoot: path.join(root, "runtime"),
    browser: false,
    automations: { start: false },
    ...build(fake, root),
  });
  return { host, fake, root };
}

test("brand VM: the bridge runs through spawnBridge, its model calls reach the proxy with the session key, and no Google credential leaves the host", async () => {
  const proxy = await fakeProxy();
  const vm = vmRuntime();
  const claude = recording();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  let marker = "";
  const askedFor: string[] = [];
  const { host, fake } = await vmHost((agy, root) => {
    const local = hostWithoutGoogleCredentials(agy, root);
    marker = local.marker;
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: proxy.baseUrl, httpHeaders: { "x-zs-session-key": "dummy-session-key" } });
    return {
      env: local.env,
      query: claude.query,
      providerFor: providerForModelFamily({ google: { id: "antigravity", home: agy.home } }),
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: (session) => {
        askedFor.push(session.model ?? "");
        return spawned!.bridge;
      },
    };
  });
  try {
    const neon = host.agents.launch({ task: "what sold yesterday?", idempotencyKey: "vm1", model: "gemini-4-neon" });
    const sonnet = host.agents.launch({ task: "answer the owner", idempotencyKey: "vm1-claude", model: "claude-sonnet-5-5" });
    const done = await host.agents.wait(neon.id, 60_000);
    await host.agents.wait(sonnet.id, 60_000);
    assert.ok(askedFor.length > 0 && askedFor.every((model) => model === "gemini-4-neon"), `asked only for the Antigravity session: ${askedFor.join(",")}`);
    assert.equal(claude.turns[0]?.[TURN_EXTRAS]?.antigravityBridge, undefined, "the Claude session gets no bridge");
    assert.notEqual(host.sessions.messages(neon.id).at(-1)?.error, true, `turn failed: ${done.result}`);
    // Spawned once, with bridge.py itself, the pinned SDK and protocol, and an empty environment: no credential travels.
    assert.equal(spawned!.requests.length, 1);
    const request = spawned!.requests[0]!;
    assert.equal(request.sessionId.length > 0, true);
    assert.equal(request.bridgeSource, ANTIGRAVITY_BRIDGE_SOURCE);
    assert.equal(request.sdkVersion, "0.1.24");
    assert.equal(request.protocol, 1);
    assert.deepEqual(request.env, {});
    assert.ok(!fs.existsSync(marker), "no local bridge or Python ran on the control host");
    // The open config: the proxy endpoint with no key or project, the VM's own paths, no host MCP server.
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(open.config!.endpoint, { kind: "vertex", baseUrl: proxy.baseUrl, httpHeaders: { "x-zs-session-key": "dummy-session-key" } });
    assert.deepEqual(open.config!.workspaces, ["/srv/zygstinct/brands/a/work"]);
    assert.equal(open.config!.saveDir, "/srv/zygstinct/brands/a/antigravity/sessions");
    assert.equal(open.config!.appDataDir, "/srv/zygstinct/brands/a/antigravity/harness");
    assert.deepEqual(open.config!.mcpServers, []);
    // The model call went to the proxy, carrying the session key.
    assert.equal(proxy.calls.length, 1);
    assert.match(proxy.calls[0]!.url, /^\/vertex\/v1\/publishers\/google\/models\/gemini-4-neon:streamGenerateContent$/);
    assert.equal(proxy.calls[0]!.headers["x-zs-session-key"], "dummy-session-key");
    assert.equal(proxy.calls[0]!.headers.authorization, undefined, "the VM sends no credential; the proxy adds it");
    assert.match(done.result ?? "", /model: proxy answer/);
    // The marshal tools still run on the VM runtime through the remote adapter.
    assert.deepEqual(vm.calls.map((call) => call.name), ["runtime_exec"]);
  } finally {
    await host.dispose();
    await proxy.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(spawned!.children.every((child) => child.exitCode !== null || child.signalCode !== null), "the VM bridge stops with the host");
});

test("brand VM: Antigravity's built-ins run there, minus the ones Marshal owns, and the prompt names them", async () => {
  const proxy = await fakeProxy();
  const vm = vmRuntime();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  const { host, fake } = await vmHost((agy, root) => {
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: proxy.baseUrl }, { disabledBuiltinTools: ["generate_image"] });
    return {
      env: hostWithoutGoogleCredentials(agy, root).env,
      provider: { id: "antigravity", home: agy.home },
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: () => spawned!.bridge,
    };
  });
  try {
    const neon = host.agents.launch({ task: "check the files", idempotencyKey: "vm2", model: "gemini-4-neon" });
    const done = await host.agents.wait(neon.id, 60_000);
    assert.notEqual(host.sessions.messages(neon.id).at(-1)?.error, true, `turn failed: ${done.result}`);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.equal(open.config!.enabledBuiltinTools, undefined, "no allowlist: the VM's built-ins stay");
    const disabled = open.config!.disabledBuiltinTools as string[];
    for (const owned of ["ask_question", "invoke_subagent", "run_workflow", "schedule", "generate_image"]) {
      assert.ok(disabled.includes(owned), `${owned} is off`);
    }
    const active = fake.entries().find((entry) => entry.op === "turn")!.active!;
    assert.ok(active.includes("run_command") && active.includes("view_file"), "the model has its shell and files, on the VM");
    assert.deepEqual(fake.entries().filter((entry) => entry.op === "builtin").map((entry) => entry.allowed), [true]);
    assert.match(String(open.config!.system?.text ?? ""), /run_command/, "the prompt names the built-ins the session has");
  } finally {
    await host.dispose();
    await proxy.close();
  }
});

test("brand VM: a caller's exact built-in allowlist is kept, with finish added for a structured answer", async () => {
  const proxy = await fakeProxy();
  const vm = vmRuntime();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  const { host, fake } = await vmHost((agy, root) => {
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: proxy.baseUrl }, { enabledBuiltinTools: ["view_file"] });
    return {
      env: hostWithoutGoogleCredentials(agy, root).env,
      provider: { id: "antigravity", home: agy.home },
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: () => spawned!.bridge,
    };
  });
  try {
    const launched = host.agents.launch({
      task: "verdict please",
      idempotencyKey: "vm3",
      model: "gemini-4-neon",
      options: { outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA } },
    });
    const done = await host.agents.wait(launched.id, 60_000);
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(open.config!.enabledBuiltinTools, ["view_file", "finish"]);
    assert.equal(fake.entries().filter((entry) => entry.op === "builtin").length, 0, "no run_command outside the allowlist");
    assert.equal((done.structuredOutput as { verdict?: string } | undefined)?.verdict, "held");
  } finally {
    await host.dispose();
    await proxy.close();
  }
});

test("brand VM: an endpoint that carries a credential, or is not a proxy, is refused before anything is spawned", async () => {
  const vm = vmRuntime();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  let endpoint: unknown;
  const { host } = await vmHost((agy, root) => {
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: "http://127.0.0.1:1/vertex" });
    return {
      env: hostWithoutGoogleCredentials(agy, root).env,
      provider: { id: "antigravity", home: agy.home },
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: () => ({ ...spawned!.bridge, endpoint: endpoint as AntigravityProxyEndpoint }),
    };
  });
  try {
    const refused = [
      [{ kind: "proxy", api: "vertex", baseUrl: "http://127.0.0.1:1/v", apiKey: "AIza-leak" }, /carries no credentials; remove apiKey/],
      [{ kind: "vertex", project: "p", location: "global" }, /runs only on a proxy endpoint/],
      [{ kind: "proxy", api: "vertex", baseUrl: "http://user:pw@127.0.0.1:1/v" }, /no user or password/],
    ] as const;
    for (const [index, [bad, message]] of refused.entries()) {
      endpoint = bad;
      const launched = host.agents.launch({ task: "x", idempotencyKey: `bad-${index}`, model: "gemini-4-neon" });
      await host.agents.wait(launched.id, 60_000);
      const last = host.sessions.messages(launched.id).at(-1)!;
      assert.equal(last.error, true);
      assert.match(last.content, message);
    }
    assert.equal(spawned!.requests.length, 0, "nothing was spawned on the VM");
  } finally {
    await host.dispose();
  }
});

test("assertProxyEndpoint and sessionConfig: only Antigravity lifts the tools-only rule for a VM bridge", () => {
  assert.doesNotThrow(() => assertProxyEndpoint({ kind: "proxy", api: "gemini", baseUrl: "https://proxy.internal/gemini", httpHeaders: { "x-key": "k" } }));
  assert.throws(() => assertProxyEndpoint({ kind: "proxy", api: "vertex", baseUrl: "file:///etc/passwd" }), /http or https/);
  assert.throws(() => assertProxyEndpoint({ kind: "proxy", api: "vertex", baseUrl: "http://x", credentialsFile: "/k.json" }), /remove credentialsFile/);
  assert.throws(() => assertProxyEndpoint({ kind: "proxy", api: "vertex", baseUrl: "http://x", httpHeaders: { a: 1 } }), /names to strings/);
  assert.throws(() => assertProxyEndpoint({ kind: "proxy", api: "gemini", baseUrl: "http://x", project: "p" }), /no project/);
  const tool = { name: "runtime_exec", handler: async () => "ok" };
  const bridge = { key: "k", endpoint: { kind: "proxy", api: "vertex", baseUrl: "http://x" }, spawnBridge: () => undefined as never } as AntigravityRemoteBridge;
  const options = { mcpServers: { browser: { command: "npx" }, [PROVIDER_TOOLS]: [tool], [PROVIDER_TOOLS_ONLY]: true } };
  const extras = { attachments: [], antigravityBridge: bridge };
  const onVm = sessionConfig(options, "/tmp", extras, "antigravity");
  assert.equal(onVm.availableTools, undefined, "built-ins run on the VM");
  assert.equal(onVm.mcpServers, undefined, "and the host's MCP servers do not go there");
  assert.equal(onVm.antigravityRemote, bridge);
  for (const runtime of ["codex", "cursor", undefined]) {
    const other = sessionConfig(options, "/tmp", extras, runtime);
    assert.deepEqual(other.availableTools, ["runtime_exec"], `${runtime ?? "no runtime"} keeps the tools-only rule`);
    assert.equal(other.antigravityRemote, undefined);
  }
});

/** The real bridge.py with the real google-antigravity, when a prepared interpreter is on this machine; no network. */
function antigravityPython(): string | undefined {
  const candidates = [process.env.MARSHAL_ANTIGRAVITY_PYTHON, path.join(os.homedir(), ".marshal/antigravity/venv/bin/python")];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate) && spawnSync(candidate, ["-I", "-c", "import google.antigravity"]).status === 0);
}

const ENDPOINT_PROBE = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("marshal_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
from google.antigravity.connections.local import local_connection
out = {"googleEnv": sorted(k for k in os.environ if k.startswith(("GOOGLE", "GEMINI")))}
for name, endpoint in json.loads(sys.argv[2]).items():
  session = bridge.BridgeSession("s", {"endpoint": endpoint, "model": "gemini-4-neon", "conversationId": "c"})
  ep = session._endpoint()
  ep.validate_endpoint()
  proto = local_connection.build_models_proto(session._models(), env={})[0]
  which = "vertex_endpoint" if proto.HasField("vertex_endpoint") else "gemini_api_endpoint"
  wire = getattr(proto, which)
  out[name] = {
    "class": type(ep).__name__, "base_url": ep.base_url, "http_headers": ep.http_headers,
    "project": getattr(ep, "project", None), "location": getattr(ep, "location", None), "api_key": ep.api_key,
    "proto": which, "proto_base_url": wire.base_url, "proto_headers": dict(wire.http_headers),
    "proto_project": getattr(wire, "project", ""), "proto_api_key": wire.api_key,
  }
print(json.dumps(out))
`;

test("bridge.py with the real google-antigravity: a proxy endpoint becomes VertexEndpoint(base_url, http_headers) with no credential and no ambient project", (context) => {
  const python = antigravityPython();
  if (!python) {
    context.skip("no prepared google-antigravity interpreter on this machine (MARSHAL_ANTIGRAVITY_PYTHON or ~/.marshal/antigravity/venv)");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agy-endpoint-"));
  const bridgePath = path.join(root, "bridge.py");
  fs.writeFileSync(bridgePath, ANTIGRAVITY_BRIDGE_SOURCE);
  const probe = path.join(root, "probe.py");
  fs.writeFileSync(probe, ENDPOINT_PROBE);
  const headers = { "x-zs-session-key": "dummy-session-key" };
  const endpoints = {
    vertexProxy: { kind: "vertex", baseUrl: "http://127.0.0.1:41000/vertex", httpHeaders: headers },
    geminiProxy: { kind: "gemini", baseUrl: "http://127.0.0.1:41000/gemini", httpHeaders: headers },
    // Control: without a base URL the SDK does read the ambient project, so the probe can see a leak.
    vertexAmbient: { kind: "vertex" },
  };
  // No Google credential anywhere (temp HOME: no gcloud ADC); an ambient project and location the proxy must NOT pick up.
  const run = spawnSync(python, ["-I", probe, bridgePath, JSON.stringify(endpoints)], {
    env: { PATH: "/usr/bin:/bin", HOME: root, GOOGLE_CLOUD_PROJECT: "ambient-project", GOOGLE_CLOUD_LOCATION: "ambient-location" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(out.googleEnv, ["GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT"], "only the ambient decoys, no key or credentials file");
  assert.deepEqual(out.vertexProxy, {
    class: "VertexEndpoint", base_url: "http://127.0.0.1:41000/vertex", http_headers: headers,
    project: null, location: null, api_key: null,
    proto: "vertex_endpoint", proto_base_url: "http://127.0.0.1:41000/vertex", proto_headers: headers, proto_project: "", proto_api_key: "",
  });
  assert.equal(out.geminiProxy.class, "GeminiAPIEndpoint");
  assert.equal(out.geminiProxy.proto_base_url, "http://127.0.0.1:41000/gemini");
  assert.deepEqual(out.geminiProxy.proto_headers, headers);
  assert.equal(out.geminiProxy.proto_api_key, "");
  assert.equal(out.vertexAmbient.project, "ambient-project", "control: without base_url the ambient project is read");
});

/** Runs the real bridge.py (real google-antigravity and its harness) against a local fake proxy; no Google call. */
async function realBridgeTurn(python: string, endpoint: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agy-harness-"));
  const bridgePath = path.join(root, "bridge.py");
  fs.writeFileSync(bridgePath, ANTIGRAVITY_BRIDGE_SOURCE);
  const proxy = await fakeProxy();
  // Temp HOME and no Google variable: no ADC, key or project exists for the harness to fall back on.
  const child = spawn(python, ["-I", bridgePath], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: ["pipe", "pipe", "pipe"] });
  const events: Record<string, any>[] = [];
  let pending = "";
  child.stdout.on("data", (data: Buffer) => {
    pending += data.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const event = JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
      events.push(event);
      if (event.ev === "request") child.stdin.write(`${JSON.stringify({ op: "reply", id: event.id, result: { allow: false, message: "no tools here" } })}\n`);
    }
  });
  const until = async (done: () => boolean, ms: number) => {
    for (const start = Date.now(); !done() && Date.now() - start < ms; ) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  try {
    await until(() => events.some((event) => event.ev === "ready"), 30_000);
    const config = {
      conversationId: "0".repeat(24) + "1234abcd",
      model: "gemini-4-neon",
      workspaces: [root],
      saveDir: path.join(root, "sessions"),
      appDataDir: path.join(root, "harness"),
      endpoint: { ...endpoint, baseUrl: proxy.baseUrl },
      enabledBuiltinTools: [],
    };
    child.stdin.write(`${JSON.stringify({ op: "open", session: "s", config })}\n`);
    await until(() => events.some((event) => event.ev === "opened" || event.ev === "open_failed"), 30_000);
    child.stdin.write(`${JSON.stringify({ op: "send", session: "s", turn: "t", prompt: "hello", media: [] })}\n`);
    await until(() => events.some((event) => event.ev === "turn_end" || event.ev === "turn_error"), 45_000);
    return { events, calls: proxy.calls };
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    await proxy.close();
  }
}

test("real bridge.py and Antigravity harness: the model call goes to the proxy with the session header and no credential", async (context) => {
  const python = antigravityPython();
  if (!python) {
    context.skip("no prepared google-antigravity interpreter on this machine (MARSHAL_ANTIGRAVITY_PYTHON or ~/.marshal/antigravity/venv)");
    return;
  }
  const headers = { "x-zs-session-key": "dummy-session-key" };
  const plain = await realBridgeTurn(python, { kind: "vertex", httpHeaders: headers });
  assert.ok(plain.events.some((event) => event.ev === "opened"), JSON.stringify(plain.events));
  assert.equal(plain.calls.length, 1, "one model call, to the proxy");
  const call = plain.calls[0]!;
  assert.equal(call.method, "POST");
  // The fake proxy is at <port>/vertex; the harness appends Vertex's publisher path (no project: the proxy adds it).
  assert.equal(call.url, "/vertex/v1beta1/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse");
  assert.equal(call.headers["x-zs-session-key"], "dummy-session-key");
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers["x-goog-api-key"], undefined);
  assert.match(call.body, /hello/);
  // The proxy answered "proxy answer" (not Vertex's stream format): the turn fails, it does not hang or fall back.
  assert.ok(plain.events.some((event) => event.ev === "turn_error" || event.ev === "turn_end"));
  const located = await realBridgeTurn(python, { kind: "vertex", httpHeaders: headers, project: "proxy-project", location: "global" });
  assert.equal(located.calls.length, 1);
  assert.match(located.calls[0]!.url, /^\/vertex\/v1beta1\/projects\/proxy-project\/locations\/global\/publishers\/google\/models\/gemini-4-neon:streamGenerateContent/);
});

test("brand VM: a session moved to another machine re-opens on a new bridge and the old bridge stops", async () => {
  const proxy = await fakeProxy();
  const vm = vmRuntime();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  let key = "brand-a:vm-1";
  const { host, fake } = await vmHost((agy, root) => {
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: proxy.baseUrl });
    return {
      env: hostWithoutGoogleCredentials(agy, root).env,
      provider: { id: "antigravity", home: agy.home },
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: () => ({ ...spawned!.bridge, key }),
    };
  });
  try {
    const neon = host.agents.launch({ task: "first", idempotencyKey: "move", model: "gemini-4-neon" });
    await host.agents.wait(neon.id, 60_000);
    host.agents.send(neon.id, "second, same machine");
    await host.agents.wait(neon.id, 60_000);
    assert.equal(spawned!.requests.length, 1, "the same machine keeps its bridge across turns");
    key = "brand-a:vm-2";
    host.agents.send(neon.id, "third, after the move");
    await host.agents.wait(neon.id, 60_000);
    assert.notEqual(host.sessions.messages(neon.id).at(-1)?.error, true);
    assert.equal(spawned!.requests.length, 2, "the new machine got a bridge of its own");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [first, second] = spawned!.children;
    assert.ok(first!.exitCode !== null || first!.signalCode !== null, "the old machine's bridge stopped");
    assert.equal(second!.exitCode, null, "the new one runs");
    assert.equal(fake.entries().filter((entry) => entry.op === "turn").length, 3);
  } finally {
    await host.dispose();
    await proxy.close();
  }
});

test("AntigravityRuntimeClient: a remote bridge's session gets no host MCP server even when one is configured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agy-client-"));
  const fake = fakeAntigravity(root);
  const spawned = vmBridge(fake, { kind: "proxy", api: "vertex", baseUrl: "http://127.0.0.1:1/vertex" });
  const client = new AntigravityRuntimeClient({ workspaceDir: root, homeDir: fake.home, env: {}, environment: async () => { throw new Error("no local environment"); } });
  try {
    const session = await client.createSession({
      workingDirectory: root,
      mcpServers: { browser: { command: "npx", args: ["@playwright/mcp"] }, remote: { url: "http://127.0.0.1:9/mcp" } } as never,
      antigravityRemote: spawned.bridge,
    });
    const open = fake.entries().find((entry) => entry.op === "open")!;
    assert.deepEqual(open.config!.mcpServers, [], "this host's MCP commands and URLs never go to the VM");
    assert.equal(spawned.requests.length, 1);
    await session.disconnect();
  } finally {
    await client.stop();
  }
});

test("B1 brand VM: a bridge that dies between turns (ssh drop, VM reboot, kill) is replaced on the next turn, which resumes the conversation", async () => {
  const proxy = await fakeProxy();
  const vm = vmRuntime();
  let spawned: ReturnType<typeof vmBridge> | undefined;
  const { host, fake } = await vmHost((agy, root) => {
    spawned = vmBridge(agy, { kind: "proxy", api: "vertex", baseUrl: proxy.baseUrl });
    return {
      env: hostWithoutGoogleCredentials(agy, root).env,
      provider: { id: "antigravity", home: agy.home },
      remoteRuntime: () => vm,
      remoteHostToolsFor: () => [],
      antigravityBridgeFor: () => spawned!.bridge,
    };
  });
  const lastIsOk = (id: string) => {
    const last = host.sessions.messages(id).at(-1)!;
    assert.equal(last.role, "assistant");
    assert.notEqual(last.error, true, `turn failed: ${last.content}`);
    return last.content;
  };
  try {
    const neon = host.agents.launch({ task: "first", idempotencyKey: "b1", model: "gemini-4-neon" });
    await host.agents.wait(neon.id, 60_000);
    lastIsOk(neon.id);
    // The VM's bridge dies while the session is idle.
    const first = spawned!.children[0]!;
    const gone = new Promise((resolve) => first.once("exit", resolve));
    first.kill("SIGKILL");
    await gone;
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.agents.send(neon.id, "second, after the bridge died");
    await host.agents.wait(neon.id, 60_000);
    assert.match(lastIsOk(neon.id), /model: proxy answer/, "the next turn ran, on a new bridge");
    assert.equal(spawned!.requests.length, 2, "one new bridge");
    const opens = fake.entries().filter((entry) => entry.op === "open");
    assert.equal(opens.length, 2);
    assert.equal(opens[1]!.config!.resume, true, "the new bridge resumes the session");
    assert.equal(opens[1]!.config!.conversationId, opens[0]!.config!.conversationId, "the same conversation");
    host.agents.send(neon.id, "third");
    await host.agents.wait(neon.id, 60_000);
    lastIsOk(neon.id);
    assert.equal(spawned!.requests.length, 2, "and keeps it for later turns");
  } finally {
    await host.dispose();
    await proxy.close();
  }
});

test("N1: a turn asking for structured output on a runtime that cannot give it is refused before any model or client runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-engine-n1-"));
  let clients = 0;
  const query = createEngineQuery({
    runtime: "codex",
    factory: async () => {
      clients += 1;
      throw new Error("no client should be made");
    },
    appDataDir: root,
  });
  try {
    const turn = query({
      prompt: "x",
      options: { cwd: root, outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA }, [TURN_EXTRAS]: { sessionId: "n1", attachments: [] } },
    });
    await assert.rejects(async () => {
      for await (const _event of turn) void _event;
    }, /not supported on codex/);
    assert.equal(clients, 0);
  } finally {
    await query.dispose();
  }
});

test("N2: a proxy endpoint carries no credential header and no query string", () => {
  const base = { kind: "proxy", api: "vertex", baseUrl: "http://127.0.0.1:1/vertex" };
  for (const name of ["Authorization", "proxy-authorization", "X-Goog-Api-Key", "cookie"]) {
    assert.throws(() => assertProxyEndpoint({ ...base, httpHeaders: { [name]: "secret" } }), /carry no credential/, name);
  }
  assert.throws(() => assertProxyEndpoint({ ...base, baseUrl: "http://127.0.0.1:1/vertex?key=AIza" }), /no query string/);
  assert.doesNotThrow(() => assertProxyEndpoint({ ...base, httpHeaders: { "x-zs-session-key": "dummy" } }));
});

test("N3: stopping a bridge whose process ignores SIGTERM ends in SIGKILL, and one that never reports exit does not hang", async () => {
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => {}); process.stdout.write(JSON.stringify({ ev: 'ready', protocol: 1 }) + '\\n'); setInterval(() => {}, 1000);"], { stdio: ["pipe", "pipe", "pipe"] });
  const killed = new Promise<NodeJS.Signals | null>((resolve) => stubborn.once("exit", (_code, signal) => resolve(signal)));
  await new Promise((resolve) => stubborn.stdout.once("data", resolve));
  const started = Date.now();
  await new AntigravityBridge({ child: stubborn, stopGraceMs: 150 }).stop();
  assert.equal(await killed, "SIGKILL");
  assert.ok(Date.now() - started < 2_000);
  // A child wrapper that never emits exit and whose kill does nothing (a remote channel): stop gives up after 3x grace.
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const silent = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null,
    killed: false,
    kill: () => false,
  });
  const begun = Date.now();
  await new AntigravityBridge({ child: silent as never, stopGraceMs: 100 }).stop();
  assert.ok(Date.now() - begun < 1_500, "stop returned instead of hanging");
});
