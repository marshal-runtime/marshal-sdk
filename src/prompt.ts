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

const RUNTIME_PROMPT_TOOLS = [
  { name: "mcp__marshal__runtime_search", description: "Find Marshal runtime capabilities and read their schemas." },
  {
    name: "mcp__marshal__runtime_exec",
    description:
      "Run a capability ({targetType: 'operation', target, input}) or TypeScript that calls context.runtime.invoke ({targetType: 'inline_module', source, input}).",
  },
  {
    name: "mcp__marshal__runtime_read_resource",
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
  /** Tools the embedder registered (MarshalHostOptions.directTools), named as sessions see them. */
  directTools?: readonly { name: string; description: string }[];
  /** The backend's own tools sessions keep (for Claude: Bash, Read, Write, Edit...). */
  nativeTools?: readonly { name: string; description: string }[];
}): PromptLayer {
  return {
    surface: "cloud-headless",
    role: "worker",
    tools: [
      ...(input.runtimeTools === false ? [] : RUNTIME_PROMPT_TOOLS),
      ...(input.directTools ?? []).map((direct) => ({ name: `mcp__marshal__${direct.name}`, description: direct.description })),
      ...(input.browser
        ? [{ name: "mcp__playwright__*", description: "A headless browser: open pages and local HTML files, resize, scroll, screenshot." }]
        : []),
      ...(input.nativeTools ?? []),
    ],
    sections: [
      ...input.sections,
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
): HostPrompts {
  const sessionLayers = new Map<string, PromptLayer>();
  const { session: sessionLayerOf, ...hostLayer } = host ?? {};
  return {
    forSession(session) {
      const role: HostPromptRole | undefined = session?.parentId ? "fork" : session?.launchedBy ? "lane" : undefined;
      const own = session ? (sessionLayers.get(session.id) ?? sessionLayerOf?.(session)) : undefined;
      const sections = sessionSections?.(session);
      const hosted = mergePromptLayers(mergePromptLayers(base, hostLayer), sections?.length ? { sections } : undefined);
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
