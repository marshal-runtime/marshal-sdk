import { randomUUID } from "node:crypto";

import type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeMcpServerConfig,
  RuntimeSessionConfig,
  RuntimeSessionEvent,
  RuntimeTool,
} from "./providers.js";
import { systemPromptText, TURN_EXTRAS, type QueryFn, type TurnExtras } from "./agent-port.js";

/**
 * Where a host puts the provider-neutral form of a session's Marshal tools inside the MCP-server record it hands the
 * agent port. The Claude Agent SDK reads only string keys, so this rides along unseen on the Claude path.
 */
export const PROVIDER_TOOLS: unique symbol = Symbol.for("marshal-sdk.provider-tools");

/**
 * Set beside PROVIDER_TOOLS when those tools are all the session may call: no built-in tool of the provider and no
 * other MCP server. A remote session's tools run on another machine, while a provider client's built-ins (a shell,
 * file tools) would run in this process's machine, so the host sets it on every remote session (SB01).
 */
export const PROVIDER_TOOLS_ONLY: unique symbol = Symbol.for("marshal-sdk.provider-tools-only");

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
  const extras = (turnOptions as Record<symbol, unknown>)[TURN_EXTRAS] as TurnExtras | undefined;
  const cwd = String(turnOptions.cwd ?? process.cwd());
  const client = await clientFor(cwd);
  const config = sessionConfig(turnOptions, cwd, extras);
  let resume = typeof turnOptions.resume === "string" ? turnOptions.resume : undefined;
  if (turnOptions.forkSession) {
    // A fork between turns: a copy of the source's native state under a new id, which the turn then resumes.
    if (!resume || !client.readNativeState || !client.writeNativeState) {
      throw new Error("Forking a session needs a provider that keeps its native state (Claude); this host runs another provider.");
    }
    if (turnOptions.resumeSessionAt !== undefined) throw new Error("Forking at an earlier message needs the Claude Agent SDK engine.");
    const state = await client.readNativeState(resume, cwd);
    if (!state) throw new Error(`No native state for session ${resume} to fork.`);
    const forked = randomUUID();
    await client.writeNativeState(forked, cwd, { ...state, skipHistory: true });
    resume = forked;
  }
  const session: RuntimeClientSession = resume
    ? await client.resumeSession(resume, config)
    : await client.createSession(config);
  yield { type: "system", subtype: "init", session_id: session.sessionId };

  const text = await promptText(params.prompt);
  const attachments = (extras?.attachments ?? []).map((file) => ({ type: "file" as const, path: file }));
  const outbox: Record<string, any>[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failed: string | undefined;
  let lastText = "";
  let structured: unknown;
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
        if (event.data.structuredOutput !== undefined) structured = event.data.structuredOutput;
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
    yield turnResult({ failed, lastText, structured, wanted: config.responseSchema !== undefined, usage, cost, modelCalls, sessionId: session.sessionId });
  } finally {
    clearTimeout(timer);
    abort?.signal.removeEventListener("abort", onAbort);
    unsubscribe();
    await session.disconnect().catch((error: unknown) => options.log?.(`provider session disconnect: ${String(error)}`));
  }
}

/** The turn's final `result` message, in the Claude Agent SDK's shape (structured_output included). */
export function turnResult(turn: {
  failed: string | undefined;
  lastText: string;
  structured: unknown;
  /** The turn asked for structured output (outputFormat). */
  wanted: boolean;
  usage: Record<string, number>;
  cost: number;
  modelCalls: number;
  sessionId: string;
}): Record<string, any> {
  // As on the Claude Agent SDK, a turn that asked for structured output and got none is an error, never a success
  // without its answer.
  const missing = !turn.failed && turn.wanted && (turn.structured === undefined || turn.structured === null);
  const failed = turn.failed ?? (missing ? "The model finished without the structured output the turn asked for." : undefined);
  return {
    type: "result",
    subtype: turn.failed ? "error_during_execution" : missing ? "error_max_structured_output_retries" : "success",
    is_error: failed !== undefined,
    result: failed ?? turn.lastText,
    ...(failed === undefined && turn.wanted ? { structured_output: turn.structured } : {}),
    usage: turn.usage,
    total_cost_usd: turn.cost,
    num_turns: turn.modelCalls,
    session_id: turn.sessionId,
  };
}

