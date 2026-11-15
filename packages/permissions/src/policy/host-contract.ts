// What the policy reads from its host: settings (for the permissions block) and the tenant policy.
import type { PermissionKind, PermissionsConfig } from "../common/permission-contract";

/** The settings store the policy reads `permissions` from and writes granted rules back to. */
export interface SettingsManager {
  get(): { permissions?: PermissionsConfig };
  update(partial: { permissions?: PermissionsConfig }): void;
}

export interface TenantPolicy {
  version?: number;
  /** MCP server config keys to block (e.g. "playwright", "filesystem"). */
  disabledServers?: string[];
  /** Permission kinds to unconditionally deny (e.g. "shell", "mcp"). */
  disabledPermissionKinds?: PermissionKind[];
  /** When true, every non-read tool call requires explicit user approval. */
  forcePrompt?: boolean;
  /** Model IDs to block. Models with these IDs won't appear in the picker. */
  disabledModels?: string[];
  /** When true, heartbeat feature is completely disabled. */
  disableHeartbeat?: boolean;
  /** When true, automation creation and scheduling is disabled. */
  disableAutomations?: boolean;
  /** Inference provider names to block (e.g. "anthropic", "openai"). Blocks all models from these providers. */
  disabledProviders?: string[];
  /** When true, filesystem/shell access is restricted to the workspace directory only. */
  restrictToWorkspace?: boolean;
  /** Origins to block outbound in the Playwright browser context (e.g. "https://evil.com"). */
  browserEgressBlockedOrigins?: string[];
  /** Organization URL (origin) Marshal Org signs in against; the user cannot change it. */
  orgUrl?: string;
  /** Extension identities that may read the org broker session; replaces the built-in allowlist. */
  orgBrokerSessionExtensions?: string[];
  /** Extension identities that may use the secure-storage service; replaces the built-in allowlist. */
  secureStorageExtensions?: string[];
  /** When true, local builds of extensions that may use the org services are trusted when installed. */
  trustLocalOrgExtensions?: boolean;
  /** Company OpenAI key used for session-recall reranking; wins over the environment keys. */
  openAiApiKey?: string;
}

/** Organization/MDM policy source; the desktop's TenantPolicyProvider reads it from disk. */
export interface TenantPolicyProvider {
  get(): TenantPolicy;
}
