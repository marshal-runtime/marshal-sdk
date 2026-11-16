# Memory, preferences and session search on every host

Every `createMarshalHost` gives its sessions the desktop's memory and session tools under the desktop's names. A host
does not define its own; it chooses where memories are stored and which scopes a session reads.

## Tools

| Capability | Input | What it does |
| --- | --- | --- |
| `marshal.tool.remember` | `{fact, category?, appliesTo?, replaces?, links?, alwaysOn?}` | Saves a memory. `category` is `preference`, `decision`, `fact` or `context` (default `fact`). A preference goes to the narrowest scope (the person) and is always on; anything else goes to the broadest scope. `appliesTo` names a scope, `replaces` removes the memory it corrects. |
| `marshal.tool.recall` | `{query, limit?}` | Ranks the memories of the session's scopes by words (or the backend's own search) and lists the scope ids. |
| `marshal.tool.forget` | `{id}` | Removes a memory from any scope the session reads. |
| `marshal.tool.searchSessions` | `{query, scope?, since?, until?, workspace?, limit?}` | Searches this host's sessions and, with an org store, every session any host of the org published (`scope`: `local`, `cloud`, `all`; default `all`). One scorer (`scoreSession` in `session-store.ts`) ranks both. |
| `marshal.tool.getSessionTranscript` | `{sessionId, lastN?}` | Reads a local session, or a published one from the org store. |

## Prompt

Before each turn the port awaits `prepareTurn`, which reads the session's scopes from the backend. The prompt's memory
block (`sessionContext.memories`, rendered in the untrusted-memory wrapper) then shows every always-on memory
(preferences) of the session's scopes, followed by the newest other memories (`promptLimit`, default 20), and a count of
the rest. `sdkBaseLayer` fills the v2 memory and session-search slots with what the host really provides.

## Options (`MarshalHostOptions.memory`)

- `backend`: a `MemoryBackend` (`save`, `list`, `remove`, optional `search`). Default `objectMemoryBackend`: one object
  per memory at `sdk-memory/v1/<scope key>/<id>.json`, in the org store's bucket when the host has one, else in
  `<stateRoot>/memory`.
- `org`: the first part of every scope key. Default: the org store's workspace, else `local`.
- `scopes(session)`: the scopes a session reads, broadest first. Default `[{id: "workspace", key: {workspace}}]`.
  Marley: `[{id: "brand", key: {brand}}, {id: "person", key: {brand, member}}]`.
- `promptLimit`, `alwaysOnLimit`.

There are no access limits inside an org: any session whose scopes name a key reads it.
