import type { Options } from "@zygstinct/marshal-sdk-port/agent-sdk";
import {
  assembleHostPrompt,
  composePromptLayers,
  fillLayerVars,
  mergePromptLayers,
  parseLayerRef,
  resolvePromptLayers,
  sdkBaseLayer,
  type HostPromptOptions,
  type HostPromptRole,
  type HostPromptSection,
  type PromptLayer,
  type PromptLayerSources,
} from "@zygstinct/marshal-sdk-port";

import { LayerKinds, type Layered, type PromptSegment } from "../prompt-segments.js";

/**
 * Marley's system prompt as layers on the Marshal agent prompt v2 (marshal-sdk docs/prompt.md). The SDK's base renders the v2 core on the
 * cloud-headless surface; Marley's words go in as the role's `roleText` and host `sections` (no `soul`: the soul is the outbox composer's alone, docs/design/marley-model.md), in the order Marley assembled them,
 * and the host-dependent spans of the core are filled through `slots`. No `override` and no custom prompt: what a session gets is always the
 * Marshal base plus these layers, assembled by the port (`ClaudeAgentPort.systemPrompt`).
 */

/** The layer of a turn, set on the options a caller hands the engine (read by the marshal-sdk engine; never sent to the SDK). */
export const PROMPT_LAYER: unique symbol = Symbol("marley.marshal-prompt-layer");

export function withPromptLayer(options: Options, layer: PromptLayer): Options {
  return Object.assign({ ...options }, { [PROMPT_LAYER]: layer });
}

export function promptLayerOf(options: Options): PromptLayer | undefined {
  return (options as Options & { [PROMPT_LAYER]?: PromptLayer })[PROMPT_LAYER];
}

/** The Claude Code tools a Marley session keeps (the turn's disallowed list narrows them further). */
const NATIVE_TOOLS = [
  { name: "Bash", description: "Run a shell command in this chat's home on the brand's machine." },
  { name: "Read", description: "Read a file (text, images, PDFs)." },
  { name: "Write", description: "Write a file." },
  { name: "Edit", description: "Change part of a file." },
  { name: "Glob", description: "Find files by name pattern." },
  { name: "Grep", description: "Search file contents." },
  {
    name: "mcp__marshal__* (the rest)",
    description: "The other tools of the brand machine's Marshal server this session lists: the reply tools and the ones the sections below name (marshal.tool.* among them: forks, sessions and memory, which the host serves itself). A tool not listed to this session does not exist in it.",
  },
];

/** Marley's words for the host-dependent spans of the v2 core (`v2SlotIds()`): who it is, how it reaches people, its tools, memory and sessions. */
export function marleySlots(agentName: string): Record<string, string> {
  return {
    "v2.identity.host": `You are ${agentName}, a messaging-first eCom expert who works for one brand's team. People reach you through WhatsApp (a member's direct chat, a group, or a job the server runs for the brand); you run on Marshal on the brand's own machine in the cloud, nobody is at a screen next to you, and you work from the brand's data, files and memory with the tools listed under "Tools on this host".`,
    "v2.working-loop.ask-once": "ask the person once in your reply, in the chat (a job with nobody in the chat states the assumption it took instead),",
    "v2.working-loop.calling-tools": [
      "## Calling Marshal's tools",
      "",
      "Your direct tools are listed under \"Tools on this host\". Everything else is a runtime capability: call one with `mcp__marshal__runtime_exec {targetType: 'operation', target: '<name>', input}`, or run TypeScript that calls several with `mcp__marshal__runtime_exec {targetType: 'inline_module', source, input}` (`context.runtime.invoke(name, input)` inside). The `marshal.tool.*` tools (forks and their messages, session search and transcripts, memory, decisions) run on the server, not on this machine: call each one as its own operation call, never from inside TypeScript, where it refuses with host_tool_top_level_only. `mcp__marshal__runtime_search {query}` finds capabilities and their schemas; read a schema before calling a capability you don't know. Calling a capability name as a direct tool fails.",
    ].join("\n"),
    "v2.finding-information.web": "(`WebSearch`, when this session has it)",
    "v2.memory-and-records.skill": "  - A procedure you repeat is said in your result for the people who own Marley.",
    "v2.memory-and-records.decision-where": "The server keeps it with this turn's record for the people who run Marley.",
  };
}

/**
 * Marley's layer over the host's own prompt (createMarshalHost's `prompt` option): the cloud-headless surface, Marley's words for the slots that are
 * about who it is and how it reaches people, and the Claude Code tools a session keeps (the host lists none when it runs on an embedder's query).
 * The session-search, memory-rung, personal-memory and correction slots are the host's own (sdkBaseLayer: marshal.tool.searchSessions, remember,
 * recall, forget), never Marley substitutes.
 */
export function marleyHostPrompt(agentName: string): HostPromptOptions {
  return { surface: "cloud-headless", slots: marleySlots(agentName), tools: NATIVE_TOOLS };
}

