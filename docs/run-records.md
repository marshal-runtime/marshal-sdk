# Run records: a service host's sessions as org runs

A host that runs for a service rather than a person (Marley's agent server, a CI job) can't publish org sessions:
`putSession` is accepted only from the session's owner (docs/org-bridge.md, "The identity it needs"). It can still
reach Marshal through the organization's **run index**. The index is built by the org gateway (zyg-agents
`src/shared/org-runs`, docs/org-run-index.md there) from run records in the records bucket. Marshal lists those runs by
workspace and workflow, rows only, and fetches a transcript only when someone opens it (`marshal.org.sessions.search`,
the desktop's session audit).

`src/run-records.ts` writes a host's sessions in that format:

```
runs/<day>-<workflow>-<12 hex>/
  summary.json             the index row: workflow, title, status, cost, links, sessions, counts (written last)
  record.jsonl             run_started, session_started {task}, session_finished {output}, run_finished
  sessions/<role>-<id>.jsonl         the session's SDK message stream (user and assistant lines), scrubbed
  sessions/<role>-<id>.claude.jsonl  the native Claude transcript, only with envelopes: true
```

```ts
const host = await createMarshalHost({
  …,
  runRecords: {
    env: "production",                                      // local | staging | production, from the host's config
    sink: gcsRunSink({ bucket: "<records bucket>", accessToken: () => workloadToken() }),
    allow: (root) => TEST_BRANDS.has(root.labels.brand),   // default: nothing leaves the host
  },
});
host.agents.launch({ task, idempotencyKey, labels: { procedure: "marley-chat", brand, conversation, channel: "whatsapp", kind: "dm", role: "front" } });
```

## The grouping

**Workspace → procedure → run → sessions.**

- **Procedure.** The workflow is the root session's `procedure` (or `workflow`) label, for example `marley-chat`,
  `marley-task` or `marley-routine`.
- **Workspace.** It is decided by the server, never the host. The workspace manifests map workflow names to a
  workspace: zyg-agents `workspaces/zygstinct.yaml` lists `marley-*` under `engine.workflows`, so these runs land in
  `ws:zygstinct`.
- **Run.** A run is one root session (a session without a parent) together with its forks. A fork going idle
  republishes its root's whole run. The run id starts with the day the root started, because the sweeper lists runs by
  that day. It is stable, so every publish overwrites the same objects.
- **Brand.** It is a `chat` link `<brand>:<conversation>`.
- **Labels.** `summary.labels` carries `procedure`, `env`, `brand`, `conversation`, `channel` and `kind` (ids and keys
  only, each matching `[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`). `env` comes from the host's `runRecords.env`, never from a
  session label, so local, staging and production runs of one procedure can be told apart.
- **No message text in a row.** The title is built from those ids (`marley-chat · <brand> · <conversation> · dm · production`);
  the record holds ids, states and times; an error is `failed`. The index builds its row and search text from the title,
  the error, the first task and the last answer, so a row says nothing beyond its labels. Message text is only in the
  session stream, fetched when someone opens the run.
- **Requester.** It is the `requester` label when there is one. A run without one is read only by the workspace's
  auditors.
- **Custom grouping.** `labelRunGrouping()` is the default. A host can pass its own `grouping(root)`.

Who may read a run is the workspace's rule on the server (its `access.auditors` and `boundary`), not the host's.

## When it publishes

- **On idle or failure.** It publishes on `session.idle` and `session.failed`.
- **One upload per run at a time.** A turn that ends during an upload queues exactly one more (the kit's
  `SessionPublisher`).
- **Failures.** They are logged ("publishing session … to the run records failed") and never thrown.
- **On dispose.** `dispose()` flushes.
- **Allow list.** `allow(root)` is required in practice: without it nothing is published.
- **Scrubbing.** Every string goes through the desktop's sanitizer (`scrubText`: secrets, the session's working folder
  and the home folder) before it leaves.

## Sinks

- `directoryRunSink(root)`: a folder laid out like the bucket. Used by tests and local proofs.
- `gcsRunSink({bucket, accessToken})`: Cloud Storage's JSON API with the host's own token. The token is never logged.

## Not done here (see the report for owners)

- **Brand and env filter on the server (in review).** The contract adds `labels` on rows and a repeated
  `label=key:value` filter (agent-runtime-org PR #59); the zyg-agents index stores `summary.labels` and filters on them,
  and the desktop's `AuditSearchInput` passes `label` through (separate PRs). Until they ship, the SDK viewer's
  Procedures tab filters by brand and env from the records themselves (viewer/README.md).
- **Runs older than two days are not re-indexed.** The sweeper looks back at most two days by run-id day, so a
  conversation updated after that is not re-indexed.
- **Envelopes are not served.** The index's envelope route is off until forking a run ships, so `envelopes` stays off.
