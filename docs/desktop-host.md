# The desktop's runtime host in the SDK

The Marshal desktop and the SDK run one runtime host: `MarshalRuntimeHost`, the composition of the kernel, extensions,
UI, permissions routing, agents, Brain and memory that the desktop built in `electron/marshal-runtime`. Its source lives
in `packages/host/src` at the desktop's own paths, byte for byte, so the desktop builds it unchanged inside Electron and
the SDK builds it into `dist/host-runtime.js` for plain Node.

```ts
import { configureHostPlatform, MarshalRuntimeHost, ProductionMarshalRuntimeApi } from "@marshal/sdk/dist/host-runtime.js";
```

## How the copy stays one copy

- `node scripts/vendor-desktop-host.mjs sync <desktop checkout>` (`npm run vendor:host -- <checkout>`) copies the set:
  every file under `electron/marshal-runtime`, the contract files `electron/backend/{ports,runtime-contract}.ts`, and
  everything they load at run time (value imports, dynamic imports, `?raw` sources, the `@common/*` alias). It records
  the list in `packages/host/FILES.json` and the commit and content hash in `packages/host/SOURCE.json`.
- Modules the host only names in types (desktop sessions, IPC, relay, settings) are not shared. `sync` writes a
  generated declaration stub for each (`*.d.ts`, first line `// generated-stub`) so the package typechecks here; stubs
  are not hashed and never go back to the desktop.
- `test/host-source.test.ts` fails when `packages/host/src` no longer matches `SOURCE.json`, and, with a desktop
  checkout (`MARSHAL_DESKTOP_DIR`, or a sibling `marshal` folder), when the desktop's files differ or the desktop host
  now loads a file outside the set. The desktop's own `scripts/marshal-host-source.test.ts` checks the same hash from
  its side, so a change on either side without a sync fails a test.
- Electron: the only Electron use in the set is `app` (`app-paths.ts`, `overlay-review.ts`). Outside Electron,
  `electron` resolves to `packages/host/platform/electron.ts`; `configureHostPlatform({paths, isPackaged, version})`
  sets what `app.getPath`, `app.isPackaged` and `app.getVersion` return.
- The three packs the host imports besides the SDK's (`@marshal/swarm`, `@marshal/overlay-review`,
  `@marshal/agentic-debugger-extension`) are vendored in `vendor/packs` like the rest.

`test/host-runtime.test.ts` starts the shared host from `dist/host-runtime.js` on the pinned packs with no Electron and
serves a runtime search.

## What the desktop passes, and where it comes from on another host

Every option the desktop gives `new MarshalRuntimeHost({...})` (`electron/main.ts`). A headless host passes the left
column it needs; the right column says what the desktop supplies, so you can see what a host without it loses.

| Option | Desktop supplies | Headless host |
| --- | --- | --- |
| `location` | `{isPackaged, appPath, resourcesPath}` of the app | `{isPackaged: false, appPath: <SDK root>, resourcesPath: <SDK root>}` |
| `hostWorkspacePath`, `protectedLifecycleResultRoot`, `worktreeRoot`, `trustedExtensionRoot` | folders under `~/.marshal/marshal-runtime` | folders under the host's `stateRoot` |
| `authority` | scope resolution from the session store + `PermissionPolicy` decisions | a resolver for its sessions; allow-all or a configured policy (`sdk permissions`) |
| `approval` | permission cards (`approval-broker.ts`) | none (no person to ask) or a route to a person |
| `catalog` | tools, skills (three tiers), workspaces, session context | its tools and extension skills |
| `agents` | `marshal.agent.*` through the desktop's sessions | the SDK agent port |
| `brain`, `memory`, `memoryProviderRegistry` | Brain client, personal memory store | kit Brain/memory, or none |
| `serviceContainer`, `compositionRegistry`, `ownedServiceBindings` | the desktop's container with org, rooms, secure storage | `createRuntimeServiceContainer()` and the host's services |
| `ui` (`delivery`, `issueDocumentAccess`, `overlayReview`) | renderer delivery, document access, overlay review | omitted: no UI |
| `additionalProviderSources` | selected session, application jobs/sessions, cloud sessions, session import, org sessions and rooms, UI image, app lifecycle, health cleanup, UI observe/layout/introspection, swarm delegation | the host's own providers (decisions, forks, automations, kit) |
| `nodeExecutable`, `trustedTypeScript` | bundled Node; trusted TypeScript on | `process.execPath`; trusted per host |
| `admitExtension`, `onInstalledExtensions`, `restrictedServices` | org extension admission and service gating | org admission from the manifest (`sdk org service`) |
| `applicationAuthority`, `onApplicationInvalidated`, `resolveApplicationWorkspace` | runtime UI applications | omitted |
| `extensionSecrets` | `safeStorage` | a secret port (file, env, vault) |
| `resolveOrganization` | org identity of the signed-in person when rooms are on | the org token's identity (`R18.1`) |
| `resolveDelegationIdentity` | delegation ids from the session store | the agent port's session ids |
| `agenticBrowser`, `firstPartyExtensions` | browser executor, bundled first-party extensions | optional |
| `startupDelayMs`, `warmUiCompiler`, `diagnostics` | acceptance harness only | omitted |

## What is not shared yet

- `createMarshalHost` (`src/host.ts`) still builds its own smaller composition on `createAgentRuntime`. The next step
  is to build it on `MarshalRuntimeHost` with the right column above, so a headless host and the desktop are the same
  host with different ports.
- The session engine (`electron/backend/local`), permission policy and org service are separate lanes
  (`sdk session engine`, `sdk permissions`, `sdk org service`).
