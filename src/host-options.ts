import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityProvider,
  type InvocationContext,
  type PermissionBroker,
} from "@marshal/runtime";
import type {
  AgentRuntimeHostOptions,
  RuntimeBuiltinsSourceOptions,
  RuntimeHostImportPolicy,
  RuntimeHostProviderSource,
  RuntimeHostWorkspaceResolver,
  RuntimeServiceContainer,
} from "@marshal/runtime/host";
import type { z } from "zod";

import { callerSessionId } from "./agent-provider.js";
import type { RuntimePermissionHandler } from "./providers.js";
import { compactTypeScriptExecutionResult, prepareAgentTypeScriptSource } from "./typescript-source.js";

type PermissionCheck = Parameters<PermissionBroker["decide"]>[0];
type PermissionDecision = Awaited<ReturnType<PermissionBroker["decide"]>>;

/**
 * Who decides what runs, the desktop's way (electron/marshal-runtime/host.ts): the runtime's broker for capability
 * calls, its approval port for calls that wait on a person, and a handler for the model backend's own tool requests.
 * Without any of these the host stays an unattended one: every capability call and tool call is allowed.
 */
export interface MarshalHostPermissions {
  /** Decides each capability call. Composed after the kit's guard (Brain writes stay denied unless the kit allows them). */
  broker?: PermissionBroker;
  /** Approvals for `approval` decisions that can be verified later (the runtime's permissionApproval). */
  approval?: AgentRuntimeHostOptions["permissionApproval"];
  /** Dynamic grants from a host-owned persisted policy (the runtime's resolvePermissionGrants). */
  resolveGrants?: AgentRuntimeHostOptions["resolvePermissionGrants"];
  /** Extra permissions granted to the host's principal. */
  patterns?: readonly string[];
  /**
   * The model backend's own tool requests (shell, file writes, MCP tools) in the desktop's request shape. Given,
   * sessions stop running with bypassPermissions on every engine.
   */
  canUseTool?: RuntimePermissionHandler;
}

/** The desktop's application authority: decides first for calls an application owns. */
export interface MarshalHostApplicationAuthority {
  decide(check: PermissionCheck): Promise<PermissionDecision | undefined> | PermissionDecision | undefined;
}

/** What the host passes to the runtime for apps and views (createRuntimeBuiltinsSource and the extension options). */
export interface MarshalHostUiOptions {
  reactUi?: RuntimeBuiltinsSourceOptions["reactUi"];
  declarativeUi?: RuntimeBuiltinsSourceOptions["declarativeUi"];
  /** An extension whose tabs and panels have no placement fails to activate. Default false. */
  placementsRequired?: boolean;
  applicationAuthority?: MarshalHostApplicationAuthority;
}

export interface MarshalHostTelemetryEvent {
  name: string;
  /** Metadata only: ids, counts, states. Never session content. */
  details: Record<string, unknown>;
}

export interface MarshalHostNotification {
  title: string;
  body: string;
  sessionId?: string;
}

export interface MarshalHostSettings {
  model?: string;
  reasoningEffort?: string;
}

/** A settings store the host reads live: new sessions take its current model and effort. */
export interface MarshalHostSettingsPort {
  read(): MarshalHostSettings;
  /** Called with each change; returns the unsubscribe. The host tells telemetry and its log. */
  subscribe?(listener: (settings: MarshalHostSettings) => void): () => void;
}

/** What a direct tool's handler may use: the runtime's own tools, scoped to the calling session. */
export interface DirectToolContext {
  sessionId: string;
  /** The workspace the session works in. */
  workspacePath: string;
  /** TypeScript blocks run in full Node (the host's trustedTypeScript), not brokered. */
  trustedTypeScript: boolean;
  /** Call a runtime MCP tool (runtime_search, runtime_exec, runtime_read_resource) with the session's scope. */
  call(name: string, args: unknown): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }>;
  invoke(capability: string, input?: unknown): Promise<unknown>;
  readResource(uri: string): Promise<{ contents: { uri: string; text?: string }[] }>;
}

/** A tool the model sees directly, registered by the embedder (the desktop's `runtimeExecuteTypeScript` and the rest). */
export interface DirectTool {
  name: string;
  description: string;
  /** A zod raw shape, as the Claude Agent SDK's `tool()` takes. */
  inputSchema: z.ZodRawShape;
  handler(args: Record<string, unknown>, context: DirectToolContext): Promise<DirectToolResult> | DirectToolResult;
}

