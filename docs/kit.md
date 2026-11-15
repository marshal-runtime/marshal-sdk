# The kit: Brain, memory and session search on a Marshal SDK host

Every Zyg internal agent (the page generator, Marley, zyg-agents) needs three things a desktop Marshal session
has: the company Brain, the team's memory, and earlier sessions. The kit gives a headless host all three with
one option:

```ts
import { createMarshalHost } from "@marshal/sdk";

const host = await createMarshalHost({
  workspacePath,
  stateRoot,
  kit: ["brain", "memory", "sessions"],
});
```

With the kit on, each session's prompt gets a "Knowledge, memory and past sessions" section that names the
capabilities and their call shapes, and the capabilities are in the runtime catalog for `runtime_exec`,
`context.runtime.invoke` and `host.invoke`. The kit is **read-only by default**: every capability that writes to
the team's production stores is refused by the host's permission broker, or is not registered at all.

Code: `src/kit/` (`brain.ts` configuration, `memory.ts`, `sessions.ts`, `index.ts` with `prepareKit` and the
broker) and the `kit` option in `src/host.ts`. Tests: `test/kit.test.ts`.

## What each part is

| Part       | Capabilities on the host                                                                         | Backed by                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `brain`    | `knowledge.search`, `context`, `impact`, `path`, `refine`, `schema`, `health`                    | The `@marshal/brain` extension (v0.2.0), loaded on the host's runtime with its cloud-only surface               |
| `memory`   | `memory.recall {query, limit?}`                                                                  | `knowledge.search {kinds: ["memory"]}` on the Brain: the team memories, each fact wrapped in `<untrusted_memory>` |
| `sessions` | `sessions.search {query, scope?, limit?, workspace?, since?, until?}`                            | This host's own session store + the Brain's shared session index (`sessions.cloud_search`), merged by rank       |

`memory` implies `brain`. `sessions` works without the Brain (local store only; the result says the shared index
is `unavailable`).

### How the Brain is loaded

It is loaded the way the desktop and zyg-agents load it: a built `@marshal/brain` package installed through the
runtime's extension lifecycle, with the runtime's **code-intelligence service on** (the extension requires it;
the kit turns it on). The configuration is the cloud-only surface (`brainConfiguration()` in `src/kit/brain.ts`):

- `cloudEnabled: true`, `brainSurface: "demo"`, with no local index (`brainHostMemory: false`), no brand tools and
  no answer card.
- `cloudUrl`: the Cloud Run front `https://zyg-agents-front-559219955260.us-central1.run.app`.
- `cloudCallerMode`:
  - `desktop` (the default): the person's own Google user credentials (gcloud ADC, or `kit.brain.credentialsFile`)
    mint an ID token for `brain-portal@zyg-ecom-meetings.iam.gserviceaccount.com`, and the Brain answers as that
    person.
  - `delegated`: a service on Google Cloud signs with its metadata-server ID token, and the person comes from the
    host principal's `callerEmail` claim (`kit.brain.callerEmail`, with access labels from `kit.brain.access`).
- A `brainRoutes` entry with `memory: true` is written only when memory writes are on.

zyg-agents loads the same package with a heavier setup: a local Quillstone index, a `bootstrapModule`, and
`BRAIN_PERMISSIONS` including `code.index.rebuild`. The kit deliberately uses only the cloud read path: a
sandbox gets the whole team's graph without indexing anything.

The package is found at `kit.brain.packageRoot` or `$MARSHAL_SDK_BRAIN_PACKAGE`. Build it from
`marshal-brain-memory` (`origin/main` commits its `dist/`): the folder needs `runtime-extension.json`,
`package.json`, `dist/`, `ui/`.

## Proof (2026-11-15, Node 24.22.2, Omer's Mac, desktop caller mode)

The script is `.runs/kit/proof.mjs` (gitignored): `createMarshalHost({ kit: ["brain", "memory", "sessions"] })`,
calls on the host, then one haiku session. The full output is in [`kit-proof/proof.txt`](kit-proof/proof.txt).

**Host calls (`host.invoke`)**

