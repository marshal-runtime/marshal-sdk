/**
 * Joining an organization as the person who started the run (R18): the same org token they use in Marshal, read from a
 * file or the environment, never a service identity. On the desktop that is their signed-in token; in the cloud the
 * requester's token is handed to the run (MARSHAL_ORG_TOKEN_FILE, or MARSHAL_ORG_TOKEN).
 *
 * Writing to a production organization is allowed under that identity, but off unless asked for
 * (MARSHAL_ORG_ALLOW_PRODUCTION=1 or `allowProductionOrg`): a test organization is a loopback host or a name under
 * .test, .example, .invalid or .localhost (isTestOrg).
 */
import fs from "node:fs";

import { OrgClient, fetchOrgDiscovery, type OrgIdentity } from "@marshal/agent-runtime-org";

import { isTestOrg } from "./org-bridge.js";
import { orgExtensionResolver } from "./org-extensions.js";
import { OnboardingError, type ExtensionResolver, type ManifestOrg } from "./onboarding.js";

type FetchLike = NonNullable<ConstructorParameters<typeof OrgClient>[0]["fetch"]>;
type Env = Record<string, string | undefined>;

export const ORG_TOKEN_ENV = "MARSHAL_ORG_TOKEN";
export const ORG_TOKEN_FILE_ENV = "MARSHAL_ORG_TOKEN_FILE";
export const ORG_URL_ENV = "MARSHAL_ORG_URL";
export const ORG_ALLOW_PRODUCTION_ENV = "MARSHAL_ORG_ALLOW_PRODUCTION";

export class OrgConnectError extends Error {
  constructor(
    readonly code: "org-token-missing" | "org-token-empty" | "production-org-off" | "org-url-missing",
    message: string,
  ) {
    super(message);
    this.name = "OrgConnectError";
  }
}

export interface OrgCredentialSource {
  /** A file holding the person's token. Read on every call, so whoever refreshes the token only rewrites the file. */
  tokenFile?: string;
  /** The token itself (tests, or a caller that keeps it in memory). */
  token?: string;
}

/**
 * The person's access token: `tokenFile`, else `token`, else MARSHAL_ORG_TOKEN_FILE, else MARSHAL_ORG_TOKEN.
 * The token never appears in an error or a log line.
 */
export function personAccessToken(source: OrgCredentialSource = {}, env: Env = process.env): () => Promise<string> {
  const file = source.tokenFile ?? (source.token === undefined ? env[ORG_TOKEN_FILE_ENV] : undefined);
  const fixed = source.token ?? (file ? undefined : env[ORG_TOKEN_ENV]);
  if (!file && !fixed) {
    throw new OrgConnectError(
      "org-token-missing",
      `Joining the organization needs the token of the person this run is for: set ${ORG_TOKEN_FILE_ENV} to a file holding it, or ${ORG_TOKEN_ENV}.`,
    );
  }
  return async () => {
    const value = (file ? fs.readFileSync(file, "utf8") : fixed!).trim();
    if (!value) throw new OrgConnectError("org-token-empty", file ? `The org token file ${file} is empty.` : `${ORG_TOKEN_ENV} is empty.`);
    return value;
  };
}

export interface ConnectOrgOptions extends OrgCredentialSource {
  /** The organization's URL (its discovery document lives under it). Default MARSHAL_ORG_URL. */
  orgUrl?: string;
  env?: Env;
  accessToken?: () => Promise<string>;
  /** A production organization. Default: MARSHAL_ORG_ALLOW_PRODUCTION=1. */
  allowProductionOrg?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface OrgConnection {
  client: OrgClient;
  accessToken: () => Promise<string>;
  allowProductionOrg: boolean;
  /** Who the token belongs to (`whoami`), read once. */
  identity(): Promise<OrgIdentity>;
}

/** Discovery, then a client holding the person's token. Refuses a production organization before sending anything. */
export async function connectOrg(options: ConnectOrgOptions = {}): Promise<OrgConnection> {
  const env = options.env ?? process.env;
  const orgUrl = options.orgUrl ?? env[ORG_URL_ENV];
  if (!orgUrl) throw new OrgConnectError("org-url-missing", `No organization named: give its URL (manifest "org.discovery", or ${ORG_URL_ENV}).`);
  const allowProductionOrg = options.allowProductionOrg ?? env[ORG_ALLOW_PRODUCTION_ENV] === "1";
  refuseProduction(orgUrl, allowProductionOrg);
  const accessToken = options.accessToken ?? personAccessToken(options, env);
  const discovery = await fetchOrgDiscovery(orgUrl, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  // The discovery document names the API; it must be a test one too.
  refuseProduction(discovery.apiBase, allowProductionOrg);
  const client = new OrgClient({ discovery, accessToken, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  let identity: Promise<OrgIdentity> | undefined;
  return { client, accessToken, allowProductionOrg, identity: () => (identity ??= client.whoami()) };
}

function refuseProduction(url: string, allowed: boolean): void {
  if (allowed || isTestOrg(url)) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not a URL: name it as given.
  }
  throw new OrgConnectError(
    "production-org-off",
    `Refusing to reach the organization at ${host}: only a test organization is used unless ${ORG_ALLOW_PRODUCTION_ENV}=1 (or allowProductionOrg) is set.`,
  );
}

export interface PersonOrgResolverOptions extends Omit<ConnectOrgOptions, "orgUrl"> {
  /** Where this host keeps an extension the organization delivers as `bundled`. */
  bundled?: (id: string) => string | undefined;
}

/**
 * An ExtensionResolver for onboarding (src/onboarding.ts) that joins the manifest's organization with the person's
 * token and asks it what it admits (orgExtensionResolver). It connects on first use, once per organization URL, so a
 * manifest without an org never needs a token. Register it with `useExtensionResolver(personOrgResolver())`.
 */
export function personOrgResolver(options: PersonOrgResolverOptions = {}): ExtensionResolver {
  const resolvers = new Map<string, Promise<ExtensionResolver>>();
  const forOrg = (org: ManifestOrg): Promise<ExtensionResolver> => {
    let resolver = resolvers.get(org.discovery);
    if (!resolver) {
      resolver = connectOrg({ ...options, orgUrl: org.discovery })
        .then((connection) =>
          orgExtensionResolver({
            client: connection.client,
            accessToken: connection.accessToken,
            ...(options.fetch ? { fetch: options.fetch as typeof globalThis.fetch } : {}),
            ...(options.bundled ? { bundled: options.bundled } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          }),
        )
        .catch((error: unknown) => {
          resolvers.delete(org.discovery);
          if (error instanceof OrgConnectError) throw new OnboardingError(error.code, error.message);
          throw error;
        });
      resolvers.set(org.discovery, resolver);
    }
    return resolver;
  };
  return {
    admitted: async (org) => (await forOrg(org)).admitted(org),
    fetch: async (request) => (await forOrg(request.org)).fetch(request),
  };
}
