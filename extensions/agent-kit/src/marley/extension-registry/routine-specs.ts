// Extract of zygstinct apps/agent-server/src/extension-registry/routine-specs.ts at 7110e58c8: only RoutineSpecs:declare.
import type Database from "better-sqlite3";
import type { Routine } from "@zygstinct/routines-public";
import { DEFAULT_SPECS, type RoutineSpec } from "./routine-spec-schema.js";

export class SpecConflictError extends Error {}

export interface SpecVersionRow { version: number; author: string; note: string; createdAt: number }

/**
 * A routine's spec as the extension registry holds it. A brand's spec version N is version N of its own copy of the routine's
 * extension (the package carries `marley-routine-spec.json`); the release default (spec version 0) is the release package, so a
 * brand with no copy reads `DEFAULT_SPECS`. Reads are synchronous over the registry's own tables on the server database because prompt
 * composition is synchronous; the async registry API (`resolveRoutine`, `listBindings`) reads the same rows.
 */
export declare class RoutineSpecs {
  private readonly db;
  private readonly now;
  constructor(db: Database.Database, now?: () => number);
  /** The spec version the prompt of the fire at `slot` was composed from, or null when none was recorded (a run from before this record). */
versionUsed(brandId: string, routineId: string, slot: number): number | null;
  defaultSpec(routineId: string): RoutineSpec | null;
  private brandVersion;
  /** The brand's current spec (its newest active version) else the release default; null for an unknown routine. */
loadSpec(brandId: string, routineId: string, version?: number): RoutineSpec | null;
  /** Appends version baseVersion+1 as a new active version of the brand's copy; throws SpecConflictError when the current version is not baseVersion. */
saveSpec(brandId: string, routineId: string, spec: RoutineSpec, author: string, note: string, baseVersion: number): RoutineSpec;
  listVersions(brandId: string, routineId: string): SpecVersionRow[];
  /**
   * The prompt a scheduled run gets: the spec's prompt rendered over the release-built `defaultPrompt` (which already carries the owner's saved-wishes block),
   * after a skills line. A spec whose prompt has no {{default}} still gets the saved-wishes block, so the earlier override feature is never dropped.
   */
compose(routine: Routine, slot: number, defaultPrompt: string, wishes: string): string;
}
