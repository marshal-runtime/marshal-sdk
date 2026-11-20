import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { createAllowAllPermissionBroker } from "@marshal/runtime";
import * as runtimeExtensions from "@marshal/runtime/extensions";
import { RUNTIME_EVENT_BUS } from "@marshal/runtime/events";
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from "@marshal/runtime/extensions";
import { createRuntimeServiceContainer } from "@marshal/runtime/host";
import { createRuntimeToolAdapter, RUNTIME_MCP_TOOLS } from "@marshal/runtime/mcp";
import { z } from "zod";

import { ClaudeAgentPort, TURN_EXTRAS, type AgentPortOptions, type QueryFn, type TurnExtras } from "./agent-port.js";
import { marshalProviderTools, PROVIDER_TOOLS, resolveProvider, type ProviderSelection, type ResolvedProvider } from "./provider-selection.js";
import { PROVIDER_TOOLS_ONLY } from "./provider-query.js";
import type { AntigravityRemoteBridge } from "./providers.js";
import { callerSessionId, createAgentProvider, createSessionToolsProvider } from "./agent-provider.js";
import { createAutomationsProvider, HostAutomations, type AgentExtensionSource, type AutomationStore, type HostAutomationsOptions, type JobHandler } from "./automations.js";
import { createDecisionsProvider, DecisionDesk, type PersonRoute } from "./decisions.js";
import { createModelServices, createModelsProvider, type ModelServices, type ModelsConfig } from "./models/index.js";
import { skillVisibleTo } from "./profile.js";
import { extensionSkillSource, extensionSkillsPrompt, readExtensionSkills, type ExtensionSkill } from "./extension-skills.js";
import { createForkToolsProvider } from "./fork-provider.js";
import {
  assertHostPrivate,
  composeBrokers,
  createNotificationsProvider,
  importPolicyOf,
  withSecrets,
  workspaceScope,
  type DirectTool,
  type DirectToolContext,
  type MarshalHostPorts,
  type MarshalHostTelemetryEvent,
} from "./host-options.js";
import { ANTIGRAVITY_NATIVE_PROMPT_TOOLS, CLAUDE_NATIVE_PROMPT_TOOLS, DISABLED_NATIVE_TOOLS, NATIVE_SUBAGENT_ALLOWLIST } from "./native-tools.js";
import { ANTIGRAVITY_V2_SLOTS } from "./prompt-antigravity-slots.js";
import { repositoryRulesPrompt } from "./repo-rules.js";
import { createHostPrompts, sdkBaseLayer, type HostPromptOptions, type HostPrompts, type PromptLayer } from "./prompt.js";
import { type ForkPointOf, SessionForks, forksPromptSection } from "./forks.js";
import { normalizeKit, prepareKit, type KitSelection } from "./kit/index.js";
import { SessionPublisher } from "./kit/publisher.js";
import { OrgStore, type OrgStoreOptions, type OrgTranscriptOptions } from "./org-store/index.js";
import { OrgSessionSearch, type OrgSessionSearchOptions } from "./org-store/search.js";
import { companyBrainStores, createMemoryToolsProvider, decideQueries, decideRelevance, HostMemory, type MemoryOptions } from "./memory.js";
import { RunRecordsPublisher, type RunRecordsOptions } from "./run-records.js";
import { ORG_EXTENSION, dependencyOrder, readPackageManifest, unmetRequirements } from "./onboarding.js";
import { createSharedRuntime, sharedCallContext } from "./shared-runtime.js";
import { createLinkCallProvider } from "./link/call-provider.js";
import { linkPersonRoute } from "./link/decisions.js";
import { startLinkServer, type LinkLivePort, type LinkServer } from "./link/server.js";
import { createOrgBridge, type OrgBridge, type OrgBridgeOptions } from "./org-bridge.js";
import { httpLinkRelay, type LinkRelay } from "./org-host-room.js";
import { ConversationRoomRoute } from "./rooms-route.js";
import { FileSessionStore, type SessionRecord, type SessionStore } from "./session-store.js";
import { resultText, sessionMarshalTools, type MarshalToolCall, type MarshalToolCallWrapper } from "./session-server.js";

export type { MarshalToolCall, MarshalToolCallWrapper };
import { hostToolOf, refusedHostTool, remoteEmbedderToolSet, remoteExecNote, remoteHostToolSet, RemoteRuntimeClients, type RemoteRuntime, type RemoteToolResult } from "./remote-tools.js";


const HARNESS_ID = "marshal-sdk";
const SDK_VERSION = "0.0.1";
const DEFAULT_MODEL = "claude-opus-5-5";
const SESSIONS_DIRECTORY = "sessions";
const AUTOMATIONS_DIRECTORY = "automations";
const PRIVATE_DIRECTORY = "runtime-private";
const EXEC_TIMEOUT_MS = 300_000;

export interface MarshalHostExtension {
  /** Absolute path of a built runtime extension package (the folder holding runtime-extension.json). */
  packageRoot: string;
  configuration?: unknown;
}

export interface MarshalHostExtensionState {
  identity: string;
  version: string;
  packageRoot: string;
  status: string;
  health: string;
  capabilities: string[];
  skills: string[];
  /** Loaded because it is one of the built-in defaults (marshal-sdk.json), not because it was listed. */
  fromDefaults: boolean;
}

/**
 * Everything a host passes in. The ports (MarshalHostPorts, docs/host-options.md) are what the desktop passes its own
 * runtime host; each one is optional and absent keeps the unattended defaults.
 */