```
[host] extension @marshal/brain@0.2.0 active
prompt has kit section: true

== knowledge.search cloud: {"status":"ok","hits":5,"caller":"omer.machluf@zyg.com",...}
 - cloud:entity:table/zyg-postgres.public.device_push_token | table
 - cloud:memory:mem-7b98ff7e-... | memory | zyg-agents uses no scheduled polling: every flow is triggered by events ...
== knowledge.context cloud:entity:table/zyg-postgres.public.device_push_token {"target":{... "source_path":"common/db-models/models/postgres/sql/device_push_token.sql" ...},"nodes":[...columns...]}

== memory.recall cloud: {"status":"ok","hits":3,"caller":"omer.machluf@zyg.com",...}
 - cloud:memory:mem-6ddff8ae-... v1:zyg/skill/run-airflow-tests <untrusted_memory>Skill "run-airflow-tests": Run Airflow tests locally ...</untrusted_memory>

== sessions.search local: 0 cloud: {"status":"ok","caller":"omer.machluf@zyg.com","hits":20}
 - cloud zyg-agents 2026-11-04T09-02-54-e773200d | INF-7439 | zyg-agents 2026-11-04T09:11:48.464Z
 - cloud zyg-agents 2026-11-02T13-24-42-4796ca15 | PageBuilderWorkflow: failing run | zyg-agents

== writes stay off
 - sessions.cloud_share -> denied kit_write_disabled sessions.cloud_share writes to the team's production Brain; ...
 - knowledge.feedback -> denied kit_write_disabled ...
 - memory.propose -> not_found capability_not_found
 - memory.remember -> not_found capability_not_found
 - sessions.share -> not_found capability_not_found
```

The kernel asks the permission broker before it calls a provider (`agent-runtime-core` `kernel.ts`
`runtimeExec`), so a denied write never reaches the Brain. The denial probe also sent inputs that could not
have stored anything.

**A haiku session on the host.** This used Omer's `omer-max` subscription with `ANTHROPIC_API_KEY` removed. The
session `f40047f9-e3e6-44ca-a5ff-4bce98176af2` (native `4e2502fc-29a5-410d-aa72-30a467f76b06`) cost $0.0136 and
ran in an empty workspace, so the zyg repo was reachable only through the Brain. Asked where the store-manager's
page builder Temporal workflow lives, who works on it, and what recent changes were about, it called:

```
mcp__marshal__runtime_exec knowledge.search {"query":"store-manager page builder Temporal workflow","limit":10}
mcp__marshal__runtime_exec memory.recall    {"query":"store-manager page builder Temporal workflow"}
mcp__marshal__runtime_exec sessions.search  {"query":"store-manager page builder Temporal workflow"}
mcp__marshal__runtime_exec knowledge.context {"target":{"kind":"node","id":"cloud:code:services/shops/store-manager/services/temporal/workflows/pagebuilder/pagebuilder_workflow.go"},"maxDepth":1}
```

and answered:

