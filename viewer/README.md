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

## Procedures (Marley)

A service's runs, published as run records by the SDK (`src/run-records.ts`, `docs/run-records.md`), sit in their own
**Procedures** tab, not in the session list: group (Marley) → workflow (`marley-chat`, `marley-task`, `marley-routine`)
→ brand → env (`local`, `staging`, `production`, from the publishing host's `runRecords.env`).

- **Rows only.** Listing reads each run's `summary.json` (ids, labels, status, cost) for the last 7 days (`days`, at most
  31). No transcript is downloaded until a run is opened.
- **Transcript on click, cached.** An opened session lands in the cloud cache (`~/.marshal/cloud-cache/procedure-<source>/<run>/`),
  marked restricted, so `sdksessions.cloudCache {restricted: true}` (sign-out) wipes it and the cache cap evicts least
  recently used files. `servedFrom` (and the tab's line under the title) says whether an open came from the cache.
- **Sources.** Configuration `procedures: [{id: "marley", name, prefix: "marley-", sources: [folder or gs://bucket]}]`,
  else `MARSHAL_SDK_MARLEY_RUNS` (colon-separated; `gs://` keeps its colon), else `~/.marshal/marley-runs` (local Marley:
  dev stack and evals write there with `directoryRunSink`).

| Capability | What it does |
| --- | --- |
| `sdksessions.procedures {procedureId?, workflow?, brand?, env?, days?}` | rows and facets (workflows, brands, envs) |
| `sdksessions.procedureTranscript {source, runId, session}` | one session's messages, fetched or from the cache |
| `sdksessions.openProcedures {workflow?, brand?, env?, runId?}` | opens the tab, preselected |

Production Marley's runs reach Marshal through the org run index (`ws:zygstinct`, `marshal.org.sessions.search`) once its
host publishes to the records bucket; the `label` filter on that index is in review (agent-runtime-org #59).
