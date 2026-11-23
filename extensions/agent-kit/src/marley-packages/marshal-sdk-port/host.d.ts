// Declarations of the vendored host (host/index.js, built by vendor.mjs from marshal-sdk src/host.ts). Hand-kept: only the parts Marley
// uses, typed from the SDK's own (MarshalHostOptions, MarshalHost, MemoryOptions). Check them against src/host.ts and src/memory.ts when
// SDK_COMMIT moves.
import type { AgentPortOptions, ClaudeAgentPort, HostAutomations, HostPromptOptions, PromptLayer, QueryFn, SessionRecord, SessionStore } from "./index.js";
import type { AntigravityBridgeChild, AntigravityBridgeSpawnRequest, AntigravityProxyEndpoint, AntigravityRemoteBridge } from "./types/providers.js";

export type { AntigravityBridgeChild, AntigravityBridgeSpawnRequest, AntigravityProxyEndpoint, AntigravityRemoteBridge };

/** marshal-sdk src/provider-selection.ts: the providers a host runs sessions on (Marley: Claude, and Antigravity for Gemini models). */
export type ProviderId = "claude" | "openai" | "codex" | "cursor" | "antigravity";
/** Which model provider runs a session and on whose credentials (marshal-sdk `ProviderSelection`, the fields Marley may use). */
export interface ProviderSelection {
  id: ProviderId;
  account?: string;
  apiKeyEnv?: string;
  home?: string;
}
/** Model families `providerForModelFamily` routes by (`claude-*` anthropic, `gpt-*` openai, `gemini-*` google). */
export type ModelProviderFamily = "anthropic" | "openai" | "google";
export declare function providerForModelFamily(routes: Partial<Record<ModelProviderFamily, ProviderSelection>>): (session: { model?: string }) => ProviderSelection | undefined;
/** Refuses an endpoint that is not a credential-free proxy (any key, credential header, URL userinfo or query, unknown field). */
export declare function assertProxyEndpoint(endpoint: unknown): asserts endpoint is AntigravityProxyEndpoint;
/** The SDK's bridge.py: the brand VM's installed copy must have its sha256 (image/install/chat-exec.py). */
export declare const ANTIGRAVITY_BRIDGE_SOURCE: string;
/** The google-antigravity version bridge.py is written for (the VM's image/antigravity/requirements.txt). */
export declare const ANTIGRAVITY_SDK_VERSION: string;

export interface MemoryScope {
  /** The scope's name as sessions use it (`appliesTo`): lower-case letters, digits, `-`, `_`. */
  id: string;
  key: Record<string, string>;
}

export type MemoryCategory = "preference" | "decision" | "fact" | "context";

/** One edge from a memory: exactly one target (a graph node, a code path with an optional symbol, a session, a person). */
export interface BrainMemoryLink {
  nodeId?: string;
  path?: string;
  symbol?: string;
  sessionId?: string;
  personId?: string;
  rel?: string;
}

/** A memory node as the Brain returns it. */
export interface BrainMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  scope: string;
  alwaysOn: boolean;
  createdAt: string;
  updatedAt?: string;
  links: BrainMemoryLink[];
  sessionId?: string;
  author?: string;
}

/** A Brain store's memory operations (marshal-sdk src/memory.ts `BrainMemoryRoute`). */
export interface BrainMemoryRoute {
  id: string;
  create(input: { content: string; category: MemoryCategory; scope: string; alwaysOn: boolean; links: BrainMemoryLink[]; supersedes?: string; sessionId?: string; author?: string }): Promise<BrainMemory>;
  update(input: { id: string; scopes: string[]; content?: string; category?: MemoryCategory; alwaysOn?: boolean; links?: BrainMemoryLink[] }): Promise<BrainMemory>;
  link(input: { id: string; scopes: string[]; links: BrainMemoryLink[] }): Promise<BrainMemory>;
  delete(input: { id: string; scopes: string[] }): Promise<boolean>;
  search(input: { query: string; scopes: string[]; limit: number; category?: MemoryCategory }): Promise<BrainMemory[]>;
  list(input: { scope: string; alwaysOn?: boolean; since?: string; limit: number }): Promise<BrainMemory[]>;
}

/** What a session's memory uses: one Brain store and the scopes it reads, broadest first. */
export interface MemoryStore {
  route: BrainMemoryRoute;
  scopes: readonly MemoryScope[];
}

export interface MemoryOptions {
  /** The Brain store and scopes of a session; undefined: the session has no memory and the tools say so. */
  store?: (session: SessionRecord | undefined) => MemoryStore | undefined;
  promptLimit?: number;
  alwaysOnLimit?: number;
  refreshMs?: number;
}

export interface HostMemory {
  /** Waits for background scope reads. */
  settle(): Promise<void>;
  [member: string]: unknown;
}

/** marshal-sdk src/memory-typed-graph.ts. */
export type TypedGraphExecute = (request: { op: string; storeId: string; tenant: string; call: Record<string, unknown> }) => Promise<unknown>;
export interface TypedGraphHit {
  id: string;
  [field: string]: unknown;
}
export interface TypedGraphMemoryRouteOptions {
  id: string;
  execute: TypedGraphExecute;
  tenant: string;
  storeOf(scope: string): string;
  accessOf?(scope: string): readonly string[] | undefined;
  merge?(lists: readonly { scope: string; hits: readonly TypedGraphHit[] }[], limit: number): string[];
}
export declare function typedGraphMemoryRoute(options: TypedGraphMemoryRouteOptions): BrainMemoryRoute;

