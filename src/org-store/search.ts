import type { ObjectStore } from "../object-store.js";
import { scoreSession, searchWords, type TranscriptMessage } from "../session-store.js";
import { INDEX_ROOT, OBJECTS_ROOT } from "./layout.js";
import type { IndexRow } from "./org-store.js";

/** One session the org store holds, as session search returns it. */
export interface OrgSessionHit {
  row: IndexRow;
  snippet: string;
  score: number;
}

export interface OrgSessionSearchOptions {
  objects: ObjectStore;
  /** The org workspace whose sessions are searched: every implementation published under it (Marley, Page Studio runs, ...). */
  workspace: string;
  /** How many of the newest sessions one search reads at most. Default 300. */
  maxSessions?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OrgSessionQuery {
  query: string;
  limit?: number;
  /** ISO times: sessions updated at or after `since`, created at or before `until`. */
  since?: string;
  until?: string;
  /** Exact label matches. */
  labels?: Record<string, string>;
}

/** The root session's directory in the bucket, from its index row. */
export function rowDir(row: IndexRow): string {
  const partition = Object.entries(row.part).map(([key, value]) => `${key}=${value}`);
  return [OBJECTS_ROOT, row.ws, row.impl, ...partition, row.day, row.id].join("/");
}

/**
 * Session search over the org store: every session any host of the workspace published (their index rows and
 * transcripts), ranked with the SDK's own scoring (scoreSession, the same one the local store uses). Transcripts are
 * cached by the row's generation, so a session is read from the bucket once per published version.
 */
export class OrgSessionSearch {
  private readonly cache = new Map<string, { gen: string; messages: TranscriptMessage[] }>();

  constructor(private readonly options: OrgSessionSearchOptions) {}

  /** Every index row of the workspace, newest first (the last row per id wins). */
  async rows(): Promise<IndexRow[]> {
    const { objects, workspace } = this.options;
    const byId = new Map<string, IndexRow>();
    const take = (row: IndexRow) => {
      const current = byId.get(row.id);
      if (!current || current.updatedAt <= row.updatedAt) byId.set(row.id, row);
    };
    for (const info of await objects.listInfo(`${INDEX_ROOT}/${workspace}/`)) {
      const isShard = info.name.endsWith(".jsonl");
      const isRow = info.name.includes("/_rows/") && info.name.endsWith(".json");
      if (!isShard && !isRow) continue;
      const bytes = await objects.get(info.name);
      if (!bytes) continue;
      const text = Buffer.from(bytes).toString("utf8");
      try {
        if (isShard) {
          for (const line of text.split("\n")) if (line) take(JSON.parse(line) as IndexRow);
        } else take(JSON.parse(text) as IndexRow);
      } catch (error) {
        this.options.log?.("org-search.bad_row", { object: info.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The row of one root session, when the org store holds it. */
  async row(sessionId: string): Promise<IndexRow | undefined> {
    return (await this.rows()).find((row) => row.id === sessionId);
  }

  /** Every message of a published root session and its forks, in transcript order per member. */
  async messages(row: IndexRow): Promise<TranscriptMessage[]> {
    const cached = this.cache.get(row.id);
    if (cached && cached.gen === row.gen) return cached.messages;
    const dir = rowDir(row);
    const messages: TranscriptMessage[] = [];
    for (const name of (await this.options.objects.list(`${dir}/transcripts/`)).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const bytes = await this.options.objects.get(name);
      if (!bytes) continue;
      for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as TranscriptMessage);
        } catch {
          // A torn line; the rest of the transcript is still good.
        }
      }
    }
    this.cache.set(row.id, { gen: row.gen, messages });
    return messages;
  }

  async search(query: OrgSessionQuery): Promise<OrgSessionHit[]> {
    const words = searchWords(query.query);
    if (words.length === 0) return [];
    const rows = (await this.rows())
      .filter((row) => !query.since || row.updatedAt >= query.since)
      .filter((row) => !query.until || row.createdAt <= query.until)
      .filter((row) => Object.entries(query.labels ?? {}).every(([key, value]) => row.labels[key] === value))
      .slice(0, this.options.maxSessions ?? 300);
    const hits: OrgSessionHit[] = [];
    for (const row of rows) {
      const scored = scoreSession(words, row.title, Object.values(row.labels), await this.messages(row));
      if (scored) hits.push({ row, ...scored });
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, query.limit ?? 10);
  }
}