export interface MarshalHostOptions extends MarshalHostPorts {
  /** Where sessions work: the checkout or scratch folder of this run. */
  workspacePath: string;
  /**
   * The Marshal workspace this host serves (e.g. "zygstinct" for a worktree of it), default the folder name. It names
   * the kit's Brain route and the workspace memory scope (`workspace:<name>`, the desktop's form), so give the
   * workspace's own name when the folder is a worktree or a scratch path.
   */
  workspaceName?: string;
  /** Host-private folder outside the workspace: runtime state and the session store. */
  stateRoot: string;
  extensions?: readonly MarshalHostExtension[];
  /** Identities that came from the manifest's built-in defaults; the start-up report marks them (withManifest sets it). */
  defaultExtensions?: readonly string[];
  /**
   * Zyg's shared knowledge for every session: `["brain", "memory", "sessions"]` (docs/kit.md). Read-only
   * unless the kit options turn a write on.
   */
  kit?: KitSelection;
  /** One run of this host; every session it starts carries it. Defaults to a new id. */
  runId?: string;
  /** Which machine or sandbox this is, as other Marshals will show it. */
  host?: { id: string; kind: string };
  labels?: Record<string, string>;
  model?: string;
  reasoningEffort?: string;
  /** Environment of the model backend. Defaults to this process's. */
  env?: Record<string, string>;
  /** Give sessions a headless browser (Playwright MCP) when the package is installed. Default true. */
  browser?: boolean | MarshalHostBrowser;
  /** The model provider of this host's sessions and its credentials: Claude, Codex or Cursor, subscription or API key (docs/providers.md). Default: Claude on the desktop's Claude client with `env` as given. */
  provider?: ProviderSelection;
  /**
   * Another provider for some sessions, so one host runs several (Gemini on Antigravity for one role, Claude for the
   * rest). Asked with a new session's model when the session is created; its answer is recorded as the session's
   * runtime and its turns run on that provider from then on. Undefined, or the host's own provider id with nothing
   * else, keeps the session on `provider`. `providerForModelFamily` builds one from model families. The selection is
   * resolved on first use, with the host's env and secrets.
   */
  providerFor?: (session: { model?: string }) => ProviderSelection | undefined;
  /** Test hook: every turn of the host's own provider runs on this instead of it (sessions `providerFor` routes elsewhere keep theirs). */
  query?: QueryFn;
  /**
   * With `query` and `providerFor`: a turn of a session `providerFor` routed to another provider runs through `query`
   * too, so an embedder's wrapper around the model run (its sandbox, outbox, run report) holds on every provider. The
   * turn's `TurnExtras.routedProvider` names that provider and carries its own query, which the wrapper calls in place
   * of its usual model query with the turn's options (its own merged in, the `TURN_EXTRAS` entry kept). The wrapper may
   * set the turn's `antigravityBridge` in those extras; `antigravityBridgeFor` also sets it, and its prompt then names
   * the VM's built-ins. Default false: routed turns run straight on their provider and `query` sees only the host's own.
   */
  wrapRoutedTurns?: boolean;
  /**
   * Load the workspace's repository rules the way the desktop does: the provider reads its own convention (Claude:
   * CLAUDE.md, .claude/rules), and the rest (AGENTS.md, .github and .cursor rules) goes into the prompt. Default true.
   */
  repoRules?: boolean;
  log?: (line: string) => void;
  /** Serve this host over the link (docs/link.md) so another Marshal can watch and drive it. */
  link?: MarshalHostLinkOptions;
  /** Schedule- and event-based runs (docs/kit.md, "Automations"). */
  automations?: MarshalHostAutomationOptions;
  /** Where decisions, questions and gaps go to people, and where their answers come from (docs/kit.md). */
  routes?: readonly PersonRoute[];
  /** Publish this host's sessions to a Marshal organization and run the instructions people post to them (docs/org-bridge.md). */
  org?: MarshalHostOrgOptions;
  /**
   * Write each run as run records the organization's run index reads (docs/run-records.md): a service host's way into
   * the org, no person's token needed. Published when a session goes idle or fails; `allow` decides which runs leave.
   */
  runRecords?: Omit<RunRecordsOptions, "store">;
  /**
   * The Zyg org's session store (docs/org-session-storage.md): each root session is published to GCS under
   * `sdk/v1/<workspace>/<impl>/<partition>/<day>/<root>/` with an index row, and the backend's transcripts go there
   * through the Agent SDK `sessionStore`, straight to the bucket. Writes happen after a session goes idle, never inside a turn.
   * `isCurrent` says when this machine already holds a native session's transcript, so a resume reads nothing from the cloud.
   */
  orgStore?: Omit<OrgStoreOptions, "log"> & { isCurrent?: OrgTranscriptOptions["isCurrent"] };
  /**
   * Search-only access to an org store this host does not publish to: searchSessions and getSessionTranscript also read the sessions other hosts
   * published under `workspace` (bounded by `sessionScopeLabel` like every other session). Ignored when `orgStore` is set, which searches its own.
   */
  orgSearch?: Omit<OrgSessionSearchOptions, "log">;
  /** Which provider answers each non-chat model service: decide, embed, speech (docs/models.md). */
  models?: ModelsConfig;
  /** Test hook: the HTTP client model services use. */
  modelsFetch?: typeof fetch;
  /**
   * Layers over the shared Marshal prompt: surface, role, soul, slots, added sections, session context, or a full
   * override; `session` gives one session its own layer (docs/prompt.md).
   */
  prompt?: HostPromptOptions;
  /**
   * Memory for every session (docs/memory.md): marshal.tool.remember / recall / linkMemory / updateMemory / forget as
   * nodes of a Brain graph, and the memory block of each session's prompt (always-on preferences first). `store(session)`
   * names the Brain store and scopes (Marley: the brand's Spanner graph, scopes brand and person). Default: the kit's
   * company Brain with a `workspace` scope when the kit carries `memory`; with neither, sessions have no memory.
   */
  memory?: MemoryOptions;
  /**
   * Launch options for every turn of a session, rebuilt by the embedder for each turn (the port's `launchOptionsFor`): a remote spawner
   * (`spawnClaudeCodeProcess`, Claude Code on another machine), its cwd and env, tool lists, and `hostMcpServers: false` when the
   * session's tools are served elsewhere. A session adopted after a restart runs behind them too.
   */
  launchOptionsFor?: AgentPortOptions["launchOptionsFor"];
  /**
   * An Antigravity session whose bridge runs on another machine (a brand VM over ssh), the Antigravity counterpart of
   * a remote `spawnClaudeCodeProcess`: called for each turn of a session on Antigravity (the host's provider or one
   * `providerFor` chose); undefined keeps the bridge on this host. The bridge's model calls go to the descriptor's
   * proxy endpoint, so that machine holds no Google credential. Its built-in tools run on that machine, so the session
   * keeps them and its prompt names them, while a remote session (`remoteRuntime`) without a bridge here gets none of
   * them. Keep it cheap: return a descriptor; `spawnBridge` does the work when a bridge starts. Merged into
   * `launchOptionsFor` as `antigravityBridge`.
   */
  antigravityBridgeFor?: (session: SessionRecord) => AntigravityRemoteBridge | undefined;
  /**
   * A session whose Claude Code runs on another machine (a remote `spawnClaudeCodeProcess`): how the host reaches that
   * machine's own Marshal runtime MCP server over stdio (Marley: the ssh command that starts the brand VM's runtime for
   * that chat). For such a session the host's `marshal` server, an in-process SDK server carried over the Claude Code
   * process's own control channel (no listener, port or token), serves runtime_search / runtime_exec /
   * runtime_read_resource on the remote runtime and the fixed host tool set (REMOTE_HOST_TOOLS: forks, sessions, memory,
   * recordDecision) on this host; no other host capability, no browser server. Tool names stay `mcp__marshal__*` and
   * `marshal.tool.*`, so the prompt is the same local or remote. The session must keep the host's servers
   * (`hostMcpServers` not false) and should run with `strictMcpConfig` so a `marshal` server in the remote machine's
   * settings does not shadow this one. Undefined (the default): the session is local.
   */
  remoteRuntime?: (session: SessionRecord) => RemoteRuntime | undefined;
  /**
   * The host tools remote sessions may reach: a subset of REMOTE_HOST_TOOLS (default: all of them). Any other host tool a remote session names is
   * refused on the host and never forwarded. A host whose session store holds several tenants' sessions lists only tools scoped by the session itself
   * (the memory tools); the session tools (searchSessions, getSessionTranscript, messageSubagent, messageForks, listSubagents, forkSubagents) reach
   * every session of the store.
   */
  remoteHostTools?: readonly string[];
  /**
   * Capabilities of the embedder's own providers (`providerSources`) that remote sessions reach on the host too, beside `remoteHostTools`: state
   * only the host holds (Marley: the brand's runs of the day and its extensions). Every other embedder capability stays unreachable from a remote
   * session. The provider bounds each call to the caller (the invocation's session), as the session tools do with `sessionScopeLabel`.
   */
  remoteEmbedderTools?: readonly string[];
  /**
   * The host tools one remote session may reach, narrower than the host-wide `remoteHostTools` and `remoteEmbedderTools` (every name must be in
   * one of them; another is a configuration error that fails the turn). `[]`: the session reaches no host tool, every one is refused. Undefined
   * (or no function): the host-wide sets. Only remote sessions (`remoteRuntime`) use it.
   */
  remoteHostToolsFor?: (session: SessionRecord) => readonly string[] | undefined;
  /**
   * Wraps every call on a session's `marshal` server (and the same tools given straight to other providers): each call that reaches the
   * session's runtime (runtime_search, runtime_exec, runtime_read_resource, from the runtime tools or from inside a direct tool, which then
   * names itself as `alias`) and each direct tool the model calls. `next()` runs the call; the wrapper may record it and may return a changed
   * result (a prefix, a truncation). A runtime_read_resource result carries what was read as `structuredContent` ({contents}); a direct tool
   * reading through its context gets that back whatever the wrapper did to `content`, or the wrapper's error text when it returns `isError`.
   */
  toolCall?: MarshalToolCallWrapper;
  /**
   * The session label that bounds the session tools, for a host whose store holds several tenants' sessions (Marley: `brand`, set by the server on
   * every session it launches; forks copy their parent's labels). searchSessions and getSessionTranscript return only sessions (local and org)
   * whose label equals the caller's, and a caller without it sees none; forkSubagents, listSubagents, messageSubagent and messageForks act only for a calling
   * session (on its own children). Undefined (the default): one tenant, nothing is filtered.
   */
  sessionScopeLabel?: string;
  /**
   * Where a session is forked when its Claude session file is not on this host (a remote session, `remoteRuntime`): see ForkPointOf (forks.ts).
   * Marley: the parent's last finished turn, resumed on the brand VM.
   */
  forkPoint?: ForkPointOf;
  /**
   * Whether a fork's final message (or error) is queued into its parent session when the fork goes idle (default true). Marley sets false: its server
   * relays a fork's outcome to the parent's conversation itself, and a queued notice would start a turn in the parent's live process it did not plan.
   */
  forkReports?: boolean;
  /** Keep sessions' Claude Code processes alive between turns (the port's live mode); `liveFor` picks which sessions. */
  live?: AgentPortOptions["live"];
  liveFor?: AgentPortOptions["liveFor"];
  /** A session's live process closed (the port's `onLiveProcessClosed`). */
  onLiveProcessClosed?: AgentPortOptions["onLiveProcessClosed"];
  /** A session went idle or failed, after the host's own handling (run records, automations, org store). */
  onSessionEvent?: AgentPortOptions["onSessionEvent"];
  /**
   * The host's guard on Claude's native subagent tool (a PreToolUse hook allowing only the native subagent types the
   * host lists). False leaves it off: for an embedder that removes the native Agent tool with `disallowedTools` and runs
   * no hooks. Default true.
   */
  nativeSubagentGuard?: boolean;
}

