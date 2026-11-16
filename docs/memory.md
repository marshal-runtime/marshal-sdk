# Memory, preferences and session search on every host

Every `createMarshalHost` gives its sessions the desktop's memory and session tools under the desktop's names. A host
does not define its own. Memory has one home: memory nodes in a Brain graph (Spanner), linked to the code, sessions,
people and entities they are about. There are no JSON memory objects, no memory files and no proposals: any agent
writes a memory node at once and nobody approves it (Omer, 2026-11-17). A host only says which Brain store and which
scopes a session uses.

## Tools

| Capability | Input | What it does |
| --- | --- | --- |
| `marshal.tool.remember` | `{fact, category?, appliesTo?, replaces?, links?, alwaysOn?}` | Writes a memory node. `category` is `preference`, `decision`, `fact` or `context` (default `fact`). A preference goes to the narrowest scope (the person) and is always on; anything else to the broadest. `appliesTo` names a scope, `replaces` supersedes the memory it corrects, `links` are edges: `{nodeId}`, `{path, symbol?}`, `{sessionId}` or `{personId}`, each with an optional `rel`. |
| `marshal.tool.recall` | `{query?, since?, category?, limit?}` | With `query`: the Brain's existing hybrid search over memory nodes of the session's scopes (its ranking, unchanged). With `since` and no query: the scopes' memories saved since then, newest first (a review of the day). Lists the scope ids. |
| `marshal.tool.linkMemory` | `{id, links, replace?}` | Adds edges to a memory; `replace: true` makes them its only links. |
| `marshal.tool.updateMemory` | `{id, fact?, category?, alwaysOn?}` | Changes a memory in place; its links stay. |
| `marshal.tool.forget` | `{id}` | Deletes a memory node. |
| `marshal.tool.searchSessions` | `{query, scope?, since?, until?, workspace?, limit?}` | Searches this host's sessions and, with an org store, every session any host of the org published (`scope`: `local`, `cloud`, `all`; default `all`). One scorer (`scoreSession` in `session-store.ts`) ranks both. |
| `marshal.tool.getSessionTranscript` | `{sessionId, lastN?}` | Reads a local session, or a published one from the org store. |

## The Brain store (`BrainMemoryRoute`)

A route is one Brain store's memory operations: `create`, `update`, `link`, `delete`, `search` and `list` (types in
`src/memory.ts`, exported from the package). Each write is a graph node or edge at once. Scopes travel as opaque
strings `<id>:<k>=<v>/...` (`scopeString`), e.g. `brand:brand=<uuid>` and `person:brand=<uuid>/member=<uuid>`.

- The company Brain: `brainCapabilityRoute(id, call)` maps the route onto the Brain extension's capabilities
  `memory.create`, `memory.update`, `memory.link`, `memory.delete`, `memory.search` and `memory.list`. With the kit's
  `memory` part the host uses it by default with one `workspace` scope, and the kit allows those writes.
- A store held in-process: `typedGraphMemoryRoute({id, execute, tenant, storeOf, merge?})` runs the route on a Quillstone
  typed-graph service's memory ops (`memoryCreate`, `memoryUpdate`, `memoryLink`, `memoryDelete`, `memorySearch`,
  `memoryList`, `memoryGet`; `execute` is `service.execute`). Each scope is its own store (`storeOf(scope)`); writes by
  id look for the id in the session's scopes. Always-on is the `preference` category there. A search runs each store's
  own search (its algorithm, unchanged) and merges the stores with `merge` on their raw `lex`/`sim` signals (Marley:
  `fuseAcrossStores`), by default interleaved by rank. Marley uses it for the brand's Spanner graph with scopes brand
  and person (the DM member).

## Prompt

Before each turn the port awaits `prepareTurn`. It reads the Brain only for a scope this host has never seen (its
always-on memories and newest others); every other scope comes from the host's cache (its own writes update it) and is
re-read in the background at most every `refreshMs` (default 60 s) to pick up other hosts' writes, so a turn never
waits on cloud I/O after a scope's first read. The prompt's memory block (`sessionContext.memories`, rendered in the
untrusted-memory wrapper) shows every always-on memory (preferences) of the session's scopes, then the newest others
(`promptLimit`, default 20). `sdkBaseLayer` fills the v2 memory and session-search slots with what the host provides.

## Options (`MarshalHostOptions.memory`)

- `store(session)`: `{route: BrainMemoryRoute, scopes: MemoryScope[]}` (broadest scope first) or `undefined`. Default:
  the kit's company Brain with `[{id: "workspace", key: {workspace}}]` when the kit carries `memory`; otherwise the
  session has no memory and the tools answer `unavailable`.
- `promptLimit`, `alwaysOnLimit`, `refreshMs`.

There are no access limits inside an org: any session whose scopes name a key reads it.
