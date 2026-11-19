// One run of an agent an extension declares (`contributes.agents`), on a headless Marshal host, from a caller's working
// folder: the one route marshal_sdk.query() takes when the caller chose an agent at init. The SDK knows nothing of what
// the agent does; it starts the host the caller's marshal-sdk.json declares, gives the agent its run (working folder,
// prompt, model, person, state folder and its link), and writes the run's logs from the host's sessions:
//   <logs>/run.jsonl, <logs>/summary.json, <logs>/query/{system_prompt.md, task.md, options.json}, <logs>/progress.log
//
//   marshal-sdk agent-run --cwd <dir> --state <dir outside cwd> --logs <dir> [--agent @scope/name[:id]] [--prompt <text | @file>]
//
// Two kinds of agent:
// - a capability agent ({"id", "capability"}): the extension's own code runs the whole run. The host calls the
//   capability with AgentRunInput and reads AgentRunOutput; what it reads in cwd and writes back is its own business.
// - a profile agent ({"id", "profile"}): one host session with the profile's prompt, scope and model, given the prompt.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentLaunchFields, readExtensionAgents, resolveAgent, type AgentEntry } from "./agent-entries.js";
import type { QueryFn } from "./agent-port.js";
import { browserEnv, NO_CHROME_WARNING, answersPipe, resolveChrome } from "./chrome.js";
import type { KitOptions, SessionsPublishOptions } from "./kit/index.js";
import { AGENT_REF } from "./onboarding.js";
import { cloudRunLayer } from "./prompt-cloud.js";
import { desktopSurface } from "./prompt-desktop.js";
import { turnSessions, writeRunLogs, type RunSummaryJson } from "./run-contract.js";
import { declaredHost, kitArgument, publishArgument, textArgument, type KitPartName } from "./run-kit.js";

/** What a capability agent is called with. */
export interface AgentRunInput {
  /** The caller's working folder: the agent reads its input there and writes its output there. */
  cwd: string;
  /** The caller's prompt, as the query had it. */
  prompt: string;
  model?: string;
  effort?: string;
  /** The person the run works for (email). */
  person?: string;
  /** A dry run: the host's sessions answer from the agent's `fake` capability, no model is called. */
  fake: boolean;
  /**
   * The run's state folder, kept (and uploaded by the caller) after the run; the host keeps its sessions in host/,
   * the agent keeps its own data beside it. `link` is where this state is found later (a gs:// location or a key):
   * an agent whose output a later run continues stamps it there (its entry's `resume`). `resumed`: the folder holds
   * an earlier run's state, which this run continues.
   */
  state: { folder: string; link?: string; location?: string; resumed: boolean };
  /** The run's log folder (summary.json, run.jsonl and query/ are the host's; anything else there is the agent's). */
  logs: string;
  /** Append one line per step here; the caller sees each as it is written. */
  progressFile: string;
  /** With the `browser` port: the Chrome the host found, a launcher with this machine's flags, and whether it answered. */
  browser?: { chrome?: string; launcher?: string; usable: boolean };
  /** The caller's own run id (the entry's `runId`). */
  runLabel?: string;
  startedBy?: string;
}

/** What a capability agent returns. Usage and cost come from the host's sessions; `costUsd` is spend outside them. */
export interface AgentRunOutput {
  /** The run's answer in words: the query's result text. */
  result?: string;
  /** Set when the run failed: the reason. */
  error?: string;
  /** Files it wrote, relative to cwd. */
  outputs?: string[];
  model?: string;
  effort?: string;
  costUsd?: number;
  warnings?: string[];
  /** Skills it loads into its own prompts, and the ones this run used (they count in the run's skills). */
  skills?: { loaded?: string[]; used?: string[] };
  /** Anything else for summary.json's marshal section. */
  details?: Record<string, unknown>;
}

