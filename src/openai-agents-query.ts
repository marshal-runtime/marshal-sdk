import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Editor, MCPServer, ModelProvider, Shell, ShellAction, ShellResult, Tool } from "@openai/agents";

import type { QueryFn } from "./agent-port.js";
import { PROVIDER_TOOLS } from "./provider-query.js";
import type { RuntimeTool } from "./providers.js";

export interface OpenAIAgentsQueryOptions {
  /** The OpenAI API key (from the credential resolver). */
  apiKey: string;
  /** Test hook: the model provider; default the Agents SDK's OpenAI provider (Responses API) on `apiKey`. */
  modelProvider?: ModelProvider;
  /**
   * The Agents SDK's local shell and apply_patch tools, run on this host in the session's working directory.
   * Default true; false leaves sessions with the marshal tools and MCP servers only.
   */
  localTools?: boolean;
  /** Most model calls one turn may make. Default 100. */
  maxTurns?: number;
  /** Longest one shell command may run. Default 10 minutes. */
  shellTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SHELL_OUTPUT = 200_000;
const OPENAI_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

/**
 * The agent port's `query` on the OpenAI Agents SDK. A session's native id is the last response id: the next turn
 * continues from it (`previousResponseId`), and a fork continues from the parent's, so forks work as on Claude.
 */
export function createOpenAIAgentsQuery(options: OpenAIAgentsQueryOptions): QueryFn {
  return (params) => turn(params, options);
}

async function* turn(
  params: { prompt: unknown; options: Record<string, unknown> },
  options: OpenAIAgentsQueryOptions,
): AsyncGenerator<Record<string, any>> {
  const turnOptions = params.options;
  if (turnOptions.resumeSessionAt) {
    throw new Error("Forking at an earlier message needs the Claude provider; OpenAI sessions fork from their latest turn.");
  }
  const agents = await import("@openai/agents");
  const cwd = String(turnOptions.cwd ?? process.cwd());
  const env = (turnOptions.env ?? {}) as Record<string, string>;
  const servers = (turnOptions.mcpServers ?? {}) as Record<string | symbol, unknown>;
  const runtimeTools = (servers[PROVIDER_TOOLS] as RuntimeTool[] | undefined) ?? [];
  const previousResponseId = typeof turnOptions.resume === "string" ? turnOptions.resume : undefined;
  const abort = turnOptions.abortController instanceof AbortController ? turnOptions.abortController : undefined;

  const tools: Tool[] = runtimeTools.map((runtimeTool) =>
    agents.tool({
      name: runtimeTool.name,
      description: runtimeTool.description ?? runtimeTool.name,
      parameters: (runtimeTool.parameters ?? { type: "object", properties: {}, additionalProperties: true }) as never,
      strict: false,
      execute: async (input: unknown) =>
        runtimeTool.handler(input, { sessionId: previousResponseId ?? "", toolCallId: "", toolName: runtimeTool.name, arguments: input }),
    }),
  );
  if (options.localTools !== false) {
    tools.push(agents.shellTool({ shell: localShell(cwd, env, options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS) }));
    tools.push(agents.applyPatchTool({ editor: localEditor(cwd, agents.applyDiff) }));
  }
  const mcpServers = mcpServersOf(agents, servers, cwd);
  const systemPrompt = turnOptions.systemPrompt;
  const effort = typeof turnOptions.effort === "string" && OPENAI_EFFORTS.has(turnOptions.effort) ? turnOptions.effort : undefined;
  const outputFormat = turnOptions.outputFormat as { type?: string; schema?: Record<string, unknown> } | undefined;
  const agent = new agents.Agent({
    name: "Marshal",
    instructions: typeof systemPrompt === "string" ? systemPrompt : "",
    ...(typeof turnOptions.model === "string" && turnOptions.model ? { model: turnOptions.model } : {}),
    ...(effort ? { modelSettings: { reasoning: { effort: effort as never } } } : {}),
    tools,
    mcpServers,
    ...(outputFormat?.type === "json_schema" && outputFormat.schema
      ? { outputType: { type: "json_schema" as const, name: "output", strict: false, schema: outputFormat.schema as never } }
      : {}),
  });
  const runner = new agents.Runner({
    modelProvider: options.modelProvider ?? new agents.OpenAIProvider({ apiKey: options.apiKey }),
    // Nothing leaves this host for OpenAI's trace viewer unless a host opts in.
    tracingDisabled: true,
  });

  let connected: MCPServer[] = [];
  try {
    for (const server of mcpServers) {
      await server.connect();
      connected.push(server);
    }
    const input = await inputOf(params.prompt);
    const result = await runner.run(agent, input as never, {
      maxTurns: typeof turnOptions.maxTurns === "number" ? turnOptions.maxTurns : (options.maxTurns ?? DEFAULT_MAX_TURNS),
      ...(previousResponseId ? { previousResponseId } : {}),
      ...(abort ? { signal: abort.signal } : {}),
    });
    const sessionId = result.lastResponseId ?? previousResponseId ?? "";
    yield { type: "system", subtype: "init", session_id: sessionId };
    let lastText = "";
    for (const item of result.newItems) {
      if (item.type !== "message_output_item") continue;
      const text = agents.extractAllTextOutput([item]);
      if (!text) continue;
      lastText = text;
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
    }
    const usage = usageOf(result.rawResponses);
    let finalOutput = result.finalOutput as unknown;
    // A JSON-schema output type comes back as the model's JSON text.
    if (outputFormat?.type === "json_schema" && typeof finalOutput === "string") {
      try {
        finalOutput = JSON.parse(finalOutput) as unknown;
      } catch {
        // Not JSON: left as the answer text, without structured output.
      }
    }
    const structured = outputFormat?.type === "json_schema" && finalOutput !== undefined && typeof finalOutput !== "string";
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: typeof finalOutput === "string" && finalOutput ? finalOutput : structured ? JSON.stringify(finalOutput) : lastText,
      ...(structured ? { structured_output: finalOutput } : {}),
      usage,
      total_cost_usd: 0,
      num_turns: result.rawResponses.length,
      session_id: sessionId,
    };
  } catch (error) {
    if (abort?.signal.aborted) throw Object.assign(new Error("Turn cancelled."), { name: "AbortError" });
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(`openai turn failed: ${message}`);
    if (previousResponseId) yield { type: "system", subtype: "init", session_id: previousResponseId };
    yield {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: message,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: 0,
      num_turns: 0,
    };
  } finally {
    for (const server of connected) await server.close().catch(() => undefined);
    connected = [];
  }
}

