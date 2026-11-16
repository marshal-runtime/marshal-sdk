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
| `runtime_exec {targetType: "operation", target}` with a target in `REMOTE_HOST_TOOLS`, and `runtime_search {name}` for one | the host, under the session's own scope |

`REMOTE_HOST_TOOLS` is fixed: `marshal.tool.forkSubagents`, `listSubagents`, `messageSubagent`, `messageForks`,
`searchSessions`, `getSessionTranscript`, `remember`, `recall`, `linkMemory`, `updateMemory`, `forget`, `recordDecision`.
`createMarshalHost({ remoteHostTools })` narrows that set to a subset (default: all of it); a host tool outside it is refused on the
host and never forwarded. A host whose session store holds several tenants (Marley: every brand on one server) lists only
the memory tools, because the session tools read and reach every session of the store. No other host capability is reachable (no generic forwarding), and a TypeScript block (`inline_module`) runs on the
remote runtime only. A remote session gets no host browser server and no host runtime for other providers. Embedder
direct tools route their runtime calls the same way.

Tool names are the local ones (`mcp__marshal__runtime_exec`, `marshal.tool.*`), so the prompt is the same local or
remote.

The host opens one remote connection (one child, e.g. one ssh) per session at its first runtime call and keeps it across
turns. It closes with the session: the live process closes, the host is disposed, or no call came for 10 minutes while
no turn ran (the next call opens a new one). A changed `remoteRuntime` value replaces it.

## What the embedder does

- Return `remoteRuntime(session)` for remote sessions (undefined for local ones; local sessions are unchanged).
- Keep the host's servers on for them (`hostMcpServers` not false) and run with `strictMcpConfig: true`, so a `marshal`
  server in the remote machine's own Claude settings cannot shadow the host's.
