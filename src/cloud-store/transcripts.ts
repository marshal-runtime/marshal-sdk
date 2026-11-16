import { randomUUID } from "node:crypto";

import type { BackendTranscriptStore } from "../session-store.js";
import type { ObjectStore, SqlClient } from "./storage.js";

type Entry = { type: string; uuid?: string; [k: string]: unknown };
type Key = { projectKey: string; sessionId: string; subpath?: string };

export interface CloudTranscriptStoreOptions {
  sql: SqlClient;
  objects: ObjectStore;
  tenant: string;
  /** A batch bigger than this many bytes goes to the object store and the row keeps its key. Default 256 KiB. */
  inlineLimitBytes?: number;
}

/**
 * The Claude Agent SDK's `sessionStore` adapter on Postgres and an object store: the SDK mirrors every transcript
 * batch here while a session runs and, on `resume`, loads the whole transcript back before it starts the backend, on
 * whatever machine that is. Nothing reads or copies Claude Code's own files.
 *
 * `load` is keyed by tenant, session id and subpath only: the project key is the working folder of the machine that
 * wrote it, and a session resumed on a machine with another folder must still find its transcript.
 */
export class CloudTranscriptStore implements BackendTranscriptStore {
  private readonly inlineLimit: number;

  constructor(private readonly options: CloudTranscriptStoreOptions) {
    this.inlineLimit = options.inlineLimitBytes ?? 256 * 1024;
  }

  async append(key: Key, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const json = JSON.stringify(entries);
    const subpath = key.subpath ?? "";
    if (Buffer.byteLength(json) > this.inlineLimit) {
      const object = `${this.options.tenant}/transcripts/${key.sessionId}/${subpath || "main"}/${randomUUID()}.json`;
      await this.options.objects.put(object, json, "application/json");
      await this.options.sql.query(
        `INSERT INTO marshal_transcript_batches (tenant, session_id, subpath, project_key, object) VALUES ($1, $2, $3, $4, $5)`,
        [this.options.tenant, key.sessionId, subpath, key.projectKey, object],
      );
      return;
    }
    await this.options.sql.query(
      `INSERT INTO marshal_transcript_batches (tenant, session_id, subpath, project_key, entries) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [this.options.tenant, key.sessionId, subpath, key.projectKey, json],
    );
  }

  async load(key: Key): Promise<Entry[] | null> {
    const { rows } = await this.options.sql.query(
      `SELECT entries, object FROM marshal_transcript_batches WHERE tenant = $1 AND session_id = $2 AND subpath = $3 ORDER BY seq`,
      [this.options.tenant, key.sessionId, key.subpath ?? ""],
    );
    if (rows.length === 0) return null;
    const seen = new Set<string>();
    const all: Entry[] = [];
    for (const row of rows) {
      let batch: Entry[];
      if (row.object) {
        const bytes = await this.options.objects.get(row.object);
        if (!bytes) throw new Error(`Transcript batch ${row.object} is missing from the object store.`);
        batch = JSON.parse(Buffer.from(bytes).toString("utf8")) as Entry[];
      } else batch = row.entries as Entry[];
      for (const entry of batch) {
        // A retried append can land twice: the entry's uuid is its identity.
        if (entry.uuid) {
          if (seen.has(entry.uuid)) continue;
          seen.add(entry.uuid);
        }
        all.push(entry);
      }
    }
    return all;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const { rows } = await this.options.sql.query(
      `SELECT session_id, floor(extract(epoch FROM max(created_at)) * 1000)::bigint AS mtime
         FROM marshal_transcript_batches WHERE tenant = $1 AND project_key = $2 AND subpath = '' GROUP BY session_id`,
      [this.options.tenant, projectKey],
    );
    return rows.map((row) => ({ sessionId: String(row.session_id), mtime: Number(row.mtime) }));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const { rows } = await this.options.sql.query(
      `SELECT DISTINCT subpath FROM marshal_transcript_batches WHERE tenant = $1 AND session_id = $2 AND subpath <> ''`,
      [this.options.tenant, key.sessionId],
    );
    return rows.map((row) => String(row.subpath));
  }

  async delete(key: Key): Promise<void> {
    const subpath = key.subpath;
    const { rows } = await this.options.sql.query(
      `DELETE FROM marshal_transcript_batches WHERE tenant = $1 AND session_id = $2 ${subpath === undefined ? "" : "AND subpath = $3"} RETURNING object`,
      subpath === undefined ? [this.options.tenant, key.sessionId] : [this.options.tenant, key.sessionId, subpath],
    );
    for (const row of rows) if (row.object) await this.options.objects.delete(row.object);
  }
}
