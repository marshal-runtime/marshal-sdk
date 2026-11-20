import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { query as claudeAgentSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { TURN_EXTRAS, type QueryFn, type TurnExtras } from "./agent-port.js";
import { readSecret, requireProviderKey } from "./credentials.js";
import { createOpenAIAgentsQuery } from "./openai-agents-query.js";
import type { ModelProvider } from "@openai/agents";
import { createEngineQuery, type EngineRuntime } from "./engine-query.js";
import { PROVIDER_TOOLS } from "./provider-query.js";
import {
  claudeAccountConfigDir,
  createAntigravityClientFactory,
  type AntigravityClientFactoryOptions,
  codexAccountHome,
  createClaudeClientFactory,
  createCodexClientFactory,
  createCursorClientFactory,
  CURSOR_API_KEY_ENV,
  defaultCodexHome,
  listRuntimeAccounts,
  marshalCursorCredentialStorePath,
  normalizeRuntimeAccounts,
  withoutLaunchCredentials,
  type ClaudeClientFactoryOptions,
  type CodexClientFactoryOptions,
  type CursorClientFactoryOptions,
  type RuntimeClientFactory,
  type RuntimeTool,
} from "./providers.js";

export { PROVIDER_TOOLS };

export const PROVIDER_IDS = ["claude", "openai", "codex", "cursor", "antigravity"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Which model provider runs a host's sessions, and on whose credentials (docs/providers.md). */
export interface ProviderSelection {
  id: ProviderId;
  /**
   * An account from the Marshal desktop's account registry (Settings, Accounts), such as `omer-max`: its own
   * credential home, the same one the desktop uses. Omitted: the provider's original home (for Claude, the host
   * environment exactly as given).
   */
  account?: string;
  /** Run on an API key read from this environment variable instead of a signed-in subscription. OpenAI always runs on a key: default OPENAI_API_KEY. */
  apiKeyEnv?: string;
  /** Overrides the credential home: CLAUDE_CONFIG_DIR, CODEX_HOME, or the folder holding Cursor's credential store. */
  home?: string;
  /**
   * Claude only. `client` (default) runs each turn on the Marshal desktop's Claude client, the code the desktop runs
   * its own sessions on; a turn that asks for what that client doesn't take (structured output, the launch's own
   * hooks, env, CLI flags or spawner, turn and budget caps, a fork at an earlier message) runs on the Claude Agent SDK
   * instead, on the same native session. `agent-sdk` runs every turn on the Claude Agent SDK directly.
   */
  engine?: ClaudeEngine;
}

export type ClaudeEngine = "client" | "agent-sdk";
export const DEFAULT_CLAUDE_ENGINE: ClaudeEngine = "client";

export type ProviderCredential = "subscription" | "api-key";

export interface ResolvedProvider {
  id: ProviderId;
  credential: ProviderCredential;
  account?: string;
  /** Environment of the Claude Agent SDK path. */
  env: Record<string, string>;
  /** Set when turns run on a provider client rather than the Claude Agent SDK. */
  query?: QueryFn & { dispose(): Promise<void> };
  /** The model a session uses when its launch names none; empty lets the provider choose its own. */
  defaultModel?: string;
  /** One line for the host log: provider, credential kind, account, home. Never a secret. */
  description: string;
}

export interface ResolveProviderOptions {
  env: Record<string, string>;
  /** The host's private folder: API-key credential homes live here, never in a person's own homes. */
  privateRoot: string;
  /** Folders holding a Marshal desktop's `marshal-settings.json`; default ~/.marshal and ~/.marshal-dev. */
  desktopDataDirs?: readonly string[];
  homeDir?: string;
  /** Test hook: the provider client factories. */
  factories?: {
    claude?: (options: ClaudeClientFactoryOptions) => RuntimeClientFactory;
    codex?: (options: CodexClientFactoryOptions) => RuntimeClientFactory;
    cursor?: (options: CursorClientFactoryOptions) => RuntimeClientFactory;
    antigravity?: (options: AntigravityClientFactoryOptions) => RuntimeClientFactory;
    /** The OpenAI Agents SDK model provider for a key. */
    openai?: (options: { apiKey: string }) => ModelProvider;
    /** The Claude Agent SDK's query, for turns the Claude client doesn't take. */
    claudeAgentSdk?: QueryFn;
  };
  log?: (line: string) => void;
}

const DEFAULT_ACCOUNT = "default";

export function resolveProvider(selection: ProviderSelection, options: ResolveProviderOptions): ResolvedProvider {
  if (!(PROVIDER_IDS as readonly string[]).includes(selection.id)) {
    throw new Error(`Unknown provider "${String(selection.id)}"; use one of ${PROVIDER_IDS.join(", ")}.`);
  }
  if (selection.engine && selection.id !== "claude") {
    throw new Error(`engine applies to the Claude provider only, not ${selection.id}.`);
  }
  if (selection.account && selection.apiKeyEnv) {
    throw new Error("Choose an account or an API key for a provider, not both.");
  }
  if (selection.id === "openai") {
    // The OpenAI Agents SDK runs on the OpenAI API: an API key, never a ChatGPT login (that is the codex provider).
    if (selection.account || selection.home) throw new Error("The openai provider runs on an API key (apiKeyEnv, default OPENAI_API_KEY), not an account or home.");
    const { key, source } = requireProviderKey("openai", { env: options.env, ...(selection.apiKeyEnv ? { keyEnv: selection.apiKeyEnv } : {}) });
    const modelProvider = options.factories?.openai?.({ apiKey: key });
    return {
      id: "openai",
      credential: "api-key",
      env: options.env,
      query: Object.assign(
        createOpenAIAgentsQuery({ apiKey: key, ...(modelProvider ? { modelProvider } : {}), ...(options.log ? { log: options.log } : {}) }),
        { dispose: async () => undefined },
      ),
      defaultModel: "",
      description: `provider openai (Agents SDK): API key from ${source}`,
    };
  }
  const homeDir = options.homeDir ?? os.homedir();
  const dataDirs = options.desktopDataDirs ?? [path.join(homeDir, ".marshal"), path.join(homeDir, ".marshal-dev")];
  const account = selection.account && selection.account !== DEFAULT_ACCOUNT ? selection.account : undefined;
  if (account) checkAccount(selection.id, account, dataDirs, accountHome(selection.id, account, homeDir, dataDirs));
  const apiKey = selection.apiKeyEnv ? readApiKey(options.env, selection.apiKeyEnv) : undefined;
  const credential: ProviderCredential = apiKey !== undefined ? "api-key" : "subscription";
  const engine = selection.id === "claude" ? (selection.engine ?? DEFAULT_CLAUDE_ENGINE) : undefined;
  if (engine && engine !== "client" && engine !== "agent-sdk") throw new Error(`Unknown Claude engine "${String(engine)}"; use client or agent-sdk.`);
  // The Claude CLI uses ANTHROPIC_API_KEY from its env over the account's login, so say so rather than "subscription".
  const envKey = selection.id === "claude" && credential === "subscription" && Boolean(options.env.ANTHROPIC_API_KEY);
  const describe = (home: string | undefined) =>
    `provider ${selection.id}${engine ? ` (${engine === "client" ? "Claude client" : "Claude Agent SDK"})` : ""}: ${credential === "api-key" ? `API key from ${selection.apiKeyEnv}` : envKey ? "API key from ANTHROPIC_API_KEY in the environment (it outranks the account login)" : `subscription, account ${account ?? DEFAULT_ACCOUNT}`}${home ? `, home ${home}` : ""}`;
  const fresh = (name: string) => {
    const dir = path.join(options.privateRoot, "providers", name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const factories = options.factories ?? {};
  // Every provider client runs under the Marshal session engine, the desktop's own (packages/providers backend/local).
  const providerQuery = (runtime: EngineRuntime, factory: RuntimeClientFactory, prepare?: Parameters<typeof createEngineQuery>[0]["prepare"]) =>
    createEngineQuery({
      runtime,
      factory,
      appDataDir: path.join(options.privateRoot, "engine"),
      ...(prepare ? { prepare } : {}),
      ...(options.log ? { log: options.log } : {}),
    });

  switch (selection.id) {
    case "claude": {
      let env = { ...options.env };
      let home: string | undefined;
      if (apiKey !== undefined) {
        env = withoutLaunchCredentials(env) as Record<string, string>;
        env.ANTHROPIC_API_KEY = apiKey;
        if (selection.home) env.CLAUDE_CONFIG_DIR = home = selection.home;
      } else if (account || selection.home) {
        env = withoutLaunchCredentials(env) as Record<string, string>;
        env.CLAUDE_CONFIG_DIR = home = selection.home ?? claudeAccountConfigDir(account!, homeDir);
      } else {
        home = env.CLAUDE_CONFIG_DIR;
      }
      const resolved: ResolvedProvider = {
        id: "claude",
        credential: apiKey === undefined && !account && !selection.home && env.ANTHROPIC_API_KEY ? "api-key" : credential,
        ...(account ? { account } : {}),
        env,
        description: describe(home),
      };
      if (engine === "agent-sdk") return resolved;
      // An account keeps the desktop's layout: its own login, transcripts linked under the original home.
      const make = factories.claude ?? createClaudeClientFactory;
      // Per session, the turn's setting sources decide whether project rules load (projectContext).
      const factory = make({
        env,
        ...(apiKey !== undefined
          ? { configDir: home ?? fresh("claude") }
          : account && !selection.home
            ? { accountId: account, accountHomeDir: homeDir }
            : home
              ? { configDir: home }
              : {}),
      });
      const client = providerQuery("claude", factory);
      const agentSdk = factories.claudeAgentSdk ?? (claudeAgentSdkQuery as unknown as QueryFn);
      const query: QueryFn = (params) => {
        const needs = agentSdkOnly(params.options);
        if (!needs.length) return client(params);
        options.log?.(`turn on the Claude Agent SDK: the Claude client doesn't take ${needs.join(", ")}`);
        return agentSdk(params);
      };
      return { ...resolved, query: Object.assign(query, { dispose: () => client.dispose() }) };
    }
    case "codex": {
      const home =
        selection.home ??
        (apiKey !== undefined ? fresh("codex") : account ? codexAccountHome(account, homeDir) : defaultCodexHome());
      const make = factories.codex ?? createCodexClientFactory;
      const factory = make({ codexHome: home, env: options.env });
      const prepare =
        apiKey === undefined
          ? undefined
          : async (client: Parameters<NonNullable<Parameters<typeof createEngineQuery>[0]["prepare"]>>[0]) => {
              if (!client.login) throw new Error("This Codex client cannot sign in with an API key.");
              await client.login({ type: "api-key", apiKey });
            };
      return {
        id: "codex",
        credential,
        ...(account ? { account } : {}),
        env: options.env,
        query: providerQuery("codex", factory, prepare),
        defaultModel: "",
        description: describe(home),
      };
    }
    case "cursor": {
      const make = factories.cursor ?? createCursorClientFactory;
      let factory: RuntimeClientFactory;
      let home: string;
      if (apiKey !== undefined) {
        // An empty private store, so the key below is the one in use (a stored login outranks the environment).
        home = selection.home ?? fresh("cursor");
        factory = make({
          env: { ...options.env, [CURSOR_API_KEY_ENV]: apiKey },
          credentialStorePath: marshalCursorCredentialStorePath(home),
        });
      } else {
        home = selection.home ?? cursorDataDir(dataDirs, account);
        factory = make({
          env: options.env,
          ...(account ? { accountId: account } : {}),
          credentialStorePath: marshalCursorCredentialStorePath(home, account),
        });
      }
      return {
        id: "cursor",
        credential,
        ...(account ? { account } : {}),
        env: options.env,
        query: providerQuery("cursor", factory),
        defaultModel: "",
        description: describe(home),
      };
    }
    case "antigravity": {
      // Google Antigravity (its Python SDK through the providers' bridge) on Vertex AI or the Gemini API. The default
      // home and an account's home hold credentials the desktop stored; a key (a Gemini API key, a Vertex
      // service-account JSON or {"project","location"}) goes into a private home of the host's own.
      const make = factories.antigravity ?? createAntigravityClientFactory;
      const home =
        selection.home ??
        (apiKey !== undefined ? fresh("antigravity") : antigravityAccountHome(account, homeDir, dataDirs));
      const factory = make({ env: options.env, homeDir: home });
      const prepare =
        apiKey === undefined
          ? undefined
          : async (client: Parameters<NonNullable<Parameters<typeof createEngineQuery>[0]["prepare"]>>[0]) => {
              if (!client.login) throw new Error("This Antigravity client cannot take credentials.");
              await client.login({ type: "api-key", apiKey });
            };
      return {
        id: "antigravity",
        credential,
        ...(account ? { account } : {}),
        env: options.env,
        query: providerQuery("antigravity", factory, prepare),
        defaultModel: "",
        description: describe(home),
      };
    }
  }
}

/**
 * Agent SDK options the Claude client has no field for. A turn that sets one runs on the Claude Agent SDK; both
 * engines run the same Claude CLI on the same config dir, so the session continues across them.
 */
const AGENT_SDK_ONLY_OPTIONS = [
  "outputFormat",
  "hooks",
  "extraArgs",
  "spawnClaudeCodeProcess",
  "pathToClaudeCodeExecutable",
  "maxTurns",
  "maxBudgetUsd",
  "allowedTools",
  "strictMcpConfig",
  "resumeSessionAt",
] as const;

export function agentSdkOnly(turnOptions: Record<string, unknown>): string[] {
  const needs: string[] = AGENT_SDK_ONLY_OPTIONS.filter((name) => turnOptions[name] !== undefined);
  // The client's environment is fixed when it is made; a launch's own env needs a process of its own.
  const extras = (turnOptions as Record<symbol, unknown>)[TURN_EXTRAS] as TurnExtras | undefined;
  if (extras?.launchEnv) needs.push("env");
  // A live process reads a stream of user messages that stays open across turns; the client takes one prompt per turn.
  if (extras?.live) needs.push("a live process");
  // The host's own in-process server (marshal) reaches the client as PROVIDER_TOOLS; a launch's would be dropped.
  const servers = (turnOptions.mcpServers ?? {}) as Record<string, { type?: unknown }>;
  const inProcess = Object.entries(servers).filter(([name, server]) => name !== "marshal" && server?.type === "sdk");
  if (inProcess.length) needs.push(`in-process MCP servers (${inProcess.map(([name]) => name).join(", ")})`);
  return needs;
}

/**
 * The marshal tools of one session as provider-neutral tools, for providers that take tools directly rather than
 * the Claude Agent SDK's in-process MCP server.
 */
export function marshalProviderTools(
  call: (name: string, args: unknown) => Promise<{ content: unknown[]; isError?: boolean }>,
  readResource: (uri: string) => Promise<{ contents: { text?: string }[] }>,
  schemas: readonly { name: string; description?: string; inputSchema?: unknown }[],
): RuntimeTool[] {
  const text = (content: unknown[]) =>
    content
      .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text: unknown }).text) : JSON.stringify(item)))
      .join("\n");
  const tools: RuntimeTool[] = schemas
    .filter((schema) => schema.name === "runtime_search" || schema.name === "runtime_exec")
    .map((schema) => ({
      name: schema.name,
      ...(schema.description ? { description: schema.description } : {}),
      ...(schema.inputSchema ? { parameters: schema.inputSchema as Record<string, unknown> } : {}),
      handler: async (args: unknown) => {
        const result = await call(schema.name, args);
        if (result.isError) throw new Error(text(result.content));
        return text(result.content);
      },
    }));
  tools.push({
    name: "runtime_read_resource",
    description:
      "Read a Marshal runtime resource by URI: an installed extension's skill (skill://<extension>/<name>) and the references it names, or a resource a runtime_search entry points to (action resource_read).",
    parameters: {
      type: "object",
      properties: { uri: { type: "string", minLength: 1, maxLength: 2048 } },
      required: ["uri"],
      additionalProperties: false,
    },
    handler: async (args: unknown) => {
      const uri = (args as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== "string" || !uri) throw new Error("uri is required");
      const read = await readResource(uri);
      return read.contents.map((item) => item.text ?? "").join("\n");
    },
  });
  return tools;
}

