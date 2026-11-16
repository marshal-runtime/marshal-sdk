// The `marshal` MCP server of a session whose Claude Code runs on another machine (a remote `spawnClaudeCodeProcess`).
//
// The server is an in-process SDK server: the Claude Agent SDK carries its calls over the Claude Code process's own
// control channel (the stdin/stdout the spawner returns), so it reaches a CLI on another machine with no listener, port,
// tunnel or token. Its tools keep their local names, so the prompt is the same local or remote:
//   - runtime_search / runtime_exec / runtime_read_resource run on the REMOTE machine's own Marshal runtime (the host
//     reaches it through `RemoteRuntime`, e.g. an ssh command that starts its MCP server): model-selected tools and code
//     execute there, never on the host.
//   - the fixed host tool set (REMOTE_HOST_TOOLS: forks, sessions, memory, decisions) runs on the host, under the session's
//     own scope. Nothing else of the host's runtime is reachable.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** How the host reaches the remote machine's Marshal runtime MCP server: a stdio command (Marley: ssh to the brand VM running its runtime). */
export interface RemoteRuntime {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** The host capabilities a remote session reaches, executed on the host. Every other capability runs on the remote runtime. */
export const REMOTE_HOST_TOOLS: readonly string[] = [
  "marshal.tool.forkSubagents",
  "marshal.tool.listSubagents",
  "marshal.tool.messageSubagent",
  "marshal.tool.messageForks",
  "marshal.tool.searchSessions",
  "marshal.tool.getSessionTranscript",
  "marshal.tool.remember",
  "marshal.tool.recall",
  "marshal.tool.linkMemory",
  "marshal.tool.updateMemory",
  "marshal.tool.forget",
  "marshal.tool.recordDecision",
];

const HOST_TOOLS = new Set(REMOTE_HOST_TOOLS);

/** True when a runtime call names one of the host's own tools (an `operation` whose target is in REMOTE_HOST_TOOLS). */
export function isHostToolCall(name: string, args: unknown): boolean {
  if (name !== "runtime_exec") return false;
  const input = (args ?? {}) as { targetType?: unknown; target?: unknown };
  return input.targetType === "operation" && typeof input.target === "string" && HOST_TOOLS.has(input.target);
}

/** True when a runtime_search asks for one host tool's schema by name. */
export function isHostToolSearch(name: string, args: unknown): boolean {
  if (name !== "runtime_search") return false;
  const input = (args ?? {}) as { name?: unknown };
  return typeof input.name === "string" && HOST_TOOLS.has(input.name);
}

type ToolResult = { content: unknown[]; isError?: boolean; structuredContent?: unknown };

interface Connection {
  signature: string;
  client: Promise<Client>;
}

/**
 * One MCP client per remote session, opened at the session's first runtime call and closed when its turn settles, its
 * process closes or the host closes (the next call opens a fresh one). A changed RemoteRuntime (a relaunch on another
 * address) replaces the connection.
 */
export class RemoteRuntimeClients {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly log: (line: string) => void = () => undefined) {}

  private connect(sessionId: string, remote: RemoteRuntime): Promise<Client> {
    const signature = JSON.stringify([remote.command, remote.args ?? [], remote.env ?? {}, remote.cwd ?? ""]);
    const existing = this.connections.get(sessionId);
    if (existing?.signature === signature) return existing.client;
    if (existing) void this.close(sessionId);
    const client = (async () => {
      const transport = new StdioClientTransport({
        command: remote.command,
        ...(remote.args ? { args: remote.args } : {}),
        ...(remote.env ? { env: remote.env } : {}),
        ...(remote.cwd ? { cwd: remote.cwd } : {}),
        stderr: "ignore",
      });
      const opened = new Client({ name: "marshal-sdk-remote", version: "0.1.0" });
      transport.onclose = () => {
        if (this.connections.get(sessionId)?.client === client) this.connections.delete(sessionId);
      };
      await opened.connect(transport);
      return opened;
    })();
    client.catch((error: unknown) => {
      if (this.connections.get(sessionId)?.client === client) this.connections.delete(sessionId);
      this.log(`remote runtime ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.connections.set(sessionId, { signature, client });
    return client;
  }

  async callTool(sessionId: string, remote: RemoteRuntime, name: string, args: unknown): Promise<ToolResult> {
    const client = await this.connect(sessionId, remote);
    return (await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: 15 * 60_000 })) as ToolResult;
  }

  async readResource(sessionId: string, remote: RemoteRuntime, uri: string): Promise<{ contents: { uri: string; text?: string }[] }> {
    const client = await this.connect(sessionId, remote);
    return (await client.readResource({ uri })) as { contents: { uri: string; text?: string }[] };
  }

  async close(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    this.connections.delete(sessionId);
    try {
      await (await connection.client).close();
    } catch {
      // A connection that never opened has nothing to close.
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((sessionId) => this.close(sessionId)));
  }
}
