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
  if (Object.hasOwn(next, "DEFAULT_PERMISSIONS"))
    DEFAULT_PERMISSIONS = next.DEFAULT_PERMISSIONS as EngineHostServices["DEFAULT_PERMISSIONS"];
  if (Object.hasOwn(next, "sessionErrors"))
    sessionErrors = next.sessionErrors as EngineHostServices["sessionErrors"];
  if (Object.hasOwn(next, "AskUserToolResultSchema"))
    AskUserToolResultSchema =
      next.AskUserToolResultSchema as EngineHostServices["AskUserToolResultSchema"];
  if (Object.hasOwn(next, "NEVER_BACKGROUND_TOOL_NAMES"))
    NEVER_BACKGROUND_TOOL_NAMES =
      next.NEVER_BACKGROUND_TOOL_NAMES as EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"];
  if (Object.hasOwn(next, "DEFAULT_SESSION_NAME")) {
    try {
      DEFAULT_SESSION_NAME =
        next.DEFAULT_SESSION_NAME as EngineHostServices["DEFAULT_SESSION_NAME"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "BusySessionTracker")) {
    try {
      BusySessionTracker = next.BusySessionTracker as EngineHostServices["BusySessionTracker"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "LEAN_PROMPT_DISABLED_NATIVE_TOOLS")) {
    try {
      LEAN_PROMPT_DISABLED_NATIVE_TOOLS =
        next.LEAN_PROMPT_DISABLED_NATIVE_TOOLS as EngineHostServices["LEAN_PROMPT_DISABLED_NATIVE_TOOLS"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "SPAWN_ONLY_SKILL_NAMES")) {
    try {
      SPAWN_ONLY_SKILL_NAMES =
        next.SPAWN_ONLY_SKILL_NAMES as EngineHostServices["SPAWN_ONLY_SKILL_NAMES"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "V2_DISABLED_NATIVE_TOOLS")) {
    try {
      V2_DISABLED_NATIVE_TOOLS =
        next.V2_DISABLED_NATIVE_TOOLS as EngineHostServices["V2_DISABLED_NATIVE_TOOLS"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "V2_DEFERRED_HOST_TOOLS")) {
    try {
      V2_DEFERRED_HOST_TOOLS =
        next.V2_DEFERRED_HOST_TOOLS as EngineHostServices["V2_DEFERRED_HOST_TOOLS"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "V2_EXPOSED_HOST_TOOLS")) {
    try {
      V2_EXPOSED_HOST_TOOLS =
        next.V2_EXPOSED_HOST_TOOLS as EngineHostServices["V2_EXPOSED_HOST_TOOLS"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "V2_NATIVE_SUBAGENT_ALLOWLIST")) {
    try {
      V2_NATIVE_SUBAGENT_ALLOWLIST =
        next.V2_NATIVE_SUBAGENT_ALLOWLIST as EngineHostServices["V2_NATIVE_SUBAGENT_ALLOWLIST"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "LocalSessionStore")) {
    try {
      LocalSessionStore = next.LocalSessionStore as EngineHostServices["LocalSessionStore"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "STUCK_TIMEOUT_MS")) {
    try {
      STUCK_TIMEOUT_MS = next.STUCK_TIMEOUT_MS as EngineHostServices["STUCK_TIMEOUT_MS"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "ViewEmissionManager")) {
    try {
      ViewEmissionManager = next.ViewEmissionManager as EngineHostServices["ViewEmissionManager"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
  if (Object.hasOwn(next, "workspaceDisplayName")) {
    try {
      workspaceDisplayName =
        next.workspaceDisplayName as EngineHostServices["workspaceDisplayName"];
    } catch {
      // A host test double without this export; the port stays unset until supplied.
    }
  }
}

/** True once a host has supplied any port. */
export function isEngineHostConfigured(): boolean {
  return Object.keys(services).length > 0;
}

function need<K extends keyof EngineHostServices>(name: K): EngineHostServices[K] {
  const value = services[name];
  if (value === undefined) {
    throw new Error(
      `The Marshal session engine has no host port "${String(name)}": call configureEngineHost() first`,
    );
  }
  return value as EngineHostServices[K];
}

type FunctionPort = {
  [K in keyof EngineHostServices]: EngineHostServices[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof EngineHostServices];

function port<K extends FunctionPort>(name: K): EngineHostServices[K] {
  const call = (...args: unknown[]): unknown =>
    (need(name) as unknown as (...a: unknown[]) => unknown)(...args);
  return call as unknown as EngineHostServices[K];
}

export const app = {
  getVersion: (): string => need("app").getVersion(),
  get isPackaged(): boolean {
    return need("app").isPackaged;
  },
};

export let APP_NAME: EngineHostServices["APP_NAME"] =
  undefined as unknown as EngineHostServices["APP_NAME"];
export let DEFAULT_PERMISSIONS: EngineHostServices["DEFAULT_PERMISSIONS"] =
  undefined as unknown as EngineHostServices["DEFAULT_PERMISSIONS"];
export let sessionErrors: EngineHostServices["sessionErrors"] =
  undefined as unknown as EngineHostServices["sessionErrors"];
export let AskUserToolResultSchema: EngineHostServices["AskUserToolResultSchema"] =
  undefined as unknown as EngineHostServices["AskUserToolResultSchema"];
export let NEVER_BACKGROUND_TOOL_NAMES: EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"] =
  undefined as unknown as EngineHostServices["NEVER_BACKGROUND_TOOL_NAMES"];

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

// SessionManager's ports (electron/sessions.ts and the modules that moved with it).
export let DEFAULT_SESSION_NAME: EngineHostServices["DEFAULT_SESSION_NAME"] =
  undefined as unknown as EngineHostServices["DEFAULT_SESSION_NAME"];
export let BusySessionTracker: EngineHostServices["BusySessionTracker"] =
  undefined as unknown as EngineHostServices["BusySessionTracker"];
export let LEAN_PROMPT_DISABLED_NATIVE_TOOLS: EngineHostServices["LEAN_PROMPT_DISABLED_NATIVE_TOOLS"] =
  undefined as unknown as EngineHostServices["LEAN_PROMPT_DISABLED_NATIVE_TOOLS"];
export let SPAWN_ONLY_SKILL_NAMES: EngineHostServices["SPAWN_ONLY_SKILL_NAMES"] =
  undefined as unknown as EngineHostServices["SPAWN_ONLY_SKILL_NAMES"];
export let V2_DISABLED_NATIVE_TOOLS: EngineHostServices["V2_DISABLED_NATIVE_TOOLS"] =
  undefined as unknown as EngineHostServices["V2_DISABLED_NATIVE_TOOLS"];
export let V2_DEFERRED_HOST_TOOLS: EngineHostServices["V2_DEFERRED_HOST_TOOLS"] =
  undefined as unknown as EngineHostServices["V2_DEFERRED_HOST_TOOLS"];
export let V2_EXPOSED_HOST_TOOLS: EngineHostServices["V2_EXPOSED_HOST_TOOLS"] =
  undefined as unknown as EngineHostServices["V2_EXPOSED_HOST_TOOLS"];
export let V2_NATIVE_SUBAGENT_ALLOWLIST: EngineHostServices["V2_NATIVE_SUBAGENT_ALLOWLIST"] =
  undefined as unknown as EngineHostServices["V2_NATIVE_SUBAGENT_ALLOWLIST"];
export let LocalSessionStore: EngineHostServices["LocalSessionStore"] =
  undefined as unknown as EngineHostServices["LocalSessionStore"];
export let STUCK_TIMEOUT_MS: EngineHostServices["STUCK_TIMEOUT_MS"] =
  undefined as unknown as EngineHostServices["STUCK_TIMEOUT_MS"];
export let ViewEmissionManager: EngineHostServices["ViewEmissionManager"] =
  undefined as unknown as EngineHostServices["ViewEmissionManager"];
export let workspaceDisplayName: EngineHostServices["workspaceDisplayName"] =
  undefined as unknown as EngineHostServices["workspaceDisplayName"];

export const isHiddenInternalControlMessage = port("isHiddenInternalControlMessage");
export const isToolFreeRuntimeAgentRole = port("isToolFreeRuntimeAgentRole");
export const isVisibleInternalControlResponse = port("isVisibleInternalControlResponse");
export const describeAgentMessageSendTime = port("describeAgentMessageSendTime");
export const isAgentMessageDeliveryControlError = port("isAgentMessageDeliveryControlError");
export const clearAvatarCache = port("clearAvatarCache");
export const buildImportedConversationState = port("buildImportedConversationState");
export const buildTranscriptConversationState = port("buildTranscriptConversationState");
export const reconcileWithTranscript = port("reconcileWithTranscript");
export const getMcpStatus = port("getMcpStatus");
export const assembleMarshalSystemPrompt = port("assembleMarshalSystemPrompt");
export const isAgentPromptV2Session = port("isAgentPromptV2Session");
export const isLeanCoreSession = port("isLeanCoreSession");
export const isLeanPromptSession = port("isLeanPromptSession");
export const isLeanRepoRulesSession = port("isLeanRepoRulesSession");
export const resolveAgentPromptV2ForNewSession = port("resolveAgentPromptV2ForNewSession");
export const resolveLeanCoreForNewSession = port("resolveLeanCoreForNewSession");
export const resolveLeanPromptForNewSession = port("resolveLeanPromptForNewSession");
export const resolveLeanRepoRulesForNewSession = port("resolveLeanRepoRulesForNewSession");
export const assembleMarshalSystemPromptV2 = port("assembleMarshalSystemPromptV2");
export const searchSessions = port("searchSessions");
export const isSessionHiddenFromList = port("isSessionHiddenFromList");
export const isSessionHiddenFromSearchAndDelete = port("isSessionHiddenFromSearchAndDelete");
export const readRuntimeTranscript = port("readRuntimeTranscript");
export const createSkillCatalog = port("createSkillCatalog");
export const getSkillsForSystemPrompt = port("getSkillsForSystemPrompt");
export const getWorkspaceRegistry = port("getWorkspaceRegistry");
export const getWorkspaceRoot = port("getWorkspaceRoot");
export const listRegisteredWorkspaces = port("listRegisteredWorkspaces");
export const normalizePathForCompare = port("normalizePathForCompare");
export const registerExistingWorkspace = port("registerExistingWorkspace");
export const registerManagedWorkspace = port("registerManagedWorkspace");
export const resolveRegisteredWorkspace = port("resolveRegisteredWorkspace");
export const validateWorkspaceName = port("validateWorkspaceName");
export const applyRuntimeAgentStrategy = port("applyRuntimeAgentStrategy");
export const buildSdkDefaultSubagentSystemContent = port("buildSdkDefaultSubagentSystemContent");
export const buildSystemMessage = port("buildSystemMessage");
export const getSoulGreeting = port("getSoulGreeting");
export const buildRelayAttentionSection = port("buildRelayAttentionSection");
export const buildSoulPrompt = port("buildSoulPrompt");
export const formatBundledWorkspaceFile = port("formatBundledWorkspaceFile");

// Class ports are also used as types, as the desktop modules exported them.
export type BusySessionTracker = InstanceType<EngineHostServices["BusySessionTracker"]>;
export type LocalSessionStore = InstanceType<EngineHostServices["LocalSessionStore"]>;
export type ViewEmissionManager = InstanceType<EngineHostServices["ViewEmissionManager"]>;
