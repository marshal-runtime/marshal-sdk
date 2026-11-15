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

## Part 2: `SessionManager`

`electron/sessions.ts` (the desktop's `SessionManager`, about 14.7k lines) moved with the same mechanism,
unchanged except for its import lines: it is now `src/engine/sessions.ts`, and the desktop's
`electron/sessions.ts` is a re-export of it. Queueing and delivery, the turn state machine, steering, compaction
and the request-ledger re-injection, fork and subagent bookkeeping, and client revive and failover now run from
the SDK tree in both hosts. IPC handlers and the renderer stay in the desktop: they call `SessionManager` as
before, through `electron/ipc/*`.

46 modules moved with it: every module that `sessions.ts` imports whose import closure has no Electron
dependency and is at most 1,300 lines. They include `turn-accumulator`, `session-start-coordinator`,
`session-model-switch`, `runtime-continuations`, `runtime-subagent-mirrors`, `background-task-manager`,
`mcp-status-manager`, `model-manager`, the worktree helpers, `souls`, `untrusted-wrap`, and the contracts
`relay-contract`, `runtime-subagent`, `session-import-contract` and the telemetry error families. They live
under `src/engine/*` (desktop `electron/*`) and `src/common/*` (desktop `common/*`), and each has a re-export at
its old desktop path.

`src/session-engine.ts` builds as `dist/src/session-engine.js` and exports `SessionManager`,
`TurnAccumulator` and `SessionStartCoordinator`. It shares one ports module (`dist/src/engine-host.js`) with
the provider bundle, so a single `configureEngineHost()` call configures both. `test/session-engine.test.ts`
checks this.

### New ports

| Family | Ports |
| --- | --- |
| IPC contract helpers | `DEFAULT_SESSION_NAME`, `isHiddenInternalControlMessage`, `isToolFreeRuntimeAgentRole`, `isVisibleInternalControlResponse` |
| Session store and search | `LocalSessionStore` (class), `readRuntimeTranscript`, `searchSessions`, `isSessionHiddenFromList`, `isSessionHiddenFromSearchAndDelete` |
| Views | `ViewEmissionManager` (class), `STUCK_TIMEOUT_MS`, `clearAvatarCache` |
| Busy state | `BusySessionTracker` (class) |
| Transcript state | `buildImportedConversationState`, `buildTranscriptConversationState`, `reconcileWithTranscript` |
| Agent messages | `describeAgentMessageSendTime`, `isAgentMessageDeliveryControlError` |
| MCP | `getMcpStatus` |
| System prompt | `buildSystemMessage`, `applyRuntimeAgentStrategy`, `buildSdkDefaultSubagentSystemContent`, `buildRelayAttentionSection`, `buildSoulPrompt`, `getSoulGreeting`, `formatBundledWorkspaceFile`, `assembleMarshalSystemPrompt`, `assembleMarshalSystemPromptV2`, `V2_*` tool lists, `SPAWN_ONLY_SKILL_NAMES`, the lean-prompt and agent-prompt-v2 resolvers |
| Skills | `createSkillCatalog`, `getSkillsForSystemPrompt` |
| Workspaces | `getWorkspaceRegistry`, `getWorkspaceRoot`, `listRegisteredWorkspaces`, `registerExistingWorkspace`, `registerManagedWorkspace`, `resolveRegisteredWorkspace`, `validateWorkspaceName`, `workspaceDisplayName`, `normalizePathForCompare` |

The desktop registers these in `electron/backend/engine-host/engine-sessions.ts` (and one wiring file per moved
module that uses ports), with lazy getters, so `vi.mock` of a desktop module still reaches the engine.

### Known gaps

- **The SDK does not typecheck `src/engine`.** The SDK's host binding declares desktop types as open shapes,
  and the 14k-line `SessionManager` relies on their real structure. The desktop typechecks the engine against
  its real types on every build, so the code is checked, but only from the desktop. The folder becomes
  checkable here as its types move into `src/contract/host-types.ts`.
- **An SDK host must supply the class ports** (`LocalSessionStore`, `ViewEmissionManager`, `BusySessionTracker`)
  and the prompt and workspace ports before it can run a `SessionManager` headless. The desktop supplies its
  own. Implementing them for the SDK host is the next step, and it belongs to the integration work that runs
  the desktop on the SDK host.
- A few small helpers now exist both here and in `packages/permissions`. Part-1 ports for modules that later
  moved (for example `model-manager`) could become direct imports.
