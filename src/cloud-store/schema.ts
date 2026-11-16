/**
 * The cloud store's tables. Every row carries the tenant, and every statement filters on it, so one database serves
 * many tenants (Marley: one brand each) without a tenant ever reading another's sessions. All statements are idempotent.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS marshal_sessions (
     tenant text NOT NULL,
     id text NOT NULL,
     record jsonb NOT NULL,
     head_tsv tsvector,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant, id)
   )`,
  `CREATE INDEX IF NOT EXISTS marshal_sessions_head ON marshal_sessions USING gin (head_tsv)`,
  `CREATE INDEX IF NOT EXISTS marshal_sessions_updated ON marshal_sessions (tenant, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS marshal_session_messages (
     tenant text NOT NULL,
     session_id text NOT NULL,
     message_id text NOT NULL,
     seq bigint NOT NULL,
     message jsonb NOT NULL,
     tsv tsvector,
     PRIMARY KEY (tenant, session_id, message_id)
   )`,
  `CREATE INDEX IF NOT EXISTS marshal_session_messages_order ON marshal_session_messages (tenant, session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS marshal_session_messages_tsv ON marshal_session_messages USING gin (tsv)`,
  `CREATE TABLE IF NOT EXISTS marshal_session_events (
     tenant text NOT NULL,
     session_id text NOT NULL,
     seq integer NOT NULL,
     at timestamptz NOT NULL,
     event jsonb NOT NULL,
     PRIMARY KEY (tenant, session_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS marshal_session_todos (
     tenant text NOT NULL,
     session_id text NOT NULL,
     plan jsonb NOT NULL,
     PRIMARY KEY (tenant, session_id)
   )`,
  `CREATE TABLE IF NOT EXISTS marshal_transcript_batches (
     seq bigserial PRIMARY KEY,
     tenant text NOT NULL,
     session_id text NOT NULL,
     subpath text NOT NULL DEFAULT '',
     project_key text NOT NULL,
     entries jsonb,
     object text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS marshal_transcript_batches_session ON marshal_transcript_batches (tenant, session_id, subpath, seq)`,
];

export async function applySchema(sql: { query(text: string): Promise<unknown> }): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement);
}
