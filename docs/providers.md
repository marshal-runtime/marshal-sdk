# Providers: one provider layer for the SDK and the Marshal desktop

A host's sessions run on Claude, Codex or Cursor, on a signed-in subscription or an API key. The provider code is
the same code the Marshal desktop runs: `packages/providers/src` here is the source, and the desktop vendors it
byte for byte at `packages/marshal-providers/src`, pinned by commit and hash in `SOURCE.json`. A session that works in
a local harness works the same way in production and in the desktop.

## Choosing the provider

In `marshal-sdk.json`:

```json
{ "version": 1, "provider": { "id": "codex", "account": "work" }, "extensions": [] }
```

or in code: `createMarshalHost({ ..., provider: { id: "cursor", apiKeyEnv: "TEAM_CURSOR_KEY" } })`. A provider given
in code wins over the manifest's. Without `provider`, the host runs Claude on the Claude Agent SDK with `env` exactly
as given, as before.

| Field | Meaning |
|---|---|
| `id` | `claude`, `codex` or `cursor` |
| `account` | An account from the Marshal desktop's registry (Settings, Accounts), e.g. `omer-max`. It uses the same credential home the desktop uses. |
| `apiKeyEnv` | Run on an API key read from this environment variable. A key never goes in the manifest. |
| `home` | Overrides the credential home: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the folder holding Cursor's credential store (a container's mounted login). |
| `engine` | Claude only: `agent-sdk` (default) or `client` (the desktop's Claude client). |

Choose an account or a key, not both. The host checks the choice before it starts and stops with the reason when it
can't work: an unknown provider, an account that is neither in the desktop registry nor on disk, or a key variable
that isn't set.

## Where credentials come from

| Provider | Subscription (account) | API key |
|---|---|---|
| Claude | `CLAUDE_CONFIG_DIR=~/.marshal/marshal-claude-accounts/<id>`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed | `ANTHROPIC_API_KEY` from `apiKeyEnv` |
| Codex | `CODEX_HOME=~/.marshal/marshal-codex-accounts/<id>`; without an account, `~/.marshal/marshal-codex` | A private `CODEX_HOME` under the host's state, signed in with the key once per client |
| Cursor | The account's credential store under the desktop's data folder (`~/.marshal`, or `~/.marshal-dev` when the login lives there) | `CURSOR_API_KEY` with an empty private store, so the key is the one in use |

The registry is read from `marshal-settings.json` (`runtimeAccounts`) in `~/.marshal` and `~/.marshal-dev`, without
writing to it. The desktop's default account is not adopted: without `account`, a host keeps its environment.

## How a turn runs

The agent port's `query` is `createProviderQuery` (src/provider-query.ts), a `QueryFn` over the providers'
`RuntimeClient`.

- The first turn creates the native session; later turns resume it by id.
- Assistant messages, usage (tokens and cost) and errors map to the port's events, so transcripts, usage and failures
  look the same as on Claude.
- The session's marshal tools (`runtime_search`, `runtime_exec`, `runtime_read_resource`) reach the provider as
  provider tools (`PROVIDER_TOOLS`). Stdio and HTTP MCP servers pass through; the Claude Agent SDK's in-process
  server stays on the Claude path.
- The host is unattended: permission requests are approved, and Codex runs without its read-only sandbox. As on
  Claude, what a run may do is decided by what is installed on the host.

Not yet on Codex and Cursor:

- Forking a session: it needs Claude and fails with a clear message.
- Image attachments: only the prompt text is sent.
- Structured output.

## Changing the provider layer

1. Edit `packages/providers/src` here and commit.
2. In the desktop, run `node scripts/marshal-providers-source.mjs sync <this checkout>`. It copies the source and
   records the commit and hash.
3. Open a desktop PR. The desktop's pin test fails if the vendored copy is edited by hand.

The package's own unit tests (vitest) run in the desktop; `test/providers.test.ts` here covers the host side with fake
transports for each provider and both credential kinds.
