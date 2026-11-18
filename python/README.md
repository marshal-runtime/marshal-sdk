# marshal_sdk (Python)

The Claude Agent SDK on a Marshal host. Swap the import and add the dependency:

```python
from marshal_sdk import query, ClaudeAgentOptions   # was: from claude_agent_sdk import …
```

```toml
marshal-sdk = { git = "https://github.com/marshal-runtime/marshal-sdk.git", branch = "main", subdirectory = "python" }
```

## What the package carries

- **Node 24** from the `nodejs-wheel-binaries` dependency (the Brain needs Node 24's FTS5).
- **The marshal-sdk npm package** as `marshal_sdk/_bundle/marshal-sdk.tgz` (built by `image/pack.mjs`): the host, its
  runtime packs, the **Page Studio** extension and the **Brain** (`_bundle/inventory.json` lists the versions).
  Building the wheel (`poetry install`, `pip install`) installs it into `marshal_sdk/_bundle/install` with that Node,
  which needs the npm registry at build time and makes the wheel platform-specific (~200 MB, ~580 MB installed; Codex's
  native binary is pruned). Without the registry the wheel builds anyway and the first query installs it into
  `~/.cache/marshal-sdk` (`MARSHAL_SDK_CACHE`).
- **marshal-claude**, the bridge `query` runs the caller's own agent through, on that Node.

## Page-agent builds and edits

A query whose `cwd` is an agent-sandbox page-agent workspace is built (or, with `input/page/base-page/index.html`,
edited) by Page Studio on Marshal's own system prompt (`page_studio.py`). The page names where its Marshal state is
uploaded (`<output root>/agent/marshal-state`, agent-sandbox's run layout from `GCS_BUCKET`); an edit continues from that
state, which is also what Marshal desktop's `sdksessions.pushToCloud` updates. Defaults need no settings:
`MARSHAL_SDK_ENGINE=claude` opts out, `MARSHAL_SDK_KIT` (default `brain,memory,sessions`, `none` turns it off).

## Deploy needs

- The npm registry reachable when the image installs Python dependencies (else on the first page run).
- A Chromium for Page Studio's renders: the Playwright Chromium already under `PLAYWRIGHT_BROWSERS_PATH` is used on
  Linux, or set `MARSHAL_SDK_CHROME`.
- `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for Page Studio's edit router) in the process.
- The Brain: Google credentials the Brain front accepts. Without them runs still finish, without memories.
  `MARSHAL_SDK_BRAIN_CALLER` names whose personal memories a run reads; `MARSHAL_SDK_PUBLISH_SESSIONS` publishes its
  sessions to Marshal desktop.
- For runs to show in Marshal desktop's cloud run list: `MARSHAL_SDK_RUN_POINTER_PREFIX` (defaults to
  `gs://$GCS_BUCKET/marshal-sdk-cloud-runs` only when `GCS_BUCKET` is set; production agent-sandbox leaves it unset).

## Refreshing the bundle

```sh
MARSHAL_SDK_BRAIN_PACKAGE=<built @marshal/brain> node image/pack.mjs --out /tmp/pack --manifest <marshal-sdk.json naming Page Studio>
cp /tmp/pack/marshal-sdk-*.tgz python/marshal_sdk/_bundle/marshal-sdk.tgz && cp /tmp/pack/inventory.json python/marshal_sdk/_bundle/
```
