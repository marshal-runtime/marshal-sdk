# The link: a Marshal SDK host and your own Marshal

A host running `@marshal/sdk` (a cloud sandbox, a container, a CI job, a Mac) serves a small HTTP API, the link. Marshal's **SDK sessions** tab (extension `@omer/marshal-sdk-sessions`) and any agent on your Marshal use it to watch the host's runs live, read transcripts, telemetry and files, send a session a message, and pull a run home or continue a session locally.

## Serving

```sh
# A live host: the runtime, its extensions, Marshal sessions on Claude; --task starts a first session.
MARSHAL_SDK_LINK_TOKEN=$(openssl rand -hex 24) marshal-sdk serve \
  --workspace ./ws --state ./state --claude-config-dir ~/.claude --model claude-haiku-5-5 \
  --files output=./out --task "…" [--bind 0.0.0.0] [--port 7781]

# Store-only: a finished run's state folder, no runtime and no credentials (read, telemetry, files, export).
marshal-sdk serve --store ./state --token-file ./link.token --files output=./out --native-root ./claude
```

In code: `createMarshalHost({ …, link: { token, bind?, port?, files?, nativeRoots? } })` (then `host.link.url`), or `startLinkServer({ token, sessionsRoot, host, files?, nativeRoots?, live? })` for a store alone.

- **Token.** Every request carries `Authorization: Bearer <token>`. There is no default and no anonymous mode: without a token of at least 16 characters the server does not start. The CLI takes it from `--token-file` or `$MARSHAL_SDK_LINK_TOKEN`, never from an argument (arguments show in `ps`). It compares SHA-256 digests in constant time.
- **Bind.** `127.0.0.1` by default. Bind wider only behind something that adds TLS (a tunnel, a port route, a reverse proxy); the link itself speaks plain HTTP.
- **Store-only** answers every read. Writes (`messages`, `cancel`, `invoke`) answer `409 store-only`.

## API (v1, JSON; errors are `{ error: { code, message } }`)

| Method and path | Answer |
| --- | --- |
| `GET /v1/info` | `{ protocol: 1, sdkVersion, host: {id, kind}, mode: "live" \| "store", runs: [runId], sessions, extensions: [{identity, version}], capabilities: [name], files: [root] }` |
| `GET /v1/runs` | `{ runs: [{ runId, host, startedAt, updatedAt, sessions, running, failed, models, costUsd, outputTokens, firstTitle }] }` |
| `GET /v1/sessions?runId&state&parentId&label=k:v…` | `{ sessions: [SessionRecord] }` (the record `src/session-store.ts` writes) |
| `GET /v1/sessions?q=words&limit` | `{ hits: [{ session, snippet, score }] }` |
| `GET /v1/sessions/:id` | `{ session }` |
| `GET /v1/sessions/:id/transcript?since&limit&tail&waitMs&state&updatedAt` | `{ session, total, cursor, messages: [{ index, id, role, content, timestamp, error?, truncated? }] }`. `since` is a message index and `cursor` the next one. With `waitMs` (≤ 25 s) the answer is held until there are messages past `since`, or the session's `state`/`updatedAt` differs from the ones passed (long poll). Messages over 64 KB are cut (`truncated` = full length). |
| `GET /v1/sessions/:id/events?since=seq&limit` | `{ events: [{ seq, at, event }], total, cursor }`: the backend events from `events.jsonl` |
| `GET /v1/sessions/:id/stream?since` | Server-sent events: `session` (the record, whenever it changes), `message` (each new transcript message, `id:` = its index + 1, so `Last-Event-ID` resumes), `activity` (`{ seq, at, kind: init \| tool \| text \| result, name?, durationMs?, costUsd? }`). Starts at the end unless `since` is given. |
| `GET /v1/runs/:runId/stream` | Server-sent events: `session` for every session of the run as it changes, `message` with `sessionId`. |
| `GET /v1/sessions/:id/telemetry` | `{ sessionId, state, telemetry }` |
| `GET /v1/runs/:runId/telemetry` | `{ runId, telemetry: { …, sessions }, sessions: [{ id, title, state, costUsd, outputTokens, turns, toolCallTotal, errors }] }` |
| `POST /v1/sessions/:id/messages {text, deliveryMode?: queue \| interrupt}` | Live only. Runs now if the session is idle (a session from an earlier run of the host resumes by its Claude id), after the current turn (`queue`), or instead of it (`interrupt`). |
| `POST /v1/sessions/:id/cancel` | Live only. Stops the running turn and drops what was queued. |
| `POST /v1/invoke {capability, input}` | Live only. Calls one runtime capability on the host and answers `{ capability, output }`. |
| `GET /v1/files?root&path` | `{ root, path, entries: [{ name, type, size, modifiedAt }], truncated }` (≤ 500 entries) |
| `GET /v1/files/read?root&path&maxBytes` | `{ root, path, size, encoding: utf8 \| base64, content, truncated, modifiedAt }` (≤ 1 MiB; binary as base64) |
| `GET /v1/sessions/:id/native` | `{ sessionId, title, nativeSessionId, state: { format: "claude-jsonl", encoding: "gzip-base64", data }, bytes, sha256 }`: exactly what `marshal.sessions.importNative` takes. `409 running` while the session runs, `404 no-native-state` when the host has no conversation file. |
| `GET /v1/pages?runId` | `{ served, pages: [{ id, title, brand, sections, labels, version, updatedAt, notesOpen, pictures: { library, missing }, runId }] }`: pages in the host's pages folder (`--pages-dir`: a page editor's data folder with pages/ and library/). `runId` is the run that last changed the page (by its time window), `null` for a page that was there before (a base page). |
| `GET /v1/pages/:id` | `{ format: "marshal-page", version: 1, page, pictures: [{ url, brand, name, bytes, sha256, record }], missing, brands }`: the page record with its sections and every library picture it shows (`https://pagestudio.library/<brand>/<name>`), with the library's record of each and the brand's facts and design plan. |
| `GET /v1/pages/:id/pictures/:brand/:name` | The picture's bytes; only a picture that page shows, nothing else in the library. |
| `GET /v1/decisions?kind&status&runId&sessionId` | `{ decisions: [DecisionEntry], answers }`: what the host's sessions asked a person (`marshal.tool.askUser`, questions with options) and the decisions and gaps they recorded (`marshal.tool.recordDecision`), read from `decisions.jsonl` in the store (src/decisions.ts). `answers` is true on a live host. A store-only host serves the record too. |
| `GET /v1/decisions/:id` | `{ decision }` |
| `POST /v1/decisions/:id/answer {choice?, text?, by?: {name?, personId?}}` | Live only. Answers an open question (`choice` is the 0-based option). The first answer wins: it is stored with route `link` and reaches the asking session as a message from that person. `409 not-accepted` when it was already answered or the option does not exist, `400` without a choice or text. |

