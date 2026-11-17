import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type { DirectTool } from "../src/host-options.js";
import type { RemoteToolResult } from "../src/remote-tools.js";
import { createSessionMarshalServer, SESSION_SERVER_NAME, type MarshalToolCall, type SessionMarshalServerOptions } from "../src/session-server.js";
import type { SessionRecord } from "../src/session-store.js";

const session = { id: "s-1" } as SessionRecord;

function runtime() {
  const calls: { name: string; args: unknown }[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    async callTool(name: string, args: unknown): Promise<RemoteToolResult> {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `${name} ok` }], structuredContent: { status: "success", result: { output: "out" } } };
    },
    async readResource(uri: string) {
      reads.push(uri);
      if (uri.endsWith("/missing")) throw new Error(`no resource ${uri}`);
      return { contents: [{ uri, text: `body of ${uri}` }] };
    },
  };
}

async function connect(options: Partial<SessionMarshalServerOptions> & { runtime: SessionMarshalServerOptions["runtime"] }) {
  const server = createSessionMarshalServer({ session, workspacePath: "/ws", ...options }) as unknown as {
    name: string;
    instance: { connect(transport: unknown): Promise<void> };
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, name: server.name };
}

const lookup: DirectTool = {
  name: "lookup",
  description: "looks up",
  inputSchema: { what: z.string() },
  handler: async (args, context) => context.call("runtime_exec", { targetType: "operation", target: String(args.what) }) as never,
};

test("Sanity: runtime tools reach the runtime, with requestId and executionMode and no approval", async () => {
  const backend = runtime();
  const { client, name } = await connect({ runtime: backend });
  assert.equal(name, SESSION_SERVER_NAME);
  const tools = (await client.listTools()).tools.map((entry) => entry.name).sort();
  assert.deepEqual(tools, ["runtime_exec", "runtime_read_resource", "runtime_search"]);
  const exec = (await client.listTools()).tools.find((entry) => entry.name === "runtime_exec")!;
  assert.equal("approval" in (exec.inputSchema.properties ?? {}), false);
  await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "a.b", requestId: "r1", executionMode: "brokered", approval: { yes: true } } });
  assert.deepEqual(backend.calls, [{ name: "runtime_exec", args: { targetType: "operation", target: "a.b", requestId: "r1", executionMode: "brokered" } }]);
  const read = await client.callTool({ name: "runtime_read_resource", arguments: { uri: "skill://x/y" } });
  assert.deepEqual(read.content, [{ type: "text", text: "body of skill://x/y" }]);
});

test("Sanity: the wrapper sees runtime and direct calls, with the direct tool as alias, and may change the result", async () => {
  const backend = runtime();
  const seen: MarshalToolCall[] = [];
  const { client } = await connect({
    runtime: backend,
    directTools: [lookup],
    toolCall: async (_session, call, next) => {
      seen.push(call);
      const result = await next();
      return call.kind === "direct" ? { content: [{ type: "text", text: `[wrapped] ${(result.content[0] as { text: string }).text}` }] } : result;
    },
  });
  const result = await client.callTool({ name: "lookup", arguments: { what: "c.d" } });
  assert.deepEqual(result.content, [{ type: "text", text: "[wrapped] runtime_exec ok" }]);
  assert.deepEqual(
    seen.map((call) => [call.kind, call.tool, call.alias]),
    [
      ["direct", "lookup", undefined],
      ["runtime", "runtime_exec", "lookup"],
    ],
  );
});

test("Error Handling: a failed read and a throwing direct tool come back as error results", async () => {
  const backend = runtime();
  const broken: DirectTool = { name: "broken", description: "fails", inputSchema: {}, handler: async () => { throw new Error("boom"); } };
  const { client } = await connect({ runtime: backend, directTools: [broken] });
  const read = await client.callTool({ name: "runtime_read_resource", arguments: { uri: "skill://x/missing" } });
  assert.equal(read.isError, true);
  const failed = await client.callTool({ name: "broken", arguments: {} });
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.content, [{ type: "text", text: "boom" }]);
});

test("Edge Cases: runtimeTools false leaves only the direct tools, and the exec note and descriptions apply", async () => {
  const backend = runtime();
  const only = await connect({ runtime: backend, directTools: [lookup], runtimeTools: false });
  assert.deepEqual((await only.client.listTools()).tools.map((entry) => entry.name), ["lookup"]);
  const described = await connect({ runtime: backend, descriptions: { search: "find", exec: "run" }, execNote: " + note" });
  const tools = (await described.client.listTools()).tools;
  assert.equal(tools.find((entry) => entry.name === "runtime_search")!.description, "find");
  assert.equal(tools.find((entry) => entry.name === "runtime_exec")!.description, "run + note");
});
