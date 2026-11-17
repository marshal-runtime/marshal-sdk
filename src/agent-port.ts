import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";

import type { Options as ClaudeOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  isLocalAddress,
  senderLine,
  type DeliveryMode,
  type DeliveryResult,
  type MessageSender,
  type SessionEnvelope,
  type SessionTransport,
} from "./session-messages.js";
import type { SessionStore, SessionFork, SessionRecord, TranscriptMessage } from "./session-store.js";
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
  /**
   * The turn opens a live process (`AgentPortOptions.live`): its prompt is a stream of user messages that stays open
   * across turns, which only the Claude Agent SDK reads.
   */
  live?: boolean;
  /**
   * The id of the turn these options were built for (the queued message's id). In live mode only the turn that opens
   * the process passes options; every user message pushed into the process carries its own turn's id under `TURN_ID`.
   */
  turnId?: string;
}

/**
 * The turn id on a user message the port pushes into a live process's input (a symbol, so it never reaches the
 * backend's wire format). A host that wraps the input can match each `result` to the turn it answers.
 */
export const TURN_ID: unique symbol = Symbol.for("marshal-sdk.turn-id");

/** Why the port closed a session's live process (`AgentPortOptions.onLiveProcessClosed`). */
export type LiveProcessCloseReason =
  | "idle"
  | "evicted"
  | "recycled"
  | "options changed"
  | "turn cancelled"
  | "turn failed"
  | "stream ended"
  | "cancelled"
  | "closed"
  | "disposed";

/**
 * The text of a turn's `systemPrompt` option: a string, a list of strings, or the Agent SDK's `{type: "custom", prompt}`
 * (a launch's own prompt, sent with `snapshot: false`). Undefined for the preset and anything else.
 */
export function systemPromptText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("\n");
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "custom") {
    return systemPromptText((value as { prompt?: unknown }).prompt);
  }
  return undefined;
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

/**
 * The permission options of a turn: dontAsk when the launch asks for it (the host's handler, if any, still sees what
 * the backend asks), the host's handler, or bypassPermissions for an unattended host.
 */
function permissionOptions(mode: AgentLaunchOptions["permissionMode"], handler: RuntimePermissionHandler | undefined, sessionId: string) {
  const canUseTool = handler ? { canUseTool: claudeCanUseTool(handler, sessionId) } : {};
  if (mode === "dontAsk") return { permissionMode: "dontAsk", ...canUseTool };
  return handler ? { permissionMode: "default", ...canUseTool } : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

/** The SDK's `tools` of a turn: the launch's (or the host's) built-in tools, narrowed to the agent profile's when it pins them. */
function toolsOption(profile: readonly string[] | undefined, launch: readonly string[] | undefined, host: readonly string[] | undefined): { tools?: string[] } {
  if (profile) return { tools: launch ? launch.filter((name) => profile.includes(name)) : [...profile] };
  const tools = launch ?? host;
  return tools ? { tools: [...tools] } : {};
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
  /**
   * Backend events this host recorded for the session, and when the latest came: a caller waiting on a long turn
   * (Page Studio's big edit) tells a working agent (thinking, tool calls) from a silent one by these.
   */
  eventCount?: number;
  lastEventAt?: string;
  /** The tools, MCP servers and skills the backend reported for the session (observed, from its init event). */
  environment?: { tools: string[]; mcpServers: string[]; skills: string[] };
  /** modelTurns: the backend's own count of model round trips (the SDK's num_turns), summed over turns. */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number; modelTurns?: number };
}

