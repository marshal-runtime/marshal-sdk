import type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeMcpServerConfig,
  RuntimeSessionConfig,
  RuntimeSessionEvent,
  RuntimeTool,
} from "./providers.js";
import type { QueryFn } from "./agent-port.js";

/**
 * Where a host puts the provider-neutral form of a session's Marshal tools inside the MCP-server record it hands the
 * agent port. The Claude Agent SDK reads only string keys, so this rides along unseen on the Claude path.
 */
export const PROVIDER_TOOLS: unique symbol = Symbol.for("marshal-sdk.provider-tools");

export interface ProviderQueryOptions {
  /** The provider's client factory (createClaudeClientFactory, createCodexClientFactory, createCursorClientFactory). */
  factory: RuntimeClientFactory;
  /** Runs once per client before its first session, e.g. an API-key login into a private credential home. */
  prepare?: (client: RuntimeClient) => Promise<void>;
  /** Longest a turn may run before it is stopped. Default 2 hours. */
  turnTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * The agent port's `query` on a Marshal provider client: the same clients the Marshal desktop runs its sessions on.
 * Each call is one turn of a session; the first turn creates the native session, later ones resume it by id.
 */
export function createProviderQuery(options: ProviderQueryOptions): QueryFn & { dispose(): Promise<void> } {
  const clients = new Map<string, Promise<RuntimeClient>>();
  const clientFor = (cwd: string): Promise<RuntimeClient> => {
    let client = clients.get(cwd);
    if (!client) {
      client = (async () => {
        const created = await options.factory(cwd);
        await options.prepare?.(created);
        return created;
      })();
      client.catch(() => clients.delete(cwd));
      clients.set(cwd, client);
    }
    return client;
  };

  const query = (params: { prompt: unknown; options: Record<string, unknown> }) =>
    turn(params, clientFor, options);
  return Object.assign(query, {
    async dispose() {
      for (const client of clients.values()) {
        await client.then((resolved) => resolved.stop()).catch(() => undefined);
      }
      clients.clear();
    },
  });
}

async function* turn(
  params: { prompt: unknown; options: Record<string, unknown> },
  clientFor: (cwd: string) => Promise<RuntimeClient>,
  options: ProviderQueryOptions,
): AsyncGenerator<Record<string, any>> {
  const turnOptions = params.options;
  if (turnOptions.forkSession) {
    throw new Error("Forking a session needs the Claude provider; this host runs another provider.");
  }
  const cwd = String(turnOptions.cwd ?? process.cwd());
  const client = await clientFor(cwd);
  const config = sessionConfig(turnOptions, cwd);
  const resume = typeof turnOptions.resume === "string" ? turnOptions.resume : undefined;
  const session: RuntimeClientSession = resume
    ? await client.resumeSession(resume, config)
    : await client.createSession(config);
  yield { type: "system", subtype: "init", session_id: session.sessionId };

  const { text, attachments } = await promptParts(params.prompt);
  const outbox: Record<string, any>[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failed: string | undefined;
  let lastText = "";
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let cost = 0;
  let modelCalls = 0;
  const push = (event: Record<string, any>) => {
    outbox.push(event);
    wake?.();
  };
  const finish = () => {
    done = true;
    wake?.();
  };
  const unsubscribe = session.on((event: RuntimeSessionEvent) => {
    switch (event.type) {
      case "assistant.message":
        if (event.data.content) {
          lastText = event.data.content;
          push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: event.data.content }] } });
        }
        break;
      case "assistant.usage":
        modelCalls += 1;
        usage.input_tokens += event.data.inputTokens ?? 0;
        usage.output_tokens += event.data.outputTokens ?? 0;
        usage.cache_read_input_tokens += event.data.cacheReadTokens ?? 0;
        usage.cache_creation_input_tokens += event.data.cacheWriteTokens ?? 0;
        cost += event.data.cost ?? 0;
        break;
      case "tool.execution_start":
        push({ type: "provider.tool", tool: event.data.toolName, toolCallId: event.data.toolCallId });
        break;
      case "session.error":
        failed = event.data.message ?? event.data.errorType ?? "The provider reported an error.";
        finish();
        break;
      case "session.idle":
        finish();
        break;
      default:
        break;
    }
  });

  const abort = turnOptions.abortController instanceof AbortController ? turnOptions.abortController : undefined;
  const onAbort = () => {
    void session.abort().catch(() => undefined);
    finish();
  };
  abort?.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    failed = `The turn ran longer than ${Math.round((options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60_000)} minutes and was stopped.`;
    void session.abort().catch(() => undefined);
    finish();
  }, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  timer.unref?.();

  try {
    await session.send({ prompt: text, ...(attachments.length ? { attachments } : {}) });
    while (true) {
      while (outbox.length) yield outbox.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    while (outbox.length) yield outbox.shift()!;
    if (abort?.signal.aborted) throw Object.assign(new Error("Turn cancelled."), { name: "AbortError" });
    yield {
      type: "result",
      subtype: failed ? "error_during_execution" : "success",
      is_error: failed !== undefined,
      result: failed ?? lastText,
      usage,
      total_cost_usd: cost,
      num_turns: modelCalls,
      session_id: session.sessionId,
    };
  } finally {
    clearTimeout(timer);
    abort?.signal.removeEventListener("abort", onAbort);
    unsubscribe();
    await session.disconnect().catch((error: unknown) => options.log?.(`provider session disconnect: ${String(error)}`));
  }
}

