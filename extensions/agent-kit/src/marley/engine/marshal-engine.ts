import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Options, SDKMessage, SDKUserMessage } from "@zygstinct/marshal-sdk-port/agent-sdk";
import { TURN_EXTRAS, type AgentLaunchOptions, type ClaudeAgentPort, type LiveProcessCloseReason, type PromptLayer, type SessionRecord, type SessionStore, type TurnExtras } from "@zygstinct/marshal-sdk-port";
import {
  assertProxyEndpoint,
  createMarshalHost,
  providerForModelFamily,
  type AntigravityBridgeChild,
  type AntigravityBridgeSpawnRequest,
  type AntigravityProxyEndpoint,
  type AntigravityRemoteBridge,
  type MarshalHost,
  type MemoryOptions,
  type RemoteRuntime,
} from "@zygstinct/marshal-sdk-port/host";

import { marleyHostPrompt, promptLayerOf } from "./marshal-prompt.js";
import { gateOnMcp, type McpReadyOptions } from "./mcp-ready.js";
import type { QueryFn } from "./run-role.js";

/** Names a turn's Marshal session (brand, conversation, role, task): set on the options a caller hands the engine's QueryFn; never sent to the SDK. */
export const SESSION_LABELS: unique symbol = Symbol("marley.marshal-session-labels");

export interface MarshalSessionLabels {
  title: string;
  labels: Record<string, string>;
}

/** The options with the Marshal session's title and labels attached (read only by the marshal-sdk engine). */
export function withSessionLabels(options: Options, labels: MarshalSessionLabels): Options {
  return Object.assign({ ...options }, { [SESSION_LABELS]: labels });
}

function labelsOf(options: Options): MarshalSessionLabels | undefined {
  return (options as Options & { [SESSION_LABELS]?: MarshalSessionLabels })[SESSION_LABELS];
}

export interface MarshalEngineOptions {
  /** The Claude Agent SDK's query (tests pass a scripted one). */
  query: QueryFn;
  /** The session store's folder (`<state>/marshal-sessions`). */
  root: string;
  /** This server's host id in the store (the server name). */
  hostId: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** The port's session events (a session went idle or failed): where Marley's run records are published from (src/run-records). */
  onSessionEvent?: (type: "session.idle" | "session.failed", payload: Record<string, unknown>) => void;
  /** The front's live processes (`openLive`): one Claude Code process per conversation, kept between its turns by the port's live mode. */
  live?: EngineLiveOptions;
  /** The agent's name in the Marshal base's identity (Marley's first configured name). Default "Marley". */
  agentName?: string;
  /**
   * The forks the host launches from a Marley session (marshal.tool.forkSubagents) and the messages sent to them (messageSubagent). A fork's turns
   * run as Marley worker tasks: `start` makes the fork a task of its parent's running turn (validated with that turn like any work it hands off) and
   * resolves with the task's outcome; `steer` sends a later message to the fork's task. Absent: a fork the host launches is refused.
   */
  forks?: EngineForks;
  /**
   * The host's memory (marshal.tool.remember / recall / linkMemory / updateMemory / forget and each session's memory block): Marley's brand Brain store
   * and its scopes (brand; a direct chat's member). Absent: sessions have no memory and the tools say so.
   */
  memory?: MemoryOptions;
  /** Search-only access to the org store (org-store/ `marleyOrgSearch`): the session tools also read the brand's published sessions. Absent: the host's own store only. */
  orgSearch?: { objects: unknown; workspace: string };
  /**
   * Capabilities the host answers itself for a session on a brand VM (marshal-sdk `remoteEmbedderTools`): server state such as the brand's stack and the
   * team's tickets (agent-extensions/brand-host-capabilities.ts). `provider` gets the session's labels by id, set by the server when it started the session.
   */
  hostCapabilities?: { tools: readonly string[]; provider: (labelsOf: (sessionId: string | undefined) => Record<string, string> | undefined) => unknown };
  /**
   * Whether this server runs Gemini sessions (VERTEX_* configured, config.ts `vertex`): each one on Antigravity with its bridge on the brand VM
   * (withAntigravityBridge), its model calls through the model proxy's capped Vertex route. False or absent: a Gemini turn fails before anything
   * starts. Either way a Gemini session never runs a bridge on this server (SB01).
   */
  antigravity?: boolean;
}

/** Marley's provider routing (marshal-sdk `providerFor`): `gemini-*` models on Antigravity, every other model on the host's Claude. */
export const MARLEY_PROVIDER_FOR = providerForModelFamily({ google: { id: "antigravity" } });

/** Whether a model runs on Antigravity (a Gemini model), by the same routing the host uses. */
export function runsOnAntigravity(model: unknown): boolean {
  return typeof model === "string" && MARLEY_PROVIDER_FOR({ model })?.id === "antigravity";
}

