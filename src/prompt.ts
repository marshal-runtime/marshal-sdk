import {
  assembleHostPrompt,
  mergePromptLayers,
  type HostPromptRole,
  type PromptLayer,
} from "../packages/prompt/src/index.js";
import type { SessionRecord } from "./session-store.js";

export * from "../packages/prompt/src/index.js";

/** `MarshalHostOptions.prompt`: the host's layer, and optionally a layer per session. */
export interface HostPromptOptions extends PromptLayer {
  /** A layer for one session (its soul, role, context), merged over the host's; called when a turn starts. */
  session?: (session: SessionRecord) => PromptLayer | undefined;
}

const READ_RESOURCE_PROMPT_TOOL = "mcp__marshal__runtime_read_resource";

const RUNTIME_PROMPT_TOOLS = [
  { name: "mcp__marshal__runtime_search", description: "Find Marshal runtime capabilities and read their schemas." },
  {
    name: "mcp__marshal__runtime_exec",
    description:
      "Run a capability ({targetType: 'operation', target, input}) or TypeScript that calls context.runtime.invoke ({targetType: 'inline_module', source, input}).",
  },
  {
    name: READ_RESOURCE_PROMPT_TOOL,
    description: "Read a runtime resource by URI: an extension's skill (skill://...) and its references.",
  },
];

/** The SDK's own layer: the cloud-headless surface, the tools this host really has and what it holds. */
export function sdkBaseLayer(input: {
  browser: boolean;
  extensionGuidance: readonly string[];
  sections: readonly { id: string; text: string }[];
  repoRules?: string;
  /** Whether sessions see the runtime's own tools (MarshalHostOptions.runtimeTools). Default true. */
  runtimeTools?: boolean;
  /** Whether the runtime tools include `runtime_read_resource` (a session server built with `readResourceTool: false` has none). Default true. */
  readResourceTool?: boolean;
  /** Tools the embedder registered (MarshalHostOptions.directTools), named as sessions see them. */
  directTools?: readonly { name: string; description: string }[];
  /** The backend's own tools sessions keep (for Claude: Bash, Read, Write, Edit...). */
  nativeTools?: readonly { name: string; description: string }[];
  /**
   * The backend's own words for v2's runtime spans (desktopSurface's per-provider slots, e.g. ANTIGRAVITY_V2_SLOTS):
   * the shared long-commands span, plus their runtime-tools rule as a section, since a cloud surface has no tools
   * section of its own.
   */
  runtimeSlots?: Readonly<Record<string, string>>;
}): PromptLayer {
  return {
    surface: "cloud-headless",
    role: "worker",
    // What every SDK host really provides (memory.ts, org-store/search.ts); a host layer's own slots still win.
    slots: {
      "v2.finding-information.session-scope":
        "ranks the sessions of this host and every session the organization's hosts published to the org store (`scope: local|cloud|all`, default all; open a hit with `marshal.tool.getSessionTranscript {sessionId}`)",
      "v2.finding-information.memory-rung": "3. **Your long-term memory.** You have a long-term memory that lasts across sessions: what you and other agents learned before (preferences, decisions, conventions, lessons, how things are done here). Each memory is a node in the Brain's knowledge graph, linked to the code, tickets, sessions and people it is about. Search it with `marshal.tool.recall {query}` whenever earlier knowledge could shape the answer or the work, such as how something is done here; `marshal.tool.recall {since}` lists what was saved since a time. When you learn something meaningful, save it with `marshal.tool.remember` and link it to the graph nodes it is about (files and symbols, tickets, sessions, people), so the next agent finds it from those nodes.",
      "v2.memory-and-records.personal": "  - What you learn about the people you work for and their world (preferences, decisions, facts, context): `marshal.tool.remember {fact, category, home, appliesTo?, replaces?, links?}` writes a memory node into the Brain graph at once; nobody approves it, so write only what is true and useful. It has one of two homes; always name it: `home: \"personal\"` is the person's own, private and in every workspace (preferences, always on; private facts such as a birthday); `home: \"workspace\"` is this workspace's own Brain, where links reach its real code (conventions, gotchas, why code is the way it is). Link it to what it is about: `links: [{nodeId} | {path, symbol?} | {sessionId} | {personId}]`. `recall` searches both homes; `appliesTo` names a scope (recall lists them), `replaces: <id>` supersedes an older memory. `marshal.tool.linkMemory {id, links}` adds links, `marshal.tool.updateMemory {id, fact?, category?, alwaysOn?}` fixes one in place, `marshal.tool.forget {id}` deletes one. A save that fails comes back as a failed call starting `MEMORY NOT SAVED:`: nothing was stored, so tell the user it was not saved and why, and never report it as remembered.",
      "v2.memory-and-records.correct": "fix it (`marshal.tool.updateMemory`, or `marshal.tool.remember` with `replaces`), relink it (`marshal.tool.linkMemory`) or delete it (`marshal.tool.forget`)",
      ...(input.runtimeSlots?.["v2.communication-and-code.long-commands"]
        ? { "v2.communication-and-code.long-commands": input.runtimeSlots["v2.communication-and-code.long-commands"] }
        : {}),
    },
    tools: [
      ...(input.runtimeTools === false
        ? []
        : RUNTIME_PROMPT_TOOLS.filter((tool) => input.readResourceTool !== false || tool.name !== READ_RESOURCE_PROMPT_TOOL)),
      ...(input.directTools ?? []).map((direct) => ({ name: `mcp__marshal__${direct.name}`, description: direct.description })),
      ...(input.browser
        ? [{ name: "mcp__playwright__*", description: "A headless browser: open pages and local HTML files, resize, scroll, screenshot." }]
        : []),
      ...(input.nativeTools ?? []),
    ],
    sections: [
      ...input.sections,
      ...(input.runtimeSlots?.["v2.tools.runtime-usage"]
        ? [{ id: "runtime-tools", text: `## Runtime tools\n\n${input.runtimeSlots["v2.tools.runtime-usage"].replace(/^\*\*Runtime tools:\*\* /, "")}` }]
        : []),
      ...(input.extensionGuidance.length
        ? [{ id: "extensions", text: `## Installed extensions\n\n${input.extensionGuidance.join("\n")}` }]
        : []),
    ],
    ...(input.repoRules ? { sessionContext: { repoRules: input.repoRules } } : {}),
  };
}

