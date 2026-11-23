// Extract of zygstinct apps/agent-server/src/proxy.ts at 7110e58c8: only Usage.
export interface Usage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}