/**
 * Antigravity built-ins a brand VM session never gets (review N4): image generation and web search call Google directly or through grounding, which
 * the model proxy refuses (it allows only the configured text model), so the model is not offered tools that always fail.
 */
export const ANTIGRAVITY_DISABLED_BUILTIN_TOOLS = ["generate_image", "search_web"] as const;

/**
 * One turn's Antigravity bridge on its brand VM (SshRunner.antigravitySpawner): `target` names the VM and chat it runs on. The engine adds the
 * bridge's `key` and the disabled built-ins.
 */
export interface VmAntigravityBridge {
  /** The brand, its VM and the chat (e.g. `brand:host:chat`): a change re-opens the session on a new bridge. */
  target: string;
  endpoint: AntigravityProxyEndpoint;
  spawnBridge(request: AntigravityBridgeSpawnRequest): AntigravityBridgeChild;
  workspaceDir?: string;
  homeDir?: string;
}

const ANTIGRAVITY_BRIDGE = Symbol.for("zygstinct.marley.antigravityBridge");
/** A Gemini turn's bridge on the brand VM (never on this server): what the engine's `antigravityBridgeFor` answers for the turn's session. */
export function withAntigravityBridge(options: Options, bridge: VmAntigravityBridge): Options {
  return Object.assign({ ...options }, { [ANTIGRAVITY_BRIDGE]: bridge });
}
function antigravityBridgeOf(options: Options): VmAntigravityBridge | undefined {
  return (options as { [ANTIGRAVITY_BRIDGE]?: VmAntigravityBridge })[ANTIGRAVITY_BRIDGE];
}

/**
 * The SDK's descriptor of a turn's VM bridge. The bridge's `key` covers the VM target and the whole endpoint (the tunnel's port and the proxy
 * session's key, review N6): the endpoint is read only when a bridge starts, so a turn whose proxy key or tunnel changed gets a new bridge instead of
 * one that keeps sending a closed key. Marley opens a proxy session per turn, so each turn starts its own bridge and resumes the conversation.
 */
export function antigravityDescriptor(bridge: VmAntigravityBridge): AntigravityRemoteBridge {
  assertProxyEndpoint(bridge.endpoint);
  const endpointHash = createHash("sha256").update(JSON.stringify(bridge.endpoint)).digest("hex").slice(0, 16);
  return {
    key: `${bridge.target}#${endpointHash}`,
    endpoint: bridge.endpoint,
    spawnBridge: (request) => bridge.spawnBridge(request),
    ...(bridge.workspaceDir ? { workspaceDir: bridge.workspaceDir } : {}),
    ...(bridge.homeDir ? { homeDir: bridge.homeDir } : {}),
    disabledBuiltinTools: [...ANTIGRAVITY_DISABLED_BUILTIN_TOOLS],
  };
}

/** The Agent SDK's query for a live process: a streaming prompt the port feeds one user message per turn. */
export type LiveQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }, sessionId: string) => AsyncIterable<SDKMessage>;

export interface EngineLiveOptions {
  /** The port closes a process idle this long (Marley's liveIdleMs). */
  idleSeconds: number;
  /** At most this many processes stay open; past it the least recently used idle one closes (Marley's liveMax). */
  maxLive: number;
  /** Default: the engine's `query`. */
  query?: LiveQueryFn;
  /** A live process closed, once per process, whatever closed it (the port's idle timer or eviction, a failed turn, `EngineLive.stream.close`). */
  onClosed: (sessionId: string, reason: LiveProcessCloseReason) => void;
}

/** One conversation's live process on the port, shaped like the SDK's streaming query so Marley's LiveSession drives it unchanged. */
export interface EngineLive {
  /** The Marshal session the process serves. */
  readonly sessionId: string;
  /** Every message the process relays, across turns; ends (or throws) when the process is gone. `close` ends the process. */
  readonly stream: AsyncIterable<SDKMessage> & { close(): void };
  /** Each push is one turn's user message: the first launches (or resumes) the session, later ones are sent to it. */
  readonly input: { push(prompt: string): void; end(): void };
}

/**
 * What Marley gives the port for one turn, taken apart from the Options a caller built: the launch options the port's `launchOptionsFor` returns
 * (gates and hooks, the remote spawner, cwd, env, limits, tool lists), and the two Agent SDK fields the port has no input for. The system prompt is
 * not among them: it is the turn's Marshal prompt layer, which the port assembles on the Marshal base.
 */
interface TurnInputs {
  launch: AgentLaunchOptions;
  /** `settingSources` (the port sends [] or ["project"]; a brand VM's MCP servers live in its "user" settings) and `thinking` (no port field). */
  extras: Pick<Options, "settingSources" | "thinking">;
  model?: string;
  effort?: string;
  nativeTools?: string[];
  layer?: PromptLayer;
  /** The chat's own runtime MCP on the brand VM (withRemoteRuntime): the host's `marshal` server carries runtime_* there and serves REMOTE_HOST_TOOLS itself. */
  remote?: RemoteRuntime;
  /** A Gemini turn's Antigravity bridge on the brand VM (withAntigravityBridge). */
  antigravity?: VmAntigravityBridge;
}