/** The org bridge without what the host supplies; `host` defaults to the host's id. */
export type MarshalHostOrgOptions = Omit<OrgBridgeOptions, "store" | "agents" | "host"> & {
  host?: string;
  /** Sync and poll on a timer from the start. Default true; tests pass false and call host.org.sync()/poll(). */
  start?: boolean;
};

export interface MarshalHostAutomationOptions {
  /** Server jobs an automation's `job` body can name (docs/automations.md). */
  jobs?: Readonly<Record<string, JobHandler>>;
  /** The scheduler's clock. Tests pass a fake one with start: false and call host.automations.tick(). */
  now?: () => Date;
  /** How often the scheduler looks for due runs. Default 5 s. */
  tickMs?: number;
  /** Start the clock with the host. Default true; its first tick fires what fell due while no host ran. */
  start?: boolean;
  /** Default time zone of cron schedules. Defaults to the host's. */
  timezone?: string;
  /** Where automation definitions live (a database adapter, per tenant). Default: automations.json in the state folder. */
  store?: AutomationStore;
  /** Finds agent extension packages for automations with an extension body (contributes.agents). */
  extensions?: AgentExtensionSource;
  /** Asked before every automatic fire: go, hold (owed, asked again each tick) or skip. */
  firePolicy?: HostAutomationsOptions["firePolicy"];
  /** Fills the context slots an agent profile names. */
  contextFor?: HostAutomationsOptions["contextFor"];
  /** A tenant's time zone, for "after" triggers. */
  timezoneFor?: HostAutomationsOptions["timezoneFor"];
  inputFor?: HostAutomationsOptions["inputFor"];
  /** The session label naming an automation's tenant (default "tenant"; Marley uses "brand"). */
  tenantLabel?: string;
}

export interface MarshalHostLinkOptions {
  /** Bearer token every client presents; at least 16 characters. Without it the host does not start. */
  token: string;
  /** Default 127.0.0.1. */
  bind?: string;
  /** Default 0: a free port (read it from host.link.port). */
  port?: number;
  /** Folders clients may list and read besides the workspace, for example { output: "<dir>" }. */
  files?: Record<string, string>;
  nativeRoots?: string[];
  /** A page editor's data folder (pages/ and library/), to serve the pages runs make (src/link/pages.ts). */
  pagesDir?: string;
}

export interface MarshalHostBrowser {
  /** Chrome or Chromium to drive. Defaults to $MARSHAL_SDK_CHROME, else Playwright's Chrome channel. */
  executablePath?: string;
  /** Needed in containers without user namespaces. Defaults to $MARSHAL_SDK_CHROME_NO_SANDBOX === "1". */
  noSandbox?: boolean;
}

export interface MarshalHost {
  readonly runId: string;
  /** What this host runs without that it was asked for (a service Brain sign-in with no person), one line each. */
  readonly warnings: readonly string[];
  readonly sessions: SessionStore;
  readonly agents: ClaudeAgentPort;
  /** Forks of this host's sessions: fork, list, message; each fork reports to its parent when it goes idle. */
  readonly forks: SessionForks;
  /** Call one runtime capability the way an agent would, and return its output. */
  invoke<T = unknown>(capability: string, input?: unknown, timeoutMs?: number): Promise<T>;
  /** Search the runtime's capabilities and skills, as a session sees them (its agent profile's extension scope applies) when `sessionId` is given. */
  search(query: string, limit?: number, sessionId?: string): Promise<unknown>;
  /** Read a runtime resource (an extension skill `skill://<identity>/<name>`, its references, extension docs). */
  readResource(uri: string, sessionId?: string): Promise<{ uri: string; mimeType?: string; text?: string }>;
  /** Skills the installed extensions declare (`skill:` catalog contributions). */
  readonly skills: readonly Omit<ExtensionSkill, "content" | "references">[];
  /** Each installed extension as it came up: identity, version, its capabilities and declared skills. */
  readonly extensions: readonly MarshalHostExtensionState[];
  /** The system prompt a session of this host gets (a top-level session when none is named). */
  systemPrompt(sessionId?: string): string | undefined;
  /** Give one session its own prompt layer (soul, role, sections, context, override); undefined removes it. */
  setSessionPrompt(sessionId: string, layer: PromptLayer | undefined): void;
  /** The MCP servers a session of this host gets (`marshal`: an in-process SDK server, `playwright` when a browser is on), for a Claude Code process the host does not launch itself (claude-bridge.ts). */
  mcpServersFor(sessionId: string): Record<string, unknown>;
  /** The link server, when the host was created with `link`. */
  readonly link?: { url: string; port: number };
  /** The org bridge, when the host was created with `org`. */
  readonly org?: OrgBridge;
  /** Automations: definitions, the scheduler behind runtime.schedules.*, and tick() for a fake clock. */
  readonly automations: HostAutomations;
  /** The decisions record of this host's sessions and its person routes (addRoute). */
  readonly decisions: DecisionDesk;
  /** Non-chat model services on the host's providers: decide, embed, speech (also marshal.models.* capabilities). */
  readonly models: ModelServices;
  /** Memory: what remember/recall/forget use and what each session's prompt shows. */
  readonly memory: HostMemory;
  /** An event happened on this host; event automations for its type run. */
  emit(event: string, payload?: Record<string, unknown>): Promise<{ automationId: string; sessionId: string }[]>;
  dispose(): Promise<void>;
}

/**
 * A Marshal host without the desktop app: the portable runtime with the given extensions, the
 * `marshal.agent.*` capabilities backed by Claude Agent SDK sessions, and a session store.
 * Every session shares this one runtime, as the desktop's sessions do.
 */
