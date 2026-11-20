# Providers: one provider layer for the SDK and the Marshal desktop

A host's sessions run on Claude (subscription or API key), OpenAI through the OpenAI Agents SDK (API key), Codex or
Cursor. The Claude, Codex and Cursor provider code is the same code the Marshal desktop runs: `packages/providers/src` here is the source, and the desktop vendors it
byte for byte at `packages/marshal-providers/src`, pinned by commit and hash in `SOURCE.json`. A session that works in
a local harness works the same way in production and in the desktop.

## Choosing the provider

In `marshal-sdk.json`:

```json
{ "version": 1, "provider": { "id": "codex", "account": "work" }, "extensions": [] }
```

or in code: `createMarshalHost({ ..., provider: { id: "cursor", apiKeyEnv: "TEAM_CURSOR_KEY" } })`. A provider given
in code wins over the manifest's. Without `provider`, the host runs Claude on the desktop's Claude client with `env`
exactly as given (a test's own `query` replaces the provider altogether).

| Field | Meaning |
|---|---|
| `id` | `claude`, `openai`, `codex`, `cursor` or `antigravity` |
| `account` | An account from the Marshal desktop's registry (Settings, Accounts), e.g. `omer-max`. It uses the same credential home the desktop uses. |
| `apiKeyEnv` | Run on an API key read from this environment variable (or the file `<name>_FILE` names). A key never goes in the manifest. `openai` always runs on a key: default `OPENAI_API_KEY`. |
| `home` | Overrides the credential home: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the folder holding Cursor's credential store (a container's mounted login). |
| `engine` | Claude only: `client` (default, the desktop's Claude client) or `agent-sdk` (every turn on the Claude Agent SDK directly). See "Claude: the client engine". |

Choose an account or a key, not both. The host checks the choice before it starts and stops with the reason when it
can't work: an unknown provider, an account that is neither in the desktop registry nor on disk, or a key variable
that isn't set.

### A provider per session: `providerFor`

`providerFor(session: {model?})` (code only) picks another provider for a session by its model; undefined keeps the
host's `provider`. `providerForModelFamily({google: {id: "antigravity"}})` routes Gemini models to Antigravity and
leaves Claude models on the host's provider, so one host can run `gemini-4-neon` and `claude-sonnet-5-5` sessions side
by side. Each routed provider is resolved once, on first use, from the host's `env` and `secrets`; it can only be a
provider other than the host's own (naming the host's id with an account or key is refused). A session keeps the
provider it was created on: its native session lives there, so a later model that routes elsewhere fails the turn with
a message to start a new session. Each session's prompt describes its own provider's tools.

## Where credentials come from

| Provider | Subscription (account) | API key |
|---|---|---|
| Claude | `CLAUDE_CONFIG_DIR=~/.marshal/marshal-claude-accounts/<id>`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed | `ANTHROPIC_API_KEY` from `apiKeyEnv` |
| Codex | `CODEX_HOME=~/.marshal/marshal-codex-accounts/<id>`; without an account, `~/.marshal/marshal-codex` | A private `CODEX_HOME` under the host's state, signed in with the key once per client |
| OpenAI | None: the Agents SDK runs on the OpenAI API (a ChatGPT login is the `codex` provider) | `OPENAI_API_KEY`, or `apiKeyEnv` |
| Cursor | The account's credential store under the desktop's data folder (`~/.marshal`, or `~/.marshal-dev` when the login lives there) | `CURSOR_API_KEY` with an empty private store, so the key is the one in use |
| Antigravity | `~/.marshal/antigravity/credentials.json` (an account: `~/.marshal/antigravity/accounts/<id>/`), else the launch environment: `GOOGLE_GENAI_USE_VERTEXAI` with `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` (gcloud ADC or `GOOGLE_APPLICATION_CREDENTIALS`), or `GEMINI_API_KEY` | `apiKeyEnv` holding a Gemini API key, a Vertex service-account JSON or `{"project","location"}`, signed into a private home |

The registry is read from `marshal-settings.json` (`runtimeAccounts`) in `~/.marshal` and `~/.marshal-dev`, without
writing to it. The desktop's default account is not adopted: without `account`, a host keeps its environment.

Every key is read through `src/credentials.ts` (`readSecret`, `providerKey`, `requireProviderKey`): `NAME`, then the
file `NAME_FILE` names. Model services (docs/models.md) read their keys the same way.

