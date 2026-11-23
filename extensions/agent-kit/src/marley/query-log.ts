// Extract of zygstinct apps/agent-server/src/query-log.ts at 7110e58c8: only recordDataQueries.
import type Database from "better-sqlite3";

export interface DataQueryEntry {
  entryId: string;
  at: string;
  engine: "postgres" | "bigquery";
  sqlHash: string;
  sql: string;
  tables: string[];
  durationMs: number;
  rows: number | null;
  bytesProcessed: number | null;
  outcome: "ok" | "error";
  errorClass: string | null;
}

export function recordDataQueries(db: Database.Database, context: { turnId: string; brandId: string; channel: string; conversationId: string }, entries: DataQueryEntry[], now: number = Date.now()): number {
  const insert = db.prepare("INSERT OR IGNORE INTO data_query_log (turn_id, entry_id, brand_id, channel, conversation_id, at, engine, sql_hash, sql_normalized, tables_json, duration_ms, rows, bytes_processed, outcome, error_class, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let written = 0;
  db.transaction(() => {
    for (const entry of entries) written += insert.run(context.turnId, entry.entryId, context.brandId, context.channel, context.conversationId, entry.at, entry.engine, entry.sqlHash, entry.sql, JSON.stringify(entry.tables), entry.durationMs, entry.rows, entry.bytesProcessed, entry.outcome, entry.errorClass, now).changes;
  })();
  return written;
}