export interface DirectToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Everything a host embedder can pass in, beside the SDK's own options (MarshalHostOptions extends this). */
export interface MarshalHostPorts {
  /**
   * An absolute host-private folder the runtime keeps its state in (extensions, jobs, receipts), outside every
   * workspace, as the desktop's `~/.marshal/marshal-runtime`. Default: `<workspace>/.marshal/runtime/<hash>`.
   */
  runtimeRoot?: string;
  /** Which workspace a call works in, for hosts serving more than one (default: the host's workspace). */
  resolveWorkspace?: RuntimeHostWorkspaceResolver;
  /** Absolute folder outside the workspace for isolated worktrees. */
  worktreeRoot?: string;
  permissions?: MarshalHostPermissions;
  /** Capability providers of the embedder, registered before the SDK's own (the desktop's additionalProviderSources). */
  providerSources?: readonly RuntimeHostProviderSource[];
  /** The embedder's service container (rooms, Brain, memory services bound by the host). Default: a new one. */
  serviceContainer?: RuntimeServiceContainer;
  compositionRegistry?: AgentRuntimeHostOptions["compositionRegistry"];
  /** Node binary for TypeScript modules and the browser MCP server (a packaged app's bundled node). */
  nodeExecutable?: string;
  /** Full-Node TypeScript: true takes the desktop's trusted policy (every package and builtin), or pass a policy. */
  trustedTypeScript?: boolean | RuntimeHostImportPolicy;
  /** Runtime built-ins over the SDK's defaults: limits, effects, extension authoring. */
  builtins?: Omit<RuntimeBuiltinsSourceOptions, "scheduler" | "reactUi" | "declarativeUi" | "nodeExecutable" | "importPolicy">;
  ui?: MarshalHostUiOptions;
  /** Host events for a telemetry pipeline: start, extensions, runtime lifecycle, session outcomes, settings. */
  telemetry?: (event: MarshalHostTelemetryEvent) => void;
  /** Where `marshal.tool.sendNotification` goes. Without it the capability is not offered. */
  notifications?: (notification: MarshalHostNotification) => Promise<void> | void;
  settings?: MarshalHostSettingsPort;
  /** Secrets by name (API keys, tokens), from the host's own store; asked before the environment's `NAME` and `NAME_FILE`. */
  secrets?: (name: string) => string | undefined;
  /** Tools the model sees directly, beside or instead of the runtime's. */
  directTools?: readonly DirectTool[];
  /** Offer the runtime's own direct tools (runtime_search, runtime_exec, runtime_read_resource). Default true. */
  runtimeTools?: boolean;
}

/** The desktop's trusted TypeScript import policy (electron/marshal-runtime/trusted-typescript.ts). */
export const TRUSTED_TYPESCRIPT_IMPORT_POLICY: RuntimeHostImportPolicy = Object.freeze({
  allowedPackages: Object.freeze(["*"]),
  allowedBuiltins: Object.freeze(["*"]),
});

export function importPolicyOf(trusted: MarshalHostPorts["trustedTypeScript"]): RuntimeHostImportPolicy | undefined {
  if (!trusted) return undefined;
  return trusted === true ? TRUSTED_TYPESCRIPT_IMPORT_POLICY : trusted;
}

/** The first broker that does not allow decides; all allow, the call is allowed. The authority decides before them. */
export function composeBrokers(
  brokers: readonly (PermissionBroker | undefined)[],
  authority?: MarshalHostApplicationAuthority,
): PermissionBroker | undefined {
  const chain = brokers.filter((broker): broker is PermissionBroker => broker !== undefined);
  if (!chain.length && !authority) return undefined;
  return {
    decide: async (check) => {
      const owned = await authority?.decide(check);
      if (owned) return owned;
      let last: PermissionDecision = { decision: "allow" };
      for (const broker of chain) {
        last = await broker.decide(check);
        if (last.decision !== "allow") return last;
      }
      return last;
    },
  };
}

/**
 * The environment with the host's secret store in front: `env[name]` asks the store first. Only the real entries
 * are enumerable, so a child process given this environment never receives the store's secrets.
 */
