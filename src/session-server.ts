// A session's `marshal` MCP server: runtime_search, runtime_exec and runtime_read_resource on the session's runtime, the
// embedder's direct tools, and the `toolCall` wrapper around each call. The host builds one per session turn
// (host.ts `serversFor`); an embedder that owns its sessions' runtimes and runs no host runtime of its own (zyg-agents'
// engine: each session's runtime is its own child process) builds it here, from the session's runtime connection alone.
// It imports no Marshal runtime package: the runtime is whatever `runtime` answers.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { DirectTool, DirectToolContext } from "./host-options.js";
import type { RemoteToolResult } from "./remote-tools.js";
import type { SessionRecord } from "./session-store.js";

/** The server's name: its tools reach the model as `mcp__marshal__<tool>`. */
export const SESSION_SERVER_NAME = "marshal";
const SERVER_VERSION = "0.1.0";
/** The longest runtime_exec a session may ask for. */
export const SESSION_EXEC_TIMEOUT_MS = 300_000;
const RESULT_ERROR_CHARS = 2000;

/** One call on a session's `marshal` server, as the `toolCall` wrapper sees it. */
export interface MarshalToolCall {
  /** "runtime": a call that reaches the session's runtime; "direct": an embedder direct tool the model called. */
  kind: "runtime" | "direct";
  /** runtime_search, runtime_exec or runtime_read_resource for a runtime call; the direct tool's name for a direct one. */
  tool: string;
  args: Record<string, unknown>;
  /** The direct tool a runtime call was made from (a desktop name such as runtimeInvoke); absent when the model called the runtime tool itself. */
  alias?: string;
}

/** The `toolCall` wrapper: runs `next()` (the call itself) and returns its result, or a changed one. */
export type MarshalToolCallWrapper = (session: SessionRecord, call: MarshalToolCall, next: () => Promise<RemoteToolResult>) => Promise<RemoteToolResult>;

/** What the server calls for every runtime tool: the session's runtime as an MCP tool caller and resource reader. */
export interface SessionRuntimeAdapter {
  callTool(name: string, args: unknown): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
}

/** The descriptions of runtime_search and runtime_exec the model reads (the host passes its runtime's own). */
export interface RuntimeToolDescriptions {
  search: string;
  exec: string;
}

const DEFAULT_DESCRIPTIONS: RuntimeToolDescriptions = {
  search: "Discover Marshal runtime capabilities by query, then resolve one exact `name` for its full input schema before running it.",
  exec: "Run a discovered capability (targetType 'operation' with `target` and `input`), or TypeScript (targetType 'inline_module' with `source`, which may `return` a value and call `context.runtime.invoke(capability, input)`).",
};

/** A session's `marshal` server, built from its runtime alone. */
export interface SessionMarshalServerOptions {
  session: SessionRecord;
  runtime: SessionRuntimeAdapter;
  /** The workspace the session works in, as direct tools see it. */
  workspacePath: string;
  /** Tools the model sees directly beside the runtime tools (the desktop names). */
  directTools?: readonly DirectTool[];
  /** Offer runtime_search, runtime_exec and runtime_read_resource. Default true. */
  runtimeTools?: boolean;
  /** Direct tools run TypeScript in full Node (the host's trustedTypeScript). Default false. */
  trustedTypeScript?: boolean;
  /** Text added to runtime_exec's description (a remote session's host tools). */
  execNote?: string;
  descriptions?: RuntimeToolDescriptions;
  toolCall?: MarshalToolCallWrapper;
}

/** The server and the wrapped calls a host also hands to providers that take tools directly. */
export interface SessionMarshalTools {
  server: ReturnType<typeof createSdkMcpServer>;
  /** runtime_search / runtime_exec through the wrapper, as an MCP result. */
  call(name: string, args: unknown): Promise<RemoteToolResult>;
  /** A resource read through the wrapper (or straight from the runtime without one). */
  readContents(uri: string): Promise<{ contents: { uri: string; text?: string }[] }>;
  /** One direct tool's call through the wrapper. */
  runDirect(direct: DirectTool): (args: Record<string, unknown>) => Promise<RemoteToolResult>;
}

