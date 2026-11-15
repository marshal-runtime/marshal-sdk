# Onboarding: the extensions a host needs, in one file

`marshal-sdk.json` lists what every host started from that folder loads: extensions, the kit, the model. Write it once
with the CLI; `exec`, `agent` and `serve` pick it up from `--manifest`, `$MARSHAL_SDK_MANIFEST`, or the current folder.

```sh
marshal-sdk init --model claude-opus-5-5 --effort high --kit memory,sessions \
  --org https://<org discovery url> --allow @zyg/page-studio --profile zyg --no-default zygTools
marshal-sdk extensions add ./vendor/page-studio              # a built package folder
marshal-sdk extensions add ./vendor/brand-tools-1.2.0.tgz    # a packed extension (sha256 recorded)
marshal-sdk extensions add @zyg/page-studio@0.2.0            # from the organization
marshal-sdk extensions add ./vendor/foo --config-env apiKey=FOO_API_KEY --config mode=strict
marshal-sdk extensions list            # what the file says, and which defaults it turns on
marshal-sdk extensions list --resolve  # defaults + listed + the org's admitted ones, fetched and checked
marshal-sdk extensions fetch           # resolve and unpack everything now (while building an image)
marshal-sdk extensions remove @zyg/page-studio

marshal-sdk exec --workspace ws --state state --capability pagestudio.pages
```

