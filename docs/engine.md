# The session engine

The SDK and the Marshal desktop run sessions on one engine: the desktop's local session backend, which used
to live in `electron/backend/local`. This page covers what moved, how a host plugs in, and the plan for the
second half, the engine part of the desktop's `SessionManager`.

Desktop references are to `OmerMachluf/marshal` main `36452cec2`.

## What moved

The engine sits in the provider tree that the desktop already vendors (`packages/providers/src`, copied
into the desktop as `packages/marshal-providers/src` and pinned by commit and content hash). It sits there
rather than in a separate package so that its relative imports resolve the same way in both repositories.

| Desktop file (before) | Now |
| --- | --- |
| `electron/backend/local/{provider,session,tools,automation,permissions,approval-adapter,internal,peer-clients,session-client,client-process,capabilities,strategy,runtime-auth,repository-customizations,tool-surface,ask-user-result}.ts` | `src/backend/local/*` |
| `electron/backend/normalize-event.ts` | `src/backend/normalize-event.ts` |
| `electron/backend/types.ts` (`ISessionBackend`, `IBackendProvider`, `BackendEvent`, execution envelopes) | `src/backend/types.ts` |
| Pure helpers the engine calls: `common/{marshal-sdk-builtin-tools,mcp-server-key-normalization,model-runtime-routing,runtime-qualified-model,workspace-role-identity}.ts`, `electron/{error-formatting,workspace-role-identity,ipc/with-timeout,foundation/yaml/skill-fields,platform/browser-egress-config,platform/security/browser-tools/{names,write-path}}.ts` | `src/common/*`, `src/support/*` |

The code is the desktop's code. Only its import lines changed: an import of a desktop service now names
`../engine-host` (a value) or `host/engine-host-types` (a type), with the same names as before. The desktop
keeps a one-line re-export at every old path, so nothing else in the desktop changed.

## Ports

