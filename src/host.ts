import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { createSdkMcpServer, query as claudeQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import { assembleAgentPrompt } from "@marshal/agent-runtime-prompt";
import { createAllowAllPermissionBroker } from "@marshal/runtime";
import * as runtimeExtensions from "@marshal/runtime/extensions";
import { RUNTIME_EVENT_BUS } from "@marshal/runtime/events";
import { RUNTIME_EXTENSION_LIFECYCLE_SERVICE } from "@marshal/runtime/extensions";
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeHostMaterializer,
  createRuntimeServiceContainer,
} from "@marshal/runtime/host";
import { createRuntimeToolAdapter, RUNTIME_MCP_TOOLS } from "@marshal/runtime/mcp";
import { z } from "zod";

import { ClaudeAgentPort, type QueryFn } from "./agent-port.js";
import { createAgentProvider, createSessionToolsProvider } from "./agent-provider.js";
import { createAutomationsProvider, HostAutomations } from "./automations.js";
import { createDecisionsProvider, DecisionDesk, type PersonRoute } from "./decisions.js";
import { createModelServices, createModelsProvider, type ModelServices, type ModelsConfig } from "./models/index.js";
import { extensionSkillSource, extensionSkillsPrompt, readExtensionSkills, type ExtensionSkill } from "./extension-skills.js";
import { createForkToolsProvider } from "./fork-provider.js";
import { SessionForks, forksPromptSection } from "./forks.js";
import { normalizeKit, prepareKit, type KitSelection } from "./kit/index.js";
import { ORG_EXTENSION, readPackageManifest } from "./onboarding.js";
import { createLinkCallProvider } from "./link/call-provider.js";
import { linkPersonRoute } from "./link/decisions.js";
import { startLinkServer, type LinkLivePort, type LinkServer } from "./link/server.js";
import { createOrgBridge, type OrgBridge, type OrgBridgeOptions } from "./org-bridge.js";
import { httpLinkRelay, type LinkRelay } from "./org-host-room.js";
import { ConversationRoomRoute } from "./rooms-route.js";
import { FileSessionStore, type SessionRecord } from "./session-store.js";

const HARNESS_ID = "marshal-sdk";
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

export interface MarshalHostOptions {
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
  query?: QueryFn;
  log?: (line: string) => void;
  /** Serve this host over the link (docs/link.md) so another Marshal can watch and drive it. */
  link?: MarshalHostLinkOptions;
  /** Schedule- and event-based runs (docs/kit.md, "Automations"). */
  automations?: MarshalHostAutomationOptions;
  /** Where decisions, questions and gaps go to people, and where their answers come from (docs/kit.md). */
  routes?: readonly PersonRoute[];
  /** Publish this host's sessions to a Marshal organization and run the instructions people post to them (docs/org-bridge.md). */
  org?: MarshalHostOrgOptions;
  /** Which provider answers each non-chat model service: decide, embed, speech (docs/models.md). */
  models?: ModelsConfig;
  /** Test hook: the HTTP client model services use. */
  modelsFetch?: typeof fetch;
}

/** The org bridge without what the host supplies; `host` defaults to the host's id. */
export type MarshalHostOrgOptions = Omit<OrgBridgeOptions, "store" | "agents" | "host"> & {
  host?: string;
  /** Sync and poll on a timer from the start. Default true; tests pass false and call host.org.sync()/poll(). */
  start?: boolean;
};

