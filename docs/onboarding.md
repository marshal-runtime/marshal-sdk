# Onboarding: the extensions a host needs, in one file

`marshal-sdk.json` lists what every host started from that folder loads: extensions, the kit, the Brain, the model.
The SDK hardwires no extension and no agent: an extension declares its agents, and the manifest's `agent` names the one
every run starts (see "Agents" below). Write it once with the CLI; `exec`, `agent`, `serve`, `agent-run` and `check` pick
it up from `--manifest`, `$MARSHAL_SDK_MANIFEST`, or the current folder.

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
    { "url": "gs://<bucket>/marshal-extensions/@zyg/review-tools/1.0.0.tgz", "sha256": "…" },
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

## Agents

An extension declares the agents it brings in its `runtime-extension.json`, and a caller picks one by name:

```json
"contributes": {
  "capabilities": ["acme.agent.run"],
  "agents": [{ "id": "page", "title": "Page agent", "description": "…", "capability": "acme.agent.run",
               "fake": "acme.agent.fake", "ports": ["browser"],
               "runId": { "file": "input/brief.json", "field": "source.run_id" },
               "resume": { "file": "input/base/index.html", "meta": "marshal-page-state" } }]
}
```

```json
{ "version": 1, "agent": "@acme/pages", "extensions": [{ "path": "vendor/pages" }] }
```

- **`agent`** in `marshal-sdk.json`: `@scope/name` (its only agent) or `@scope/name:<id>`. `marshal_sdk.init(path,
  agent=…)` overrides it, `$MARSHAL_SDK_AGENT` overrides that, and a query's `extra_args={"marshal-agent": …}` overrides
  all; `"none"` runs the caller's own agent. With no agent named, `query()` runs the Marshal Claude bridge as before.
- **One route:** `marshal-sdk agent-run --cwd <dir> --state <dir> --logs <dir> [--agent …] [--prompt …]` starts the host,
  calls the agent's `capability` with `{cwd, prompt, model, effort, person, fake, state: {folder, link, location,
  resumed}, logs, progressFile, browser, runLabel, startedBy}`, tails `progressFile` as its progress, and writes
  `logs/summary.json` (usage and cost from the host's sessions; `marshal.outputs` lists what it wrote). The capability
  answers `{result, error?, outputs, model, effort, costUsd?, warnings, skills, details}`. What it reads in `cwd` and
  writes back is its own business.
- **Optional fields:** `fake` (a capability answering `{prompt}` with `{text}`: `MARSHAL_SDK_FAKE=1` / `--fake` runs the
  agent with no model), `ports: ["browser"]` (the host finds a Chrome and passes it), `runId` (where the caller's run id
  is), `resume` (the file whose `<meta name=…>` names an earlier run's state: the SDK reloads it and passes
  `state.resumed`). An entry with a `profile` instead of a `capability` is a Marshal agent profile, launched as a session.
- `marshal-sdk check` lists the agents the manifest's extensions declare and fails when `agent` names none of them.

## Rules

- **One source per entry:** `path` (a built package folder), `archive` (a .tgz, checked against `sha256` when given),
  `url` (a .tgz at `gs://bucket/object` or `https://…`, with a required `sha256`) or `id` (+ optional `version`) from
  the organization. Paths inside the manifest's folder are stored relative, so the
  folder can move into an image whole; paths outside it are stored absolute.
- **Secrets stay out of the file.** A configuration string `${env:NAME}` is read from the host's environment at start;
  a missing variable stops the host with its name. `extensions list` shows references as written and masks values
  under keys that look secret; resolved values are never printed.
- **Flags win.** `--model` and `--effort` override the manifest; `--extension` packages load after its extensions.
- **An identity appears once.** Two listed entries resolving to the same extension stop the host and name both. A
  listed entry replaces a default or an org-profile extension of the same identity.

## A service's extensions: `url` entries

A service (agent-sandbox, Marley) pins each extension to a published archive:

```json
{ "url": "gs://shop-builder-local-runs/marshal-extensions/@zyg/page-studio/0.3.0.tgz",
  "sha256": "603ebc8d5139401f2d775b18739dfd0cb8a64ec32d6aba69bf3f5f4c4c36e797",
  "configuration": { "openaiApiKey": "${env:OPENAI_API_KEY}" } }
```

The host downloads it with its own credentials. `gs://` goes through the Cloud Storage API (read-only scope), signed
in with, in order:

