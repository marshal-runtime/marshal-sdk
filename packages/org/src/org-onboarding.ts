import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";

import { createLogger } from "../host-deps";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "../host-deps";
import {
  ORG_ONBOARDING_VAULT_CAPABILITIES,
  compareExtensionVersions,
  parseOrgOnboardingManifest,
  type OrgOnboardingConnectResult,
  type OrgOnboardingExtension,
  type OrgOnboardingExtensionStatus,
  type OrgOnboardingInstallResult,
  type OrgOnboardingManifest,
  type OrgOnboardingManifestResult,
  type OrgOnboardingRunResult,
  type OrgOnboardingScope,
  type OrgOnboardingStatusResult,
} from "./common/org-onboarding";
import type { ApplyOrgAgentDefaults } from "./org-agent-defaults";
import { extractTgz, verifyArchiveBytes } from "./org-onboarding-archive";

const log = createLogger("OrgOnboarding");

const VAULT_EXTENSION_ID = "@marshal/vault";

export interface OrgOnboardingDeps {
  getFlag: () => boolean;
  /** The signed-in org, or undefined when signed out. */
  getOrg: () => Promise<
    | { orgId?: string; orgUrl?: string; orgName?: string; features: string[]; apiBase: string }
    | undefined
  >;
  requestJson: (route: string) => Promise<unknown>;
  /** Authenticated download from the org API; must refuse other origins and cap the size. */
  downloadArchive: (url: string, maxBytes: number) => Promise<Uint8Array>;
  runtime: Pick<
    MarshalRuntimeApi,
    | "installLocalExtension"
    | "updateExtension"
    | "configureExtension"
    | "enableExtension"
    | "removeExtension"
    | "listExtensions"
    | "invoke"
  >;
  /**
   * Lets the session read one manifest-named status capability of an enabled extension without a
   * prompt (see `createStatusReadGrant`); the read stays forbidden when it returns false.
   */
  allowStatusRead?: (
    scope: MarshalRuntimeScope,
    ownerIds: readonly string[],
    capability: string,
  ) => Promise<boolean>;
  /** Hands the manifest's `agentDefaults` to the session manager when the Set up flow loads it. */
  applyAgentDefaults?: ApplyOrgAgentDefaults;
  tempRoot?: () => string;
  /**
   * Records the package integrity of an archive whose size and sha256 matched the org manifest
   * (`createOrgTrustedExtensions(...).trust`), so allowlisted identities load. Called before the install.
   */
  trust?: (identity: string, packageIntegrity: string) => void;
  /** Whether an identity may use the organization services (broker, identity, secure storage). Published extensions never may. */
  isOrgServiceIdentity?: (identity: string) => boolean;
  computeIntegrity?: (packageRoot: string) => string;
}

