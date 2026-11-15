import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { QueryFn } from "./agent-port.js";
import { createProviderQuery, PROVIDER_TOOLS } from "./provider-query.js";
import {
  claudeAccountConfigDir,
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

export const PROVIDER_IDS = ["claude", "codex", "cursor"] as const;
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
  /** Run on an API key read from this environment variable instead of a signed-in subscription. */
  apiKeyEnv?: string;
  /** Overrides the credential home: CLAUDE_CONFIG_DIR, CODEX_HOME, or the folder holding Cursor's credential store. */
  home?: string;
  /**
   * Claude only. `agent-sdk` (default) runs each turn on the Claude Agent SDK directly, with forks, images and
   * structured output; `client` runs it on the Marshal desktop's Claude client.
   */
  engine?: "agent-sdk" | "client";
}

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
  const homeDir = options.homeDir ?? os.homedir();
  const dataDirs = options.desktopDataDirs ?? [path.join(homeDir, ".marshal"), path.join(homeDir, ".marshal-dev")];
  const account = selection.account && selection.account !== DEFAULT_ACCOUNT ? selection.account : undefined;
  if (account) checkAccount(selection.id, account, dataDirs, accountHome(selection.id, account, homeDir, dataDirs));
  const apiKey = selection.apiKeyEnv ? readApiKey(options.env, selection.apiKeyEnv) : undefined;
  const credential: ProviderCredential = apiKey !== undefined ? "api-key" : "subscription";
  const describe = (home: string | undefined) =>
    `provider ${selection.id}${selection.engine === "client" ? " (client)" : ""}: ${credential === "api-key" ? `API key from ${selection.apiKeyEnv}` : `subscription, account ${account ?? DEFAULT_ACCOUNT}`}${home ? `, home ${home}` : ""}`;
  const fresh = (name: string) => {
    const dir = path.join(options.privateRoot, "providers", name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const factories = options.factories ?? {};
  const providerQuery = (factory: RuntimeClientFactory, prepare?: Parameters<typeof createProviderQuery>[0]["prepare"]) =>
    createProviderQuery({ factory, ...(prepare ? { prepare } : {}), ...(options.log ? { log: options.log } : {}) });

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
      if (selection.engine !== "client") return resolved;
      // An account keeps the desktop's layout: its own login, transcripts linked under the original home.
      const make = factories.claude ?? createClaudeClientFactory;
      const factory = make({
        env,
        ...(apiKey !== undefined
          ? { configDir: home ?? fresh("claude") }
          : account && !selection.home
            ? { accountId: account, accountHomeDir: homeDir }
            : home
              ? { configDir: home }
              : {}),
        settingSources: [],
      });
      return { ...resolved, query: providerQuery(factory) };
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
          : async (client: Parameters<NonNullable<Parameters<typeof createProviderQuery>[0]["prepare"]>>[0]) => {
              if (!client.login) throw new Error("This Codex client cannot sign in with an API key.");
              await client.login({ type: "api-key", apiKey });
            };
      return {
        id: "codex",
        credential,
        ...(account ? { account } : {}),
        env: options.env,
        query: providerQuery(factory, prepare),
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
        query: providerQuery(factory),
        defaultModel: "",
        description: describe(home),
      };
    }
  }
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
  const value = env[name]?.trim();
  if (!value) throw new Error(`The API key variable ${name} is not set in the host environment.`);
  return value;
}

function accountHome(id: ProviderId, account: string, homeDir: string, dataDirs: readonly string[]): string {
  if (id === "claude") return claudeAccountConfigDir(account, homeDir);
  if (id === "codex") return codexAccountHome(account, homeDir);
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

/** The desktop data folder whose Cursor credential store exists, else the first (production) one. */
function cursorDataDir(dataDirs: readonly string[], account: string | undefined): string {
  return (
    dataDirs.find((dir) => fs.existsSync(marshalCursorCredentialStorePath(dir, account))) ??
    dataDirs[0] ??
    path.join(os.homedir(), ".marshal")
  );
}