export interface HostPrompts {
  /** The prompt of this session (or of a top-level session when none is given); undefined when it can't be assembled. */
  forSession(session?: SessionRecord): string | undefined;
  /** Give one session its own layer (soul, role, sections, context, override) before or between its turns. */
  setSessionLayer(sessionId: string, layer: PromptLayer | undefined): void;
}

/**
 * Layer order, later wins: the SDK's base, the host's `prompt` option, the role the session has (a fork is `fork`,
 * a lane is `lane`), then the session's own layer.
 */
export function createHostPrompts(
  base: PromptLayer,
  host: HostPromptOptions | undefined,
  log: (line: string) => void,
  /** Sections that depend on the session (the skills its agent profile shows), added after the host's layers. */
  sessionSections?: (session?: SessionRecord) => PromptLayer["sections"],
  /** The memory block of a session (the host's memory: always-on preferences, then the newest memories of its scopes). */
  sessionMemories?: (session?: SessionRecord) => NonNullable<PromptLayer["sessionContext"]>["memories"],
): HostPrompts {
  const sessionLayers = new Map<string, PromptLayer>();
  const { session: sessionLayerOf, ...hostLayer } = host ?? {};
  return {
    forSession(session) {
      const role: HostPromptRole | undefined = session?.parentId ? "fork" : session?.launchedBy ? "lane" : undefined;
      const own = session ? (sessionLayers.get(session.id) ?? sessionLayerOf?.(session)) : undefined;
      const sections = sessionSections?.(session);
      const memories = sessionMemories?.(session);
      const hosted = mergePromptLayers(
        mergePromptLayers(mergePromptLayers(base, hostLayer), sections?.length ? { sections } : undefined),
        memories ? { sessionContext: { memories } } : undefined,
      );
      // The host's role text is for its top-level sessions; a fork or lane gets its own unless its layer gives one.
      const layer = mergePromptLayers(role ? { ...hosted, role, roleText: undefined } : hosted, own);
      try {
        return assembleHostPrompt(layer).content;
      } catch (error) {
        log(`Marshal prompt could not be assembled (${error instanceof Error ? error.message : String(error)}); sessions use the backend's own prompt.`);
        return undefined;
      }
    },
    setSessionLayer(sessionId, layer) {
      if (layer) sessionLayers.set(sessionId, layer);
      else sessionLayers.delete(sessionId);
    },
  };
}