/** The base every Marley session renders: the SDK's own layer (cloud-headless, the runtime tools, its memory and session slots) with Marley's host layer. */
export function marleyBaseLayer(agentName: string): PromptLayer {
  return mergePromptLayers(sdkBaseLayer({ browser: false, extensionGuidance: [], sections: [] }), marleyHostPrompt(agentName));
}

/** The layers of Marley's own prompt that are the role's text (front.md, routine.md, worker.md, the standard prompt's role layers, the first reply's prompt). */
const ROLE_LAYERS = new Set(["background_work", "worker_role", "first_reply"]);

/** A host section id from one of Marley's layer ids (`[a-z0-9][a-z0-9._-]*`). */
function sectionId(id: string): string {
  const clean = id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return `marley.${clean || "layer"}`;
}

/**
 * Marley's assembled layers (prompt.ts, tasks/worker-prompt.ts) as one Marshal prompt layer: the role's own layer
 * (front.md, routine.md or worker.md) the role text, and every other layer a section, in Marley's order, under a stable id (`marley.<layer id>`).
 */
export function marleyPromptLayer(layered: Layered, role: Extract<HostPromptRole, "main" | "worker">): PromptLayer {
  let roleText: string | undefined;
  const sections: HostPromptSection[] = [];
  const seen = new Map<string, number>();
  for (const segment of [...layered.segments].sort((a, b) => a.start - b.start)) {
    const text = layered.text.slice(segment.start, segment.end).trim();
    if (!text) continue;
    if (ROLE_LAYERS.has(segment.id) && roleText === undefined) roleText = text;
    else {
      const base = sectionId(segment.id);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      sections.push({ id: count ? `${base}-${count + 1}` : base, text });
    }
  }
  return { role, ...(roleText ? { roleText } : {}), sections };
}

/** A role's whole text (a composer's instruction) as the role text of a Marshal layer, with no sections. */
export function rolePromptLayer(text: string, role: Extract<HostPromptRole, "main" | "worker">, extra: Partial<PromptLayer> = {}): PromptLayer {
  return { role, roleText: text, ...extra };
}

/** The persona layer ids that are a role's own text in an agent profile. */
const PROFILE_ROLE_LAYERS = new Set(["front", "worker", "routine"]);

/**
 * An extension agent profile (a routine's, @marley/chat's) as a Marshal layer instead of its `promptMode: "replace"` text: each of the profile's
 * layers resolved and filled as the SDK composes them (`resolvePromptLayers`, `fillLayerVars`), the role's layer as the role
 * text, the rest as sections in the profile's order, then the profile's own prompt file and the host's context section (`composed` minus the
 * profile's prompt) as session context. A profile that names the persona's `#soul` is refused: the soul is the composer's alone.
 */
export function profilePromptLayer(input: {
  layers: readonly string[];
  layerVars?: Readonly<Record<string, string>>;
  sources: PromptLayerSources;
  scope?: readonly string[];
  /** The profile's composed prompt (layers, then its own file). */
  profilePrompt: string;
  /** The text the SDK would have sent (`agentLaunchFields`): the profile's prompt and the host's context section. */
  composed: string;
  role: Extract<HostPromptRole, "main" | "worker">;
}): PromptLayer {
  const resolved = resolvePromptLayers(input.layers, input.sources, input.scope);
  const vars = input.layerVars ?? {};
  let roleText: string | undefined;
  const sections: HostPromptSection[] = [];
  for (const layer of resolved) {
    const { identity, id } = parseLayerRef(layer.ref);
    const text = fillLayerVars(layer.text, vars).trim();
    if (!text) continue;
    if (id === "soul") throw new Error(`agent profile names ${layer.ref}: the soul is the outbox composer's alone (docs/design/marley-model.md)`);
    if (PROFILE_ROLE_LAYERS.has(id) && roleText === undefined) roleText = text;
    else sections.push({ id: sectionId(`${identity.replace(/^@/, "").replace(/\//g, ".")}.${id}`), text });
  }
  const layersText = composePromptLayers(resolved, undefined, vars).trimEnd();
  const profile = input.profilePrompt.trimEnd();
  const own = profile.startsWith(layersText) ? profile.slice(layersText.length).trim() : "";
  if (own) sections.push({ id: "marley.profile-prompt", text: own });
  const context = input.composed.startsWith(profile) ? input.composed.slice(profile.length).trim() : "";
  return { role: input.role, ...(roleText ? { roleText } : {}), sections, ...(context ? { sessionContext: { text: context } } : {}) };
}

