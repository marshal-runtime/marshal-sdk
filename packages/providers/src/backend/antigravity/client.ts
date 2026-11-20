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
import { AntigravityBridge } from "./bridge-process";
import {
  ANTIGRAVITY_DEFAULT_MODEL_ID,
  ANTIGRAVITY_MARSHAL_OWNED_TOOLS,
  type AntigravityProcessEnv,
} from "./constants";
import {
  ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS,
  bridgeEndpoint,
  clearAntigravityCredentials,
  describeAntigravityEndpoint,
  resolveAntigravityEndpoint,
  saveAntigravityCredential,
  type AntigravityEndpoint,
} from "./credentials";
import { ensureAntigravityEnvironment, type AntigravityPythonEnvironment } from "./environment";
import { antigravityModels } from "./models";
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
  ): Record<string, unknown> {
    const cwd = config.cwd ?? config.workingDirectory ?? this.options.workspaceDir;
    const restricted = config.availableTools !== undefined;
    const allowed = new Set(config.availableTools ?? []);
    const exposed = config.exposedHostTools ? new Set(config.exposedHostTools) : undefined;
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
            enabledBuiltinTools: [...allowed].filter(
              (name) => !config.tools?.some((tool) => tool.name === name),
            ),
          }
        : {}),
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

  private async startSession(
    id: string,
    config: RuntimeSessionConfig,
    resume: boolean,
  ): Promise<AntigravityRuntimeSession> {
    if (this.sessions.has(id)) throw new Error(`Antigravity session ${id} is already active`);
    const bridge = await this.ensureBridge();
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error(ANTIGRAVITY_AUTH_SETUP_INSTRUCTIONS);
    const session = new AntigravityRuntimeSession(
      bridge,
      id,
      config,
      {
        baseConfig: this.baseConfig(config, endpoint),
        modelId: config.model || ANTIGRAVITY_DEFAULT_MODEL_ID,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        resume,
      },
      () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      },
    );
    this.sessions.set(id, session);
    try {
      await session.open();
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
    return session;
  }
}
