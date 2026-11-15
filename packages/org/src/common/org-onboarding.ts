/** Contract C1: the onboarding manifest an organization serves at `GET {apiBase}/onboarding`. */

import { parseOrgAgentDefaults, type OrgAgentDefaults } from "./org-onboarding-agent-defaults";
import { parseOrgOnboardingTools, type OrgOnboardingTool } from "./org-onboarding-tools";

export type OrgOnboardingDelivery =
  | { kind: "bundled" }
  /** `url` defaults to `{apiBase}/v1/onboarding/extensions/{id}/{version}.tgz`. */
  | { kind: "archive"; url?: string; sha256: string; bytes: number };

export interface OrgOnboardingConnect {
  capability: string;
  input?: Record<string, unknown>;
  statusCapability?: string;
  /** Input for the status read, for status capabilities that need one (for example a provider). */
  statusInput?: Record<string, unknown>;
  label: string;
}

export interface OrgOnboardingExtension {
  id: string;
  version: string;
  /** `optional` is the legacy name of `available`; the parser maps it. */
  tier: "recommended" | "available";
  title: string;
  why: string;
  delivery: OrgOnboardingDelivery;
  connect?: OrgOnboardingConnect[];
  /** `published` entries were uploaded by a member and approved by an admin; they never join the org-service allowlist. */
  origin?: "org" | "published";
  publisher?: string;
  approver?: string;
}

export interface OrgOnboardingManifest {
  version: 1;
  welcome: {
    title: string;
    points: { title: string; body: string }[];
    starterPrompts: string[];
  };
  extensions: OrgOnboardingExtension[];
  projects?: { provider: "github"; owner: string; preselect: string[]; cloneRoot: string };
  dailySignIn?: {
    kind: "google-gcloud";
    /** Extension that provides `capability`. */
    extension: string;
    /** Capability the test runs and the daily schedule calls. */
    capability: string;
    defaultTime: string;
  };
  /** Contract C7: which developer tools the org wants; Marshal's own installers do the work. */
  tools?: OrgOnboardingTool[];
  /** Models the org sets for its members at onboarding; applied once, only to unset values. */
  agentDefaults?: OrgAgentDefaults;
}

const MAX_EXTENSIONS = 64;
const MAX_POINTS = 12;
/** Same limits as the org server (title 256, why 1024) so a valid entry is never dropped. */
const MAX_ENTRY_TITLE = 256;
const MAX_ENTRY_WHY = 1024;
const MAX_PROMPTS = 12;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const EXTENSION_ID = /^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const CAPABILITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
    ? value
    : undefined;
}

function parseConnect(value: unknown): OrgOnboardingConnect | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const capability = text(entry.capability, 128);
  const label = text(entry.label, 80);
  if (!capability || !CAPABILITY.test(capability) || !label) return undefined;
  const result: OrgOnboardingConnect = { capability, label };
  if (entry.input !== undefined) {
    const input = record(entry.input);
    if (!input) return undefined;
    result.input = { ...input };
  }
  if (entry.statusCapability !== undefined) {
    const status = text(entry.statusCapability, 128);
    if (!status || !CAPABILITY.test(status)) return undefined;
    result.statusCapability = status;
  }
  if (entry.statusInput !== undefined) {
    const statusInput = record(entry.statusInput);
    if (!statusInput) return undefined;
    result.statusInput = { ...statusInput };
  }
  return result;
}

function parseDelivery(value: unknown): OrgOnboardingDelivery | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  if (entry.kind === "bundled") return { kind: "bundled" };
  if (entry.kind !== "archive") return undefined;
  const url = entry.url === undefined ? undefined : text(entry.url, 2048);
  if (entry.url !== undefined && !url) return undefined;
  const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : undefined;
  const bytes = entry.bytes;
  if (!sha256 || !SHA256.test(sha256)) return undefined;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return undefined;
  if (bytes > MAX_ARCHIVE_BYTES) return undefined;
  return { kind: "archive", ...(url ? { url } : {}), sha256, bytes };
}