/** The ids and labels of the Marshal base's own sections, for the inspector's layer view. */
function segmentSpec(id: string): Pick<PromptSegment, "label" | "kind" | "source"> {
  if (id.startsWith("role.")) return { label: `Role (${id})`, kind: LayerKinds.Rules, source: "Marley role text (roleText)" };
  if (id.startsWith("extra.host.marley.")) return { label: id.slice("extra.host.marley.".length), kind: LayerKinds.Rules, source: `Marley section ${id}` };
  if (id.startsWith("extra.context.")) return { label: `Session context (${id})`, kind: LayerKinds.State, source: "sessionContext" };
  return { label: `Marshal ${id}`, kind: LayerKinds.Rules, source: "marshal-sdk agent prompt v2" };
}

/**
 * The exact system prompt a Marley session with this layer gets from the port: the Marshal base merged with the layer (the same merge
 * `createHostPrompts` makes for a top-level session), assembled, with one segment per section for the inspector.
 */
export function assembleMarleyPrompt(base: PromptLayer, layer: PromptLayer): Layered {
  const assembled = assembleHostPrompt(mergePromptLayers(base, layer));
  const segments: PromptSegment[] = [];
  let at = 0;
  assembled.sections.forEach((section, index) => {
    if (index > 0) at += 2;
    segments.push({ id: section.id, ...segmentSpec(section.id), start: at, end: at + section.text.length });
    at += section.text.length;
  });
  return { text: assembled.content, segments };
}

/**
 * The inbox (Omer's R76 model): a chat session reads each item that reaches the conversation (a message of the person, an event, a task's result) and
 * decides one of three things. Its words reach the person only through the outbox, whose agent composes the one message they get.
 */
export const INBOX_SECTION: HostPromptSection = {
  id: "marley.inbox",
  text: `# The inbox

Every message, event and task result in this conversation reaches you here first. For each one, decide exactly one of:

1. Steer or follow up a task. When it is about work a fork or task is already doing or did, send it there: a fork you started, with marshal.tool.messageSubagent {sessionId, message} (runtime_exec {targetType: "operation", target: "marshal.tool.messageSubagent", input: {sessionId, message}}); a task the tasks block lists by its id (only a task of this conversation can be steered), with marley.task.steer {taskId, message}. Send the person's words, plus what the work needs to know. A running task takes it when it finishes its current step; a finished one picks up its own session again. Do not start a second task for the same work.
2. Answer from what the shop already knows. When the living state, memory or what this conversation already holds answers it, answer now through the outbox with basis "state" (marley.outbox.send_text, send_voice and the others; replyTo: the ref of the message you answer when it is not their latest one). The words say how old what they rest on is, as the state or memory dates it ("as of this morning's sync", "from Tuesday's check"), or that it is what you last loaded when nothing dates it; a figure you are still checking keeps that mark in the same sentence. Do not fetch fresh data for this: if the answer needs fresh data, it is choice 3. One figure on a window the Key numbers cover is always this choice, never choice 3, however many tasks are running: say it with its window's dates, the day it is loaded through and when the data last synced. You run no query and work out no figure yourself; a figure no line holds is choice 3, however quick it sounds.
3. Fork a worker. When it needs fresh data, a check, a build or anything longer than a quick answer, fork it with marshal.tool.forkSubagents (runtime_exec {targetType: "operation", target: "marshal.tool.forkSubagents", input: {tasks: [{name, task}]}}), and tell the person in a few words what you are checking (marley.outbox.send_text, basis "state"). The worker puts its own findings to the outbox. When they asked several things (in one message or several), fork one worker per question and write in each task the ref of the message that question is in, so each answer arrives quoted under its own question. A dashboard, a report or a written document they ask for is a page (a view); say so in the task, never ask for a markdown file, and ask for a CSV or spreadsheet only beside the page when they want the raw rows.

Everything you say goes through the marley.outbox.* capabilities, one part per call: a text, a voice note, an image, a file, a brand file, a reaction or a connect link. The outbox agent composes it with everything else waiting for this person and may add a pointer, a quote of an earlier message, or a line on how fresh the facts are; you never write a reply anywhere else. Words you end the turn with and did not put are sent to the outbox for you.`,
};

/** A worker's (and a job's) way to the person: the outbox, with its own task id so the outbox agent can ask it for a rework. */
export const WORKER_OUTBOX_SECTION: HostPromptSection = {
  id: "marley.outbox",
  text: `# The outbox

What you found reaches the person only through the outbox: marley.outbox.send_text or send_voice with basis "work" and taskId, your task's id from the task block (runtime_exec operation calls). Put each finding when it is ready, not all at the end, with replyTo set to the ref of the message it answers (the one your task names, or the message that asked for it), every time: the person may have asked several things, and the quote shows which one this answers. The outbox agent composes your words with everything else waiting for this person. It may send them back with a note asking you to rework them (shorter, clearer, more depth, the person's language): then put the new version to the outbox the same way. Words you end with and did not put are sent to the outbox for you.`,
};

/** A layer with one more host section after Marley's own. */
export function withSection(layer: PromptLayer, section: HostPromptSection): PromptLayer {
  return { ...layer, sections: [...(layer.sections ?? []), section] };
}
