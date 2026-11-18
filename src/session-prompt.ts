// The system prompt a Marshal host gives its top-level sessions, for an embedder that runs ClaudeAgentPort itself
// (zyg-agents' engine) and wants Marshal's default prompt without building a whole MarshalHost. Packed beside the
// agent port as `@marshal/sdk/session-prompt` (scripts/pack-agent-port.mjs).
import { forksPromptSection } from "./forks.js";
import { CLAUDE_NATIVE_PROMPT_TOOLS } from "./native-tools.js";
import { assembleHostPrompt, mergePromptLayers, sdkBaseLayer, type PromptLayer } from "./prompt.js";

/** One tool as the prompt's "Tools on this host" list names it. */
export interface SessionPromptTool {
  readonly name: string;
  readonly description: string;
}

/** What a top-level session holds; every field defaults to what createMarshalHost gives a Claude session. */
export interface DefaultSessionPromptInput {
  /**
   * The native Claude tools the session keeps: a name takes its line from CLAUDE_NATIVE_PROMPT_TOOLS (a name not in
   * it gets "The <name> tool."), an entry keeps its own line. Default: every tool of CLAUDE_NATIVE_PROMPT_TOOLS.
   */
  readonly nativeTools?: readonly (string | SessionPromptTool)[];
  /** The runtime's own tools (`runtime_search`, `runtime_exec`). Default true. */
  readonly runtimeTools?: boolean;
  /** `runtime_read_resource` among the runtime tools (a session server built with `readResourceTool: false` has none). Default true. */
  readonly readResourceTool?: boolean;
  /** Tools the embedder registered on the `marshal` server (MarshalHostOptions.directTools), by their own names. */
  readonly directTools?: readonly SessionPromptTool[];
  /** Any other tool the session holds (the embedder's own MCP servers), named as the session sees it. */
  readonly otherTools?: readonly SessionPromptTool[];
  /** The headless browser (`mcp__playwright__*`). Default false. */
  readonly browser?: boolean;
  /** One line per installed extension's agent guidance. */
  readonly extensionGuidance?: readonly string[];
  /** Sections the host adds after the base. */
  readonly sections?: readonly { id: string; text: string }[];
  /** The repository rules section (repo-rules.ts `repositoryRulesPrompt`). */
  readonly repoRules?: string;
  /** The forks section: on with the runtime_exec call by default, `{call}` with another call, false for a host without the fork capabilities. */
  readonly forks?: boolean | { readonly call: string };
  /** A layer over the default (MarshalHostOptions.prompt), merged as the host merges it. */
  readonly layer?: PromptLayer;
}

const NATIVE_LINES = new Map(CLAUDE_NATIVE_PROMPT_TOOLS.map((tool) => [tool.name, tool.description]));

function nativeEntries(tools: readonly (string | SessionPromptTool)[] | undefined): readonly SessionPromptTool[] {
  if (tools === undefined) return CLAUDE_NATIVE_PROMPT_TOOLS;
  return tools.map((tool) => (typeof tool === "string" ? { name: tool, description: NATIVE_LINES.get(tool) ?? `The ${tool} tool.` } : tool));
}

/**
 * The default system prompt of a top-level session, as createMarshalHost assembles it (sdkBaseLayer, the host's layer,
 * assembleHostPrompt) for the tools the session really holds. Throws when the layers cannot be assembled.
 */
export function defaultSessionPrompt(input: DefaultSessionPromptInput = {}): string {
  const forks = input.forks ?? true;
  const base = sdkBaseLayer({
    browser: input.browser ?? false,
    extensionGuidance: input.extensionGuidance ?? [],
    sections: [
      ...(input.sections ?? []),
      ...(forks === false ? [] : [forksPromptSection(typeof forks === "object" ? forks.call : undefined)]),
    ],
    ...(input.repoRules ? { repoRules: input.repoRules } : {}),
    runtimeTools: input.runtimeTools !== false,
    ...(input.readResourceTool === false ? { readResourceTool: false } : {}),
    directTools: input.directTools ?? [],
    nativeTools: nativeEntries(input.nativeTools),
  });
  const withOthers = input.otherTools?.length ? { ...base, tools: [...(base.tools ?? []), ...input.otherTools] } : base;
  return assembleHostPrompt(mergePromptLayers(withOthers, input.layer)).content;
}

export { CLAUDE_NATIVE_PROMPT_TOOLS } from "./native-tools.js";
export type { PromptLayer } from "./prompt.js";