## Claude: the client engine

By default a Claude turn runs on `createClaudeClientFactory` from `packages/providers`: the client the desktop runs
its own Claude sessions on (desktop #162), so a session behaves the same in a local harness, in production and in the
desktop. It goes through `createProviderQuery` like Codex and Cursor (below), and also takes:

- **Forks.** A fork during the parent's turn copies the native session file (`forks.ts`, as before). A fork between
  turns copies the parent's native state under a new id (`readNativeState` / `writeNativeState`) and resumes it.
- **Images and files.** A launch's attachments go to the client as files; it inlines images the way the desktop does.
- **The native tool surface** (`disabledBuiltInTools`, `nativeSubagentAllowlist`) and project rules
  (`projectContext`): see "Marshal's tool surface and repository rules" below.

A turn that sets something the client has no field for runs on the Claude Agent SDK instead: `outputFormat`
(structured output), the launch's own `hooks` or `env` (the client's environment is fixed when it is made), `extraArgs`
(and so `disableSlashCommands`), an in-process MCP server of its own (`type: "sdk"`), `spawnClaudeCodeProcess`, `pathToClaudeCodeExecutable`,
`maxTurns`, `maxBudgetUsd`, `allowedTools`, `strictMcpConfig`, or a fork at an earlier message (`resumeSessionAt`).
Both engines run the same Claude CLI on the same config dir, so the session continues across them; the host logs each
such turn ("turn on the Claude Agent SDK: the Claude client doesn't take …"). `engine: "agent-sdk"` runs every turn
there, as the SDK did before.

## Marshal's tool surface and repository rules

A session on the host's own prompt (not one whose launch brings its own `systemPrompt`; a fork carries its parent's
prompt and counts as the host's) gets the desktop's v2 native tool surface (`src/native-tools.ts`, copied from the
desktop's `electron/prompt/v2/assemble.ts`):

- `DISABLED_NATIVE_TOOLS`: TodoWrite, AskUserQuestion, the Task* and Cron* tools, ScheduleWakeup, plan mode, worktree
  mode, PushNotification, RemoteTrigger, SendMessage, ListAgents, Workflow, DesignSync. Marshal owns each job.
- `NATIVE_SUBAGENT_ALLOWLIST`: only `web-fetch`; every other `Agent`/`Task` call is denied in favor of forkSubagents
  (a PreToolUse hook on the Agent SDK path, the client's own hook on the client path).

`createMarshalHost({ repoRules })` (default true) loads the workspace's rules the way the desktop does
(`src/repo-rules.ts`, from the desktop's `repository-customizations.ts`): the provider reads its own convention
(Claude: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules` through the `project` setting source, along with project
skills and agents), and the rest (`AGENTS.md` at any depth, `.github/copilot-instructions.md` and
`.github/instructions`, `.cursor/rules`) goes into the prompt as "Repository Instructions"; path-scoped rules are
listed, not inlined. `repoRules: false` loads nothing from the checkout (`settingSources: []`, `projectContext: false`).
The section is read once, when the host starts.

Claude sessions start with `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, so Claude Code's own skills (loop, update-config,
claude-api, batch, …) stay out of a host's skill list: a probe of the init event went from 19 skills to 3 (`design`,
`doctor` and `plugin-authoring` are built into the CLI and stay). A host that sets the variable in its env (say, to `0`)
keeps its own value. Project skills and plugins are unaffected.

`test/native-tools.test.ts` fails when the desktop's lists change (run with `MARSHAL_DESKTOP_DIR`, or with the desktop
checked out beside this repo).

## OpenAI: the Agents SDK

`provider: {"id": "openai"}` runs each turn with `@openai/agents` (src/openai-agents-query.ts) on the Responses API.

- A session's native id is its last response id. The next turn continues from it (`previousResponseId`), and a fork
  continues from the parent's, so forks work. Forking at an earlier message (`resumeSessionAt`) needs Claude.
- Tools: the marshal runtime tools as function tools; the Agents SDK's `shell` and `apply_patch` tools, run by the host
  in the session's working directory (`localTools: false` leaves them out); stdio and HTTP MCP servers such as the
  browser.
- Marshal's prompt is the agent's instructions. Images in a prompt become `input_image` parts. A launch's
  `outputFormat` JSON schema is the output type, and its parsed result is the structured output.
- Usage counts input, output and cached tokens. Cost is not reported (0).
- Tracing to OpenAI's trace viewer is off.
- With no model set, the Agents SDK's default model is used (`OPENAI_DEFAULT_MODEL` overrides it).

## Antigravity: Google's agent SDK on Vertex or the Gemini API

`provider: {"id": "antigravity"}` runs each session on Google Antigravity (PyPI `google-antigravity`, pinned in
`packages/providers/src/backend/antigravity/constants.ts`). The SDK is Python only, so the provider drives it through
`bridge.py`: one Python process per client, JSON lines on stdin/stdout, one `Agent` per session.

- **Python.** On first use the provider makes a private venv at `~/.marshal/antigravity/venv` with uv (else a system
  Python 3.10+) and installs the pinned SDK; `MARSHAL_ANTIGRAVITY_PYTHON` names a prepared interpreter instead. The
  bridge ships inside any bundle as `bridge-source.ts`, regenerated from `bridge.py` by
  `node scripts/antigravity-bridge-source.mjs` (`--check` fails when it is stale).
- **Credentials.** Vertex on a project (gcloud ADC or a service-account key file), Vertex express (API key), or the
  Gemini API (API key); see the table above. The desktop's sign-in, "Use Vertex or Gemini credentials", takes the same
  values.
- **Sessions.** The native id is Antigravity's `conversation_id`. Conversations are saved under `<home>/sessions`, so
  later turns, a restart and `resumeSession` continue them. A model or effort change restarts the Agent on the same
  conversation. Reasoning effort maps to Gemini's thinking level (`max` becomes `xhigh`).
- **Tools.** Every tool call (Antigravity's built-ins, MCP, Marshal's host tools) passes the host first: the pre-tool
  hook, then the permission handler with the request kinds Claude uses (`shell` for `run_command`, `write`, `read`,
  `url`, `mcp`, `custom-tool`). Marshal's host tools run in the host and are registered with their JSON schemas; stdio
  and HTTP MCP servers pass through. On Marshal's tool surface `ask_question`, `invoke_subagent` and `schedule` are
  off, since Marshal owns those jobs.
- **Remote sessions** (`remoteRuntime`). The session's marshal tools are its only tools: they reach Antigravity as host
  tools whose calls run on the session's remote runtime, and the session gets `enabledBuiltinTools: []` (no
  `run_command`, file or web built-in, which would run on the host) and no MCP server. Its prompt names none of
  Antigravity's built-ins.
