// Extract of zygstinct apps/agent-server/src/sandbox/brain-tokens.ts at 7110e58c8: only brainAccount, brainScopesFor, iamTokenMinter, STAGING_BRAIN_SCOPES, MintedToken.
import type { FetchFn, TokenSource } from "../gcp.js";

const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The admin scope is what lets the broker build a newly enrolled brand's tables; the account's IAM role still limits it to its own database.
export const BRAIN_SCOPES = ["https://www.googleapis.com/auth/spanner.data", "https://www.googleapis.com/auth/spanner.admin"];

export const TOKEN_LIFETIME_S = 3600;

/** Staging's token: data only. Without the admin scope no broker, however old, can change the schema of a production database (MLY-412). */
export const STAGING_BRAIN_SCOPES = ["https://www.googleapis.com/auth/spanner.data"];

export const brainScopesFor = (env: "production" | "staging"): readonly string[] => (env === "staging" ? STAGING_BRAIN_SCOPES : BRAIN_SCOPES);

/** The brand's own brain service account (tofu: infra/modules/gcp/brand_brain_spanner): `zs-brain-<first 8 hex of the brand id>`. */
export const brainAccount = (brandId: string, project: string): string => {
  if (!BRAND_ID.test(brandId)) throw new Error("invalid brand id");
  return `zs-brain-${brandId.slice(0, 8)}@${project}.iam.gserviceaccount.com`;
};

export interface MintedToken {
  accessToken: string;
  /** RFC 3339, as IAM Credentials returns it. */
  expireTime: string;
}

/** Mints a short-lived Spanner access token for ONE service account; only the agent servers' accounts may (serviceAccountTokenCreator on that account; staging's only for listed brands). */
export type TokenMinter = (serviceAccount: string) => Promise<MintedToken>;

export function iamTokenMinter(tokens: TokenSource, fetchFn: FetchFn = fetch, scopes: readonly string[] = BRAIN_SCOPES): TokenMinter {
  return async (serviceAccount) => {
    const response = await fetchFn(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:generateAccessToken`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokens.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: scopes, lifetime: `${TOKEN_LIFETIME_S}s` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`generateAccessToken failed: HTTP ${response.status}`);
    const body = (await response.json()) as { accessToken?: unknown; expireTime?: unknown };
    if (typeof body.accessToken !== "string" || typeof body.expireTime !== "string") throw new Error("generateAccessToken answered without a token");
    return { accessToken: body.accessToken, expireTime: body.expireTime };
  };
}
