import path from "node:path";

import type { RuntimeClientFactory } from "../runtime-contract";
import { AntigravityRuntimeClient } from "./client";
import type { AntigravityProcessEnv } from "./constants";
import {
  defaultAntigravityHome,
  ensureAntigravityEnvironment,
  type AntigravityPythonEnvironment,
} from "./environment";

export interface AntigravityClientFactoryOptions {
  env?: AntigravityProcessEnv;
  /** Overrides the folder holding the venv, credentials and conversations. */
  homeDir?: string;
  /** The host's data folder (`~/.marshal`); the home is `<it>/antigravity`. */
  appDataDir?: () => string | Promise<string>;
  /** An extra account: its own credentials and conversations, no launch-environment credentials. */
  accountId?: string;
  environment?: () => Promise<AntigravityPythonEnvironment>;
}

const CREDENTIAL_ENV_NAMES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

function accountEnvironment(env: AntigravityProcessEnv, accountId: string | undefined) {
  if (!accountId) return env;
  const scoped = { ...env };
  for (const name of CREDENTIAL_ENV_NAMES) delete scoped[name];
  return scoped;
}

export async function antigravityHomeDir(options: AntigravityClientFactoryOptions): Promise<string> {
  const base = options.homeDir ?? defaultAntigravityHome(options.appDataDir ? await options.appDataDir() : undefined);
  return options.accountId ? path.join(base, "accounts", options.accountId) : base;
}

export function createAntigravityClientFactory(
  options: AntigravityClientFactoryOptions = {},
): RuntimeClientFactory {
  return async (workspaceDir) => {
    const homeDir = await antigravityHomeDir(options);
    // Accounts share the base home's venv; only credentials and conversations are per account.
    const sharedHome = options.homeDir ?? defaultAntigravityHome(options.appDataDir ? await options.appDataDir() : undefined);
    const env = accountEnvironment(options.env ?? process.env, options.accountId);
    return new AntigravityRuntimeClient({
      workspaceDir,
      homeDir,
      env,
      environment:
        options.environment ??
        (() => ensureAntigravityEnvironment({ homeDir: sharedHome, env })),
    });
  };
}
