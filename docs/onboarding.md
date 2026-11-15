# Onboarding: the extensions a host needs, in one file

`marshal-sdk.json` lists what every host started from that folder loads: extensions, the kit, the model. Write it once
with the CLI; `exec`, `agent` and `serve` pick it up from `--manifest`, `$MARSHAL_SDK_MANIFEST`, or the current folder.

```sh
marshal-sdk init --model claude-opus-5-5 --effort high --kit brain,memory,sessions \
  --registry https://<org api base> --registry-token-env MARSHAL_ORG_TOKEN
marshal-sdk extensions add ./vendor/page-studio              # a built package folder
marshal-sdk extensions add ./vendor/brand-tools-1.2.0.tgz    # a packed extension (sha256 recorded)
marshal-sdk extensions add @zyg/page-studio@0.2.0            # from the organization registry
marshal-sdk extensions add ./vendor/foo --config-env apiKey=FOO_API_KEY --config mode=strict
marshal-sdk extensions list            # what the file says; --resolve fetches and checks every package
marshal-sdk extensions fetch           # resolve and unpack everything now (while building an image)
marshal-sdk extensions remove @zyg/page-studio

marshal-sdk exec --workspace ws --state state --capability pagestudio.pages
```

```json
{
  "version": 1,
  "model": "claude-opus-5-5",
  "reasoningEffort": "high",
  "kit": ["brain", "memory", "sessions"],
  "registry": { "url": "https://<org api base>", "tokenEnv": "MARSHAL_ORG_TOKEN" },
  "extensions": [
    { "path": "vendor/page-studio" },
    { "archive": "vendor/brand-tools-1.2.0.tgz", "sha256": "…" },
    { "id": "@zyg/page-studio", "version": "0.2.0" },
    { "path": "vendor/foo", "configuration": { "apiKey": "${env:FOO_API_KEY}", "mode": "strict" } }
  ]
}
```

From code, the same file feeds `createMarshalHost`:

```ts
import { createMarshalHost, withManifest } from "@marshal/sdk";

const host = await createMarshalHost(await withManifest({ workspacePath, stateRoot }, { manifest: "marshal-sdk.json" }));
```

or `resolveManifest(file)` (`src/onboarding.ts`) for the resolved packages alone.

## Rules

- **One source per entry:** `path` (a built package folder), `archive` (a .tgz, checked against `sha256` when given)
  or `id` (+ optional `version`) from the registry. Paths inside the manifest's folder are stored relative, so the
  folder can move into an image whole; paths outside it are stored absolute.
- **Secrets stay out of the file.** A configuration string `${env:NAME}` is read from the host's environment at start;
  a missing variable stops the host with its name. `extensions list` shows references as written and masks values
  under keys that look secret; resolved values are never printed.
- **Flags win.** `--model` and `--effort` override the manifest; `--extension` packages load after its extensions.
- **An identity appears once.** Two entries resolving to the same extension stop the host and name both.

## The registry is the desktop's organization catalog

The SDK reads the same catalog and archives the desktop installs from in Plugins > Organization
(`electron/org/org-extension-catalog.ts`, `org-onboarding.ts`, `common/org-onboarding.ts` in the desktop repo):

- `GET {url}/v1/onboarding/catalog` with `Authorization: Bearer $<tokenEnv>`: `{version: 1, recommended, available,
  pending}` entries `{id, version, status, delivery: {kind: "archive", url?, sha256, bytes}}`.
- Only `approved` entries install; without `version` the highest approved one is taken (`1.2.10` after `1.2.9`, a
  prerelease before its release). Pending and rejected entries never install. `bundled` deliveries are desktop-only.
- The archive comes from `delivery.url` or `{url}/v1/onboarding/extensions/{id}/{version}.tgz`, from the registry's own
  origin only, and must match the announced size and sha256. It is unpacked with the desktop's rules (regular files
  and folders only; links, devices, absolute and `..` paths refused) into the cache, keyed by version and sha256, and
  not downloaded again while the hash matches. The package inside must carry the identity asked for.
- `url` must be https unless it is this machine (a local mirror). `"registry": {"dir": "mirror"}` reads the same layout
  from a folder (`mirror/v1/onboarding/catalog`, `mirror/v1/onboarding/extensions/@scope/name/1.0.0.tgz`): an offline
  mirror inside an image.
- Cache: `--cache <dir>`, else `$MARSHAL_SDK_CACHE`, else `<manifest folder>/.marshal-sdk/extensions`.

**Not done:** the SDK has not been pointed at the production organization server; everything was built and tested
against a fake registry on localhost. The token is the caller's bearer token; which identity a cloud sandbox uses to
read the catalog (a service token the org server accepts) is still to be decided.

## What the host says at start

```
[marshal-sdk] manifest /…/marshal-sdk.json: @zyg/page-studio@0.1.0, @omer/marshal-sdk-sessions@0.2.7, @test/onboard-fixture@1.0.0
[marshal-sdk] extension @zyg/page-studio@0.1.0 enabled, healthy: 37 capabilities, 7 skills
[marshal-sdk] extension @omer/marshal-sdk-sessions@0.2.7 enabled, healthy: 14 capabilities, 0 skills
[marshal-sdk] extension @test/onboard-fixture@1.0.0 enabled, healthy: 0 capabilities, 1 skills
```

`host.extensions` holds the same per extension (identity, version, package, status, health, capabilities, skills). A
package that is missing or not an extension stops the host before anything starts ("<entry>: no runtime-extension.json
in <path> (is it a built extension package?)"); one that installs but does not come up healthy stops it with its
identity, package, status, health and the runtime's reasons.

## Proof

`docs/onboarding-proof/proof.txt` (2026-11-15, no model): `init` with the real Page Studio package, the SDK sessions
viewer and a fixture; `extensions add` with an env reference; `extensions list`; then `exec --capability
pagestudio.pages` with the manifest found in the current folder: the three extensions come up healthy (Page Studio with
37 capabilities and its 7 skills) and Page Studio answers from a temp `PAGE_STUDIO_DIR`. Without the variable the host
refuses, naming it.

Tests: `test/onboarding.test.ts`: the manifest format; folders, archives (sha256, unpack once) and `${env:}`; the
registry over HTTP (latest approved, pinned, pending refused, identity swap, tampered hash, token missing or wrong,
plain-http remote refused, cached archive not downloaded again); the folder mirror; unsafe archives; a host from one
manifest with its start report and a clear refusal of a missing package.