function parseExtension(value: unknown): OrgOnboardingExtension | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  const id = text(entry.id, 128);
  const version = text(entry.version, 64);
  const title = text(entry.title, MAX_ENTRY_TITLE);
  const why = text(entry.why, MAX_ENTRY_WHY);
  const delivery = parseDelivery(entry.delivery);
  if (!id || !EXTENSION_ID.test(id) || !version || !VERSION.test(version)) return undefined;
  if (!title || !why || !delivery) return undefined;
  // Servers from before the catalog call the second tier "optional".
  const tier = entry.tier === "optional" ? "available" : entry.tier;
  if (tier !== "recommended" && tier !== "available") return undefined;
  const origin = entry.origin === "org" || entry.origin === "published" ? entry.origin : undefined;
  const publisher = text(entry.publisher, 256);
  const approver = text(entry.approver, 256);
  const connect = Array.isArray(entry.connect)
    ? entry.connect
        .slice(0, 8)
        .map(parseConnect)
        .filter((item): item is OrgOnboardingConnect => item !== undefined)
    : [];
  return {
    id,
    version,
    tier,
    title,
    why,
    delivery,
    ...(connect.length ? { connect } : {}),
    ...(origin ? { origin } : {}),
    ...(publisher ? { publisher } : {}),
    ...(approver ? { approver } : {}),
  };
}

export type OrgCatalogStatus = "approved" | "pending" | "rejected";

export interface OrgCatalogEntry extends OrgOnboardingExtension {
  status: OrgCatalogStatus;
  publishedAt?: string;
}

/** `GET {apiBase}/v1/onboarding/catalog`: live entries by tier, plus the caller's open entries (every open one for an admin). */
export interface OrgExtensionCatalog {
  isAdmin: boolean;
  recommended: OrgCatalogEntry[];
  available: OrgCatalogEntry[];
  pending: OrgCatalogEntry[];
}

function parseCatalogEntries(value: unknown): OrgCatalogEntry[] {
  return (Array.isArray(value) ? value : []).slice(0, 256).flatMap((item) => {
    const extension = parseExtension(item);
    const status = record(item)?.status;
    if (!extension || (status !== "approved" && status !== "pending" && status !== "rejected")) {
      return [];
    }
    const publishedAt = text(record(item)?.publishedAt, 64);
    return [{ ...extension, status, ...(publishedAt ? { publishedAt } : {}) }];
  });
}

export function parseOrgExtensionCatalog(value: unknown): OrgExtensionCatalog | undefined {
  const root = record(value);
  if (!root || root.version !== 1 || typeof root.isAdmin !== "boolean") return undefined;
  return {
    isAdmin: root.isAdmin,
    recommended: parseCatalogEntries(root.recommended),
    available: parseCatalogEntries(root.available),
    pending: parseCatalogEntries(root.pending),
  };
}

/** Parses the entry the publish and review calls answer with. */
export function parseOrgCatalogEntry(value: unknown): OrgCatalogEntry | undefined {
  return parseCatalogEntries([value])[0];
}

/**
 * How an installed extension compares to a catalog entry: `current` (same version), `update` (older
 * installed), `newer` (installed is ahead), `local-build` (same identity, but a package Marshal did not
 * install from the organization, so it gets no organization services).
 */
export type OrgCatalogInstallState = "current" | "update" | "newer" | "local-build";

export interface OrgCatalogInstalled {
  version: string;
  state: OrgCatalogInstallState;
}

