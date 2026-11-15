import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Usage, type Model, type ModelProvider, type ModelRequest, type ModelResponse } from "@openai/agents";

import { ClaudeAgentPort } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { createOpenAIAgentsQuery } from "../src/openai-agents-query.js";
import { PROVIDER_TOOLS } from "../src/provider-query.js";
import { resolveProvider } from "../src/provider-selection.js";
import { FileSessionStore } from "../src/session-store.js";

type Step = (request: ModelRequest, call: number) => ModelResponse["output"] | Error;

/** An Agents SDK model double: each call answers with the next scripted output; no network. */
function fakeOpenAI(steps: Step[]) {
  const requests: ModelRequest[] = [];
  let call = 0;
  const model: Model = {
    async getResponse(request) {
      requests.push(request);
      const step = steps[Math.min(call, steps.length - 1)]!;
      const output = step(request, call);
      call += 1;
      if (output instanceof Error) throw output;
      return {
        output,
        responseId: `resp_${call}`,
        usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokensDetails: { cached_tokens: 4 } }),
      };
    },
    getStreamedResponse() {
      throw new Error("not streamed");
    },
  };
  const provider: ModelProvider = { getModel: () => model };
  return { provider, requests };
}

const say = (text: string): Step => () => [
  { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } as never,
];

function portOn(query: ReturnType<typeof createOpenAIAgentsQuery>, servers: () => Record<string | symbol, unknown> = () => ({})) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-openai-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  const port = new ClaudeAgentPort({
    query,
    store,
    cwd: root,
    env: {},
    defaultModel: "",
    systemPrompt: () => "You are a Marshal agent.",
    mcpServers: servers as () => Record<string, unknown>,
  });
  return { port, store, root };
}

test("an OpenAI session: Marshal's prompt, the answer and usage, and the next message continues from the last response", async () => {
  const openai = fakeOpenAI([(request) => say(`echo: ${JSON.stringify(request.input)}`)(request, 0) as never]);
  const { port, store } = portOn(createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider, localTools: false }));
  const agent = port.launch({ task: "hi", idempotencyKey: "o1" });
  const waited = await port.wait(agent.id);
  assert.match(waited.result ?? "", /^echo: .*hi/);
  assert.equal(openai.requests[0]!.systemInstructions, "You are a Marshal agent.");
  const record = store.get(agent.id)!;
  assert.equal(record.native.sessionId, "resp_1");
  assert.equal(record.usage.inputTokens, 10);
  assert.equal(record.usage.outputTokens, 5);
  assert.equal(record.usage.cacheReadTokens, 4);

  port.send(agent.id, "again");
  await port.wait(agent.id);
  assert.equal(openai.requests[1]!.previousResponseId, "resp_1");
  assert.equal(store.get(agent.id)!.native.sessionId, "resp_2");
});

test("tools: a marshal runtime tool, the Agents SDK shell, and apply_patch all run on this host", async () => {
  const seen: unknown[] = [];
  const runtimeTool = {
    name: "runtime_search",
    description: "Search the runtime",
    parameters: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
    handler: async (args: unknown) => {
      seen.push(args);
      return "found: marshal.agent.launch";
    },
  };
  const openai = fakeOpenAI([
    () => [{ type: "function_call", callId: "c1", name: "runtime_search", arguments: JSON.stringify({ query: "agents" }), status: "completed" } as never],
    () => [{ type: "shell_call", callId: "c2", status: "completed", action: { commands: ["printf hello > from-shell.txt && echo done"] } } as never],
    () => [{ type: "apply_patch_call", callId: "c3", status: "completed", operation: { type: "create_file", path: "notes/plan.md", diff: "+# Plan\n+step one\n" } } as never],
    say("all done"),
  ]);
  const { port, root } = portOn(createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider }), () => ({
    marshal: { type: "sdk", name: "marshal", instance: {} },
    [PROVIDER_TOOLS]: [runtimeTool],
  }));
  const agent = port.launch({ task: "work", idempotencyKey: "o2" });
  assert.equal((await port.wait(agent.id)).result, "all done");
  assert.deepEqual(seen, [{ query: "agents" }]);
  assert.equal(fs.readFileSync(path.join(root, "from-shell.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(root, "notes", "plan.md"), "utf8"), "# Plan\nstep one");
  const toolNames = openai.requests[0]!.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["apply_patch", "runtime_search", "shell"]);
  const echoed = JSON.stringify(openai.requests.slice(1).map((request) => request.input));
  assert.match(echoed, /found: marshal\.agent\.launch/);
  assert.match(echoed, /done/);
});

