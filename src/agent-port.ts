import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";

import {
  isLocalAddress,
  senderLine,
  type DeliveryMode,
  type DeliveryResult,
  type MessageSender,
  type SessionEnvelope,
  type SessionTransport,
} from "./session-messages.js";
import type { FileSessionStore, SessionFork, SessionRecord, TranscriptMessage } from "./session-store.js";
import { nativeSubagentHook } from "./native-tools.js";
import { toClaudePermissionResult, toRuntimePermissionRequest, type RuntimePermissionHandler } from "./providers.js";

/**
 * What a turn carries for provider clients beside the Claude Agent SDK's options (which read only string keys): the
 * attached files as paths, and the native subagent allowlist the Agent SDK path enforces with a hook.
 */
export const TURN_EXTRAS: unique symbol = Symbol.for("marshal-sdk.turn-extras");
export interface TurnExtras {
  attachments: string[];
  nativeSubagentAllowlist?: string[];
  /** The launch set its own `env` (the `env` option is always set: the host's, or the launch's merged over it). */
  launchEnv?: boolean;
  /** The host's permission handler for this session's tool calls; absent, the provider approves every request. */
  permissionHandler?: RuntimePermissionHandler;
  /** The Marshal session this turn belongs to (the session engine keeps one live session per Marshal session). */
  sessionId?: string;
}