/** Orders `1.2.10` after `1.2.9`; a prerelease (`1.0.0-rc.1`) sorts before its release. */
export function compareExtensionVersions(left: string, right: string): number {
  const split = (version: string) => {
    const [core = "", pre] = version.split("+")[0].split(/-(.*)/su);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export type OrgCatalogResult =
  | {
      success: true;
      orgName: string;
      catalog: OrgExtensionCatalog;
      /** By extension id, for the extensions installed here; absent when the install list could not be read. */
      installed?: Record<string, OrgCatalogInstalled>;
    }
  | { success: false; error: string };

export type OrgCatalogActionResult =
  | { success: true; entry?: OrgCatalogEntry }
  | { success: false; error: string; detail?: string };

export interface OrgCatalogUpdateRequest {
  id: string;
  tier?: "recommended" | "available";
  version?: string;
  remove?: boolean;
}

export interface OrgCatalogReviewRequest {
  id: string;
  version: string;
  decision: "approve" | "reject";
  reason?: string;
}

/** An installed extension the person could publish. */
export interface OrgPublishableExtension {
  identity: string;
  version: string;
}

export type OrgPublishableResult =
  | { success: true; extensions: OrgPublishableExtension[] }
  | { success: false; error: string };

export interface OrgCatalogPublishPreviewRequest {
  scope: OrgOnboardingScope;
  identity: string;
}

/** What an upload would hold: shown to the person before anything leaves the machine. */
export type OrgCatalogPublishPreviewResult =
  | {
      success: true;
      version: string;
      files: { path: string; bytes: number }[];
      totalBytes: number;
      skipped: string[];
    }
  | { success: false; error: string; detail?: string };

export interface OrgCatalogPublishRequest {
  scope: OrgOnboardingScope;
  identity: string;
  title: string;
  why: string;
}

/** Strictly validates a server manifest: unknown fields are dropped and bad entries skipped. */
export function parseOrgOnboardingManifest(value: unknown): OrgOnboardingManifest | undefined {
  const root = record(value);
  if (!root || root.version !== 1) return undefined;
  const welcome = record(root.welcome);
  const title = text(welcome?.title, 120);
  if (!welcome || !title) return undefined;
  const points = (Array.isArray(welcome.points) ? welcome.points : [])
    .slice(0, MAX_POINTS)
    .flatMap((point) => {
      const item = record(point);
      const pointTitle = text(item?.title, 120);
      const body = text(item?.body, 400);
      return pointTitle && body ? [{ title: pointTitle, body }] : [];
    });
  const starterPrompts = (Array.isArray(welcome.starterPrompts) ? welcome.starterPrompts : [])
    .slice(0, MAX_PROMPTS)
    .flatMap((prompt) => {
      const promptText = text(prompt, 600);
      return promptText ? [promptText] : [];
    });
  const seen = new Set<string>();
  const extensions = (Array.isArray(root.extensions) ? root.extensions : [])
    .slice(0, MAX_EXTENSIONS)
    .map(parseExtension)
    .filter((extension): extension is OrgOnboardingExtension => {
      if (!extension || seen.has(extension.id)) return false;
      seen.add(extension.id);
      return true;
    });
  const manifest: OrgOnboardingManifest = {
    version: 1,
    welcome: { title, points, starterPrompts },
    extensions,
  };
  const projects = record(root.projects);
  const owner = text(projects?.owner, 100);
  const cloneRoot = text(projects?.cloneRoot, 512);
  if (projects && projects.provider === "github" && owner && cloneRoot) {
    manifest.projects = {
      provider: "github",
      owner,
      preselect: (Array.isArray(projects.preselect) ? projects.preselect : [])
        .slice(0, 50)
        .flatMap((name) => {
          const repo = text(name, 100);
          return repo ? [repo] : [];
        }),
      cloneRoot,
    };
  }
  const daily = record(root.dailySignIn);
  const dailyExtension = text(daily?.extension, 128);
  const dailyCapability = text(daily?.capability, 128);
  if (
    daily &&
    daily.kind === "google-gcloud" &&
    dailyExtension &&
    EXTENSION_ID.test(dailyExtension) &&
    dailyCapability &&
    CAPABILITY.test(dailyCapability) &&
    typeof daily.defaultTime === "string" &&
    TIME.test(daily.defaultTime)
  ) {
    manifest.dailySignIn = {
      kind: "google-gcloud",
      extension: dailyExtension,
      capability: dailyCapability,
      defaultTime: daily.defaultTime,
    };
  }
  const tools = parseOrgOnboardingTools(root.tools);
  if (tools.length) manifest.tools = tools;
  const agentDefaults = parseOrgAgentDefaults(root.agentDefaults);
  if (agentDefaults) manifest.agentDefaults = agentDefaults;
  return manifest;
}

export type OrgOnboardingExtensionState = "not-installed" | "installed" | "connected" | "unknown";

export interface OrgOnboardingExtensionStatus {
  id: string;
  /** The extension is installed and enabled in the runtime. */
  installed: boolean;
  /** Per connect-entry status; `undefined` when the entry has no status capability or it could not be read. */
  connected: (boolean | undefined)[];
}

export interface OrgOnboardingScope {
  sessionId: string;
  workspaceName: string;
}

export type OrgOnboardingManifestResult =
  | {
      success: true;
      source: "server";
      orgName: string;
      manifest: OrgOnboardingManifest;
    }
  | { success: false; error: string };

export type OrgOnboardingStatusResult =
  | { success: true; extensions: OrgOnboardingExtensionStatus[] }
  | { success: false; error: string };

export type OrgOnboardingInstallResult =
  | {
      success: true;
      results: { id: string; ok: boolean; error?: string }[];
    }
  | { success: false; error: string };

export type OrgOnboardingConnectResult =
  | { success: true; output?: unknown }
  | { success: false; error: string };

export type OrgOnboardingRunResult =
  | { success: true; output?: unknown }
  | { success: false; error: string };

/** Capabilities of @marshal/vault the daily sign-in step may call, plus the manifest's own `dailySignIn.capability`. */
export const ORG_ONBOARDING_VAULT_CAPABILITIES = [
  "vault.status",
  "vault.secret.set",
  "vault.secret.delete",
  "googleSignin.run",
  "googleSignin.status",
  "googleSignin.schedule",
] as const;
