import type { EngineHostServices } from "../../host/engine-host-types";

export type { EngineHostServices };

/**
 * The session engine's ports: everything it needs from the host that is not part of the engine itself
 * (settings, MCP, Marshal's own tools, permissions, telemetry, workspace and app paths). A host calls
 * configureEngineHost before it creates a backend, with all ports or with a part of them; later calls add
 * to earlier ones. The Marshal desktop registers each engine module's ports next to that module, so the
 * desktop loads exactly the services each module used to import. Engine modules import these names exactly
 * as they used to import the desktop modules, so the engine code is the desktop's code.
 */
const services: Partial<EngineHostServices> = {};

export function configureEngineHost(next: Partial<EngineHostServices>): void {
  // Descriptors, not values: a host may pass getters that resolve its modules on first use.
  Object.defineProperties(services, Object.getOwnPropertyDescriptors(next));
  if (Object.hasOwn(next, "APP_NAME")) APP_NAME = next.APP_NAME as EngineHostServices["APP_NAME"];
  if (Object.hasOwn(next, "DEFAULT_PERMISSIONS")) DEFAULT_PERMISSIONS = next.DEFAULT_PERMISSIONS as EngineHostServices["DEFAULT_PERMISSIONS"];
  if (Object.hasOwn(next, "sessionErrors")) sessionErrors = next.sessionErrors as EngineHostServices["sessionErrors"];
  if (Object.hasOwn(next, "AskUserToolResultSchema")) AskUserToolResultSchema = next.AskUserToolResultSchema as EngineHostServices["AskUserToolResultSchema"];
  if (Object.hasOwn(next, "NEVER_BACKGROUND_TOOL_NAMES")) NEVER_BACKGROUND_TOOL_NAMES = next.NEVER_BACKGROUND_TOOL_NAMES as EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"];
}

/** True once a host has supplied any port. */
export function isEngineHostConfigured(): boolean {
  return Object.keys(services).length > 0;
}

function need<K extends keyof EngineHostServices>(name: K): EngineHostServices[K] {
  const value = services[name];
  if (value === undefined) {
    throw new Error(`The Marshal session engine has no host port "${String(name)}": call configureEngineHost() first`);
  }
  return value as EngineHostServices[K];
}

type FunctionPort = { [K in keyof EngineHostServices]: EngineHostServices[K] extends (...args: never[]) => unknown ? K : never }[keyof EngineHostServices];

function port<K extends FunctionPort>(name: K): EngineHostServices[K] {
  const call = (...args: unknown[]): unknown => (need(name) as unknown as (...a: unknown[]) => unknown)(...args);
  return call as unknown as EngineHostServices[K];
}

export const app = {
  getVersion: (): string => need("app").getVersion(),
  get isPackaged(): boolean {
    return need("app").isPackaged;
  },
};

export let APP_NAME: EngineHostServices["APP_NAME"] = undefined as unknown as EngineHostServices["APP_NAME"];
export let DEFAULT_PERMISSIONS: EngineHostServices["DEFAULT_PERMISSIONS"] = undefined as unknown as EngineHostServices["DEFAULT_PERMISSIONS"];
export let sessionErrors: EngineHostServices["sessionErrors"] = undefined as unknown as EngineHostServices["sessionErrors"];
export let AskUserToolResultSchema: EngineHostServices["AskUserToolResultSchema"] = undefined as unknown as EngineHostServices["AskUserToolResultSchema"];
export let NEVER_BACKGROUND_TOOL_NAMES: EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"] = undefined as unknown as EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"];

export const applyGuardrails = port("applyGuardrails");
export const backgroundToolObservation = port("backgroundToolObservation");
export const buildMcpConfig = port("buildMcpConfig");
export const buildUserPromptContext = port("buildUserPromptContext");
export const describeRequestCompaction = port("describeRequestCompaction");
export const describeSessionViews = port("describeSessionViews");
export const extractPattern = port("extractPattern");
export const getActiveWorkspaceRoot = port("getActiveWorkspaceRoot");
export const getAppDataDir = port("getAppDataDir");
export const getCommandText = port("getCommandText");
export const getSelfFsTools = port("getSelfFsTools");
export const getSelfTools = port("getSelfTools");
export const getSessionClientViewport = port("getSessionClientViewport");
export const isReadOnlyCommand = port("isReadOnlyCommand");
export const loadMcpBrokerManager = port("loadMcpBrokerManager");
export const makeSessionError = port("makeSessionError");
export const normalizeDiscoveredModels = port("normalizeDiscoveredModels");
export const normalizePermissionRequest = port("normalizePermissionRequest");
export const resolveSessionToolAllowlist = port("resolveSessionToolAllowlist");
export const runToolWithBackgrounding = port("runToolWithBackgrounding");
export const sanitizeForTelemetry = port("sanitizeForTelemetry");
export const secureAppendFile = port("secureAppendFile");
export const secureMkdir = port("secureMkdir");
export const secureMkdirSync = port("secureMkdirSync");
export const secureWriteFileSync = port("secureWriteFileSync");
export const sendErrorTelemetry = port("sendErrorTelemetry");
export const takeSessionMentionContext = port("takeSessionMentionContext");
export const takeSharedSessionContext = port("takeSharedSessionContext");
