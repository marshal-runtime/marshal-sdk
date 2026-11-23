import type { BrandContext } from "../directory.js";

/**
 * The provider the daily Amazon ads check (routines/ua-amazon) needs: Amazon Ads. The daily ua-cbo turn runs the check only for it (service.ts
 * amazonConnected), because a Seller connection alone leaves the check waiting for ads data, so this line follows the same rule. A broken connection keeps
 * its synced data, so the check still has findings to tell.
 */
export const AMAZON_PROVIDERS: ReadonlySet<string> = new Set(["amazon_ads"]);

export function hasAmazon(brand: Pick<BrandContext, "connections"> | null): boolean {
  return brand?.connections.some((connection) => AMAZON_PROVIDERS.has(connection.provider) && (connection.status === "connected" || connection.status === "broken")) ?? false;
}

/**
 * The "Amazon ads:" host line: on a turn of a brand with Amazon connected, it tells Marley the daily Amazon ads check exists (the agent server runs it, routines/ua-server), where its findings are (the
 * amazon-insights skill's `latest`, and any money-free amazon_* nodes in the brand's knowledge) and to combine them with the Meta findings and the store data.
 * The skill uses the Amazon analysis only on a turn with this line; who hears which figures is the skill's audience rule, not this line's. It grants nothing:
 * the check only recommends and nothing here can change Amazon. Null for a brand without Amazon, so nothing about Amazon is said there.
 */
export function amazonAdsBlock(brand: BrandContext | null): string | null {
  if (!brand || !hasAmazon(brand)) return null;
  return [
    "Amazon ads: connected. Marley's server runs a daily check that reviews the Amazon ads (bids, search terms, campaign budgets and stock) and keeps its moves; it only recommends and never changes anything in Amazon, and no chat can start it. The brand's knowledge may hold its older money-free moves as amazon_run, amazon_move and amazon_recommendation entries; a hit is only a pointer.",
    "When someone asks about Amazon, or about the ads or the money across channels (Meta and Amazon, where to put the budget, what is working overall), read /opt/zygstinct/experience/skills/amazon-insights/SKILL.md with your file tools and run its `latest` before you answer, and read the Meta findings the Meta insights section names too: combine both with the store data, each with its own data date, and never add up figures of different windows or channels as one. To say which channel returns more, compare both over the same dates and name them, never a 30-day figure against a 14-day one. Do not bring Amazon up when nobody asked about ads or channels.",
  ].join("\n");
}