export function withSecrets<T extends Record<string, string | undefined>>(env: T, secrets: ((name: string) => string | undefined) | undefined): T {
  if (!secrets) return env;
  return new Proxy(env, {
    get(target, key, receiver) {
      if (typeof key === "string") {
        const value = secrets(key);
        if (value) return value;
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The runtime's scope for a workspace, ids derived the way the runtime derives them for its own workspace. */
export function workspaceScope(workspacePath: string): { workspacePath: string; workspaceId: string; projectId: string } {
  const normalized = process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath;
  const id = (kind: string) => `${kind}-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
  return { workspacePath, workspaceId: id("workspace"), projectId: id("project") };
}

export function assertHostPrivate(name: string, folder: string, workspacePath: string): void {
  if (!path.isAbsolute(folder)) throw new Error(`${name} must be an absolute path.`);
  const resolved = realpathOfExisting(path.resolve(folder));
  if (resolved === workspacePath || resolved.startsWith(`${workspacePath}${path.sep}`)) {
    throw new Error(`${name} must be outside the workspace: agents work in the workspace.`);
  }
}

/** The real path of a folder that may not exist yet: its nearest existing ancestor resolved (macOS /var is /private/var). */
function realpathOfExisting(folder: string): string {
  const missing: string[] = [];
  let current = folder;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return folder;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

/** `marshal.tool.sendNotification` on the host's sink, with the desktop's input shape. */
export function createNotificationsProvider(sink: NonNullable<MarshalHostPorts["notifications"]>): CapabilityProvider {
  const descriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.tool.sendNotification",
    version: "1.0.0",
    title: "Send a notification",
    description: "Notify the person who runs this host: a title and a short body, delivered verbatim. Never put private details in it unless they asked.",
    tags: ["marshal", "notification"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body"],
      properties: { title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string", minLength: 1, maxLength: 2000 } },
    },
    outputSchema: { type: "object", additionalProperties: false, required: ["success"], properties: { success: { type: "boolean" }, error: { type: "string" } } },
    permissions: [{ permission: "marshal.tool.sendNotification", risk: "low" as const }],
  };
  return {
    id: "marshal.notifications",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name: string) => (name === descriptor.name ? descriptor : undefined),
    invoke: async (_name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as { title?: unknown; body?: unknown };
      const caller = callerSessionId(context);
      try {
        await sink({ title: String(input.title ?? ""), body: String(input.body ?? ""), ...(caller ? { sessionId: caller } : {}) });
        return { output: { success: true } };
      } catch (error) {
        return { output: { success: false, error: error instanceof Error ? error.message : String(error) } };
      }
    },
  } as unknown as CapabilityProvider;
}

function text(value: unknown): DirectToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function relay(result: { content: unknown[]; isError?: boolean }): DirectToolResult {
  return { content: result.content as DirectToolResult["content"], ...(result.isError ? { isError: true } : {}) };
}

/**
 * The desktop's direct tool names over this host's runtime, so prompts, skills and memories that cite
 * `runtimeSearch`, `runtimeInvoke`, `runtimeExecuteTypeScript`, `runtimeReadResource` and `forkSubagents` work here.
 * Pass with `runtimeTools: false` to show only these names.
 */
export function desktopDirectTools(zod: typeof z): DirectTool[] {
  return [
    {
      name: "runtimeSearch",
      description: "Search the Marshal Runtime catalog for capabilities, skills and resources; pass name for one capability's full schema.",
      inputSchema: {
        query: zod.string().max(4000).optional(),
        name: zod.string().max(512).optional(),
        catalogId: zod.string().max(512).optional(),
        detail: zod.enum(["summary", "full"]).optional(),
        limit: zod.number().int().min(1).max(50).optional(),
        tags: zod.array(zod.string()).max(20).optional(),
      },
      handler: async (args, context) => relay(await context.call("runtime_search", args)),
    },
    {
      name: "runtimeInvoke",
      description: "Invoke one capability returned by runtimeSearch under this session's scope and permission policy.",
      inputSchema: { capability: zod.string().min(1).max(512), input: zod.any().optional(), idempotencyKey: zod.string().max(256).optional() },
      handler: async (args, context) =>
        relay(await context.call("runtime_exec", { targetType: "operation", target: args.capability, input: args.input ?? {} })),
    },
    {
      name: "runtimeExecuteTypeScript",
      description:
        "Run TypeScript: top-level statements ending in `return`, with `context.runtime.invoke(name, input)` and `context.runtime.search(query)` in scope.",
      inputSchema: {
        source: zod.string().min(1).max(2_097_152),
        input: zod.any().optional(),
        timeoutMs: zod.number().int().min(1).max(300_000).optional(),
        verbose: zod.boolean().optional(),
      },
      handler: async (args, context) => {
        const result = await context.call("runtime_exec", {
          targetType: "inline_module",
          // The desktop's authoring conveniences: a plain body with top-level await and `return` becomes a module.
          source: prepareAgentTypeScriptSource(String(args.source ?? ""), { trusted: context.trustedTypeScript, workspacePath: context.workspacePath }),
          ...(context.trustedTypeScript ? { executionMode: "trusted_node" } : {}),
          ...(args.input !== undefined ? { input: args.input } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
        const envelope = result.structuredContent as { status?: string; result?: { output?: unknown }; error?: unknown } | undefined;
        if (!envelope || args.verbose === true) return relay(result);
        if (envelope.status !== "success") return { ...text({ ok: false, status: envelope.status, error: envelope.error }), isError: true };
        return text(compactTypeScriptExecutionResult(envelope.result?.output));
      },
    },
    {
      name: "runtimeReadResource",
      description: "Read a Marshal runtime resource by URI: an extension's skill (skill://...), its references, extension docs.",
      inputSchema: { uri: zod.string().min(1).max(2048) },
      handler: async (args, context) => {
        const read = await context.readResource(String(args.uri));
        return text(read.contents.map((item) => item.text ?? "").join("\n"));
      },
    },
    {
      name: "forkSubagents",
      description:
        "Fork yourself into subagents that each take one part of the work; each continues this conversation with its task as its first message and reports back when it goes idle.",
      inputSchema: {
        tasks: zod
          .array(zod.object({ task: zod.string().min(1), name: zod.string().optional(), model: zod.string().optional(), reasoningEffort: zod.string().optional() }).passthrough())
          .min(1)
          .max(8),
      },
      handler: async (args, context) => text(await context.invoke("marshal.tool.forkSubagents", args)),
    },
  ];
}
