import type { MSettings } from "../host-deps";
import { normalizeOrgUrl } from "./common/org-url";
import { OrgService, type OrgFlags } from "./org-service";
import { SafeStorageOrgTokenStore } from "./org-token-store";

export function resolveOrgFlags(settings: MSettings): OrgFlags {
  const experiments = settings.experiments;
  const enabled = experiments?.orgEnabled === true;
  const signIn = enabled && experiments?.orgSignIn === true;
  const workspaces = signIn && experiments?.orgWorkspaces === true;
  const sessionSharing = workspaces && experiments?.orgSessionSharing === true;
  const remoteSessions =
    enabled && experiments?.orgSignIn === true && experiments.orgRemoteSessions === true;
  return {
    enabled,
    signIn,
    workspaces,
    remoteSessions,
    ...(sessionSharing ? { sessionSharing: true } : {}),
    ...(sessionSharing && experiments?.orgMentions === true ? { mentions: true } : {}),
    ...(sessionSharing && experiments?.orgCloudMove === true ? { cloudMove: true } : {}),
    ...(signIn && experiments?.orgSessionAudit === true ? { sessionAudit: true } : {}),
    ...(signIn ? { onboarding: true } : {}),
    ...(sessionSharing && experiments?.orgCloudMove === true && experiments.orgRemoteMode === true
      ? { remoteMode: true }
      : {}),
    ...(remoteSessions &&
    sessionSharing &&
    experiments?.orgCloudMove === true &&
    experiments.orgCloudGroup === true
      ? { cloudGroup: true }
      : {}),
    ...(remoteSessions && experiments?.orgFork === true ? { fork: true } : {}),
    ...(remoteSessions &&
    sessionSharing &&
    experiments?.orgMentions === true &&
    experiments.orgLiveSessions === true
      ? { liveSessions: true }
      : {}),
    ...(sessionSharing && experiments?.orgCloudMove === true && experiments.orgPlacement === true
      ? { placement: true }
      : {}),
    ...(signIn && experiments?.orgRooms === true ? { rooms: true } : {}),
  };
}

export function resolveOrgUrl(
  settings: MSettings,
  policyOrgUrl: string | undefined,
): { url?: string; managed: boolean } {
  if (policyOrgUrl) return { url: policyOrgUrl, managed: true };
  const url = normalizeOrgUrl(settings.orgUrl);
  return url ? { url, managed: false } : { managed: false };
}

export function createOrgService(deps: {
  settingsManager: {
    get(): MSettings;
    update(partial: Partial<MSettings>): void;
    on(event: "changed", listener: () => void): unknown;
  };
  tenantPolicyProvider: {
    get(): { orgUrl?: string };
    on(event: "policyChanged", listener: () => void): unknown;
  };
  openExternal: (url: string) => void;
  getLocallyTrustedExtensions?: () => string[];
}): OrgService {
  const service = new OrgService({
    getFlags: () => resolveOrgFlags(deps.settingsManager.get()),
    getOrgUrl: () =>
      resolveOrgUrl(deps.settingsManager.get(), deps.tenantPolicyProvider.get().orgUrl),
    persistOrgUrl: (orgUrl) => deps.settingsManager.update({ orgUrl }),
    tokenStore: new SafeStorageOrgTokenStore(),
    openExternal: deps.openExternal,
    getLocallyTrustedExtensions: deps.getLocallyTrustedExtensions,
  });
  deps.settingsManager.on("changed", () => service.onConfigChanged());
  deps.tenantPolicyProvider.on("policyChanged", () => service.onConfigChanged());
  return service;
}
