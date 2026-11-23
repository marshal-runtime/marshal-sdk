// Extract of zygstinct apps/agent-server/src/routines/registry.ts at 7110e58c8: only RoutineRecord, RoutineRegistry:declare, metaAnalysisLive.
import type Database from "better-sqlite3";
import { UA_CBO, type Routine } from "@zygstinct/routines-public";
import { type BrandDirectory } from "../directory.js";
import type { ConversationKey, Store } from "../store.js";
import { RoutineOverrides } from "./overrides.js";
import { RoutineSpecs } from "../extension-registry/routine-specs.js";

export interface RoutineOwner { brandId: string; memberId: string }

export interface RoutineRecord { routine: Routine; memberId: string; target: ConversationKey; createdAt: number; effectiveAt: number }

/**
 * The brand has its Meta analysis switched on: its UA CBO record is enabled and available. One test for every part that follows the analysis: the engine's
 * daily build (an SDK `after` trigger on the analysis), the release default graph (GraphEngine.defaultApplies) and the brief gate. It reads the record, never a
 * server schedule: the analysis is an engine routine and has none.
 */
export function metaAnalysisLive(registry: Pick<RoutineRegistry, "get" | "available">, brandId: string): boolean {
  const meta = registry.get(brandId, UA_CBO);
  return meta?.routine.enabled === true && registry.available(meta.routine, meta.memberId);
}

export declare class RoutineRegistry {
  readonly db: Database.Database;
  /** What owners told Marley about how each system routine should behave; read by every run prompt of the routine. */
readonly overrides: RoutineOverrides;
  /** Versioned routine specs: release defaults plus a brand's append-only edits. */
readonly specs: RoutineSpecs;
  onConfigured?: (record: RoutineRecord) => void;
  private readonly store;
  private readonly directory;
  private readonly now;
  private readonly ownerReportsOn;
  constructor(store: Store, directory: BrandDirectory, now?: () => number, ownerReportsOn?: () => boolean);
  private member;
  /**
   * `maintainer` is for a caller that checked a platform maintainer's own authority (the Routines page, D116, MLY-362): the stored member's
   * checks (an active member, a DM with a host they wrote in) are skipped, so a maintainer can turn on or reschedule a routine whose member or
   * chat fails them. The owner-report recipient rule, availability, cadence and revision checks still apply, and delivery rechecks its own gates.
   */
configure(actor: RoutineOwner, raw: unknown, target: ConversationKey, expectedRevision: number | null, options?: { maintainer?: true }): Promise<Routine>;
  /**
   * Switches a registered routine off for a caller that checked its own authority (the Routines page or chat: any active member or a maintainer, MLY-362, MLY-604).
   * Off only stops runs and sends nothing, so the stored member's checks of `configure` (an active member, a DM with a host they wrote in) do not
   * apply: a routine whose member left or whose chat moved can still be stopped. The record keeps its member and target; turning it on again goes
   * through `configure` and its checks (skipped only for a maintainer).
   */
turnOff(brandId: string, routineId: string, expectedRevision: number): Routine;
  /**
   * Creates an owner-made routine for a caller that already holds a fresh member authorization from the same turn (the spec worker's change set, which checks the live single active-member speaker
   * before it gets here). Same checks and the same write as `configure`, without its directory read, so it can run inside the caller's transaction.
   */
createOwnerRoutine(actor: RoutineOwner, raw: unknown, target: ConversationKey): Routine;
  /** Creates a brand-level routine (ua-cbo, owner-report-daily) that belongs to no member: see brand-run.ts. Never for an owner-made routine. */
enrollBrandRun(brandId: string, raw: unknown, expectedRevision?: number | null): Routine;
  private persist;
  list(actor: RoutineOwner): Promise<Routine[]>;
  /** Every record of the brand, without an authorization check: callers that expose them (the Routines page) check the viewer themselves. */
records(brandId: string): RoutineRecord[];
  /** Deletes an owner-made routine and retires its schedule. Catalog (Marley) routines are never deleted, only switched off. */
remove(brandId: string, routineId: string): boolean;
  get(brandId: string, routineId: string): RoutineRecord | null;
  /**
   * The UA CBO routine is available for every brand (it is the first step of the daily brief graph); `authorized` adds that the record's member is a fresh, active owner.
   * The owner reports are available for every brand while OWNER_REPORTS_ENABLED is on; `authorized` adds that the record's member is the signup owner.
   */
available(routine: Pick<Routine, "origin" | "routineId"> & { brandId?: string }, memberId?: string): boolean;
  authorized(record: RoutineRecord): Promise<boolean>;
}
