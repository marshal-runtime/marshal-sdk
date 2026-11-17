import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost, type MarshalHostOptions, type MarshalToolCall } from "../src/host.js";
import { desktopDirectTools, type DirectTool } from "../src/host-options.js";
import { normalizeKit } from "../src/kit/index.js";
import { PROVIDER_TOOLS } from "../src/provider-selection.js";
import { isRuntimeConnection, RemoteRuntimeClients, type RemoteRuntimeConnection, type RemoteToolResult } from "../src/remote-tools.js";

type Seen = { name: string; args: Record<string, unknown> };

/** An embedder-owned session runtime that records each call and counts the closes nobody may make. */
function ownedRuntime(): RemoteRuntimeConnection & { calls: Seen[]; reads: string[]; closes: number; close(): void } {
  const runtime = {
    calls: [] as Seen[],
    reads: [] as string[],
    closes: 0,
    close() {
      runtime.closes += 1;
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<RemoteToolResult> {
      runtime.calls.push({ name, args });
      const output = { echo: args.target ?? args.query ?? args.source };
      return { content: [{ type: "text", text: `${name} ok` }], structuredContent: { status: "success", result: { output } } };
    },
    async readResource(uri: string) {
      runtime.reads.push(uri);
      if (uri.endsWith("/missing")) throw new Error(`no resource ${uri}`);
      return { contents: [{ uri, text: `body of ${uri}` }] };
    },
  };
  return runtime;
}

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

async function host(options: Partial<MarshalHostOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-seams-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  const backend = recording();
  const created = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    runtimeRoot: path.join(root, "runtime"),
    query: backend.query,
    browser: false,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    automations: { start: false },
    ...options,
  });
  return { host: created, turns: backend.turns };
}

/** Runs one turn and connects an MCP client to the session's `marshal` server as Claude Code would. */
async function marshalClient(created: Awaited<ReturnType<typeof host>>) {
  const session = created.host.agents.launch({ task: "t", idempotencyKey: `seams-${Math.random()}` });
  await created.host.agents.wait(session.id);
  const options = created.turns.at(-1)!;
  const server = options.mcpServers.marshal as { instance: { connect(transport: unknown): Promise<void> } };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "seams-test", version: "0.0.1" });
  await client.connect(clientSide);
  const text = (result: unknown) => ((result as { content: { text: string }[] }).content ?? []).map((item) => item.text).join("\n");
  return { session, options, client, text };
}

const recordingDirect: DirectTool = {
  name: "noteDown",
  description: "Records a note on the embedder.",
  inputSchema: { note: z.string() },
  handler: (args) => ({ content: [{ type: "text", text: `noted ${String(args.note)}` }] }),
};

test("Sanity: an embedder-owned runtime gets every runtime_search, runtime_exec and runtime_read_resource call and is never closed", async () => {
  const runtime = ownedRuntime();
  const created = await host({ remoteRuntime: () => runtime, remoteHostToolsFor: () => [] });
  try {
    const { client, text } = await marshalClient(created);
    assert.equal(text(await client.callTool({ name: "runtime_search", arguments: { query: "brain" } })), "runtime_search ok");
    assert.equal(text(await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "zyg.read", input: {} } })), "runtime_exec ok");
    assert.equal(text(await client.callTool({ name: "runtime_read_resource", arguments: { uri: "skill://x/y" } })), "body of skill://x/y");
    assert.deepEqual(runtime.calls.map((call) => call.name), ["runtime_search", "runtime_exec"]);
    assert.deepEqual(runtime.reads, ["skill://x/y"]);
  } finally {
    await created.host.dispose();
  }
  assert.equal(runtime.closes, 0, "the host never closes an embedder's runtime, not even on dispose");
});

