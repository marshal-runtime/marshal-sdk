import { execFile } from "node:child_process";

import { readSecret } from "../credentials.js";

export type ModelEnv = Readonly<Record<string, string | undefined>>;

/** The one place model services read a key: the SDK's shared resolver (`NAME`, then the file `NAME_FILE` names). */
export function modelCredential(name: string, env: ModelEnv = process.env): string | undefined {
  return readSecret(name, env);
}

export type AccessTokenProvider = () => Promise<string>;

interface GoogleAuthModule {
  GoogleAuth: new (options: { scopes: string[] }) => { getAccessToken(): Promise<string | null | undefined> };
}

/**
 * Google access tokens: `GOOGLE_ACCESS_TOKEN` (or its _FILE) when given, else Application Default Credentials through
 * google-auth-library when the host has it installed, else `gcloud auth application-default print-access-token`.
 * Tokens are cached until about a minute before they expire (an hour for gcloud and env tokens, which carry no expiry).
 */
export function googleAccessTokenProvider(env: ModelEnv = process.env): AccessTokenProvider {
  let held: { value: string; expires: number } | undefined;
  return async () => {
    if (held && held.expires > Date.now() + 60_000) return held.value;
    const fixed = modelCredential("GOOGLE_ACCESS_TOKEN", env);
    if (fixed) return fixed;
    let value: string | undefined;
    try {
      const moduleName = "google-auth-library";
      const auth = (await import(moduleName)) as GoogleAuthModule;
      value = (await new auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getAccessToken()) ?? undefined;
    } catch {
      value = await gcloudToken();
    }
    if (!value) throw new Error("No Google access token: set GOOGLE_ACCESS_TOKEN, install google-auth-library, or run `gcloud auth application-default login`.");
    held = { value, expires: Date.now() + 50 * 60_000 };
    return value;
  };
}

function gcloudToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 15_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}