/** The Claude Agent SDK's canUseTool over a host handler: the request mapped the way the desktop's Claude client maps it. */
function claudeCanUseTool(handler: RuntimePermissionHandler, sessionId: string) {
  return async (toolName: string, input: Record<string, unknown>, options: Record<string, any>) => {
    try {
      return toClaudePermissionResult(await handler(toRuntimePermissionRequest(toolName, input, options as never), { sessionId }));
    } catch (error) {
      return { behavior: "deny" as const, message: `The permission check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

/** `hooks` with one more PreToolUse callback, after the launch's own. */
function withPreToolUse(hooks: Readonly<Record<string, unknown>> | undefined, callback: unknown): Record<string, unknown> {
  const existing = Array.isArray(hooks?.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  return { ...hooks, PreToolUse: [...existing, { hooks: [callback] }] };
}

/** How a session's queued work ended: idle with the last turn's answer (none when it was cancelled), or failed. */
export type SessionOutcome = { state: "idle"; reply?: string } | { state: "failed"; error: string };

/** The slice of the Claude Agent SDK's `query` this port relies on; tests pass a fake. */
export type QueryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<
  Record<string, any>
>;

export interface AgentSummary {
  id: string;
  name: string;
  state: "running" | "idle" | "failed";
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  workspaceName?: string;
  sessionId?: string;
  /** modelTurns: the backend's own count of model round trips (the SDK's num_turns), summed over turns. */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; modelTurns?: number };
}

/**
 * Claude Agent SDK options one launch passes to every turn of its session, on top of what the host sets. Functions
 * (hooks, the spawner) live in this process only: a session adopted by a later run of the host runs without them.
 */
export interface AgentLaunchOptions {
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Use only the MCP servers given here and by the host, ignoring the backend's own MCP config. */
  strictMcpConfig?: boolean;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /** Working folder of this session's turns instead of the host's (native history is filed under it). */
  cwd?: string;
  /** Environment of this session's backend, merged over the host's; null removes a key (say, ANTHROPIC_API_KEY). */
  env?: Readonly<Record<string, string | null>>;
  /** The Claude Code binary to run instead of the SDK's own. */
  pathToClaudeCodeExecutable?: string;
  /** Start Claude Code with --disable-slash-commands. */
  disableSlashCommands?: boolean;
  /** Extra Claude Code CLI flags (flag name without dashes to value, or null for a bare flag). */
  extraArgs?: Readonly<Record<string, string | null>>;
  /** The SDK's hooks: event name to matchers with callbacks. */
  hooks?: Readonly<Record<string, unknown>>;
  /** Structured output (`{type: "json_schema", schema}`); the parsed result is the turn's structuredOutput. */
  outputFormat?: unknown;
  /** Start the Claude Code process yourself (a remote machine, a sandbox user). */
  spawnClaudeCodeProcess?: (options: any) => unknown;
  /** MCP servers of this session, added to the host's (or alone, with hostMcpServers false). */
  mcpServers?: Readonly<Record<string, unknown>>;
  /** Give the session the host's MCP servers (the marshal runtime tools, the browser). Default true. */
  hostMcpServers?: boolean;
}

export interface AgentLaunchRequest {
  task: string;
  idempotencyKey: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  attachments?: readonly string[];
  parentId?: string;
  /** Starts a lane: a top-level session (no parent) that records the session which launched it. */
  launchedBy?: string;
  /** Who the task comes from, recorded on the first transcript message. */
  from?: MessageSender;
  labels?: Record<string, string>;
  /** The session id to use (a fork's id is written into the conversation it continues). Default: a new id. */
  sessionId?: string;
  /** Where the conversation starts: a native session to resume, or one the first turn forks (resume + forkSession). */
  native?: { sessionId?: string; forkOf?: string; forkAt?: string };
  fork?: SessionFork;
  /** SDK options for every turn of this session. */
  options?: AgentLaunchOptions;
}

export interface AgentTranscript {
  agent: AgentSummary;
  messageCount: number;
  showing: number;
  messages: TranscriptMessage[];
  result?: string;
}

export interface AgentPortOptions {
  query: QueryFn;
  /** The runtime the sessions run on (the provider id: claude, codex, cursor, openai); recorded as the session's runtimeId. Default claude. */
  runtimeId?: string;
  store: FileSessionStore;
  /** Working directory of every session, and the directory the backend files its native history under. */
  cwd: string;
  /** Environment of the backend process: credentials and config dir are the host's choice, never the agent's. */
  env: Record<string, string>;
  defaultModel: string;
  defaultReasoningEffort?: string;
  workspaceName?: string;
  /** Marshal's system prompt for a session, unless the launch replaces it. */
  systemPrompt: (session: SessionRecord) => string | undefined;
  /** MCP servers of one session; called per turn because an in-process server serves one connection. */
  mcpServers: (session: SessionRecord) => Record<string, unknown>;
  /** Tool allowlist handed to the backend; undefined leaves its defaults. */
  tools?: readonly string[];
  /**
   * Let the backend load the project's own settings and rules (Claude: CLAUDE.md, .claude/rules, project skills and
   * agents through the `project` setting source). Default false: nothing from the checkout.
   */
  projectSettings?: boolean;
  /**
   * The native tool surface of a session on the host's own prompt (not one whose launch brings its own): native
   * tools removed, and the only native subagent types it may launch (native-tools.ts).
   */
  nativeTools?: { disabled: readonly string[]; subagentAllowlist: readonly string[] };
  /**
   * Decides each tool call a session's backend asks about, in the desktop's request shape (kind, toolName, arguments).
   * Given, turns stop running with bypassPermissions; absent, every tool call is approved (an unattended host).
   */
  permissionHandler?: RuntimePermissionHandler;
  /** Live defaults read at each launch (a settings store the host changes); they win over defaultModel/defaultReasoningEffort. */
  settings?: () => { model?: string; reasoningEffort?: string };
  log?: (line: string) => void;
  /** A session finished its queued work (`session.idle`) or stopped on an error (`session.failed`). */
  onSessionEvent?: (type: "session.idle" | "session.failed", payload: Record<string, unknown>) => void;
}

interface QueuedMessage {
  id: string;
  /** The text the session reads (with the sender line when it came from someone else). */
  text: string;
  from?: MessageSender;
  attachments: readonly string[];
  /** Called with the turn's answer, or undefined when the message was dropped, interrupted or failed. */
  waiters: ((reply: string | undefined) => void)[];
}

interface LiveAgent {
  id: string;
  queue: QueuedMessage[];
  abort?: AbortController;
  running: boolean;
  lastResult?: string;
  /** The answer of the last turn that ran, undefined when it was cancelled. */
  lastReply?: string;
  systemPrompt?: string;
  idle: Promise<void>;
  launchOptions?: AgentLaunchOptions;
  /** The message uuid the first (forking) turn resumes at: resumeSessionAt. */
  forkAt?: string;
  /** The last turn's structured output (outputFormat). */
  structuredOutput?: unknown;
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_EVENT_STRING = 4_000;
const MAX_TRANSCRIPT_LIMIT = 200;

/**
 * Marshal's agent port on top of a Claude Agent SDK `query`: a launch is a Marshal session whose turns
 * are SDK queries resumed by the backend's own session id. It is the headless twin of the desktop's
 * SessionManager-backed port, so `marshal.agent.*` behaves the same for an extension on either host.
 */
export class ClaudeAgentPort {
  private readonly live = new Map<string, LiveAgent>();
  private readonly launches = new Map<string, string>();
  private readonly transports = new Map<string, SessionTransport>();
  private readonly settledListeners = new Set<(sessionId: string, outcome: SessionOutcome) => void>();

  constructor(private readonly options: AgentPortOptions) {}

  /** Called each time a session's queue runs dry or it fails (forks report to their parent this way). */
  onSettled(listener: (sessionId: string, outcome: SessionOutcome) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** The system prompt a launch gave this session in place of the host's (a fork keeps its parent's). */
  systemPromptOf(agentId: string): string | undefined {
    return this.live.get(agentId)?.systemPrompt;
  }

  /** Whether a turn of this session is running in this process now. */
  isRunning(agentId: string): boolean {
    return this.live.get(agentId)?.running === true;
  }

  /** Messages waiting behind the session's running turn. */
  queuedCount(agentId: string): number {
    return this.live.get(agentId)?.queue.length ?? 0;
  }

  /** The backend's environment (its CLAUDE_CONFIG_DIR is where native sessions are kept). */
  get backendEnv(): Readonly<Record<string, string>> {
    return this.options.env;
  }

  /** This host's id in session addresses. */
  get hostId(): string {
    return this.options.store.origin.host.id;
  }

  /** Reach the sessions of another host (the link registers one per connected host). Returns the unregister call. */
  addTransport(transport: SessionTransport): () => void {
    if (transport.hostId === this.hostId) throw new Error(`${transport.hostId} is this host; its sessions need no transport.`);
    this.transports.set(transport.hostId, transport);
    return () => {
      if (this.transports.get(transport.hostId) === transport) this.transports.delete(transport.hostId);
    };
  }

  launch(request: AgentLaunchRequest): AgentSummary {
    const existing = this.launches.get(request.idempotencyKey);
    if (existing) return this.summary(existing);
    const session = this.options.store.create({
      ...(request.sessionId ? { id: request.sessionId } : {}),
      title: request.name ?? request.task.slice(0, 80),
      runtime: this.options.runtimeId ?? "claude",
      model: request.model ?? this.options.settings?.().model ?? this.options.defaultModel,
      reasoningEffort: request.reasoningEffort ?? this.options.settings?.().reasoningEffort ?? this.options.defaultReasoningEffort,
      native: {
        kind: "claude",
        cwd: this.options.cwd,
        ...(this.options.env.CLAUDE_CONFIG_DIR ? { configDir: this.options.env.CLAUDE_CONFIG_DIR } : {}),
        ...(request.options?.cwd ? { cwd: request.options.cwd } : {}),
        ...(request.options?.env?.CLAUDE_CONFIG_DIR ? { configDir: request.options.env.CLAUDE_CONFIG_DIR } : {}),
        ...(request.native?.sessionId ? { sessionId: request.native.sessionId } : {}),
        ...(request.native?.forkOf && !request.native.sessionId ? { forkOf: request.native.forkOf } : {}),
      },
      ...(request.fork ? { fork: request.fork } : {}),
      ...(request.parentId ? { parentId: request.parentId } : {}),
      ...(request.launchedBy ? { launchedBy: request.launchedBy } : {}),
      ...(this.options.workspaceName ? { workspace: this.options.workspaceName } : {}),
      labels: request.labels,
    });
    const agent: LiveAgent = {
      id: session.id,
      queue: [],
      running: false,
      idle: Promise.resolve(),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
      ...(request.options ? { launchOptions: request.options } : {}),
      ...(request.native?.forkAt ? { forkAt: request.native.forkAt } : {}),
    };
    this.live.set(session.id, agent);
    this.launches.set(request.idempotencyKey, session.id);
    this.start(agent, {
      id: randomUUID(),
      text: request.task,
      ...(request.from ? { from: request.from } : {}),
      attachments: request.attachments ?? [],
      waiters: [],
    });
    return this.summary(session.id);
  }

  /** A message from the session's own caller (an extension, the host): no sender line. */
  send(agentId: string, message: string, deliveryMode: DeliveryMode = "queue", from?: MessageSender): AgentSummary {
    const agent = this.live.get(agentId) ?? this.adopt(agentId);
    this.enqueue(agent, { id: randomUUID(), text: message, ...(from ? { from } : {}), attachments: [], waiters: [] }, deliveryMode);
    return this.summary(agentId);
  }

  /**
   * Delivers a message from another session, a person or a host. A session on this host gets it with the sender line
   * the desktop uses ("Message from session <name> (<id>):") and `from` on its transcript message; a session on another
   * host goes through that host's transport.
   */
  async deliver(envelope: SessionEnvelope): Promise<DeliveryResult> {
    const refused = (error: string): DeliveryResult => ({ success: false, accepted: false, messageId: envelope.messageId, error });
    if (!envelope.body.trim()) return refused("message is required");
    if (!isLocalAddress(envelope.to, this.hostId)) {
      const transport = this.transports.get(envelope.to.host!);
      return transport ? transport.deliver(envelope) : refused(`No route to host ${envelope.to.host}.`);
    }
    const targetId = envelope.to.sessionId;
    if (!this.options.store.get(targetId)) return refused("Session not found");
    const from = envelope.from;
    if (from.kind === "session" && from.sessionId === targetId && isLocalAddress({ host: from.host, sessionId: targetId }, this.hostId)) {
      return refused("A session cannot message itself");
    }
    const agent = this.live.get(targetId) ?? this.adopt(targetId);
    const replacedMessageIds: string[] = [];
    if (envelope.replaceQueued) {
      const sender = senderKey(from);
      for (const queued of [...agent.queue]) {
        if (queued.from && senderKey(queued.from) === sender) {
          agent.queue.splice(agent.queue.indexOf(queued), 1);
          replacedMessageIds.push(queued.id);
          for (const waiter of queued.waiters) waiter(undefined);
        }
      }
    }
    const item: QueuedMessage = {
      id: envelope.messageId,
      text: `${senderLine(from)}\n\n${envelope.body}`,
      from,
      attachments: [],
      waiters: [],
    };
    const reply = envelope.waitForResponse ? new Promise<string | undefined>((resolve) => item.waiters.push(resolve)) : undefined;
    const deliveryState = this.enqueue(agent, item, envelope.deliveryMode);
    const result: DeliveryResult = {
      success: true,
      accepted: true,
      messageId: envelope.messageId,
      deliveryState,
      ...(replacedMessageIds.length ? { replacedMessageIds } : {}),
    };
    if (!reply) return result;
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      reply.then((text) => ({ text })),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), envelope.timeoutMs ?? 300_000);
      }),
    ]);
    clearTimeout(timer);
    if (answer === "timeout") return { ...result, status: "timeout" };
    return answer.text === undefined ? result : { ...result, response: answer.text };
  }

  private enqueue(agent: LiveAgent, item: QueuedMessage, deliveryMode: DeliveryMode): "queued" | "started" {
    if (!agent.running) {
      this.options.store.update(agent.id, { state: "running" });
      this.start(agent, item);
      return "started";
    }
    if (deliveryMode === "interrupt") {
      agent.queue.unshift(item);
      agent.abort?.abort();
      return "started";
    }
    agent.queue.push(item);
    return "queued";
  }

  transcript(agentId: string, limit = 20): AgentTranscript {
    const session = this.session(agentId);
    const bounded = Math.max(1, Math.min(limit, MAX_TRANSCRIPT_LIMIT));
    const messages = this.options.store.messages(agentId, bounded);
    const result = this.live.get(agentId)?.lastResult;
    return {
      agent: this.summary(agentId),
      messageCount: session.messageCount,
      showing: messages.length,
      messages,
      ...(result !== undefined && session.state === "idle" ? { result } : {}),
    };
  }

  cancel(agentId: string): AgentSummary {
    const agent = this.agent(agentId);
    dropQueue(agent);
    agent.abort?.abort();
    return this.summary(agentId);
  }

  async wait(
    agentId: string,
    timeoutMs = 300_000,
  ): Promise<{ state: "completed" | "timeout"; agent: AgentSummary; result?: string; structuredOutput?: unknown }> {
    const agent = this.agent(agentId);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([agent.idle.then(() => "completed" as const), timedOut]);
    clearTimeout(timer);
    return {
      state: outcome,
      agent: this.summary(agentId),
      ...(outcome === "completed" && agent.lastResult !== undefined ? { result: agent.lastResult } : {}),
      ...(outcome === "completed" && agent.structuredOutput !== undefined ? { structuredOutput: agent.structuredOutput } : {}),
    };
  }

  list(): AgentSummary[] {
    return [...this.live.keys()].map((id) => this.summary(id));
  }

  get(agentId: string): AgentSummary | null {
    return this.live.has(agentId) ? this.summary(agentId) : null;
  }

  /** Switch an idle agent to another model for its next turns (each turn reads the model from the session record). */
  setModel(agentId: string, model: string, reasoningEffort?: string): AgentSummary {
    if (this.agent(agentId).running) {
      throw Object.assign(new Error(`Agent ${agentId} is running; switch its model once it is idle.`), { code: "invalid_request" });
    }
    this.options.store.update(agentId, { model, ...(reasoningEffort ? { reasoningEffort } : {}) });
    return this.summary(agentId);
  }

  /** Stops every session; resolves when their backends have exited. */
  async dispose(): Promise<void> {
    for (const agent of this.live.values()) {
      dropQueue(agent);
      agent.abort?.abort();
    }
    await Promise.allSettled([...this.live.values()].map((agent) => agent.idle));
  }

  private start(agent: LiveAgent, first: QueuedMessage): void {
    agent.running = true;
    agent.idle = this.drain(agent, first).catch((error: unknown) => {
      this.options.log?.(`agent ${agent.id} stopped: ${errorText(error)}`);
    });
  }

  /** Runs the given message and then every queued one; the session reads as running until the queue is empty. */
  private async drain(agent: LiveAgent, first: QueuedMessage): Promise<void> {
    let item: QueuedMessage | undefined = first;
    try {
      while (item !== undefined) {
        let reply: string | undefined;
        try {
          reply = await this.turn(agent, item.text, item.attachments, item.from);
        } finally {
          agent.lastReply = reply;
          for (const waiter of item.waiters) waiter(reply);
        }
        item = agent.queue.shift();
      }
      agent.running = false;
      this.announce("session.idle", this.options.store.update(agent.id, { state: "idle" }));
      this.settle(agent.id, { state: "idle", ...(agent.lastReply !== undefined ? { reply: agent.lastReply } : {}) });
    } catch (error) {
      dropQueue(agent);
      agent.running = false;
      this.announce("session.failed", this.options.store.update(agent.id, { state: "failed", lastError: errorText(error) }));
      this.settle(agent.id, { state: "failed", error: errorText(error) });
      throw error;
    } finally {
      agent.running = false;
    }
  }

  private settle(sessionId: string, outcome: SessionOutcome): void {
    for (const listener of this.settledListeners) {
      try {
        listener(sessionId, outcome);
      } catch (error) {
        this.options.log?.(`settled listener for ${sessionId} failed: ${errorText(error)}`);
      }
    }
  }

  private announce(type: "session.idle" | "session.failed", session: SessionRecord): void {
    try {
      this.options.onSessionEvent?.(type, {
        sessionId: session.id,
        title: session.title,
        state: session.state,
        labels: session.labels,
        ...(session.parentId ? { parentId: session.parentId } : {}),
        ...(session.launchedBy ? { launchedBy: session.launchedBy } : {}),
        ...(session.lastError ? { lastError: session.lastError } : {}),
      });
    } catch (error) {
      this.options.log?.(`session event ${type} for ${session.id} failed: ${errorText(error)}`);
    }
  }

  /** One backend turn; resolves with the answer, or undefined when the turn was cancelled. */
  private async turn(
    agent: LiveAgent,
    message: string,
    attachments: readonly string[],
    from?: MessageSender,
  ): Promise<string | undefined> {
    const store = this.options.store;
    const session = this.session(agent.id);
    store.appendMessage(agent.id, { role: "user", content: message, ...(from ? { from } : {}) });
    const abort = new AbortController();
    agent.abort = abort;
    const hostPrompt = this.options.systemPrompt(session);
    const systemPrompt = agent.systemPrompt ?? hostPrompt;
    const launch = agent.launchOptions ?? {};
    agent.structuredOutput = undefined;
    const extraArgs = { ...launch.extraArgs, ...(launch.disableSlashCommands ? { "disable-slash-commands": null } : {}) };
    // A fork carries its parent's prompt, so it counts as the host's prompt when the text is the same.
    const surface = systemPrompt !== undefined && systemPrompt === hostPrompt ? this.options.nativeTools : undefined;
    const disallowedTools = [...(surface?.disabled ?? []), ...(launch.disallowedTools ?? [])];
    const hooks = surface ? withPreToolUse(launch.hooks, nativeSubagentHook(surface.subagentAllowlist)) : launch.hooks;
    const permissionHandler = this.options.permissionHandler;
    const options: Record<string | symbol, unknown> = {
      model: session.model,
      ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
      cwd: launch.cwd ?? this.options.cwd,
      env: withoutBundledSkills(launch.env ? mergeEnv(this.options.env, launch.env) : this.options.env),
      abortController: abort,
      ...(permissionHandler
        ? { permissionMode: "default", canUseTool: claudeCanUseTool(permissionHandler, agent.id) }
        : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
      settingSources: this.options.projectSettings ? ["project"] : [],
      mcpServers: { ...(launch.hostMcpServers === false ? {} : this.options.mcpServers(session)), ...launch.mcpServers },
      systemPrompt: systemPrompt ?? { type: "preset", preset: "claude_code" },
      ...(this.options.tools ? { tools: [...this.options.tools] } : {}),
      ...(session.native.sessionId
        ? { resume: session.native.sessionId }
        : session.native.forkOf
          ? { resume: session.native.forkOf, forkSession: true, ...(agent.forkAt ? { resumeSessionAt: agent.forkAt } : {}) }
          : {}),
      ...(launch.maxTurns !== undefined ? { maxTurns: launch.maxTurns } : {}),
      ...(launch.maxBudgetUsd !== undefined ? { maxBudgetUsd: launch.maxBudgetUsd } : {}),
      ...(launch.strictMcpConfig !== undefined ? { strictMcpConfig: launch.strictMcpConfig } : {}),
      ...(launch.allowedTools ? { allowedTools: [...launch.allowedTools] } : {}),
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(launch.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable } : {}),
      ...(Object.keys(extraArgs).length ? { extraArgs } : {}),
      ...(hooks ? { hooks } : {}),
      ...(launch.outputFormat !== undefined ? { outputFormat: launch.outputFormat } : {}),
      ...(launch.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: launch.spawnClaudeCodeProcess } : {}),
      stderr: (data: string) => this.options.log?.(`agent ${agent.id} stderr: ${data.trimEnd().slice(0, 500)}`),
      [TURN_EXTRAS]: {
        sessionId: agent.id,
        attachments: [...attachments],
        ...(surface ? { nativeSubagentAllowlist: [...surface.subagentAllowlist] } : {}),
        ...(launch.env ? { launchEnv: true } : {}),
        // The provider's own session id is not the Marshal one; the handler always gets the Marshal session.
        ...(permissionHandler ? { permissionHandler: (request) => permissionHandler(request, { sessionId: agent.id }) } : {}),
      } satisfies TurnExtras,
    };
    let lastText = "";
    let final: string | undefined;
    let failed: string | undefined;
    try {
      for await (const event of this.options.query({ prompt: promptOf(message, attachments), options })) {
        store.appendEvent(agent.id, slim(event));
        if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
          store.update(agent.id, { native: { ...this.session(agent.id).native, sessionId: event.session_id } });
        } else if (event.type === "assistant" && !event.parent_tool_use_id) {
          const text = textOf(event.message?.content);
          if (text) lastText = text;
        } else if (event.type === "result") {
          final = typeof event.result === "string" && event.result ? event.result : lastText;
          if (event.is_error) failed = final || String(event.subtype ?? "error");
          if (event.structured_output !== undefined) agent.structuredOutput = event.structured_output;
          store.addUsage(agent.id, {
            inputTokens: num(event.usage?.input_tokens),
            outputTokens: num(event.usage?.output_tokens),
            cacheReadTokens: num(event.usage?.cache_read_input_tokens),
            cacheWriteTokens: num(event.usage?.cache_creation_input_tokens),
            costUsd: num(event.total_cost_usd),
            turns: 1,
            modelTurns: num(event.num_turns),
          });
        }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
        return undefined;
      }
      store.appendMessage(agent.id, { role: "assistant", content: errorText(error), error: true });
      throw error;
    } finally {
      agent.abort = undefined;
    }
    if (abort.signal.aborted) {
      store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
      return undefined;
    }
    const content = failed ?? final ?? lastText;
    agent.lastResult = content;
    store.appendMessage(agent.id, {
      role: "assistant",
      content,
      ...(failed !== undefined ? { error: true } : {}),
    });
    return content;
  }

  private summary(agentId: string): AgentSummary {
    const session = this.session(agentId);
    return {
      id: session.id,
      name: session.title,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.workspace ? { workspaceName: session.workspace } : {}),
      ...(session.native.sessionId ? { sessionId: session.native.sessionId } : {}),
      usage: {
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        cachedInputTokens: session.usage.cacheReadTokens,
        costUsd: session.usage.costUsd,
        ...(session.usage.modelTurns ? { modelTurns: session.usage.modelTurns } : {}),
      },
    };
  }

  /** A stored session this process did not start (an earlier run of the host): resumed by its native id. */
  private adopt(agentId: string): LiveAgent {
    this.session(agentId);
    const agent: LiveAgent = { id: agentId, queue: [], running: false, idle: Promise.resolve() };
    this.live.set(agentId, agent);
    return agent;
  }

  private agent(agentId: string): LiveAgent {
    const agent = this.live.get(agentId);
    if (!agent) throw Object.assign(new Error(`No agent ${agentId} on this host.`), { code: "not-found" });
    return agent;
  }

  private session(agentId: string): SessionRecord {
    const session = this.options.store.get(agentId);
    if (!session) throw Object.assign(new Error(`No agent ${agentId} on this host.`), { code: "not-found" });
    return session;
  }
}

function dropQueue(agent: LiveAgent): void {
  for (const dropped of agent.queue.splice(0)) for (const waiter of dropped.waiters) waiter(undefined);
}

function senderKey(from: MessageSender): string {
  return `${from.kind}:${from.host ?? ""}:${from.sessionId ?? from.personId ?? from.name ?? ""}`;
}

/** The host's environment with a launch's on top; a null value removes the key. */
function mergeEnv(base: Record<string, string>, over: Readonly<Record<string, string | null>>): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Claude Code's bundled skills (loop, update-config, claude-api, …) describe the CLI, not a Marshal host, and
 * otherwise show in every session's skill list. A host that wants them sets the variable itself (say, to "0").
 */
function withoutBundledSkills(env: Record<string, string>): Record<string, string> {
  return "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS" in env ? env : { ...env, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" };
}

/** A plain string, or one user message with the pictures as image blocks ahead of the text. */
function promptOf(message: string, attachments: readonly string[]): unknown {
  if (attachments.length === 0) return message;
  const content: unknown[] = [];
  const unreadable: string[] = [];
  for (const file of attachments) {
    const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mediaType) {
      unreadable.push(file);
      continue;
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: fs.readFileSync(file).toString("base64") },
    });
  }
  const note = unreadable.length ? `\n\nAttached files (open them yourself): ${unreadable.join(", ")}` : "";
  content.push({ type: "text", text: `${message}${note}` });
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
  })();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A backend event without picture bytes or very long strings, so events.jsonl stays readable. */
function slim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_EVENT_STRING ? `${value.slice(0, MAX_EVENT_STRING)}… [${value.length} chars]` : value;
  }
  if (value === null || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => slim(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === "base64" && typeof record.data === "string") {
    return { ...record, data: `[${record.data.length} base64 chars]` };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, slim(item, depth + 1)]));
}