/** How the host reaches a remote session's own Marshal runtime MCP server over stdio (marshal-sdk src/remote-tools.ts). */
export interface RemoteRuntime {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}
/** The host capabilities a remote session reaches on the host; every other capability runs on the remote runtime. */
export declare const REMOTE_HOST_TOOLS: readonly string[];

export interface MarshalHostOptions {
  workspacePath: string;
  stateRoot: string;
  runId?: string;
  host?: { id: string; kind: string };
  labels?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
  /** Environment of the model backend. Defaults to this process's: Marley passes `{}` so nothing of the server reaches a brand VM. */
  env?: Record<string, string>;
  browser?: boolean;
  query?: QueryFn;
  repoRules?: boolean;
  /** Whether sessions see the runtime's own tools; the prompt names them (`mcp__marshal__runtime_*`). Default true. */
  runtimeTools?: boolean;
  log?: (line: string) => void;
  prompt?: HostPromptOptions;
  memory?: MemoryOptions;
  launchOptionsFor?: AgentPortOptions["launchOptionsFor"];
  /** A remote session's own runtime (docs/remote-sessions.md); the session must keep the host's servers and run with strictMcpConfig. */
  remoteRuntime?: (session: SessionRecord) => RemoteRuntime | undefined;
  /** The host tools remote sessions may reach, a subset of REMOTE_HOST_TOOLS (default all); any other is refused on the host (marshal-sdk #115). */
  remoteHostTools?: readonly string[];
  /** Capabilities of the embedder's own `providerSources` that remote sessions reach on the host too (marshal-sdk #124); the provider bounds each call to its caller. */
  remoteEmbedderTools?: readonly string[];
  /** Capability providers of the embedder, registered before the SDK's own. */
  providerSources?: readonly (() => unknown)[];
  /** The session label that bounds the session tools to the caller's tenant (marshal-sdk #117; an org row by its partition keys too, #123); forks copy their parent's labels. */
  sessionScopeLabel?: string;
  /** Search-only access to an org store this host does not publish to (marshal-sdk #123): the session tools also read the sessions published under `workspace`. */
  orgSearch?: { objects: unknown; workspace: string; maxSessions?: number };
  /** Where a remote session is forked (marshal-sdk #118): `{forkAt}` resumes the parent there, `{fresh: true}` starts from the task alone. */
  forkPoint?: (parent: SessionRecord) => { forkAt: string } | { fresh: true } | undefined;
  /** Whether a fork's outcome is queued into its parent as a notice (marshal-sdk #119; default true). */
  forkReports?: boolean;
  live?: AgentPortOptions["live"];
  liveFor?: (session: SessionRecord) => boolean;
  onLiveProcessClosed?: AgentPortOptions["onLiveProcessClosed"];
  onSessionEvent?: AgentPortOptions["onSessionEvent"];
  /** False: no PreToolUse guard on the native Agent tool (Marley removes it with disallowedTools and runs no hooks). */
  nativeSubagentGuard?: boolean;
  /**
   * Another provider for some sessions: asked with a new session's model; its answer is recorded as the session's runtime and its turns run there
   * from then on (they bypass `query`; the port's `onEvent` launch option still sees every event). Marley: `gemini-*` on Antigravity.
   */
  providerFor?: (session: { model?: string }) => ProviderSelection | undefined;
  /**
   * An Antigravity session's bridge on another machine (the brand VM), the counterpart of a remote `spawnClaudeCodeProcess`. Undefined keeps the
   * bridge on this host, so Marley throws instead (a throw fails the turn). Merged into the port's launch options as `antigravityBridge`.
   */
  antigravityBridgeFor?: (session: SessionRecord) => AntigravityRemoteBridge | undefined;
  /**
   * With `query` and `providerFor`: a routed session's turn runs through `query` too, so the embedder's wrapper around the model run (sandbox, outbox,
   * run report) holds on every provider. The turn's `TurnExtras.routedProvider` names that provider and carries its query, which the wrapper calls in
   * place of its usual one, keeping the `TURN_EXTRAS` entry (it may set the turn's `antigravityBridge` there). Refused without `query`. Default false.
   */
  wrapRoutedTurns?: boolean;
  [option: string]: unknown;
}

export interface MarshalHost {
  readonly runId: string;
  readonly sessions: SessionStore;
  readonly agents: ClaudeAgentPort;
  invoke<T = unknown>(capability: string, input?: unknown, timeoutMs?: number): Promise<T>;
  systemPrompt(sessionId?: string): string | undefined;
  setSessionPrompt(sessionId: string, layer: PromptLayer | undefined): void;
  readonly automations: HostAutomations;
  readonly memory: HostMemory;
  readonly forks: unknown;
  readonly decisions: unknown;
  emit(event: string, payload?: Record<string, unknown>): Promise<{ automationId: string; sessionId: string }[]>;
  dispose(): Promise<void>;
}

export declare function createMarshalHost(options: MarshalHostOptions): Promise<MarshalHost>;

