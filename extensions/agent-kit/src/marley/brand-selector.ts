import { parseBrandAllowList } from "@zygstinct/shared";

const BRAND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The one environment `*` is accepted in: `DAYTONA_ENV` (required on every deployed server) names it. */
export const EVERY_BRAND_ENVIRONMENT = "staging";

/**
 * Thrown at startup (fail closed, LN03) when an `ORGANISM_*_BRANDS` setting holds `*` anywhere but staging, or `*` beside other entries.
 * Names the setting and the environment, never a value (PI04).
 */
export class EveryBrandRefusedError extends Error {
  constructor(readonly setting: string, readonly environment: string | null, readonly reason: "environment" | "mixed") {
    super(reason === "mixed"
      ? `${setting}: \`*\` stands alone (every brand) or the list holds brand ids, never both`
      : `${setting}: \`*\` (every brand) is accepted only when DAYTONA_ENV is ${EVERY_BRAND_ENVIRONMENT}, this server's is ${environment ?? "not set"}`);
    this.name = "EveryBrandRefusedError";
  }
}

/**
 * The brands of a flag when the value is `*`: every brand, including one that does not exist yet (a fresh staging signup is on from its first sync).
 * It is a ReadonlySet so every `has(brandId)` gate keeps working; a loop over it yields nothing (use `every` to tell it apart), and `size` is 1 so
 * "listed at all" checks see it as on.
 */
export class EveryBrand implements ReadonlySet<string> {
  readonly every = true as const;
  readonly size = 1;
  has(brandId: string): boolean { return BRAND_UUID.test(brandId); }
  forEach(): void { /* no listed ids */ }
  entries(): SetIterator<[string, string]> { return new Set<string>().entries(); }
  keys(): SetIterator<string> { return new Set<string>().keys(); }
  values(): SetIterator<string> { return new Set<string>().values(); }
  [Symbol.iterator](): SetIterator<string> { return new Set<string>().values(); }
}

export const isEveryBrand = (brands: ReadonlySet<string>): brands is EveryBrand => brands instanceof EveryBrand;

/**
 * The brands of one `ORGANISM_*_BRANDS` value: canonical ids as `parseBrandAllowList` reads them (unset, empty or malformed = none), or `*` for every
 * brand, which only a server whose `DAYTONA_ENV` is `staging` accepts. Anything else holding `*` throws, so a production config that asks for it
 * never starts.
 */
export function parseOrganismBrands(setting: string, value: string | undefined, environment: string | null): ReadonlySet<string> {
  const text = value?.trim() ?? "";
  if (!text.includes("*")) return new Set(parseBrandAllowList(value));
  if (text !== "*") throw new EveryBrandRefusedError(setting, environment, "mixed");
  if (environment !== EVERY_BRAND_ENVIRONMENT) throw new EveryBrandRefusedError(setting, environment, "environment");
  return new EveryBrand();
}
