import type { BackendCapabilities } from "../types";

export function createLocalRuntimeCapabilities(options?: {
  sessionCompaction?: boolean;
  busyTurnSteer?: boolean;
  sessionFork?: boolean;
}): BackendCapabilities {
  return {
    taskList: false,
    cronExpressions: false,
    retryPolicy: false,
    policyEditor: false,
    heartbeatIsolated: false,
    modelFallback: false,
    connectionStatus: false,
    sessionCompaction: options?.sessionCompaction ?? false,
    busyTurnSteer: options?.busyTurnSteer ?? false,
    sessionFork: options?.sessionFork ?? false,
    // Every local runtime runs turns through LocalSessionBackend, whose user-prompt hook adds the shared-session context.
    sharedSessions: true,
    automations: {
      multiStep: true,
      workingDir: true,
      skills: true,
      perAutomationPermissions: true,
      conditionTrigger: true,
      heartbeat: true,
      heartbeatRunNow: true,
      bundleImport: true,
      exportImport: true,
      githubImport: true,
    },
    // Local runtimes do not use the DesktopCapabilities bridge; flags remain
    // false for interface symmetry per CLAUDE.md rule 3.
    desktopCapabilities: {
      localTools: false,
      notifications: false,
    },
  };
}