export interface MarshalHostAutomationOptions {
  /** The scheduler's clock. Tests pass a fake one with start: false and call host.automations.tick(). */
  now?: () => Date;
  /** How often the scheduler looks for due runs. Default 5 s. */
  tickMs?: number;
  /** Start the clock with the host. Default true; its first tick fires what fell due while no host ran. */
  start?: boolean;
  /** Default time zone of cron schedules. Defaults to the host's. */
  timezone?: string;
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
  readonly sessions: FileSessionStore;
  readonly agents: ClaudeAgentPort;
  /** Forks of this host's sessions: fork, list, message; each fork reports to its parent when it goes idle. */
  readonly forks: SessionForks;
  /** Call one runtime capability the way an agent would, and return its output. */
  invoke<T = unknown>(capability: string, input?: unknown, timeoutMs?: number): Promise<T>;
  search(query: string, limit?: number): Promise<unknown>;
  /** Read a runtime resource (an extension skill `skill://<identity>/<name>`, its references, extension docs). */
  readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string }>;
  /** Skills the installed extensions declare (`skill:` catalog contributions). */
  readonly skills: readonly Omit<ExtensionSkill, "content" | "references">[];
  /** Each installed extension as it came up: identity, version, its capabilities and declared skills. */
  readonly extensions: readonly MarshalHostExtensionState[];
  /** The system prompt a session of this host gets. */
  systemPrompt(): string | undefined;
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
  const workspacePath = fs.realpathSync(options.workspacePath);
  fs.mkdirSync(options.stateRoot, { recursive: true });
  const stateRoot = fs.realpathSync(options.stateRoot);
  if (stateRoot === workspacePath || stateRoot.startsWith(`${workspacePath}${path.sep}`)) {
    throw new Error("stateRoot must be outside the workspace: agents work in the workspace.");
  }
  const privateRoot = path.join(stateRoot, PRIVATE_DIRECTORY);
  fs.mkdirSync(privateRoot, { recursive: true });
  const runId = options.runId ?? randomUUID();
  const hostSessionId = `host-${runId}`;
  const sessions = new FileSessionStore(path.join(stateRoot, SESSIONS_DIRECTORY), {
    runId,
    host: options.host ?? { id: HARNESS_ID, kind: "local" },
  });
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
  let prompt: string | undefined;
  let serversFor: (session: SessionRecord) => Record<string, unknown> = () => ({});
  let automations: HostAutomations | undefined;
  const agents = new ClaudeAgentPort({
    query: options.query ?? (claudeQuery as unknown as QueryFn),
    store: sessions,
    cwd: workspacePath,
    env: options.env ?? definedEnv(process.env),
    defaultModel: options.model ?? DEFAULT_MODEL,
    ...(options.reasoningEffort ? { defaultReasoningEffort: options.reasoningEffort } : {}),
    workspaceName: path.basename(workspacePath),
    systemPrompt: () => prompt,
    mcpServers: (session) => serversFor(session),
    log,
    onSessionEvent: (type, payload) => {
      automations?.emit(type, payload).catch((error: unknown) => log(`automations on ${type}: ${String(error)}`));
    },
  });
  automations = new HostAutomations({
    root: path.join(stateRoot, AUTOMATIONS_DIRECTORY),
    port: agents,
    sessions,
    ...(options.automations?.now ? { now: options.automations.now } : {}),
    ...(options.automations?.tickMs ? { tickMs: options.automations.tickMs } : {}),
    ...(options.automations?.timezone ? { timezone: options.automations.timezone } : {}),
    log,
  });
  const hostAutomations = automations;
  const decisions = new DecisionDesk(sessions, agents, log);
  // marshal.link.call answers through a private loopback link that starts on first use (after the extensions activate).
  let linkRelay: LinkRelay | undefined;
  const forks = new SessionForks(agents, sessions, { log });
  const models = createModelServices(options.models, { env: options.env ?? process.env, ...(options.modelsFetch ? { fetch: options.modelsFetch } : {}) });
  const runtime = await createAgentRuntime({
    workspacePath,
    protectedLifecycleResultRoot: privateRoot,
    stateDirectory: `.marshal/runtime/${createHash("sha256").update(HARNESS_ID).digest("hex").slice(0, 16)}`,
    identity: { harnessId: HARNESS_ID },
    principal: {
      id: `${HARNESS_ID}:${runId}`,
      kind: "agent",
      ...(kit && Object.keys(kit.claims).length ? { claims: kit.claims } : {}),
    },
    // An unattended host has nobody to approve; what a run may do is decided by what is installed on it.
    permissionBroker: kit?.permissionBroker ?? createAllowAllPermissionBroker(),
    // The Brain extension requires the code-intelligence service.
    codeIntelligence: kit?.codeIntelligence ?? false,
    extensions: extensions.length
      ? {
          allowedRoots: extensions.map((extension) => extension.packageRoot),
          discoveryRoots: extensions.map((extension) => extension.packageRoot),
          // An extension's tabs and panels stay unplaced here; its capabilities still activate.
          uiPlacementsRequired: false,
          restore: false,
        }
      : false,
    serviceContainer: createRuntimeServiceContainer(),
    providerSources: [
      () => createAgentProvider(agents, (id) => id !== undefined && sessions.get(id) !== undefined),
      () => createSessionToolsProvider(agents, sessions),
      () => createForkToolsProvider(forks),
      () => createAutomationsProvider(hostAutomations),
      () => createDecisionsProvider(decisions),
      () => createModelsProvider(models),
      () => createLinkCallProvider(() => linkRelay),
      createRuntimeBuiltinsSource({
        typescript: true,
        artifacts: true,
        effects: false,
        // runtime.schedules.* on this host's durable scheduler (agent.wake and the automation task kinds).
        scheduling: true,
        scheduler: hostAutomations.scheduler,
        reactUi: false,
        declarativeUi: false,
        extensionAuthoring: false,
        authoredUiPromotion: false,
      }),
      ...(kit?.providerSources ?? []),
      ...(extensionSkills.length && !runtimeReadsSkills ? [extensionSkillSource(extensionSkills)] : []),
    ],
  } as never);
  // The core kernel takes the caller's own invocation context, so the Brain sees the same principal.
  kit?.bind((runtime as unknown as { core: never }).core);

  const guidance: string[] = [];
  const installedExtensions: { identity: string; version: string }[] = [];
  const extensionStates: MarshalHostExtensionState[] = [];
  try {
    const lifecycle = runtime.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    for (const [index, extension] of extensions.entries()) {
      if (!lifecycle) throw new Error("This runtime was composed without extension support.");
      const declared = packages[index]!;
      let installed: { identity: string };
      try {
        const materializer = await createRuntimeHostMaterializer({ allowedRoots: [extension.packageRoot] });
        const request = await materializer.materialize({ packageRoot: extension.packageRoot });
        // The org extension reaches this host only through capabilities; what it cannot ask for (who the host is, where
        // to keep its ledgers) the host gives it here, under any configuration the manifest set.
        const configuration =
          declared.identity === ORG_EXTENSION
            ? { hostId: (options.host ?? { id: HARNESS_ID }).id, hostKind: (options.host ?? { kind: "local" }).kind, stateDir: path.join(stateRoot, "org"), ...(extension.configuration as object | undefined) }
            : extension.configuration;
        installed = await lifecycle.install(request, { configuration } as never);
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
      log(`extension ${installed.identity}@${record.version}${fromDefaults ? " (default)" : ""} ${record.status}, ${record.health}: ${declared.capabilities.length} capabilities, ${declared.skills.length} skills`);
      installedExtensions.push({ identity: installed.identity, version: String(record.version) });
      if (record.agentGuidance) guidance.push(`${installed.identity}: ${JSON.stringify(record.agentGuidance)}`);
    }
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }
  // Events the runtime publishes (lifecycle, extensions) trigger event automations too.
  const eventBus = runtime.serviceContainer.tryGet(RUNTIME_EVENT_BUS as never) as
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
      resources: runtime.resources,
      lifecycle: runtime.lifecycle,
      context: { sessionId, workspacePath },
    } as never);
  const hostAdapter = adapterFor(context.sessionId);
  const browserServer =
    options.browser === false
      ? undefined
      : playwrightServer(typeof options.browser === "object" ? options.browser : {}, log);
  const skillsSection = extensionSkillsPrompt(extensionSkills);
  prompt = marshalPrompt(guidance, browserServer !== undefined, log, [
    ...(kit?.promptSection ? [kit.promptSection] : []),
    forksPromptSection(),
    ...(skillsSection ? [skillsSection] : []),
  ]);

  serversFor = (session: SessionRecord): Record<string, unknown> => {
    const adapter = adapterFor(session.id);
    const call = async (name: string, args: unknown) => {
      const result = (await adapter.callTool(name, args, undefined as never)) as {
        content: unknown[];
        isError?: boolean;
      };
      return { content: result.content, ...(result.isError ? { isError: true } : {}) } as never;
    };
    const marshal = createSdkMcpServer({
      name: "marshal",
      version: "0.1.0",
      tools: [
        tool(
          "runtime_search",
          RUNTIME_MCP_TOOLS[0]!.description,
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
          RUNTIME_MCP_TOOLS[1]!.description,
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
      ],
    });
    return { marshal, ...(browserServer ? { playwright: browserServer } : {}) };
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
  const search = async (query: string, limit = 10): Promise<unknown> => {
    const result = (await hostAdapter.callTool("runtime_search", { query, limit }, undefined as never)) as {
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
    capabilities: () => (names ??= capabilityNames(runtime.kernel as never, runId, context)),
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

  return {
    runId,
    sessions,
    agents,
    forks,
    systemPrompt: () => prompt,
    invoke,
    search,
    readResource: async (uri) => {
      const read = (await hostAdapter.readResource(uri)) as { contents: { uri: string; mimeType?: string; text?: string }[] };
      return read.contents[0]!;
    },
    extensions: extensionStates,
    skills: extensionSkills.map(({ content: _content, references: _references, ...skill }) => skill),
    ...(link ? { link: { url: link.url, port: link.port } } : {}),
    ...(org ? { org } : {}),
    automations: hostAutomations,
    models,
    decisions,
    emit: (event, payload = {}) => hostAutomations.emit(event, payload),
    async dispose(): Promise<void> {
      eventSubscription?.dispose();
      await hostAutomations.stop();
      await decisions.stop();
      await link?.close();
      await org?.close();
      forks.dispose();
      await models.dispose().catch(() => undefined);
      await agents.dispose();
      await runtime.dispose();
      // After the runtime: the org extension publishes its last turns through it while it closes.
      if (innerLink) await (await innerLink).server.close();
    },
  };
}

/** Every capability the runtime lists: the kernel's search without a query returns the whole catalog. */
async function capabilityNames(
  kernel: { search(request: unknown, context: unknown): Promise<{ matches?: { capability?: { name?: string } }[] }> },
  runId: string,
  scope: { sessionId: string; workspacePath: string },
): Promise<string[]> {
  const found = await kernel.search({ limit: 500 }, { principal: { id: `${HARNESS_ID}:${runId}`, kind: "agent" }, scope }).catch(() => undefined);
  return [...new Set((found?.matches ?? []).map((match) => match.capability?.name).filter((name): name is string => !!name))].sort();
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function playwrightServer(browser: MarshalHostBrowser, log: (line: string) => void): Record<string, unknown> | undefined {
  try {
    // @playwright/mcp's exports map hides cli.js, so resolving "@playwright/mcp/cli.js" always throws.
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("@playwright/mcp/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { bin?: Record<string, string> };
    const cli = path.join(path.dirname(manifestPath), manifest.bin?.["playwright-mcp"] ?? "cli.js");
    const executablePath = browser.executablePath ?? (process.env.MARSHAL_SDK_CHROME || undefined);
    const noSandbox = browser.noSandbox ?? process.env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1";
    return {
      command: process.execPath,
      args: [cli, "--headless", "--isolated", ...(executablePath ? ["--executable-path", executablePath] : []), ...(noSandbox ? ["--no-sandbox"] : [])],
    };
  } catch (error) {
    log(`no browser for sessions: @playwright/mcp not usable (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

/** Marshal agent prompt v2 on its unattended cloud surface, with what this host really holds. */
function marshalPrompt(
  extensionGuidance: readonly string[],
  browser: boolean,
  log: (line: string) => void,
  sections: readonly { id: string; text: string }[] = [],
): string | undefined {
  try {
    return assembleAgentPrompt({
      core: { behavior: "v2", claudeTooling: "lean" },
      surface: "cloud-headless",
      role: "worker",
      tools: [
        { name: "mcp__marshal__runtime_search", description: "Find Marshal runtime capabilities and read their schemas." },
        {
          name: "mcp__marshal__runtime_exec",
          description:
            "Run a capability ({targetType: 'operation', target, input}) or TypeScript that calls context.runtime.invoke ({targetType: 'inline_module', source, input}).",
        },
        {
          name: "mcp__marshal__runtime_read_resource",
          description: "Read a runtime resource by URI: an extension's skill (skill://...) and its references.",
        },
        ...(browser
          ? [{ name: "mcp__playwright__*", description: "A headless browser: open pages and local HTML files, resize, scroll, screenshot." }]
          : []),
      ],
      extraSections: [
        ...sections,
        ...(extensionGuidance.length
          ? [{ id: "extensions", text: `## Installed extensions\n\n${extensionGuidance.join("\n")}` }]
          : []),
      ],
    }).content;
  } catch (error) {
    log(`Marshal prompt v2 could not be assembled (${error instanceof Error ? error.message : String(error)}); sessions use the backend's own prompt.`);
    return undefined;
  }
}