export interface AgentRunOptions {
  /** `@scope/name` or `@scope/name:id`. Default: the manifest's `agent`. */
  agent?: string;
  cwd: string;
  prompt?: string;
  /** Host-private folder outside cwd: the host's sessions and the agent's data. */
  state: string;
  logs: string;
  manifest?: string;
  /** Package folders loaded next to (or, without a manifest, instead of) the manifest's: developing an extension. */
  extensions?: readonly string[];
  person?: string;
  model?: string;
  effort?: string;
  kit?: readonly KitPartName[];
  publish?: SessionsPublishOptions;
  startedBy?: string;
  /** Where the caller uploads the state folder (gs://…), named in the prompt and given to the agent. */
  stateLocation?: string;
  /** How a later run finds this state: the location, or a key the caller keeps it under. */
  stateLink?: string;
  /** The state folder holds an earlier run's state that this run continues. */
  resumed?: boolean;
  runLabel?: string;
  fake?: boolean;
  env?: Record<string, string>;
  host?: { id: string; kind: string };
  labels?: Record<string, string>;
  log?: (line: string) => void;
}

/** One agent the manifest's extensions declare, found by its reference. */
export interface FoundAgent {
  ref: string;
  identity: string;
  packageRoot: string;
  entry: AgentEntry;
}

const DEFAULT_TIMEOUT_MINUTES = 6 * 60;
const PROGRESS_FILE = "progress.log";

/** The agent `ref` names among the loaded extensions: `@scope/name` (its only agent) or `@scope/name:id`. */
export function findAgent(ref: string, extensions: readonly { packageRoot: string; identity: string }[]): FoundAgent {
  if (!AGENT_REF.test(ref)) throw new Error(`"${ref}" is not an agent: write @scope/name or @scope/name:<agent id>.`);
  const [identity, id] = ref.split(":") as [string, string | undefined];
  const extension = extensions.find((loaded) => loaded.identity === identity);
  if (!extension) throw new Error(`The agent ${ref} is not on this host: ${identity} is not among its extensions (${extensions.map((loaded) => loaded.identity).join(", ") || "none"}).`);
  const { agents } = readExtensionAgents(extension.packageRoot);
  const entry = id ? agents.find((agent) => agent.id === id) : agents.length === 1 ? agents[0] : undefined;
  if (!entry) {
    const known = agents.map((agent) => `${identity}:${agent.id}`).join(", ") || "none";
    throw new Error(id ? `${identity} declares no agent "${id}" (it declares: ${known}).` : `${identity} declares ${agents.length} agents; name one: ${known}.`);
  }
  return { ref: `${identity}:${entry.id}`, identity, packageRoot: extension.packageRoot, entry };
}

/** Every agent the extensions declare, as references and what they are (for the check report). */
export function declaredAgents(extensions: readonly { packageRoot: string; identity: string }[]): { ref: string; kind: "capability" | "profile"; description: string; entry: AgentEntry }[] {
  return extensions.flatMap((extension) => {
    let agents: AgentEntry[] = [];
    try {
      agents = readExtensionAgents(extension.packageRoot).agents;
    } catch {
      return [];
    }
    return agents.map((entry) => ({ ref: `${extension.identity}:${entry.id}`, kind: entry.capability ? ("capability" as const) : ("profile" as const), description: entry.description, entry }));
  });
}