```json
{
  "version": 1,
  "profile": "zyg",
  "model": "claude-opus-5-5",
  "reasoningEffort": "high",
  "kit": ["memory", "sessions"],
  "org": { "discovery": "https://<org discovery url>", "profile": { "allow": ["*"], "deny": ["@zyg/legacy-tools"] } },
  "defaults": { "zygTools": false },
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
  or `id` (+ optional `version`) from the organization. Paths inside the manifest's folder are stored relative, so the
  folder can move into an image whole; paths outside it are stored absolute.
- **Secrets stay out of the file.** A configuration string `${env:NAME}` is read from the host's environment at start;
  a missing variable stops the host with its name. `extensions list` shows references as written and masks values
  under keys that look secret; resolved values are never printed.
- **Flags win.** `--model` and `--effort` override the manifest; `--extension` packages load after its extensions.
- **An identity appears once.** Two listed entries resolving to the same extension stop the host and name both. A
  listed entry replaces a default or an org-profile extension of the same identity.

## Extensions from the organization

`"org": {"discovery": "<url>"}` names the organization this host belongs to (the URL a desktop signs in to). Two things
come from it:

- **`id` entries:** `{"id": "@scope/name", "version"?: "1.2.3"}`, pinned or the organization's current version.
- **The org's admitted extensions:** every extension the organization admits for this host, filtered by
  `org.profile`: `allow` (identities, `"*"` for all; default all) minus `deny`. An admitted extension that is
  also listed loads once, as listed.

The SDK does not talk to the organization itself. An `ExtensionResolver` does, and the org layer (`src/org`) provides
it:

```ts
interface ExtensionResolver {
  admitted(org: ManifestOrg): Promise<{ id: string; version: string }[]>;
  fetch(request: { org: ManifestOrg; id: string; version?: string }): Promise<
    { id: string; version: string } & ({ archive: Uint8Array; sha256: string } | { packageRoot: string })
  >;
}
```

The org layer registers it once with `useExtensionResolver(resolver)`, or a caller passes `resolveManifest(file,
{resolver})`. Onboarding then checks what comes back. An archive must match the sha256 the organization announced.
It is unpacked with the desktop's rules: regular files and folders only, and links, devices, absolute paths and `..`
paths are refused. It goes into the cache, keyed by identity, version and hash, and is not unpacked again. The
package must carry the identity that was asked for. Cache: `--cache <dir>`, else `$MARSHAL_SDK_CACHE`, else
`<manifest folder>/.marshal-sdk/extensions`.

Without the org layer, an `id` entry or an `org.profile.allow` stops the host and says so. A manifest with an `id`
entry and no `org` stops it too.

**Not done:** `src/org` has not landed yet, so the resolver has only been exercised with a fake in the tests. Org
credentials are the person who started the run, the same ones they use in Marshal (R18).

## Default extensions

Every host loads a built-in default set unless the manifest opts out. Defaults load first. A listed entry with the
same identity replaces its default.

| Default | Identity | On when | Package from |
| --- | --- | --- | --- |
| `org` | `@marshal/org` | the manifest names an `org` | `$MARSHAL_SDK_ORG_PACKAGE`, the SDK's `extensions/org/out/package`, or the organization |
| `brain` | `@marshal/brain` | always (the kit's Brain) | `kit.brain.packageRoot`, `$MARSHAL_SDK_BRAIN_PACKAGE`, or the organization |
| `zygTools` | `@zyg/marshal-runtime-extension` | `"profile": "zyg"` (a Zyg host) | `$MARSHAL_SDK_ZYG_EXTENSION` or the organization |

- **Opting out:** `"defaults": {"zygTools": false}` turns one off; Marley is a Zyg host that does this.
  `"defaults": false` turns all of them off. With the CLI, use `init --no-default zygTools` or `init --no-defaults`.
- **The Brain goes through the kit.** The default adds `brain` to the kit's parts, with the package found, so it gets
  the kit's cloud configuration. A kit that already asks for `brain` or `memory` loads the Brain itself, and the Brain
  is not counted as a default then. A kit passed in code (`createMarshalHost({kit})`) wins over the manifest's.
- **A default that is on but has no package stops the host** and says how to fix it. For example: `default
  @marshal/brain is on because every host carries the kit's Brain, but no package was found: set
  MARSHAL_SDK_BRAIN_PACKAGE to a built package, or name the org that serves it, or opt out with "defaults": {"brain":
  false}.`
- `resolveManifest` returns `defaults` (every default that loads, the Brain included, so an image can pack them) and
  `defaultExtensions` (their identities). `withManifest` passes `defaultExtensions` to the host, which marks them.

## What the host says at start

```
[marshal-sdk] manifest /…/marshal-sdk.json: @marshal/brain@0.1.0 (default), @zyg/marshal-runtime-extension@0.4.0 (default), @zyg/page-studio@0.1.0
[marshal-sdk] extension @marshal/brain@0.1.0 (default) enabled, healthy: 3 capabilities, 0 skills
[marshal-sdk] extension @zyg/marshal-runtime-extension@0.4.0 (default) enabled, healthy: 1 capabilities, 0 skills
[marshal-sdk] extension @zyg/page-studio@0.1.0 enabled, healthy: 37 capabilities, 7 skills
```

`host.extensions` holds the same per extension (identity, version, package, status, health, capabilities, skills,
`fromDefaults`). A
package that is missing or not an extension stops the host before anything starts ("<entry>: no runtime-extension.json
in <path> (is it a built extension package?)"); one that installs but does not come up healthy stops it with its
identity, package, status, health and the runtime's reasons.

## Proof

`docs/onboarding-proof/proof.txt` (2026-11-15, no model): `init` with the real Page Studio package, the SDK sessions
viewer and a fixture; `extensions add` with an env reference; `extensions list`; then `exec --capability
pagestudio.pages` with the manifest found in the current folder: the three extensions come up healthy (Page Studio with
37 capabilities and its 7 skills) and Page Studio answers from a temp `PAGE_STUDIO_DIR`. Without the variable the host
refuses, naming it.

`docs/onboarding-proof/defaults-proof.txt` (2026-11-15, Node 24.14, no model):
- A Zyg host with an `org` and an allow-list lists its three defaults. Resolving it without the org layer is refused
  by name.
- A Zyg host with the real `@marshal/brain` and zyg-agents' `@zyg/marshal-runtime-extension` brings both up marked
  "(default)" next to the listed Page Studio, and Page Studio answers.
- The same host with `--no-default zygTools` (Marley) brings up the Brain and Page Studio only.

Node 22.14 cannot run the Brain (`no such module: fts5`, see docs/kit.md), so a Brain default needs Node 24.

Tests (`test/onboarding.test.ts`):
- the manifest format;
- folders, archives (sha256, unpack once) and `${env:}`;
- `id` entries through a fake resolver: current or pinned, a tampered hash, a swapped identity, no org layer, no
  `org`;
- the org profile: allow, deny, and listed entries winning;
- the defaults: org, Brain through the kit, Zyg tools on a Zyg host, each opt-out, a kit that asks for the Brain, a
  listed default, missing and wrong packages;
- unsafe archives;
- a Zyg host from one manifest whose start report marks its defaults, and a clear refusal of a missing package.