export async function createMarshalHost(options: MarshalHostOptions): Promise<MarshalHost> {
  const log = options.log ?? (() => undefined);
  const telemetry = (name: string, details: Record<string, unknown> = {}) => {
    try {
      options.telemetry?.({ name, details } satisfies MarshalHostTelemetryEvent);
    } catch (error) {
      log(`telemetry ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const workspacePath = fs.realpathSync(options.workspacePath);
  fs.mkdirSync(options.stateRoot, { recursive: true });
  const stateRoot = fs.realpathSync(options.stateRoot);
  if (stateRoot === workspacePath || stateRoot.startsWith(`${workspacePath}${path.sep}`)) {
    throw new Error("stateRoot must be outside the workspace: agents work in the workspace.");
  }
  let runtimeRoot: string | undefined;
  if (options.runtimeRoot) {
    assertHostPrivate("runtimeRoot", options.runtimeRoot, workspacePath);
    fs.mkdirSync(options.runtimeRoot, { recursive: true });
    runtimeRoot = fs.realpathSync(options.runtimeRoot);
    assertHostPrivate("runtimeRoot", runtimeRoot, workspacePath);
  }
  if (options.worktreeRoot) assertHostPrivate("worktreeRoot", options.worktreeRoot, workspacePath);
  const privateRoot = path.join(stateRoot, PRIVATE_DIRECTORY);
  fs.mkdirSync(privateRoot, { recursive: true });
  const runId = options.runId ?? randomUUID();
  const hostSessionId = `host-${runId}`;
  const origin = { runId, host: options.host ?? { id: HARNESS_ID, kind: "local" } };
  const sessions: SessionStore = new FileSessionStore(path.join(stateRoot, SESSIONS_DIRECTORY), origin);
  const orgStore = options.orgStore ? new OrgStore({ log, ...options.orgStore }, sessions, options.orgStore.isCurrent) : undefined;
  if (orgStore) sessions.transcripts = orgStore.transcripts;
  const orgSearchLog = (line: string, fields?: Record<string, unknown>) => log(line + " " + JSON.stringify(fields ?? {}));
  const orgSearch = options.orgStore
    ? new OrgSessionSearch({ objects: options.orgStore.objects, workspace: options.orgStore.impl.workspace, log: orgSearchLog })
    : options.orgSearch
      ? new OrgSessionSearch({ ...options.orgSearch, log: orgSearchLog })
      : undefined;
  // The kit's company Brain answers memory.* once the runtime exists (`invoke` below); until then a call fails as unavailable.
  let brainInvoke: ((capability: string, input: Record<string, unknown>) => Promise<unknown>) | undefined;
  const workspaceName = options.workspaceName?.trim() || path.basename(workspacePath);
  const brainCall = (capability: string, input: Record<string, unknown>) => {
    if (!brainInvoke) throw Object.assign(new Error("The Brain is not ready yet."), { code: "unavailable" });
    return brainInvoke(capability, input);
  };
  const kitSelection = normalizeKit(options.kit);
  const kit = kitSelection ? prepareKit({ kit: kitSelection, sessions, workspacePath, workspaceName }) : undefined;
  const warnings: string[] = kit?.warning ? [kit.warning] : [];
  for (const warning of warnings) log(`WARNING ${warning}`);
  const kitMemory = kit?.parts.has("memory") === true;
  const kitStores = companyBrainStores(brainCall, {
    workspace: workspaceName,
    personEmail: options.memory?.personEmail ?? kitSelection?.brain?.callerEmail,
  });
  const memory = new HostMemory(
    {
      ...options.memory,
      ...(kitMemory ? { fallback: () => kitStores } : {}),
    },
    sessions,
  );
  const runRecordsPublisher = options.runRecords ? new RunRecordsPublisher({ log, ...options.runRecords, store: sessions }) : undefined;
  // Fails before anything starts when a listed package is missing or is not an extension, naming it; then names every
  // dependency or required setting the extensions declare and this host does not give, in one error.
  const extensions = dependencyOrder([...(kit?.extensions ?? []), ...(options.extensions ?? [])]);
  const packages = extensions.map((extension) => readPackageManifest(extension.packageRoot));
  const unmet = unmetRequirements(extensions);
  if (unmet.length) throw new Error(`This host cannot start; its extensions need:\n${unmet.map((problem) => `  - ${problem}`).join("\n")}`);
  const extensionSkills = extensions.flatMap((extension) => readExtensionSkills(extension.packageRoot));
  // Runtime packs that read `skill:` catalog contributions list these skills themselves.
  const runtimeReadsSkills = "readRuntimeExtensionSkills" in runtimeExtensions;
  const context = { sessionId: hostSessionId, workspacePath };

  // Both are filled once the runtime exists; sessions only read them when a turn starts.
  let prompts: HostPrompts | undefined;
  let serversFor: (session: SessionRecord) => Record<string, unknown> = () => ({});
  const remoteClients = new RemoteRuntimeClients(log);
  let automations: HostAutomations | undefined;
  let publisher: SessionPublisher | undefined;
  const runRecords = runRecordsPublisher;
  // A test's own query runs every turn; otherwise Claude is the default provider.
  const selection = options.provider ?? (options.query ? undefined : ({ id: "claude" } as const));
  const hostEnv = options.env ?? definedEnv(process.env);
  const provider = selection ? resolveProvider(selection, { env: withSecrets(hostEnv, options.secrets), privateRoot, log }) : undefined;
  if (provider) log(provider.description);
  const hostRuntime = provider?.id ?? "claude";
  const hostQuery = options.query ?? provider?.query ?? (claudeQuery as unknown as QueryFn);
  // providerFor: the providers it routes sessions to, each resolved once on first use.
  const routedProviders = new Map<string, ResolvedProvider>();
  const routedSelection = (model: string | undefined): ProviderSelection | undefined => {
    const chosen = options.providerFor?.(model ? { model } : {});
    if (!chosen) return undefined;
    if (chosen.id !== hostRuntime) return chosen;
    if (Object.entries(chosen).some(([key, value]) => key !== "id" && value !== undefined)) {
      throw new Error(`providerFor: sessions on ${chosen.id} run on the host's own provider (\`provider\`); route only to other providers.`);
    }
    return undefined;
  };
  const routedProvider = (chosen: ProviderSelection): ResolvedProvider => {
    const key = JSON.stringify([chosen.id, chosen.account, chosen.apiKeyEnv, chosen.home, chosen.engine]);
    let resolved = routedProviders.get(key);
    if (!resolved) {
      resolved = resolveProvider(chosen, { env: withSecrets(hostEnv, options.secrets), privateRoot, log });
      log(`providerFor: ${resolved.description}`);
      routedProviders.set(key, resolved);
    }
    return resolved;
  };
  if (options.wrapRoutedTurns && !options.query) throw new Error("wrapRoutedTurns needs the host's `query`, which runs the routed turns.");
  const wrapRouted = options.wrapRoutedTurns ? options.query : undefined;
  /** The runtime a session's turns run on: recorded when it was created (providerFor), else the host's. */
  const runtimeOfSession = (session: SessionRecord | undefined): string =>
    session && options.providerFor ? (session.runtimeId ?? session.runtime) : hostRuntime;
  // Each turn runs on its session's provider. A session keeps the provider it was created on: its native session
  // lives there, so a model that now routes elsewhere fails the turn instead of starting over on another provider.
  const routedQuery: QueryFn = (params) => {
    try {
      const extras = (params.options as Record<symbol, unknown>)[TURN_EXTRAS] as TurnExtras | undefined;
      const session = extras?.sessionId ? sessions.get(extras.sessionId) : undefined;
      const chosen = routedSelection(session?.model);
      const wanted = chosen?.id ?? hostRuntime;
      const runtime = runtimeOfSession(session);
      if (wanted !== runtime) {
        throw new Error(`Session ${session?.id ?? "?"} runs on ${runtime}, and its model ${session?.model || "(default)"} routes to ${wanted}; a session keeps its provider, so start a new session for that model.`);
      }
      if (!chosen) return hostQuery(params);
      const routed = routedProvider(chosen).query ?? (claudeQuery as unknown as QueryFn);
      if (!wrapRouted) return routed(params);
      // The embedder's query runs the turn and calls the provider's own query from the extras.
      const wrapped: TurnExtras = { ...(extras ?? { attachments: [] }), routedProvider: { runtime: chosen.id, query: routed } };
      return wrapRouted({ ...params, options: { ...params.options, [TURN_EXTRAS]: wrapped } });
    } catch (error) {
      return (async function* () {
        throw error;
      })();
    }
  };
  /** The session's Antigravity bridge on another machine (antigravityBridgeFor), for a session on Antigravity only. */
  const antigravityBridgeOf = (session: SessionRecord): AntigravityRemoteBridge | undefined =>
    runtimeOfSession(session) === "antigravity" ? options.antigravityBridgeFor?.(session) : undefined;
  const repoRules = options.repoRules !== false;
  const agents = new ClaudeAgentPort({
    query: options.providerFor ? routedQuery : hostQuery,
    runtimeId: hostRuntime,
    ...(options.providerFor ? { runtimeIdFor: (model: string | undefined) => routedSelection(model)?.id ?? hostRuntime } : {}),
    projectSettings: repoRules,
    ...(options.nativeSubagentGuard === false ? {} : { nativeTools: { disabled: DISABLED_NATIVE_TOOLS, subagentAllowlist: NATIVE_SUBAGENT_ALLOWLIST } }),
    store: sessions,
    cwd: workspacePath,
    env: provider?.env ?? options.env ?? definedEnv(process.env),
    defaultModel: options.model ?? provider?.defaultModel ?? DEFAULT_MODEL,
    ...(options.reasoningEffort ? { defaultReasoningEffort: options.reasoningEffort } : {}),
    ...(options.permissions?.canUseTool ? { permissionHandler: options.permissions.canUseTool } : {}),
    ...(options.settings ? { settings: () => options.settings!.read() } : {}),
    workspaceName,
    systemPrompt: (session) => prompts?.forSession(session),
    ...(options.antigravityBridgeFor
      ? {
          launchOptionsFor: (session: SessionRecord) => {
            const base = options.launchOptionsFor?.(session);
            const bridge = antigravityBridgeOf(session);
            return bridge ? { ...base, antigravityBridge: bridge } : base;
          },
        }
      : options.launchOptionsFor
        ? { launchOptionsFor: options.launchOptionsFor }
        : {}),
    ...(options.live ? { live: options.live } : {}),
    ...(options.liveFor ? { liveFor: options.liveFor } : {}),
    ...(options.onLiveProcessClosed || options.remoteRuntime
      ? {
          onLiveProcessClosed: (sessionId: string, reason: Parameters<NonNullable<AgentPortOptions["onLiveProcessClosed"]>>[1]) => {
            void remoteClients.close(sessionId);
            options.onLiveProcessClosed?.(sessionId, reason);
          },
        }
      : {}),
    prepareTurn: (session, message) => memory.warm(session, log, message),
    mcpServers: (session) => serversFor(session),
    log,
    onSessionEvent: (type, payload) => {
      telemetry(type, { sessionId: payload.sessionId, state: payload.state, ...(payload.parentId ? { parentId: payload.parentId } : {}) });
      automations?.emit(type, payload).catch((error: unknown) => log(`automations on ${type}: ${String(error)}`));
      if (typeof payload.sessionId === "string") publisher?.schedule(payload.sessionId);
      if (typeof payload.sessionId === "string") runRecords?.schedule(payload.sessionId);
      if (typeof payload.sessionId === "string" && (type === "session.idle" || type === "session.failed")) orgStore?.schedule(payload.sessionId);
      // A remote session keeps its runtime connection across turns; between turns it closes after the idle period.
      if (typeof payload.sessionId === "string" && (type === "session.idle" || type === "session.failed")) remoteClients.idle(payload.sessionId);
      try {
        options.onSessionEvent?.(type, payload);
      } catch (error) {
        log(`onSessionEvent ${type}: ${String(error)}`);
      }
    },
  });
  automations = new HostAutomations({
    root: path.join(stateRoot, AUTOMATIONS_DIRECTORY),
    port: agents,
    sessions,
    ...(options.automations?.now ? { now: options.automations.now } : {}),
    ...(options.automations?.tickMs ? { tickMs: options.automations.tickMs } : {}),
    ...(options.automations?.timezone ? { timezone: options.automations.timezone } : {}),
    ...(options.automations?.store ? { store: options.automations.store } : {}),
    ...(options.automations?.extensions ? { extensions: options.automations.extensions } : {}),
    ...(options.automations?.jobs ? { jobs: options.automations.jobs } : {}),
    ...(options.automations?.firePolicy ? { firePolicy: options.automations.firePolicy } : {}),
    ...(options.automations?.contextFor ? { contextFor: options.automations.contextFor } : {}),
    ...(options.automations?.timezoneFor ? { timezoneFor: options.automations.timezoneFor } : {}),
    ...(options.automations?.inputFor ? { inputFor: options.automations.inputFor } : {}),
    ...(options.automations?.tenantLabel ? { tenantLabel: options.automations.tenantLabel } : {}),
    log,
  });
  const hostAutomations = automations;
  const decisions = new DecisionDesk(sessions, agents, log);
  // marshal.link.call answers through a private loopback link that starts on first use (after the extensions activate).
  let linkRelay: LinkRelay | undefined;
  const forks = new SessionForks(agents, sessions, { log, ...(options.forkPoint ? { forkPoint: options.forkPoint } : {}), ...(options.forkReports === false ? { reportToParent: false } : {}) });
  const models = createModelServices(options.models, { env: withSecrets(options.env ?? process.env, options.secrets), ...(options.modelsFetch ? { fetch: options.modelsFetch } : {}) });
  // R153: which memories a session loads is judged on OpenAI Decisions (R54.2) unless the host names a decide provider.
  const memoryDecide = () => models.decideFor(options.models?.decide?.provider ?? "decisions");
  memory.useRelevance(decideRelevance((request, judgeOptions) => memoryDecide().judge(request, judgeOptions)));
  memory.useQueryPlanner(decideQueries((request, decideOptions) => memoryDecide().decide(request, decideOptions)));
  const importPolicy = importPolicyOf(options.trustedTypeScript);
  const broker =
    composeBrokers([kit?.permissionBroker, options.permissions?.broker], options.ui?.applicationAuthority) ?? createAllowAllPermissionBroker();
  const hostScope = workspaceScope(workspacePath);
  const runtimeHostRoot =
    runtimeRoot ?? path.join(workspacePath, ".marshal", "runtime", createHash("sha256").update(HARNESS_ID).digest("hex").slice(0, 16));
  const callContext = (sessionId: string) => sharedCallContext(sessionId, workspaceName, workspacePath);
  if (options.permissions?.approval || options.permissions?.resolveGrants || options.permissions?.patterns) {
    log("permissions.approval, resolveGrants and patterns are not taken by the shared runtime host yet; brokers and canUseTool decide");
  }
  // The desktop's own runtime host (packages/host), with the SDK's providers, brokers and scheduler plugged in.
  const runtime = await createSharedRuntime({
    root: runtimeHostRoot,
    workspacePath,
    workspaceName,
    ...(options.resolveWorkspace ? { resolveWorkspace: options.resolveWorkspace as never } : {}),
    privateRoot,
    worktreeRoot: options.worktreeRoot ?? path.join(stateRoot, "worktrees"),
    extensionRoot: path.join(stateRoot, "extensions"),
    serviceContainer: options.serviceContainer ?? createRuntimeServiceContainer(),
    ...(options.compositionRegistry ? { compositionRegistry: options.compositionRegistry } : {}),
    broker,
    sessionExtensionScope: (id) => sessions.get(id)?.extensions,
    principal: {
      id: `${HARNESS_ID}:${runId}`,
      kind: "agent",
      ...(kit && Object.keys(kit.claims).length ? { claims: kit.claims } : {}),
    },
    harnessId: HARNESS_ID,
    ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}),
    ...(importPolicy ? { trustedTypeScript: true } : {}),
    version: SDK_VERSION,
    providerSources: [
      ...(options.providerSources ?? []),
      () => createAgentProvider(agents, (id) => id !== undefined && sessions.get(id) !== undefined),
      () => createSessionToolsProvider(agents, sessions, { ...(orgSearch ? { orgSearch } : {}), ...(options.sessionScopeLabel ? { scopeLabel: options.sessionScopeLabel } : {}) }),
      () => createMemoryToolsProvider(memory),
      () => createForkToolsProvider(forks, options.sessionScopeLabel ? { requireCaller: true } : {}),
      () => createAutomationsProvider(hostAutomations),
      () => createDecisionsProvider(decisions),
      () => createModelsProvider(models),
      () => createLinkCallProvider(() => linkRelay),
      ...(options.notifications ? [() => createNotificationsProvider(options.notifications!)] : []),
      ...(kit?.providerSources ?? []),
      ...(extensionSkills.length && !runtimeReadsSkills ? [extensionSkillSource(extensionSkills)] : []),
    ],
    builtins: {
      artifacts: true,
      effects: false,
      extensionAuthoring: false,
      authoredUiPromotion: false,
      ...options.builtins,
      // runtime.schedules.* on this host's durable scheduler (agent.wake and the automation task kinds).
      scheduling: true,
      scheduler: hostAutomations.scheduler,
      reactUi: options.ui?.reactUi ?? false,
      declarativeUi: options.ui?.declarativeUi ?? false,
      ...(importPolicy ? { importPolicy } : {}),
    },
  });
  // The runtime lists extension skills; the desktop host's resource port doesn't read skill:// URIs, so the SDK does.
  const skillResources = extensionSkillSource(extensionSkills)().resources;
  const resourcesPort = {
    listResources: async (callerContext: unknown) => [...((await runtime.resources?.listResources(callerContext)) ?? [])],
    readResource: async (uri: string, callerContext: unknown) => {
      if (uri.startsWith("skill://")) {
        const caller = callerSessionId(callerContext as never);
        const owner = caller ? sessions.get(caller) : undefined;
        const hidden = extensionSkills.find((skill) => (uri === skill.uri || uri.startsWith(`${skill.uri}/`)) && !skillVisibleTo(skill, owner));
        if (hidden) throw new Error(`Skill ${hidden.name} is not part of this agent's profile.`);
      }
      try {
        return await runtime.resources.readResource(uri, callerContext);
      } catch (error) {
        if (uri.startsWith("skill://") && extensionSkills.length) return skillResources.readResource(uri);
        throw error;
      }
    },
  };
  // The core kernel takes the caller's own invocation context, so the Brain sees the same principal.
  kit?.bind((runtime as unknown as { core: never }).core);
  const lifecycleSubscription = options.telemetry
    ? (runtime as unknown as { core?: { observeLifecycle?(listener: (event: { type: string }) => void): { dispose(): void } } }).core?.observeLifecycle?.(
        (event) => telemetry(`runtime.${event.type}`),
      )
    : undefined;
  const settingsSubscription = options.settings?.subscribe?.((next) => {
    log(`settings changed: model ${next.model ?? "(default)"}, effort ${next.reasoningEffort ?? "(default)"}`);
    telemetry("settings.changed", { model: next.model, reasoningEffort: next.reasoningEffort });
  });

  const guidance: string[] = [];
  const installedExtensions: { identity: string; version: string }[] = [];
  const extensionStates: MarshalHostExtensionState[] = [];
  try {
    const lifecycle = runtime.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE) as any;
    for (const [index, extension] of extensions.entries()) {
      if (!lifecycle) throw new Error("This runtime was composed without extension support.");
      const declared = packages[index]!;
      let installed: { identity: string };
      try {
        // The org extension reaches this host only through capabilities; what it cannot ask for (who the host is, where
        // to keep its ledgers) the host gives it here, under any configuration the manifest set.
        const configuration =
          declared.identity === ORG_EXTENSION
            ? { hostId: (options.host ?? { id: HARNESS_ID }).id, hostKind: (options.host ?? { kind: "local" }).kind, stateDir: path.join(stateRoot, "org"), ...(extension.configuration as object | undefined) }
            : extension.configuration;
        installed = await runtime.installLocalExtension(extension.packageRoot, configuration);
      } catch (error) {
        throw new Error(`Extension ${declared.identity}@${declared.version} (${extension.packageRoot}) could not be installed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const record = lifecycle.get(installed.identity);
      const fromDefaults = options.defaultExtensions?.includes(installed.identity) ?? false;
      if (record?.health !== "healthy" || record.status !== "enabled") {
        throw new Error(
          `Extension ${installed.identity}@${declared.version} (${extension.packageRoot}) did not activate: status ${record?.status ?? "missing"}, health ${record?.health ?? "unknown"}, reasons ${JSON.stringify(record?.blockReasons ?? [])}`,
        );
      }
      extensionStates.push({
        identity: installed.identity,
        version: String(record.version),
        packageRoot: extension.packageRoot,
        status: String(record.status),
        health: String(record.health),
        capabilities: declared.capabilities,
        skills: declared.skills,
        fromDefaults,
      });
      telemetry("extension.installed", { identity: installed.identity, version: String(record.version), fromDefaults });
      log(`extension ${installed.identity}@${record.version}${fromDefaults ? " (default)" : ""} ${record.status}, ${record.health}: ${declared.capabilities.length} capabilities, ${declared.skills.length} skills`);
      installedExtensions.push({ identity: installed.identity, version: String(record.version) });
      if (record.agentGuidance) guidance.push(`${installed.identity}: ${JSON.stringify(record.agentGuidance)}`);
    }
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
  // Events the runtime publishes (lifecycle, extensions) trigger event automations too.
  const eventBus = (runtime.serviceContainer as any).tryGet(RUNTIME_EVENT_BUS as never) as
    | { subscribe(type: "*", listener: (event: { type: string; payload: unknown }) => unknown): { dispose(): void } }
    | undefined;
  const eventSubscription = eventBus?.subscribe("*", (event) => {
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : { value: event.payload };
    void hostAutomations.emit(event.type, payload).catch((error: unknown) => log(`automations on ${event.type}: ${String(error)}`));
  });
  if (options.automations?.start !== false) hostAutomations.start();
  for (const route of options.routes ?? []) await decisions.addRoute(route);

  const adapterFor = (sessionId: string) =>
    createRuntimeToolAdapter({
      kernel: runtime.kernel,
      resources: resourcesPort,
      lifecycle: runtime.lifecycle,
      context: callContext(sessionId),
    } as never);
  const hostAdapter = adapterFor(context.sessionId);
  const browserServer =
    options.browser === false
      ? undefined
      : playwrightServer(typeof options.browser === "object" ? options.browser : {}, log, options.nodeExecutable);
  const directTools = options.directTools ?? [];
  const runtimeTools = options.runtimeTools !== false;
  const forksCall =
    !runtimeTools && directTools.some((direct) => direct.name === "runtimeInvoke")
      ? "mcp__marshal__runtimeInvoke {capability: '<name>', input}"
      : undefined;
  // The base prompt names the session's own runtime's tools, so it depends on the session's provider (providerFor).
  const baseLayers = new Map<string, PromptLayer>();
  const baseLayerOf = (runtimeId: string, noBuiltins: boolean): PromptLayer => {
    const key = `${runtimeId}:${noBuiltins}`;
    let layer = baseLayers.get(key);
    if (!layer) {
      const rulesSection = repoRules ? repositoryRulesPrompt(workspacePath, runtimeId) : "";
      layer = sdkBaseLayer({
        browser: browserServer !== undefined,
        extensionGuidance: guidance,
        sections: [...(kit?.promptSection ? [kit.promptSection] : []), forksPromptSection(forksCall)],
        ...(rulesSection ? { repoRules: rulesSection } : {}),
        runtimeTools,
        directTools,
        // The test hook's query stands in for the host's own provider, which then has no native tools.
        ...(runtimeId === "claude" && (runtimeId !== hostRuntime || !options.query) ? { nativeTools: CLAUDE_NATIVE_PROMPT_TOOLS } : {}),
        // A remote Antigravity session with its bridge on this host has none of Antigravity's built-ins (serversFor),
        // so its prompt names none; with its bridge on its own machine (antigravityBridgeFor) it has them there.
        ...(runtimeId === "antigravity" && !noBuiltins ? { nativeTools: ANTIGRAVITY_NATIVE_PROMPT_TOOLS, runtimeSlots: ANTIGRAVITY_V2_SLOTS } : {}),
      });
      baseLayers.set(key, layer);
    }
    return layer;
  };
  prompts = createHostPrompts(
    (session) => {
      const runtimeId = runtimeOfSession(session);
      return baseLayerOf(
        runtimeId,
        runtimeId === "antigravity" &&
          session !== undefined &&
          options.remoteRuntime?.(session) !== undefined &&
          antigravityBridgeOf(session) === undefined,
      );
    },
    options.prompt,
    log,
    (session) => {
      const visible = extensionSkillsPrompt(extensionSkills.filter((skill) => skillVisibleTo(skill, session)));
      return visible ? [visible] : [];
    },
    (session) => memory.promptContext(session),
  );

  const remoteHostTools = remoteHostToolSet(options.remoteHostTools);
  const remoteEmbedderTools = remoteEmbedderToolSet(options.remoteEmbedderTools);
  const hostWideTools: ReadonlySet<string> = new Set([...remoteHostTools, ...remoteEmbedderTools]);
  const sessionHostTools = (session: SessionRecord): ReadonlySet<string> => {
    const listed = options.remoteHostToolsFor?.(session);
    if (listed === undefined) return hostWideTools;
    const unknown = listed.filter((name) => !hostWideTools.has(name));
    if (unknown.length) throw new Error(`remoteHostToolsFor: not a host tool this host allows: ${unknown.join(", ")} (remoteHostTools and remoteEmbedderTools list them)`);
    return new Set(listed);
  };
  serversFor = (session: SessionRecord): Record<string, unknown> => {
    const hostAdapterOfSession = adapterFor(session.id);
    const remote = options.remoteRuntime?.(session);
    const allowedHostTools = remote ? sessionHostTools(session) : hostWideTools;
    // A remote session's runtime calls go to its own machine's runtime, except the host tools it may reach (remote-tools.ts).
    const adapter = remote
      ? {
          callTool: (name: string, args: unknown) => {
            const hostTool = hostToolOf(name, args, remoteEmbedderTools);
            if (hostTool === undefined) return remoteClients.callTool(session.id, remote, name, args);
            return allowedHostTools.has(hostTool) ? hostAdapterOfSession.callTool(name, args, undefined as never) : Promise.resolve(refusedHostTool(hostTool));
          },
          readResource: (uri: string) => remoteClients.readResource(session.id, remote, uri),
        }
      : {
          callTool: (name: string, args: unknown) => hostAdapterOfSession.callTool(name, args, undefined as never),
          readResource: (uri: string) => hostAdapterOfSession.readResource(uri),
        };
    const execNote = remote && allowedHostTools.size ? remoteExecNote(allowedHostTools) : "";
    const { server: marshal, call, readContents, runDirect } = sessionMarshalTools({
      session,
      runtime: adapter as never,
      workspacePath,
      directTools,
      runtimeTools: runtimeTools || remote !== undefined,
      trustedTypeScript: !remote && importPolicy !== undefined,
      execNote,
      descriptions: { search: RUNTIME_MCP_TOOLS[0]!.description ?? "", exec: RUNTIME_MCP_TOOLS[1]!.description ?? "" },
      ...(options.toolCall ? { toolCall: options.toolCall } : {}),
    });
    // A remote session gets only its `marshal` tools: no host browser, no other MCP server. On the Claude Agent SDK
    // they are the `marshal` server; a provider client (Antigravity, Codex, Cursor) runs in this process, so it takes
    // the same tools as provider tools, whose calls still go to the remote runtime, and nothing else: none of its own
    // built-ins (a shell, file tools) may run on this machine (SB01).
    if (remote) {
      const schemas = RUNTIME_MCP_TOOLS.map((schema) =>
        schema.name === "runtime_exec" && execNote ? { ...schema, description: `${schema.description ?? ""}${execNote}` } : schema,
      );
      return {
        marshal,
        [PROVIDER_TOOLS]: [...marshalProviderTools(call as never, readContents, schemas as never), ...directProviderTools(directTools, runDirect)],
        [PROVIDER_TOOLS_ONLY]: true,
      };
    }
    return {
      marshal,
      ...(browserServer ? { playwright: browserServer } : {}),
      // Providers other than the Claude Agent SDK take these tools directly; that SDK reads only string keys.
      [PROVIDER_TOOLS]: [
        ...(runtimeTools ? marshalProviderTools(call as never, readContents, RUNTIME_MCP_TOOLS as never) : []),
        ...directProviderTools(directTools, runDirect),
      ],
    };
  };

  const invoke = async <T>(capability: string, input: unknown = {}, timeoutMs = EXEC_TIMEOUT_MS): Promise<T> => {
    const result = (await hostAdapter.callTool(
      "runtime_exec",
      { targetType: "operation", target: capability, input, timeoutMs },
      undefined as never,
    )) as { structuredContent?: Record<string, any> };
    const response = result.structuredContent ?? {};
    if (response.status !== "success") {
      throw Object.assign(new Error(`${capability} failed: ${JSON.stringify(response.error ?? response).slice(0, 2000)}`), {
        response,
      });
    }
    return response.result?.output as T;
  };
  brainInvoke = (capability, input) => invoke(capability, input);
  if (kit?.publishes) publisher = new SessionPublisher((sessionId) => invoke("sessions.share", { sessionId }), log);
  if (kit?.parts.has("brain")) void brainReady(invoke, log);
  const search = async (query: string, limit = 10, sessionId?: string): Promise<unknown> => {
    const result = (await (sessionId ? adapterFor(sessionId) : hostAdapter).callTool("runtime_search", { query, limit }, undefined as never)) as {
      structuredContent?: unknown;
    };
    return result.structuredContent;
  };

  let org: OrgBridge | undefined;
  if (options.org) {
    try {
      const { start: startOrg, ...orgOptions } = options.org;
      // A room route asks in the session's room; the org inbox may carry the answer, so the bridge offers it messages.
      const answers = orgOptions.answers ?? options.routes?.find((route): route is ConversationRoomRoute => route instanceof ConversationRoomRoute);
      org = createOrgBridge({
        ...orgOptions,
        ...(answers ? { answers } : {}),
        store: sessions,
        agents,
        host: orgOptions.host ?? options.host?.id ?? HARNESS_ID,
        log: orgOptions.log ?? log,
      });
      if (startOrg !== false) org.start();
    } catch (error) {
      await agents.dispose().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  let link: LinkServer | undefined;
  let names: Promise<string[]> | undefined;
  const live: LinkLivePort = {
    send: (sessionId, text, deliveryMode) => agents.send(sessionId, text, deliveryMode),
    cancel: (sessionId) => agents.cancel(sessionId),
    invoke: (capability, input) => invoke(capability, input),
    extensions: () => [...installedExtensions],
    capabilities: () => (names ??= capabilityNames(runtime.kernel as never, callContext(context.sessionId))),
    answer: (input) => decisions.answer({ ...input, route: "link" }),
  };
  const linkFiles = { workspace: workspacePath, ...options.link?.files };
  let innerLink: Promise<{ server: LinkServer; token: string }> | undefined;
  const startInnerLink = async () => {
    const token = randomBytes(24).toString("hex");
    const server = await startLinkServer({ token, bind: "127.0.0.1", port: 0, sessionsRoot: sessions.root, host: options.host ?? { id: HARNESS_ID, kind: "local" }, files: linkFiles, live, log });
    return { server, token };
  };
  linkRelay = async (request) => {
    const inner = await (innerLink ??= startInnerLink());
    return httpLinkRelay(inner.server.url, () => inner.token)(request);
  };
  if (options.link) {
    try {
      link = await startLinkServer({
        token: options.link.token,
        ...(options.link.bind ? { bind: options.link.bind } : {}),
        port: options.link.port ?? 0,
        sessionsRoot: sessions.root,
        host: options.host ?? { id: HARNESS_ID, kind: "local" },
        files: linkFiles,
        ...(options.link.nativeRoots ? { nativeRoots: options.link.nativeRoots } : {}),
        ...(options.link.pagesDir ? { pagesDir: options.link.pagesDir } : {}),
        live,
        log,
      });
      log(`link serving on ${link.url}`);
      await decisions.addRoute(linkPersonRoute(link.url));
    } catch (error) {
      await agents.dispose().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  telemetry("host.started", { runId, extensions: extensionStates.length, provider: provider?.id ?? "test", runtimeRoot: runtimeRoot !== undefined });
  return {
    runId,
    warnings,
    sessions,
    agents,
    forks,
    systemPrompt: (sessionId) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      return prompts?.forSession(session ?? undefined);
    },
    setSessionPrompt: (sessionId, layer) => prompts?.setSessionLayer(sessionId, layer),
    mcpServersFor: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No session ${sessionId} on this host.`);
      return serversFor(session);
    },
    invoke,
    search,
    readResource: async (uri, sessionId) => {
      const read = (await (sessionId ? adapterFor(sessionId) : hostAdapter).readResource(uri)) as { contents: { uri: string; mimeType?: string; text?: string }[] };
      return read.contents[0]!;
    },
    extensions: extensionStates,
    skills: extensionSkills.map(({ content: _content, references: _references, ...skill }) => skill),
    ...(link ? { link: { url: link.url, port: link.port } } : {}),
    ...(org ? { org } : {}),
    automations: hostAutomations,
    models,
    memory,
    decisions,
    emit: (event, payload = {}) => hostAutomations.emit(event, payload),
    async dispose(): Promise<void> {
      eventSubscription?.dispose();
      lifecycleSubscription?.dispose();
      settingsSubscription?.();
      await publisher?.flush();
      await runRecords?.close();
      await orgStore?.close();
      await hostAutomations.stop();
      await decisions.stop();
      await link?.close();
      await org?.close();
      forks.dispose();
      await models.dispose().catch(() => undefined);
      await agents.dispose();
      await remoteClients.closeAll();
      // Stopping the agents ends their running turns, which schedules one more publish each; it must reach the
      // Brain before the runtime takes its capabilities down (2026-11-16: capability_not_found on the last upload).
      await publisher?.close();
      await provider?.query?.dispose();
      for (const routed of routedProviders.values()) await routed.query?.dispose().catch((error: unknown) => log(`providerFor dispose: ${String(error)}`));
      await runtime.dispose();
      // After the runtime: the org extension publishes its last turns through it while it closes.
      if (innerLink) await (await innerLink).server.close();
    },
  };
}

