import type { RuntimeMcpServerConfig, RuntimeTool } from "../runtime-contract";

export interface RestrictedToolSurface {
  readonly tools: RuntimeTool[];
  /** Strict runtime allowlist; undefined when the session is unrestricted. */
  readonly availableTools: string[] | undefined;
}

/** Host tools a session lists and loads Marshal skills with. */
export const SKILL_HOST_TOOL_NAMES: readonly string[] = ["listSkills", "getSkill"];

export interface ScopedToolSurface extends RestrictedToolSurface {
  /** MCP servers wired into the session; undefined = none. */
  readonly mcpServers: Record<string, RuntimeMcpServerConfig> | undefined;
  /** Under an allowlist: the wired MCP servers whose tools stay callable. */
  readonly availableMcpServers: string[] | undefined;
  /** Under an allowlist: the skills that stay available. */
  readonly availableSkills: string[] | undefined;
}

/**
 * Adds a session's named MCP servers and skills to its tool surface. A tool
 * allowlist on its own excludes every MCP server and skill; a non-empty
 * `scopedMcp` keeps the session's MCP config (already filtered to that scope)
 * wired with its tools callable, and a non-empty `scopedSkills` adds the host
 * skill tools and keeps those native skills. Unrestricted sessions keep their
 * MCP config and are otherwise unchanged.
 */
export function scopeToolSurface(
  allTools: readonly RuntimeTool[],
  surface: RestrictedToolSurface,
  mcpConfig: Record<string, RuntimeMcpServerConfig>,
  scope: { readonly scopedMcp?: readonly string[]; readonly scopedSkills?: readonly string[] },
): ScopedToolSurface {
  const hasMcpConfig = Object.keys(mcpConfig).length > 0;
  if (surface.availableTools === undefined) {
    return {
      ...surface,
      mcpServers: hasMcpConfig ? mcpConfig : undefined,
      availableMcpServers: undefined,
      availableSkills: undefined,
    };
  }
  const keepMcp = (scope.scopedMcp?.length ?? 0) > 0 && hasMcpConfig;
  const skills = scope.scopedSkills?.length ? [...scope.scopedSkills] : undefined;
  const skillTools = skills
    ? allTools.filter(
        (tool) =>
          SKILL_HOST_TOOL_NAMES.includes(tool.name) &&
          !surface.tools.some((kept) => kept.name === tool.name),
      )
    : [];
  return {
    tools: [...surface.tools, ...skillTools],
    availableTools: [...surface.availableTools, ...skillTools.map((tool) => tool.name)],
    mcpServers: keepMcp ? mcpConfig : undefined,
    availableMcpServers: keepMcp ? Object.keys(mcpConfig) : undefined,
    availableSkills: skills,
  };
}

/**
 * Narrows a session's host tools to an explicit allowlist. Both the schemas
 * handed to the runtime and the runtime's own allowlist shrink, so runtimes
 * that only honor one of them still stop advertising the excluded tools.
 * Creation fails closed on unknown names; resume drops names that no longer
 * exist rather than leaving an unresumable session.
 */
export function restrictToolSurface(
  tools: readonly RuntimeTool[],
  allowlist: readonly string[] | undefined,
  options: { readonly failOnUnknown: boolean },
): RestrictedToolSurface {
  if (allowlist === undefined) return { tools: [...tools], availableTools: undefined };
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const names = [...new Set(allowlist)];
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0 && options.failOnUnknown) {
    throw new Error(`allowedTools contains unknown host tools: ${unknown.join(", ")}`);
  }
  const surface = names.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
  return { tools: surface, availableTools: surface.map((tool) => tool.name) };
}
