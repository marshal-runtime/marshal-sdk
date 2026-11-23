import type { ConnectionRow } from "./ports.js";

/**
 * The store handle (`mystore`) of `mystore`, `mystore.myshopify.com` or its URL; null for anything else, including a
 * custom domain, which names no store. The same rule as `shopHandle` in @zygstinct/shared, which the portal uses to
 * store a Shopify connection's pin; brand-brain does not depend on that package.
 */
export function shopHandle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 200 || /\s/.test(raw)) return null;
  let host: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) {
    try {
      const url = new URL(raw);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  } else {
    host = raw.split(/[/?#]/)[0] ?? "";
  }
  const match = /^([a-z0-9][a-z0-9-]{0,58}[a-z0-9]|[a-z0-9])(?:\.myshopify\.com)?$/.exec(host);
  return match ? match[1]! : null;
}

export function isSourceSchema(schema: unknown, canonical: string): schema is string {
  if (schema === canonical) return true;
  const prefix = `${canonical}_v_`;
  return typeof schema === "string" && schema.startsWith(prefix) && /^[0-9]{14}_[a-f0-9]{8}$/.test(schema.slice(prefix.length));
}

function inputSchema(row: ConnectionRow, canonical: string): string | null {
  const lifecycle = row.lifecycle;
  if (lifecycle === undefined || lifecycle === null) return row.schema === canonical ? canonical : null;
  if (typeof lifecycle !== "object" || Array.isArray(lifecycle)) return null;
  const generation = lifecycle as Record<string, unknown>;
  if (!Object.hasOwn(generation, "activeSchema") && !Object.hasOwn(generation, "pendingSchema")) return row.schema === canonical ? canonical : null;
  if (Object.hasOwn(generation, "pendingSchema")) {
    if (!isSourceSchema(generation.activeSchema, canonical) || !isSourceSchema(generation.pendingSchema, canonical) ||
        generation.pendingSchema === canonical || generation.activeSchema === generation.pendingSchema ||
        row.schema !== generation.pendingSchema || generation.phase !== "connecting" ||
        typeof generation.at !== "string" || !Number.isFinite(Date.parse(generation.at))) return null;
    return generation.activeSchema;
  }
  if (row.schema === canonical) return generation.activeSchema === canonical ? canonical : null;
  if (generation.phase !== "active" || generation.activeSchema !== row.schema ||
      typeof generation.readyAt !== "string" || !Number.isFinite(Date.parse(generation.readyAt))) return null;
  return isSourceSchema(row.schema, canonical) ? row.schema : null;
}

export function activeSourceSchema(connections: readonly ConnectionRow[], provider: string, canonical: string): string | null {
  const rows = connections.filter(row => row.provider === provider && row.status === "connected" && row.mode === "fivetran");
  if (rows.length !== 1) return null;
  return inputSchema(rows[0]!, canonical);
}

/** The unique connected source whose retained input or promoted writer matches the resolved active source. */
export function owningConnection(connections: readonly ConnectionRow[], provider: string, schema: string): ConnectionRow | null {
  const canonical = schema.replace(/_v_[0-9]{14}_[a-f0-9]{8}$/, "");
  if (activeSourceSchema(connections, provider, canonical) !== schema) return null;
  return connections.find(row => row.provider === provider && row.status === "connected" && row.mode === "fivetran") ?? null;
}

export function sourceRevision(connections: readonly ConnectionRow[]): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
    return value;
  };
  return JSON.stringify(connections.filter(row => row.provider === "shopify" || row.provider === "meta_ads").map(row => stable({
    id: row.id, external_id: row.external_id, provider: row.provider, status: row.status, mode: row.mode,
    schema: row.schema, scope: row.scope, lifecycle: row.lifecycle,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

/**
 * Ownership evidence for a conventional Shopify source (a brand absent from the canonical map). The name
 * `brand_<id>_shopify` alone is not ownership: the brand's connected Fivetran Shopify connection must write that source
 * or its server-promoted generation. When the connection pins a store, the pin must be one well-formed store handle and must match the map's
 * `raw_source_shop_domains` entry for the brand, if there is one. Returns the pinned store handle, or null when the
 * connection pins none, so the caller can also compare it with the shop domain the brand's own dataset names.
 */
export function conventionShopifyOwner(brandId: string, dataset: string, connections: readonly ConnectionRow[], mapShopDomain?: string): { shop: string | null } {
  const row = owningConnection(connections, "shopify", dataset);
  if (!row) throw new Error(`conventional Shopify source of brand ${brandId} has no ownership evidence: no connected Fivetran Shopify connection of this brand writes ${dataset}`);
  if (row.scope === undefined || row.scope === null) return { shop: null };
  const scope = row.scope as { kind?: unknown; values?: unknown };
  const values = typeof scope === "object" && Array.isArray(scope.values) ? scope.values : [];
  const shop = scope.kind === "shop" && values.length === 1 ? shopHandle(values[0]) : null;
  if (!shop) throw new Error(`conventional Shopify source of brand ${brandId}: the Shopify connection's store pin is malformed`);
  if (mapShopDomain !== undefined && shopHandle(mapShopDomain) !== shop) throw new Error(`conventional Shopify source of brand ${brandId}: the pinned store does not match the map's shop domain`);
  return { shop };
}

/** A pinned store must match the shop domain the brand's own `brand_info` names, when that table names one. */
export function assertPinnedShop(brandId: string, pinned: string | null, named: string | null): void {
  if (pinned === null || named === null || named.trim() === "") return;
  if (shopHandle(named) !== pinned) throw new Error(`conventional Shopify source of brand ${brandId}: the pinned store does not match the shop domain in brand_info`);
}
