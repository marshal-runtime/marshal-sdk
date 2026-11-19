// `marshal-claude`: the Claude Code command line that the Python Claude Agent SDK launches, run on a Marshal host.
//
// The Python SDK (claude_agent_sdk.query / ClaudeSDKClient) does not run the agent: it starts the Claude Code CLI and
// speaks stream-json with it over stdin/stdout. `marshal_sdk` (python/) points the SDK's `cli_path` here and names the
// real CLI in MARSHAL_SDK_CLAUDE_CLI. This process starts a Marshal host, starts the real CLI with the same arguments,
// and sits on the line between them:
//   - every line passes through unchanged, so the caller's hooks, permission callback, subagents and in-process
//     (SDK) MCP tools keep working exactly as they do without Marshal;
//   - the host's `marshal` MCP server is added to --mcp-config as an SDK server, and its calls (control requests the
//     CLI sends for server "marshal") are answered here, so the agent gets Marshal's runtime, capabilities and kit;
//   - the conversation is recorded as a session of the host's session store (and published with the kit), so the run
//     shows up in Marshal like any other session.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { MarshalHost } from "./host.js";
import { withManifest } from "./onboarding-cli.js";
import { hostKit, kitArgument, pageKit, publishArgument } from "./page-run.js";

export const REAL_CLI_ENV = "MARSHAL_SDK_CLAUDE_CLI";
export const STATE_ENV = "MARSHAL_SDK_STATE";
export const TITLE_ENV = "MARSHAL_SDK_SESSION_TITLE";
export const PROMPT_ENV = "MARSHAL_SDK_PROMPT";
export const BRAIN_CALLER_ENV = "MARSHAL_SDK_BRAIN_CALLER";
const SERVER_NAME = "marshal";
const MCP_CONFIG_FLAG = "--mcp-config";
const APPEND_PROMPT_FLAG = "--append-system-prompt";
const SYSTEM_PROMPT_FLAG = "--system-prompt";
const DEFAULT_TITLE = "Claude Agent SDK run";
const TOOLS_NOTE = `## Marshal

This run is on a Marshal host. Besides your own tools you have the \`mcp__marshal__*\` tools: runtime_search finds a Marshal capability or skill by what you need, runtime_exec runs it (or TypeScript with context.runtime.invoke), runtime_read_resource reads a skill or doc it names.`;

type Json = Record<string, any>;

/** The CLI arguments with the host's `marshal` server added as an SDK server, and the Marshal note on the prompt. */
export function bridgeArgs(args: readonly string[], note: string): string[] {
  const out = [...args];
  const entry = { type: "sdk", name: SERVER_NAME };
  const at = out.indexOf(MCP_CONFIG_FLAG);
  let merged = false;
  if (at >= 0 && at + 1 < out.length) {
    try {
      const config = JSON.parse(out[at + 1]!) as { mcpServers?: Record<string, unknown> };
      if (config && typeof config === "object") {
        if (config.mcpServers?.[SERVER_NAME]) throw new Error(`The caller already has an MCP server named "${SERVER_NAME}"; rename it to run on Marshal.`);
        out[at + 1] = JSON.stringify({ ...config, mcpServers: { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry } });
        merged = true;
      }
    } catch (error) {
      if (error instanceof SyntaxError) merged = false;
      else throw error;
    }
  }
  if (!merged) out.push(MCP_CONFIG_FLAG, JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }));
  if (!note) return out;
  const append = out.indexOf(APPEND_PROMPT_FLAG);
  const system = out.indexOf(SYSTEM_PROMPT_FLAG);
  if (append >= 0 && append + 1 < out.length) out[append + 1] = `${out[append + 1]}\n\n${note}`;
  else if (system >= 0 && system + 1 < out.length) out[system + 1] = `${out[system + 1]}\n\n${note}`;
  else out.push(APPEND_PROMPT_FLAG, note);
  return out;
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** Answers MCP JSON-RPC messages for one in-process SDK server (an McpServer instance) over an in-memory pair. */
export class SdkServerLine {
  private readonly pending = new Map<string | number, (message: Json) => void>();
  private constructor(private readonly client: InMemoryTransport) {}

