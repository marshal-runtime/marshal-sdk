import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort, mergeLaunchOptions, type AgentPortOptions, type QueryFn } from "../src/agent-port.js";
import { FileSessionStore } from "../src/session-store.js";

function rig(extra: Partial<AgentPortOptions> = {}, events: Record<string, unknown>[] = []) {
  const calls: Record<string, any>[] = [];
  let count = 0;
  const query: QueryFn = ({ options }) => {
    calls.push(options);
    return (async function* () {
      const sessionId = (options.resume as string | undefined) ?? (options.sessionId as string | undefined) ?? `native-${++count}`;
      yield { type: "system", subtype: "init", session_id: sessionId };
      for (const event of events) yield event;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, usage: {}, total_cost_usd: 0.25 };
    })();
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-passthrough-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run", host: { id: "h", kind: "local" } });
  const port = new ClaudeAgentPort({
    query,
    store,
    cwd: root,
    env: { PATH: "/bin" },
    defaultModel: "m",
    systemPrompt: () => "host prompt",
    mcpServers: () => ({}),
    ...extra,
  });
  return { port, store, calls, root };
}

test("Claude session options of a launch reach every turn as the SDK's own", async () => {
  const { port, calls } = rig();
  const agents = { reviewer: { description: "reviews", prompt: "review it", tools: ["Read"] } };
  const plugins = [{ type: "local" as const, path: "/plugins/zyg" }];
  const agent = port.launch({
    task: "one",
    idempotencyKey: "k",
    options: {
      tools: ["Read", "Grep"],
      agents,
      plugins,
      claudeSkills: ["zyg-agents:review"],
      settings: { autoMemoryEnabled: false },
      settingSources: ["project"],
      additionalDirectories: ["/extra"],
      thinking: { type: "adaptive" },
      includePartialMessages: false,
    },
  });
  await port.wait(agent.id);
  port.send(agent.id, "two");
  await port.wait(agent.id);
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.deepEqual(options.tools, ["Read", "Grep"]);
    assert.deepEqual(options.agents, agents);
    assert.deepEqual(options.plugins, plugins);
    assert.deepEqual(options.skills, ["zyg-agents:review"]);
    assert.deepEqual(options.settings, { autoMemoryEnabled: false });
    assert.deepEqual(options.settingSources, ["project"]);
    assert.deepEqual(options.additionalDirectories, ["/extra"]);
    assert.deepEqual(options.thinking, { type: "adaptive" });
    assert.equal(options.includePartialMessages, false);
  }
});

test("dontAsk keeps the allow-list and never falls back to bypassPermissions", async () => {
  const { port, calls } = rig();
  const agent = port.launch({ task: "t", idempotencyKey: "k", options: { permissionMode: "dontAsk", allowedTools: ["Read", "Bash(git status)"] } });
  await port.wait(agent.id);
  assert.equal(calls[0]!.permissionMode, "dontAsk");
  assert.deepEqual(calls[0]!.allowedTools, ["Read", "Bash(git status)"]);
  assert.equal(calls[0]!.allowDangerouslySkipPermissions, undefined);
  assert.equal(calls[0]!.canUseTool, undefined);
});

test("dontAsk with a host permission handler keeps the handler", async () => {
  const { port, calls } = rig({ permissionHandler: async () => ({ kind: "approve-once" }) as never });
  const agent = port.launch({ task: "t", idempotencyKey: "k", options: { permissionMode: "dontAsk" } });
  await port.wait(agent.id);
  assert.equal(calls[0]!.permissionMode, "dontAsk");
  assert.equal(typeof calls[0]!.canUseTool, "function");
});

test("a host's dontAsk is not lifted by a launch that leaves it out", async () => {
  const { port, calls } = rig({ launchOptionsFor: () => ({ permissionMode: "dontAsk" }) });
  const agent = port.launch({ task: "t", idempotencyKey: "k", options: { permissionMode: undefined, maxTurns: 3 } });
  await port.wait(agent.id);
  assert.equal(calls[0]!.permissionMode, "dontAsk");
  assert.equal(mergeLaunchOptions({ permissionMode: "dontAsk" }, { permissionMode: undefined }).permissionMode, "dontAsk");
});

test("without launch options a turn keeps the host's defaults", async () => {
  const { port, calls } = rig({ tools: ["Read"] });
  const agent = port.launch({ task: "t", idempotencyKey: "k" });
  await port.wait(agent.id);
  const options = calls[0]!;
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.includePartialMessages, true);
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.tools, ["Read"]);
  assert.equal(options.systemPrompt, "host prompt");
  for (const key of ["agents", "plugins", "skills", "settings", "additionalDirectories", "thinking", "sessionId"]) {
    assert.equal(key in options, false, key);
  }
});

