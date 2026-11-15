import type {
  createSdkMcpServer,
  deleteSession,
  getSessionMessages,
  getSubagentMessages,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSdkFacade {
  query: typeof query;
  deleteSession: typeof deleteSession;
  getSessionMessages: typeof getSessionMessages;
  getSubagentMessages: typeof getSubagentMessages;
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

export async function loadClaudeSdk(): Promise<ClaudeSdkFacade> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: sdk.query,
    deleteSession: sdk.deleteSession,
    getSessionMessages: sdk.getSessionMessages,
    getSubagentMessages: sdk.getSubagentMessages,
    createSdkMcpServer: sdk.createSdkMcpServer,
    tool: sdk.tool,
  };
}