/**
 * Claude Agent SDK options one launch passes to every turn of its session, on top of what the host sets. Functions
 * (hooks, the spawner) live in this process only and the port does not store them: a session adopted by a later run of
 * the host gets only what the host's `launchOptionsFor` returns for it, so a policy that must survive a restart (a
 * tool gate, the remote spawner, the proxy env) belongs there.
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
  /**
   * "dontAsk": a tool call not pre-approved by `allowedTools` is denied, never asked about and never bypassed. Without
   * it a session runs with bypassPermissions (or the host's permission handler). A host's dontAsk is never lifted by a
   * launch.
   */
  permissionMode?: "dontAsk";
  /** The backend's built-in tools of this session (the SDK's `tools`) instead of the host's; agent-profile `nativeTools` still narrow them. */
  tools?: readonly string[];
  /** Subagent definitions the session may start (the SDK's `agents`). */
  agents?: ClaudeOptions["agents"];
  /** Claude Code plugins loaded for the session (the SDK's `plugins`). */
  plugins?: ClaudeOptions["plugins"];
  /** The SDK's own `skills` option (skill names the backend loads, or "all"); not the agent profile's `AgentLaunchRequest.skills`. */
  claudeSkills?: ClaudeOptions["skills"];
  /** Claude Code settings for the session (the SDK's `settings`), say `{autoMemoryEnabled: false}`. */
  settings?: ClaudeOptions["settings"];
  /** Which settings files the backend loads (the SDK's `settingSources`) instead of the host's `projectSettings` choice. */
  settingSources?: ClaudeOptions["settingSources"];
  /** Folders besides `cwd` the session may read and write. */
  additionalDirectories?: readonly string[];
  /** The SDK's `thinking` setting. */
  thinking?: ClaudeOptions["thinking"];
  /** Run on Claude Code's own prompt with `append` after it instead of the host's prompt; a launch's own `systemPrompt` still wins. */
  systemPromptPreset?: { append?: string };
  /** Ask the backend for partial messages (stream_event). Default true. */
  includePartialMessages?: boolean;
  /**
   * Every backend event of the session as it arrives, unslimmed, stream_event included, before the port records it.
   * A host's and a launch's both run (the host's first); a throw is logged and ignored.
   */
  onEvent?: (event: Record<string, any>) => void;
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
  /**
   * Where the conversation starts: a native session to resume, or one the first turn forks (resume + forkSession).
   * `newSessionId` is the id a new native session gets (the SDK's `sessionId`), so the caller knows it before the first
   * event; ignored with `sessionId` or `forkOf`.
   */
  native?: { sessionId?: string; forkOf?: string; forkAt?: string; newSessionId?: string };
  fork?: SessionFork;
  /** Agent profile: extension identities the session sees (capabilities and skills). Absent: every installed extension. */
  extensions?: readonly string[];
  /** Agent profile: skill names the session sees besides its extensions' skills. */
  skills?: readonly string[];
  /** Agent profile: the backend's built-in tools (Read, Bash, ...) the session keeps. */
  nativeTools?: readonly string[];
  /** Agent profile: sections appended to the host prompt (ignored when the launch replaces the prompt). */
  systemPromptAppend?: string;
  /** Agent profile: the host MCP server names the session keeps. Absent: all. */
  mcpServerNames?: readonly string[];
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
  store: SessionStore;
  /** Working directory of every session, and the directory the backend files its native history under. */
  cwd: string;
  /** Environment of the backend process: credentials and config dir are the host's choice, never the agent's. */
  env: Record<string, string>;
  defaultModel: string;
  defaultReasoningEffort?: string;
  workspaceName?: string;
  /** Marshal's system prompt for a session, unless the launch replaces it. */
  systemPrompt: (session: SessionRecord) => string | undefined;
  /** Awaited before each turn's prompt is assembled: the host reads what the prompt renders (the session's memories). */
  prepareTurn?: (session: SessionRecord) => Promise<void>;
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
  /**
   * The host's launch options for a session, read at every turn, including turns of a session this process adopted
   * from an earlier run (whose own launch options are gone). Merged with the launch's own: hooks of both run (the
   * host's first, per event), `disallowedTools` is the union, `env`, `mcpServers` and `extraArgs` merge key by key with
   * the launch winning, and any other option the launch sets wins. A throw fails the turn: a session never runs
   * without the policy its host gives it.
   */
  launchOptionsFor?: (session: SessionRecord) => AgentLaunchOptions | undefined;
  /**
   * Keep each session's Claude Code process alive between its turns (Claude Agent SDK streaming input) instead of
   * starting one per turn. Off by default. Only for Claude sessions on the Agent SDK's `query` (`runtimeId` claude).
   * See `LiveProcessOptions`.
   */
  live?: LiveProcessOptions;
  /**
   * Which sessions run in live mode when `live` is set (default: every one). A host whose sessions mix live processes
   * (a chat kept warm between turns) and one process per turn (a job, a worker) says which is which here.
   */
  liveFor?: (session: SessionRecord) => boolean;
  /**
   * A session's live process closed, once per process, whatever closed it: `closed` is `closeLive`, `cancelled` is
   * `cancel`, `disposed` is `dispose`, the rest are the port's own decisions. A host releases what it holds for that
   * process here. A throw is logged and ignored.
   */
  onLiveProcessClosed?: (sessionId: string, reason: LiveProcessCloseReason) => void;
}