1. the service account key in `$GOOGLE_APPLICATION_CREDENTIALS_JSON` (inline JSON: agent-sandbox loads
   e2b-production's key there from Secret Manager), else a `service_account` file at `$GOOGLE_APPLICATION_CREDENTIALS`
   (the same lookup as the Brain's `service-key` mode), exchanged for a token as a signed JWT;
2. the metadata server's token (a Cloud Run, GKE or GCE service account);
3. the application default credentials (`gcloud auth application-default login`, `GOOGLE_ACCESS_TOKEN`).

`https://` is a plain GET. The bytes must match `sha256`, then unpack into
the cache (`$MARSHAL_SDK_CACHE`, default `.marshal-sdk/extensions` beside the manifest) under that hash, so a repeat
start reads nothing over the network. `marshal-sdk extensions fetch` fills the cache while an image builds.

## What extensions declare they need

An extension's `runtime-extension.json` already says what it needs, in the runtime's own fields:

- `dependencies.extensions: [{ "id": "@marshal/brain", "version"?: "…" }]`: other extensions on the same host;
- `configuration.schema.required: ["key", …]`: settings the host must give (a key in `configuration.defaults` counts
  as given).

Before a host starts, `resolveManifest` and `createMarshalHost` check every loaded extension (the kit's Brain
included) and stop with one error that names every gap at once, together with every unset `${env:…}` variable:

```
/srv/marshal-sdk.json cannot start a host:
  - gs://shop-builder-local-runs/marshal-extensions/@zyg/page-studio/0.3.0.tgz configuration: environment variable OPENAI_API_KEY is not set.
  - @zyg/page-studio@0.2.0 needs the extension @marshal/brain, which this host does not load.
  - @acme/tools@1.0.0 needs the setting "region" in its configuration.
```

Extensions load in dependency order.

## The Brain: `brain`

```json
"brain": { "index": "zyg", "auth": "service", "person": "${env:MARSHAL_BRAIN_PERSON}" }
```

- `index` names the Brain (default `zyg`, ZyG's company Brain). The SDK maps a name to its address (`BRAIN_INDEXES`
  in `src/kit/brain.ts`); the file holds no URL. A Brain the table does not know takes `url` (and `audience`).
- `auth`: `"person"` (default) signs in with the person's own Google credentials (a laptop, a Coder workspace):
  the Brain's `desktop` mode. `"service"` signs in as the service and names the person each run works for
  (`--person`, Python's `ClaudeAgentOptions(user="<email>")`, else `$MARSHAL_SDK_BRAIN_CALLER`; a service call with no
  person fails). How the service signs in follows what the host has:
  - a service account key: `brain.credentialsFile` (a key file, relative to the manifest), else
    `$GOOGLE_APPLICATION_CREDENTIALS_JSON` (the key inline, as an E2B sandbox carries it), else a `service_account` file
    at `$GOOGLE_APPLICATION_CREDENTIALS`: the Brain's `service-key` mode (@marshal/brain 0.2.1 or later);
  - otherwise the metadata server's identity (Cloud Run, GKE, a GCE VM): `delegated` mode.

  `check` reports the mode it chose (`brain.mode`). The Brain front must allow the service account.
- `person` (auth `"service"`): the person a run works for when it names none, an email or `"${env:NAME}"`. The run's
  own person comes first: Python's `user=` (`--person`), then `$MARSHAL_SDK_BRAIN_CALLER`, then `brain.person`. An
  unset variable means no person. A service sign-in with no person runs without the Brain: the `@marshal/brain`
  package still loads (extensions may depend on it), its `knowledge.`, `memory.` and `graph.` calls are refused
  (`kit_no_person`), memory and session publishing are off, and the host says so once (a `WARNING` log line, the
  run summary's `warnings`, `check`'s `warnings`; `check` and `init` still pass).
- A `brain` block turns the kit's Brain on. The old knobs (`MARSHAL_SDK_BRAIN_URL` and friends, a kit object's
  `brain` options) still override it.

## Proving a manifest: `marshal-sdk check`

```sh
marshal-sdk check --manifest marshal-sdk.json [--person someone@zyg.com] [--no-brain-ping]
```

Resolves the manifest (downloads, hashes, `${env:…}`), checks what every extension needs, starts a throwaway host with
exactly those extensions, and asks the Brain one question (`knowledge.search`). It prints a JSON report and exits 1 on
any problem:

```json
{ "ok": true, "manifest": "/srv/marshal-sdk.json",
  "extensions": [{ "identity": "@zyg/page-studio", "version": "0.2.0", "source": "url", "from": "gs://…", "origin": "listed" }],
  "brain": { "index": "zyg", "url": "https://…", "auth": "service", "reachable": true },
  "model": "claude-opus-5-5", "effort": "xhigh", "problems": [], "warnings": [] }
```

Python's `marshal_sdk.init(path)` runs it once at a service's start and raises `MarshalInitError` with the problems.

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
| `brain` | `@marshal/brain` | always (the kit's Brain) | `kit.brain.packageRoot`, `$MARSHAL_SDK_BRAIN_PACKAGE`, the SDK's `extensions/brain` (where `image/pack.mjs` puts it), or the organization |
| `zygTools` | `@zyg/marshal-runtime-extension` | `"profile": "zyg"` (a Zyg host) | `$MARSHAL_SDK_ZYG_EXTENSION` or the organization |

- **`@marshal/org` is told which organization to join:** its configuration gets `{discovery, profile?}` from the
  manifest's `org`, under any configuration the manifest gives it.
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

`docs/onboarding-proof/installed-tarball-proof.txt` (2026-11-15, Node 24.14, no model):
- `image/pack.mjs` packed Page Studio with the Brain default, and `npm install` put the tarball into an empty folder.
- With `MARSHAL_SDK_BRAIN_PACKAGE` unset, the Brain came up from `<install>/node_modules/@marshal/sdk/extensions/brain`,
  marked "(default)", and Page Studio answered.
- A `kit: ["memory"]` manifest found the same bundled Brain.

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
