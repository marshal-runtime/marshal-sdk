import type { Logger } from "../../logger.js";
import type { EventHandler } from "./events.js";
import { assertGraphIngestAllowed, GraphIngestHeldError } from "@zygstinct/brand-brain";
import { outcomeOf, type BrandGraphStates } from "./brand-graph-state.js";

/**
 * Rebuilds a brand's graph and publishes it to the brand repo. The BRAIN lane's `ingestBrand({brandId, deps})` fits behind
 * this: the caller binds `deps` once and passes `({ brandId, signal }) => ingestBrand({ brandId, deps })`.
 */
export type BrandGraphIngest = (input: { brandId: string; signal: AbortSignal }) => Promise<unknown>;

export const BRAND_GRAPH_HANDLER = "brand-graph";

export interface BrandGraphHandlerOptions {
  ingest: BrandGraphIngest;
  logger: Logger;
  /** Which `data.sync.completed` sources start an ingest. Other sources are ignored. */
  sources?: readonly string[];
  /** Records each attempt's outcome and schedules a retry after a failure, so a failed ingest does not die with its spent event id. */
  states?: BrandGraphStates;
  /** Brands with an attempt running (this handler's or the retry worker's), so the two never overlap. */
  running?: Set<string>;
}

/** Ingest failures the state store has recorded (and logged, and scheduled for retry): the event handler does not report them a second time. */
const recordedFailures = new WeakSet<object>();

/** One attempt: runs the ingest, records how it ended, and rethrows a failure. A failure to record is thrown as itself, never marked as recorded. */
async function attempt(options: BrandGraphHandlerOptions, brandId: string, eventId: string | null, signal: AbortSignal): Promise<void> {
  const { states } = options;
  options.running?.add(brandId);
  try {
    let result: unknown;
    try { result = await options.ingest({ brandId, signal }); }
    catch (error) {
      if (states) {
        states.recordFailure(brandId, error, eventId);
        if (typeof error === "object" && error !== null) recordedFailures.add(error);
      }
      throw error;
    }
    states?.recordOutcome(brandId, outcomeOf(result), eventId);
  } finally {
    options.running?.delete(brandId);
  }
}

/**
 * Runs the attempts that are due: a failed ingest (backing off from one minute to one hour) and a first sync that had not produced tables yet.
 * Called on a timer. A brand whose graph is held is skipped without a record; a brand with an attempt already running is left alone.
 */
export async function retryDueBrandGraphs(options: BrandGraphHandlerOptions & { states: BrandGraphStates; timeoutMs: number; brandHeld?: (brandId: string) => boolean; sandboxRunning?: (brandId: string) => Promise<boolean> }): Promise<number> {
  let ran = 0;
  const tried = new Set<string>();
  const run = async (brandId: string, fields: Record<string, unknown>): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref();
    ran += 1;
    tried.add(brandId);
    options.logger.info("brand_graph.retry_started", { brandId, ...fields });
    try { await attempt(options, brandId, null, controller.signal); }
    catch { /* recorded by attempt; the next due time is in the row */ }
    finally { clearTimeout(timer); }
  };
  const allowed = async (brandId: string): Promise<boolean> => {
    try { await assertGraphIngestAllowed(brandId); return true; }
    catch (error) {
      if (error instanceof GraphIngestHeldError) { options.logger.info("brand_graph.ingest_held", { brandId, reason: error.reason, retry: true }); return false; }
      throw error;
    }
  };
  for (const due of options.states.due()) {
    if (options.running?.has(due.brandId) || options.brandHeld?.(due.brandId)) continue;
    if (!(await allowed(due.brandId))) continue;
    await run(due.brandId, { attempts: due.attempts, status: due.status });
  }
  // Repo catch-up (brain worker): a brand whose graph went to Spanner while its sandbox was stopped gets its `brain/` files once the sandbox is up for
  // another reason. The check reads Daytona's state only; it never starts a sandbox. A run that finds it stopped again stays pending.
  if (options.sandboxRunning) {
    for (const pending of options.states.repoPending()) {
      if (tried.has(pending.brandId) || options.running?.has(pending.brandId) || options.brandHeld?.(pending.brandId)) continue;
      // A failed attempt waits for its own retry time (the loop above runs it when due), so a failing catch-up keeps the 1 min to 1 h backoff.
      const state = options.states.get(pending.brandId);
      if (state?.status === "failed" && state.nextAttemptAt !== null) continue;
      let up: boolean;
      try { up = await options.sandboxRunning(pending.brandId); }
      catch (error) { options.logger.warn("brand_graph.repo_catch_up_check_failed", { brandId: pending.brandId, error: error instanceof Error ? error.name : "unknown" }); continue; }
      if (!up || !(await allowed(pending.brandId))) continue;
      await run(pending.brandId, { reason: "repo_catch_up", pendingForMs: Date.now() - pending.since });
    }
  }
  return ran;
}

/**
 * The internal handler for `data.sync.completed`: when a brand's data lands from Airflow, rebuild its graph before the
 * brand's subscribed turns run, so those turns see fresh data. Without a state store a failing ingest throws and the event bus logs it; with one, the state store logs it and schedules the retry.
 */
export function brandGraphHandler(options: BrandGraphHandlerOptions): EventHandler {
  const sources = options.sources ?? ["airflow"];
  return async ({ brandId, eventId, payload, signal }) => {
    const source = String(payload.source);
    if (!sources.includes(source)) {
      options.logger.debug("brand_graph.ignored", { brandId, eventId, source });
      return;
    }
    try { await assertGraphIngestAllowed(brandId); }
    catch (error) {
      if (!(error instanceof GraphIngestHeldError)) throw error;
      options.logger.info("brand_graph.ingest_held", { brandId, eventId, reason: error.reason });
      return;
    }
    const started = Date.now();
    options.logger.info("brand_graph.ingest_started", { brandId, eventId, source });
    try { await attempt(options, brandId, eventId, signal); }
    catch (error) {
      // An ingest failure the state store recorded is already logged (WARN, ERROR once stuck) and queued for retry; rethrowing would log it again at ERROR on
      // every attempt. Anything else (no state store, or recording the failure or the outcome failed) is the handler's failure and is thrown.
      if (typeof error === "object" && error !== null && recordedFailures.has(error)) return;
      throw error;
    }
    options.logger.info("brand_graph.ingest_done", { brandId, eventId, ms: Date.now() - started });
  };
}
