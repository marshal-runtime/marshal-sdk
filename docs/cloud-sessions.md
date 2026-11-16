# Cloud sessions: one store for every host of a tenant

An SDK host keeps its sessions in a `SessionStore`. The default is `FileSessionStore` (a folder; one machine). A service
whose sessions must outlive its machines, be searched, and be resumed anywhere uses `CloudSessionStore`:

```ts
const sql = new pg.Pool({ connectionString });                       // anything with query(text, params)
const objects = gcsObjectStore({ bucket, accessToken });             // or fsObjectStore(dir), or your own ObjectStore
const store = await CloudSessionStore.open({ sql, objects, tenant: brandId, origin: { runId, host } });
const host = await startHost({ ..., sessionStore: () => store });
```

- **Tenant.** Every row and every query carries the tenant. A store opened for tenant A cannot read tenant B's records,
  transcripts or search hits (tested). One database serves many tenants.
- **What is stored where.** Postgres: session records (labels, usage, state), messages, events, plans, transcript
  batches. Object store: artifacts (`putArtifact`) and transcript batches over `inlineLimitBytes`.
- **Writes** land in memory at once and go to Postgres in ordered, idempotent batches. The port calls `flush()` before a
  session reads as idle or failed, so an idle session is durable. A failed write is kept and retried by the next flush.
- **Reads** are synchronous from memory. `open` loads every record of the tenant; `hydrate(id)` (called by the port before
  a turn) loads a session's messages and events, so a session started on another machine continues with its history.
- **Transcript custody.** The store exposes `transcripts`, a `CloudTranscriptStore` implementing the Claude Agent SDK's
  `sessionStore`. The port passes it to every Claude turn: the Agent SDK mirrors each transcript batch to it while the
  turn runs and, when a session resumes, loads the transcript from it before the backend starts. Nothing reads or copies
  Claude Code's own files. `load` ignores the project key (the working folder of the writing machine), so a session
  resumes on a machine with another folder.
  - The Agent SDK restores into a temporary `CLAUDE_CONFIG_DIR` on the machine that runs `query`. A host whose
    `spawnClaudeCodeProcess` runs Claude Code on another machine must make that directory exist there (it is passed in
    the spawn options' `env.CLAUDE_CONFIG_DIR`).
  - A session that has Claude Code history on disk but none in the store is moved with the Agent SDK's
    `importSessionToStore(sessionId, store.transcripts)`.
- **Search.** `store.search(query, limit)` is a Postgres full-text search (title, labels, message text) with a snippet.
  `rerank` is the hook for semantic ordering: it receives up to 5x the limit of lexical candidates. `sessions.search`
  uses it.
- **Knowledge.** `kit.knowledge: { provider, scope }` (part `knowledge`) serves `knowledge.search` / `knowledge.context`
  from a `KnowledgeProvider` in a scope the host fixes (`tenant`, optional `viewer`); the capabilities take no tenant
  field, so a session cannot read another tenant. The team Brain is one binding (`brainKnowledgeProvider`); a service's own
  corpus is another. Not combinable with the Brain parts, which install their own `knowledge.*`.
