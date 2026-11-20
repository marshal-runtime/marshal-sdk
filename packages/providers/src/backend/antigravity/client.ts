import { randomUUID } from "node:crypto";
import path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginResult,
  RuntimeClient,
  RuntimeMcpServerConfig,
  RuntimeModelInfo,
  RuntimeProcessHandle,
  RuntimeSessionConfig,
} from "../runtime-contract";
import { ANTIGRAVITY_BRIDGE_PROTOCOL, AntigravityBridge } from "./bridge-process";
import { ANTIGRAVITY_BRIDGE_SOURCE } from "./bridge-source";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  ANTIGRAVITY_FINISH_TOOL,
  ANTIGRAVITY_MARSHAL_OWNED_TOOLS,
  ANTIGRAVITY_SDK_VERSION,
  type AntigravityProcessEnv,
} from "./constants";
import {
  ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS,
  assertProxyEndpoint,
  bridgeEndpoint,
  clearAntigravityCredentials,
  describeAntigravityEndpoint,
  resolveAntigravityEndpoint,
  saveAntigravityCredential,
  type AntigravityEndpoint,
} from "./credentials";
import { ensureAntigravityEnvironment, type AntigravityPythonEnvironment } from "./environment";
import { antigravityModels } from "./models";
import type { AntigravityRemoteBridge } from "./remote";
import { AntigravityRuntimeSession } from "./session";

const log = createLogger("antigravity:client");

export interface AntigravityRuntimeClientOptions {
  workspaceDir: string;
  /** Holds the venv, the bridge, stored credentials and saved conversations. */
  homeDir: string;
  env?: AntigravityProcessEnv;
  /** Tests inject a prepared environment instead of provisioning Python. */
  environment?: () => Promise<AntigravityPythonEnvironment>;
}

function mcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_") || "mcp";
}

function toBridgeMcpServers(
  servers: Record<string, RuntimeMcpServerConfig> | undefined,
  allowed: readonly string[] | undefined,
): Record<string, unknown>[] {
  if (!servers) return [];
  return Object.entries(servers)
    .filter(([name]) => !allowed || allowed.includes(name))
    .map(([name, server]) => {
      const common = {
        name: mcpServerName(name),
        ...(server.tools?.length && !server.tools.includes("*") ? { tools: server.tools } : {}),
      };
      if ("url" in server) {
        return {
          ...common,
          url: server.url,
          ...(server.headers ? { headers: server.headers } : {}),
        };
      }
      return {
        ...common,
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      };
    });
}

/**
 * Marshal's runtime client for Google Antigravity: the official Python SDK
 * (google-antigravity) driven through a bridge process, on Vertex AI or the
 * Gemini API.
 */
export class AntigravityRuntimeClient implements RuntimeClient {
  private readonly sessions = new Map<string, AntigravityRuntimeSession>();
  private bridge: AntigravityBridge | undefined;
  private bridgeStarting: Promise<AntigravityBridge> | undefined;
  private endpoint: AntigravityEndpoint | undefined;
  /** Bridges on other machines (RuntimeSessionConfig.antigravityRemote), one per session, stopped when it closes. */
  private readonly remoteBridges = new Map<string, AntigravityBridge>();

  constructor(private readonly options: AntigravityRuntimeClientOptions) {}

  get process(): RuntimeProcessHandle | undefined {
    return this.bridge?.process;
  }

  isClosed(): boolean {
    return this.bridge?.isClosed() ?? false;
  }

