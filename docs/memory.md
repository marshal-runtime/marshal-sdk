# Memory, preferences and session search on every host

Every `createMarshalHost` gives its sessions the desktop's memory and session tools under the desktop's names. A host
does not define its own. Memory has one home: memory nodes in a Brain graph (Spanner), linked to the code, sessions,
people and entities they are about. There are no JSON memory objects, no memory files and no proposals: any agent
writes a memory node at once and nobody approves it (Omer, 2026-11-17). A host only says which Brain store(s) and which
scopes a session uses.

## Two homes (Omer R8, 2026-11-17)

A memory lives in one of two homes, and a session reads both:

| Home | Where | What goes there | Read in |
| --- | --- | --- | --- |
| `personal` | the default Brain (the company Brain, zyg), scope `person:email=<email>`, private to that person | preferences (always on) and private facts such as a birthday | every session of that person, in every workspace |
| `workspace` | the session workspace's own Brain, scope `workspace:<name>` (the form the desktop and the extension write) | knowledge about that workspace: conventions, gotchas, why code is the way it is, linked to its real code nodes | sessions of that workspace |

A workspace whose Brain has no code graph of its own keeps its workspace memories in the company Brain under its
`workspace` scope (path links only) until it gets one. `remember` takes `home`; without it a preference is personal and
anything else workspace (falling back to the home the session has). Search and `since` lists run in each home and are
merged: search interleaves the homes' own rankings by rank, lists sort by time. A home whose Brain cannot be read is
named in recall's `degraded`; the other home's memories still come back. Update, link and forget by id try the home whose
cache holds the id first, then the other.

## Tools

| Capability | Input | What it does |
| --- | --- | --- |
| `marshal.tool.remember` | `{fact, category?, home?, appliesTo?, replaces?, links?, alwaysOn?}` | Writes a memory node. `category` is `preference`, `decision`, `fact` or `context` (default `fact`). `home` is `personal` or `workspace` (default: personal for a preference, else workspace). Within a home a preference goes to the narrowest scope and is always on; anything else to the broadest. `appliesTo` names a scope, `replaces` supersedes the memory it corrects, `links` are edges: `{nodeId}`, `{path, symbol?}`, `{sessionId}` or `{personId}`, each with an optional `rel`. |
| `marshal.tool.recall` | `{query?, since?, category?, limit?}` | With `query`: each home's Brain search over memory nodes of the session's scopes (its ranking, unchanged), interleaved by rank. With `since` and no query: the scopes' memories saved since then, newest first (a review of the day). Lists the scope ids; each memory carries its `home`; `degraded` names a home that could not be read. |
| `marshal.tool.linkMemory` | `{id, links, replace?}` | Adds edges to a memory; `replace: true` makes them its only links. |
| `marshal.tool.updateMemory` | `{id, fact?, category?, alwaysOn?}` | Changes a memory in place; its links stay. |
| `marshal.tool.forget` | `{id}` | Deletes a memory node. |
| `marshal.tool.searchSessions` | `{query, scope?, since?, until?, workspace?, limit?}` | Searches this host's sessions and, with an org store, every session any host of the org published (`scope`: `local`, `cloud`, `all`; default `all`). One scorer (`scoreSession` in `session-store.ts`) ranks both. |
| `marshal.tool.getSessionTranscript` | `{sessionId, lastN?}` | Reads a local session, or a published one from the org store. |

## The Brain store (`BrainMemoryRoute`)

A route is one Brain store's memory operations: `create`, `update`, `link`, `delete`, `search` and `list` (types in
`src/memory.ts`, exported from the package). Each write is a graph node or edge at once. Scopes travel as opaque
strings `<id>:<k>=<v>/...`, or `<id>:<name>` for a scope with a bare `name` (`scopeString`), e.g. `brand:brand=<uuid>` and `person:brand=<uuid>/member=<uuid>`.

- The company Brain: `brainCapabilityRoute(id, call, {home?})` maps the route onto the Brain extension's capabilities
  `memory.create`, `memory.update`, `memory.link`, `memory.delete`, `memory.search` and `memory.list`. With `home`, every
  call carries it and the extension uses only that home's Brain: `personal` is its pinned `memoryRoute` (the kit sets
  `zyg`, the company Brain), `workspace` is the route of the session's workspace (`kit.brain.cloudUrl`). With the kit's
  `memory` part the host uses two such routes by default (below), and the kit allows those writes.