**Telemetry** comes from `events.jsonl`, nothing else: `tokens {input, output, cacheRead, cacheWrite}`, `costUsd`, `turns` (messages the host ran), `modelRoundTrips`, `toolCalls` by name, `toolCallTotal`, `toolErrors` (tool results marked as errors), `turnDurations {count, totalMs, averageMs, medianMs, maxMs, lastMs[]}`, `errors {count, last[]}` (failed turns), `models {name: {costUsd, outputTokens}}`, `events`, `firstEventAt`, `lastEventAt`.

**Files** are served only under the named roots (`workspace` is always one on a live host; `--files name=dir` adds more). Paths are resolved through `realpath` and must stay inside their root, so neither `..` nor a symlink leaves it.

**Conversation files** are found at `<config dir>/projects/<cwd with non-alphanumerics as '-'>/<Claude session id>.jsonl`, trying the session's own config dir, then each `--native-root`. A sandbox can ship conversation files without the account they ran on: copy only `projects/` and point `--native-root` at the copy.

## Marshal's side

The tab lists **hosts**: `local` (session stores in folders on this Mac, read-only) and every linked host from the extension's configuration:

```json
{ "hosts": [{ "id": "cloud-1", "name": "Cloud sandbox", "url": "https://…", "tokenFile": "~/.config/marshal-sdk/cloud-1.token" }] }
```

(`token` instead of `tokenFile` works too.) Tokens are never returned by any capability or shown in the tab beyond their last four characters. Hosts → runs → sessions → a session with Transcript, Telemetry and Files tabs. The transcript is live (a `watch` long poll with what the backend is doing), a live host gets a message box and a Stop button, and **Continue in Marshal** pulls the conversation file over the link into `marshal.sessions.importNative`.

**Questions a run asked** show as a row above the run's sessions ("❓ 1 question waits for an answer"). The questions view lists each open question with its options as buttons (the recommended one marked) and a box for your own answer. Answered ones show who answered and what, and the decisions and gaps the sessions recorded are listed under them. The answer goes over the link as the person in the extension's configuration (`person: {name, personId}`, else this Mac's user name). A run in a folder on this Mac shows its questions read-only. A live host registers the `link` route, so the delivery of every entry names its link address.

**Pages a run made** show as a row above the run's sessions. **Open in Page Studio** brings one into this Marshal's Page Studio as an ordinary page (sections, pictures, notes) people keep editing. A linked host's page and the pictures it shows are pulled first into `~/marshal/marshal-sdk/.pulled/<host>/<run>/data` (hash-checked); a local run's page is read from the run's own `data/` folder. Then `pagestudio.page.import {dataDir, pageId, origin}` copies it in: a new id when the id is taken, identical pictures reused, a different picture with the same name renamed and relinked. The run's copy stays as it is. A run held both in its own folder and in a pulled copy is one row that names both sources.

Agents on your Marshal use the same through capabilities: `sdksessions.hosts`, `.runs {hostId}`, `.sessions`, `.transcript`, `.watch`, `.telemetry {sessionId | runId}`, `.files {root, path, read}`, `.send {text | cancel}`, `.continue`, `.search`, `.pages {hostId, runId}`, `.openInPageStudio {hostId, pageId, open?}`, `.questions {hostId, runId, sessionId, kind, status}`, `.answer {hostId, questionId, choice | text}`, and `.pull {hostId, runId | sessionId}`. Pull copies records, transcripts, events, conversation files and the run's pages into `~/marshal/marshal-sdk/.pulled/<host>/<run>`, where the local host shows them, so they can be continued offline.

## Connecting a team (three steps)

1. **On the host:** run `marshal-sdk serve` (or pass `link` to `createMarshalHost`) with a token from your secret store, behind the sandbox's port route or a tunnel that adds TLS.
2. **Share the address:** put the URL and the token in the team's secret store (one token per host or per environment).
3. **In each Marshal:** add the host to the SDK sessions extension's configuration (`hosts: [{ id, url, tokenFile }]`), or ask Marshal's agent to do it; the host appears in the SDK sessions tab.