const REMOTE_RUNTIME = Symbol.for("zygstinct.marley.remoteRuntime");
/**
 * The host tools a Marley session on a brand VM reaches (marshal-sdk `remoteHostTools`): forks and their messages, session search and transcripts,
 * and memory. Every one is bounded to the session's own brand: the session tools by MARLEY_SESSION_SCOPE (the server-set `brand` label, which forks
 * copy), the fork tools to the caller's own children, memory by the session's scopes (brain-memory/). recordDecision stays out (no reader in Marley).
 */
export const MARLEY_REMOTE_HOST_TOOLS = [
  "marshal.tool.forkSubagents", "marshal.tool.listSubagents", "marshal.tool.messageSubagent", "marshal.tool.messageForks",
  "marshal.tool.searchSessions", "marshal.tool.getSessionTranscript",
  "marshal.tool.remember", "marshal.tool.recall", "marshal.tool.linkMemory", "marshal.tool.updateMemory", "marshal.tool.forget",
] as const;
/** The label that bounds the session tools to one brand (marshal-sdk `sessionScopeLabel`): set by the server on every session (run-records/labels.ts). */
export const MARLEY_SESSION_SCOPE = "brand";
/**
 * A turn whose brand VM runs the chat's runtime server for the host (VM feature `remote_runtime@1`): the session keeps the host's `marshal` server,
 * which carries runtime_search/runtime_exec to that runtime over `remote` (so every model-selected call still runs on the VM, SB01) and answers only the
 * SDK's fixed host tools (memory, sessions, decisions) itself. strictMcpConfig: the VM's own settings cannot add or shadow a server.
 */
export function withRemoteRuntime(options: Options, remote: RemoteRuntime): Options {
  return Object.assign({ ...options, strictMcpConfig: true, mcpServers: {} }, { [REMOTE_RUNTIME]: remote });
}
function remoteRuntimeOf(options: Options): RemoteRuntime | undefined {
  return (options as { [REMOTE_RUNTIME]?: RemoteRuntime })[REMOTE_RUNTIME];
}

/** How Marley runs the forks the host launches (MarshalEngineOptions.forks). Both resolve with the fork's outcome text and reject when it cannot run. */
export interface EngineForks {
  start(input: { parentSessionId: string; childSessionId: string; name: string; task: string }): Promise<string>;
  steer(input: { childSessionId: string; text: string }): Promise<string>;
}

/** The Options keys a caller may set; any other key is reported and left out (the port builds the SDK's options). */
const HANDLED_KEYS = new Set(["model", "effort", "thinking", "settingSources", "abortController", "permissionMode", "allowDangerouslySkipPermissions", "maxTurns", "maxBudgetUsd", "strictMcpConfig", "allowedTools", "disallowedTools", "cwd", "env", "pathToClaudeCodeExecutable", "extraArgs", "hooks", "outputFormat", "spawnClaudeCodeProcess", "mcpServers", "tools", "resume", "forkSession", "resumeSessionAt"]);

function turnInputs(options: Options, log?: MarshalEngineOptions["log"]): TurnInputs {
  if (options.systemPrompt !== undefined) throw new Error("marshal engine: a turn's prompt is a Marshal prompt layer (withPromptLayer), never options.systemPrompt");
  const dropped = Object.keys(options).filter((key) => !HANDLED_KEYS.has(key));
  if (dropped.length) log?.("marshal_engine.options_dropped", { keys: dropped });
  const env = options.env ? (Object.fromEntries(Object.entries(options.env).filter(([, value]) => typeof value === "string")) as Record<string, string>) : undefined;
  const launch: AgentLaunchOptions = {
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxBudgetUsd !== undefined ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
    ...(options.strictMcpConfig !== undefined ? { strictMcpConfig: options.strictMcpConfig } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(env ? { env } : {}),
    ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.hooks ? { hooks: options.hooks as Record<string, unknown> } : {}),
    ...(options.outputFormat !== undefined ? { outputFormat: options.outputFormat } : {}),
    ...(options.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: options.spawnClaudeCodeProcess } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers as Record<string, unknown> } : {}),
  };
  const layer = promptLayerOf(options);
  const remote = remoteRuntimeOf(options);
  const antigravity = antigravityBridgeOf(options);
  return {
    ...(remote ? { remote } : {}),
    ...(antigravity ? { antigravity } : {}),
    launch,
    extras: { ...(options.settingSources ? { settingSources: options.settingSources } : {}), ...(options.thinking ? { thinking: options.thinking } : {}) },
    ...(typeof options.model === "string" ? { model: options.model } : {}),
    ...(typeof options.effort === "string" ? { effort: options.effort } : {}),
    ...(Array.isArray(options.tools) ? { nativeTools: options.tools } : {}),
    ...(layer ? { layer } : {}),
  };
}

