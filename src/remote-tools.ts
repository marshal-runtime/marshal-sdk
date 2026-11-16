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

/**
 * The host tools an embedder lets its remote sessions reach (`remoteHostTools`): a subset of REMOTE_HOST_TOOLS, all of them when not given. A host
 * that serves several tenants from one session store (Marley: every brand on one agent server) keeps the session tools (searchSessions,
 * getSessionTranscript, messageSubagent, ...) out, because they read and reach every session of the store. An unknown name is a configuration error.
 */
export function remoteHostToolSet(allowed: readonly string[] | undefined): ReadonlySet<string> {
  if (allowed === undefined) return HOST_TOOLS;
  const unknown = allowed.filter((name) => !HOST_TOOLS.has(name));
  if (unknown.length) throw new Error(`remoteHostTools: not a remote host tool: ${unknown.join(", ")} (REMOTE_HOST_TOOLS lists them)`);
  return new Set(allowed);
}

/** The host tool a runtime call names (an `operation` whose target is in REMOTE_HOST_TOOLS, or a runtime_search for one by name), else undefined. */
export function hostToolOf(name: string, args: unknown): string | undefined {
  const input = (args ?? {}) as { targetType?: unknown; target?: unknown; name?: unknown };
  if (name === "runtime_exec" && input.targetType === "operation" && typeof input.target === "string" && HOST_TOOLS.has(input.target)) return input.target;
  if (name === "runtime_search" && typeof input.name === "string" && HOST_TOOLS.has(input.name)) return input.name;
  return undefined;
}

/** True when a runtime call names one of the host's own tools (an `operation` whose target is in REMOTE_HOST_TOOLS). */
export function isHostToolCall(name: string, args: unknown): boolean {
  return name === "runtime_exec" && hostToolOf(name, args) !== undefined;
}

/** True when a runtime_search asks for one host tool's schema by name. */
export function isHostToolSearch(name: string, args: unknown): boolean {
  return name === "runtime_search" && hostToolOf(name, args) !== undefined;
}

/** A host tool the embedder did not allow (`remoteHostTools`): refused on the host, never forwarded to the remote runtime. */
export function refusedHostTool(tool: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: `${tool} is not available in this session.` }], isError: true };
}

type ToolResult = { content: unknown[]; isError?: boolean; structuredContent?: unknown };

interface Connection {
  signature: string;
  client: Promise<Client>;
  inFlight: number;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * One MCP client (one remote child, e.g. one ssh) per remote session, opened at the session's first runtime call and
 * kept across its turns. It closes with the session: its live process closes, the host closes, or nothing called it for
 * `idleMs` while no turn ran (default 10 minutes; the next call opens a fresh one). A changed RemoteRuntime (a relaunch
 * on another address) replaces the connection.
 */
export class RemoteRuntimeClients {
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly log: (line: string) => void = () => undefined,
    private readonly idleMs = 10 * 60_000,
  ) {}

  /** The session's turn ended: its connection closes after idleMs unless it is used again. */
  idle(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.inFlight > 0) return;
    if (connection.idle) clearTimeout(connection.idle);
    connection.idle = setTimeout(() => {
      if (this.connections.get(sessionId) === connection && connection.inFlight === 0) void this.close(sessionId);
    }, this.idleMs);
    connection.idle.unref?.();
  }

  private async use<T>(sessionId: string, remote: RemoteRuntime, run: (client: Client) => Promise<T>): Promise<T> {
    const client = this.connect(sessionId, remote);
    const connection = this.connections.get(sessionId)!;
    if (connection.idle) clearTimeout(connection.idle);
    connection.idle = undefined;
    connection.inFlight += 1;
    try {
      return await run(await client);
    } finally {
      connection.inFlight -= 1;
    }
  }

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
    this.connections.set(sessionId, { signature, client, inFlight: 0 });
    return client;
  }

  async callTool(sessionId: string, remote: RemoteRuntime, name: string, args: unknown): Promise<ToolResult> {
    return this.use(sessionId, remote, async (client) => (await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: 15 * 60_000 })) as ToolResult);
  }

  async readResource(sessionId: string, remote: RemoteRuntime, uri: string): Promise<{ contents: { uri: string; text?: string }[] }> {
    return this.use(sessionId, remote, async (client) => (await client.readResource({ uri })) as { contents: { uri: string; text?: string }[] });
  }

  async close(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    this.connections.delete(sessionId);
    if (connection.idle) clearTimeout(connection.idle);
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