/** Runs the agent once and writes the run's logs. Resolves with summary.json (with `marshal.outputs`); a failed run still writes it. */
export async function runAgent(options: AgentRunOptions): Promise<RunSummaryJson> {
  const log = options.log ?? (() => undefined);
  const cwd = path.resolve(options.cwd);
  const logs = path.resolve(options.logs);
  const state = path.resolve(options.state);
  for (const directory of [path.join(logs, "query"), path.join(state, "host")]) fs.mkdirSync(directory, { recursive: true });
  const env: Record<string, string> = {
    ...(options.env ??
      Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))),
  };
  const declared = await declaredHost({ ...options, env }, log);
  const ref = options.agent ?? declared.agent;
  if (!ref) throw new Error(`No agent to run: pass --agent @scope/name, or name one in ${declared.manifest ?? "the manifest"} ("agent").`);
  const agent = findAgent(ref, declared.extensions);
  const prompt = options.prompt ?? "";
  const stateLocation = options.stateLocation ?? env.MARSHAL_SDK_STATE_LOCATION;
  log(`agent ${agent.ref} (${agent.entry.capability ? `capability ${agent.entry.capability}` : "profile"})${options.fake ? ", dry run" : ""}`);

  let browser: AgentRunInput["browser"];
  if (agent.entry.ports.includes("browser")) {
    const chrome = await resolveChrome(env);
    const usable = Boolean(chrome) && (await answersPipe(chrome!));
    if (!usable) log(`WARNING ${NO_CHROME_WARNING}`);
    const set = chrome ? browserEnv(chrome, state, env) : undefined;
    // The agent runs in this process: it reads the browser from here as well as from its input.
    if (set) Object.assign(process.env, Object.assign(env, set));
    browser = { ...(set ? { chrome: set.MARSHAL_SDK_CHROME, launcher: set.MARSHAL_SDK_CHROME_LAUNCHER } : {}), usable };
  }

  const started = Date.now();
  const { createMarshalHost } = await import("./host.js");
  let hostRef: { invoke: (capability: string, input: unknown) => Promise<unknown> } | undefined;
  const fake = agent.entry.fake;
  const host = await createMarshalHost({
    workspacePath: cwd,
    stateRoot: path.join(state, "host"),
    extensions: declared.extensions.map(({ packageRoot, configuration }) => ({ packageRoot, ...(configuration !== undefined ? { configuration } : {}) })),
    host: options.host ?? { id: "marshal-sdk", kind: "local" },
    labels: { job: "agent-run", agent: agent.ref, ...options.labels },
    prompt: runPrompt(agent, { ...options, ...(stateLocation ? { stateLocation } : {}) }, declared.kit),
    env,
    ...(declared.model ? { model: declared.model } : {}),
    ...(declared.effort ? { reasoningEffort: declared.effort } : {}),
    ...(declared.kit ? { kit: declared.kit } : {}),
    ...(options.fake
      ? { query: dryQuery(async (text) => (fake && hostRef ? fakeText(await hostRef.invoke(fake, { prompt: text })) : DRY_ANSWER)), browser: false }
      : {}),
    log,
  });
  hostRef = host;
  const usageBefore = new Map(host.sessions.list().map((session) => [session.id, { ...session.usage }]));
  const progressFile = path.join(logs, PROGRESS_FILE);
  fs.writeFileSync(progressFile, "");
  const stopTail = tail(progressFile, (line) => log(`${agent.ref}: ${line}`));
  const timeoutMs = DEFAULT_TIMEOUT_MINUTES * 60_000;

  let output: AgentRunOutput = {};
  let failure = "";
  try {
    fs.writeFileSync(path.join(logs, "query", "system_prompt.md"), host.systemPrompt() ?? "");
    fs.writeFileSync(path.join(logs, "query", "task.md"), prompt);
    if (agent.entry.capability) {
      const input: AgentRunInput = {
        cwd,
        prompt,
        ...(declared.model ? { model: declared.model } : {}),
        ...(declared.effort ? { effort: declared.effort } : {}),
        ...(declared.kit?.brain?.callerEmail ? { person: declared.kit.brain.callerEmail } : {}),
        fake: Boolean(options.fake),
        state: { folder: state, ...(options.stateLink ? { link: options.stateLink } : {}), ...(stateLocation ? { location: stateLocation } : {}), resumed: Boolean(options.resumed) },
        logs,
        progressFile,
        ...(browser ? { browser } : {}),
        ...(options.runLabel ? { runLabel: options.runLabel } : {}),
        ...((options.startedBy ?? env.MARSHAL_SDK_STARTED_BY) ? { startedBy: options.startedBy ?? env.MARSHAL_SDK_STARTED_BY } : {}),
      };
      fs.writeFileSync(path.join(logs, "query", "options.json"), JSON.stringify({ agent: agent.ref, capability: agent.entry.capability, input }, null, 2));
      output = asOutput(await host.invoke(agent.entry.capability, input, timeoutMs));
    } else {
      const resolved = resolveAgent(
        agent.packageRoot,
        agent.entry.id,
        { ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) },
        (identity) => declared.extensions.find((extension) => extension.identity === identity)?.packageRoot,
      );
      const { labels, ...fields } = agentLaunchFields(resolved);
      fs.writeFileSync(path.join(logs, "query", "options.json"), JSON.stringify({ agent: agent.ref, profile: resolved.fingerprint, model: fields.model, effort: fields.reasoningEffort }, null, 2));
      const session = host.agents.launch({ task: prompt || `Run ${agent.entry.title}.`, idempotencyKey: `agent-run:${randomUUID()}`, name: agent.entry.title, ...fields, labels: { ...labels, job: "agent-run" } });
      const minutes = resolved.profile.limits?.timeoutMinutes;
      const waited = await host.agents.wait(session.id, (minutes ?? DEFAULT_TIMEOUT_MINUTES) * 60_000);
      output = waited.state === "timeout" ? { error: `${agent.ref} did not finish in time` } : { result: waited.result ?? "", ...(fields.model ? { model: fields.model } : {}) };
    }
    if (output.error) throw new Error(output.error);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${failure}`);
  } finally {
    stopTail();
  }

  const warnings = [...host.warnings, ...(output.warnings ?? [])];
  for (const warning of new Set(output.warnings ?? [])) log(`WARNING ${warning}`);
  const summary = writeRunLogs({
    logDir: logs,
    storeRoot: path.join(state, "host", "sessions"),
    sessions: turnSessions(host.sessions.list(), usageBefore, host.runId, started),
    model: output.model ?? declared.model,
    effort: output.effort ?? declared.effort,
    started,
    since: started,
    error: failure,
    requiredSkills: [],
    loadedSkills: output.skills?.loaded ?? [],
    usedSkills: output.skills?.used ?? [],
    marshal: {
      runId: host.runId,
      agent: agent.ref,
      engine: agent.identity,
      fake: Boolean(options.fake),
      reply: output.result ?? "",
      outputs: output.outputs ?? [],
      ...(output.costUsd ? { agentCostUsd: output.costUsd } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...output.details,
    },
  });
  await host.dispose().catch(() => undefined);
  return summary;
}

function asOutput(value: unknown): AgentRunOutput {
  const output = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  // A refused call comes back as {ok: false, error} from some extensions.
  if (output.ok === false && typeof output.error !== "string") return { ...output, error: String(output.code ?? "the agent refused the run") } as AgentRunOutput;
  return output as AgentRunOutput;
}

function fakeText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = (value as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : DRY_ANSWER;
}

const DRY_ANSWER = "{}";

/** A scripted backend for a dry run: each turn's answer comes from `answer` (the agent's `fake` capability); no model. */
export function dryQuery(answer: (prompt: string) => Promise<string>): QueryFn {
  return (params) =>
    (async function* () {
      const text = await answer(await promptText(params.prompt));
      const sessionId = randomUUID();
      yield { type: "system", subtype: "init", session_id: sessionId, model: String(params.options.model ?? "fake"), skills: [], tools: [], cwd: params.options.cwd };
      yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: sessionId };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        result: text,
        session_id: sessionId,
      };
    })();
}

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const message of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
      const content = message?.message?.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) for (const block of content) if (block?.type === "text") parts.push(String(block.text));
    }
  }
  return parts.join("\n");
}

/** Calls `onLine` for each line appended to `file` until the returned stop is called (which reads what is left). */
function tail(file: string, onLine: (line: string) => void): () => void {
  let offset = 0;
  let rest = "";
  const read = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(handle, buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (rest + buffer.toString("utf8")).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trimEnd());
    } finally {
      fs.closeSync(handle);
    }
  };
  const timer = setInterval(read, 500);
  return () => {
    clearInterval(timer);
    read();
    if (rest.trim()) onLine(rest.trimEnd());
  };
}

/**
 * The cloud run layer of the run's sessions (src/prompt-cloud.ts): host facts only (who it is for, where state goes,
 * which tools exist). How the work is done belongs to the agent's extension, the same as on a desktop.
 */
function runPrompt(agent: FoundAgent, options: AgentRunOptions, kitOptions: KitOptions | undefined) {
  const parts = new Set<string>(kitOptions?.parts ?? []);
  const startedBy = options.startedBy ?? process.env.MARSHAL_SDK_STARTED_BY;
  return {
    ...cloudRunLayer({
      job: agent.ref,
      ...(agent.entry.description ? { purpose: agent.entry.description.split("\n")[0]!.replace(/\.$/, "") } : {}),
      kit: { brain: parts.has("brain") || parts.has("memory"), memory: parts.has("memory"), sessions: parts.has("sessions"), publishes: Boolean(options.publish) },
      ...(options.runLabel ? { runId: options.runLabel } : {}),
      ...(startedBy ? { startedBy } : {}),
      ...(options.stateLocation ? { stateLocation: options.stateLocation } : {}),
    }),
    surface: desktopSurface(),
  };
}

const USAGE = `marshal-sdk agent-run: one run of an agent an extension declares (contributes.agents), from a working folder.

  --cwd <dir>        the working folder the agent reads and writes                                    (required)
  --state <dir>      host-private folder outside the working folder (the host's sessions, the agent's data) (required)
  --logs <dir>       where run.jsonl, summary.json, progress.log and query/ go                         (required)
  --agent <@scope/name[:id]>  the agent (default: the manifest's "agent")
  --prompt <text | @file>     the caller's prompt
  --manifest <file>  the marshal-sdk.json declaring the host (default: $MARSHAL_SDK_MANIFEST, else ./marshal-sdk.json)
  --extension <dir>  an extension package folder next to the manifest's (repeatable; without a manifest, instead of it)
  --person <email>   who the run works for: the Brain answers with their memories (default: $MARSHAL_SDK_BRAIN_CALLER)
  --model <id>  --effort <low|medium|high|xhigh|max>  --kit <brain,memory,sessions>
  --publish-sessions <team|email,...>  --publish-context <text>
  --state-location <gs://…>  where the caller uploads --state (default $MARSHAL_SDK_STATE_LOCATION)
  --state-link <location | key>  how a later run finds this state; --resumed  --state holds an earlier run's state
  --started-by <email>  --run-label <id>
  --fake             the agent's scripted backend instead of a model: a dry run, no credentials needed
  --claude-config-dir <dir>  run the backend on that Claude account and drop ANTHROPIC_API_KEY
  --host-id <id>  --host-kind <local|container|e2b>

Prints {summary, error, outputs, wall_seconds, cost_usd}. Exit code 0 when the run finished, 1 when it failed.
`;

export async function agentRunCommand(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.\n\n${USAGE}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.add(token.slice(2));
    else {
      values.set(token.slice(2), [...(values.get(token.slice(2)) ?? []), next]);
      index += 1;
    }
  }
  const one = (name: string): string | undefined => values.get(name)?.at(-1);
  const required = (name: string): string => {
    const value = one(name);
    if (!value) throw new Error(`--${name} is required.\n\n${USAGE}`);
    return value;
  };
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const configDir = one("claude-config-dir");
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = path.resolve(configDir);
    delete env.ANTHROPIC_API_KEY;
  }
  const kit = kitArgument(one("kit"));
  const summary = await runAgent({
    cwd: required("cwd"),
    state: required("state"),
    logs: required("logs"),
    env,
    ...(one("agent") ? { agent: one("agent")! } : {}),
    ...(one("prompt") ? { prompt: textArgument(one("prompt")!) } : {}),
    ...(one("manifest") ? { manifest: one("manifest")! } : {}),
    ...(values.get("extension")?.length ? { extensions: values.get("extension")! } : {}),
    ...(one("person") ? { person: one("person")! } : {}),
    ...(one("model") ? { model: one("model")! } : {}),
    ...(one("effort") ? { effort: one("effort")! } : {}),
    ...(kit ? { kit } : {}),
    ...publishArgument(one("publish-sessions"), one("publish-context")),
    ...(one("started-by") ? { startedBy: one("started-by")! } : {}),
    ...(one("state-location") ? { stateLocation: one("state-location")! } : {}),
    ...(one("state-link") ? { stateLink: one("state-link")! } : {}),
    ...(one("run-label") ? { runLabel: one("run-label")! } : {}),
    resumed: flags.has("resumed"),
    fake: flags.has("fake"),
    host: { id: one("host-id") ?? "marshal-sdk", kind: one("host-kind") ?? "local" },
    log: (line) => process.stderr.write(`[marshal-sdk agent-run ${new Date().toISOString().slice(11, 19)}] ${line}\n`),
  });
  const marshal = summary.marshal as { outputs?: string[]; usage?: { costUsd?: number } };
  process.stdout.write(
    `${JSON.stringify({
      summary: path.join(path.resolve(required("logs")), "summary.json"),
      error: summary.error,
      outputs: marshal.outputs ?? [],
      wall_seconds: summary.wall_seconds,
      cost_usd: marshal.usage?.costUsd ?? 0,
    })}\n`,
  );
  return summary.error ? 1 : 0;
}