/** The launch request's own fields of a turn: the model, effort and native tool list the port keeps on the session. */
function launchFields(inputs: TurnInputs): { model?: string; reasoningEffort?: string; nativeTools?: string[] } {
  return { ...(inputs.model ? { model: inputs.model } : {}), ...(inputs.effort ? { reasoningEffort: inputs.effort } : {}), ...(inputs.nativeTools ? { nativeTools: inputs.nativeTools } : {}) };
}

/** One turn a caller is waiting on: what it gives the port and the messages the port's backend relays to it. */
interface PendingTurn {
  inputs: TurnInputs;
  messages: SDKMessage[];
  wake: (() => void) | null;
  ended: boolean;
  error?: { value: unknown };
  /** A live process's message stream: it spans turns and ends only with the process. */
  live?: boolean;
  /** The turn's prompt reaches Claude Code only once these MCP servers are connected (engine/mcp-ready.ts); checked on the real stream, which has the control channel. */
  mcpReady?: McpReadyOptions;
}

/**
 * A turn's launch options. A Marley session's tools are the brand VM's runtime (SB01), never the server's: without a remote runtime the host's own MCP
 * servers are off; with one (withRemoteRuntime) the host's `marshal` server stays, and it carries runtime calls to the VM. A session Marley did not
 * launch (a host fork, an automation of the host) has no launch options and is refused: without Marley's spawner its Claude Code would start on this
 * server (the port fails a turn whose launch options throw).
 */
function onVmOnly(sessionId: string, inputs: TurnInputs | undefined): AgentLaunchOptions {
  if (!inputs) throw new Error(`marshal engine: session ${sessionId} has no Marley launch; only Marley's own turns run (on the brand's sandbox)`);
  return (inputs.remote ? { ...inputs.launch, strictMcpConfig: true } : { ...inputs.launch, hostMcpServers: false }) as AgentLaunchOptions;
}

/**
 * Marley's turns on a Marshal SDK host (`createMarshalHost`). The engine is a QueryFn, so every caller (runRole and its budgets, limits and observers)
 * is unchanged: a call becomes a turn of a host session (a new one, a resumed one found by its native id, or a fork at a message). The host's port builds
 * the Agent SDK's options for every call: its system prompt is the host's (Marshal agent prompt v2: the SDK's base with its memory, forks and session
 * slots, Marley's host layer, the session's memory block) with the turn's Marley layer (engine/marshal-prompt.ts), and Marley's limits, tool lists, cwd,
 * env and the remote spawner reach it as the session's launch options (`launchOptionsFor`), rebuilt for every call, so a session the port adopts after a
 * restart still runs behind them. The host's MCP servers never attach (`hostMcpServers: false`), the host gets no environment of this process (`env: {}`),
 * and its native-subagent hook is off (Marley removes Agent/Task with disallowedTools and runs no hooks). The front's sessions run in the port's live
 * mode (`liveFor`), every other session one process per turn. The host starts on the first `start()`; every turn awaits it.
 */
export class MarshalEngine {
  private host: MarshalHost | null = null;
  private starting: Promise<MarshalHost> | null = null;
  private readonly pending = new Map<string, PendingTurn>();
  /** Each session's VM runtime connection, from its latest turn (kept between turns: the host keeps one connection per session across turns). */
  private readonly remotes = new Map<string, RemoteRuntime>();
  /** Forks whose task already started: a later turn of theirs is a message to that task (EngineForks.steer). */
  private readonly forkTasks = new Set<string>();
  /** Marshal session by the backend's (Claude Code's) session id, for resumes. */
  private readonly byNative = new Map<string, string>();

  constructor(private readonly options: MarshalEngineOptions) {}

  /** Starts the host once (a failed start is tried again by the next call). */
  start(): Promise<MarshalHost> {
    return (this.starting ??= this.open().catch((error: unknown) => {
      this.starting = null;
      throw error;
    }));
  }

