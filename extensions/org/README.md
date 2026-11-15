# @marshal/org

The organization layer of a Marshal host as a runtime extension. The SDK loads it by default when its manifest names an org (`"org": {"discovery": "<org url>"}`); `"defaults": {"org": false}` opts out. Design and contract: `docs/org.md` in marshal-sdk.

It acts as the person the run is for, with their own org token: `MARSHAL_ORG_TOKEN_FILE` (a file, re-read on every call) or `MARSHAL_ORG_TOKEN`. A production organization is refused unless `MARSHAL_ORG_ALLOW_PRODUCTION=1`.

| Capability | What it does |
| --- | --- |
| `marshal.org.status` | Joined or not, as whom, the workspace, each session's lease and live state, rooms and the host room |
| `marshal.org.sync` | Publish now, refresh the host room, put open questions into session rooms |
| `marshal.org.poll` | Run what people posted to the host's live sessions now |
| `marshal.org.sessions.search` | Org sessions this person can read (desktop name) |
| `marshal.org.sessions.transcript` | One page of an org session's transcript, wrapped as external content (desktop name) |
| `marshal.org.sessions.view` | Desktop name; a headless host has no screen and says so |
| `marshal.org.extensions` | What the org admits and what this host's profile loads |
| `marshal.org.hostRoom.grant` | Let a teammate view or drive this host through its room |

Configuration (all optional; the SDK host fills `hostId`, `hostKind` and `stateDir`): `discovery`, `tokenFile`, `workspaceId`, `allowProductionOrg`, `live`, `start`, `syncSeconds`, `rooms` (`false`, or `{apiBase, socketUrl, tokenFile?}`), `profile`.

It reaches the host only through capabilities: `marshal.agent.*` for sessions and turns, and `marshal.link.call` for full transcripts, checkpoints and the host room where the host offers it (the SDK host does; without it the extension publishes the last 20 messages per read and leaves no checkpoint).
