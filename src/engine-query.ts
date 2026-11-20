import { createHash, randomUUID } from "node:crypto";

import { TURN_EXTRAS, type QueryFn, type TurnExtras } from "./agent-port.js";
import { ensureEngineHost } from "./headless-engine.js";
import { promptText, sessionConfig } from "./provider-query.js";
import {
  ANTIGRAVITY_ACCOUNT_IDENTITY_PREFIX,
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  ANTIGRAVITY_PREFERRED_MODEL_IDS,
  ANTIGRAVITY_RUNTIME_ID,
  ANTIGRAVITY_SESSION_CONFIG_TRACE_FILENAME,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  createLocalRuntimeCapabilities,
  CURSOR_ACCOUNT_IDENTITY_PREFIX,
  CURSOR_DEFAULT_MODEL_ID,
  CURSOR_PREFERRED_MODEL_IDS,
  CURSOR_RUNTIME_ID,
  CURSOR_SESSION_CONFIG_TRACE_FILENAME,
  getRuntimeMetadata,
  LocalBackend,
  type BackendEvent,
  type CreateSessionOpts,
  type LocalRuntimeStrategy,
  type RuntimeClient,
  type RuntimeClientFactory,
  type RuntimeMcpServerConfig,
  type RuntimePermissionHandler,
  type RuntimePermissionResult,
  type RuntimeTool,
} from "./providers.js";

export type EngineRuntime = "claude" | "codex" | "cursor" | "antigravity";

/**
 * The desktop's runtime strategies (electron/backend/<runtime>/strategy.ts) for a headless host: the same runtime ids,
 * compatibility origins, default models and capabilities. Workspace prompt files are the host prompt's job here.
 */
export function engineStrategy(runtime: EngineRuntime): LocalRuntimeStrategy {
  switch (runtime) {
    case "claude": {
      const metadata = getRuntimeMetadata(CLAUDE_RUNTIME_ID);
      return {
        runtimeId: CLAUDE_RUNTIME_ID,
        origin: metadata.compatibilityOrigin as LocalRuntimeStrategy["origin"],
        displayName: metadata.displayName,
        sessionConfigTraceFilename: "m-claude-session-config-trace.jsonl",
        defaultInferenceModel: "sonnet",
        preferredDefaultModelIds: ["sonnet", "opus", "haiku"],
        accountIdentityPrefix: "anthropic",
        capabilities: createLocalRuntimeCapabilities({ sessionCompaction: true, sessionFork: true }),
        loadWorkspaceFiles: () => null,
      };
    }
    case "codex": {
      const metadata = getRuntimeMetadata(CODEX_RUNTIME_ID);
      return {
        runtimeId: CODEX_RUNTIME_ID,
        origin: metadata.compatibilityOrigin as LocalRuntimeStrategy["origin"],
        displayName: metadata.displayName,
        sessionConfigTraceFilename: "m-codex-session-config-trace.jsonl",
        defaultInferenceModel: "gpt-5.4",
        preferredDefaultModelIds: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
        accountIdentityPrefix: "openai",
        capabilities: createLocalRuntimeCapabilities({ busyTurnSteer: true, sessionCompaction: true }),
        loadWorkspaceFiles: () => null,
        defaultClientLoginRequest: { type: "browser" },
      };
    }
    case "cursor": {
      const metadata = getRuntimeMetadata(CURSOR_RUNTIME_ID);
      return {
        runtimeId: CURSOR_RUNTIME_ID,
        origin: metadata.compatibilityOrigin as LocalRuntimeStrategy["origin"],
        displayName: metadata.displayName,
        sessionConfigTraceFilename: CURSOR_SESSION_CONFIG_TRACE_FILENAME,
        defaultInferenceModel: CURSOR_DEFAULT_MODEL_ID,
        preferredDefaultModelIds: CURSOR_PREFERRED_MODEL_IDS,
        accountIdentityPrefix: CURSOR_ACCOUNT_IDENTITY_PREFIX,
        capabilities: createLocalRuntimeCapabilities({ sessionCompaction: true, busyTurnSteer: true }),
        loadWorkspaceFiles: () => null,
        defaultClientLoginRequest: { type: "browser" },
      };
    }
    case "antigravity": {
      const metadata = getRuntimeMetadata(ANTIGRAVITY_RUNTIME_ID);
      return {
        runtimeId: ANTIGRAVITY_RUNTIME_ID,
        origin: metadata.compatibilityOrigin as LocalRuntimeStrategy["origin"],
        displayName: metadata.displayName,
        sessionConfigTraceFilename: ANTIGRAVITY_SESSION_CONFIG_TRACE_FILENAME,
        defaultInferenceModel: ANTIGRAVITY_DEFAULT_MODEL_ID,
        preferredDefaultModelIds: ANTIGRAVITY_PREFERRED_MODEL_IDS,
        accountIdentityPrefix: ANTIGRAVITY_ACCOUNT_IDENTITY_PREFIX,
        capabilities: createLocalRuntimeCapabilities(),
        loadWorkspaceFiles: () => null,
      };
    }
  }
}

