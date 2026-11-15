# The org layer: an SDK host in its organization

An SDK host joins its Marshal organization the way a person's desktop does, as the person the run is for. Its sessions become org sessions that every teammate's Marshal shows, and a teammate with a role on one can drive it. The organization's admitted extensions load on it, filtered by the host's profile. A Marshal can also reach the host itself through rooms: who it is, whether it is up, its sessions, and requests to cancel or read telemetry and files. The host only ever dials out.

All of it ships as one first-party runtime extension, `@marshal/org` (`extensions/org`). The SDK loads it by default when its manifest names an org.

```json
{
  "version": 1,
  "extensions": [],
  "org": { "discovery": "https://org.example.test", "profile": { "deny": ["@zyg/marshal-runtime-extension"] } }
}
```

Run it with `MARSHAL_ORG_TOKEN_FILE=/run/secrets/org-token marshal-sdk serve …`. To opt out, set `"defaults": {"org": false}`.

## Pieces

| Piece | File | What it does |
| --- | --- | --- |
| Credentials and connection | `src/org-connect.ts` | Reads the person's token (`personAccessToken`). Runs discovery and returns a client (`connectOrg`). Gives onboarding a resolver that joins the manifest's org (`personOrgResolver`, registered by the CLI with `useExtensionResolver`). |
| Extensions from the org | `src/org-extensions.ts` (onboarding lane) | Admits the catalog's approved entries, newest version of each, and pins versions. Downloads archives from the API origin only, checking size and sha256. Bundled delivery is supported. The manifest's `org.profile` allow and deny lists apply in `src/onboarding.ts`. |
| Sessions in the org | `src/org-bridge.ts`, `src/org-publish.ts` | Publishes envelopes, transcripts and checkpoints. Holds the leases and turns live on. Runs claimed inbox messages and completes them (docs/org-bridge.md). |
| Sessions through capabilities | `src/org-host-sessions.ts` | The host's sessions as the extension sees them. `marshal.agent.list`, `send`, `wait` and `cancel` drive turns. `marshal.link.call` supplies full transcripts and the native state. |
| Questions in rooms | `src/rooms-route.ts` | Posts a session's open question into its conversation room. A reply there, or the next inbox instruction, answers it. |
| Host room | `src/org-host-room.ts` | The contract below and its host side, `HostRoomEndpoint`. |
| Rooms client | `src/org/rooms/*` | Socket, replica, text, files and routes, lifted from the desktop (`electron/org/rooms` at c75500b1b), behind the runtime's `RoomsApi` and `Room` (`connectOrgRooms`). |
| The extension | `extensions/org` | Wires all of the above and exposes the `marshal.org.*` capabilities. |
| Link in process | `src/link/call-provider.ts` | `marshal.link.call`: the SDK host answers link v1 requests without exposing a port, through a private loopback link that starts on first use. |

## Credentials (R18)

The run acts as **the person who started it**, with the same org token they use in Marshal. There is no service identity.

- On a person's own machine, that is their signed-in token.
- In the cloud, the requester's token is handed to the run.

The token comes from `MARSHAL_ORG_TOKEN_FILE`, a file that is read again on every call so whoever refreshes the token only rewrites the file. Failing that, it comes from `MARSHAL_ORG_TOKEN`. The extension also takes `tokenFile` in its configuration. A token never appears in configuration that is listed, in a log line or in an error.

The same token is the rooms token. The rooms routes take it as a bearer token and the socket sends it in `hello`. There is no separate exchange (see the note at the top of `src/org/rooms/index.ts`).

Production writes are allowed under that identity. They are off unless the person turns them on with `MARSHAL_ORG_ALLOW_PRODUCTION=1` or `allowProductionOrg: true`. A test organization is a loopback host or a name under `.test`, `.example`, `.invalid` or `.localhost`. Anything else is refused before the first request: `connectOrg` checks the org URL, then the discovery document's `apiBase`, and the bridge checks again. Nothing in this repository runs against production: every test uses the contract's fakes (R13).

## The extension

The SDK host gives `@marshal/org` three things it cannot ask for itself: `hostId`, `hostKind` and `stateDir` (`<state>/org`, holding the ledgers and the rooms replica). They go under any configuration the manifest set. The onboarding default passes the manifest's `org.discovery`; `MARSHAL_ORG_URL` stands in until then.