/** Every capability the runtime lists: the kernel's search without a query returns the whole catalog. */
async function capabilityNames(
  kernel: { search(request: unknown, context: unknown): Promise<{ matches?: { capability?: { name?: string } }[] }> },
  context: unknown,
): Promise<string[]> {
  const found = await kernel.search({ limit: 500 }, context).catch(() => undefined);
  return [...new Set((found?.matches ?? []).map((match) => match.capability?.name).filter((name): name is string => !!name))].sort();
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function playwrightServer(browser: MarshalHostBrowser, log: (line: string) => void, nodeExecutable?: string): Record<string, unknown> | undefined {
  try {
    // @playwright/mcp's exports map hides cli.js, so resolving "@playwright/mcp/cli.js" always throws.
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("@playwright/mcp/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { bin?: Record<string, string> };
    const cli = path.join(path.dirname(manifestPath), manifest.bin?.["playwright-mcp"] ?? "cli.js");
    const executablePath = browser.executablePath ?? (process.env.MARSHAL_SDK_CHROME || undefined);
    const noSandbox = browser.noSandbox ?? process.env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1";
    return {
      // In a packaged app process.execPath is the app binary, not node.
      command: nodeExecutable ?? process.execPath,
      args: [cli, "--headless", "--isolated", ...(executablePath ? ["--executable-path", executablePath] : []), ...(noSandbox ? ["--no-sandbox"] : [])],
    };
  } catch (error) {
    log(`no browser for sessions: @playwright/mcp not usable (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

/** Embedder direct tools for providers that take tools directly (JSON Schema from the zod shape); `run` is the session's (wrapped) call of one. */
function directProviderTools(
  directTools: readonly DirectTool[],
  run: (direct: DirectTool) => (args: Record<string, unknown>) => Promise<RemoteToolResult>,
): unknown[] {
  return directTools.map((direct) => ({
    name: direct.name,
    description: direct.description,
    parameters: z.toJSONSchema(z.object(direct.inputSchema)),
    handler: async (args: unknown) => {
      const result = await run(direct)((args ?? {}) as Record<string, unknown>);
      const joined = resultText(result.content);
      if (result.isError) throw new Error(joined);
      return joined;
    },
  }));
}





/**
 * The Brain's own warm-up calls the front's `schema` tool, which can take ~25 s when the front has not computed it
 * recently, gives up after 20 s and only logs "cloud_brain_timeout" while later calls work. This says plainly
 * whether the Brain answers, with a one-hit search: `schema` would hold one of the Brain's two call slots for that long.
 */
async function brainReady(invoke: (capability: string, input: unknown) => Promise<unknown>, log: (line: string) => void, attempts = 3): Promise<void> {
  const started = Date.now();
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await invoke("knowledge.search", { query: "Marshal SDK host readiness check", limit: 1 });
      log(`kit: Brain ready in ${Date.now() - started} ms (attempt ${attempt})`);
      return;
    } catch (error) {
      last = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000).unref());
    }
  }
  log(`kit: Brain not answering after ${attempts} tries in ${Date.now() - started} ms; sessions run without it until it does: ${last}`);
}