  static async open(instance: { connect(transport: unknown): Promise<void> }): Promise<SdkServerLine> {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const line = new SdkServerLine(client);
    client.onmessage = (message: Json) => {
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        line.pending.get(message.id)?.(message);
        line.pending.delete(message.id);
      }
    };
    await instance.connect(server);
    await client.start();
    return line;
  }

  /** The server's reply; a notification gets the empty result the Python SDK sends for one. */
  async send(message: Json): Promise<Json> {
    if (message.id === undefined) {
      await this.client.send(message as never);
      return { jsonrpc: "2.0", result: {} };
    }
    const reply = new Promise<Json>((resolve) => this.pending.set(message.id, resolve));
    await this.client.send(message as never);
    return reply;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Run the real CLI behind a Marshal host; resolves with the CLI's exit code. */
export async function runClaudeBridge(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const realCli = env[REAL_CLI_ENV];
  if (!realCli) throw new Error(`${REAL_CLI_ENV} must name the Claude Code CLI to run (marshal_sdk sets it to the one claude_agent_sdk bundles).`);
  const log = (line: string) => process.stderr.write(`[marshal-claude] ${line}\n`);
  const cwd = process.cwd();
  const runId = randomUUID();
  const stateRoot = path.resolve(env[STATE_ENV] || path.join(os.tmpdir(), "marshal-claude", runId));
  fs.mkdirSync(stateRoot, { recursive: true });

  const { createMarshalHost } = await import("./host.js");
  // The host the caller's marshal-sdk.json declares ($MARSHAL_SDK_MANIFEST, else one in the working folder): its
  // extensions, kit, Brain and model; without one, the kit $MARSHAL_SDK_KIT names. The run's person
  // ($MARSHAL_SDK_BRAIN_CALLER, set by marshal_sdk from the options' user) is the Brain's caller either way.
  const person = env[BRAIN_CALLER_ENV]?.trim().toLowerCase() || undefined;
  const declared = await withManifest(
    {
      workspacePath: cwd,
      stateRoot,
      runId,
      browser: false,
      labels: { job: "claude-agent-sdk" },
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...hostKit(kitArgument(undefined), publishArgument(undefined, undefined).publish, person),
      log,
    },
    {},
  );
  const kit = pageKit(declared.kit, undefined, undefined, person);
  const host: MarshalHost = await createMarshalHost({ ...declared, ...(kit ? { kit } : {}) });
  const model = flag(args, "--model");
  const session = host.sessions.create({
    title: env[TITLE_ENV] || DEFAULT_TITLE,
    runtime: "claude",
    ...(model ? { model } : {}),
    ...(flag(args, "--effort") ? { reasoningEffort: flag(args, "--effort")! } : {}),
    native: { kind: "claude", cwd },
    workspace: cwd,
    labels: { via: "claude-agent-sdk" },
  });
  host.sessions.update(session.id, { state: "running" });
  const servers = host.mcpServersFor(session.id) as { marshal?: { instance?: { connect(transport: unknown): Promise<void> } } };
  if (!servers.marshal?.instance) throw new Error("The host gave this session no in-process marshal server.");
  const marshal = await SdkServerLine.open(servers.marshal.instance);
  const note = env[PROMPT_ENV] === "off" ? "" : env[PROMPT_ENV] === "full" ? (host.systemPrompt(session.id) ?? TOOLS_NOTE) : TOOLS_NOTE;
  log(`session ${session.id} in ${path.join(stateRoot, "sessions")}`);

  const child = spawn(realCli, bridgeArgs(args, note), { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const toChild = (line: string) => {
    if (!child.stdin.destroyed) child.stdin.write(`${line}\n`);
  };
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);

  // The caller (Python SDK) -> the CLI: unchanged; user turns are recorded.
  const fromCaller = createInterface({ input: process.stdin, crlfDelay: Infinity });
  fromCaller.on("line", (line) => {
    toChild(line);
    try {
      const message = JSON.parse(line) as Json;
      if (message.type === "user") {
        const text = textOf(message.message?.content);
        if (text) host.sessions.appendMessage(session.id, { role: "user", content: text });
      }
    } catch {
      // Not JSON: the CLI answers it, as it would without the bridge.
    }
  });
  fromCaller.on("close", () => child.stdin.end());

  // The CLI -> the caller: unchanged, except the calls for the host's marshal server, which are answered here.
  let failure = "";
  const fromChild = createInterface({ input: child.stdout, crlfDelay: Infinity });
  fromChild.on("line", (line) => {
    let message: Json | undefined;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      message = undefined;
    }
    const request = message?.type === "control_request" ? message.request : undefined;
    if (request?.subtype === "mcp_message" && request.server_name === SERVER_NAME) {
      const requestId = message!.request_id;
      marshal
        .send(request.message)
        .then((reply) => toChild(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response: reply } } })))
        .catch((error: unknown) =>
          toChild(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error: error instanceof Error ? error.message : String(error) } })),
        );
      return;
    }
    process.stdout.write(`${line}\n`);
    if (!message) return;
    try {
      if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        host.sessions.update(session.id, { native: { kind: "claude", cwd, sessionId: message.session_id } });
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        const text = textOf(message.message?.content);
        if (text) host.sessions.appendMessage(session.id, { role: "assistant", content: text });
      } else if (message.type === "result") {
        const usage = message.usage ?? {};
        host.sessions.addUsage(session.id, {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          costUsd: message.total_cost_usd ?? 0,
          turns: 1,
          modelTurns: message.num_turns ?? 0,
        });
        if (message.is_error) failure = String(message.result ?? message.subtype ?? "error");
      }
    } catch (error) {
      log(`could not record a message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const code = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      failure = `could not start ${realCli}: ${error.message}`;
      log(failure);
      resolve(1);
    });
    child.on("close", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  process.off("SIGTERM", forward);
  process.off("SIGINT", forward);
  if (code !== 0 && !failure) failure = `the Claude Code CLI exited with ${code}`;
  host.sessions.update(session.id, { state: failure ? "failed" : "idle", ...(failure ? { lastError: failure.slice(0, 500) } : {}) });
  await marshal.close().catch(() => undefined);
  await host.dispose().catch((error: unknown) => log(`host dispose: ${String(error)}`));
  return code;
}