function failure(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

async function findPackageRoot(dir: string): Promise<string | undefined> {
  const has = async (candidate: string) =>
    stat(path.join(candidate, "runtime-extension.json")).then(
      () => true,
      () => false,
    );
  if (await has(dir)) return dir;
  const children = (await readdir(dir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (children.length === 1) {
    const child = path.join(dir, children[0].name);
    if (await has(child)) return child;
  }
  return undefined;
}

function runtimeScope(scope: OrgOnboardingScope) {
  return { sessionId: scope.sessionId, workspaceName: scope.workspaceName };
}

export class OrgOnboarding {
  constructor(private readonly deps: OrgOnboardingDeps) {}

  enabled(): boolean {
    return this.deps.getFlag();
  }

  async getManifest(): Promise<OrgOnboardingManifestResult> {
    if (!this.enabled()) return { success: false, error: "disabled" };
    const org = await this.deps.getOrg();
    if (!org) return { success: false, error: "not-signed-in" };
    const orgName = org.orgName ?? "your organization";
    if (org.features.includes("onboarding")) {
      try {
        const manifest = parseOrgOnboardingManifest(await this.deps.requestJson("/v1/onboarding"));
        if (manifest) {
          if (manifest.agentDefaults) await this.deps.applyAgentDefaults?.(manifest.agentDefaults);
          return { success: true, source: "server", orgName, manifest };
        }
        log.warn("server onboarding manifest failed validation");
      } catch (error) {
        log.warn("server onboarding manifest unavailable", {
          code:
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
        });
      }
    }
    return { success: false, error: "no-onboarding" };
  }

  private async entry(id: string): Promise<{
    manifest: OrgOnboardingManifest;
    extension: OrgOnboardingExtension;
    apiBase: string;
  }> {
    const result = await this.getManifest();
    const org = await this.deps.getOrg();
    if (!result.success || !org) throw new Error("onboarding unavailable");
    const extension = result.manifest.extensions.find((candidate) => candidate.id === id);
    if (!extension) throw new Error("unknown extension");
    return { manifest: result.manifest, extension, apiBase: org.apiBase };
  }

  async install(scope: OrgOnboardingScope, ids: string[]): Promise<OrgOnboardingInstallResult> {
    if (!this.enabled()) return { success: false, error: "disabled" };
    const results: { id: string; ok: boolean; error?: string }[] = [];
    // Bundled extensions may depend on archive-delivered ones (agentic browser needs jev), so archives go first.
    const manifest = await this.getManifest();
    const archived = new Set(
      manifest.success
        ? manifest.manifest.extensions
            .filter((extension) => extension.delivery.kind === "archive")
            .map((extension) => extension.id)
        : [],
    );
    const ordered = [...ids].sort((a, b) => Number(archived.has(b)) - Number(archived.has(a)));
    for (const id of ordered) {
      try {
        // eslint-disable-next-line no-await-in-loop -- installs run one at a time so runtime installs never overlap
        await this.installOne(scope, id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: failure(error).error });
      }
    }
    return { success: true, results };
  }

  private async enable(scope: OrgOnboardingScope, id: string): Promise<void> {
    const result = await this.deps.runtime.enableExtension({
      ...runtimeScope(scope),
      identity: id,
      idempotencyKey: `org-onboarding-enable-${id}-${randomUUID()}`,
    });
    if (!result.ok) throw new Error(result.error.message);
  }

  private async installedIds(
    scope: OrgOnboardingScope,
  ): Promise<Map<string, "enabled" | "disabled">> {
    const records = await this.installedRecords(scope);
    return new Map([...records].map(([identity, record]) => [identity, record.status]));
  }

  private async installedRecords(
    scope: OrgOnboardingScope,
  ): Promise<Map<string, { status: "enabled" | "disabled"; version: string }>> {
    const listed = await this.deps.runtime.listExtensions({ ...runtimeScope(scope) });
    if (!listed.ok) throw new Error(listed.error.message);
    return new Map(
      listed.value.map((record) => [
        record.identity,
        { status: record.status, version: record.version },
      ]),
    );
  }

  private async installOne(scope: OrgOnboardingScope, id: string): Promise<void> {
    const { extension, apiBase } = await this.entry(id);
    await this.installEntry(scope, extension, apiBase);
  }

  /** Installs one manifest or catalog entry; used by onboarding and by Settings > Organization > Extensions. */
  async installEntry(
    scope: OrgOnboardingScope,
    extension: OrgOnboardingExtension,
    apiBase: string,
  ): Promise<void> {
    const id = extension.id;
    const records = await this.installedRecords(scope);
    const installed = new Map([...records].map(([identity, record]) => [identity, record.status]));
    const existing = records.get(id);
    const delivery = extension.delivery;
    // Fail closed: only an entry the server labels "org" may use organization services; a missing or unknown label counts as published.
    const orgOwned = extension.origin === "org";
    if (extension.origin === "published" && delivery.kind !== "archive") {
      throw new Error("published extensions cannot use organization services");
    }
    if (!orgOwned && delivery.kind === "archive" && this.deps.isOrgServiceIdentity?.(id)) {
      throw new Error("published extensions cannot use organization services");
    }
    if (delivery.kind === "bundled") {
      const status = installed.get(id);
      if (!status) throw new Error("not bundled in this build");
      if (status === "disabled") await this.enable(scope, id);
      return;
    }
    // Same or newer version already there: nothing to download; an older one is updated in place.
    if (existing && compareExtensionVersions(existing.version, extension.version) >= 0) {
      if (existing.status === "disabled") await this.enable(scope, id);
      return;
    }
    const base = apiBase.replace(/\/+$/, "");
    const url = !delivery.url
      ? `${base}/v1/onboarding/extensions/${extension.id}/${extension.version}.tgz`
      : delivery.url.startsWith("/")
        ? `${base}${delivery.url}`
        : new URL(delivery.url).toString();
    if (new URL(url).origin !== new URL(apiBase).origin) {
      throw new Error("archive host not trusted");
    }
    const bytes = await this.deps.downloadArchive(url, delivery.bytes);
    verifyArchiveBytes(bytes, delivery);
    // The host refuses an install source whose path crosses a symlink, and os.tmpdir() is /var/folders/... (a symlink) on macOS.
    const tempRoot = await realpath(this.deps.tempRoot?.() ?? os.tmpdir());
    const workDir = await mkdtemp(path.join(tempRoot, "marshal-onboard-"));
    try {
      const extracted = path.join(workDir, "extract");
      await extractTgz(bytes, extracted);
      const packageRoot = await findPackageRoot(extracted);
      if (!packageRoot) throw new Error("archive has no runtime-extension.json");
      const integrity =
        this.deps.computeIntegrity?.(packageRoot) ??
        computeRuntimeExtensionIntegrity(packageRoot).value;
      // A published archive's hash vouches only for the bytes, never for org-service access.
      if (orgOwned) this.deps.trust?.(id, integrity);
      const installedRecord = existing
        ? await this.deps.runtime.updateExtension({
            ...runtimeScope(scope),
            identity: id,
            packageRoot,
            idempotencyKey: `org-onboarding-update-${id}-${randomUUID()}`,
          })
        : await this.deps.runtime.installLocalExtension({
            ...runtimeScope(scope),
            packageRoot,
            idempotencyKey: `org-onboarding-install-${id}-${randomUUID()}`,
          });
      if (!installedRecord.ok) throw new Error(installedRecord.error.message);
      if (installedRecord.value.identity !== id) {
        await this.deps.runtime.removeExtension({
          ...runtimeScope(scope),
          identity: installedRecord.value.identity,
          idempotencyKey: `org-onboarding-remove-${randomUUID()}`,
        });
        throw new Error("archive contains a different extension than announced");
      }
      if (installedRecord.value.status !== "enabled") await this.enable(scope, id);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async status(scope: OrgOnboardingScope): Promise<OrgOnboardingStatusResult> {
    if (!this.enabled()) return { success: false, error: "disabled" };
    try {
      const result = await this.getManifest();
      if (!result.success) return result;
      const installed = await this.installedIds(scope);
      const ownerIds = result.manifest.extensions.map((extension) => extension.id);
      const extensions: OrgOnboardingExtensionStatus[] = [];
      for (const extension of result.manifest.extensions) {
        const isInstalled = installed.get(extension.id) === "enabled";
        const connected: (boolean | undefined)[] = [];
        for (const connect of extension.connect ?? []) {
          const value =
            isInstalled && connect.statusCapability
              ? // eslint-disable-next-line no-await-in-loop -- status capabilities are read one by one
                await this.readConnected(
                  scope,
                  ownerIds,
                  connect.statusCapability,
                  connect.statusInput,
                )
              : undefined;
          connected.push(value);
        }
        extensions.push({ id: extension.id, installed: isInstalled, connected });
      }
      return { success: true, extensions };
    } catch (error) {
      return failure(error);
    }
  }

  private async invokeCapability(
    scope: OrgOnboardingScope,
    capability: string,
    input: unknown,
    background: boolean,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const result = await this.deps.runtime.invoke({
      ...runtimeScope(scope),
      capability,
      ...(input === undefined ? {} : { input }),
      idempotencyKey: `org-onboarding-${capability}-${randomUUID()}`,
      ...(background ? { approvalPolicy: "forbid" as const } : {}),
    });
    return result.ok
      ? { ok: true, output: result.value.output }
      : { ok: false, error: result.error.message };
  }

  /** Reads a connect status; any shape that clearly says connected maps to true, errors to undefined. */
  private async readConnected(
    scope: OrgOnboardingScope,
    ownerIds: readonly string[],
    capability: string,
    input: unknown,
  ): Promise<boolean | undefined> {
    try {
      await this.deps.allowStatusRead?.(runtimeScope(scope), ownerIds, capability);
      const result = await this.invokeCapability(scope, capability, input, true);
      return result.ok ? interpretConnected(result.output) : undefined;
    } catch {
      return undefined;
    }
  }

  async connect(
    scope: OrgOnboardingScope,
    extensionId: string,
    index: number,
  ): Promise<OrgOnboardingConnectResult> {
    if (!this.enabled()) return { success: false, error: "disabled" };
    try {
      const { extension } = await this.entry(extensionId);
      const connect = extension.connect?.[index];
      if (!connect) return { success: false, error: "unknown connect action" };
      const result = await this.invokeCapability(scope, connect.capability, connect.input, false);
      return result.ok ? { success: true, output: result.output } : failure(result.error);
    } catch (error) {
      return failure(error);
    }
  }

  /** The vault only schedules capabilities its configuration allows: add the manifest's daily capability. */
  private async allowDailyCapability(scope: OrgOnboardingScope): Promise<void> {
    const manifest = await this.getManifest();
    const daily = manifest.success ? manifest.manifest.dailySignIn : undefined;
    if (!daily) return;
    const listed = await this.deps.runtime.listExtensions({ ...runtimeScope(scope) });
    if (!listed.ok) throw new Error(listed.error.message);
    const vault = listed.value.find((record) => record.identity === VAULT_EXTENSION_ID);
    if (!vault) throw new Error("the vault extension is not installed");
    const current: unknown = vault.configuration?.allowedDailyCapabilities;
    const allowed = Array.isArray(current)
      ? current.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (allowed.includes(daily.capability)) return;
    const configured = await this.deps.runtime.configureExtension({
      ...runtimeScope(scope),
      identity: VAULT_EXTENSION_ID,
      configuration: {
        ...vault.configuration,
        allowedDailyCapabilities: [...allowed, daily.capability],
      },
      idempotencyKey: `org-onboarding-configure-${randomUUID()}`,
    });
    if (!configured.ok) throw new Error(configured.error.message);
  }

  /** Daily sign-in step: only the vault capabilities of contract C3 may be called. */
  async runVaultCapability(
    scope: OrgOnboardingScope,
    capability: string,
    input: unknown,
  ): Promise<OrgOnboardingRunResult> {
    if (!this.enabled()) return { success: false, error: "disabled" };
    const manifest = await this.getManifest();
    const dailyCapability = manifest.success
      ? manifest.manifest.dailySignIn?.capability
      : undefined;
    if (
      !(ORG_ONBOARDING_VAULT_CAPABILITIES as readonly string[]).includes(capability) &&
      capability !== dailyCapability
    ) {
      return { success: false, error: "capability not allowed" };
    }
    try {
      if (capability === "googleSignin.schedule") await this.allowDailyCapability(scope);
      const isStatusRead = capability === "vault.status" || capability === "googleSignin.status";
      if (isStatusRead) {
        await this.deps.allowStatusRead?.(runtimeScope(scope), [VAULT_EXTENSION_ID], capability);
      }
      const result = await this.invokeCapability(scope, capability, input, isStatusRead);
      return result.ok ? { success: true, output: result.output } : failure(result.error);
    } catch (error) {
      return failure(error);
    }
  }
}

/** A successful read maps to true or false; a payload that does not say "connected" counts as not connected. */
export function interpretConnected(output: unknown): boolean {
  if (output === null || typeof output !== "object") return false;
  for (const key of ["connected", "signedIn", "ready"]) {
    const value: unknown = Reflect.get(output, key);
    if (typeof value === "boolean") return value;
  }
  for (const key of ["state", "status"]) {
    const value: unknown = Reflect.get(output, key);
    if (typeof value === "string") return value === "connected";
  }
  const accounts: unknown = Reflect.get(output, "accounts");
  if (Array.isArray(accounts)) return accounts.length > 0;
  const purposes: unknown = Reflect.get(output, "purposes");
  if (Array.isArray(purposes)) {
    return purposes.some(
      (purpose: unknown) =>
        typeof purpose === "object" &&
        purpose !== null &&
        Reflect.get(purpose, "hasSecret") === true,
    );
  }
  return false;
}
