export const UA_CBO = "ua-cbo";
export const UA_CBO_ENABLED = false;
export const UA_CBO_PUBLIC = {
  routineId: UA_CBO, origin: "marley" as const, name: "UA CBO recommendations",
  description: "Campaign, ad set and ad recommendations using Meta, Shopify and Triple Whale evidence. No automatic changes.",
  // Omer, 2026-11-10: every brand's Meta analysis is scheduled at 05:00 (the brief clock), four hours before the 09:00 send.
  cadence: "0 5 * * *",
};
/** Default model for the UA routine through the brand-VM loopback proxy, and the output budget its leaves need. */
export const UA_CBO_MODEL = "claude-sonnet-5-5";
export const UA_CBO_MAX_OUTPUT_TOKENS = 20_000;
export const UA_CBO_DEFINITION = {
  ...UA_CBO_PUBLIC, enabledByDefault: UA_CBO_ENABLED, mode: "recommendation-only" as const,
  requiredSources: ["meta", "metaHistory", "shopify", "tripleWhale"] as const,
  upstreamVersion: "844a971296b973f7770136b4384abf3f21b93a61",
  recipePath: "/opt/zygstinct/current/routines/ua-cbo/run.mjs",
};

/**
 * The Amazon Ads analysis (bids, search terms, campaign budgets and stock; recommendation-only), installed on the brand VM by the image
 * (`routines/ua-amazon`). Not a routine of its own: it is not in ROUTINE_CATALOG and UA_AMAZON_ENABLED stays false, so nothing lists it or gives it a
 * schedule or owner setting. The daily ua-cbo turn runs it (`zs.amazon.run`) for a brand with Amazon Ads, the "Amazon ads:" host line points chat at its
 * skill (apps/agent-server/src/prompt-layers/amazon-insights.ts), and knowledge search reads its `ua-amazon` corpus slot.
 */
export const UA_AMAZON = "ua-amazon";
export const UA_AMAZON_ENABLED = false;
export const UA_AMAZON_MODEL = "claude-sonnet-5-5";
export const UA_AMAZON_DEFINITION = {
  routineId: UA_AMAZON, origin: "marley" as const, name: "Amazon ads recommendations",
  description: "Keyword and product-target bids, search terms to harvest or block, and campaign budget and stock moves for Amazon Sponsored Products. No automatic changes.",
  enabledByDefault: UA_AMAZON_ENABLED, mode: "recommendation-only" as const,
  requiredSources: ["amazonAds"] as const,
  recipePath: "/opt/zygstinct/current/routines/ua-amazon/run.mjs",
};

/** The recipe the server runs on the brand's own VM; it keeps its state in the owner chat's private home. */
export const STORE_WATCH_RECIPE = "/opt/zygstinct/current/routines/store-watch/run.mjs";

/** The owner report: every brand's signup owner gets the daily morning brief in their own existing DM, at 09:00 in the owner's own time zone (brand_members.timezone), else the shop's. */
export const OWNER_REPORT_DAILY = "owner-report-daily";
/**
 * Routine ids that no longer exist. Stored records of them are deleted at startup (routines/registry.ts), never parsed: the monthly owner report was
 * removed completely (Omer R149, 2026-11-18).
 */
export const RETIRED_ROUTINES: readonly string[] = ["owner-report-monthly"];
export const OWNER_REPORT_DAILY_PUBLIC = {
  routineId: OWNER_REPORT_DAILY, origin: "marley" as const, name: "Daily morning brief",
  description: "A short video with Marley's voice: yesterday's sales by source and the Meta ads review, sent with the message \"Here is your morning brief\". Falls back to the text report when no video can be made.", cadence: "0 9 * * *",
};
export const OWNER_REPORTS = [OWNER_REPORT_DAILY_PUBLIC] as const;
export const isOwnerReport = (routineId: string): boolean => routineId === OWNER_REPORT_DAILY;

export const ROUTINE_CATALOG = { [UA_CBO]: UA_CBO_PUBLIC,
  [OWNER_REPORT_DAILY]: OWNER_REPORT_DAILY_PUBLIC };

export function catalogRoutine(id: string) {
  return Object.hasOwn(ROUTINE_CATALOG, id) ? ROUTINE_CATALOG[id as keyof typeof ROUTINE_CATALOG] : undefined;
}
