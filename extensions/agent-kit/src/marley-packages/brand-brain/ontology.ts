/**
 * Entity kinds, edge types and graph record types. Copied from Zyg's Stripes Brand Brain, plus `member`, `collection` and
 * `location` (Shopify catalog kinds Stripes does not have). `segment`, `concept`, `attribution_rule` and `column` match the
 * kinds the live Stripes Brain adds on top of its extension ontology.
 */

export const NODE_KINDS = [
  "brand",
  "member",
  "ad_account",
  "campaign",
  "adset",
  "ad",
  "creative",
  "canonical_creative",
  "product",
  "variant",
  "channel",
  "metric",
  "cohort",
  "landing_page",
  "facet",
  "table",
  "recipe",
  "insight",
  "decision",
  "change",
  "anomaly",
  "outcome",
  "stat_link",
  "connector",
  "experiment",
  "experiment_variant",
  "segment",
  "concept",
  "attribution_rule",
  "column",
  "collection",
  "location",
  "board",
  "work_item",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  "HAS_PRODUCT",
  "HAS_VARIANT",
  "HAS_MEMBER",
  "COMPOSED_OF",
  "RUNS",
  "CONTAINS",
  "USES",
  "INSTANCE_OF",
  "HAS_ANGLE",
  "HAS_HOOK",
  "HAS_PERSONA",
  "HAS_OFFER",
  "FOR_PRODUCT",
  "PROMOTES",
  "LANDS_ON",
  "HAS_SECTION",
  "TESTS",
  "IN_TURBOTEST",
  "TARGETS",
  "BUDGETED_IN",
  "IN_VERTICAL",
  "COMPETES_WITH",
  "DERIVED_FROM",
  "WRITES",
  "DEPENDS_ON",
  "READS",
  "COMPUTES",
  "COMPUTED_BY",
  "FEEDS",
  "CHANGED",
  "INITIATED_BY",
  "ABOUT",
  "RESPONDS_TO",
  "ACTED_ON",
  "ON",
  "IN_WINDOW",
  "RESULTED_IN",
  "COINCIDES_WITH",
  "MOVES_WITH",
  "SHARES_AUDIENCE",
  "BOUGHT_WITH",
  "ACQUIRED",
  "FIRST_PRODUCT",
  "SIMILAR_TO",
  "PEER_OF",
  "APPLIES_TO",
  "SUPERSEDES",
  "CONTRADICTS",
  "COMPUTED_FROM",
  "LIVES_IN",
  "PART_OF",
  "DISTINCT_FROM",
  "CONFLICTS_WITH",
  "ASSIGNED_TO",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const EVIDENCE_STATUSES = ["recorded", "suggested", "accepted"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export type StatisticalLabel = "moves_with" | "coincides_with";
export type PropValue = string | number | boolean | readonly string[];
export type Props = Readonly<Record<string, PropValue>>;

export interface StatisticalEvidence {
  label: StatisticalLabel;
  sample_count: number;
  window_days: number;
  lag_days: number;
  confidence: number;
  null_test: string;
  multiple_testing_correction: string;
  p_value?: number;
}

export interface GraphNode {
  node_id: string;
  kind: NodeKind;
  name: string;
  card_text: string;
  snapshot_at: string;
  source: string;
  props: Props;
}

export interface GraphEdge {
  edge_id: string;
  from: string;
  to: string;
  type: EdgeType;
  status: EvidenceStatus;
  confidence: number;
  source: string;
  recorded_at: string;
  count?: number;
  match_rate?: number;
  stat?: StatisticalEvidence;
}

export interface SourceJob {
  source: string;
  job_id: string;
  estimated_bytes: number;
  bytes_processed: number;
  completed_at: string;
}

export interface JoinMetric {
  join: string;
  matched: number;
  total: number;
  match_rate: number;
}

export interface SkippedSource {
  source: string;
  reason: string;
}

export const SCHEMA_VERSION = 1;

/**
 * Whether the brand has Meta: `bound` by a canonical Meta account binding; `connected` without one, but its own
 * connected Fivetran Meta connection writes `brand_<id>_facebook_ads`; `none` otherwise. Table presence is not Meta
 * presence: dbt publishes the Meta tables for every brand.
 */
export type MetaPresence = "bound" | "connected" | "none";

export interface Manifest {
  schema_version: number;
  brand_id: string;
  brand_name: string;
  version: string;
  built_at: string;
  /** SHA-256 of the nodes and edges without their build timestamps. Equal hashes mean an equal graph. */
  content_hash?: string;
  counts: { nodes: number; edges: number; by_kind: Record<string, number> };
  /** Logical table name to the physical table recipes read, as `project.dataset.table`. */
  tables: Record<string, string>;
  /** Shop settings recipes use: IANA timezone and ISO currency. */
  settings: { timezone: string; currency: string };
  /**
   * The Meta presence the build used. Meta recipes run only when it is `bound` or `connected`. A manifest without it
   * predates the field (before #363). Builds from #355 published Meta tables for conventional brands without a binding,
   * so such a manifest that records the `no canonical Meta binding` skip means no Meta; any other decides by its table
   * map, as before (`metaAvailable` in recipes.ts).
   */
  meta?: MetaPresence;
  source_jobs: SourceJob[];
  join_metrics: JoinMetric[];
  skipped: SkippedSource[];
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Layout of the bundle inside the brand repo. */
export const BRAIN_DIR = "brain";
export const MANIFEST_FILE = `${BRAIN_DIR}/manifest.json`;
export const NODES_FILE = `${BRAIN_DIR}/graph/nodes.jsonl`;
export const EDGES_FILE = `${BRAIN_DIR}/graph/edges.jsonl`;
export const ENTITIES_DIR = `${BRAIN_DIR}/entities`;