Other configuration fields: `tokenFile`, `workspaceId` (default `MARSHAL_ORG_WORKSPACE`, else the person's first workspace), `allowProductionOrg`, `live`, `start` (default true; tests use false and call the capabilities), `syncSeconds`, `rooms` (`false`, or `{apiBase, socketUrl, tokenFile?}` in place of the discovery document's), and `profile`.

| Capability | Name source | What it does |
| --- | --- | --- |
| `marshal.org.status` | new | Whether the host joined, as whom, which workspace, each session's lease and live state, and rooms and host-room state |
| `marshal.org.sync` | new | Publishes now, refreshes the host room, and posts open questions into session rooms |
| `marshal.org.poll` | new | Runs what people posted to the host's live sessions now (a timer does it otherwise) |
| `marshal.org.sessions.search` | desktop | Org sessions this person can read; titles are wrapped as external content |
| `marshal.org.sessions.transcript` | desktop | One page of up to 100 messages from `from`, wrapped as external content |
| `marshal.org.sessions.view` | desktop | Answers `ok: false`: a headless host has no screen |
| `marshal.org.extensions` | new | What the org admits, and which entries this host's profile loads |
| `marshal.org.hostRoom.grant` | new | The person lets a teammate view or drive the host through its room |

**Only through capabilities.** The extension never imports the host. It uses `marshal.agent.list`, `send` with `wait`, and `cancel`, the runtime's agent provider under the desktop's names. Where the host offers `marshal.link.call`, as the SDK host does, it uses that for full transcripts, checkpoints and the host room. Without it (a host like today's desktop), the extension still publishes and runs instructions. In that case it sees only the last 20 messages per read, marks a gap it could not read, leaves no checkpoint and runs no host room.

On the desktop, the runtime's rooms service (`ROOMS_SERVICE_KEY`) supplies the rooms. In the SDK, the extension connects its own client.

## Rooms as the endpoint

The org path already carries sessions, transcripts, checkpoints (`putTranscript`, `putEnvelope`) and instructions (the inbox). Rooms carry only what the org path does not: host identity and presence, live session state, and requests to stop, read telemetry and read files. Every payload in a room is a link v1 payload (docs/link.md), so a Marshal that speaks the link maps one to one.

### Host room, contract v1

- **Room:** id `host.<host id>`, kind `@marshal/org/host`, schema version 1, declared in `@marshal/org`'s `contributes.rooms`. It is owned by the person the host runs as. They grant `viewer` to show the host, or `driver` to let someone send requests (`marshal.org.hostRoom.grant`).
- **`info:host`** `{v: 1, info, owner, at}`. `info` is exactly what `GET /v1/info` returns.
- **`session:<local session id>`** `{v: 1, session, orgSessionId, room}`, one record per session the host has. `session` is the link's session record. `orgSessionId` is the org session it is published as (`msdk-<id>`), and `room` is its conversation room (`session:msdk-<id>`). The record is written when it changes (refreshed every 5 s) and deleted when the session is gone.
- **Presence:** `{v: 1, host, running, at}`, refreshed with the records. The rooms service's presence TTL makes a host that stopped answering show as offline. On close it writes `stopped: true`.
- **`request:<id>`** (the built-in type), written by a driver as `{to: <the host's person>, about?: "info:host" | "session:<id>", text, status: "open"}`.
  - `text` is JSON `{v: 1, method, path, query?, body?}` on one of the offered link routes:
    - `GET /v1/info`
    - `GET /v1/runs` and `GET /v1/runs/:id/telemetry`
    - `GET /v1/sessions`, `GET /v1/sessions/:id` and `GET /v1/sessions/:id/{transcript, telemetry, native}`
    - `POST /v1/sessions/:id/{messages, cancel}`
    - `GET /v1/files` and `GET /v1/files/read`
    - `GET /v1/decisions[/:id]` and `POST /v1/decisions/:id/answer`
  - Streams and `/v1/invoke` are not offered. A long poll (`waitMs`) is dropped: the room's own changes are the live signal.
  - The addressee is a person because the rooms schema accepts only a principal or `agent:team` there. The room belongs to one host, so anything addressed to its person in it is for the host.
  - The host claims a request (`status: "claimed"`, `claimedBy`: the person) and answers it:
    - `done`, with `result` JSON `{v: 1, status, body}`.
    - `done`, with `{v: 1, status, file, bytes}` when the body is over 31,000 characters (`request.result` holds at most 32,000). The room file holds the body as JSON.
    - `failed`, with `{v: 1, status, error: {code, message}}` using the link's error codes (`not-found`, `invalid-request`, `running`, `no-native-state`, …).
  - Requests are answered one at a time, oldest first. Open ones left from before a restart are answered too.
- A client writing into a host room declares the kind, as `@marshal/org` does: `kinds: [{...HOST_ROOM_SCHEMA, identity: "@marshal/org"}]`.

### Conversation rooms

`session:<org session id>`, the runtime's built-in kind, accepts only `message` records. The host uses it for questions (`src/rooms-route.ts`). Transcript deltas stay on the org path for now. Instructions go through the org inbox, which already checks roles and runs them on the lease holder.

### The two transports behind one interface

The desktop reaches an SDK host through `SdkHostTransport` (OmerMachluf/marshal `electron/sdk-hosts/sdk-host-transport.ts`, #160). The HTTP link is one implementation; org plus rooms is the other:

| `SdkHostTransport` | Over org + rooms |
| --- | --- |
| `info()` | the host room's `info:host`.`info` |
| `sessions()` | the host room's `session:*`.`session` |
| `search(q, limit)` | request `GET /v1/sessions?q=&limit=` |
| `transcript(id, {tail})` | `getTranscript(msdk-<id>)` on the org (bulk), or request `GET /v1/sessions/:id/transcript?tail=` for the host's own copy |
| `telemetry(id)` | request `GET /v1/sessions/:id/telemetry` |
| `files(root, path)` / `readFile(root, path, max)` | request `GET /v1/files` / `GET /v1/files/read` (a large body arrives as a room file) |
| `send(id, text, "queue")` | `postMessage(msdk-<id>)` on the org inbox; `"interrupt"` is request `POST /v1/sessions/:id/messages` |
| `cancel(id)` | request `POST /v1/sessions/:id/cancel` |
| `native(id)` | the org checkpoint (`getEnvelope`), or request `GET /v1/sessions/:id/native` |

## What the desktop would switch to later (north star, not now)

The desktop keeps its own org layer (`electron/org`); this repository changes nothing there. When it moves onto the SDK, it would:

1. Load `@marshal/org` like any extension. The runtime already binds the rooms service and the agent provider there. The extension then needs one host capability the desktop lacks today (`marshal.link.call`, or a smaller `marshal.sessions.exportNative` for checkpoints), plus a way to read full transcripts beyond `marshal.agent.transcript`'s 20 messages.
2. Implement `SdkHostTransport` over org and rooms with the table above (the "marshal <-> sdk sessions" lane).
3. Retire its own copies of what was lifted: `rooms-*` is now in `src/org/rooms`, the onboarding resolver in `src/org-extensions.ts`, and the live executor in `src/org-bridge.ts`.

## Lifted code

`src/org/rooms/*` is a copy of `electron/org/rooms` at OmerMachluf/marshal c75500b1b, adapted: a local log sink instead of `createLogger`, `fs.mkdirSync` instead of `secureMkdirSync`, and Node 22's WebSocket instead of `ws`. Each of those files names its source. `src/org-extensions.ts` installs the way `electron/org/org-onboarding.ts` does. The bridge, the host room and the extension are new code on the runtime's org contract.

## Tests (fakes only)

- `test/org-connect.test.ts`: the token from a file (re-read on every call) or the environment; a missing or empty token; a production org refused before any request and allowed only by the person's switch; the resolver joining the manifest's org with the person's token and admitting the newest approved version (pending entries refused).
- `test/org-host-room.test.ts`: against a fake room and a real link server on loopback. Info, session records and presence are published. Telemetry, files, read and cancel requests are answered with link payloads. A large transcript goes as a room file. A request on an unoffered route fails `invalid-request`, one for someone else is left alone, and a 404 keeps the link's code.
- `test/org-extension.test.ts`: a real SDK host loads the built `@marshal/org` against the contract's in-memory org and the runtime's in-memory rooms service (`createInMemoryRoomsProvider`):
  - It joins as Ada with her own token file and publishes the session with a checkpoint.
  - Bob, granted `driver`, posts an instruction; the host runs it through `marshal.agent.send` and the org names Bob as its author.
  - Search, transcript and view answer.
  - Ada grants Bob the host room; Bob's own rooms client sees `info:host` and the session record, asks for telemetry, and gets a `done` link payload.
  - Disposing the host gives the lease back with a checkpoint.
  - A manifest naming an org loads `@marshal/org` by default; `"defaults": {"org": false}` leaves it out.
- `test/org-rooms-client.test.ts` (rooms client lane): the lifted client against the rooms fake.