/**
 * Live processes: one Claude Code process per session, fed one user message per turn. A turn still ends at its
 * `result`. The process closes when it has been idle `idleSeconds`, when a new one is needed and `maxLive` are open
 * (the least recently used idle one closes), after `maxTurns` turns, when the turn's options change (model, effort,
 * prompt, cwd, env, tools, MCP server names, limits, or the hook events and counts), when its turn is cancelled or
 * interrupted, and at `dispose`. A live process keeps the hooks, spawner and MCP servers it started with: a host whose
 * hooks read per-turn state reads it through the session, not through a fresh closure per turn. `maxBudgetUsd` counts
 * the spend of the whole process.
 */
export interface LiveProcessOptions {
  /** Default 900. */
  idleSeconds?: number;
  /** Default 4. */
  maxLive?: number;
  /** Turns one process serves before it is replaced. Default 20. */
  maxTurns?: number;
}

/** A user-message stream the Agent SDK reads; `end` lets its process finish. */
class InputQueue implements AsyncIterable<unknown> {
  private readonly items: unknown[] = [];
  private waiting: ((result: IteratorResult<unknown>) => void) | null = null;
  private ended = false;

  push(message: unknown): void {
    if (this.ended) throw new Error("input closed");
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: async () => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}

interface LiveProcess {
  agentId: string;
  signature: string;
  input: InputQueue;
  stream: AsyncIterable<Record<string, any>> & { close?: () => void };
  events: AsyncIterator<Record<string, any>>;
  abort: AbortController;
  turns: number;
  /** The process's cumulative total_cost_usd at its last result (streaming input reports a running total). */
  lastTotalCost?: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  busy: boolean;
  closed: boolean;
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
  /** The native id the first turn of a new session asks for (the SDK's sessionId). */
  newNativeSessionId?: string;
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
  private readonly processes = new Map<string, LiveProcess>();

  constructor(private readonly options: AgentPortOptions) {}

  /** Sessions whose Claude Code process is alive between turns now (live mode). */
  liveSessions(): string[] {
    return [...this.processes.keys()];
  }

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
      ...(request.extensions ? { extensions: request.extensions } : {}),
      ...(request.skills ? { skills: request.skills } : {}),
      ...(request.nativeTools ? { nativeTools: request.nativeTools } : {}),
      ...(request.systemPromptAppend ? { systemPromptAppend: request.systemPromptAppend } : {}),
      ...(request.mcpServerNames ? { mcpServerNames: request.mcpServerNames } : {}),
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
      ...(request.native?.newSessionId && !request.native.sessionId && !request.native.forkOf
        ? { newNativeSessionId: request.native.newSessionId }
        : {}),
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
    const live = this.processes.get(agentId);
    if (live) this.closeProcess(live, "cancelled");
    return this.summary(agentId);
  }