`src/backend/engine-host.ts` holds everything the engine needs from its host. A host calls
`configureEngineHost(services)` before it creates a backend, with every port or a part of them; later calls
add to earlier ones, and getters are kept as getters. The desktop registers each engine module's ports next
to that module (`electron/backend/engine-host/<module>.ts`, imported by the module's shim), so a desktop
process loads exactly the services each module used to import, and a test's `vi.mock` of a desktop module
still reaches the engine. A port that was never supplied throws on first use: `The Marshal session engine
has no host port "<name>": call configureEngineHost() first`.

| Family | Ports |
| --- | --- |
| App identity | `app.getVersion()`, `app.isPackaged`, `APP_NAME` |
| Paths and workspace | `getAppDataDir`, `getActiveWorkspaceRoot` |
| Files | `secureMkdir`, `secureMkdirSync`, `secureWriteFileSync`, `secureAppendFile` |
| MCP | `buildMcpConfig`, `loadMcpBrokerManager` |
| Marshal's tools | `getSelfTools`, `getSelfFsTools` |
| Tool backgrounding | `runToolWithBackgrounding`, `backgroundToolObservation`, `NEVER_BACKGROUND_TOOL_NAMES` |
| Permissions | `DEFAULT_PERMISSIONS`, `normalizePermissionRequest`, `getCommandText`, `isReadOnlyCommand`, `extractPattern`, `applyGuardrails` |
| Prompt context per turn | `buildUserPromptContext`, `describeRequestCompaction`, `describeSessionViews`, `getSessionClientViewport`, `takeSessionMentionContext`, `takeSharedSessionContext` |
| Session contract | `resolveSessionToolAllowlist`, `AskUserToolResultSchema` |
| Models | `normalizeDiscoveredModels` |
| Telemetry | `sendErrorTelemetry`, `makeSessionError`, `sessionErrors`, `sanitizeForTelemetry` |

The permission ports go away once the shared permission policy lands in this repository: the engine then
imports it directly.

### Types

Some types the engine names (`MSettings`, `SessionMessage`, `StoredSession`, `IPermissionPolicy`,
`ISelfToolDeps` and others) are defined by the desktop's IPC contract and service ports. The engine imports
them from `packages/providers/host/engine-host-types.ts`, which sits outside the vendored `src` tree, so
each repository has its own copy:

- **Desktop:** `packages/marshal-providers/host/engine-host-types.ts` re-exports the desktop's real types,
  and `EngineHostServices` is typed with `typeof` of the desktop's own functions. The desktop typechecks
  the engine exactly as before.
- **SDK:** the same names are open shapes (`any`), except for the few ports whose shapes the engine relies
  on, which are typed. Each type becomes strict here when its definition moves into the shared contract
  (`src/contract/host-types.ts`), as `ModelInfo`, `MessageToolCall` and `SessionSandboxConfig` already have.

### Using it from an SDK host

```ts
// The provider bundle (src/providers.ts -> dist/src/providers.js) carries the engine.
import { configureEngineHost, LocalBackend } from "./providers.js";

configureEngineHost(myHostServices);
const backend = new LocalBackend({ workspaceDir, clientFactory, strategy });
const handle = await backend.sessions.create({ sessionId, systemMessage });
backend.sessions.subscribe(sessionId, (event) => render(event));
await backend.sessions.send(sessionId, { prompt });
```

`test/engine.test.ts` runs exactly this, with plain functions as the host and a provider double: create,
send, streamed `text-delta`, `turn-complete`, `idle`, and the session config trace written to the host's
app data directory.

## Next: the engine half of `SessionManager`

`electron/sessions.ts` is 14.7k lines: 532 methods, 122 private fields and 125 import lines. About two
thirds of it is the engine: the turn loop, delivery and queueing, fork bookkeeping. The rest is desktop
product: IPC, views, relay, goals, workflows. The engine half moves the same way the backend did, with a
new set of ports.

### Moves to the engine

| Concern | Where in `sessions.ts` |
| --- | --- |
| Turn lifecycle: send, steer, cancel, stop, wait, busy/idle, pending sends, turn state | `sendMessage` 12147, `performSendMessage` 12473, `steerMessage` 12101, `cancelTurn`/`performCancelTurn` 11862/11981, `stopSession` 11891, `waitForIdle` 11789, `beginPendingSend`… 7365–7398, `markBusy`/`markIdle`/`getTurnState` 13792–13803 |
| Event intake and turn accumulation, live-turn checkpoints | `subscribeToBackendEvents` 6174, `getAccumulator` 2616, `persistLiveTurnCheckpoint`…`promoteLiveTurnCheckpoint` 2648–2699, `appendMessage` 2511 |
| Backend session create/resume/recreate/refresh | `createBackendSession(Attempt)` 5395–5859, `createSessionLocked` 7903, `refreshSession` 13399, `recreateSessionBackendWithLatestConfig` 13689 |
| Compaction and post-compaction context | `compactSession` 13525, `registerContextCompactedHook`/`notifyContextCompacted` 2953–2974 |
| Runtime switch and cross-provider handoff | `prepareRuntimeHandoff` 5997, `performBackendRuntimeSwitch` 5939, `moveSessionToCurrentRuntime` 6119, `switchBackend` 6153 |
| Agent messages, queue and continuations | `deliverAgentMessage` 1873, `acceptAgentMessage` 11119, `sendMessageToSession`/`ToSubagent`/`ToParent` 10758/10708/11072, runtime continuations 10887–10935, `sendAndCollect` 12982 |
| Forks and subagents: launch, readiness wakes, yield | `forkSubagentSessions` 9785, `createSubagentSession(Deferred)` 9626/10212, `listForkSiblings` 10115, readiness wakes 6566–7185, subagent yield 2150–2236 |
| Running and background tools | 3779–4427 (`listRunningTools`, `claimBackgroundToolDispatch`, `inspectRunningTool`, `cancelRunningTool`…) |
| Idle reaper and pause | `startIdleSessionReaper` 6551, `reapIdleSessions` 7185, `pauseSession` 7236–7343 |
| Client and auth lifecycle | `checkAuthStatus` 3238, `initClient` 3307, `reviveClient` 3549, `login` 3568, `signOut` 3472 |
| Per-session model, effort and context tier | 13807–14645 |

### Stays in the desktop, behind ports the engine calls

| Concern | Where | Port the engine needs |
| --- | --- | --- |
| View emission, hydration, list listeners | 2729 (`ViewEmissionManager`), 8327, 11284–11424 | an event sink |
| System prompt assembly | 4564–4996 (`buildSystemMessage`) | the SDK prompt layers (desktop adds sections) |
| Relay (WhatsApp and other channels) | 2769–2832, 10941–11036 | a delivery-origin hook |
| Goals and workflows | 3056–3172 | a turn-boundary hook |
| Request ledger | 2832–2953 | a ledger port (reminders, compaction context) |
| Permission cards, reviewer scopes | 5331–5364, 9009 | the approval port from the permission policy |
| Session list decoration (unread, pinned, souls) | 9016–9330, 14673 | none: read from the store |
| Worktrees and workspace registry | 10408–10688, 9371–9494 | a workspace resolver port |
| Command center | 4427–4457 | the event sink |
| Session index and content store | `SessionIndexWriter`, `LocalSessionStore` | a session store port (`runtimeId`/`backendOrigin` partition kept) |

### Order

1. **Inside the desktop first.** Extract a `SessionEngine` class from `sessions.ts` that holds the "moves"
   rows and reaches the "stays" rows only through the ports above. `SessionManager` becomes a thin facade
   that keeps its public methods and IPC behavior. The ~30 `sessions-*.test.ts` suites and
   `conformance.test.ts` must pass unchanged. This is the big step: about one to two weeks, done family by
   family, each in its own PR.
2. **Lift it here with the same mechanism** used for the backend: same tree, import lines only, the
   desktop's old path re-exports it, and the vendored hash pins it.
3. **Make the SDK host run sessions through it.** `ClaudeAgentPort`'s per-turn query becomes an adapter
   over `SessionEngine` plus `LocalBackend`. The SDK session store implements the store port and gains
   `runtimeId`/`backendOrigin`. After this step a desktop session and an SDK session are the same object
   in two shells.
