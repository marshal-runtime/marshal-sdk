// Checks, without a model, that a session launched on the host gets a working browser: a fake backend
// captures the session's MCP servers, then the playwright server is started and asked for its tools.
//   node poc/browser-check.mjs <scratch dir>
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createMarshalHost } from "../dist/src/index.js";

const scratch = path.resolve(process.argv[2] ?? "/tmp/marshal-sdk-browser-check");
for (const directory of ["ws", "state"]) fs.mkdirSync(path.join(scratch, directory), { recursive: true });
let servers;
const host = await createMarshalHost({
  workspacePath: path.join(scratch, "ws"),
  stateRoot: path.join(scratch, "state"),
  log: (line) => process.stderr.write(`${line}\n`),
  query: ({ options }) => {
    servers = options.mcpServers;
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, usage: {} };
    })();
  },
});
const launched = await host.invoke("marshal.agent.launch", { task: "noop", idempotencyKey: "browser-check" });
await host.invoke("marshal.agent.wait", { agentId: launched.agent.id, timeoutMs: 10_000 });
const playwright = servers?.playwright;
console.log(`session MCP servers: ${Object.keys(servers ?? {}).join(", ")}`);
if (!playwright) {
  await host.dispose();
  process.exit(1);
}
console.log(`playwright server: ${playwright.command} ${playwright.args.join(" ")}`);
const client = new Client({ name: "browser-check", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: playwright.command, args: playwright.args, stderr: "pipe" }));
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
const navigated = await client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,<title>marshal-sdk</title><h1>browser ok</h1>" } });
console.log(`browser_navigate: ${JSON.stringify(navigated.content).slice(0, 300)}`);
await client.close();
await host.dispose();
process.exit(0);