test("Sanity: RemoteRuntimeClients passes an owned connection through and keeps nothing for it to idle-close", async () => {
  const runtime = ownedRuntime();
  assert.equal(isRuntimeConnection(runtime), true);
  assert.equal(isRuntimeConnection({ command: "ssh", args: ["vm"] }), false);
  const clients = new RemoteRuntimeClients(() => undefined, 1);
  const result = await clients.callTool("s1", runtime, "runtime_exec", { targetType: "operation", target: "a.b" });
  assert.equal(result.content.length, 1);
  clients.idle("s1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await clients.close("s1");
  await clients.closeAll();
  assert.equal(runtime.closes, 0);
  assert.equal(runtime.calls.length, 1);
});

test("Sanity: toolCall wraps runtime tools and direct tools, names the alias, and can change the result", async () => {
  const runtime = ownedRuntime();
  const seen: MarshalToolCall[] = [];
  let evidence = 0;
  const created = await host({
    remoteRuntime: () => runtime,
    remoteHostToolsFor: () => [],
    directTools: [...desktopDirectTools(z).filter((direct) => direct.name === "runtimeInvoke"), recordingDirect],
    toolCall: async (_session, call, next) => {
      seen.push(call);
      const result = await next();
      if (call.kind !== "runtime") return result;
      evidence += 1;
      return { ...result, content: [{ type: "text", text: `[evidence ev-${evidence}]` }, ...result.content] };
    },
  });
  try {
    const { client, text, session } = await marshalClient(created);
    assert.equal(text(await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "zyg.read" } })), "[evidence ev-1]\nruntime_exec ok");
    await client.callTool({ name: "runtimeInvoke", arguments: { capability: "zyg.read", input: { a: 1 } } });
    assert.equal(text(await client.callTool({ name: "noteDown", arguments: { note: "hi" } })), "noted hi");
    assert.equal(text(await client.callTool({ name: "runtime_read_resource", arguments: { uri: "skill://x/y" } })), "[evidence ev-3]\nbody of skill://x/y");
    assert.deepEqual(
      seen.map((call) => [call.kind, call.tool, call.alias ?? null]),
      [
        ["runtime", "runtime_exec", null],
        ["direct", "runtimeInvoke", null],
        ["runtime", "runtime_exec", "runtimeInvoke"],
        ["direct", "noteDown", null],
        ["runtime", "runtime_read_resource", null],
      ],
    );
    assert.deepEqual(seen[2]!.args, { targetType: "operation", target: "zyg.read", input: { a: 1 } });
    assert.ok(created.host.sessions.get(session.id));
  } finally {
    await created.host.dispose();
  }
});

test("Sanity: a local session's provider tools (other providers) go through toolCall too", async () => {
  const seen: string[] = [];
  const created = await host({
    directTools: [recordingDirect],
    toolCall: async (_session, call, next) => {
      seen.push(`${call.kind}:${call.tool}`);
      return next();
    },
  });
  try {
    const { options } = await marshalClient(created);
    const tools = options.mcpServers[PROVIDER_TOOLS] as { name: string; handler(args: unknown): Promise<string> }[];
    const byName = new Map(tools.map((entry) => [entry.name, entry]));
    assert.equal(await byName.get("noteDown")!.handler({ note: "x" }), "noted x");
    await byName.get("runtime_search")!.handler({ name: "marshal.tool.recall" });
    assert.deepEqual(seen, ["direct:noteDown", "runtime:runtime_search"]);
  } finally {
    await created.host.dispose();
  }
});

test("Sanity: runtime_exec carries requestId and executionMode to the runtime and drops approval", async () => {
  const runtime = ownedRuntime();
  const created = await host({ remoteRuntime: () => runtime, remoteHostToolsFor: () => [] });
  try {
    const { client } = await marshalClient(created);
    const listed = await client.listTools();
    const exec = listed.tools.find((entry) => entry.name === "runtime_exec")!;
    const properties = (exec.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok(properties.requestId);
    assert.ok(properties.executionMode);
    assert.equal(properties.approval, undefined, "a session never approves its own call");
    await client.callTool({
      name: "runtime_exec",
      arguments: { targetType: "inline_module", source: "return 1;", requestId: "idem-1", executionMode: "brokered", approval: { granted: true } },
    });
    assert.deepEqual(runtime.calls.at(-1)!.args, { targetType: "inline_module", source: "return 1;", requestId: "idem-1", executionMode: "brokered" });
  } finally {
    await created.host.dispose();
  }
});

test("Sanity: remoteHostToolsFor narrows one session's host tools; an empty list refuses every one and drops the exec note", async () => {
  const runtime = ownedRuntime();
  const created = await host({
    remoteRuntime: () => runtime,
    remoteHostToolsFor: (session) => (session.labels?.lane === "learning" ? ["marshal.tool.recordDecision"] : []),
  });
  try {
    const { client, text } = await marshalClient(created);
    const forked = await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "marshal.tool.forkSubagents", input: {} } });
    assert.equal(text(forked), "marshal.tool.forkSubagents is not available in this session.");
    assert.equal(forked.isError, true);
    assert.equal(runtime.calls.length, 0, "a refused host tool is never forwarded to the session's runtime");
    const exec = (await client.listTools()).tools.find((entry) => entry.name === "runtime_exec")!;
    assert.doesNotMatch(exec.description ?? "", /Host tools \(/);

    const learning = created.host.agents.launch({ task: "t", idempotencyKey: "learning", labels: { lane: "learning" } });
    await created.host.agents.wait(learning.id);
    const server = created.turns.at(-1)!.mcpServers.marshal as { instance: { connect(transport: unknown): Promise<void> } };
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const second = new Client({ name: "seams-test-2", version: "0.0.1" });
    await second.connect(clientSide);
    const note = (await second.listTools()).tools.find((entry) => entry.name === "runtime_exec")!.description ?? "";
    assert.match(note, /Host tools \(marshal\.tool\.recordDecision\) run on the host/);
    const refused = await second.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "marshal.tool.searchSessions", input: {} } });
    assert.equal(text(refused), "marshal.tool.searchSessions is not available in this session.");
    const allowed = await second.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "marshal.tool.recordDecision", input: { kind: "gap", text: "t" } } });
    assert.doesNotMatch(text(allowed), /not available in this session/);
  } finally {
    await created.host.dispose();
  }
});