  async stop(): Promise<Error[]> {
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(sessions.map((session) => session.disconnect()));
    this.sessions.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
        : [],
    );
    // Every remote bridge stops at once, each within its own bound (AntigravityBridge.stop).
    const remote = [...this.remoteBridges.values()];
    this.remoteBridges.clear();
    for (const result of await Promise.allSettled(remote.map((bridge) => bridge.stop()))) {
      if (result.status === "rejected") {
        errors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
    }
    const bridge = this.bridge;
    this.bridge = undefined;
    this.bridgeStarting = undefined;
    if (bridge) {
      try {
        await bridge.stop();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return errors;
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    await session?.disconnect();
    this.sessions.delete(id);
  }

  async getAuthStatus(): Promise<{
    isAuthenticated: boolean;
    login?: string;
    statusMessage?: string;
  }> {
    const endpoint = await resolveAntigravityEndpoint(this.options.homeDir, this.env);
    if (!endpoint) {
      return { isAuthenticated: false, statusMessage: ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS };
    }
    return {
      isAuthenticated: true,
      login: describeAntigravityEndpoint(endpoint),
      statusMessage: `Antigravity runs on ${describeAntigravityEndpoint(endpoint)}`,
    };
  }

  async getUsage(): Promise<null> {
    // Vertex and the Gemini API expose no plan usage to an API caller.
    return null;
  }

  async login(request: RuntimeAuthLoginRequest): Promise<RuntimeAuthLoginResult> {
    if (request.type !== "api-key") {
      throw new Error(
        `Antigravity does not support ${request.type} sign-in. ${ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS}`,
      );
    }
    if (this.sessions.size > 0) {
      throw new Error("Cannot change Antigravity credentials while sessions are active");
    }
    await saveAntigravityCredential(this.options.homeDir, request.apiKey);
    await this.restartBridge();
    return { status: "authenticated" };
  }

  async logout(): Promise<void> {
    const errors = await this.stop();
    await clearAntigravityCredentials(this.options.homeDir);
    this.endpoint = undefined;
    if (errors.length > 0) {
      throw new AggregateError(errors, "Antigravity logout could not stop every active session");
    }
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    return antigravityModels();
  }

  async createSession(config: RuntimeSessionConfig): Promise<AntigravityRuntimeSession> {
    return this.startSession(randomUUID(), config, false);
  }

  async resumeSession(
    id: string,
    config: RuntimeSessionConfig,
  ): Promise<AntigravityRuntimeSession> {
    const active = this.sessions.get(id);
    if (active) await active.disconnect();
    return this.startSession(id, config, true);
  }

  async readConversationState(
    id: string,
    _workingDirectory: string,
    options?: { allowCompaction?: boolean },
  ) {
    const active = this.sessions.get(id);
    if (active) return active.exportConversationState(options);
    throw new Error(
      "Antigravity keeps a closed chat's context inside its own session store; open the chat to export it.",
    );
  }

  private get env(): AntigravityProcessEnv {
    return this.options.env ?? process.env;
  }

  private async restartBridge(): Promise<void> {
    const bridge = this.bridge;
    this.bridge = undefined;
    this.bridgeStarting = undefined;
    this.endpoint = undefined;
    await bridge?.stop();
  }

  private async ensureBridge(): Promise<AntigravityBridge> {
    if (this.bridge && !this.bridge.isClosed()) return this.bridge;
    if (this.bridgeStarting) return this.bridgeStarting;
    this.bridgeStarting = (async () => {
      const endpoint = await resolveAntigravityEndpoint(this.options.homeDir, this.env);
      if (!endpoint) throw new Error(ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS);
      const environment = await (this.options.environment?.() ??
        ensureAntigravityEnvironment({
          homeDir: this.options.homeDir,
          env: this.env,
          onProgress: (message) => log.info(message),
        }));
      const bridge = new AntigravityBridge({
        python: environment.python,
        bridgePath: environment.bridgePath,
        cwd: this.options.workspaceDir,
        env: { ...process.env, ...this.env, ...bridgeEndpoint(endpoint).env } as NodeJS.ProcessEnv,
      });
      this.endpoint = endpoint;
      this.bridge = bridge;
      return bridge;
    })();
    try {
      return await this.bridgeStarting;
    } finally {
      this.bridgeStarting = undefined;
    }
  }

  private baseConfig(
    config: RuntimeSessionConfig,
    endpoint: AntigravityEndpoint,
    remote?: AntigravityRemoteBridge,
  ): Record<string, unknown> {
    if (remote) return this.remoteConfig(config, endpoint, remote);
    const cwd = config.cwd ?? config.workingDirectory ?? this.options.workspaceDir;
    const restricted = config.availableTools !== undefined;
    const allowed = new Set(config.availableTools ?? []);
    // Antigravity has no deferred-tool loading, so tools Marshal defers elsewhere are registered up front.
    const exposed = config.exposedHostTools
      ? new Set([...config.exposedHostTools, ...(config.deferredHostTools ?? [])])
      : undefined;
    const hostTools = (config.tools ?? [])
      .filter(
        (tool) => (!restricted || allowed.has(tool.name)) && (!exposed || exposed.has(tool.name)),
      )
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      }));
    const onMarshalSurface = (config.disabledBuiltInTools?.length ?? 0) > 0;
    return {
      workspaces: [cwd],
      saveDir: path.join(this.options.homeDir, "sessions"),
      appDataDir: path.join(this.options.homeDir, "harness"),
      endpoint: bridgeEndpoint(endpoint).config,
      ...(config.systemMessage?.content
        ? {
            system: {
              mode: config.systemMessage.mode ?? "append",
              text: config.systemMessage.content,
            },
          }
        : {}),
      hostTools,
      mcpServers: toBridgeMcpServers(
        config.mcpServers,
        restricted ? (config.availableMcpServers ?? []) : undefined,
      ),
      ...(restricted
        ? {
            enabledBuiltinTools: [
              ...[...allowed].filter((name) => !config.tools?.some((tool) => tool.name === name)),
              // Antigravity returns a structured answer only through its built-in `finish` tool, which ends the
              // turn and runs nothing; an allowlist without it would drop the answer.
              ...(config.responseSchema && !allowed.has(ANTIGRAVITY_FINISH_TOOL)
                ? [ANTIGRAVITY_FINISH_TOOL]
                : []),
            ],
          }
        : {}),
      ...(config.responseSchema ? { responseSchema: config.responseSchema } : {}),
      ...(onMarshalSurface
        ? {
            disabledBuiltinTools: [
              ...ANTIGRAVITY_MARSHAL_OWNED_TOOLS,
              ...(config.disabledBuiltInTools ?? []),
            ],
          }
        : {}),
    };
  }

  /**
   * The open config of a session whose bridge runs on another machine: its paths are that machine's, its built-in
   * tools run there (minus those Marshal owns, or exactly the caller's allowlist), and the host's MCP servers, which are
   * commands and URLs of this host, are not passed.
   */
  private remoteConfig(
    config: RuntimeSessionConfig,
    endpoint: AntigravityEndpoint,
    remote: AntigravityRemoteBridge,
  ): Record<string, unknown> {
    const restricted = config.availableTools !== undefined;
    const allowed = new Set(config.availableTools ?? []);
    const exposed = config.exposedHostTools
      ? new Set([...config.exposedHostTools, ...(config.deferredHostTools ?? [])])
      : undefined;
    const hostTools = (config.tools ?? [])
      .filter(
        (tool) => (!restricted || allowed.has(tool.name)) && (!exposed || exposed.has(tool.name)),
      )
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters ? { parameters: tool.parameters } : {}),
      }));
    const finish = (names: readonly string[]) =>
      config.responseSchema && !names.includes(ANTIGRAVITY_FINISH_TOOL)
        ? [...names, ANTIGRAVITY_FINISH_TOOL]
        : [...names];
    // An exact allowlist: the session's own (restricted) or the caller's; otherwise the built-ins minus the disabled.
    const enabled = restricted
      ? finish([...allowed].filter((name) => !config.tools?.some((tool) => tool.name === name)))
      : remote.enabledBuiltinTools
        ? finish(remote.enabledBuiltinTools)
        : undefined;
    return {
      ...(remote.workspaceDir ? { workspaces: [remote.workspaceDir] } : {}),
      ...(remote.homeDir
        ? {
            saveDir: path.posix.join(remote.homeDir, "sessions"),
            appDataDir: path.posix.join(remote.homeDir, "harness"),
          }
        : {}),
      endpoint: bridgeEndpoint(endpoint).config,
      ...(config.systemMessage?.content
        ? {
            system: {
              mode: config.systemMessage.mode ?? "append",
              text: config.systemMessage.content,
            },
          }
        : {}),
      hostTools,
      mcpServers: [],
      ...(enabled ? { enabledBuiltinTools: enabled } : {}),
      ...(config.responseSchema ? { responseSchema: config.responseSchema } : {}),
      ...(enabled
        ? {}
        : {
            disabledBuiltinTools: [
              ...new Set([
                ...ANTIGRAVITY_MARSHAL_OWNED_TOOLS,
                ...(config.disabledBuiltInTools ?? []),
                ...(remote.disabledBuiltinTools ?? []),
              ]),
            ],
          }),
    };
  }

  /** Starts a session's own bridge on another machine, through the caller's spawner, on a proxy endpoint. */
  private startRemoteBridge(id: string, remote: AntigravityRemoteBridge): AntigravityBridge {
    assertProxyEndpoint(remote.endpoint);
    const child = remote.spawnBridge({
      sessionId: id,
      bridgeSource: ANTIGRAVITY_BRIDGE_SOURCE,
      sdkVersion: ANTIGRAVITY_SDK_VERSION,
      protocol: ANTIGRAVITY_BRIDGE_PROTOCOL,
      env: { ...bridgeEndpoint(remote.endpoint).env },
    });
    const bridge = new AntigravityBridge({ child });
    this.remoteBridges.set(id, bridge);
    return bridge;
  }

  private stopRemoteBridge(id: string, bridge: AntigravityBridge): void {
    if (this.remoteBridges.get(id) !== bridge) return;
    this.remoteBridges.delete(id);
    void bridge.stop().catch((error: unknown) =>
      log.warn("remote Antigravity bridge did not stop cleanly", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private async startSession(
    id: string,
    config: RuntimeSessionConfig,
    resume: boolean,
  ): Promise<AntigravityRuntimeSession> {
    if (this.sessions.has(id)) throw new Error(`Antigravity session ${id} is already active`);
    const remote = config.antigravityRemote;
    const bridge = remote ? this.startRemoteBridge(id, remote) : await this.ensureBridge();
    const endpoint = remote ? remote.endpoint : this.endpoint;
    if (!endpoint) throw new Error(ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS);
    const session = new AntigravityRuntimeSession(
      bridge,
      id,
      config,
      {
        baseConfig: this.baseConfig(config, endpoint, remote),
        modelId: config.model || ANTIGRAVITY_DEFAULT_MODEL_ID,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        resume,
      },
      () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        if (remote) this.stopRemoteBridge(id, bridge);
      },
    );
    this.sessions.set(id, session);
    try {
      await session.open();
    } catch (error) {
      this.sessions.delete(id);
      if (remote) this.stopRemoteBridge(id, bridge);
      throw error;
    }
    return session;
  }
}