  /**
   * Closes the session's live process while the session is idle, keeping its queue and its stored state: its next
   * turn starts a new process (resuming the session). For a host that ends a process on its own schedule, such as a
   * context rollover. False when there is no live process, or the session is running (cancel it instead).
   */
  closeLive(agentId: string): boolean {
    const agent = this.agent(agentId);
    const proc = this.processes.get(agentId);
    if (!proc || proc.busy || agent.running) return false;
    this.closeProcess(proc, "closed");
    return true;
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
    for (const live of [...this.processes.values()]) this.closeProcess(live, "disposed");
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
          reply = await this.turn(agent, item.text, item.attachments, item.from, item.id);
        } finally {
          agent.lastReply = reply;
          for (const waiter of item.waiters) waiter(reply);
        }
        item = agent.queue.shift();
      }
      agent.running = false;
      const idle = this.options.store.update(agent.id, { state: "idle" });
      this.announce("session.idle", idle);
      this.settle(agent.id, { state: "idle", ...(agent.lastReply !== undefined ? { reply: agent.lastReply } : {}) });
    } catch (error) {
      dropQueue(agent);
      agent.running = false;
      const failed = this.options.store.update(agent.id, { state: "failed", lastError: errorText(error) });
      this.announce("session.failed", failed);
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
    turnId: string = randomUUID(),
  ): Promise<string | undefined> {
    const store = this.options.store;
    // A session adopted from another host (or an earlier run) is read from the store before it continues.
    const session = this.session(agent.id);
    store.appendMessage(agent.id, { role: "user", content: message, ...(from ? { from } : {}) });
    const abort = new AbortController();
    agent.abort = abort;
    if (this.options.prepareTurn) {
      try {
        await this.options.prepareTurn(session);
      } catch (error) {
        this.options.log?.(`prepareTurn for ${session.id} failed: ${errorText(error)}`);
      }
    }
    const basePrompt = this.options.systemPrompt(session);
    const hostPrompt = basePrompt !== undefined && session.systemPromptAppend ? `${basePrompt}\n\n${session.systemPromptAppend}` : basePrompt;
    const systemPrompt = agent.systemPrompt ?? hostPrompt;
    const launch = mergeLaunchOptions(this.options.launchOptionsFor?.(session), agent.launchOptions);
    const live = this.options.live && (this.options.runtimeId ?? "claude") === "claude" && (this.options.liveFor?.(session) ?? true) ? this.options.live : undefined;
    agent.structuredOutput = undefined;
    const extraArgs = { ...launch.extraArgs, ...(launch.disableSlashCommands ? { "disable-slash-commands": null } : {}) };
    // A fork carries its parent's prompt, so it counts as the host's prompt when the text is the same.
    const surface = systemPrompt !== undefined && systemPrompt === hostPrompt && !launch.systemPromptPreset ? this.options.nativeTools : undefined;
    const disallowedTools = [...(surface?.disabled ?? []), ...(launch.disallowedTools ?? [])];
    const hooks = surface ? withPreToolUse(launch.hooks, nativeSubagentHook(surface.subagentAllowlist)) : launch.hooks;
    const permissionHandler = this.options.permissionHandler;
    const nativeSessionId = !session.native.sessionId && !session.native.forkOf ? agent.newNativeSessionId : undefined;
    const options: Record<string | symbol, unknown> = {
      model: session.model,
      ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
      cwd: launch.cwd ?? this.options.cwd,
      env: withoutBundledSkills(launch.env ? mergeEnv(this.options.env, launch.env) : this.options.env),
      abortController: abort,
      // Deltas keep the session's activity time moving while one long message (a whole page in one tool call) streams.
      includePartialMessages: launch.includePartialMessages ?? true,
      ...permissionOptions(launch.permissionMode, permissionHandler, agent.id),
      settingSources: launch.settingSources ? [...launch.settingSources] : this.options.projectSettings ? ["project"] : [],
      ...(launch.agents ? { agents: launch.agents } : {}),
      ...(launch.plugins ? { plugins: launch.plugins } : {}),
      ...(launch.claudeSkills !== undefined ? { skills: launch.claudeSkills } : {}),
      ...(launch.settings !== undefined ? { settings: launch.settings } : {}),
      ...(launch.additionalDirectories ? { additionalDirectories: [...launch.additionalDirectories] } : {}),
      ...(launch.thinking ? { thinking: launch.thinking } : {}),
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
      // The store keeps the backend's transcript: the Agent SDK mirrors each batch to it while the turn runs and, when a
      // session resumes, loads it from there before the backend starts (a store answers null when the machine already has it).
      // A session reads as idle without waiting for any of it to reach the cloud.
      ...(store.transcripts && (this.options.runtimeId ?? "claude") === "claude" ? { sessionStore: store.transcripts.bind ? store.transcripts.bind(agent.id) : store.transcripts } : {}),
      // A live process keeps the servers it started with, so they are made only when one starts (openProcess).
      mcpServers: live ? {} : this.mcpServersOf(session, launch),
      // A launch's own prompt (a fork's included) is rendered fresh on every request: recorded once, a resumed or
      // forked session would keep running on the prompt of its first turn (its parent's, for a fork).
      systemPrompt:
        agent.systemPrompt !== undefined
          ? { type: "custom", prompt: agent.systemPrompt, snapshot: false }
          : launch.systemPromptPreset
            ? { type: "preset", preset: "claude_code", ...(launch.systemPromptPreset.append ? { append: launch.systemPromptPreset.append } : {}) }
            : (systemPrompt ?? { type: "preset", preset: "claude_code" }),
      ...toolsOption(session.nativeTools, launch.tools, this.options.tools),
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
        turnId,
        attachments: [...attachments],
        ...(surface ? { nativeSubagentAllowlist: [...surface.subagentAllowlist] } : {}),
        ...(launch.env ? { launchEnv: true } : {}),
        ...(live ? { live: true } : {}),
        // The provider's own session id is not the Marshal one; the handler always gets the Marshal session.
        ...(permissionHandler ? { permissionHandler: (request) => permissionHandler(request, { sessionId: agent.id }) } : {}),
      } satisfies TurnExtras,
    };
    if (live) return this.liveTurn(agent, session, launch, live, options, abort, message, attachments, turnId);
    const acc: TurnAccumulator = { lastText: "" };
    // The turn ends at its result event, not when the stream closes: on 2026-11-16 (c2-real-2 hero, 900008 critic)
    // the Claude process stayed alive after `result` (end_turn), the stream never closed, and the finished answer was
    // never recorded until the caller cancelled the turn 25-40 min later.
    const events = this.options.query({ prompt: promptOf(message, attachments), options })[Symbol.asyncIterator]();
    let ended = false;
    try {
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        if (this.takeEvent(agent, next.value, acc, num(next.value.total_cost_usd), launch.onEvent)) {
          ended = true;
          break;
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
    if (ended) closeAfterResult(events, abort, (error) => this.options.log?.(`agent ${agent.id}: closing its stream after the result failed: ${errorText(error)}`));
    else if (abort.signal.aborted) {
      store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
      return undefined;
    }
    return this.finishTurn(agent, acc);
  }

  /** Records one backend event; true at the turn's result. `costUsd` is what this turn cost. */
  private takeEvent(
    agent: LiveAgent,
    event: Record<string, any>,
    acc: TurnAccumulator,
    costUsd: number,
    onEvent?: (event: Record<string, any>) => void,
  ): boolean {
    const store = this.options.store;
    if (onEvent) {
      try {
        onEvent(event);
      } catch (error) {
        this.options.log?.(`agent ${agent.id}: onEvent failed: ${errorText(error)}`);
      }
    }
    // A streamed delta of a message still being written: proof the backend is working, not a record of the turn.
    if (event.type === "stream_event") {
      store.touch(agent.id);
      return false;
    }
    store.appendEvent(agent.id, slim(event));
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      store.update(agent.id, { native: { ...this.session(agent.id).native, sessionId: event.session_id } });
      store.setEnvironment(agent.id, environmentOf(event));
    } else if (event.type === "assistant" && !event.parent_tool_use_id) {
      const text = textOf(event.message?.content);
      if (text) acc.lastText = text;
    } else if (event.type === "result") {
      acc.final = typeof event.result === "string" && event.result ? event.result : acc.lastText;
      if (event.is_error) acc.failed = acc.final || String(event.subtype ?? "error");
      if (event.structured_output !== undefined) agent.structuredOutput = event.structured_output;
      store.addUsage(agent.id, {
        inputTokens: num(event.usage?.input_tokens),
        outputTokens: num(event.usage?.output_tokens),
        cacheReadTokens: num(event.usage?.cache_read_input_tokens),
        cacheWriteTokens: num(event.usage?.cache_creation_input_tokens),
        costUsd,
        turns: 1,
        modelTurns: num(event.num_turns),
      });
      return true;
    }
    return false;
  }

  private finishTurn(agent: LiveAgent, acc: TurnAccumulator): string {
    const content = acc.failed ?? acc.final ?? acc.lastText;
    agent.lastResult = content;
    this.options.store.appendMessage(agent.id, {
      role: "assistant",
      content,
      ...(acc.failed !== undefined ? { error: true } : {}),
    });
    return content;
  }

  private mcpServersOf(session: SessionRecord, launch: AgentLaunchOptions): Record<string, unknown> {
    const host = launch.hostMcpServers === false ? {} : this.options.mcpServers(session);
    const names = session.mcpServerNames;
    const kept = names ? Object.fromEntries(Object.entries(host).filter(([name]) => names.includes(name))) : host;
    return { ...kept, ...launch.mcpServers };
  }

  /**
   * One turn on the session's live process: reuses it when its options are unchanged, otherwise starts one (resuming
   * the session, or forking it on its first turn). The message goes into the process's input; the turn ends at its
   * result and the process stays up until idle, evicted, recycled, cancelled or disposed.
   */
  private async liveTurn(
    agent: LiveAgent,
    session: SessionRecord,
    launch: AgentLaunchOptions,
    live: LiveProcessOptions,
    options: Record<string | symbol, unknown>,
    abort: AbortController,
    message: string,
    attachments: readonly string[],
    turnId: string,
  ): Promise<string | undefined> {
    const store = this.options.store;
    const signature = processSignature(options, launch);
    let proc = this.processes.get(agent.id);
    if (proc && (proc.closed || proc.signature !== signature || proc.turns >= (live.maxTurns ?? 20))) {
      this.closeProcess(proc, proc.signature !== signature ? "options changed" : "recycled");
      proc = undefined;
    }
    const acc: TurnAccumulator = { lastText: "" };
    const onAbort = () => {
      if (proc) this.closeProcess(proc, "turn cancelled");
    };
    try {
      if (!proc) proc = this.openProcess(agent, session, launch, live, options, signature);
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      proc.busy = true;
      if (abort.signal.aborted) throw new Error("Turn cancelled before it started.");
      abort.signal.addEventListener("abort", onAbort, { once: true });
      proc.input.push(Object.assign(userMessage(message, attachments) as object, { [TURN_ID]: turnId }));
      for (;;) {
        const next = await proc.events.next();
        if (next.done) {
          // The process ended without answering this turn: it is gone, and the next turn starts another.
          this.closeProcess(proc, "stream ended");
          break;
        }
        const event = next.value;
        let costUsd = 0;
        if (event.type === "result") {
          // Streaming input reports a running total for the process; this turn cost the difference.
          const total = num(event.total_cost_usd);
          costUsd = proc.lastTotalCost === undefined || total < proc.lastTotalCost ? total : total - proc.lastTotalCost;
          proc.lastTotalCost = total;
        }
        if (this.takeEvent(agent, event, acc, costUsd, launch.onEvent)) {
          proc.turns += 1;
          break;
        }
      }
    } catch (error) {
      if (proc) this.closeProcess(proc, "turn failed");
      if (abort.signal.aborted) {
        store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
        return undefined;
      }
      store.appendMessage(agent.id, { role: "assistant", content: errorText(error), error: true });
      throw error;
    } finally {
      abort.signal.removeEventListener("abort", onAbort);
      agent.abort = undefined;
      if (proc && !proc.closed) {
        proc.busy = false;
        proc.lastUsedAt = Date.now();
        const live_ = proc;
        proc.idleTimer = setTimeout(() => {
          if (!live_.busy) this.closeProcess(live_, "idle");
        }, (live.idleSeconds ?? 900) * 1000);
        proc.idleTimer.unref?.();
      }
    }
    if (abort.signal.aborted && acc.final === undefined) {
      store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
      return undefined;
    }
    return this.finishTurn(agent, acc);
  }

  private openProcess(
    agent: LiveAgent,
    session: SessionRecord,
    launch: AgentLaunchOptions,
    live: LiveProcessOptions,
    options: Record<string | symbol, unknown>,
    signature: string,
  ): LiveProcess {
    const maxLive = Math.max(1, live.maxLive ?? 4);
    while (this.processes.size >= maxLive) {
      const idle = [...this.processes.values()].filter((p) => !p.busy).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) break;
      this.closeProcess(idle, "evicted");
    }
    const input = new InputQueue();
    const processAbort = new AbortController();
    const stream = this.options.query({
      prompt: input,
      options: { ...options, abortController: processAbort, mcpServers: this.mcpServersOf(session, launch) },
    }) as LiveProcess["stream"];
    const proc: LiveProcess = {
      agentId: agent.id,
      signature,
      input,
      stream,
      events: stream[Symbol.asyncIterator](),
      abort: processAbort,
      turns: 0,
      lastUsedAt: Date.now(),
      busy: false,
      closed: false,
    };
    this.processes.set(agent.id, proc);
    this.options.log?.(`agent ${agent.id}: live process started (${this.processes.size} live)`);
    return proc;
  }

  private closeProcess(proc: LiveProcess, why: LiveProcessCloseReason): void {
    if (proc.closed) return;
    proc.closed = true;
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    if (this.processes.get(proc.agentId) === proc) this.processes.delete(proc.agentId);
    proc.input.end();
    try {
      proc.stream.close?.();
    } catch {
      /* already gone */
    }
    proc.abort.abort();
    // A backend without close() (any QueryFn) still gets its stream finished.
    Promise.resolve()
      .then(() => proc.events.return?.())
      .catch((error) => this.options.log?.(`agent ${proc.agentId}: closing its live stream failed: ${errorText(error)}`));
    this.options.log?.(`agent ${proc.agentId}: live process closed (${why})`);
    try {
      this.options.onLiveProcessClosed?.(proc.agentId, why);
    } catch (error) {
      this.options.log?.(`live process closed listener for ${proc.agentId} failed: ${errorText(error)}`);
    }
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
      ...this.options.store.activity(session.id),
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

interface TurnAccumulator {
  lastText: string;
  final?: string;
  failed?: string;
}

type HookMatchers = Readonly<Record<string, unknown>>;

/** Hooks of both, per event: the host's matchers first, then the launch's. */
function mergeHooks(host: HookMatchers | undefined, own: HookMatchers | undefined): Record<string, unknown> | undefined {
  if (!host) return own ? { ...own } : undefined;
  if (!own) return { ...host };
  const merged: Record<string, unknown> = {};
  for (const event of new Set([...Object.keys(host), ...Object.keys(own)])) {
    const list = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
    merged[event] = [...list(host[event]), ...list(own[event])];
  }
  return merged;
}

/** Both event listeners, the host's first; a throw in one does not keep the other from running. */
function chainOnEvent(
  host: AgentLaunchOptions["onEvent"],
  own: AgentLaunchOptions["onEvent"],
): AgentLaunchOptions["onEvent"] {
  if (!host || !own) return host ?? own;
  return (event) => {
    let failure: unknown;
    for (const listener of [host, own]) {
      try {
        listener(event);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
}

/** A host's launch options (launchOptionsFor) with a launch's own over them; see AgentPortOptions.launchOptionsFor. */
export function mergeLaunchOptions(host: AgentLaunchOptions | undefined, own: AgentLaunchOptions | undefined): AgentLaunchOptions {
  if (!host) return own ?? {};
  if (!own) return host;
  const hooks = mergeHooks(host.hooks, own.hooks);
  const disallowedTools = [...new Set([...(host.disallowedTools ?? []), ...(own.disallowedTools ?? [])])];
  const env = host.env || own.env ? { ...host.env, ...own.env } : undefined;
  const mcpServers = host.mcpServers || own.mcpServers ? { ...host.mcpServers, ...own.mcpServers } : undefined;
  const extraArgs = host.extraArgs || own.extraArgs ? { ...host.extraArgs, ...own.extraArgs } : undefined;
  const permissionMode = host.permissionMode ?? own.permissionMode;
  const onEvent = chainOnEvent(host.onEvent, own.onEvent);
  return {
    ...host,
    ...own,
    ...(permissionMode ? { permissionMode } : {}),
    ...(onEvent ? { onEvent } : {}),
    ...(hooks ? { hooks } : {}),
    ...(disallowedTools.length ? { disallowedTools } : {}),
    ...(env ? { env } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

/**
 * What a live process was started with, as text: a turn whose signature differs needs a new process. Functions count
 * by shape only (hook events and how many matchers, whether a spawner or permission handler is set), so a host that
 * builds fresh closures each turn keeps its process.
 */
function processSignature(options: Record<string | symbol, unknown>, launch: AgentLaunchOptions): string {
  const hooks = (options.hooks ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    model: options.model,
    effort: options.effort,
    cwd: options.cwd,
    env: options.env,
    permissionMode: options.permissionMode,
    canUseTool: typeof options.canUseTool === "function",
    settingSources: options.settingSources,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    strictMcpConfig: options.strictMcpConfig,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    extraArgs: options.extraArgs,
    outputFormat: options.outputFormat,
    includePartialMessages: options.includePartialMessages,
    agents: options.agents,
    plugins: options.plugins,
    skills: options.skills,
    settings: options.settings,
    additionalDirectories: options.additionalDirectories,
    thinking: options.thinking,
    spawner: typeof options.spawnClaudeCodeProcess === "function",
    hooks: Object.keys(hooks)
      .sort()
      .map((event) => [event, Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).length : 1]),
    mcpServers: [launch.hostMcpServers === false ? "-host" : "+host", ...Object.keys(launch.mcpServers ?? {}).sort()],
  });
}

/** One user message of a live process's input stream. */
function userMessage(message: string, attachments: readonly string[]): unknown {
  return { type: "user", message: { role: "user", content: contentOf(message, attachments) }, parent_tool_use_id: null, session_id: "" };
}

/** A plain string, or one user message with the pictures as image blocks ahead of the text. */
function promptOf(message: string, attachments: readonly string[]): unknown {
  if (attachments.length === 0) return message;
  const content = contentOf(message, attachments);
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
  })();
}

/** The message text, or the pictures as image blocks ahead of it. */
function contentOf(message: string, attachments: readonly string[]): string | unknown[] {
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
  return content;
}

/** How long a backend gets to close its stream after the result before its turn is aborted (the process is killed). */
export const CLOSE_AFTER_RESULT_MS = 10_000;

/** Asks the backend's stream to close without waiting on it; a stream that doesn't close in time is aborted. */
function closeAfterResult(events: AsyncIterator<unknown>, abort: AbortController, onError: (error: unknown) => void): void {
  const timer = setTimeout(() => abort.abort(), CLOSE_AFTER_RESULT_MS);
  timer.unref?.();
  Promise.resolve()
    .then(() => events.return?.())
    .then(() => clearTimeout(timer), (error) => {
      clearTimeout(timer);
      onError(error);
    });
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

const names = (list: unknown, key?: string): string[] =>
  (Array.isArray(list) ? list : []).map((entry) => String(key && entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : entry)).sort();

/** The tools, MCP servers and skills a backend's init event lists, as sorted names. */
export function environmentOf(init: { tools?: unknown; mcp_servers?: unknown; skills?: unknown }): { tools: string[]; mcpServers: string[]; skills: string[] } {
  return { tools: names(init.tools), mcpServers: names(init.mcp_servers, "name"), skills: names(init.skills) };
}
