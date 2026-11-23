import type { SourceJob } from "../ontology.js";

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  job: SourceJob;
}

/** Reads from the warehouse. Tests fake it. */
export interface WarehousePort {
  /** Runs one SELECT. Throws when the statement is not a SELECT or would scan more than the cap. */
  query(name: string, sql: string): Promise<QueryResult>;
}

export interface MemberRow {
  id: string;
  display_name: string;
  phone_e164: string | null;
  /** `pending`, `active` or `disabled`. Absent before WEB's migration 0007. */
  status?: string | null;
  email: string | null;
  /** True for the person who signed the brand up (brands.owner_user_id). Their only difference is who gets the signup greeting and owner reports; their access is every member's. Absent on an older read. */
  signup_owner?: boolean;
  created_at: string | null;
}

export interface ConnectionRow {
  id?: string;
  external_id?: string | null;
  provider: string;
  status: string;
  mode: string | null;
  connected_at: string | null;
  last_checked_at: string | null;
  /** `metadata.fivetran.schema`: the dataset the connection writes. Ownership evidence only; never enters the graph. */
  schema?: string | null;
  /** `metadata.fivetran.scope` as stored (`{kind, values, state}`), unvalidated. Ownership evidence only. */
  scope?: unknown;
  /** Server-owned source generation, promoted only after the pinned first historical sync. */
  lifecycle?: unknown;
}

export interface BrandRow {
  id: string;
  name: string;
  website_url: string | null;
}

/** One tag the brand's latest finished storefront scan saw (pixel_audit_reports), reduced to what the tracking setup card says. */
export interface StorefrontTag {
  vendor: string;
  /** The Shopify app pixel's name as the scan read it; untrusted shop text, cleaned by the reader. */
  appName: string | null;
  fired: boolean;
}

export interface StorefrontScan {
  /** When the scan ran (the report's generatedAt), `YYYY-MM-DD`. */
  scannedOn: string;
  tags: StorefrontTag[];
  /** Tags counted but not listed: the report's own left-out ones, the "N other" app pixels it grouped, and entries the card cannot list. */
  omitted: number;
}

/**
 * The storefront scan read for the tracking setup card: `found` (a finished scan of the brand's own website host), `none` (no such
 * scan) or `unavailable` (the read failed: the card says so, the ingest logs and records `code` and goes on; a scan is
 * descriptive, never a gate). `code` is a SQLSTATE, `query_failed` (the query function answered null) or `error`.
 */
export type StorefrontScanRead = { state: "found"; scan: StorefrontScan } | { state: "none" } | { state: "unavailable"; code: string };

/** Reads the brand's control data from Cloud SQL (read only). */
export interface DirectoryPort {
  brand(brandId: string): Promise<BrandRow | null>;
  members(brandId: string): Promise<MemberRow[]>;
  connections(brandId: string): Promise<ConnectionRow[]>;
  /**
   * The latest pixel audit whose storefront scan finished on the brand's own website host (`websiteUrl`, from `brand`). Never
   * throws: a failed read is `unavailable`. Optional: a directory without it gives the setup card no tag list.
   */
  storefrontScan?(brandId: string, websiteUrl: string | null): Promise<StorefrontScanRead>;
}
