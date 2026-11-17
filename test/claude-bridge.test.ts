import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bridgeArgs } from "../src/claude-bridge.js";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "claude-bridge-cli.js");

test("bridgeArgs adds the marshal SDK server to the caller's --mcp-config and the note to its appended prompt", () => {
  const args = ["--output-format", "stream-json", "--append-system-prompt", "Theirs.", "--mcp-config", JSON.stringify({ mcpServers: { copy: { type: "sdk", name: "copy" } } })];
  const out = bridgeArgs(args, "NOTE");
  const config = JSON.parse(out[out.indexOf("--mcp-config") + 1]!);
  assert.deepEqual(Object.keys(config.mcpServers), ["copy", "marshal"]);
  assert.deepEqual(config.mcpServers.marshal, { type: "sdk", name: "marshal" });
  assert.equal(out[out.indexOf("--append-system-prompt") + 1], "Theirs.\n\nNOTE");
  assert.equal(out.filter((arg) => arg === "--mcp-config").length, 1);
});

test("bridgeArgs adds its own --mcp-config and prompt when the caller has none, and refuses a caller server named marshal", () => {
  const out = bridgeArgs(["--output-format", "stream-json"], "NOTE");
  assert.deepEqual(JSON.parse(out[out.indexOf("--mcp-config") + 1]!), { mcpServers: { marshal: { type: "sdk", name: "marshal" } } });
  assert.equal(out[out.indexOf("--append-system-prompt") + 1], "NOTE");
  assert.deepEqual(bridgeArgs(["-p"], ""), ["-p", "--mcp-config", JSON.stringify({ mcpServers: { marshal: { type: "sdk", name: "marshal" } } })]);
  assert.throws(() => bridgeArgs(["--mcp-config", JSON.stringify({ mcpServers: { marshal: {} } })], ""), /already has an MCP server named "marshal"/);
});

// A stand-in for the Claude Code CLI: on the caller's user turn it lists the marshal server's tools (the bridge must
// answer), asks the caller's own SDK server "copy" to call a tool (the bridge must pass it through), then ends the turn.
const FAKE_CLI = `
const readline = require("node:readline");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const waiting = new Map();
out({ type: "system", subtype: "init", session_id: "native-1", argv: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_response") { waiting.get(m.response.request_id)?.(m.response); return; }
  if (m.type !== "user") return;
  const ask = (id, server, message) => new Promise((resolve) => { waiting.set(id, resolve); out({ type: "control_request", request_id: id, request: { subtype: "mcp_message", server_name: server, message } }); });
  await ask("r1", "marshal", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
  const listed = await ask("r2", "marshal", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const copied = await ask("r3", "copy", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fact", arguments: {} } });
  const tools = listed.response.mcp_response.result.tools.map((t) => t.name);
  out({ type: "assistant", message: { content: [{ type: "text", text: "tools " + tools.join(",") + " copy " + copied.response.mcp_response.result.content[0].text }] }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } });
  process.exit(0);
});
`;

test("marshal-claude answers the marshal server itself, passes the caller's SDK server calls through, and records a session", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-"));
  const workspace = path.join(base, "ws");
  const state = path.join(base, "state");
  fs.mkdirSync(workspace);
  const fake = path.join(base, "fake-claude.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\n${FAKE_CLI}`, { mode: 0o755 });
  const child = spawn(process.execPath, [BRIDGE, "--output-format", "stream-json", "--model", "claude-haiku-5-5", "--mcp-config", JSON.stringify({ mcpServers: { copy: { type: "sdk", name: "copy" } } })], {
    cwd: workspace,
    env: { ...process.env, MARSHAL_SDK_CLAUDE_CLI: fake, MARSHAL_SDK_STATE: state, MARSHAL_SDK_SESSION_TITLE: "bridge test", MARSHAL_SDK_KIT: "", MARSHAL_SDK_PUBLISH_SESSIONS: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const seen: any[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    seen.push(message);
    if (message.type === "control_request") {
      child.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { mcp_response: { jsonrpc: "2.0", id: message.request.message.id, result: { content: [{ type: "text", text: "pistachio" }] } } } } })}\n`);
    }
  });
  child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "hello" } })}\n`);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);

  const requests = seen.filter((m) => m.type === "control_request");
  assert.deepEqual(requests.map((m) => m.request.server_name), ["copy"], "only the caller's own server reaches the caller");
  const init = seen.find((m) => m.type === "system");
  const config = JSON.parse(init.argv[init.argv.indexOf("--mcp-config") + 1]);
  assert.deepEqual(Object.keys(config.mcpServers), ["copy", "marshal"]);
  const said = seen.find((m) => m.type === "assistant").message.content[0].text as string;
  assert.match(said, /runtime_search/);
  assert.match(said, /copy pistachio/);

  const index = JSON.parse(fs.readFileSync(path.join(state, "sessions", "index.json"), "utf8")) as any[];
  assert.equal(index.length, 1);
  assert.equal(index[0].title, "bridge test");
  assert.equal(index[0].state, "idle");
  assert.equal(index[0].native.sessionId, "native-1");
  assert.equal(index[0].usage.costUsd, 0.01);
  const transcript = fs.readFileSync(path.join(state, "sessions", index[0].id, "transcript.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(transcript.map((m: any) => m.role), ["user", "assistant"]);
});
