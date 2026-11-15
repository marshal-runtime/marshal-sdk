// The session engine's host ports for a host without the desktop: the same engine code (packages/providers
// backend/local), given plain-function services where the desktop gives Electron, its settings store and its
// self-tools. A host's own tools, MCP servers and permission handler reach the engine per session through the
// backend (src/engine-query.ts), not through these process-wide ports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureEngineHost, isEngineHostConfigured, type EngineHostServices } from "./engine-host.js";
import {
  applyGuardrails,
  DEFAULT_POLICY_PERMISSIONS,
  extractPattern,
  getCommandText,
  isReadOnlyCommand,
  normalizePermissionRequest,
} from "./permissions.js";

export const HEADLESS_APP_NAME = "Marshal";
const SDK_VERSION = "0.0.1";

/** The ask-user tool result shape the engine reads back (the desktop validates it with zod). */
const askUserResultSchema: EngineHostServices["AskUserToolResultSchema"] = {
  safeParse(value: unknown) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    if (record && typeof record.question === "string" && Array.isArray(record.answers)) {
      return { success: true, data: record as never };
    }
    return { success: false, error: { message: "Not an askUser result." } };
  },
};

function formatNow(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone, timeZoneName: "short" }).format(now);
  } catch {
    return now.toISOString();
  }
}

/** The engine's LocalBackend ports for a headless host (SessionManager's ports stay unset: the agent port drives sessions), with its app data (session config traces, browser output) under `appDataDir`. */
export function headlessEngineHost(appDataDir: string, version = SDK_VERSION): EngineHostServices {
  const mkdir = (dir: string, mode?: number) => fs.mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  return {
    app: { getVersion: () => version, isPackaged: false },
    APP_NAME: HEADLESS_APP_NAME as never,
    DEFAULT_PERMISSIONS: DEFAULT_POLICY_PERMISSIONS as never,
    sessionErrors: { INFER_FAILED: "INFER_FAILED" } as never,
    NEVER_BACKGROUND_TOOL_NAMES: new Set<string>() as never,
    AskUserToolResultSchema: askUserResultSchema,
    applyGuardrails: applyGuardrails as never,
    backgroundToolObservation: (toolName, handle) => `${toolName} keeps running in the background as ${handle}.`,
    // Every MCP server of a headless session comes from the host per session (EngineBackend.prepareMcpConfig).
    buildMcpConfig: (() => ({})) as never,
    buildUserPromptContext: ((prompt: string, opts: { timeZone?: string; now?: Date }) => ({
      modifiedPrompt: `${prompt}\n\n[${HEADLESS_APP_NAME} context: Current date and time is ${formatNow(opts?.now ?? new Date(), opts?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}. Treat this as authoritative for "today".]`,
    })) as never,
    describeRequestCompaction: (() => "") as never,
    describeSessionViews: (() => "") as never,
    extractPattern: extractPattern as never,
    getActiveWorkspaceRoot: ((fallback: string) => fallback) as never,
    getAppDataDir: () => appDataDir,
    getCommandText: getCommandText as never,
    getSelfFsTools: (() => []) as never,
    getSelfTools: () => [],
    getSessionClientViewport: (() => undefined) as never,
    isReadOnlyCommand: isReadOnlyCommand as never,
    loadMcpBrokerManager: (async () => {
      throw new Error("A headless Marshal host has no MCP broker: its sessions take MCP servers directly.");
    }) as never,
    makeSessionError: ((code: unknown) => code) as never,
    normalizeDiscoveredModels: ((models: unknown[]) => models) as never,
    normalizePermissionRequest: normalizePermissionRequest as never,
    resolveSessionToolAllowlist: ((_role: unknown, allowed: readonly string[] | undefined) => allowed) as never,
    runToolWithBackgrounding: (async (opts: { run: (signal: AbortSignal | undefined) => Promise<unknown> }) => opts.run(undefined)) as never,
    sanitizeForTelemetry: ((value: unknown) => value) as never,
    secureAppendFile: (async (file: string, data: string) => {
      mkdir(path.dirname(file));
      fs.appendFileSync(file, data, { mode: 0o600 });
    }) as never,
    secureMkdir: (async (dir: string, mode?: number) => mkdir(dir, mode)) as never,
    secureMkdirSync: ((dir: string, mode?: number) => mkdir(dir, mode)) as never,
    secureWriteFileSync: ((file: string, data: string, options?: { mode?: number }) => {
      mkdir(path.dirname(file));
      fs.writeFileSync(file, data, { mode: options?.mode ?? 0o600 });
    }) as never,
    sendErrorTelemetry: (() => undefined) as never,
    takeSessionMentionContext: (() => undefined) as never,
    takeSharedSessionContext: (() => undefined) as never,
  };
}

/**
 * Configures the engine's ports once per process, unless an embedder (the desktop) already did: the engine is one
 * module per process, and the desktop's own ports win over these.
 */
export function ensureEngineHost(appDataDir?: string): void {
  if (isEngineHostConfigured()) return;
  const dir = appDataDir ?? path.join(os.tmpdir(), "marshal-sdk-engine");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  configureEngineHost(headlessEngineHost(dir));
}
