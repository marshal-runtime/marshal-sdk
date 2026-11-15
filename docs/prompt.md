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

The desktop's words (its 24 slot values, role texts, browser guidance, notable-extensions list) stay in the desktop
as its layer; they describe the desktop. Everything the hosts share is already in the package.