function sessionConfig(turnOptions: Record<string, unknown>, cwd: string): RuntimeSessionConfig {
  const servers = (turnOptions.mcpServers ?? {}) as Record<string | symbol, unknown>;
  const tools = (servers[PROVIDER_TOOLS] as RuntimeTool[] | undefined) ?? [];
  const mcpServers: Record<string, RuntimeMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    const converted = mcpServerConfig(server);
    if (converted) mcpServers[name] = converted;
  }
  const systemPrompt = turnOptions.systemPrompt;
  return {
    // An empty model lets the provider pick its own default.
    ...(typeof turnOptions.model === "string" && turnOptions.model ? { model: turnOptions.model } : {}),
    ...(typeof turnOptions.effort === "string" ? { reasoningEffort: turnOptions.effort as never } : {}),
    workingDirectory: cwd,
    cwd,
    streaming: true,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(tools.length ? { tools } : {}),
    ...(typeof systemPrompt === "string" ? { systemMessage: { content: systemPrompt, mode: "replace" as const } } : {}),
    // An unattended host has nobody to approve; what a run may do is decided by what is installed on it.
    // Claude denies every tool without a handler; Codex runs in a read-only sandbox unless told otherwise.
    onPermissionRequest: () => ({ kind: "approve-once" }),
    sandbox: { mode: "danger-full-access" },
  };
}

/** A stdio or HTTP MCP server in the Claude SDK's shape, as a provider server config; in-process servers are dropped. */
function mcpServerConfig(server: unknown): RuntimeMcpServerConfig | undefined {
  if (!server || typeof server !== "object") return undefined;
  const record = server as Record<string, unknown>;
  if (record.type === "sdk") return undefined;
  if ((record.type === "http" || record.type === "sse") && typeof record.url === "string") {
    return {
      type: record.type,
      url: record.url,
      ...(record.headers && typeof record.headers === "object" ? { headers: record.headers as Record<string, string> } : {}),
    };
  }
  if (typeof record.command === "string") {
    return {
      type: "stdio",
      command: record.command,
      ...(Array.isArray(record.args) ? { args: record.args.map(String) } : {}),
      ...(record.env && typeof record.env === "object" ? { env: record.env as Record<string, string> } : {}),
    };
  }
  return undefined;
}

/** The port's prompt: a string, or one user message; only its text reaches non-Claude providers (images are dropped). */
async function promptParts(prompt: unknown): Promise<{ text: string; attachments: { type: "file"; path: string }[] }> {
  if (typeof prompt === "string") return { text: prompt, attachments: [] };
  const texts: string[] = [];
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const message of prompt as AsyncIterable<Record<string, any>>) {
      for (const block of message?.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
  }
  return { text: texts.join("\n"), attachments: [] };
}