  private async open(): Promise<MarshalHost> {
    const options = this.options;
    const workspacePath = path.join(options.root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const live = options.live;
    const host = await createMarshalHost({
      workspacePath,
      stateRoot: options.root,
      runId: options.hostId,
      host: { id: options.hostId, kind: "marley-agent-server" },
      env: {},
      model: "sonnet",
      browser: false,
      repoRules: false,
      nativeSubagentGuard: false,
      query: (params) => this.relay(params),
      prompt: marleyHostPrompt(options.agentName ?? "Marley"),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.orgSearch ? { orgSearch: options.orgSearch } : {}),
      // A fork of a Marley session runs as a Marley worker task (relayFork): the port's own launch options are never used for it.
      launchOptionsFor: (session) => (!this.pending.has(session.id) && this.isMarleyFork(session) ? ({ hostMcpServers: false } as AgentLaunchOptions) : this.launchOf(session)),
      // Gemini models run on Antigravity, each turn with its bridge on the turn's brand VM; a Gemini turn without one, or on a server without the
      // Vertex route, fails here, before anything starts. Their turns still run through `query` (wrapRoutedTurns), so relay delivers their messages
      // and a fork of a Gemini session becomes a Marley worker task like any fork (relayFork).
      providerFor: MARLEY_PROVIDER_FOR,
      wrapRoutedTurns: true,
      antigravityBridgeFor: (session) => this.antigravityBridge(session),
      // A fork's conversation is staged on the brand VM by its worker task (tasks/fork.ts), never copied from this server: the host starts it fresh
      // and Marley's own path forks it at the parent turn's end. Its outcome reaches the parent's conversation through Marley's relay, not as a notice.
      forkPoint: () => ({ fresh: true }),
      forkReports: false,
      // Only a session whose turn named its VM runtime has one; every other session gets no host runtime at all (hostMcpServers false above).
      remoteRuntime: (session) => this.remotes.get(session.id),
      // One host serves every brand on this server: the session tools see only the caller's brand, and the fork tools only its own children.
      remoteHostTools: MARLEY_REMOTE_HOST_TOOLS,
      sessionScopeLabel: MARLEY_SESSION_SCOPE,
      ...(options.hostCapabilities
        ? {
            providerSources: [() => options.hostCapabilities!.provider((sessionId) => (sessionId ? this.host?.sessions.get(sessionId)?.labels : undefined)) as never],
            remoteEmbedderTools: [...options.hostCapabilities.tools],
          }
        : {}),
      log: (line) => options.log?.("marshal_engine.host", { line }),
      ...(options.onSessionEvent ? { onSessionEvent: options.onSessionEvent } : {}),
      ...(live
        ? {
            // Marley rolls a process over at its own liveMaxTurns before this would.
            live: { idleSeconds: live.idleSeconds, maxLive: live.maxLive, maxTurns: Number.MAX_SAFE_INTEGER },
            liveFor: (session: SessionRecord) => this.pending.get(session.id)?.live === true,
            onLiveProcessClosed: (sessionId: string, reason: LiveProcessCloseReason) => {
              this.end(sessionId);
              this.remotes.delete(sessionId);
              this.pending.delete(sessionId);
              options.log?.("marshal_engine.live_closed", { sessionId, reason });
              live.onClosed(sessionId, reason);
            },
          }
        : {}),
    });
    for (const record of host.sessions.list()) if (record.native.sessionId) this.byNative.set(record.native.sessionId, record.id);
    // A live session's turns end at their result messages; its stream ends only with its process (onLiveProcessClosed).
    host.agents.onSettled((sessionId, outcome) => {
      const turn = this.pending.get(sessionId);
      if (turn?.live) return;
      // A Gemini turn that failed before its model ran (no Vertex route, no VM bridge: the port's launch options) never reached relay; its caller gets the port's failure.
      if (turn && !turn.ended && !turn.error && outcome.state === "failed" && runsOnAntigravity(turn.inputs.model ?? this.store.get(sessionId)?.model)) {
        turn.error = { value: new Error(outcome.error) };
      }
      this.end(sessionId);
      this.remotes.delete(sessionId);
    });
    this.host = host;
    return host;
  }

  private get started(): MarshalHost {
    if (!this.host) throw new Error("marshal engine: the host has not started (await engine.start())");
    return this.host;
  }

  /** The host's session store. */
  get store(): SessionStore {
    return this.started.sessions;
  }

  /** The host's agent port: every session, per-turn and live. */
  get port(): ClaudeAgentPort {
    return this.started.agents;
  }

  /** The host's prompt of a session, as the port assembles it. */
  systemPrompt(sessionId: string): string | undefined {
    return this.host?.systemPrompt(sessionId);
  }

