import type { FetchFn, TokenSource } from "../../gcp.js";
import type { MetadataToken } from "./provider.js";

const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * What a brand's sandbox needs the metadata shim to serve: BigQuery, Cloud SQL IAM login, and Cloud Storage reads for `zs.footage.fetch` (the brand
 * account may read only its own footage prefix; without this scope Cloud Storage refuses every fetch whatever IAM says). Read-only: the sandbox
 * writes no object. Spanner stays with the Brain token.
 */
export const METADATA_SCOPES = ["https://www.googleapis.com/auth/bigquery", "https://www.googleapis.com/auth/sqlservice.login", "https://www.googleapis.com/auth/devstorage.read_only"];
const LIFETIME_S = 3600;

/** The brand's own VM service account (`zs-brand-<8 hex>`): the identity its VM's metadata server shows today. */
export const brandAccount = (brandId: string, project: string): string => {
  if (!BRAND_ID.test(brandId)) throw new Error("invalid brand id");
  return `zs-brand-${brandId.slice(0, 8)}@${project}.iam.gserviceaccount.com`;
};

/** Mints the token the sandbox's metadata shim serves for BigQuery and Postgres, from the control plane's own identity (token creator on that account alone). */
export function metadataTokenMinter(tokens: TokenSource, project: string, fetchFn: FetchFn = fetch, now: () => number = Date.now): (brandId: string) => Promise<MetadataToken> {
  return async (brandId) => {
    const email = brandAccount(brandId, project);
    const response = await fetchFn(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokens.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: METADATA_SCOPES, lifetime: `${LIFETIME_S}s` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`generateAccessToken failed: HTTP ${response.status}`);
    const body = (await response.json()) as { accessToken?: unknown; expireTime?: unknown };
    const expiry = typeof body.expireTime === "string" ? Date.parse(body.expireTime) : Number.NaN;
    if (typeof body.accessToken !== "string" || !Number.isFinite(expiry)) throw new Error("generateAccessToken answered without a token");
    return { token: body.accessToken, email, exp: Math.floor(Math.max(expiry, now()) / 1000) };
  };
}

/** Audiences of the two ID tokens a brand VM's root timers fetch from the metadata server: the same strings `zs-embed-token`, `zs-speech-token`, the proxies and `zs-speech.mjs` pin. */
export const ID_TOKEN_AUDIENCE = {
  embed: "https://zs-embed.zyg-ecom-zygstinct.internal",
  speech: "https://zs-speech-xfxeykcwnq-uc.a.run.app",
  /** The vision audience of the embeddings service (`/v1/vision`): distinct from `embed`, because a chat can read this token and must not be able to call `/v1/embed` with it. */
  vision: "https://zs-vision.zyg-ecom-zygstinct.internal",
} as const;
export type IdTokenKind = keyof typeof ID_TOKEN_AUDIENCE;

export interface IdToken {
  token: string;
  /** Epoch seconds, read from the token's own `exp` claim. */
  exp: number;
}

/**
 * Mints an audience-bound ID token of the brand's own VM account (`zs-brand-<8 hex>`) through IAM Credentials `generateIdToken` (the server needs
 * serviceAccountTokenCreator on that account, which it already holds for the metadata token). A Daytona sandbox has no metadata server to ask, so
 * the server asks for it and pushes it. The audience is fixed per kind, never a caller value; the answer must carry that audience, the account's
 * email and a future expiry or it is refused. The token never reaches a log or an error.
 */
export function idTokenMinter(tokens: TokenSource, project: string, fetchFn: FetchFn = fetch, now: () => number = Date.now): (brandId: string, kind: IdTokenKind) => Promise<IdToken> {
  return async (brandId, kind) => {
    const email = brandAccount(brandId, project);
    const audience = ID_TOKEN_AUDIENCE[kind];
    const response = await fetchFn(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateIdToken`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokens.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audience, includeEmail: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`generateIdToken failed: HTTP ${response.status}`);
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string") throw new Error("generateIdToken answered without a token");
    let claims: { aud?: unknown; email?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(body.token.split(".")[1] ?? "", "base64url").toString("utf8"));
    } catch {
      throw new Error("generateIdToken answered with a malformed token");
    }
    if (claims.aud !== audience || claims.email !== email || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()) throw new Error("generateIdToken answered with a token for another identity");
    return { token: body.token, exp: claims.exp };
  };
}
