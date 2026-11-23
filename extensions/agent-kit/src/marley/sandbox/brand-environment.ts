// Extract of zygstinct apps/agent-server/src/sandbox/brand-environment.ts at 7110e58c8: only BrandNotInEnvironmentError.
/** Thrown before any sandbox call when this environment does not run the brand's runtime (`brandRunsHere`). */
export class BrandNotInEnvironmentError extends Error {
  constructor(readonly brandId: string, readonly environment: string) {
    super(`brand ${brandId} does not run in the ${environment} environment`);
    this.name = "BrandNotInEnvironmentError";
  }
}

export interface BrandRunsHereInput {
  /** The server's sandbox environment (`runtimeEnvironment`). */
  environment: string;
  /** BRAIN_TOKEN_BRANDS: the brands this server holds credentials for. */
  tokenBrands: Readonly<Record<string, unknown>>;
  /** The brand's origin in the shared registry (`sources.brand_origin`), null when it has none; throws when the registry cannot be read. */
  origin(brandId: string): Promise<string | null>;
  now?: () => number;
  /** How long an answer is kept (default 5 minutes); a failed read is never kept. */
  cacheMs?: number;
}

/**
 * Whether this environment runs the brand's sandbox. The staging seed copies production's brands (MLY-412), and every copied brand
 * has a sandbox account staging cannot mint for, so a staging server that ran their background work started a sandbox for each one
 * every few minutes and kept it awake, failing every time on the credential push. Staging therefore runs only a brand it created
 * (origin `staging`) or one it was given credentials for (BRAIN_TOKEN_BRANDS, kept equal to the IAM grants). Production and local
 * stacks run every brand they hold: null. A registry that cannot be read refuses (fail closed) and is asked again next time.
 */
export function brandRunsHere(input: BrandRunsHereInput): ((brandId: string) => Promise<boolean>) | null {
  if (input.environment !== "staging") return null;
  const now = input.now ?? Date.now;
  const cacheMs = input.cacheMs ?? 5 * 60_000;
  const known = new Map<string, { runs: boolean; at: number }>();
  return async (brandId) => {
    if (Object.hasOwn(input.tokenBrands, brandId)) return true;
    const cached = known.get(brandId);
    if (cached && now() - cached.at < cacheMs) return cached.runs;
    const runs = (await input.origin(brandId)) === "staging";
    known.set(brandId, { runs, at: now() });
    return runs;
  };
}