/**
 * The desktop's LocalBackend with a headless host's per-session pieces: the Marshal tools and MCP servers the host
 * gives each session, and its permission handler. The engine reads them where the desktop reads its self-tools,
 * MCP broker and approval broker.
 */
export class EngineBackend extends LocalBackend {
  readonly toolsBySession = new Map<string, RuntimeTool[]>();
  readonly mcpBySession = new Map<string, Record<string, RuntimeMcpServerConfig>>();
  readonly permissionBySession = new Map<string, RuntimePermissionHandler | undefined>();

  constructor(config: { workspaceDir: string; clientFactory: RuntimeClientFactory; strategy: LocalRuntimeStrategy }) {
    super(config);
    this.setSelfToolDeps({
      sessionManager: { getExclusiveSessionTools: (sessionId: string) => this.toolsBySession.get(sessionId) ?? [] },
      settingsManager: { get: () => ({}), update: () => undefined },
    } as never);
    this.setApprovalCallback(async (request) => {
      const handler = this.permissionBySession.get(request.sessionId);
      // An unattended host has nobody to approve; what a run may do is decided by what is installed on it.
      if (!handler) return "approved";
      return toApprovalResult(await handler(request as never, { sessionId: request.sessionId }));
    });
  }

  override async prepareMcpConfig(sessionId: string): Promise<Record<string, RuntimeMcpServerConfig>> {
    return this.mcpBySession.get(sessionId) ?? {};
  }
}

function toApprovalResult(result: RuntimePermissionResult) {
  if (result.kind === "approve-once") return "approved" as const;
  if (result.kind === "reject" && result.feedback) return { kind: "denied-by-policy-with-feedback" as const, feedback: result.feedback };
  if (result.kind === "user-not-available" || result.kind === "no-result") return "denied-by-rules" as const;
  return "denied-interactively-by-user" as const;
}

