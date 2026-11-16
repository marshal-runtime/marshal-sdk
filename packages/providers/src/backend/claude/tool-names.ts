import { canonicalizeFirstPartyToolName } from "../../common/tool-names";

export const CLAUDE_HOST_MCP_SERVER_NAME = "marshal";

export interface ClaudeToolName {
  runtimeName: string;
  sdkName: string;
  serverName?: string;
  mcpToolName?: string;
  isHostTool: boolean;
}

export function toClaudeHostToolName(runtimeName: string): string {
  return `mcp__${CLAUDE_HOST_MCP_SERVER_NAME}__${runtimeName}`;
}

/** An MCP server's name as it appears in Claude tool names (`mcp__<server>__<tool>`). */
export function toClaudeMcpToolServerName(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function parseClaudeToolName(sdkName: string): ClaudeToolName {
  const match = /^mcp__(.+?)__(.+)$/.exec(sdkName);
  if (!match) {
    return {
      runtimeName: sdkName,
      sdkName,
      isHostTool: false,
    };
  }

  const serverName = match[1];
  const mcpToolName = match[2];
  const isHostTool = serverName === CLAUDE_HOST_MCP_SERVER_NAME;
  return {
    runtimeName: isHostTool ? canonicalizeFirstPartyToolName(mcpToolName) : sdkName,
    sdkName,
    serverName,
    mcpToolName,
    isHostTool,
  };
}
