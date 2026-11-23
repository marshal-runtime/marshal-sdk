const METADATA = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_HEADERS = { "Metadata-Flavor": "Google" };

export type FetchFn = typeof fetch;

/** Reads a metadata-server path; null when there is no metadata server (local dev). */
export async function metadataGet(path: string, fetchFn: FetchFn = fetch): Promise<string | null> {
  try {
    const response = await fetchFn(`${METADATA}/${path}`, {
      headers: METADATA_HEADERS,
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
}

/** The config attributes of this VM; missing attributes are null (local development has no metadata server). */
export async function configFromMetadata(fetchFn: FetchFn = fetch): Promise<{ gatewayUrl: string | null; pgHost: string | null; project: string | null }> {
  const [gatewayUrl, pgHost, project] = await Promise.all(
    ["gateway_url", "pg_host", "gcp_project"].map((name) => metadataGet(`instance/attributes/${name}`, fetchFn)),
  );
  return { gatewayUrl: gatewayUrl ?? null, pgHost: pgHost ?? null, project: project ?? null };
}

export interface TokenSource {
  accessToken(): Promise<string>;
  /** An ID token for the audience that stays valid for at least `minValidMs` (default two minutes). */
  idToken(audience: string, minValidMs?: number): Promise<string>;
}

interface Cached {
  value: string;
  expiresAt: number;
}

/** Tokens for the VM service account from the metadata server, cached until shortly before expiry. */
export function metadataTokens(fetchFn: FetchFn = fetch, now: () => number = Date.now): TokenSource {
  let access: Cached | null = null;
  const ids = new Map<string, Cached>();
  return {
    async accessToken() {
      if (access && access.expiresAt - 60_000 > now()) return access.value;
      const response = await fetchFn(`${METADATA}/instance/service-accounts/default/token`, {
        headers: METADATA_HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`metadata access token failed: ${response.status}`);
      const body = (await response.json()) as { access_token: string; expires_in: number };
      access = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 };
      return access.value;
    },
    async idToken(audience, minValidMs = 120_000) {
      const cached = ids.get(audience);
      if (cached && cached.expiresAt - minValidMs > now()) return cached.value;
      const url = `${METADATA}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
      const response = await fetchFn(url, { headers: METADATA_HEADERS, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`metadata id token failed: ${response.status}`);
      const token = (await response.text()).trim();
      ids.set(audience, { value: token, expiresAt: jwtExpiry(token) ?? now() + 30 * 60_000 });
      return token;
    },
  };
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A secret read the API refused; the status tells a revoked or disabled secret (400, 403) from a transient failure (5xx, timeout). */
export class SecretAccessError extends Error {
  constructor(name: string, readonly status: number) { super(`secret ${name}: HTTP ${status}`); this.name = "SecretAccessError"; }
}

export interface SecretProvider {
  /** The latest version of a secret as text; null when the secret or its value does not exist. */
  get(name: string): Promise<string | null>;
  /** The latest version with its immutable, ever-growing Secret Manager version number; null when there is none. */
  latest?(name: string): Promise<{ value: string; version: number } | null>;
}

/** Secret Manager over REST with the VM service account. */
export function secretManager(project: string, tokens: TokenSource, fetchFn: FetchFn = fetch): SecretProvider {
  const access = async (name: string): Promise<{ value: string; version: number } | null> => {
    const token = await tokens.accessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`;
    const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new SecretAccessError(name, response.status);
    const body = (await response.json()) as { name?: string; payload?: { data?: string } };
    if (!body.payload?.data) return null;
    // "projects/<n>/secrets/<name>/versions/<version>": the number is assigned once and only grows.
    const version = Number(/\/versions\/([1-9][0-9]*)$/.exec(body.name ?? "")?.[1] ?? 0);
    return { value: Buffer.from(body.payload.data, "base64").toString("utf8"), version };
  };
  return {
    async get(name) {
      return (await access(name))?.value ?? null;
    },
    latest: access,
  };
}

/** A secret provider that reads ZS_SECRET_<NAME> env vars, for local development and tests. */
export function envSecrets(env: Record<string, string | undefined> = process.env): SecretProvider {
  return {
    async get(name) {
      return env[`ZS_SECRET_${name.toUpperCase().replace(/-/g, "_")}`] ?? null;
    },
  };
}