/** The JSON schema of a launch's `outputFormat` (`{type: "json_schema", schema}`), as the provider's response schema. */
export function responseSchemaOf(outputFormat: unknown): Record<string, unknown> | undefined {
  if (outputFormat === undefined || outputFormat === null) return undefined;
  const format = outputFormat as { type?: unknown; schema?: unknown };
  if (format.type !== "json_schema" || !format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
    throw new Error('outputFormat must be {type: "json_schema", schema: {...}} on this provider.');
  }
  return format.schema as Record<string, unknown>;
}

export function sessionConfig(turnOptions: Record<string, unknown>, cwd: string, extras: TurnExtras | undefined): RuntimeSessionConfig {
  const servers = (turnOptions.mcpServers ?? {}) as Record<string | symbol, unknown>;
  const tools = (servers[PROVIDER_TOOLS] as RuntimeTool[] | undefined) ?? [];
  const toolsOnly = servers[PROVIDER_TOOLS_ONLY] === true;
  const mcpServers: Record<string, RuntimeMcpServerConfig> = {};
  // A session limited to its provider tools gets no MCP server either.
  for (const [name, server] of toolsOnly ? [] : Object.entries(servers)) {
    const converted = mcpServerConfig(server);
    if (converted) mcpServers[name] = converted;
  }
  const systemPrompt = systemPromptText(turnOptions.systemPrompt);
  const responseSchema = responseSchemaOf(turnOptions.outputFormat);
  return {
    // An empty model lets the provider pick its own default.
    ...(typeof turnOptions.model === "string" && turnOptions.model ? { model: turnOptions.model } : {}),
    ...(typeof turnOptions.effort === "string" ? { reasoningEffort: turnOptions.effort as never } : {}),
    workingDirectory: cwd,
    cwd,
    streaming: true,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(tools.length ? { tools } : {}),
    // The provider's strict allowlist: exactly these tools, so none of its built-ins.
    ...(toolsOnly ? { availableTools: tools.map((tool) => tool.name) } : {}),
    ...(responseSchema ? { responseSchema } : {}),
    ...(typeof systemPrompt === "string" ? { systemMessage: { content: systemPrompt, mode: "replace" as const } } : {}),
    ...(Array.isArray(turnOptions.disallowedTools) && turnOptions.disallowedTools.length
      ? { disabledBuiltInTools: turnOptions.disallowedTools.map(String) }
      : {}),
    // The client enforces the allowlist in its PreToolUse hook, which runs only when the session has one.
    ...(extras?.nativeSubagentAllowlist
      ? { nativeSubagentAllowlist: [...extras.nativeSubagentAllowlist], hooks: { onPreToolUse: () => undefined } }
      : {}),
    // The Agent SDK's empty setting sources: nothing from the checkout (rules, skills, agents).
    ...(Array.isArray(turnOptions.settingSources) && turnOptions.settingSources.length === 0 ? { projectContext: false } : {}),
    // An unattended host has nobody to approve; what a run may do is decided by what is installed on it.
    // Claude denies every tool without a handler; Codex runs in a read-only sandbox unless told otherwise.
    onPermissionRequest: extras?.permissionHandler ?? (() => ({ kind: "approve-once" })),
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

/** The port's prompt text: a string, or the text of one user message (its files come as paths in TURN_EXTRAS). */
export async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const texts: string[] = [];
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const message of prompt as AsyncIterable<Record<string, any>>) {
      for (const block of message?.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
  }
  return texts.join("\n");
}