> The PageBuilder workflow lives at `services/shops/store-manager/services/temporal/workflows/pagebuilder/pagebuilder_workflow.go`
> (`PageBuilderWorkflow`, tests in `pagebuilder_workflow_test.go`). Ido Miller (GitHub `millerZygCoys`) is the
> main author of recent PRs; Matan Albeck did earlier positioning/Shopify-stop work. Recent changes center on
> Claude-agent page runs: CRO-1644 (PR #20451, open) DM the page agent run after its studio import; CRO-1339
> (PR #19013, open) context-only page runs; CRO-1469/1475/1489 (closed Nov 11) studio import and editor link;
> ... Sessions showed a Nov 4 failed run (run 745) ...

An earlier run, on a question the Brain had no code for (GitHub OIDC verification in zyg-agents), showed that
haiku copied the Brain's own "drill" hint (`traverse {from:[id]}`) into `knowledge.context` and was refused.
The kit prompt now gives the exact call shapes (`{target: {kind: "node", id}}`); the run above used them first
time.

## Known gap

`knowledge.context` at `maxDepth: 1` on a busy file returned **201,274 characters**: more than a session's tool
result limit. The session recovered by reading the saved file with `rg`, but a sandbox without a shell would
not. The fix belongs in the Brain extension (a node and character budget on `context`), or in a kit wrapper that
trims it. It has not been done here.

In this run the session's own `sessions.search` returned the session itself as the top local hit (this host's
store holds the running session), followed by the shared zyg-agents runs. `sessions.search` now leaves out the
calling session, as the desktop's search does (unit-tested; this change came after the proof run). The
host-level call above found no local hit because no earlier session on this host matched its query.

## Off pending a decision (Omer)

Each write has a kit option that is **off**. While it is off, the capability is either not registered or refused
by the broker with `kit_write_disabled`.

| Write                          | Option                          | What it does when on                                                                                                                                  |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team memory proposals          | `kit.memory.writes: true`       | Registers `memory.remember {fact, links?, key?}`, which calls the Brain's `memory.propose` through a `brainRoutes[<workspace>].memory: true` route (optional `kit.memory.anchorPath`) |
| Sharing sessions to the index  | `kit.sessions.ingest: true`     | Registers `sessions.share {sessionId, people?}`, which sends the session's user and assistant messages (tool output dropped, each capped) to `sessions.cloud_share` |
| Search feedback                | `kit.brain.feedback: true`      | Allows `knowledge.feedback` (the Brain's search-quality log)                                                                                            |

Both write paths are tested against fakes only (`test/kit.test.ts`); nothing was written to production.

**What identity a memory written by a service carries.** `memory.propose` stores a `memory_link` in state
`proposed` with `capturedBy: marshal-agent`:

- **The proposer is whoever signed the request.**
  - In `delegated` mode that is the sandbox's service account.
  - In `desktop` mode it is the person whose credentials the host holds.
- **A speaker is recorded only with user credentials.** The record gets
  `speaker {kind: "human", id: <email>, relayedBy: "marshal-agent"}` with `trust: "human-relayed"`. A service
  signing alone writes a memory with no human speaker: an agent-authored fact.
- **A proposal stays private until approved.** Only its proposer sees it until someone on
  `QUILLSTONE_MEMORY_APPROVERS` approves it with their own token.

zyg-agents' own memories use keys `v1:agent-<category>/<slug>`; personal ones use
`v1:personal-<category>/<person>-<slug>`.

**What a shared session written by a service carries.** The shared index stores a person's share under their
email with `source: marshal`, and a zyg-agents job's under `zyg-agents`. An SDK sandbox signing as a service
account has no defined owner today, so the front may refuse it or file it under the service. Decide that before
turning ingest on.

The decisions:

1. May a headless host propose team memories, and as whom (the service account, or the person it works for)?
2. May SDK sessions be shared into the production session index, under which owner and `source`?
3. Which service account does a sandbox use for `delegated` mode, and does the front accept it? Today the front
   accepts the desktop ID-token path for people and zyg-agents' own runners.

## What a sandbox needs

- **Node ≥ 24.** The Brain keeps a small local SQLite catalog and needs FTS5. Node 22.14 fails activation with
  `no such module: fts5`; Node 24.22.2 works. The image (`image/Dockerfile`) is on `node:24.19.0`, which is not
  yet verified with the Brain.
- **The Brain package in the image.** Pass it to `node image/prepare.mjs --extension <brain-package>`, which
  copies it to `/opt/marshal-sdk/extensions/<name>`, and set `MARSHAL_SDK_BRAIN_PACKAGE` to that path (or pass
  `kit.brain.packageRoot`). The kit refuses to start without it and says how to fix it.
- **Network** to the Cloud Run front (`zyg-agents-front-…run.app`) and to Google's token endpoints
  (`oauth2.googleapis.com`, `iamcredentials.googleapis.com` in `desktop` mode; the metadata server in `delegated`
  mode).
- **Credentials**, one of:
  - `desktop`: an `authorized_user` credentials file for a person (`kit.brain.credentialsFile`). This suits a
    developer's sandbox, not a shared service.
  - `delegated`: the sandbox runs on Google Cloud as a service account the front accepts.
    `kit.brain.callerEmail` (the person the run works for) and `kit.brain.access` (labels such as `staff` and
    `user:<email>`) go on the host principal; they are never taken from model input. This is open decision 3.
- **No API key for the model.** The kit changes nothing about how sessions reach the model.

## Unit tests

`npm test` covers the kit in `test/kit.test.ts`:

- recall maps and wraps memories, and escapes closing tags;
- `memory.remember` exists only with writes on, and proposes to a fake;
- `sessions.search` merges local and shared hits by rank, and survives a failing or absent Brain;
- `sessions.share` exists only with ingest on, and sends the right payload to a fake `cloud_share`;
- `brainConfiguration` writes a memory route only with writes on;
- `prepareKit` defaults (memory implies the Brain, code intelligence, principal claims, denials, prompt);
- the broker denies the writes and defers everything else;
- a real host with `kit: ["sessions"]` serves `sessions.search` and its prompt names it.

## Skills from extensions

An extension brings its skills with it. Its `runtime-extension.json` declares each skill folder as a catalog
contribution:

```json
{ "contributes": { "catalog": ["skill:skills/lp-roles", "skill:skills/lp-review"] } }
```

- **The folder.** Each folder holds a `SKILL.md` with frontmatter `name` (lowercase, defaults to the folder name)
  and `description`. Its other `.md` and `.txt` files are references.
- **Not a declaration.** An entry `skill://...` is the id of a skill entry an extension registers in code, not a
  folder.
- **Why `contributes.catalog`.** Every released runtime accepts that key and ignores its strings, while it rejects
  any unknown `contributes` key. So the same package installs on the desktop's pinned packs today.

On a host:

- **Search.** Every declared skill is a runtime_search `skill` entry `skill://<identity>/<name>`. Its action reads
  the `SKILL.md` text, and `metadata.references` lists `skill://<identity>/<name>/<path>` for each reference.
- **Read.** Sessions read a skill with the `mcp__marshal__runtime_read_resource {uri}` tool; code on the host uses
  `host.readResource(uri)`.
- **Prompt.** The session prompt gets a "Skills from installed extensions" section naming each skill, the extension
  it came from and its URI. `host.skills` lists them.
- **Refusals.** A missing `SKILL.md`, a missing description, or a bad or repeated name stops the host from starting,
  as the runtime refuses such a package.

The runtime reads the same declaration natively from agent-runtime-extensions (runtime PR "extensions: skills
declared as skill: catalog contributions"), and there disable and remove take the skills out with the activation.
The SDK host runs the desktop's pinned packs (host-72), which don't, so `src/extension-skills.ts` reads the
declaration itself and registers the same entries and resources. It stands aside when the loaded runtime exports
`readRuntimeExtensionSkills`. This host installs its extensions once at start, so there is no disable here.

The desktop lists the same skills with the person's own skills and loads them with `getSkill`, marked with the
extension they came from.

Tests: `test/extension-skills.test.ts`, with a fixture extension carrying one skill and one reference, on the pinned
packs.

## Lanes and messages between sessions

Sessions on a host talk to each other under the desktop's names (`electron/self-tools.ts`), so an agent prompted for
the desktop calls the same capabilities here:

- **`marshal.tool.startLane {task, name?, model?, reasoningEffort?}`** starts a lane. A lane is a top-level session
  with no parent, so nothing reports back on its own. It starts with only the brief:
  - When a session launches it, the brief opens with the desktop's lane line ("You are a new Marshal session (a lane)
    started by session ... send it ... with marshal.tool.messageSession {sessionId: ...}"), then the task.
  - The record carries `launchedBy`, and the brief's transcript message carries `from`.
  - Desktop-only fields (workspace, worktree, runtime, permission mode) are accepted and ignored.
- **`marshal.tool.messageSession {sessionId, host?, message, deliveryMode?, replaceQueued?, waitForResponse?,
  timeoutMs?}`** messages any session by id:
  - `queue` (the default) runs the message after the target's current turn. `interrupt` stops that turn ("Turn
    cancelled." in its transcript) and runs this message next.
  - `replaceQueued` drops the sender's own undelivered messages. `waitForResponse` returns the target's reply to this
    message.
  - The target reads the desktop's sender line, "Message from session <title> (<id>):". Its transcript message
    records `from: {kind, sessionId, name, host?}`.
  - A session can't message itself.
- **`marshal.tool.searchSessions {query, since?, until?, workspace?, includeSubagents?, limit?}`** searches this
  host's store and leaves the caller out. Hits carry `parentId` and `launchedBy`. The kit's `sessions.search` also
  covers the team's shared sessions.
- **`marshal.tool.getSessionTranscript {sessionId, lastN?}`** returns the latest messages, each with `from` when
  someone else sent it.

`marshal.agent.launch` from a session now makes a child of it (`parentId`). Before this change the provider read the
caller from the wrong field, so no SDK child had a parent.

**Addressing for other hosts.** A target is `{host?, sessionId}`; no `host`, or this host's id, means this host.
`src/session-messages.ts` defines:

- the `SessionEnvelope`: `messageId`, `from`, `to`, `body`, `deliveryMode`, `sentAt` and the options above;
- the `DeliveryResult`;
- the `SessionTransport { hostId, deliver(envelope) }`.

`host.agents.addTransport(transport)` routes envelopes for another host through it. A host with no transport is
refused ("No route to host ..."). On the receiving side, `host.agents.deliver(envelope)` puts an envelope into a local
session with the sender's `host` kept on `from`. The link implements the transport; this package does not.

Tests: `test/session-messages.test.ts`:

- port level: the sender line and `from`, queue and wait for the reply, interrupt, replaceQueued, the refusals, and a
  fake transport carrying an envelope;
- host level: sessions act through their own `marshal` MCP server. A session starts a lane, launches a child with a
  parent, and the lane messages its launcher back; both are found and read.

## Automations: schedule- and event-based runs

**What the runtime gives.** The scheduling builtin is a facade. `runtime.schedules.{create,get,list,update,pause,
resume,cancel}` dispatch `runtime.schedule.*` effects to a scheduler the host supplies; without one they answer
`unsupported`. The runtime ships that scheduler too: `RuntimeScheduleService` on a `FileScheduleStore` gives durable
once, interval and cron timing, retries, catch-up after downtime and an injectable clock. The host now turns the builtin
on (`scheduling: true`) and passes its scheduler. Its task kinds are:

- `agent.wake`: the runtime's own kind; it wakes a session with a message;
- `marshal.automation.run`;
- `marshal.automation.check`.

**The capability family** uses the desktop's automation self-tool names:

- `marshal.tool.createAutomation {name, prompt, …}` creates a prompt that starts a new session per run, or wakes one
  (`wakeThisSession`, `targetSessionId`). `triggerType` picks the trigger:
  - **`schedule`**: `schedule` is a five-field cron expression (in `timezone`, default the host's) or "every N
    minutes|hours|days"; `runAt` or `runInMinutes` make a one-off. The desktop's phrases such as "every weekday at
    9am" are not parsed here; they are cron here ("0 9 * * 1-5").
  - **`condition`**: the desktop's check. Every `conditionCheckInterval` minutes (5, 15, 30 or 60), one check session
    gets the desktop's prompt. On `CONDITION_MET` the automation runs once, completes and its checks stop.
  - **`event`**: runs on every event of type `event` whose payload has the `eventMatch` values. The payload goes into
    the prompt, marked as data.
- `marshal.tool.listAutomations`, `getAutomation`, `updateAutomation` (a new trigger replaces the old schedule;
  `enabled: false` pauses it), `deleteAutomation` and `runAutomationNow`.
- `marshal.events.emit {event, payload}` is new (the desktop has no event bus to name it after).

**Event sources:**

- `host.emit(event, payload)`, for host code such as Marley's inbound message handler;
- `marshal.events.emit`;
- `session.idle` and `session.failed`, which the agent port raises when a session's queued work ends;
- every event on the runtime's event bus.

A session an automation started never triggers that same automation.

**Restart.** Definitions live in `<stateRoot>/automations/automations.json` and schedules in
`<stateRoot>/automations/schedules/`. The first tick after a start fires what fell due while the host was down: once
per schedule, not once per missed slot. Event automations need nothing re-armed. `automations: {now, start: false}`
gives a fake clock and `host.automations.tick()`. The tick loop's timer is unref'd, so a host that nobody disposed
doesn't hold Node open.

Tests: `test/automations.test.ts`, with a fake clock and no model:

- interval, one-off and cron runs;
- a restart that runs one missed slot once, keeps a paused automation paused and still triggers an event automation;
- a condition that is not met, then met, through one resumed check session;
- event matching, the payload in the prompt, `marshal.events.emit`, and `session.idle` without self-triggering;
- a `runtime.schedules.create` `agent.wake` waking a session;
- an automation waking its target session.