function usageOf(responses: readonly { usage?: { inputTokens?: number; outputTokens?: number; inputTokensDetails?: unknown } }[]) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const response of responses) {
    usage.input_tokens += response.usage?.inputTokens ?? 0;
    usage.output_tokens += response.usage?.outputTokens ?? 0;
    const details = response.usage?.inputTokensDetails;
    for (const entry of Array.isArray(details) ? details : details ? [details] : []) {
      const cached = (entry as { cached_tokens?: unknown }).cached_tokens;
      if (typeof cached === "number") usage.cache_read_input_tokens += cached;
    }
  }
  return usage;
}

/** Stdio and HTTP servers in the Claude SDK's shape as Agents SDK servers; in-process servers are dropped. */
function mcpServersOf(agents: typeof import("@openai/agents"), servers: Record<string | symbol, unknown>, cwd: string): MCPServer[] {
  const result: MCPServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== "object") continue;
    const record = server as Record<string, unknown>;
    if (record.type === "sdk") continue;
    const headers = record.headers && typeof record.headers === "object" ? (record.headers as Record<string, string>) : undefined;
    if (record.type === "http" && typeof record.url === "string") {
      result.push(new agents.MCPServerStreamableHttp({ name, url: record.url, ...(headers ? { requestInit: { headers } } : {}) }));
    } else if (record.type === "sse" && typeof record.url === "string") {
      result.push(new agents.MCPServerSSE({ name, url: record.url, ...(headers ? { requestInit: { headers } } : {}) }));
    } else if (typeof record.command === "string") {
      result.push(
        new agents.MCPServerStdio({
          name,
          command: record.command,
          args: Array.isArray(record.args) ? record.args.map(String) : [],
          cwd,
          ...(record.env && typeof record.env === "object" ? { env: record.env as Record<string, string> } : {}),
        }),
      );
    }
  }
  return result;
}

/** The port's prompt as Agents SDK input: a string, or one user message whose images become input_image parts. */
async function inputOf(prompt: unknown): Promise<string | unknown[]> {
  if (typeof prompt === "string") return prompt;
  const content: unknown[] = [];
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const message of prompt as AsyncIterable<Record<string, any>>) {
      for (const block of message?.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") content.push({ type: "input_text", text: block.text });
        else if (block?.type === "image" && block.source?.type === "base64") {
          content.push({ type: "input_image", image: `data:${block.source.media_type};base64,${block.source.data}` });
        }
      }
    }
  }
  return [{ role: "user", content }];
}

/** The Agents SDK shell tool, run by this host: each command in the session's working directory. */
export function localShell(cwd: string, env: Record<string, string>, timeoutMs: number): Shell {
  return {
    async run(action: ShellAction): Promise<ShellResult> {
      const limit = Math.min(action.maxOutputLength ?? MAX_SHELL_OUTPUT, MAX_SHELL_OUTPUT);
      const output: ShellResult["output"] = [];
      for (const command of action.commands) {
        output.push(await runCommand(command, cwd, { ...process.env, ...env }, action.timeoutMs ?? timeoutMs, limit));
      }
      return { output, maxOutputLength: limit };
    },
  };
}

function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, limit: number) {
  return new Promise<ShellResult["output"][number]>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const take = (current: string, chunk: Buffer) => (current.length >= limit ? current : (current + chunk.toString("utf8")).slice(0, limit));
    child.stdout.on("data", (chunk: Buffer) => (stdout = take(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = take(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, outcome: { type: "exit", exitCode: 127 } });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, outcome: timedOut ? { type: "timeout" } : { type: "exit", exitCode: code } });
    });
  });
}

/** The Agents SDK apply_patch tool, applied by this host to files under the session's working directory. */
export function localEditor(cwd: string, applyDiff: (input: string, diff: string, mode?: "default" | "create") => string): Editor {
  const resolve = (file: string) => path.resolve(cwd, file);
  const failed = (error: unknown) => ({ status: "failed" as const, output: error instanceof Error ? error.message : String(error) });
  return {
    async createFile(operation) {
      try {
        const file = resolve(operation.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, applyDiff("", operation.diff, "create"));
        return { status: "completed", output: `Created ${operation.path}` };
      } catch (error) {
        return failed(error);
      }
    },
    async updateFile(operation) {
      try {
        const file = resolve(operation.path);
        const next = applyDiff(fs.readFileSync(file, "utf8"), operation.diff);
        const target = operation.moveTo ? resolve(operation.moveTo) : file;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, next);
        if (target !== file) fs.rmSync(file);
        return { status: "completed", output: `Updated ${operation.moveTo ?? operation.path}` };
      } catch (error) {
        return failed(error);
      }
    },
    async deleteFile(operation) {
      try {
        fs.rmSync(resolve(operation.path));
        return { status: "completed", output: `Deleted ${operation.path}` };
      } catch (error) {
        return failed(error);
      }
    },
  };
}
