import type { AntigravityBridgeChild } from "./bridge-process";
import type { AntigravityProxyEndpoint } from "./credentials";

/** What a remote bridge's spawner is asked to start. */
export interface AntigravityBridgeSpawnRequest {
  /** The Marshal runtime session the bridge serves (one bridge per session). */
  sessionId: string;
  /** bridge.py itself (ANTIGRAVITY_BRIDGE_SOURCE): run it, or check an installed copy against it. */
  bridgeSource: string;
  /** The google-antigravity version bridge.py is written for (ANTIGRAVITY_SDK_VERSION). */
  sdkVersion: string;
  /** The JSON-lines protocol the host speaks (`ready.protocol` must equal it). */
  protocol: number;
  /** The environment the bridge needs for its endpoint: empty for a proxy endpoint, so no credential travels. */
  env: Record<string, string>;
}

/**
 * An Antigravity session whose bridge (bridge.py and the Antigravity harness) runs on another machine, such as a brand
 * VM reached over ssh, the way a remote `spawnClaudeCodeProcess` runs Claude Code there. The host keeps the session:
 * its tool decisions, host tools and events cross the spawned process's stdin/stdout. Model calls go from that
 * machine to `endpoint`, a proxy that holds the credentials, so the machine holds none.
 */
export interface AntigravityRemoteBridge {
  /**
   * Where the bridge runs (e.g. brand and VM). The session keeps its bridge across turns while this stays the same;
   * a different key re-opens the session on a new bridge. The endpoint and spawner are read when a bridge starts.
   */
  key: string;
  /** Starts bridge.py on the other machine with a Python that has google-antigravity `sdkVersion`, e.g. over ssh. */
  spawnBridge(request: AntigravityBridgeSpawnRequest): AntigravityBridgeChild;
  /** The proxy the bridge's model calls go to; a key, service account or project credentials are refused. */
  endpoint: AntigravityProxyEndpoint;
  /** The session's workspace on that machine (default: the bridge's working directory there). */
  workspaceDir?: string;
  /** Where conversations and harness data live on that machine (`<it>/sessions`, `<it>/harness`); default the SDK's. */
  homeDir?: string;
  /**
   * Antigravity's built-in tools run on that machine, so the session keeps them (minus those Marshal owns on its tool
   * surface). `enabledBuiltinTools` is an exact allowlist instead; `disabledBuiltinTools` turns more off.
   */
  enabledBuiltinTools?: readonly string[];
  disabledBuiltinTools?: readonly string[];
}