/** Builds a session's `marshal` server and its wrapped calls (host.ts `serversFor` uses it for every session). */
export function sessionMarshalTools(options: SessionMarshalServerOptions): SessionMarshalTools {
  const { session, runtime: adapter, workspacePath } = options;
  const wrap = options.toolCall;
  const directTools = options.directTools ?? [];
  const descriptions = options.descriptions ?? DEFAULT_DESCRIPTIONS;
  const runtimeCall =
    (alias?: string) =>
    (name: string, args: unknown): Promise<RemoteToolResult> => {
      const next = async () => (await adapter.callTool(name, args)) as RemoteToolResult;
      return wrap ? wrap(session, { kind: "runtime", tool: name, args: argsRecord(args), ...(alias ? { alias } : {}) }, next) : next();
    };
  const runtimeRead =
    (alias?: string) =>
    (uri: string): Promise<RemoteToolResult> => {
      const next = async (): Promise<RemoteToolResult> => {
        try {
          const read = (await adapter.readResource(uri)) as { contents: { uri: string; text?: string }[] };
          return { content: read.contents.map((item) => ({ type: "text" as const, text: item.text ?? "" })), structuredContent: read };
        } catch (error) {
          return { content: [{ type: "text" as const, text: messageOf(error) }], isError: true };
        }
      };
      return wrap ? wrap(session, { kind: "runtime", tool: "runtime_read_resource", args: { uri }, ...(alias ? { alias } : {}) }, next) : next();
    };
  // Without a wrapper a direct tool reads through the adapter as it always did; with one, through the wrapped read.
  const readContents =
    (alias?: string) =>
    async (uri: string): Promise<{ contents: { uri: string; text?: string }[] }> => {
      if (!wrap) return (await adapter.readResource(uri)) as { contents: { uri: string; text?: string }[] };
      const result = await runtimeRead(alias)(uri);
      if (result.isError) throw new Error(resultText(result.content));
      const read = result.structuredContent as { contents?: { uri: string; text?: string }[] } | undefined;
      return read?.contents ? { contents: read.contents } : { contents: [{ uri, text: resultText(result.content) }] };
    };
  const call = async (name: string, args: unknown) => {
    const result = await runtimeCall()(name, args);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  };
  const directContextFor = (alias: string): DirectToolContext => ({
    sessionId: session.id,
    workspacePath,
    trustedTypeScript: options.trustedTypeScript === true,
    call: (name: string, args: unknown) => runtimeCall(alias)(name, args),
    invoke: async (capability: string, input: unknown = {}) => {
      const result = await runtimeCall(alias)("runtime_exec", { targetType: "operation", target: capability, input });
      const response = (result.structuredContent ?? {}) as Record<string, any>;
      if (response.status !== "success") throw new Error(`${capability} failed: ${JSON.stringify(response.error ?? response).slice(0, RESULT_ERROR_CHARS)}`);
      return response.result?.output;
    },
    readResource: readContents(alias),
  });
  const runDirect =
    (direct: DirectTool) =>
    (args: Record<string, unknown>): Promise<RemoteToolResult> => {
      const next = async (): Promise<RemoteToolResult> => {
        try {
          return await direct.handler(args, directContextFor(direct.name));
        } catch (error) {
          return { content: [{ type: "text" as const, text: messageOf(error) }], isError: true };
        }
      };
      return wrap ? wrap(session, { kind: "direct", tool: direct.name, args }, next) : next();
    };
  const embedderTools = directTools.map((direct: DirectTool) =>
    tool(direct.name, direct.description, direct.inputSchema, async (args) => (await runDirect(direct)(args as Record<string, unknown>)) as never),
  );
  const runtimeToolList = [
    tool(
      "runtime_search",
      descriptions.search,
      {
        query: z.string().optional(),
        name: z.string().optional(),
        catalogId: z.string().optional(),
        detail: z.enum(["summary", "full"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        tags: z.array(z.string()).optional(),
      },
      async (args) => (await call("runtime_search", args)) as never,
    ),
    tool(
      "runtime_exec",
      descriptions.exec + (options.execNote ?? ""),
      {
        targetType: z.enum(["operation", "inline_module", "module"]),
        target: z.string().optional(),
        source: z.string().optional(),
        module: z.record(z.string(), z.any()).optional(),
        input: z.any().optional(),
        timeoutMs: z.number().int().min(1).max(SESSION_EXEC_TIMEOUT_MS).optional(),
        // An idempotency key: a retried call with the same id is the same request (the approval retry). No `approval`: a session never approves its own call.
        requestId: z.string().min(1).max(200).optional(),
        executionMode: z.enum(["brokered", "trusted_node"]).optional(),
      },
      async (args) => (await call("runtime_exec", args)) as never,
    ),
    tool(
      "runtime_read_resource",
      "Read a Marshal runtime resource by URI: an installed extension's skill (skill://<extension>/<name>) and the references it names, or a resource a runtime_search entry points to (action resource_read).",
      { uri: z.string().min(1).max(2048) },
      async ({ uri }) => {
        const result = await runtimeRead()(uri);
        return { content: result.content, ...(result.isError ? { isError: true } : {}) } as never;
      },
    ),
  ];
  const server = createSdkMcpServer({
    name: SESSION_SERVER_NAME,
    version: SERVER_VERSION,
    tools: [...(options.runtimeTools !== false ? runtimeToolList : []), ...embedderTools],
  });
  return { server, call, readContents: readContents(), runDirect };
}

/** A session's `marshal` server from its runtime alone: for an embedder that owns each session's runtime and runs no host runtime. */
export function createSessionMarshalServer(options: SessionMarshalServerOptions): ReturnType<typeof createSdkMcpServer> {
  return sessionMarshalTools(options).server;
}

/** A tool call's arguments as a record (an absent or non-object argument is an empty one). */
function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** The text of an MCP result's content items, one per line. */
export function resultText(content: readonly unknown[]): string {
  return content
    .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : JSON.stringify(item)))
    .join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
