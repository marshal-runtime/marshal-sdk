import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { createSdkMcpServer, query as claudeQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import { createAllowAllPermissionBroker } from "@marshal/runtime";
import * as runtimeExtensions from "@marshal/runtime/extensions";
import { RUNTIME_EVENT_BUS } from "@marshal/runtime/events";
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from "@marshal/runtime/extensions";
import { createRuntimeServiceContainer } from "@marshal/runtime/host";
import { createRuntimeToolAdapter, RUNTIME_MCP_TOOLS } from "@marshal/runtime/mcp";
import { z } from "zod";

import { ClaudeAgentPort, type AgentPortOptions, type QueryFn } from "./agent-port.js";
import { marshalProviderTools, PROVIDER_TOOLS, resolveProvider, type ProviderSelection } from "./provider-selection.js";
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
  type MarshalHostPorts,
  type MarshalHostTelemetryEvent,
} from "./host-options.js";
import { CLAUDE_NATIVE_PROMPT_TOOLS, DISABLED_NATIVE_TOOLS, NATIVE_SUBAGENT_ALLOWLIST } from "./native-tools.js";
import { repositoryRulesPrompt } from "./repo-rules.js";
import { createHostPrompts, sdkBaseLayer, type HostPromptOptions, type HostPrompts, type PromptLayer } from "./prompt.js";
import { SessionForks, forksPromptSection } from "./forks.js";
import { normalizeKit, prepareKit, type KitSelection } from "./kit/index.js";
import { SessionPublisher } from "./kit/publisher.js";
import { OrgStore, type OrgStoreOptions, type OrgTranscriptOptions } from "./org-store/index.js";
import { OrgSessionSearch } from "./org-store/search.js";
import { brainCapabilityRoute, createMemoryToolsProvider, HostMemory, type MemoryOptions } from "./memory.js";
import { RunRecordsPublisher, type RunRecordsOptions } from "./run-records.js";
import { ORG_EXTENSION, readPackageManifest } from "./onboarding.js";
import { createSharedRuntime, sharedCallContext } from "./shared-runtime.js";
import { createLinkCallProvider } from "./link/call-provider.js";
import { linkPersonRoute } from "./link/decisions.js";
import { startLinkServer, type LinkLivePort, type LinkServer } from "./link/server.js";
import { createOrgBridge, type OrgBridge, type OrgBridgeOptions } from "./org-bridge.js";
import { httpLinkRelay, type LinkRelay } from "./org-host-room.js";
import { ConversationRoomRoute } from "./rooms-route.js";
import { FileSessionStore, type SessionRecord, type SessionStore } from "./session-store.js";

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
  /** Test hook: every turn runs on this instead of a provider. */
  query?: QueryFn;
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
  /** Page Studio's data folder, to serve the pages runs make. Default: PAGE_STUDIO_DIR from the host's env. */
  pageStudioDir?: string;
}

export interface MarshalHostBrowser {
  /** Chrome or Chromium to drive. Defaults to $MARSHAL_SDK_CHROME, else Playwright's Chrome channel. */
  executablePath?: string;
  /** Needed in containers without user namespaces. Defaults to $MARSHAL_SDK_CHROME_NO_SANDBOX === "1". */
  noSandbox?: boolean;
}

