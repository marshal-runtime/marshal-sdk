import type Database from "better-sqlite3";

/** One saved change to one of the brand's routines: a note saved for it (routine_overrides) or a new version of its package (extension_versions). */
export interface RoutineChange { routine: string; at: number; lastRunAt?: number }

/** When a routine last started, from the Routines manager's stored rows (null when unknown). */
export type RoutineLastRun = (brandId: string, routineId: string) => number | null;

const hasTable = (db: Database.Database, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

/**
 * The brand's routine changes saved since `since`, oldest first, from the same records the brief build's history reads (brief-question-history.ts): a note
 * saved on a routine and a brand version of a routine package. Only times and routine names, never the note's words (PI01). A missing table is no change.
 * The composer reads them so a scheduled piece is never said to predate a change that was saved before it (Guy's replay, 2026-11-22: the first brief after
 * his saved edit went out as "built before your changes").
 */
export function routineChangesSince(db: Database.Database, brandId: string, since: number, lastRun?: RoutineLastRun): RoutineChange[] {
  const changes: RoutineChange[] = [];
  if (hasTable(db, "routine_overrides")) {
    for (const row of db.prepare("SELECT routine_id, updated_at FROM routine_overrides WHERE brand_id=? AND updated_at>=?").all(brandId, since) as { routine_id: string; updated_at: number }[]) {
      changes.push({ routine: row.routine_id, at: row.updated_at });
    }
  }
  if (hasTable(db, "extension_versions")) {
    // A version counts from when it went live: its activation (the owner's yes to a proposal), else its creation for one written active. A draft or a
    // proposal waiting for a yes is no change yet.
    for (const row of db.prepare("SELECT extension_id, row_json FROM extension_versions WHERE tenant=? AND version>0 AND status IN ('active','retired')").all(brandId) as { extension_id: string; row_json: string }[]) {
      let at = Number.NaN;
      try {
        const version = JSON.parse(row.row_json) as { createdAt?: string; activatedAt?: string };
        at = Date.parse(version.activatedAt ?? version.createdAt ?? "");
      } catch { /* an unreadable row is no change */ }
      if (Number.isFinite(at) && at >= since) changes.push({ routine: row.extension_id, at });
    }
  }
  // Each change carries its routine's last start, so a reply about a brief that ran after the change can say it is the changed one (sim 4, 2026-11-22).
  return changes.sort((a, b) => a.at - b.at).map((change) => {
    const last = lastRun?.(brandId, change.routine) ?? null;
    return last !== null && Number.isFinite(last) ? { ...change, lastRunAt: last } : change;
  });
}
