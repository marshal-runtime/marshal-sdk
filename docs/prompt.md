# The host's system prompt

Every SDK host gives its sessions the same base prompt, Marshal agent prompt v2 from `@marshal/agent-runtime-prompt`
(the package the desktop renders from too). A host shapes the prompt by adding **layers**. A host built on top of
another one (the desktop on the SDK, a Slack bot, Marley) adds layers and never rewrites the base, so "same prompt
locally and in production" holds by construction. Code: `src/prompt.ts`; tests: `test/prompt.test.ts`.

## Layers

`MarshalHostOptions.prompt` is a `PromptLayer` (plus an optional `session` callback). Every field is optional.

| Field | What it does |
| --- | --- |
| `surface` | `cloud-headless` (default), `cloud-slack`, `cloud-github`: the package's surface text, shared v2 sections only. Or an injected layer `{id: "desktop", coreSlots, sections}`: the desktop-only v2 sections (delegation, TypeScript, showing results, requests, long-running, tools, extensions) in the host's own words. |
| `core` | What the session holds (`delegation`, `runtime: "trusted" \| "brokered" \| false`, `hostTools`, `memoryBlock`), which decides the fixed v2 sections. |
| `slots` | The host's words for v2's host-dependent spans (`v2SlotIds()`): identity, merge policy, where memory lives, and so on. |
| `role` | `main`, `fork`, `lane`, `reviewer`, `worker`. Default: the SDK's `worker` for a top-level session; a fork always gets `fork` and a lane `lane` unless its own layer says otherwise. |
| `roleText` | The host's own role text in place of the package's for that role. Applies to top-level sessions; forks and lanes get their own role text. |
| `soul` | The persona of this host's agents, a section right after the role. Host-supplied text. |
| `knowledge` | Render v2's knowledge section (a Brain serves the workspace). |
| `extensions` | Render v2's extensions section (desktop surface), with `{notable}` text after it. |
| `tools` | The "Tools on this host" list. The SDK's base fills it with its real tools; a host layer replaces it. |
| `sections` | Sections the host adds: `{id, text}` appended in order, or placed with `after`/`before` a section id (`core.v2.working-loop`, `role.main`, `extra.soul`...). Host and session sections add up. |
| `sessionContext` | Rendered last: `repoRules`, `skills`, `text` (anything the host composed) and `memories` (`{entries, omittedCount}`), which go through the untrusted-memory wrapper exactly as the desktop renders them. |
| `override` | The host's own system prompt instead of all of the above: a string, or `(assembled) => string \| undefined` to edit the assembled prompt. For hosts that are not Marshal-shaped. |

Order of the assembled prompt (a stable prefix first, session text last): `core.v2.*`, the surface, `role.*`,
`workspace`, `org`, `tools`, then `extra.soul`, `extra.knowledge`, `extra.extensions`, the host's appended sections
(`extra.host.*`), and the session context (`extra.context.repo-rules`, `.skills`, `.session`, `.memory`). Placed
sections are `host.<id>` at their anchor.

### Per session

Later wins, field by field: the SDK's base, then `MarshalHostOptions.prompt`, then the session's role (fork or lane),
then the session's own layer from `prompt.session(session)` or `host.setSessionPrompt(sessionId, layer)`.
`host.systemPrompt(sessionId?)` returns what a session gets.

```ts
const host = await createMarshalHost({
  workspacePath, stateRoot,
  prompt: {
    surface: "cloud-slack",
    role: "main",
    soul: "SOUL: warm, direct, brief.",
    sections: [{ id: "house-rule", text: "## House rule\n\nNever book meetings.", after: "core.v2.working-loop" }],
    session: (session) => (session.labels?.persona === "marley" ? { soul: marleySoul } : undefined),
  },
});
```

## The desktop as a layer

The desktop renders the same base with its own layer: `surface: {id: "desktop", coreSlots: DESKTOP_V2_SLOTS,
sections: []}`, `core` from the session (forks, trusted or brokered runtime, host tools), `roleText` from its role
deltas, `knowledge`, `extensions: {notable}`, its browser guidance as an added section and its session context as
`sessionContext.text`. No override. `test/prompt.test.ts` proves it: for five desktop sessions (workspace main, fork
with trusted Node, orchestrator without runtime, tool-free, swarm worker), the SDK's output equals the desktop's own
`assembleMarshalSystemPromptV2` byte for byte. The expected prompts are in `test/fixtures/desktop-v2-prompt.json`,
rendered from desktop `36452cec2`; `node scripts/desktop-prompt-fixture.mjs [desktop checkout]` regenerates them
(it bundles the desktop's assembler with the desktop's own esbuild and runs it in that checkout).

