import { createHash, randomUUID } from "node:crypto";
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
import desktopPlacements from "./desktop-placements.json" with { type: "json" };
import { extensionSkillSource, extensionSkillsPrompt, readExtensionSkills, type ExtensionSkill } from "./extension-skills.js";
import { normalizeKit, prepareKit, type KitSelection } from "./kit/index.js";
import { startLinkServer, type LinkServer } from "./link/server.js";
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

export interface MarshalHostOptions {
  /** Where sessions work: the checkout or scratch folder of this run. */
  workspacePath: string;
  /** Host-private folder outside the workspace: runtime state and the session store. */
  stateRoot: string;
  extensions?: readonly MarshalHostExtension[];
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
}

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
  /** Call one runtime capability the way an agent would, and return its output. */
  invoke<T = unknown>(capability: string, input?: unknown, timeoutMs?: number): Promise<T>;
  search(query: string, limit?: number): Promise<unknown>;
  /** Read a runtime resource (an extension skill `skill://<identity>/<name>`, its references, extension docs). */
  readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string }>;
  /** Skills the installed extensions declare (`skill:` catalog contributions). */
  readonly skills: readonly Omit<ExtensionSkill, "content" | "references">[];
  /** The system prompt a session of this host gets. */
  systemPrompt(): string | undefined;
  /** The link server, when the host was created with `link`. */
  readonly link?: { url: string; port: number };
  /** Automations: definitions, the scheduler behind runtime.schedules.*, and tick() for a fake clock. */
  readonly automations: HostAutomations;
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
          // The desktop's placements, declared inert: an extension that adds a tab activates here too.
          uiPlacements: desktopPlacements.placements as never,
          uiPlacementsRequired: false,
          restore: false,
        }
      : false,
    serviceContainer: createRuntimeServiceContainer(),
    providerSources: [
      () => createAgentProvider(agents, (id) => id !== undefined && sessions.get(id) !== undefined),
      () => createSessionToolsProvider(agents, sessions),
      () => createAutomationsProvider(hostAutomations),
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
  try {
    const lifecycle = runtime.serviceContainer.tryGet(RUNTIME_EXTENSION_LIFECYCLE_SERVICE);
    for (const extension of extensions) {
      if (!lifecycle) throw new Error("This runtime was composed without extension support.");
      const materializer = await createRuntimeHostMaterializer({ allowedRoots: [extension.packageRoot] });
      const request = await materializer.materialize({ packageRoot: extension.packageRoot });
      const installed = await lifecycle.install(request, { configuration: extension.configuration } as never);
      const record = lifecycle.get(installed.identity);
      if (record?.health !== "healthy" || record.status !== "enabled") {
        throw new Error(`Extension ${installed.identity} did not activate: ${JSON.stringify(record?.blockReasons)}`);
      }
      log(`extension ${installed.identity}@${record.version} active`);
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

  let link: LinkServer | undefined;
  let names: Promise<string[]> | undefined;
  if (options.link) {
    const pageStudioDir = options.link.pageStudioDir ?? options.env?.PAGE_STUDIO_DIR ?? process.env.PAGE_STUDIO_DIR;
    try {
      link = await startLinkServer({
        token: options.link.token,
        ...(options.link.bind ? { bind: options.link.bind } : {}),
        port: options.link.port ?? 0,
        sessionsRoot: sessions.root,
        host: options.host ?? { id: HARNESS_ID, kind: "local" },
        files: { workspace: workspacePath, ...options.link.files },
        ...(options.link.nativeRoots ? { nativeRoots: options.link.nativeRoots } : {}),
        ...(pageStudioDir ? { pageStudioDir } : {}),
        live: {
          send: (sessionId, text, deliveryMode) => agents.send(sessionId, text, deliveryMode),
          cancel: (sessionId) => agents.cancel(sessionId),
          invoke: (capability, input) => invoke(capability, input),
          extensions: () => [...installedExtensions],
          capabilities: () => (names ??= capabilityNames(runtime.kernel as never, runId, context)),
        },
        log,
      });
      log(`link serving on ${link.url}`);
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
    systemPrompt: () => prompt,
    invoke,
    search,
    readResource: async (uri) => {
      const read = (await hostAdapter.readResource(uri)) as { contents: { uri: string; mimeType?: string; text?: string }[] };
      return read.contents[0]!;
    },
    skills: extensionSkills.map(({ content: _content, references: _references, ...skill }) => skill),
    ...(link ? { link: { url: link.url, port: link.port } } : {}),
    automations: hostAutomations,
    emit: (event, payload = {}) => hostAutomations.emit(event, payload),
    async dispose(): Promise<void> {
      eventSubscription?.dispose();
      await hostAutomations.stop();
      await link?.close();
      await agents.dispose();
      await runtime.dispose();
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
