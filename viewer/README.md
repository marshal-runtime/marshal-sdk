# SDK sessions (`@omer/marshal-sdk-sessions`)

Reads the session stores a headless Marshal host (`marshal-sdk`) writes, and shows them in Marshal:
runs → sessions → transcript, on desktop and phone.

A store is a host's `<state>/sessions` folder: `index.json` (one record per session: title, state, model,
effort, usage, labels, host, run id, parent, native Claude session id) and `<session id>/transcript.jsonl`.

Where it looks: the extension configuration `roots` (store folders, or folders searched a few levels deep
for `index.json`), else `MARSHAL_SDK_SESSION_ROOTS` (colon-separated), else `~/marshal/marshal-sdk/.runs`.
Every read capability also takes `roots` for one call.

| Capability | What it returns |
| --- | --- |
| `sdksessions.runs` | runs found, newest first: host, start, sessions, models, cost |
| `sdksessions.sessions {runId}` | the run's sessions |
| `sdksessions.transcript {sessionId, limit?}` | the session record and its messages |
| `sdksessions.search {query, limit?}` | sessions matching words in title, labels, run id or transcript |
| `sdksessions.open {runId?, sessionId?}` | opens the tab, preselected |

Build: `node build.mjs` (writes `out/package`); test: `node --test out/test/store.test.cjs`.