- **Structured output.** A launch's `outputFormat: {type: "json_schema", schema}` becomes Antigravity's
  `response_schema`; the answer comes back through its built-in `finish` tool (which ends the turn and runs nothing),
  so a session limited to an allowlist keeps `finish` when it asks for a schema. The parsed answer is the turn's
  `structured_output`. A turn that asked for one and got none fails (`error_max_structured_output_retries`), as on the
  Claude Agent SDK.
- **Prompt.** Marshal's prompt is a section appended to Antigravity's own instructions, or the whole system prompt when
  a launch replaces it (`systemMessage.mode: "replace"`). Image, PDF, audio and video attachments go in as media.
- Usage reports input, cached, output and thinking tokens; cost is not reported (0). Antigravity compacts on its own,
  reported as `session.compaction_complete`.

## How a turn runs on Codex and Cursor

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

- Forking a session: it needs a client that keeps native state (Claude) and otherwise fails with a clear message.
- Structured output: a turn that asks for it (`outputFormat`) fails with `error_max_structured_output_retries`
  instead of succeeding without its answer.

A remote session (`remoteRuntime`) on any of these providers gets only its marshal tools (`PROVIDER_TOOLS_ONLY`): the
provider's strict allowlist is exactly those tools, and no MCP server is passed.

Attachments go to the client as files; whether it reads images is the client's own behaviour.

## Changing the provider layer

1. Edit `packages/providers/src` here and commit.
2. In the desktop, run `node scripts/marshal-providers-source.mjs sync <this checkout>`. It copies the source and
   records the commit and hash.
3. Open a desktop PR. The desktop's pin test fails if the vendored copy is edited by hand.

The package's own unit tests (vitest) run in the desktop; `test/providers.test.ts` here covers the host side with fake
transports for each provider and both credential kinds.