  /**
   * Opens a conversation's live process on the port's live mode with the options Marley built for it (they are sent unchanged for the
   * process's life; a later turn reuses them, so the port never sees a changed signature). The process starts at the first push.
   */
  openLive(options: Options): EngineLive {
    if (!this.options.live) throw new Error("marshal engine: live processes are off");
    // The port keeps live processes for Claude sessions only; a Gemini session runs one turn at a time (its bridge per turn on the brand VM).
    if (runsOnAntigravity(options.model)) throw new Error(`marshal engine: ${String(options.model)} runs on Antigravity, one turn at a time; a live process is Claude only`);
    const port = this.port;
    const named = labelsOf(options);
    const resume = typeof options.resume === "string" ? options.resume : undefined;
    const fork = options.forkSession === true && resume !== undefined;
    const known = resume && !fork ? this.byNative.get(resume) : undefined;
    const existing = known && !port.isRunning(known) && !this.pending.has(known) ? known : undefined;
    const sessionId = existing ?? randomUUID();
    const inputs = turnInputs(options, this.options.log);
    const turn: PendingTurn = { inputs, messages: [], wake: null, ended: false, live: true };
    this.pending.set(sessionId, turn);
    this.prepare(sessionId, inputs, existing !== undefined);
    let launched = existing !== undefined;
    const input = {
      push: (prompt: string) => {
        if (turn.ended) throw new Error("input closed");
        if (launched) {
          port.send(sessionId, prompt);
          return;
        }
        launched = true;
        port.launch({
          task: prompt,
          idempotencyKey: sessionId,
          sessionId,
          name: named?.title ?? "Marley",
          ...launchFields(inputs),
          ...(named ? { labels: named.labels } : {}),
          ...(fork
            ? { native: { forkOf: resume, ...(typeof options.resumeSessionAt === "string" ? { forkAt: options.resumeSessionAt } : {}) } }
            : resume
              ? { native: { sessionId: resume } }
              : {}),
        });
      },
      end: () => undefined,
    };
    const stream = {
      [Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => ({
        next: async () => {
          for (;;) {
            const message = turn.messages.shift();
            if (message) return { value: message, done: false };
            if (turn.ended) {
              const error = turn.error;
              turn.error = undefined;
              if (error) throw error.value;
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              turn.wake = resolve;
            });
            turn.wake = null;
          }
        },
        return: async () => ({ value: undefined, done: true }),
      }),
      close: () => this.closeLive(sessionId),
    };
    return { sessionId, stream, input };
  }

  /**
   * Ends a conversation's live process: closed between turns (its queue and record kept, so a rollover resumes cleanly), cancelled while a
   * turn runs. `onClosed` follows from the port. Ends the stream either way.
   */
  closeLive(sessionId: string): void {
    const port = this.host?.agents;
    if (port?.get(sessionId) && !port.closeLive(sessionId) && port.isRunning(sessionId)) port.cancel(sessionId);
    this.end(sessionId);
    if (this.pending.get(sessionId)?.live) this.pending.delete(sessionId);
    const record = this.store.get(sessionId);
    if (record?.native.sessionId) this.byNative.set(record.native.sessionId, sessionId);
  }

  /** The engine as a QueryFn: what ClaudeTurnRunner and runRole call instead of `query`. */
  readonly queryFn: QueryFn = (params) => this.turn(params.prompt, params.options);
  /** A per-turn QueryFn whose prompt waits for the brand's MCP servers (a worker's first call must find the `marshal` tools). */
  queryFnGatedOnMcp(ready: McpReadyOptions): QueryFn {
    return (params) => this.turn(params.prompt, params.options, ready);
  }

  /** Stops every running session. */
  async dispose(): Promise<void> {
    const host = this.starting ? await this.starting.catch(() => null) : null;
    await host?.dispose();
  }

  /** The Marshal session that holds this backend session, if this store has one. */
  sessionOf(nativeSessionId: string): string | undefined {
    return this.byNative.get(nativeSessionId);
  }

  private async *turn(prompt: string, options: Options, mcpReady?: McpReadyOptions): AsyncGenerator<SDKMessage> {
    await this.start();
    const named = labelsOf(options);
    const resume = typeof options.resume === "string" ? options.resume : undefined;
    const fork = options.forkSession === true && resume !== undefined;
    const existing = resume && !fork ? this.byNative.get(resume) : undefined;
    // A session a live process holds is never resumed by a per-turn call: that call gets a new session.
    const sessionId = existing && !this.port.isRunning(existing) && !this.pending.has(existing) ? existing : randomUUID();
    const inputs = turnInputs(options, this.options.log);
    const turn: PendingTurn = { inputs, messages: [], wake: null, ended: false, ...(mcpReady ? { mcpReady } : {}) };
    this.pending.set(sessionId, turn);
    this.prepare(sessionId, inputs, sessionId === existing);
    const callerAbort = options.abortController;
    let settled = false;
    const cancel = () => {
      if (!settled) this.port.cancel(sessionId);
    };
    try {
      if (sessionId === existing) {
        this.port.send(sessionId, prompt);
      } else {
        this.port.launch({
          task: prompt,
          idempotencyKey: sessionId,
          sessionId,
          name: named?.title ?? "Marley",
          ...launchFields(inputs),
          ...(named ? { labels: named.labels } : {}),
          ...(fork
            ? { native: { forkOf: resume, ...(typeof options.resumeSessionAt === "string" ? { forkAt: options.resumeSessionAt } : {}) } }
            : resume
              ? { native: { sessionId: resume } }
              : {}),
        });
      }
      if (callerAbort?.signal.aborted) cancel();
      else callerAbort?.signal.addEventListener("abort", cancel, { once: true });
      for (;;) {
        while (turn.messages.length) {
          const message = turn.messages.shift()!;
          yield message;
          if (message.type === "result") {
            settled = true;
            return;
          }
        }
        if (turn.ended) break;
        await new Promise<void>((resolve) => {
          turn.wake = resolve;
        });
        turn.wake = null;
      }
      settled = true;
      if (turn.error) throw turn.error.value;
    } finally {
      callerAbort?.signal.removeEventListener("abort", cancel);
      // A caller that stops reading before the result (its own error, an early return) stops the session's turn too.
      if (!settled) this.port.cancel(sessionId);
      if (this.pending.get(sessionId) === turn) this.pending.delete(sessionId);
      const record = this.store.get(sessionId);
      if (record?.native.sessionId) this.byNative.set(record.native.sessionId, sessionId);
    }
  }