function readApiKey(env: Record<string, string>, name: string): string {
  const value = readSecret(name, env);
  if (!value) throw new Error(`The API key variable ${name} is not set in the host environment (nor ${name}_FILE).`);
  return value;
}

function accountHome(id: ProviderId, account: string, homeDir: string, dataDirs: readonly string[]): string {
  if (id === "claude") return claudeAccountConfigDir(account, homeDir);
  if (id === "codex") return codexAccountHome(account, homeDir);
  if (id === "antigravity") return antigravityAccountHome(account, homeDir, dataDirs);
  return path.dirname(marshalCursorCredentialStorePath(cursorDataDir(dataDirs, account), account));
}

/** The desktop accounts of a provider across every desktop data folder found. */
export function desktopAccounts(id: ProviderId, dataDirs: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const dir of dataDirs) {
    const file = path.join(dir, "marshal-settings.json");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      continue;
    }
    const settings = normalizeRuntimeAccounts((raw as { runtimeAccounts?: unknown } | null)?.runtimeAccounts);
    for (const entry of listRuntimeAccounts(settings, id)) if (entry.id !== DEFAULT_ACCOUNT) ids.add(entry.id);
  }
  return [...ids].sort();
}

function checkAccount(id: ProviderId, account: string, dataDirs: readonly string[], home: string): void {
  const known = desktopAccounts(id, dataDirs);
  if (known.includes(account) || fs.existsSync(home)) return;
  throw new Error(
    `No ${id} account "${account}" in the Marshal desktop's accounts${known.length ? ` (${known.join(", ")})` : ""}, and ${home} does not exist. Add the account in Marshal, Settings, Accounts.`,
  );
}

/** The desktop's Antigravity home (`<data>/antigravity`), or an account's home under it. */
function antigravityAccountHome(account: string | undefined, homeDir: string, dataDirs: readonly string[]): string {
  const base = path.join(dataDirs[0] ?? path.join(homeDir, ".marshal"), "antigravity");
  return account ? path.join(base, "accounts", account) : base;
}

/** The desktop data folder whose Cursor credential store exists, else the first (production) one. */
function cursorDataDir(dataDirs: readonly string[], account: string | undefined): string {
  return (
    dataDirs.find((dir) => fs.existsSync(marshalCursorCredentialStorePath(dir, account))) ??
    dataDirs[0] ??
    path.join(os.homedir(), ".marshal")
  );
}