- A store held in-process: `typedGraphMemoryRoute({id, execute, tenant, storeOf, merge?})` runs the route on a Quillstone
  typed-graph service's memory ops (`memoryCreate`, `memoryUpdate`, `memoryLink`, `memoryDelete`, `memorySearch`,
  `memoryList`, `memoryGet`; `execute` is `service.execute`). Each scope is its own store (`storeOf(scope)`); writes by
  id look for the id in the session's scopes; `alwaysOn`, `sessionId` and access tags (`accessOf(scope)`) are native fields. A search runs each store's
  own search (its algorithm, unchanged) and merges the stores with `merge` on their raw `lex`/`sim` signals (Marley:
  `fuseAcrossStores`), by default interleaved by rank. Marley uses it for the brand's Spanner graph with scopes brand
  and person (the DM member).

## Prompt

**Loaded when needed (`promptMemories: "relevant"`, the default with the kit's company Brain; Omer R153).** On a
session's turn `prepareTurn` gets the turn's message. A query planner (`decideQueries` on the host's decide service)
reads the whole message (up to 200k characters; a Page Studio brief names its brand only in its input data) and answers
whether it gives a task, the task in one sentence naming its subject, and up to 3 search queries; a message that gives
no task yet (Page Studio opens each session with "reply ready") gets none, and the choice waits for the next turn. The
judgement reads the planner's task sentence, then the message's head and tail. Each home's
Brain `memory.search` runs with each query (`relevantCandidates` hits per query, default 12; without a planner, or when
it fails, the message's head is the query), the lists are interleaved by rank, and a judgement keeps the memories that would change how this task is done: one yes/no question per memory on the
host's decide service (OpenAI Decisions unless `models.decide.provider` names another), kept at probability ≥ 0.5
(`decideRelevance`). At most `relevantLimit` (default 8) are rendered, each with `(memory <id>)`. Being always-on
loads nothing by itself. Without a judgement, or when it fails, the top `RELEVANT_FALLBACK` (3) hits by rank are kept.
Later turns reuse the choice; `marshal.tool.recall` serves lookups mid-task. The host log names what was loaded:
`memory: 2 of 14 memories loaded by relevance (judged) for session <id>: mem_… [workspace], …`.

**Newest (`promptMemories: "newest"`, the default for a host's own `store`, e.g. Marley).** Before each turn the port awaits `prepareTurn`. It reads the Brain only for a scope this host has never seen (its
always-on memories and newest others); every other scope comes from the host's cache (its own writes update it) and is
re-read in the background at most every `refreshMs` (default 60 s) to pick up other hosts' writes, so a turn never
waits on cloud I/O after a scope's first read. The prompt's memory block (`sessionContext.memories`, rendered in the
untrusted-memory wrapper) shows the always-on memories (preferences) of each home in turn, personal first, then the
newest others of every home (`promptLimit`, default 20). The homes are read side by side. `sdkBaseLayer` fills the v2 memory and session-search slots with what the host provides.

## Options (`MarshalHostOptions.memory`)

- `store(session)`: `{route: BrainMemoryRoute, scopes: MemoryScope[], home?}` (broadest scope first), an array of them
  with one `home` each (`personal`, `workspace`), or `undefined`. Default when the kit carries `memory`: a `workspace`
  home `[{id: "workspace", key: {}, name: <workspace>}]` (scope `workspace:<workspace>`) and, when the person is known, a `personal` home
  `[{id: "person", key: {email}}]`; otherwise the session has no memory and the tools answer `unavailable`. A single
  store without `home` (Marley's brand graph) behaves as before.
- `personEmail`: the person this host works for; default `kit.brain.callerEmail`. Never taken from model input.
- The workspace home's `<name>` is `MarshalHostOptions.workspaceName`: the Marshal workspace this host serves (e.g.
  `zygstinct` for a worktree of it), default the folder name. The kit's Brain route has the same name, and the desktop
  lists `workspace:<name>` exactly, so a host in a worktree or scratch path should pass the workspace's own name.
- `promptMemories`, `relevantLimit`, `relevantCandidates`, `relevance` (a `RelevanceJudge`); `newest` mode: `promptLimit`,
  `alwaysOnLimit`, `refreshMs`.

Access is the Brain's: a `person` scope is private to that person (the Brain checks the signed-in caller), a workspace
memory is readable by the company's staff unless written with `audience: "me"`.
