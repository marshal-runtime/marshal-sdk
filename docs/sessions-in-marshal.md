# Marshal SDK sessions inside Marshal

How a headless run's sessions are stored, tagged, searched, opened and continued, what works today, and what is
missing. Marshal references are to `/Users/omer/marshal/marshal` at local `origin/main` 5d87dd76b plus the working tree
(read 2026-11-15); org contract references are to `@marshal/agent-runtime-org` 0.1.0 as pinned by that repo.

## Stored

A marshal-sdk host writes its sessions under `<stateRoot>/sessions` (`src/session-store.ts`):

- `index.json`: one record per session: id, title, state, model, effort, usage, `runId`, `host {id, kind}`,
  `parentId`, free `labels`, `native {kind: "claude", sessionId, cwd, configDir}`.
- `<id>/transcript.jsonl` (what a person reads) and `<id>/events.jsonl` (every backend message).
- The model's own copy: `<configDir or ~/.claude>/projects/<cwd, non-alphanumerics as '-'>/<native id>.jsonl`
  (`claudeNativePath` in `src/org-publish.ts`). This file is what lets another Marshal resume the conversation.

## Tagged and searched

- On the host: `FileSessionStore.list({runId, parentId, state, labels})` and `search(words)`.
- In Marshal, from the files: the `@omer/marshal-sdk-sessions` extension (`viewer/`) gives `sdksessions.runs`,
  `.sessions {runId}`, `.transcript {sessionId}`, `.search {query}` and a tab (runs → sessions → transcript, desktop and
  phone). It reads store folders on the same machine (configured `roots`, default `~/marshal/marshal-sdk/.runs`).
- In the organization: `publishToOrg` (`src/org-publish.ts`) turns each session into an org session `msdk-<id>`.
  The org envelope has no free tags (`OrgSessionEnvelope` in `agent-runtime-org/src/sessions.ts`: id, workspace, title,
  owner, labels = public|team|restricted, runtime, transcript), so the title names the run and host
  (`… · run 6ca64536 on poc`) and a first `system` message carries run, host, model, effort, parent, native id and
  labels. Org transcript search (`marshal.org.sessions.search`, `electron/marshal-runtime/org-sessions-provider.ts`)
  then finds a session by run id or label words.

## Opened by a teammate

Published org sessions appear where every shared session does (Org sessions list → `RemoteSessionView`,
`src/features/org/RemoteSessionView.tsx`) for anyone granted a role, and agents read them with
`marshal.org.sessions.view/transcript`.

## Continued in their own Marshal

Shortest real path, all existing code:

1. The run publishes with `publishToOrg` (session, transcript, and between turns a lease + `putEnvelope` +
   release with a `sha256:` checkpoint).
2. The owner grants the teammate `driver` (`OrgClient.grantSession`). A fork needs `driver` or `owner`; a viewer can
   read but not fork.
3. The teammate presses Fork in `RemoteSessionView` (`useForkSession`, `src/features/org/orgQueries.ts:271`) →
   `org:forkSession` (`electron/ipc/org-ipc.ts:285`) → `OrgFork.fork` (`electron/org/org-fork.ts`): `forkSession`,
   `getForkEnvelope`, sha check, gunzip → `sessions.createFromNative` (`electron/main.ts:3561`) →
   `SessionManager.createFromNativeState` (`electron/sessions.ts:7595`): accepts `claude-jsonl`, rewrites the
   session id, imports the native file into the Claude runtime and opens a new local session that resumes the
   conversation natively.

Tested: `test/org-publish.test.ts` runs steps 1–3 up to `createFromNative` against the contract's in-memory
organization (the fork's downloaded state equals the native bytes), and a copy of the real quick1 store published all
10 sessions with their native state checkpointed. Not run: the desktop half (the button and `createFromNativeState`) on
a published SDK session, and no production organization was called.

## What is missing

| Gap | Where | What it takes |
| --- | --- | --- |
| A service can't publish for a person. The org accepts `putSession` only from the session's owner (in-memory server: `upload.owner !== caller` → 403; test "only from its owner"). zyg-agents avoids this by writing through its own DB store (`src/shared/org-sessions/cloud-publish.ts`), not HTTP. | org server | A service principal allowed to publish on behalf of the requester (owner = requester, author = service), or agent-sandbox hands the run to the org's run index (records bucket `runs/<run id>/`) instead. |
| Fork and take-back need the org to serve `leases`, `cloudRuns` (the envelope store; `OrgFork` calls `getCloudCapabilities`) and `forks`, and the desktop flag `orgFork`. | org server, settings | Turn them on for the workspace the runs publish to. |
| Take-back of the session itself (not a fork) refuses any runtime but `claude` (`electron/org/org-cloud-move.ts:939`). | desktop | Publish with `runtime: "claude"` (option on `publishToOrg`), or let take-back accept any runtime whose envelope format it can import. |
| No runtime capability creates a local session from a native file. Session capabilities are read-only (`marshal.org.sessions.*`, `marshal.cloud.session.open`, `marshal.session.context`); `createFromNativeState` is reachable only from the org fork and cloud take-back. So the viewer tab can't offer "Continue in Marshal" without an org. | desktop | A `marshal.sessions.importNative {name, state, workspace?}` capability over `createFromNativeState`, behind a permission. |
| The local Import flow (`sessionImport:*`, UI only) scans only `~/.claude/projects` (`electron/session-import/sources.ts:36`; it deliberately ignores `CLAUDE_CONFIG_DIR`). A run made with `--claude-config-dir <account>` is invisible to it; a run with the default config dir would show up as a plain Claude Code session (no run, host or labels). | desktop | Let Import scan the SDK's store (or the account's projects folder) and keep the SDK metadata. Not tried. |
| Paths: the native file records the sandbox's cwd and file paths. A fork resumes the conversation in the teammate's default workspace, without the sandbox's files. | design | Expected for a fork; a placement-style mount bundle (`putMountBundle`) would bring the files along. |
| Live follow (watching a prod run while it runs) | org | Publish on every turn end (calls are incremental); live inbox (`postMessage`/`claimMessages`) would let a teammate send a message into the running sandbox session, not built here. |