  /**
   * Gives the session its Marley prompt layer before the port renders its prompt, and, for a session that already exists, the turn's model, effort
   * and native tool list (the port sends the session's own; a launch passes them in its request). The tool list is replaced even when the turn names
   * none: the port builds the SDK's `tools` from the record, so a session launched by a toolless turn (the onboarding first reply's `tools: []`)
   * would otherwise keep no native tools for every later turn that resumes it.
   */
  private prepare(sessionId: string, inputs: TurnInputs, existing: boolean): void {
    if (inputs.remote) this.remotes.set(sessionId, inputs.remote);
    else this.remotes.delete(sessionId);
    if (!inputs.layer) this.options.log?.("marshal_engine.no_prompt_layer", { sessionId });
    this.started.setSessionPrompt(sessionId, inputs.layer);
    if (existing) this.store.update(sessionId, { ...(inputs.model ? { model: inputs.model } : {}), ...(inputs.effort ? { reasoningEffort: inputs.effort } : {}), nativeTools: inputs.nativeTools });
  }

  /**
   * The port's backend: the Agent SDK called with the options the port built for this turn (its Marshal prompt, launch options, resume, store),
   * plus only the fields the port has no input for (TurnInputs.extras); every message also goes to the caller. Its `close` closes the SDK's
   * query, which the port calls when it closes a live process.
   */
  private relay(params: { prompt: unknown; options: Record<string | symbol, unknown> }): AsyncGenerator<Record<string, any>> & { close(): void } {
    const holder: { query?: { close?: () => void } } = {};
    return Object.assign(this.relayMessages(params, holder), {
      close: () => {
        try {
          holder.query?.close?.();
        } catch {
          /* already gone */
        }
      },
    });
  }

  private async *relayMessages(params: { prompt: unknown; options: Record<string | symbol, unknown> }, holder: { query?: { close?: () => void } }): AsyncGenerator<Record<string, any>> {
    const extras = params.options[TURN_EXTRAS] as TurnExtras | undefined;
    const sessionId = extras?.sessionId;
    const turn = sessionId ? this.pending.get(sessionId) : undefined;
    if (sessionId && !turn) {
      const record = this.store.get(sessionId);
      if (record && this.isMarleyFork(record)) {
        yield* this.relayFork(record, params.prompt);
        return;
      }
    }
    if (!sessionId || !turn) throw new Error(`marshal engine: no waiting turn for session ${sessionId ?? "(none)"}`);
    if (Boolean(extras?.live) !== Boolean(turn.live)) throw new Error(`marshal engine: session ${sessionId} is ${turn.live ? "" : "not "}live, the port's turn is ${extras?.live ? "" : "not "}live`);
    // The port's options go to the SDK as the port built them; Marley adds only what the port has no field for (settingSources, thinking).
    // The port hands its prompt over as a bare string, which the Agent SDK records on a session's first request and replays on every resume and fork
    // (snapshot by default): a worker forked from the front's session would keep the front's prompt. The same text goes as {type: "custom", prompt,
    // snapshot: false}, the SDK's only way to say "render fresh": the content is the port's Marshal prompt, unchanged.
    const portPrompt = params.options.systemPrompt;
    const options = { ...params.options, ...turn.inputs.extras, ...(typeof portPrompt === "string" ? { systemPrompt: { type: "custom", prompt: portPrompt, snapshot: false } } : {}) } as Options;
    delete (options as Record<symbol, unknown>)[TURN_EXTRAS];
    // A Gemini turn (the host routed its session to Antigravity): the provider's own query with the port's options as they are (TURN_EXTRAS kept), and
    // the bridge antigravityBridgeFor gave the turn. Without that bridge it would start one on this server (SB01), so the turn fails instead.
    const routed = extras?.routedProvider;
    if (routed) {
      if (turn.live) throw new Error(`marshal engine: session ${sessionId} runs on ${routed.runtime}, which has no live process`);
      if (routed.runtime !== "antigravity" || !extras.antigravityBridge) throw new Error(`marshal engine: session ${sessionId} runs on ${routed.runtime} with no Antigravity bridge on its brand VM; a Gemini session never runs on this server`);
    }
    // A live process: the port's streaming input goes to the SDK as is, and each message goes to the conversation's stream (its turns
    // end at their result messages, which LiveSession reads). The call ends only with the process.
    const messages = routed
      ? routed.query({ prompt: params.prompt as string, options: params.options as Options })
      : turn.live
        ? (this.options.live?.query ?? (this.options.query as unknown as LiveQueryFn))({ prompt: params.prompt as AsyncIterable<SDKUserMessage>, options }, sessionId)
        : (turn.mcpReady ? gateOnMcp(this.options.query, turn.mcpReady) : this.options.query)({ prompt: params.prompt as string, options });
    holder.query = messages as { close?: () => void };
    // Everything below belongs to this turn only: a provider's stream can outlive its result (Antigravity's closes after it), and by then the session's
    // next turn may be pending under the same id; ending or feeding that one from here would end it with no result.
    const mine = (): boolean => this.pending.get(sessionId) === turn;
    try {
      for await (const message of messages) {
        // The port asks for partial messages (they keep a session's activity time moving); Marley's callers never read them.
        if (message.type !== "stream_event" && mine()) this.deliver(sessionId, message as SDKMessage);
        yield message as Record<string, any>;
      }
    } catch (error) {
      if (mine()) turn.error = { value: error };
      throw error;
    } finally {
      if (mine()) this.end(sessionId);
    }
  }

