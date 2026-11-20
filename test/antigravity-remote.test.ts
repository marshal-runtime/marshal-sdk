import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost, type MarshalHostOptions } from "../src/host.js";
import { PROVIDER_TOOLS, PROVIDER_TOOLS_ONLY, sessionConfig } from "../src/provider-query.js";
import { providerForModelFamily } from "../src/provider-selection.js";
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
    record({ op: "open", session: command.session, config: command.config });
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
