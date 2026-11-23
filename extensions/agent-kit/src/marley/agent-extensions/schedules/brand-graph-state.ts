import type Database from "better-sqlite3";

import type { Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";

/**
 * Where a brand's graph stands. One row per brand, written by every ingest attempt (the event handler and the retry worker).
 *
 * - `published`: the last attempt built the graph and published it.
 * - `no_data`: the brand has no warehouse data to build from yet (`reason`). Not an error, and not "empty and green": nothing was published.
 * - `failed`: the last attempt threw. `attempts` counts the failures in a row and `nextAttemptAt` is when the worker tries again; the brand's
 *   previous graph (if any) is still what chat reads.
 */
export type BrandGraphStatus = "published" | "no_data" | "failed";

export const BRAND_GRAPH_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS brand_graph_state (
  brand_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_event_id TEXT,
  last_attempt_at INTEGER NOT NULL,
  last_success_at INTEGER,
  failing_since INTEGER,
  next_attempt_at INTEGER,
  nodes INTEGER,
  edges INTEGER,
  dropped_edges INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brand_graph_repo_pending (
  brand_id TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);
`;

export interface BrandGraphState {
  brandId: string;
  status: BrandGraphStatus;
  reason: string | null;
  attempts: number;
  lastError: string | null;
  lastEventId: string | null;
  lastAttemptAt: number;
  lastSuccessAt: number | null;
  failingSince: number | null;
  nextAttemptAt: number | null;
  nodes: number | null;
  edges: number | null;
  droppedEdges: number;
}

interface Row {
  brand_id: string;
  status: BrandGraphStatus;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  last_event_id: string | null;
  last_attempt_at: number;
  last_success_at: number | null;
  failing_since: number | null;
  next_attempt_at: number | null;
  nodes: number | null;
  edges: number | null;
  dropped_edges: number;
}

const toState = (row: Row): BrandGraphState => ({
  brandId: row.brand_id,
  status: row.status,
  reason: row.reason,
  attempts: row.attempts,
  lastError: row.last_error,
  lastEventId: row.last_event_id,
  lastAttemptAt: row.last_attempt_at,
  lastSuccessAt: row.last_success_at,
  failingSince: row.failing_since,
  nextAttemptAt: row.next_attempt_at,
  nodes: row.nodes,
  edges: row.edges,
  droppedEdges: row.dropped_edges,
});

/** First retry after one minute, doubling to one hour. */
export const retryDelayMs = (attempts: number): number => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
/** A first sync that has not produced tables yet is checked again after this long. */
export const FIRST_SYNC_RECHECK_MS = 30 * 60_000;
/** A brand failing this long (or this many times in a row) is reported as stuck, every attempt, at error level. */
export const STUCK_AFTER_MS = 30 * 60_000;
export const STUCK_AFTER_ATTEMPTS = 3;

export interface IngestOutcome {
  state: "published" | "no_data";
  reason?: string;
  nodes?: number;
  edges?: number;
  droppedEdges?: number;
  /** The brain worker published to Spanner without the sandbox; the repo's `brain/` files wait for a run that finds the sandbox up. */
  repoPending?: boolean;
}

/** Reads what an ingest returned. A result that says nothing (an older or a fake ingest) counts as published. */
export function outcomeOf(result: unknown): IngestOutcome {
  const value = (result ?? {}) as { state?: unknown; reason?: unknown; counts?: { nodes?: unknown; edges?: unknown }; droppedEdges?: { total?: unknown }; repoPending?: unknown };
  const count = (field: unknown): number | undefined => (typeof field === "number" && Number.isFinite(field) ? field : undefined);
  return {
    state: value.state === "no_data" ? "no_data" : "published",
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    nodes: count(value.counts?.nodes),
    edges: count(value.counts?.edges),
    droppedEdges: count(value.droppedEdges?.total),
    ...(value.repoPending === true ? { repoPending: true } : {}),
  };
}

export class BrandGraphStates {
  constructor(private readonly db: Database.Database, private readonly logger: Logger, private readonly now: () => number = Date.now) {}

  get(brandId: string): BrandGraphState | null {
    const row = this.db.prepare("SELECT * FROM brand_graph_state WHERE brand_id = ?").get(brandId) as Row | undefined;
    return row ? toState(row) : null;
  }

  /** Brands whose graph the brain worker published while their sandbox was stopped, oldest first: the repo files catch up on a run that finds the sandbox up. */
  repoPending(): { brandId: string; since: number }[] {
    return (this.db.prepare("SELECT brand_id, since FROM brand_graph_repo_pending ORDER BY since, brand_id").all() as { brand_id: string; since: number }[]).map((row) => ({ brandId: row.brand_id, since: row.since }));
  }
  list(): BrandGraphState[] {
    return (this.db.prepare("SELECT * FROM brand_graph_state ORDER BY brand_id").all() as Row[]).map(toState);
  }

  /** The ingest ran to its end. A `published` result clears the failure; `no_data` is its own state, and a first sync still pending is rechecked slowly. */
  recordOutcome(brandId: string, outcome: IngestOutcome, eventId: string | null): void {
    const at = this.now();
    const previous = this.get(brandId);
    const published = outcome.state === "published";
    const recheck = !published && outcome.reason === "first_sync_pending" ? at + FIRST_SYNC_RECHECK_MS : null;
    this.db
      .prepare(
        `INSERT INTO brand_graph_state (brand_id, status, reason, attempts, last_error, last_event_id, last_attempt_at, last_success_at, failing_since, next_attempt_at, nodes, edges, dropped_edges, updated_at)
         VALUES (?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(brand_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, attempts = 0, last_error = NULL, last_event_id = COALESCE(excluded.last_event_id, last_event_id),
           last_attempt_at = excluded.last_attempt_at, last_success_at = COALESCE(excluded.last_success_at, last_success_at), failing_since = NULL, next_attempt_at = excluded.next_attempt_at,
           nodes = COALESCE(excluded.nodes, nodes), edges = COALESCE(excluded.edges, edges), dropped_edges = excluded.dropped_edges, updated_at = excluded.updated_at`,
      )
      .run(brandId, outcome.state, outcome.reason ?? null, eventId, at, published ? at : null, recheck, outcome.nodes ?? null, outcome.edges ?? null, outcome.droppedEdges ?? 0, at);
    if (published && outcome.repoPending) this.db.prepare("INSERT INTO brand_graph_repo_pending (brand_id, since) VALUES (?, ?) ON CONFLICT(brand_id) DO NOTHING").run(brandId, at);
    else if (published) this.db.prepare("DELETE FROM brand_graph_repo_pending WHERE brand_id = ?").run(brandId);
    if (previous?.status === "failed") this.logger.info("brand_graph.recovered", { brandId, after: previous.attempts, failingForMs: previous.failingSince === null ? null : at - previous.failingSince });
    if (!published) this.logger.info("brand_graph.no_data", { brandId, reason: outcome.reason ?? null });
    if (published && (outcome.droppedEdges ?? 0) > 0) this.logger.warn("brand_graph.edges_dropped", { brandId, dropped: outcome.droppedEdges });
  }

  /** The ingest threw. The event is not lost: the row schedules the next attempt. */
  recordFailure(brandId: string, error: unknown, eventId: string | null): BrandGraphState {
    const at = this.now();
    const previous = this.get(brandId);
    const attempts = previous?.status === "failed" ? previous.attempts + 1 : 1;
    const failingSince = previous?.status === "failed" && previous.failingSince !== null ? previous.failingSince : at;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.db
      .prepare(
        `INSERT INTO brand_graph_state (brand_id, status, reason, attempts, last_error, last_event_id, last_attempt_at, failing_since, next_attempt_at, updated_at)
         VALUES (?, 'failed', NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(brand_id) DO UPDATE SET status = 'failed', reason = NULL, attempts = excluded.attempts, last_error = excluded.last_error, last_event_id = COALESCE(excluded.last_event_id, last_event_id),
           last_attempt_at = excluded.last_attempt_at, failing_since = excluded.failing_since, next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
      )
      .run(brandId, attempts, message, eventId, at, failingSince, at + retryDelayMs(attempts), at);
    const state = this.get(brandId)!;
    const stuck = this.isStuck(state, at);
    this.logger[stuck ? "error" : "warn"](stuck ? "brand_graph.ingest_stuck" : "brand_graph.ingest_failed", { brandId, attempts, failingForMs: at - failingSince, nextAttemptAt: new Date(state.nextAttemptAt!).toISOString(), ...failureFields(error) });
    return state;
  }

  isStuck(state: BrandGraphState, at = this.now()): boolean {
    return state.status === "failed" && (state.attempts >= STUCK_AFTER_ATTEMPTS || (state.failingSince !== null && at - state.failingSince >= STUCK_AFTER_MS));
  }

  /** Brands whose next attempt is due. */
  due(): BrandGraphState[] {
    return (this.db.prepare("SELECT * FROM brand_graph_state WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at").all(this.now()) as Row[]).map(toState);
  }

  /** What the health file reports: counts and the brands that need attention (failed or stuck), never an error body. */
  summary(): { published: number; noData: number; failed: number; stuck: number; attention: { brandId: string; status: BrandGraphStatus; attempts: number; stuck: boolean }[]; repoPending: { count: number; oldestHours: number | null } } {
    const states = this.list();
    const at = this.now();
    const pending = this.repoPending();
    const attention = states.filter((state) => state.status === "failed").map((state) => ({ brandId: state.brandId, status: state.status, attempts: state.attempts, stuck: this.isStuck(state, at) }));
    return {
      published: states.filter((state) => state.status === "published").length,
      noData: states.filter((state) => state.status === "no_data").length,
      failed: attention.length,
      stuck: attention.filter((entry) => entry.stuck).length,
      attention,
      // Brands the brain worker published while their sandbox was stopped: repo files and the graph comparison wait for the sandbox to be up.
      repoPending: { count: pending.length, oldestHours: pending.length === 0 ? null : Math.round(((at - pending[0]!.since) / 3_600_000) * 10) / 10 },
    };
  }
}
