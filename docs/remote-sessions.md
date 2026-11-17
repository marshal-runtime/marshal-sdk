# Sessions whose Claude Code runs on another machine

A host can start a session's Claude Code elsewhere (a sandbox VM, another user) with the launch option
`spawnClaudeCodeProcess`. The SDK gives such a session the host's tools itself; a host builds no server, tunnel or token.

## How the tools reach the remote CLI

The host's `marshal` server is an in-process SDK MCP server. The Claude Agent SDK keeps it in this process and carries
every call over the Claude Code process's own control channel (`control_request` / `mcp_message` on the stdin/stdout
the spawner returns), so a CLI on another machine reaches it through the spawner's connection. Nothing listens on a
port, so there is no endpoint to reach and no token to mint, rotate or revoke: the server lives and dies with the
session's process.

## `remoteRuntime(session)`

`createMarshalHost({ remoteRuntime })` returns, for a remote session, how the host reaches that machine's own Marshal
runtime MCP server over stdio: `{command, args?, env?, cwd?}` (Marley: the ssh command that starts the brand VM's runtime
for that chat). For such a session the `marshal` server carries:

| Tool | Runs on |
| --- | --- |
| `runtime_search`, `runtime_exec`, `runtime_read_resource` | the remote machine's runtime (model-selected tools and code never run on the host) |
| `runtime_exec {targetType: "operation", target}` with a target in `REMOTE_HOST_TOOLS`, and `runtime_search {name}` for one | the host; the session tools see the whole host store unless `sessionScopeLabel` is set (below) |

`REMOTE_HOST_TOOLS` is fixed: `marshal.tool.forkSubagents`, `listSubagents`, `messageSubagent`, `messageForks`,
`searchSessions`, `getSessionTranscript`, `remember`, `recall`, `linkMemory`, `updateMemory`, `forget`, `recordDecision`.
`createMarshalHost({ remoteHostTools })` narrows that set to a subset (default: all of it); a host tool outside it is refused on the
host and never forwarded. `createMarshalHost({ sessionScopeLabel })` bounds the session tools for a host whose store holds several tenants (Marley:
`brand`): searchSessions and getSessionTranscript see only sessions whose label equals the caller's (forks copy their
parent's labels; an org row matches on its partition keys too, `{...row.part, ...row.labels}`, so a row without the label matches no scoped caller), and the fork tools act only for a calling session on its own children. `createMarshalHost({ remoteEmbedderTools })` adds named capabilities of the embedder's own `providerSources` (state only the host holds; Marley: `marley.runs.today`, `marley.extension.list`); each is answered on the host and its provider bounds the call to the calling session (`context.scope.sessionId`). No other host capability is reachable (no generic forwarding), and a TypeScript block (`inline_module`) runs on the
remote runtime only. A remote session gets no host browser server and no host runtime for other providers. Embedder
direct tools route their runtime calls the same way.

Tool names are the local ones (`mcp__marshal__runtime_exec`, `marshal.tool.*`), so the prompt is the same local or
remote.

The host opens one remote connection (one child, e.g. one ssh) per session at its first runtime call and keeps it across
turns. It closes with the session: the live process closes, the host is disposed, or no call came for 10 minutes while
no turn ran (the next call opens a new one). A changed `remoteRuntime` value replaces it.

### A runtime the embedder owns

`remoteRuntime(session)` may also return a connection the embedder already started, `{callTool(name, args),
readResource(uri)}` (`RemoteRuntimeConnection`; zyg-agents: the session's runtime child behind its bridge, with its own
environment allowlist, sandbox user and grants). The host calls it and nothing else: it never spawns, idle-closes or
disposes it, and the embedder closes it when the session ends. Its timeouts are the embedder's too.

### Host tools per session

`createMarshalHost({ remoteHostToolsFor })` narrows the host tools of one remote session below the host-wide
`remoteHostTools` and `remoteEmbedderTools`: `[]` refuses every host tool (and drops the runtime_exec note that names them),
a list allows only those, undefined keeps the host-wide sets. A name outside the host-wide sets is a configuration error
that fails the turn.

### `toolCall`: one wrapper around every call

`createMarshalHost({ toolCall })` wraps each call on a session's `marshal` server (and on the same tools handed to other
providers): `toolCall(session, {kind, tool, args, alias?}, next)`. `kind: "runtime"` is a call that reaches the
session's runtime (`runtime_search`, `runtime_exec`, `runtime_read_resource`); made from inside a direct tool, `alias`
names that tool (`runtimeInvoke`). `kind: "direct"` is a direct tool the model called. `next()` runs the call; the wrapper
records it and may return a changed result (zyg-agents: the `evidence_call` record and the `[evidence ev-N]` prefix). A
read's result carries what was read as `structuredContent` (`{contents}`), which a direct tool gets back unchanged.

`runtime_exec` takes `requestId` (an idempotency key, the approval retry) and `executionMode` (`brokered` or
`trusted_node`; the runtime still refuses `trusted_node` on a host without `trustedTypeScript`). It takes no `approval`:
a session never approves its own call.

## What the embedder does

- Return `remoteRuntime(session)` for remote sessions (undefined for local ones; local sessions are unchanged).
- Keep the host's servers on for them (`hostMcpServers` not false) and run with `strictMcpConfig: true`, so a `marshal`
  server in the remote machine's own Claude settings cannot shadow the host's.