  /** A Marley turn's launch options (onVmOnly). */
  private launchOf(session: SessionRecord): AgentLaunchOptions {
    return onVmOnly(session.id, this.pending.get(session.id)?.inputs);
  }

  /**
   * The SDK asks this for each turn of a session on Antigravity: the turn's bridge on its brand VM. A turn that runs a model never gets undefined,
   * which would start the bridge on this server (SB01): a server without the Vertex route, or a turn without a VM bridge (an adopted session, a host
   * fork when Marley's forks are off), fails instead, and relay refuses a routed turn that reaches it without a bridge. Only a Marley fork gets none.
   */
  private antigravityBridge(session: SessionRecord): AntigravityRemoteBridge | undefined {
    // A fork of a Marley session (a Gemini session's fork, or a Gemini fork of a Claude one) never runs a model here: relay hands its turn to a Marley
    // worker task (relayFork), whose own turns run on the worker's model with their own VM bridge. No bridge is started for it, so none is needed.
    if (!this.pending.has(session.id) && this.isMarleyFork(session)) return undefined;
    const model = session.model || "(default)";
    if (!this.options.antigravity) throw new Error(`marshal engine: ${model} runs on Antigravity, and this server has no Vertex route (VERTEX_PROJECT unset); a Gemini session never runs here`);
    const bridge = this.pending.get(session.id)?.inputs.antigravity;
    if (!bridge) throw new Error(`marshal engine: session ${session.id} (${model}) has no Antigravity bridge on its brand VM; a Gemini session never runs on this server`);
    return antigravityDescriptor(bridge);
  }

  /** A session the host launched as a fork of a Marley session (its parent is in this store). */
  private isMarleyFork(session: SessionRecord): boolean {
    return this.options.forks !== undefined && session.fork !== undefined && session.parentId !== undefined && this.host?.sessions.get(session.parentId) !== undefined;
  }

  /**
   * One turn of a fork: its first starts the fork's worker task, a later one (messageSubagent) steers it. The turn's messages are the task's outcome as
   * one answer, so the port settles the fork with it; a failure fails the fork's turn.
   */
  private async *relayFork(record: SessionRecord, prompt: unknown): AsyncGenerator<Record<string, any>> {
    const forks = this.options.forks!;
    const text = typeof prompt === "string" ? prompt : "";
    const started = this.forkTasks.has(record.id);
    this.options.log?.("marshal_engine.fork_turn", { sessionId: record.id, parentId: record.parentId, mode: started ? "steer" : "start" });
    yield { type: "system", subtype: "init", session_id: record.native.sessionId ?? randomUUID() };
    let outcome: string;
    if (started) outcome = await forks.steer({ childSessionId: record.id, text });
    else {
      this.forkTasks.add(record.id);
      try {
        outcome = await forks.start({ parentSessionId: record.parentId!, childSessionId: record.id, name: record.title, task: record.fork?.task ?? text });
      } catch (error) {
        this.forkTasks.delete(record.id);
        throw error;
      }
    }
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: outcome }] } };
    yield { type: "result", subtype: "success", is_error: false, result: outcome, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 };
  }

  private deliver(sessionId: string, message: SDKMessage): void {
    const turn = this.pending.get(sessionId);
    if (!turn || turn.ended) return;
    turn.messages.push(message);
    if (message.type === "system" && message.subtype === "init") this.byNative.set(message.session_id, sessionId);
    turn.wake?.();
  }

  /** Ends the caller's stream (a live one when its process is gone: only the per-turn port reports settled turns). */
  private end(sessionId: string): void {
    const turn = this.pending.get(sessionId);
    if (!turn || turn.ended) return;
    turn.ended = true;
    turn.wake?.();
  }
}