export interface EngineQueryOptions {
  runtime: EngineRuntime;
  /** The provider's client factory (createClaudeClientFactory, createCodexClientFactory, createCursorClientFactory). */
  factory: RuntimeClientFactory;
  /** Runs once per client before its first session, e.g. an API-key login into a private credential home. */
  prepare?: (client: RuntimeClient) => Promise<void>;
  /** Where the engine keeps its traces and browser output when no embedder configured it. */
  appDataDir?: string;
  /** Longest a turn may run before it is stopped. Default 2 hours. */
  turnTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

interface LiveEngineSession {
  backend: EngineBackend;
  backendId: string;
  /** What the session was created with; a change (a new prompt layer, tool surface) re-opens it on the same native session. */
  signature: string;
  model?: string;
}

/**
 * The agent port's `query` on the Marshal session engine: the desktop's LocalBackend (electron/backend/local), lifted
 * into packages/providers, runs every turn. A Marshal session keeps one live engine session across turns, as on the
 * desktop; a later run of the host resumes it by its native id.
 */
export function createEngineQuery(options: EngineQueryOptions): QueryFn & { dispose(): Promise<void> } {
  ensureEngineHost(options.appDataDir);
  const strategy = engineStrategy(options.runtime);
  const backends = new Map<string, EngineBackend>();
  const live = new Map<string, LiveEngineSession>();
  const backendFor = (cwd: string): EngineBackend => {
    let backend = backends.get(cwd);
    if (!backend) {
      const factory: RuntimeClientFactory = async (workspaceDir) => {
        const client = await options.factory(workspaceDir);
        await options.prepare?.(client);
        return client;
      };
      backend = new EngineBackend({ workspaceDir: cwd, clientFactory: factory, strategy });
      backends.set(cwd, backend);
    }
    return backend;
  };

  const query = (params: { prompt: unknown; options: Record<string, unknown> }) => engineTurn(params, backendFor, live, options);
  return Object.assign(query, {
    async dispose() {
      for (const [sessionId, session] of live) {
        await session.backend.sessions.disconnect(sessionId).catch(() => undefined);
      }
      live.clear();
      for (const backend of backends.values()) await backend.destroy().catch(() => undefined);
      backends.clear();
    },
  });
}

async function* engineTurn(
  params: { prompt: unknown; options: Record<string, unknown> },
  backendFor: (cwd: string) => EngineBackend,
  live: Map<string, LiveEngineSession>,
  options: EngineQueryOptions,
): AsyncGenerator<Record<string, any>> {
  const turnOptions = params.options;
  const extras = (turnOptions as Record<symbol, unknown>)[TURN_EXTRAS] as TurnExtras | undefined;
  const sessionId = extras?.sessionId ?? randomUUID();
  const cwd = String(turnOptions.cwd ?? process.cwd());
  const backend = backendFor(cwd);
  const config = sessionConfig(turnOptions, cwd, extras);
  backend.toolsBySession.set(sessionId, [...(config.tools ?? [])]);
  backend.mcpBySession.set(sessionId, { ...config.mcpServers });
  backend.permissionBySession.set(sessionId, extras?.permissionHandler);

  const systemPrompt = config.systemMessage?.content;
  const model = typeof config.model === "string" ? config.model : undefined;
  const sessionOptions: CreateSessionOpts = {
    sessionId,
    ...(model ? { model } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort as never } : {}),
    ...(systemPrompt !== undefined ? { systemMessage: systemPrompt, systemMessageMode: "replace" as const } : {}),
    workspaceDir: cwd,
    ...(config.disabledBuiltInTools?.length ? { disabledBuiltInTools: [...config.disabledBuiltInTools] } : {}),
    ...(config.nativeSubagentAllowlist ? { nativeSubagentAllowlist: [...config.nativeSubagentAllowlist] } : {}),
    ...(config.projectContext === false ? { projectContext: false } : {}),
    // The host's prompt names the session's tools once; no per-turn availability line.
    hostToolTurnNote: false,
    sandbox: { mode: "danger-full-access" } as never,
  };
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt,
        cwd,
        tools: (config.tools ?? []).map((tool) => tool.name),
        mcp: Object.keys(config.mcpServers ?? {}),
        disabled: config.disabledBuiltInTools,
        allowlist: config.nativeSubagentAllowlist,
        projectContext: config.projectContext,
      }),
    )
    .digest("hex");

  let current = live.get(sessionId);
  if (current && (current.backend !== backend || current.signature !== signature)) {
    await current.backend.sessions.disconnect(sessionId).catch(() => undefined);
    live.delete(sessionId);
    current = undefined;
  }
  if (!current) {
    let resume = typeof turnOptions.resume === "string" ? turnOptions.resume : undefined;
    if (turnOptions.forkSession) {
      // A fork between turns: a copy of the source's native state under a new id, which the session then resumes.
      if (turnOptions.resumeSessionAt !== undefined) throw new Error("Forking at an earlier message needs the Claude Agent SDK engine.");
      if (!resume) throw new Error("Forking a session needs the session it continues.");
      if (!backend.getClient()) await backend.initClient();
      const client = backend.getClient();
      if (!client?.readNativeState || !client.writeNativeState) {
        throw new Error("Forking a session needs a provider that keeps its native state (Claude); this host runs another provider.");
      }
      const state = await client.readNativeState(resume, cwd);
      if (!state) throw new Error(`No native state for session ${resume} to fork.`);
      const forked = randomUUID();
      await client.writeNativeState(forked, cwd, { ...state, skipHistory: true });
      resume = forked;
    }
    const handle = resume
      ? await backend.sessions.resume(sessionId, { ...sessionOptions, backendId: resume })
      : await backend.sessions.create(sessionOptions);
    current = { backend, backendId: handle.backendId, signature, ...(model ? { model } : {}) };
    live.set(sessionId, current);
  } else if (model && model !== current.model) {
    await backend.sessions.setModel(sessionId, model, config.reasoningEffort ? { reasoningEffort: config.reasoningEffort as never } : undefined);
    current.model = model;
  }
  yield { type: "system", subtype: "init", session_id: current.backendId };

  const text = await promptText(params.prompt);
  const attachments = (extras?.attachments ?? []).map((file) => ({ type: "file" as const, path: file }));
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
  const unsubscribe = backend.sessions.subscribe(sessionId, (event: BackendEvent) => {
    switch (event.type) {
      case "turn-complete": {
        const content = typeof event.message?.content === "string" ? event.message.content : "";
        if (content) {
          lastText = content;
          push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: content }] } });
        }
        break;
      }
      case "llm-usage":
        modelCalls += 1;
        usage.input_tokens += event.inputTokens ?? 0;
        usage.output_tokens += event.outputTokens ?? 0;
        usage.cache_read_input_tokens += event.cacheReadTokens ?? 0;
        usage.cache_creation_input_tokens += event.cacheWriteTokens ?? 0;
        cost += event.cost ?? 0;
        break;
      case "tool-start":
        push({ type: "provider.tool", tool: event.toolName, toolCallId: event.toolCallId });
        break;
      case "turn-error":
        if (!event.retrying) {
          failed = event.error || "The provider reported an error.";
          finish();
        }
        break;
      case "idle":
        finish();
        break;
      default:
        break;
    }
  });

  const abort = turnOptions.abortController instanceof AbortController ? turnOptions.abortController : undefined;
  const onAbort = () => {
    void backend.sessions.abort(sessionId).catch(() => undefined);
    finish();
  };
  abort?.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    failed = `The turn ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`;
    void backend.sessions.abort(sessionId).catch(() => undefined);
    finish();
  }, timeoutMs);
  timer.unref?.();

  try {
    await backend.sessions.send(sessionId, { prompt: text, ...(attachments.length ? { attachments } : {}) } as never);
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
      session_id: current.backendId,
    };
  } finally {
    clearTimeout(timer);
    abort?.signal.removeEventListener("abort", onAbort);
    unsubscribe();
    if (failed !== undefined) {
      // A failed engine session is re-opened from its native id on the next turn.
      await backend.sessions.disconnect(sessionId).catch((error: unknown) => options.log?.(`engine session disconnect: ${String(error)}`));
      live.delete(sessionId);
    }
  }
}
