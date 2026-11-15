import type { RuntimeClientFactory } from "../runtime-contract";
import { CursorRuntimeClient } from "./client";
import { CURSOR_API_KEY_ENV, type CursorProcessEnv } from "./constants";
import { marshalCursorCredentialStorePath } from "./credential-store";
import { loadCursorSdk, type CursorSdkFacade, type SdkCredentialStore } from "./sdk-facade";

export interface CursorClientFactoryOptions {
  env?: CursorProcessEnv;
  store?: SdkCredentialStore;
  sdk?: CursorSdkFacade;
  credentialStorePath?: string;
  /** An extra account: its own credential store, and no launch-environment API key. */
  accountId?: string;
  /** The host's data folder, where signed-in credentials are kept unless a store or path is given. */
  appDataDir?: () => string | Promise<string>;
}

function accountEnvironment(env: CursorProcessEnv, accountId: string | undefined) {
  if (!accountId) return env;
  const scoped = { ...env };
  for (const name of Object.keys(scoped)) {
    if (name.toUpperCase() === CURSOR_API_KEY_ENV) delete scoped[name];
  }
  return scoped;
}

async function credentialStorePathOf(options: CursorClientFactoryOptions): Promise<string> {
  if (options.credentialStorePath) return options.credentialStorePath;
  if (!options.appDataDir) {
    throw new Error(
      "Cursor needs a credential store: pass store, credentialStorePath or appDataDir.",
    );
  }
  return marshalCursorCredentialStorePath(await options.appDataDir(), options.accountId);
}

export function createCursorClientFactory(
  options: CursorClientFactoryOptions = {},
): RuntimeClientFactory {
  return async (workspaceDir) => {
    const sdk = options.sdk ?? (await loadCursorSdk());
    const store =
      options.store ?? sdk.createFileCredentialStore(await credentialStorePathOf(options));
    return new CursorRuntimeClient(sdk, {
      workspaceDir,
      env: accountEnvironment(options.env ?? process.env, options.accountId),
      store,
    });
  };
}
