# Host options: what an embedder passes in

`createMarshalHost` runs unattended by default: every capability call and tool call is allowed, runtime state sits
in the workspace, and sessions see the runtime's own tools (`runtime_search`, `runtime_exec`,
`runtime_read_resource`). A host that has more to give passes it in. The fields are `MarshalHostPorts`
(`src/host-options.ts`), and their shapes are the ones the Marshal desktop passes to its own runtime host
(`electron/marshal-runtime/host.ts`, `MarshalRuntimeHostOptions`). Each field is optional. Leaving one out keeps
today's behavior.

| Option | What it does | Desktop equivalent |
| --- | --- | --- |
| `permissions.broker` | Decides each capability call. It runs after the kit's guard (Brain writes stay denied unless the kit allows them). The first broker that doesn't allow a call decides it. | `permissionBroker` over `decidePermission` |
| `permissions.approval` | The runtime's `permissionApproval`: requests that wait on a person, plus verification afterwards. | `approval.permissionApproval` |
| `permissions.resolveGrants`, `permissions.patterns` | Dynamic grants from a persisted policy, and extra principal permissions. | the runtime's `resolvePermissionGrants` / `permissionPatterns` |
| `permissions.canUseTool` | Decides the model backend's own tool requests (shell, file writes, MCP tools) in the desktop's `RuntimePermissionRequest` shape, with the Marshal session id. When it's given, sessions stop running with `bypassPermissions`. On the Claude Agent SDK it becomes `canUseTool` (mapped the way the desktop's Claude client maps it). On provider clients it becomes `onPermissionRequest`. | each backend's `onPermissionRequest` |
| `ui.applicationAuthority` | Decides first for calls an application owns. | `applicationAuthority.decide` |
| `ui.reactUi`, `ui.declarativeUi`, `ui.placementsRequired` | View compilation, declarative UI, and whether an extension's tabs need a placement. | `createMarshalReactUiOptions()`, extension options |
| `runtimeRoot` | An absolute, host-private folder for runtime state (`<runtimeRoot>/state`), outside every workspace. Calls still work in the session's workspace through `resolveWorkspace`. Default: `<workspace>/.marshal/runtime/<hash>`. | `hostWorkspacePath` + `stateDirectory: "state"` |
| `resolveWorkspace` | Which workspace a call works in, for hosts that serve several. | `resolveWorkspace` |
| `worktreeRoot` | An absolute folder for isolated worktrees, outside the workspace. | `worktreeRoot` |
| `providerSources` | The embedder's capability providers, registered before the SDK's own. | `additionalProviderSources` |
| `serviceContainer`, `compositionRegistry` | The embedder's container (rooms, Brain and memory services bound by the host). Its providers resolve those services from it. | `serviceContainer`, `compositionRegistry` |
| `nodeExecutable` | The Node binary for TypeScript modules and the browser MCP server. A packaged app's `process.execPath` is the app, not Node. | `nodeExecutable` |
| `trustedTypeScript` | `true` uses the desktop's trusted import policy (every package and builtin, `trusted_node` execution). You can also pass a policy. | `trustedTypeScript` + `TRUSTED_TYPESCRIPT_IMPORT_POLICY` |
| `builtins` | Runtime built-ins over the SDK's defaults: limits, effects, extension authoring. | `createRuntimeBuiltinsSource` options |
| `telemetry` | Host events with metadata only: `host.started`, `extension.installed`, `runtime.<lifecycle>`, `session.idle` / `session.failed`, `settings.changed`. | `diagnostics` |
| `notifications` | Where `marshal.tool.sendNotification` goes. The capability is offered only when this is set. | the notifications self-tool |
| `settings` | A live settings store: new sessions take its current `model` and `reasoningEffort`, and a `subscribe` call reports each change. | settings store + change events |
| `secrets` | Secrets by name from the host's store, asked before the environment's `NAME` and `NAME_FILE`. The store's values never appear among a child process's environment keys. | safeStorage-backed credentials |
| `directTools`, `runtimeTools` | Tools the model sees directly, registered by the embedder. `desktopDirectTools(z)` gives `runtimeSearch`, `runtimeInvoke`, `runtimeExecuteTypeScript` (the desktop's body wrapping and compact result), `runtimeReadResource` and `forkSubagents` over this host's runtime. `runtimeTools: false` hides the runtime's own names, and the prompt names what sessions really have. | `V2_EXPOSED_HOST_TOOLS` |

```ts
import { z } from "zod";
import { createMarshalHost, desktopDirectTools } from "@marshal/sdk";

const host = await createMarshalHost({
  workspacePath,
  stateRoot: "/var/lib/my-host/state",
  runtimeRoot: "/var/lib/my-host/runtime",
  permissions: {
    broker: myPolicy, // capability calls
    canUseTool: async (request, { sessionId }) =>
      request.kind === "shell" ? askAPerson(sessionId, request) : { kind: "approve-once" },
  },
  trustedTypeScript: true,
  directTools: desktopDirectTools(z),
  runtimeTools: false,
  secrets: (name) => keychain.read(name),
  telemetry: (event) => metrics.emit(event.name, event.details),
  notifications: (note) => push(note),
  settings: { read: () => store.current(), subscribe: (listener) => store.on("change", listener) },
});
```

## Not ported in this pass

- **Extension secrets** (the desktop's `extensionSecrets` module) and **extension admission hooks** (`admitExtension`,
  `onInstalledExtensions`) are not ported. The SDK installs a fixed extension list at start.
- **UI delivery ports** (`ui.delivery`, the document access issuer, overlay review) have no SDK equivalent. A host
  without a renderer has nothing to deliver views to, and `ui.reactUi` only makes compilation available.
- **The desktop's agentic browser executor and its first-party extension list** stay desktop-only.
