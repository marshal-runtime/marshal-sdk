# North star: the Marshal desktop on top of the SDK

Not scheduled. This is what it would take for the desktop app (`OmerMachluf/marshal`) to run its agents, sessions and
tools through `@marshal/sdk`, so that a desktop session and an SDK session are the same thing in two shells. Desktop
references are to `origin/main` f779c44e9 plus the SDK-hosts change (desktop PR "SDK host sessions"); SDK references
are to this repository's `main` (2026-11-15).

## Where the two stand today

| Concern | Desktop | SDK | Shared already |
| --- | --- | --- | --- |
| Runtime kernel, extensions, capabilities | `electron/marshal-runtime/*` over the `@marshal/runtime` + `agent-runtime-*` packs | `MarshalHost` (`src/host.ts`) over the same packs | Yes: same packages, separate pins |
| Agent execution | `ISessionBackend` per runtime (`electron/backend/{claude,copilot,codex,cursor,gateway}`), driven by `SessionManager` (`electron/sessions.ts`, ~14.7k lines) | `ClaudeAgentPort` (`src/agent-port.ts`), Claude only | No |
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
   manifest (today: desktop `.marshal-runtime-packs/archives/*.tgz`, SDK `package.json` 0.1.0). Without this, a
   capability can behave differently in the two shells.
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

## What stays hard

- Multi-runtime: the SDK is Claude-only; the desktop's five runtimes and their invariants (Gateway rows never
  reinterpreted as Copilot) must survive steps 2, 4 and 8.
- Interactive permissions: cards need a broker that can wait on a person; the SDK host wires allow-all or a fixed deny
  list (`kitPermissionBroker`) today, and nothing yet routes a pending tool call to someone.
- Packaged build: the host must run from the bundled Node and resources outside `app.asar`, on macOS and Windows.
- Migration: existing desktop sessions (index + LocalSessionStore + SDK-side state) must open unchanged after step 4;
  step 2's mapping is the tool for that.
