# North star: the Marshal desktop on top of the SDK

Not scheduled. This is what it would take for the desktop app (`OmerMachluf/marshal`) to run its agents, sessions and
tools through `@marshal/sdk`, so that a desktop session and an SDK session are the same thing in two shells. Desktop
references are to `origin/main` f779c44e9 plus the SDK-hosts change (desktop PR "SDK host sessions"); SDK references
are to this repository's `main` (2026-11-15).

## Where the two stand today

| Concern | Desktop | SDK | Shared already |
| --- | --- | --- | --- |
| Runtime kernel, extensions, capabilities | `electron/marshal-runtime/*` over the `@marshal/runtime` + `agent-runtime-*` packs | `MarshalHost` (`src/host.ts`) over the same packs | Yes: the same tarballs, checked by `check:packs` |
| Agent execution | `ISessionBackend` per runtime (`electron/backend/{claude,copilot,codex,cursor,gateway}`), driven by `SessionManager` (`electron/sessions.ts`) | The same engine: `LocalBackend` from `packages/providers/src/backend/local` (the desktop's `electron/backend/local`, lifted), driven per Marshal session by `ClaudeAgentPort` through `createEngineQuery` (`src/engine-query.ts`), on Claude, Codex or Cursor | Yes: the engine code (2026-11-15); the session lifecycle above it (`SessionManager` vs `ClaudeAgentPort`) not yet |
| Session storage | `LocalSessionStore` + `sessions-index.json`, partitioned by `runtimeId` | `FileSessionStore` (`src/session-store.ts`): `index.json`, `transcript.jsonl`, `events.jsonl`, native ref | No (the desktop imports SDK conversations through `importClaudeTranscript`) |
| Marshal tools (`marshal.tool.*`) | `electron/self-tools.ts` (~4.3k lines) | `src/agent-provider.ts`, `forks.ts`, `automations.ts`, `decisions.ts`, `kit/` | Names and shapes, not code |
| Permissions | `PermissionPolicy` + permission cards (interactive) | `PermissionBroker`, allow-all for the POC (`kit/index.ts`) | The broker interface |
| Remote sessions | Org remote threads (`electron/org/*`) and, new, linked SDK hosts (`electron/sdk-hosts/*`, link protocol v1 client) | Link server/client (`src/link/*`, `docs/link.md`), org bridge (`src/org-bridge.ts`) | The link protocol and the org contract |
| UI | Renderer over typed IPC | None (the viewer extension is a Marshal extension) | Not needed |

## The mapping

- **SDK host = the desktop main process's agent half.** One `MarshalHost` per desktop, created in `electron/main.ts`
  (the composition root), owns the kernel, extensions, agent port, session store, automations and decisions. The
  desktop keeps windows, IPC, auth, MCP children and the renderer.
- **Agent port = a backend.** `ClaudeAgentPort` becomes an `ISessionBackend` implementation in
  `electron/backend/sdk-claude/` (rule 4). Copilot, Codex, Cursor and Gateway stay desktop backends until each has an
  agent port of its own; the SDK grows an `AgentPort` interface so the second one does not fork the code.
- **Session store = the desktop's session content.** `SessionRecord` gains `runtimeId` and `backendOrigin` (the
  desktop's durable partition, CLAUDE.md invariant), and the desktop index row is derived from the record, not stored
  beside it.
- **Link = the desktop's remote-host source, both ways.** The desktop already reads and drives SDK hosts over link v1.
  The step after is the desktop serving link v1 over its own store, so a desktop is just another host to a phone, a
  cloud run or another desktop.

## In order

1. **One pack pin.** The desktop and the SDK resolve the same `@marshal/runtime` and `agent-runtime-*` builds from one
   manifest. Done: `scripts/vendor-packs.mjs --from <desktop>` copies the desktop's pinned tarballs into
   `vendor/packs` (source commit and hashes in `SOURCE.json`); `npm run check:packs -- --desktop <checkout> [--ref
   origin/main]` and `test/pack-pins.test.ts` (with `MARSHAL_DESKTOP_DIR`, or a sibling `marshal` checkout) fail
   when the two differ by archive name or bytes. Each pack keeps its own build number (runtime host-88 next to claude
   host-78 is the desktop's own pin set, not drift).
2. **Converge the session record.** Add `runtimeId`, `backendOrigin`, `workspace` and `effort` to the SDK
   `SessionRecord`; write a two-way mapping to the desktop index row with tests on real rows from both. Desktop keeps
   its files; nothing moves yet.
3. **A `MarshalHost` inside the desktop for headless work.** Extension-launched agents (`marshal.agent.*`) and
   automations run on an in-process SDK host whose store sits under `~/.marshal/marshal-sdk/`. Their sessions show up
   through the SDK-hosts source as a local host (no network), which proves the read, search, drive and continue paths
   on real desktop traffic.
4. **Claude chats on the agent port.** `electron/backend/sdk-claude/` implements `ISessionBackend` over
   `ClaudeAgentPort` + `FileSessionStore`; a setting picks it per new Claude session, with a conformance case for every
   method (rule 5). The old Claude backend stays until parity is shown on the e2e suite.
5. **Tools move into SDK providers.** Self-tools move one family at a time (sessions, forks, memory, automations,
   decisions, goals) into SDK capability providers that both shells register; `self-tools.ts` keeps only desktop-only
   tools (windows, UI, settings).
6. **Permissions as a broker.** `PermissionPolicy` and the card manager become a `PermissionBroker` the desktop passes
   to its host, so the same policy gates an SDK tool call and a desktop one. Headless hosts keep allow-all or a
   configured policy.
7. **The desktop serves link v1.** A local link server over the desktop's own store (loopback by default, token in safe
   storage) makes desktop sessions readable and drivable from any Marshal; org publishing reuses the SDK's
   `org-publish` path instead of the desktop's own.
8. **`SessionManager` shrinks to an adapter.** Session lifecycle, queueing and fork bookkeeping move to the host;
   `electron/sessions.ts` keeps the IPC and renderer concerns. Other runtimes join as agent ports when each is worth it.

## Headless hosts on the shared engine (2026-11-15)

`createMarshalHost` runs every provider-client turn (Claude client, Codex, Cursor) on the desktop's session engine:
`createEngineQuery` keeps one live `LocalBackend` session per Marshal session, the way the desktop keeps one per chat,
and resumes it by its native id in a later run. The host's Marshal tools, MCP servers and permission handler reach the
engine per session (`EngineBackend`: the engine's exclusive-session-tools path, `prepareMcpConfig`, the approval
callback); the engine's process-wide ports get headless implementations (`src/headless-engine.ts`) unless an embedder (the
desktop) configured them first. Session records carry the desktop's `runtimeId` and `backendOrigin`.