test("structured output: the launch's JSON schema is the agent's output type", async () => {
  const openai = fakeOpenAI([say(JSON.stringify({ verdict: "ship", score: 9 }))]);
  const { port } = portOn(createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider, localTools: false }));
  const agent = port.launch({
    task: "judge",
    idempotencyKey: "o3",
    options: { outputFormat: { type: "json_schema", schema: { type: "object", properties: { verdict: { type: "string" }, score: { type: "number" } } } } },
  });
  const waited = await port.wait(agent.id);
  assert.deepEqual(waited.structuredOutput, { verdict: "ship", score: 9 });
});

test("a fork continues from the parent's last response; forking at an earlier message needs Claude", async () => {
  const openai = fakeOpenAI([say("ok")]);
  const query = createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider, localTools: false });
  const events: Record<string, any>[] = [];
  for await (const event of query({ prompt: "branch", options: { resume: "resp_parent", forkSession: true } })) events.push(event);
  assert.equal(openai.requests[0]!.previousResponseId, "resp_parent");
  assert.equal(events.find((event) => event.type === "system")?.session_id, "resp_1");
  await assert.rejects(async () => {
    for await (const _ of query({ prompt: "x", options: { resume: "resp_parent", forkSession: true, resumeSessionAt: "uuid" } })) void _;
  }, /needs the Claude provider/);
});

test("an API error ends the turn with an error answer that carries the message", async () => {
  const openai = fakeOpenAI([() => new Error("429 rate limited")]);
  const { port } = portOn(createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider, localTools: false }));
  const agent = port.launch({ task: "x", idempotencyKey: "o4" });
  assert.match((await port.wait(agent.id)).result ?? "", /429 rate limited/);
  const last = port.transcript(agent.id, 1).messages.at(-1) as { error?: boolean };
  assert.equal(last.error, true);
});

test("the openai provider: the key from OPENAI_API_KEY, a named variable or its _FILE; never an account", () => {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-openai-sel-"));
  const keys: string[] = [];
  const factories = { openai: ({ apiKey }: { apiKey: string }) => (keys.push(apiKey), fakeOpenAI([say("x")]).provider) };
  const base = { privateRoot, factories };
  const fromDefault = resolveProvider({ id: "openai" }, { ...base, env: { OPENAI_API_KEY: "sk-default" } });
  assert.equal(fromDefault.credential, "api-key");
  assert.equal(fromDefault.defaultModel, "");
  assert.ok(fromDefault.query);
  assert.equal(fromDefault.description, "provider openai (Agents SDK): API key from OPENAI_API_KEY");
  const keyFile = path.join(privateRoot, "key");
  fs.writeFileSync(keyFile, "sk-file\n");
  resolveProvider({ id: "openai", apiKeyEnv: "TEAM_OPENAI" }, { ...base, env: { TEAM_OPENAI_FILE: keyFile } });
  assert.deepEqual(keys, ["sk-default", "sk-file"]);
  assert.throws(() => resolveProvider({ id: "openai" }, { ...base, env: {} }), /No openai API key: set OPENAI_API_KEY/);
  assert.throws(() => resolveProvider({ id: "openai", account: "work" }, { ...base, env: { OPENAI_API_KEY: "k" } }), /API key/);
});

test("a host on OpenAI: the model calls the host's runtime through runtime_search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-openai-host-"));
  fs.mkdirSync(path.join(dir, "ws"));
  const openai = fakeOpenAI([
    () => [{ type: "function_call", callId: "c1", name: "runtime_search", arguments: JSON.stringify({ query: "launch an agent session" }), status: "completed" } as never],
    say("searched"),
  ]);
  const host = await createMarshalHost({
    workspacePath: path.join(dir, "ws"),
    stateRoot: path.join(dir, "state"),
    query: createOpenAIAgentsQuery({ apiKey: "sk-test", modelProvider: openai.provider, localTools: false }),
    browser: false,
    env: {},
    ...({ automations: { start: false } } as object),
  });
  try {
    const agent = host.agents.launch({ task: "look around", idempotencyKey: "h1" });
    assert.equal((await host.agents.wait(agent.id)).result, "searched");
    assert.match(JSON.stringify(openai.requests[1]!.input), /marshal\.agent/);
  } finally {
    await host.dispose();
  }
});