`desktopSurface()` (`src/prompt-desktop.ts`) is that same layer's slots as a ready surface, so a host can run the
`marshal` profile (Marshal's own prompt) instead of the cloud-headless text: `prompt: {surface: desktopSurface()}`. A
cloud host's own facts (`cloudRunLayer`) go on top. `test/prompt.test.ts` pins its slots to the fixture.

The desktop's words (its 24 slot values, role texts, browser guidance, notable-extensions list) stay in the desktop
as its layer; they describe the desktop. Everything the hosts share is already in the package.

## One source for both shells

The layer code (`PromptLayer`, `assembleHostPrompt`, `mergePromptLayers`, `renderMemoryBlock`) lives in
`packages/prompt/src/index.ts`, which depends only on `@marshal/agent-runtime-prompt`. `src/prompt.ts` re-exports it
and adds the SDK host's own pieces (`sdkBaseLayer`, `createHostPrompts`). The desktop vendors `packages/prompt/src`
(pinned commit and content hash, like `packages/providers`) and renders its v2 prompt through `assembleHostPrompt`
with the desktop layer above, so the two shells run the same prompt code, not two that happen to agree.

## Cloud run layer

A sandbox host is not a desktop: nobody is at a screen, nothing can be asked mid-run, results go where the run's
contract says, and the tools are the host's. `cloudRunLayer({job, purpose?, runId?, startedBy?, stateLocation?,
contract?, pageStudio?, kit?, limits?})` (`src/prompt-cloud.ts`) is that host's layer; `page-run` and `page-edit` apply
it (`--started-by`, `--state-location`, `--run-label`, or `MARSHAL_SDK_STARTED_BY` / `MARSHAL_SDK_STATE_LOCATION`).
The SDK's base also lists the Claude backend's native tools now (Bash, Read, Write, Edit, NotebookEdit, WebSearch,
Task for `web-fetch`), and the host serves `marshal.tool.setSessionTodos` (the plan, kept as `todos.json` beside the
transcript), so the v2 core's "plan visibly" step is true on a sandbox.

Rendered prompts (2026-11-16, Page Studio + kit): before, after, and the desktop's workspace-main prompt are in the
overnight tracking folder (`reports/marshal-sdk/lane-b/prompt-*.md`).

| Desktop section (v2) | Sandbox before | Sandbox with the cloud run layer |
| --- | --- | --- |
| Identity ("on the user's own computer") | cloud host "for the people who start your runs" | cloud sandbox for the person who started this run (by email); nobody at a screen |
| How you work a task: "ask once" | "ask once, the way this surface allows" (no way exists) | record the question with `recordDecision` and the default taken |
| How you work a task: `setSessionTodos` | named, **not on the host** | `marshal.tool.setSessionTodos` exists; plan saved with the session |
| Calling Marshal's tools | `runtimeSearch` and TypeScript blocks (desktop tool names) | `mcp__marshal__runtime_exec` operation / inline_module, `runtime_search` |
| Finding information: sessions | `marshal.tool.searchSessions` said to cover the org (it covers this host only) | host store via `marshal.tool.searchSessions`; team index via the kit's `sessions.search` |
| Finding information: memory | `marshal.tool.recall` (**missing**) | `memory.recall` (kit) or "no memory store" |
| Finding information: web | `WebSearch` and `WebFetch` (**no WebFetch**) | `WebSearch`; pages through the `web-fetch` subagent |
| Delegation: forks | v2 desktop section absent; host's forks section | unchanged (`marshal.tool.forkSubagents` exists on the host) |
| TypeScript blocks / Showing results / Track what the user asked / Work that outlives this turn / Extending Marshal / Workspaces / Browser control | absent (desktop-only) | absent: no screen, no request ledger, no automations, one checkout; Page Studio renders pages itself |
| Remembering: personal memory | `marshal.tool.remember` / `forget` (**missing**) | "this run cannot save memories; lessons go in the result" (or `memory.remember` with writes on) |
| Record decisions | kept by the host | kept in the run's decisions record, uploaded with the state |
| Your tools | 3 MCP tools, "do not assume any other tool exists" (**the session also had Bash, Read, Write…**) | runtime tools + the backend's native tools |
| Asking the user | absent | absent; "This run" says there is no chat, no `askUser`, no approval |
| Knowledge: the company Brain | kit section (`knowledge.*`) | kit section; publishing noted when on |
| Skills / Extensions | extension skills + raw guidance | unchanged |
| Your role | worker | worker (Page Studio's own task text sets each agent's job) |
| — | — | **This run**: job, run id, starter, run contract (out/, logs/), state location, published sessions, no messages to people |
| — | — | **Page Studio on this host** (only when `pageStudio` is set; `page-run` and `page-edit` leave it off, because Page Studio itself decides the process) |

## Prompt layers from extensions

An extension can contribute named pieces of system prompt (`contributes.promptLayers: [{ id, file }]`, files inside the package, 256 KB each). A layer is named `<extension identity>#<id>`, for example `@marley/persona#soul`.

An agent profile composes its system prompt from layers: `profile.layers` lists them in the order they are joined (a blank line between pieces), and the profile's own `prompt` file, when it has one, comes last. `prompt` is optional when `layers` is given. A layer's extension must be one of the profile's `extensions` (its own package always is); an unknown layer, an extension that is not installed or one out of scope refuses the resolve. `resolveAgent(packageRoot, agentId, overrides, layerSources)` finds the packages through `layerSources` (identity to package root, or a function); `HostAutomations` passes its `extensions` source.

The profile fingerprint carries the ordered `(layer, extension version, sha256)` list when there are layers, so a changed word in a shared layer changes every profile that composes it. A profile without layers keeps the fingerprint it always had.

A host launch that is not an agent entry (a chat whose prompt the host assembles per turn) uses `resolvePromptLayers(refs, sources, scope?)` and `composePromptLayers(layers, ownText?)` directly and adds its host-filled text after the layers.
