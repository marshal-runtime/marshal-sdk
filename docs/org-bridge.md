# The org bridge: drive any SDK session from your own Marshal, through the organization

The link (docs/link.md) connects one Marshal to one host directly. The org bridge connects a host to the **organization** instead. Its sessions show up as org sessions in every teammate's Marshal, and a person with a role on one can post an instruction from their desktop. The host runs that instruction in the session and answers. There is no address to share and no token per host: the organization carries everything.

```ts
const host = await createMarshalHost({
  …,
  org: {
    client,                       // an OrgClient holding the owner's token
    owner: "user:ada@zyg.com",    // the person the run is for
    workspaceId: "ws:pages",
    // allowProductionOrg: true,  // off by default; see "Production" below
  },
});
// host.org.sessions(), host.org.sync(), host.org.poll(), host.org.idle(), host.org.heartbeat(); dispose() closes it.
```

Or use `createOrgBridge({ client, store, agents, owner, workspaceId, host })` around any store and agent port.

## What it does

1. **Publishes** every session of the store (or of `runId`) with `publishToOrg` (src/org-publish.ts). That covers the envelope (`putSession`, id `msdk-<local id>`), the transcript in pages, and, for an idle session, its native Claude state as a checkpoint. It re-publishes every `syncSeconds` (30 s), so the host's own turns appear too.
2. **Takes the lease** of each session as its executor (`host` = the host id) and **turns live collaboration on** (`setSessionLive {enabled, host}`). From then on, instructions from the owner and from anyone granted `collaborator` or `driver` are queued for this host. A `viewer` can only comment, and a person with no role gets 404.
3. **Polls** `listLivePending {host}` every `pollSeconds` (the server says how often; 4 s by default). Polling also keeps the host shown as online. For each session with work, it runs these steps:
   - It claims up to 5 messages (`claimMessages`).
   - It delivers each one into the session as a message from that person (`agents.deliver`, `from: {kind: "person", personId: <principal>, name}`). The session reads "Message from Bob:" above it, just as with the desktop's sender line, and its transcript message carries `from`.
   - It waits for the answer (`turnTimeoutMs`, 30 min). It then marks the messages done with the turn's answer (`completeMessages {turnId, final}`).
   - It appends the turn to the org transcript. The user message names the inbox message it ran (`messageId`), so the org shows its real author. Then it leaves a fresh checkpoint.
   Sessions run in parallel; one session runs one turn at a time.
4. **Heartbeats** every held lease every 30 s. A 410 `lease-lost` means another host took the session, for example the owner pulled it to her own desktop. The session is then marked `lost` and left alone: the next sync sees `lease-held` and marks it `elsewhere`, and the bridge never forces a lease back.
5. **On close** (`host.dispose()`), it waits for running turns, publishes them with a checkpoint, and gives every lease back.

The org records a checkpoint only when a lease is released. A checkpoint therefore releases the lease and takes it again at once. This happens after `completeMessages`, never between a claim and its done.

What the host remembers sits next to the session store:
- `org-published.json`: what was sent.
- `org-inbox.json`: which local user message ran which inbox message.

Restarting the host resumes from there.

## Questions through the session's room

A session that asks a person (`marshal.tool.askUser`, docs/kit.md) can be answered by anyone it is shared with. `ConversationRoomRoute` (src/rooms-route.ts) is a `PersonRoute`:

- **The question goes into the room.** It is written into the conversation room of the session's org session (`session:msdk-<id>`) as an `assistant` message for the owner, with numbered options. Every Marshal with a role on the session shows that room.
- **A reply in the room answers it.** A final `user` message whose `replyTo` is the question's record answers it. The writer is the one the server names (`updatedBy`), and a number or an option's title picks that option.
- **So does the next instruction posted to the session.** The bridge offers each claimed inbox message to the route first (`answers.takeInboxAnswer`). While the session has an open question asked in its room, the message is taken as the answer, and the turn is completed with "Answer recorded". After that, messages run as usual.

The answer reaches the session through `DecisionDesk.answer`, as a message from that person. A host created with both `org` and a `ConversationRoomRoute` in `routes` wires the route into the bridge.

The route writes through the runtime's rooms API (`RoomsApi.open(roomId)`, pack marshal-host-87 and later). It needs only `query`, `set` and `subscribe` of a room, so `openRoom` is the host's to supply. On a host with the rooms service bound, that is `rooms.open(roomId)`. Without rooms, a session that is not shared gets a delivery that says so, and the question still goes out on the other routes (`link`, file).

What's open:

- The SDK host's rooms client is `src/org/rooms` (lifted from the desktop); `@marshal/org` opens session rooms with it (docs/org.md).
- Questions asked before a host restart are not re-posted to the room. They are still open on the link and through `marshal.decisions.answer`.

## Production

`createOrgBridge` refuses to start (code `production-org-off`) unless the organization's API is a test one: a loopback host, or a name under `.test`, `.example`, `.invalid` or `.localhost`. The exception is when the caller passes `allowProductionOrg: true`. Whether a host writes to Zyg's production org is the owner's decision. Nothing in this package turns it on.

## The identity it needs

The bridge holds **the token of the person the run is for** (R18, settled): the same org token they use in Marshal, never a service identity. On their own machine that is their sign-in. In the cloud, the requester's token is handed to the run (`MARSHAL_ORG_TOKEN_FILE` or `MARSHAL_ORG_TOKEN`; see docs/org.md, "Credentials"). The org contract needs exactly that:

- `putSession` is accepted only from the session's owner. A service publishing a session for someone else gets 403 (test "the organization takes a session only from its owner" in `test/org-publish.test.ts`).
- Only the owner's own host runs other people's instructions in a live session. The claim covers every author only when the caller is the owner and `host` is the session's live host (in-memory server `claimMessages`, `everyone`).

As an extension, the bridge runs inside `@marshal/org` (docs/org.md), which reads the token and passes the client in.

## Tests

`test/decision-routes.test.ts`: a linked Marshal lists and answers a live host's question (and a store-only host refuses); a question in a fake conversation room answered by a reply there (a streaming reply does not count); the next org inbox instruction answering the open question, after which instructions run as usual.

`test/org-bridge.test.ts`, against the contract's in-memory organization (`createInMemoryOrgProvider`, with features `messages`, `liveSessions`, `leases`, `cloudRuns`, `forks` and `multiUser`). No model is involved; the session answers `echo: …`.

- Bob, granted `driver`, posts an instruction and it runs in the session. His message is done with the turn id, the org transcript names him, and the checkpoint covers the turn. Carol, who has no role, is refused by the org. The owner's own instruction runs the same way.
- The owner takes the session to her desktop (`force`). The bridge marks it lost on the next heartbeat and doesn't take it back.
- A real org address is refused without `allowProductionOrg`.
- A host created with `org` publishes its own launched session, runs a collaborator's instruction, and gives the lease back on `dispose()`.
