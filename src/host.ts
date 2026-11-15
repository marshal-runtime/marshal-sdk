import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { createSdkMcpServer, query as claudeQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import { assembleAgentPrompt } from "@marshal/agent-runtime-prompt";
import { createAllowAllPermissionBroker } from "@marshal/runtime";
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
import { createAgentProvider } from "./agent-provider.js";
import desktopPlacements from "./desktop-placements.json" with { type: "json" };
import { FileSessionStore, type SessionRecord } from "./session-store.js";

const HARNESS_ID = "marshal-sdk";
const DEFAULT_MODEL = "claude-opus-5-5";
const SESSIONS_DIRECTORY = "sessions";
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
  browser?: boolean;
  query?: QueryFn;
  log?: (line: string) => void;
}

export interface MarshalHost {
  readonly runId: string;
  readonly sessions: FileSessionStore;
  readonly agents: ClaudeAgentPort;
  /** Call one runtime capability the way an agent would, and return its output. */
  invoke<T = unknown>(capability: string, input?: unknown, timeoutMs?: number): Promise<T>;
  search(query: string, limit?: number): Promise<unknown>;
  /** The system prompt a session of this host gets. */
  systemPrompt(): string | undefined;
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
  const extensions = options.extensions ?? [];
  const context = { sessionId: hostSessionId, workspacePath };

  // Both are filled once the runtime exists; sessions only read them when a turn starts.
  let prompt: string | undefined;
  let serversFor: (session: SessionRecord) => Record<string, unknown> = () => ({});
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
  });
  const runtime = await createAgentRuntime({
    workspacePath,
    protectedLifecycleResultRoot: privateRoot,
    stateDirectory: `.marshal/runtime/${createHash("sha256").update(HARNESS_ID).digest("hex").slice(0, 16)}`,
    identity: { harnessId: HARNESS_ID },
    principal: { id: `${HARNESS_ID}:${runId}`, kind: "agent" },
    // An unattended host has nobody to approve; what a run may do is decided by what is installed on it.
    permissionBroker: createAllowAllPermissionBroker(),
    codeIntelligence: false,
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
      createRuntimeBuiltinsSource({
        typescript: true,
        artifacts: true,
        effects: false,
        scheduling: false,
        reactUi: false,
        declarativeUi: false,
        extensionAuthoring: false,
        authoredUiPromotion: false,
      }),
    ],
  } as never);

  const guidance: string[] = [];
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
      if (record.agentGuidance) guidance.push(`${installed.identity}: ${JSON.stringify(record.agentGuidance)}`);
    }
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    throw error;
  }

  const adapterFor = (sessionId: string) =>
    createRuntimeToolAdapter({
      kernel: runtime.kernel,
      resources: runtime.resources,
      lifecycle: runtime.lifecycle,
      context: { sessionId, workspacePath },
    } as never);
  const hostAdapter = adapterFor(context.sessionId);
  const browserServer = options.browser === false ? undefined : playwrightServer();
  prompt = marshalPrompt(guidance, browserServer !== undefined, log);

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
      ],
    });
    return { marshal, ...(browserServer ? { playwright: browserServer } : {}) };
  };

  return {
    runId,
    sessions,
    agents,
    systemPrompt: () => prompt,
    async invoke<T>(capability: string, input: unknown = {}, timeoutMs = EXEC_TIMEOUT_MS): Promise<T> {
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
    },
    async search(query: string, limit = 10): Promise<unknown> {
      const result = (await hostAdapter.callTool("runtime_search", { query, limit }, undefined as never)) as {
        structuredContent?: unknown;
      };
      return result.structuredContent;
    },
    async dispose(): Promise<void> {
      await agents.dispose();
      await runtime.dispose();
    },
  };
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function playwrightServer(): Record<string, unknown> | undefined {
  try {
    const require = createRequire(import.meta.url);
    const cli = require.resolve("@playwright/mcp/cli.js");
    return { command: process.execPath, args: [cli, "--headless", "--isolated"] };
  } catch {
    return undefined;
  }
}

/** Marshal agent prompt v2 on its unattended cloud surface, with what this host really holds. */
function marshalPrompt(extensionGuidance: readonly string[], browser: boolean, log: (line: string) => void): string | undefined {
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
        ...(browser
          ? [{ name: "mcp__playwright__*", description: "A headless browser: open pages and local HTML files, resize, scroll, screenshot." }]
          : []),
      ],
      extraSections: extensionGuidance.length
        ? [{ id: "extensions", text: `## Installed extensions\n\n${extensionGuidance.join("\n")}` }]
        : [],
    }).content;
  } catch (error) {
    log(`Marshal prompt v2 could not be assembled (${error instanceof Error ? error.message : String(error)}); sessions use the backend's own prompt.`);
    return undefined;
  }
}