export interface MarshalHost {
  readonly runId: string;
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
  const orgSearch = options.orgStore ? new OrgSessionSearch({ objects: options.orgStore.objects, workspace: options.orgStore.impl.workspace, log: (line, fields) => log(line + " " + JSON.stringify(fields ?? {})) }) : undefined;
  // The kit's company Brain answers memory.* once the runtime exists (`invoke` below); until then a call fails as unavailable.
  let brainInvoke: ((capability: string, input: Record<string, unknown>) => Promise<unknown>) | undefined;
  const companyBrain = brainCapabilityRoute("brain", (capability, input) => {
    if (!brainInvoke) throw Object.assign(new Error("The Brain is not ready yet."), { code: "unavailable" });
    return brainInvoke(capability, input);
  });
  const kitMemory = normalizeKit(options.kit)?.parts.includes("memory") === true;
  const memory = new HostMemory(
    {
      ...options.memory,
      ...(kitMemory ? { fallback: () => ({ route: companyBrain, scopes: [{ id: "workspace", key: { workspace: path.basename(workspacePath) } }] }) } : {}),
    },
    sessions,
  );
  const runRecordsPublisher = options.runRecords ? new RunRecordsPublisher({ log, ...options.runRecords, store: sessions }) : undefined;
  const kitOptions = normalizeKit(options.kit);
  const kit = kitOptions ? prepareKit({ kit: kitOptions, sessions, workspacePath }) : undefined;
  const extensions = [...(kit?.extensions ?? []), ...(options.extensions ?? [])];
  // Fails before anything starts when a listed package is missing or is not an extension, naming it.
  const packages = extensions.map((extension) => readPackageManifest(extension.packageRoot));
  const extensionSkills = extensions.flatMap((extension) => readExtensionSkills(extension.packageRoot));
  // Runtime packs that read `skill:` catalog contributions list these skills themselves.
  const runtimeReadsSkills = "readRuntimeExtensionSkills" in runtimeExtensions;
  const context = { sessionId: hostSessionId, workspacePath };

