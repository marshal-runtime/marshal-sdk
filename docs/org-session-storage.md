# Org session storage

A host publishes its sessions to one bucket for the whole Zyg org, and keeps the backend's transcripts there, so a session resumes on
any machine and anyone in the org can read and pull it. GCS is the only store of record; there is no database.

```ts
const objects = gcsObjectStore({ bucket: "zyg-agents-records", accessToken });   // or fsObjectStore(dir) locally
const host = await startHost({
  ...,
  orgStore: {
    objects,
    impl: { v: 1, workspace: "zygstinct", impl: "marley", partition: ["env", "brand"], fields: { procedure: { from: "label", filter: true } } },
    isCurrent: (nativeSessionId) => thisMachineHasIt(nativeSessionId),
  },
});
```

A host that only reads the store (it publishes its own sessions elsewhere, or another host of the same process publishes them) passes
`orgSearch: { objects, workspace }` instead: searchSessions and getSessionTranscript then read the workspace's published sessions too,
bounded by `sessionScopeLabel` like every other session. `orgStore` takes precedence when both are set.

## Layout (the contract readers rely on)

```
sdk/v1/<workspace>/<impl>/_impl.json                      the declaration (written once, create-only)
sdk/v1/<workspace>/<impl>/<k=v>/…/<day>/<root session>/
    session.json                                          row + member list; written LAST: the commit marker
    transcripts/<member>.jsonl                            Marshal messages, one session per file
    native/<native session>.jsonl                         the backend's transcript (composed at idle)
    native/<native session>/<subpath>.jsonl               sub-agent transcripts
    native/_batches/<member>/<time>-<n>-<uuid>.jsonl      create-only batches the Agent SDK mirrors while a turn runs
sdk-index/v1/<workspace>/<impl>/<k=v>/…/<day>.jsonl       index shard: one JSON row per root session, last row per id wins
sdk-index/v1/<workspace>/<impl>/<k=v>/…/<day>/_rows/<root>.json   the writer's own row; folded into the shard
```

- `<day>` is the root session's creation day (UTC), so a path never moves. `<k=v>` are the implementation's declared partition labels, ids only.
- A session whose partition labels are missing or not id-shaped is not published.
- A row holds ids, labels, counts, state, usage and the generation of `session.json`; never message text.

## Writes

- One writer per session. It writes transcripts, then `session.json`, then its row object, then folds the day's rows into the shard with
  `ifGenerationMatch` (a lost race retries). Nothing is ever appended; no object is shared by writers.
- Publishing starts after a session goes idle or fails, on a timer (`publishDelayMs`, 1 s), and never inside a turn.
- Native transcript batches are create-only objects; compose (server-side) folds them into one file after idle.

## Resume without cloud reads

The port gives the Agent SDK a store bound to the Marshal session. With `isCurrent(nativeSessionId)` true, `load` answers null and the Agent SDK
restores nothing and reads nothing: a warm machine resumes with zero cloud requests. A cold machine (new or rebuilt VM, a desktop opening the
session) loads the composed file plus any batches after it.

## Reading

`listIndex({ objects, impl, partition?, from?, to?, where? })` lists rows newest first from shards plus unfolded row objects. It filters; it does not
rank. Text search over pulled sessions belongs to the reader's own engine.