## One runtime host (2026-11-15)

`createMarshalHost` composes its runtime on the desktop's own `MarshalRuntimeHost` (`packages/host`, the desktop's
`electron/marshal-runtime` byte for byte), through `src/shared-runtime.ts`: the same kernel, extension manager,
built-in capabilities, UI options and lifecycle as the desktop. The SDK plugs its parts in through the host's options:
its capability providers as `additionalProviderSources`, its permission brokers as the `applicationAuthority` (they
see the whole check and decide finally), its durable scheduler and built-in overrides through `builtins`, and its
principal and harness id. Built-ins now follow the desktop's defaults (TypeScript, React UI options, output limits)
under the SDK's own overrides.

Still different from the desktop: the session lifecycle above the engine (`ClaudeAgentPort` vs `SessionManager`);
turns that need the Claude Agent SDK (structured output, launch hooks, CLI flags, turn caps, a fork at an earlier
message), which still run on it; a model backend's permission request is normalised twice (engine, then
`canUseTool`); the engine's trace logs go to stdout; and `permissions.approval`, `resolveGrants` and `patterns` are
not taken by the shared host (it logs that; brokers and `canUseTool` decide).

## What stays hard

- Multi-runtime: the SDK is Claude-only; the desktop's five runtimes and their invariants (Gateway rows never
  reinterpreted as Copilot) must survive steps 2, 4 and 8.
- Interactive permissions: cards need a broker that can wait on a person; the SDK host wires allow-all or a fixed deny
  list (`kitPermissionBroker`) today, and nothing yet routes a pending tool call to someone.
- Packaged build: the host must run from the bundled Node and resources outside `app.asar`, on macOS and Windows.
- Migration: existing desktop sessions (index + LocalSessionStore + SDK-side state) must open unchanged after step 4;
  step 2's mapping is the tool for that.
