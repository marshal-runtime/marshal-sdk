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

**Telemetry** comes from `events.jsonl`, nothing else: `tokens {input, output, cacheRead, cacheWrite}`, `costUsd`, `turns` (messages the host ran), `modelRoundTrips`, `toolCalls` by name, `toolCallTotal`, `toolErrors` (tool results marked as errors), `turnDurations {count, totalMs, averageMs, medianMs, maxMs, lastMs[]}`, `errors {count, last[]}` (failed turns), `models {name: {costUsd, outputTokens}}`, `events`, `firstEventAt`, `lastEventAt`.

**Files** are served only under the named roots (`workspace` is always one on a live host; `--files name=dir` adds more). Paths are resolved through `realpath` and must stay inside their root, so neither `..` nor a symlink leaves it.

**Conversation files** are found at `<config dir>/projects/<cwd with non-alphanumerics as '-'>/<Claude session id>.jsonl`, trying the session's own config dir, then each `--native-root`. A sandbox can ship conversation files without the account they ran on: copy only `projects/` and point `--native-root` at the copy.

## Marshal's side

The tab lists **hosts**: `local` (session stores in folders on this Mac, read-only) and every linked host from the extension's configuration:

```json
{ "hosts": [{ "id": "cloud-1", "name": "Cloud sandbox", "url": "https://…", "tokenFile": "~/.config/marshal-sdk/cloud-1.token" }] }
```

(`token` instead of `tokenFile` works too.) Tokens are never returned by any capability or shown in the tab beyond their last four characters. Hosts → runs → sessions → a session with Transcript, Telemetry and Files tabs. The transcript is live (a `watch` long poll with what the backend is doing), a live host gets a message box and a Stop button, and **Continue in Marshal** pulls the conversation file over the link into `marshal.sessions.importNative`.

Agents on your Marshal use the same through capabilities: `sdksessions.hosts`, `.runs {hostId}`, `.sessions`, `.transcript`, `.watch`, `.telemetry {sessionId | runId}`, `.files {root, path, read}`, `.send {text | cancel}`, `.continue`, `.search`, and `.pull {hostId, runId | sessionId}`. Pull copies records, transcripts, events and conversation files into `~/marshal/marshal-sdk/.pulled/<host>/<run>`, where the local host shows them, so they can be continued offline.

## Connecting a team (three steps)

1. **On the host:** run `marshal-sdk serve` (or pass `link` to `createMarshalHost`) with a token from your secret store, behind the sandbox's port route or a tunnel that adds TLS.
2. **Share the address:** put the URL and the token in the team's secret store (one token per host or per environment).
3. **In each Marshal:** add the host to the SDK sessions extension's configuration (`hosts: [{ id, url, tokenFile }]`), or ask Marshal's agent to do it; the host appears in the SDK sessions tab.
