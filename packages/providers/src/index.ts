// Marshal's model provider layer. The Marshal desktop composes these clients through its own
// backend; the Marshal SDK uses the same factories, so a session runs on the same code in both.

export type * from "./contract/host-types";
export type {
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientSession,
  RuntimeMcpServerConfig,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeTool,
  RuntimeToolInvocation,
} from "./backend/runtime-contract";
export type { RuntimeSessionEvent } from "./common/runtime-events";

export {
  ACCOUNT_RUNTIME_IDS,
  DEFAULT_RUNTIME_ACCOUNT_ID,
  defaultRuntimeAccountId,
  isRuntimeAccountId,
  listRuntimeAccounts,
  normalizeRuntimeAccounts,
  type AccountRuntimeId,
  type RuntimeAccount,
  type RuntimeAccountsSettings,
} from "./common/runtime-accounts";
export {
  ANTIGRAVITY_RUNTIME_ID,
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  CURSOR_RUNTIME_ID,
} from "./common/runtime-config";

export { claudeAccountConfigDir, withoutLaunchCredentials } from "./backend/claude/accounts";
export {
  createClaudeClientFactory,
  type ClaudeClientFactoryOptions,
} from "./backend/claude/client-factory";
export { DEFAULT_CLAUDE_CONFIG_DIR } from "./backend/claude/environment";

export { codexAccountHome } from "./backend/codex/accounts";
export { createCodexClientFactory, type CodexClientFactoryOptions } from "./backend/codex/factory";
export { defaultCodexHome } from "./backend/codex/process";

export { CURSOR_API_KEY_ENV } from "./backend/cursor/constants";
export { marshalCursorCredentialStorePath } from "./backend/cursor/credential-store";
export {
  createCursorClientFactory,
  type CursorClientFactoryOptions,
} from "./backend/cursor/factory";

export {
  antigravityHomeDir,
  createAntigravityClientFactory,
  type AntigravityClientFactoryOptions,
} from "./backend/antigravity/factory";
export {
  resolveAntigravityEndpoint,
  saveAntigravityCredential,
  type AntigravityEndpoint,
} from "./backend/antigravity/credentials";
export { ensureAntigravityEnvironment, defaultAntigravityHome } from "./backend/antigravity/environment";

export { addLogSink, createLogger, type LogEntry } from "./common/marshal-logger";