test("Error Handling: a direct tool that throws and a failed read reach the wrapper as isError results", async () => {
  const runtime = ownedRuntime();
  const results: { tool: string; isError: boolean }[] = [];
  const failing: DirectTool = { name: "explode", description: "Throws.", inputSchema: {}, handler: () => Promise.reject(new Error("boom")) };
  const reader: DirectTool = {
    name: "readIt",
    description: "Reads a resource through its context.",
    inputSchema: { uri: z.string() },
    handler: async (args, context) => ({ content: [{ type: "text", text: (await context.readResource(String(args.uri))).contents[0]!.text ?? "" }] }),
  };
  const created = await host({
    remoteRuntime: () => runtime,
    remoteHostToolsFor: () => [],
    directTools: [failing, reader],
    toolCall: async (_session, call, next) => {
      const result = await next();
      results.push({ tool: `${call.kind}:${call.tool}`, isError: result.isError === true });
      return result;
    },
  });
  try {
    const { client, text } = await marshalClient(created);
    const exploded = await client.callTool({ name: "explode", arguments: {} });
    assert.equal(exploded.isError, true);
    assert.equal(text(exploded), "boom");
    assert.equal(text(await client.callTool({ name: "readIt", arguments: { uri: "skill://x/y" } })), "body of skill://x/y");
    const missing = await client.callTool({ name: "readIt", arguments: { uri: "skill://x/missing" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /no resource skill:\/\/x\/missing/);
    assert.deepEqual(results, [
      { tool: "direct:explode", isError: true },
      { tool: "runtime:runtime_read_resource", isError: false },
      { tool: "direct:readIt", isError: false },
      { tool: "runtime:runtime_read_resource", isError: true },
      { tool: "direct:readIt", isError: true },
    ]);
  } finally {
    await created.host.dispose();
  }
});

test("Error Handling: remoteHostToolsFor naming a tool the host does not allow fails the turn", async () => {
  const created = await host({
    remoteRuntime: () => ownedRuntime(),
    remoteHostTools: ["marshal.tool.remember"],
    remoteHostToolsFor: () => ["marshal.tool.searchSessions"],
  });
  try {
    const session = created.host.agents.launch({ task: "t", idempotencyKey: "bad-tools" });
    const outcome = await created.host.agents.wait(session.id);
    assert.equal(outcome.agent.state, "failed");
    assert.equal(created.turns.length, 0, "the backend never starts with a misconfigured tool set");
    assert.match(created.host.sessions.get(session.id)?.lastError ?? "", /remoteHostToolsFor: not a host tool this host allows: marshal\.tool\.searchSessions/);
  } finally {
    await created.host.dispose();
  }
});

test("Edge Cases: the kit takes the knowledge part on its own; an unknown part still fails", () => {
  assert.deepEqual(normalizeKit(["knowledge"])?.parts, ["knowledge"]);
  assert.throws(() => normalizeKit(["brian" as never]), /Unknown kit part/);
});

test("Edge Cases: without remoteHostToolsFor a remote session keeps the host-wide sets; without toolCall results are unchanged", async () => {
  const runtime = ownedRuntime();
  const created = await host({ remoteRuntime: () => runtime, remoteHostTools: ["marshal.tool.recordDecision"] });
  try {
    const { client, text } = await marshalClient(created);
    const exec = (await client.listTools()).tools.find((entry) => entry.name === "runtime_exec")!;
    assert.match(exec.description ?? "", /Host tools \(marshal\.tool\.recordDecision\)/);
    assert.equal(text(await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "zyg.read" } })), "runtime_exec ok");
    const refused = await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "marshal.tool.forget", input: {} } });
    assert.equal(text(refused), "marshal.tool.forget is not available in this session.");
  } finally {
    await created.host.dispose();
  }
});

test("Edge Cases: executionMode trusted_node does not give full Node on a host that does not trust TypeScript", async () => {
  const created = await host();
  try {
    const { options } = await marshalClient(created);
    const tools = options.mcpServers[PROVIDER_TOOLS] as { name: string; handler(args: unknown): Promise<string> }[];
    const exec = tools.find((entry) => entry.name === "runtime_exec")!;
    const outcome = await exec
      .handler({ targetType: "inline_module", executionMode: "trusted_node", source: 'import fs from "node:fs";\nexport default async () => typeof fs.readFileSync;' })
      .then((text) => text, (error: Error) => `error: ${error.message}`);
    assert.match(outcome, /IMPORT_DENIED/, outcome);
    assert.doesNotMatch(outcome, /"value":\s*"function"/, outcome);
  } finally {
    await created.host.dispose();
  }
});