  // Both are filled once the runtime exists; sessions only read them when a turn starts.
  let prompts: HostPrompts | undefined;
  let serversFor: (session: SessionRecord) => Record<string, unknown> = () => ({});
  let automations: HostAutomations | undefined;
  let publisher: SessionPublisher | undefined;
  const runRecords = runRecordsPublisher;
  // A test's own query runs every turn; otherwise Claude is the default provider.
  const selection = options.provider ?? (options.query ? undefined : ({ id: "claude" } as const));
  const hostEnv = options.env ?? definedEnv(process.env);
  const provider = selection ? resolveProvider(selection, { env: withSecrets(hostEnv, options.secrets), privateRoot, log }) : undefined;
  if (provider) log(provider.description);
  const repoRules = options.repoRules !== false;
  const agents = new ClaudeAgentPort({
    query: options.query ?? provider?.query ?? (claudeQuery as unknown as QueryFn),
    runtimeId: provider?.id ?? "claude",
    projectSettings: repoRules,
    ...(options.nativeSubagentGuard === false ? {} : { nativeTools: { disabled: DISABLED_NATIVE_TOOLS, subagentAllowlist: NATIVE_SUBAGENT_ALLOWLIST } }),
    store: sessions,
    cwd: workspacePath,
    env: provider?.env ?? options.env ?? definedEnv(process.env),
    defaultModel: options.model ?? provider?.defaultModel ?? DEFAULT_MODEL,
    ...(options.reasoningEffort ? { defaultReasoningEffort: options.reasoningEffort } : {}),
    ...(options.permissions?.canUseTool ? { permissionHandler: options.permissions.canUseTool } : {}),
    ...(options.settings ? { settings: () => options.settings!.read() } : {}),
    workspaceName: path.basename(workspacePath),
    systemPrompt: (session) => prompts?.forSession(session),
    ...(options.launchOptionsFor ? { launchOptionsFor: options.launchOptionsFor } : {}),
    ...(options.live ? { live: options.live } : {}),
    ...(options.liveFor ? { liveFor: options.liveFor } : {}),
    ...(options.onLiveProcessClosed ? { onLiveProcessClosed: options.onLiveProcessClosed } : {}),
    prepareTurn: (session) => memory.warm(session, log),
    mcpServers: (session) => serversFor(session),
    log,
    onSessionEvent: (type, payload) => {
      telemetry(type, { sessionId: payload.sessionId, state: payload.state, ...(payload.parentId ? { parentId: payload.parentId } : {}) });
      automations?.emit(type, payload).catch((error: unknown) => log(`automations on ${type}: ${String(error)}`));
      if (typeof payload.sessionId === "string") publisher?.schedule(payload.sessionId);
      if (typeof payload.sessionId === "string") runRecords?.schedule(payload.sessionId);
      if (typeof payload.sessionId === "string" && (type === "session.idle" || type === "session.failed")) orgStore?.schedule(payload.sessionId);
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
  const forks = new SessionForks(agents, sessions, { log });
  const models = createModelServices(options.models, { env: withSecrets(options.env ?? process.env, options.secrets), ...(options.modelsFetch ? { fetch: options.modelsFetch } : {}) });
  const importPolicy = importPolicyOf(options.trustedTypeScript);
  const broker =
    composeBrokers([kit?.permissionBroker, options.permissions?.broker], options.ui?.applicationAuthority) ?? createAllowAllPermissionBroker();
  const hostScope = workspaceScope(workspacePath);
  const runtimeHostRoot =
    runtimeRoot ?? path.join(workspacePath, ".marshal", "runtime", createHash("sha256").update(HARNESS_ID).digest("hex").slice(0, 16));
  const workspaceName = path.basename(workspacePath);
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
      () => createSessionToolsProvider(agents, sessions, orgSearch ? { orgSearch } : {}),
      () => createMemoryToolsProvider(memory),
      () => createForkToolsProvider(forks),
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
  const rulesSection = repoRules ? repositoryRulesPrompt(workspacePath, options.provider?.id ?? "claude") : "";
  const directTools = options.directTools ?? [];
  const runtimeTools = options.runtimeTools !== false;
  const forksCall =
    !runtimeTools && directTools.some((direct) => direct.name === "runtimeInvoke")
      ? "mcp__marshal__runtimeInvoke {capability: '<name>', input}"
      : undefined;
  prompts = createHostPrompts(
    sdkBaseLayer({
      browser: browserServer !== undefined,
      extensionGuidance: guidance,
      sections: [...(kit?.promptSection ? [kit.promptSection] : []), forksPromptSection(forksCall)],
      ...(rulesSection ? { repoRules: rulesSection } : {}),
      runtimeTools,
      directTools,
      ...((provider?.id ?? "claude") === "claude" && !options.query ? { nativeTools: CLAUDE_NATIVE_PROMPT_TOOLS } : {}),
    }),
    options.prompt,
    log,
    (session) => {
      const visible = extensionSkillsPrompt(extensionSkills.filter((skill) => skillVisibleTo(skill, session)));
      return visible ? [visible] : [];
    },
    (session) => memory.promptContext(session),
  );

  serversFor = (session: SessionRecord): Record<string, unknown> => {
    const adapter = adapterFor(session.id);
    const call = async (name: string, args: unknown) => {
      const result = (await adapter.callTool(name, args, undefined as never)) as {
        content: unknown[];
        isError?: boolean;
      };
      return { content: result.content, ...(result.isError ? { isError: true } : {}) } as never;
    };
    const directContext = {
      sessionId: session.id,
      workspacePath,
      trustedTypeScript: importPolicy !== undefined,
      call: (name: string, args: unknown) => adapter.callTool(name, args, undefined as never) as never,
      invoke: async (capability: string, input: unknown = {}) => {
        const result = (await adapter.callTool("runtime_exec", { targetType: "operation", target: capability, input }, undefined as never)) as {
          structuredContent?: Record<string, any>;
        };
        const response = result.structuredContent ?? {};
        if (response.status !== "success") throw new Error(`${capability} failed: ${JSON.stringify(response.error ?? response).slice(0, 2000)}`);
        return response.result?.output;
      },
      readResource: (uri: string) => adapter.readResource(uri) as never,
    };
    const embedderTools = directTools.map((direct: DirectTool) =>
      tool(direct.name, direct.description, direct.inputSchema, async (args) => {
        try {
          return (await direct.handler(args as Record<string, unknown>, directContext)) as never;
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true } as never;
        }
      }),
    );
    const runtimeToolList = [
        tool(
          "runtime_search",
          RUNTIME_MCP_TOOLS[0]!.description ?? "",
          {
            query: z.string().optional(),
            name: z.string().optional(),
            catalogId: z.string().optional(),
            detail: z.enum(["summary", "full"]).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            tags: z.array(z.string()).optional(),
          },
          (args) => call("runtime_search", args),
        ),
        tool(
          "runtime_exec",
          RUNTIME_MCP_TOOLS[1]!.description ?? "",
          {
            targetType: z.enum(["operation", "inline_module", "module"]),
            target: z.string().optional(),
            source: z.string().optional(),
            module: z.record(z.string(), z.any()).optional(),
            input: z.any().optional(),
            timeoutMs: z.number().int().min(1).max(EXEC_TIMEOUT_MS).optional(),
          },
          (args) => call("runtime_exec", args),
        ),
        tool(
          "runtime_read_resource",
          "Read a Marshal runtime resource by URI: an installed extension's skill (skill://<extension>/<name>) and the references it names, or a resource a runtime_search entry points to (action resource_read).",
          { uri: z.string().min(1).max(2048) },
          async ({ uri }) => {
            try {
              const read = (await adapter.readResource(uri)) as { contents: { uri: string; text?: string }[] };
              return { content: read.contents.map((item) => ({ type: "text" as const, text: item.text ?? "" })) } as never;
            } catch (error) {
              return {
                content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
                isError: true,
              } as never;
            }
          },
        ),
      ];
    const marshal = createSdkMcpServer({
      name: "marshal",
      version: "0.1.0",
      tools: [...(runtimeTools ? runtimeToolList : []), ...embedderTools],
    });
    return {
      marshal,
      ...(browserServer ? { playwright: browserServer } : {}),
      // Providers other than the Claude Agent SDK take these tools directly; that SDK reads only string keys.
      [PROVIDER_TOOLS]: [
        ...(runtimeTools ? marshalProviderTools(call as never, (uri) => adapter.readResource(uri) as never, RUNTIME_MCP_TOOLS as never) : []),
        ...directProviderTools(directTools, directContext),
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
    const pageStudioDir = options.link.pageStudioDir ?? options.env?.PAGE_STUDIO_DIR ?? process.env.PAGE_STUDIO_DIR;
    try {
      link = await startLinkServer({
        token: options.link.token,
        ...(options.link.bind ? { bind: options.link.bind } : {}),
        port: options.link.port ?? 0,
        sessionsRoot: sessions.root,
        host: options.host ?? { id: HARNESS_ID, kind: "local" },
        files: linkFiles,
        ...(options.link.nativeRoots ? { nativeRoots: options.link.nativeRoots } : {}),
        ...(pageStudioDir ? { pageStudioDir } : {}),
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
    sessions,
    agents,
    forks,
    systemPrompt: (sessionId) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      return prompts?.forSession(session ?? undefined);
    },
    setSessionPrompt: (sessionId, layer) => prompts?.setSessionLayer(sessionId, layer),
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
      // Stopping the agents ends their running turns, which schedules one more publish each; it must reach the
      // Brain before the runtime takes its capabilities down (2026-11-16: capability_not_found on the last upload).
      await publisher?.close();
      await provider?.query?.dispose();
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

/** Embedder direct tools for providers that take tools directly (JSON Schema from the zod shape). */
function directProviderTools(directTools: readonly DirectTool[], context: Parameters<DirectTool["handler"]>[1]): unknown[] {
  return directTools.map((direct) => ({
    name: direct.name,
    description: direct.description,
    parameters: z.toJSONSchema(z.object(direct.inputSchema)),
    handler: async (args: unknown) => {
      const result = await direct.handler((args ?? {}) as Record<string, unknown>, context);
      const joined = result.content.map((item) => item.text).join("\n");
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