test("an agent profile's native tools narrow the launch's tools", async () => {
  const { port, calls } = rig({ tools: ["Read", "Bash", "Grep"] });
  const agent = port.launch({ task: "t", idempotencyKey: "k", nativeTools: ["Read", "Grep"], options: { tools: ["Read", "Bash"] } });
  await port.wait(agent.id);
  assert.deepEqual(calls[0]!.tools, ["Read"]);
});

test("the preset prompt with append replaces the host's prompt; a launch's own prompt still wins", async () => {
  const { port, calls } = rig({ nativeTools: { disabled: ["WebSearch"], subagentAllowlist: [] } });
  const preset = port.launch({ task: "t", idempotencyKey: "a", options: { systemPromptPreset: { append: "role text" } } });
  await port.wait(preset.id);
  assert.deepEqual(calls[0]!.systemPrompt, { type: "preset", preset: "claude_code", append: "role text" });
  assert.equal(calls[0]!.disallowedTools, undefined, "the host's native surface is for its own prompt only");
  const bare = port.launch({ task: "t", idempotencyKey: "b", options: { systemPromptPreset: {} } });
  await port.wait(bare.id);
  assert.deepEqual(calls[1]!.systemPrompt, { type: "preset", preset: "claude_code" });
  const own = port.launch({ task: "t", idempotencyKey: "c", systemPrompt: "own", options: { systemPromptPreset: { append: "x" } } });
  await port.wait(own.id);
  assert.deepEqual(calls[2]!.systemPrompt, { type: "custom", prompt: "own", snapshot: false });
});

test("a preset native session id starts the session, and later turns resume it", async () => {
  const { port, calls, store } = rig();
  const agent = port.launch({ task: "one", idempotencyKey: "k", native: { newSessionId: "fixed-id" } });
  await port.wait(agent.id);
  port.send(agent.id, "two");
  await port.wait(agent.id);
  assert.equal(calls[0]!.sessionId, "fixed-id");
  assert.equal(calls[0]!.resume, undefined);
  assert.equal(calls[1]!.sessionId, undefined);
  assert.equal(calls[1]!.resume, "fixed-id");
  assert.equal(store.get(agent.id)!.native.sessionId, "fixed-id");
});

test("a preset native id is ignored when the session resumes or forks", async () => {
  const { port, calls } = rig();
  const resumed = port.launch({ task: "t", idempotencyKey: "a", native: { sessionId: "old", newSessionId: "new" } });
  await port.wait(resumed.id);
  assert.equal(calls[0]!.resume, "old");
  assert.equal(calls[0]!.sessionId, undefined);
  const forked = port.launch({ task: "t", idempotencyKey: "b", native: { forkOf: "parent", newSessionId: "new" } });
  await port.wait(forked.id);
  assert.equal(calls[1]!.forkSession, true);
  assert.equal(calls[1]!.sessionId, undefined);
});

test("onEvent gets every backend event unslimmed, stream events included", async () => {
  const long = "x".repeat(50_000);
  const delta = { type: "stream_event", event: { type: "content_block_delta", delta: { text: "hi" } } };
  const assistant = { type: "assistant", message: { content: [{ type: "text", text: long }] }, parent_tool_use_id: null };
  const { port } = rig({}, [delta, assistant]);
  const seen: Record<string, any>[] = [];
  const agent = port.launch({ task: "t", idempotencyKey: "k", options: { onEvent: (event) => seen.push(event) } });
  await port.wait(agent.id);
  assert.deepEqual(seen.map((event) => event.type), ["system", "stream_event", "assistant", "result"]);
  assert.equal(seen[1], delta);
  assert.equal(seen[2]!.message.content[0].text.length, 50_000);
  assert.equal(seen[3]!.total_cost_usd, 0.25);
});

test("a throwing onEvent is logged and the turn still finishes", async () => {
  const logs: string[] = [];
  const { port } = rig({ log: (line) => logs.push(line) });
  const agent = port.launch({
    task: "t",
    idempotencyKey: "k",
    options: {
      onEvent: () => {
        throw new Error("listener broke");
      },
    },
  });
  const done = await port.wait(agent.id);
  assert.equal(done.result, "ok");
  assert.ok(logs.some((line) => line.includes("onEvent failed: listener broke")));
});

test("the host's and the launch's onEvent both run, the host's first", async () => {
  const order: string[] = [];
  const { port } = rig({ launchOptionsFor: () => ({ onEvent: (event) => order.push(`host:${event.type}`) }) });
  const agent = port.launch({ task: "t", idempotencyKey: "k", options: { onEvent: (event) => order.push(`own:${event.type}`) } });
  await port.wait(agent.id);
  assert.deepEqual(order.slice(0, 2), ["host:system", "own:system"]);
  assert.equal(order.length, 4);
});

