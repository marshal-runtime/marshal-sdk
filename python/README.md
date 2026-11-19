# marshal_sdk (Python)

The Claude Agent SDK on a Marshal host. Swap the import and add the dependency:

```python
from marshal_sdk import query, ClaudeAgentOptions   # was: from claude_agent_sdk import …
```

```toml
marshal-sdk = { git = "https://github.com/marshal-runtime/marshal-sdk.git", branch = "main", subdirectory = "python" }
```

## Declare the host: marshal-sdk.json

What a Marshal host loads is declared in one file the caller owns, `marshal-sdk.json` (format: `docs/onboarding.md`).
The SDK hardwires no extension: Page Studio loads because the file lists it. agent-sandbox's, for example
(`examples/zyg-agent-sandbox/marshal-sdk.json`):

```json
{
  "version": 1,
  "model": "claude-opus-5-5",
  "reasoningEffort": "xhigh",
  "kit": ["brain", "memory", "sessions"],
  "brain": { "index": "zyg", "auth": "service" },
  "extensions": [
    {
      "url": "gs://shop-builder-local-runs/marshal-extensions/@zyg/page-studio/0.2.0.tgz",
      "sha256": "603ebc8d5139401f2d775b18739dfd0cb8a64ec32d6aba69bf3f5f4c4c36e797",
      "configuration": { "openaiApiKey": "${env:OPENAI_API_KEY}" }
    }
  ]
}
```

Call `init` once when the service starts:

```python
import marshal_sdk

report = marshal_sdk.init("marshal-sdk.json")   # raises marshal_sdk.MarshalInitError naming every problem
```

`init` downloads each pinned package with the process's own Google credentials (cached by its sha256), reads the
`${env:…}` settings, checks what every extension declares it needs (other extensions, required settings), starts a host
with exactly those extensions and asks the Brain one question. The report lists each extension with its version and
source, the Brain (index, address, sign-in, reachable) and the model. A second call with the same file is free.
`MarshalInitError.problems` lists every missing environment variable, setting, extension or Brain access, one per line.

Without `init`, the first query finds the manifest at `$MARSHAL_SDK_MANIFEST`, else `marshal-sdk.json` in the working
folder, else beside the agent's `cwd`.

## The person a run works for

```python
ClaudeAgentOptions(cwd=workspace, user="requester@zyg.com")
```

An email in `user` is the run's person: the Brain answers as them (their personal memories, in `"auth": "service"`
mode the Brain's caller), lower-cased, never taken from model input. `claude_agent_sdk` spawns its CLI as the OS user
`user` names, so marshal_sdk clears an email there before spawning; a plain OS user name passes through unchanged.
`MARSHAL_SDK_BRAIN_CALLER` is the fallback when no email is given.

## What the package carries

- **Node 24** from the `nodejs-wheel-binaries` dependency (the Brain needs Node 24's FTS5).
- **The marshal-sdk npm package** as `marshal_sdk/_bundle/marshal-sdk.tgz` (built by `image/pack.mjs`): the host, its
  runtime packs and the **Brain** (`_bundle/inventory.json` lists the versions). No other extension is inside: the
  caller's `marshal-sdk.json` names them.
  Building the wheel (`poetry install`, `pip install`) installs it into `marshal_sdk/_bundle/install` with that Node,
  which needs the npm registry at build time and makes the wheel platform-specific (~200 MB, ~580 MB installed; Codex's
  native binary is pruned). Without the registry the wheel builds anyway and the first query installs it into
  `~/.cache/marshal-sdk` (`MARSHAL_SDK_CACHE`).
- **marshal-claude**, the bridge `query` runs the caller's own agent through, on that Node.

## Page-agent builds and edits

A query whose `cwd` is an agent-sandbox page-agent workspace, on a host whose manifest lists `@zyg/page-studio`, is
built (or, with `input/page/base-page/index.html`, edited) by Page Studio on Marshal's own system prompt
(`page_studio.py`). With no manifest, or one that does not list Page Studio, the query runs the caller's own agent and
its first message is a `SystemMessage` (subtype `marshal_sdk_notice`) saying why. The page names where its Marshal state is
uploaded (`<output root>/agent/marshal-state`, agent-sandbox's run layout from `GCS_BUCKET`); an edit continues from that
state, which is also what Marshal desktop's `sdksessions.pushToCloud` updates. `MARSHAL_SDK_ENGINE=claude` opts out; `MARSHAL_SDK_KIT` names kit parts over the manifest's `kit`.

## Deploy needs

- The npm registry reachable when the image installs Python dependencies (else on the first page run).
- A Chromium for Page Studio's renders: the Playwright Chromium already under `PLAYWRIGHT_BROWSERS_PATH` is used on
  Linux, or set `MARSHAL_SDK_CHROME`.
- `ANTHROPIC_API_KEY`, and whatever the manifest's `${env:…}` settings name (`OPENAI_API_KEY` for Page Studio's edit
  router in agent-sandbox's).
- Read access to the bucket of every `url` extension (the service account's own credentials).
- The Brain: Google credentials the Brain front accepts (`init` proves it). `MARSHAL_SDK_PUBLISH_SESSIONS` publishes a
  run's sessions to Marshal desktop.
- For runs to show in Marshal desktop's cloud run list: `MARSHAL_SDK_RUN_POINTER_PREFIX` (defaults to
  `gs://$GCS_BUCKET/marshal-sdk-cloud-runs` only when `GCS_BUCKET` is set; production agent-sandbox leaves it unset).

## Refreshing the bundle

```sh
MARSHAL_SDK_BRAIN_PACKAGE=<built @marshal/brain> node image/pack.mjs --out /tmp/pack --manifest <marshal-sdk.json with "kit": ["brain"], no extensions>
cp /tmp/pack/marshal-sdk-*.tgz python/marshal_sdk/_bundle/marshal-sdk.tgz && cp /tmp/pack/inventory.json python/marshal_sdk/_bundle/
```
