import fs from "node:fs";

/**
 * The SDK's one credential resolver. Agent providers (src/provider-selection.ts) and model services (src/models) read
 * keys here, so a key is found the same way everywhere: `NAME` wins, then the file named by `NAME_FILE` (how a sandbox
 * or a secret mount hands one over). Signed-in subscriptions (a Claude config dir, a Codex home, a Cursor store) are
 * resolved by `resolveProvider`, which uses this for its API-key mode.
 */
export type CredentialEnv = Readonly<Record<string, string | undefined>>;

/** Where each provider's API key is read from when the caller names no variable. */
export const DEFAULT_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
  gemini: "GEMINI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
} as const;
export type KeyProvider = keyof typeof DEFAULT_KEY_ENV;

/** A secret from `name` or the file `name_FILE` names; undefined when neither holds one. */
export function readSecret(name: string, env: CredentialEnv = process.env): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedKey {
  key: string;
  /** The variable it came from (never the key itself): safe to log. */
  source: string;
}

/** A provider's API key from `keyEnv` (default: the provider's usual variable), or undefined. */
export function providerKey(
  provider: KeyProvider,
  options: { env?: CredentialEnv; keyEnv?: string } = {},
): ResolvedKey | undefined {
  const name = options.keyEnv ?? DEFAULT_KEY_ENV[provider];
  const key = readSecret(name, options.env ?? process.env);
  return key ? { key, source: name } : undefined;
}

/** Like providerKey, but a missing key is an error that names where it was looked for. */
export function requireProviderKey(
  provider: KeyProvider,
  options: { env?: CredentialEnv; keyEnv?: string } = {},
): ResolvedKey {
  const found = providerKey(provider, options);
  if (found) return found;
  const name = options.keyEnv ?? DEFAULT_KEY_ENV[provider];
  throw new Error(`No ${provider} API key: set ${name} (or ${name}_FILE) in the host environment.`);
}
