import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { FileSessionStore } from "../src/session-store.js";

function rig(result: Record<string, unknown> = {}) {
  const calls: Record<string, any>[] = [];
  let count = 0;
  const query: QueryFn = ({ options }) => {
    calls.push(options);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) && !options.forkSession ? options.resume : `native-${++count}` };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 3, usage: {}, ...result };
    })();
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-options-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run", host: { id: "h", kind: "local" } });
  const port = new ClaudeAgentPort({
    query,
    store,
    cwd: root,
    env: { CLAUDE_CONFIG_DIR: "/accounts/host", ANTHROPIC_API_KEY: "host-key", PATH: "/bin" },
    defaultModel: "m",
    systemPrompt: () => "host prompt",
    mcpServers: () => ({ marshal: { type: "sdk", name: "marshal" } }),
  });
  return { port, store, calls, root };
}

test("launch options reach every turn of the session as the SDK's own options", async () => {
  const { port, store, calls, root } = rig();
  const hook = async () => ({ continue: true });
  const spawner = () => ({});
  const workdir = path.join(root, "chat-42");
  const agent = port.launch({
    task: "one",
    idempotencyKey: "k",
    options: {
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      strictMcpConfig: true,
      allowedTools: ["Read"],
      disallowedTools: ["Bash", "WebFetch"],
      cwd: workdir,
      env: { ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CONFIG_DIR: "/accounts/chat-42" },
      pathToClaudeCodeExecutable: "/opt/claude/2.1.0/claude",
      disableSlashCommands: true,
      extraArgs: { "debug-to-stderr": null },
      hooks: { PreToolUse: [{ hooks: [hook] }] },
      outputFormat: { type: "json_schema", schema: { type: "object" } },
      spawnClaudeCodeProcess: spawner,
      mcpServers: { brand: { type: "stdio", command: "brand-mcp" } },
    },
  });
  await port.wait(agent.id);
  port.send(agent.id, "two");
  await port.wait(agent.id);
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.maxTurns, 8);
    assert.equal(options.maxBudgetUsd, 0.5);
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.allowedTools, ["Read"]);
    assert.deepEqual(options.disallowedTools, ["Bash", "WebFetch"]);
    assert.equal(options.cwd, workdir);
    assert.deepEqual(options.env, { CLAUDE_CONFIG_DIR: "/accounts/chat-42", PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" });
    assert.equal(options.pathToClaudeCodeExecutable, "/opt/claude/2.1.0/claude");
    assert.deepEqual(options.extraArgs, { "debug-to-stderr": null, "disable-slash-commands": null });
    assert.equal(options.hooks.PreToolUse[0].hooks[0], hook);
    assert.deepEqual(options.outputFormat, { type: "json_schema", schema: { type: "object" } });
    assert.equal(options.spawnClaudeCodeProcess, spawner);
    assert.deepEqual(Object.keys(options.mcpServers), ["marshal", "brand"]);
  }
  assert.equal(calls[1]!.resume, "native-1");
  const record = store.get(agent.id)!;
  assert.equal(record.native.cwd, workdir, "native history is filed under the launch's folder");
  assert.equal(record.native.configDir, "/accounts/chat-42");
  assert.equal(record.usage.turns, 2);
  assert.equal(record.usage.modelTurns, 6, "the SDK's num_turns, summed");
  assert.equal(port.get(agent.id)!.usage.modelTurns, 6);
});

test("a launch without options sends exactly what it sent before; hostMcpServers false leaves only the launch's servers", async () => {
  const { port, calls } = rig();
  const plain = port.launch({ task: "x", idempotencyKey: "plain" });
  await port.wait(plain.id);
  for (const key of ["maxTurns", "maxBudgetUsd", "strictMcpConfig", "allowedTools", "disallowedTools", "pathToClaudeCodeExecutable", "extraArgs", "hooks", "outputFormat", "spawnClaudeCodeProcess", "resumeSessionAt", "forkSession"]) {
    assert.equal(key in calls[0]!, false, key);
  }
  assert.equal(calls[0]!.env.ANTHROPIC_API_KEY, "host-key");
  const own = port.launch({ task: "y", idempotencyKey: "own", options: { hostMcpServers: false, mcpServers: { only: { type: "stdio", command: "x" } } } });
  await port.wait(own.id);
  assert.deepEqual(Object.keys(calls[1]!.mcpServers), ["only"]);
});

test("a fork point: the first turn resumes the source at a message and forks; later turns resume the fork", async () => {
  const { port, calls } = rig();
  const fork = port.launch({ task: "branch here", idempotencyKey: "f", native: { forkOf: "source-native", forkAt: "uuid-of-message-12" } });
  await port.wait(fork.id);
  assert.equal(calls[0]!.resume, "source-native");
  assert.equal(calls[0]!.forkSession, true);
  assert.equal(calls[0]!.resumeSessionAt, "uuid-of-message-12");
  port.send(fork.id, "next");
  await port.wait(fork.id);
  assert.equal(calls[1]!.resume, "native-1");
  assert.equal("resumeSessionAt" in calls[1]!, false);
  assert.equal("forkSession" in calls[1]!, false);
});

test("structured output comes back from wait", async () => {
  const { port } = rig({ structured_output: { verdict: "pass", score: 4 } });
  const agent = port.launch({ task: "judge", idempotencyKey: "s", options: { outputFormat: { type: "json_schema", schema: { type: "object" } } } });
  const waited = await port.wait(agent.id);
  assert.deepEqual(waited.structuredOutput, { verdict: "pass", score: 4 });
});
