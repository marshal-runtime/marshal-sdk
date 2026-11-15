import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";

import { createLogger } from "../host-deps";
import {
  compareExtensionVersions,
  parseOrgCatalogEntry,
  parseOrgExtensionCatalog,
  type OrgCatalogInstalled,
  type OrgExtensionCatalog as OrgExtensionCatalogValue,
  type OrgCatalogActionResult,
  type OrgCatalogPublishPreviewRequest,
  type OrgCatalogPublishPreviewResult,
  type OrgCatalogPublishRequest,
  type OrgCatalogResult,
  type OrgCatalogReviewRequest,
  type OrgCatalogUpdateRequest,
  type OrgOnboardingExtension,
  type OrgOnboardingInstallResult,
  type OrgOnboardingScope,
  type OrgPublishableResult,
} from "./common/org-onboarding";
import type { MarshalRuntimeApi } from "../host-deps";
import { packExtensionDirectory, previewExtensionPack } from "./org-extension-pack";
import { OrgArchiveError } from "./org-onboarding-archive";

const log = createLogger("OrgExtensionCatalog");

const CATALOG_ROUTE = "/v1/onboarding/catalog";
const PUBLISH_ROUTE = `${CATALOG_ROUTE}/publish`;
const PUBLISH_HEADERS = {
  id: "x-marshal-extension-id",
  version: "x-marshal-extension-version",
  title: "x-marshal-extension-title",
  why: "x-marshal-extension-why",
  sha256: "x-marshal-archive-sha256",
} as const;
const EXTENSION_ID = /^@[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const LOCAL_COPY_PREFIX = ".local-extension-";

export interface OrgExtensionCatalogDeps {
  getOrg: () => Promise<{ orgName?: string; features: string[]; apiBase: string } | undefined>;
  requestJson: (method: "GET" | "POST" | "PUT", route: string, body?: unknown) => Promise<unknown>;
  uploadBytes: (
    route: string,
    headers: Record<string, string>,
    bytes: Uint8Array,
  ) => Promise<unknown>;
  runtime: Pick<MarshalRuntimeApi, "listExtensions">;
  /** The folder the runtime keeps installed local extensions in. */
  trustedExtensionRoot: () => string;
  /** Identities bundled with Marshal; never publishable. */
  isBundled: (identity: string) => boolean;
  /** Identities that may use the organization services; never publishable. */
  isOrgServiceIdentity: (identity: string) => boolean;
  /** Whether this package integrity was installed from the organization (or grandfathered) for that identity. */
  isTrusted?: (identity: string, packageIntegrity: string) => boolean;
  /** Installs a catalog entry (the same path onboarding uses). */
  install: (
    scope: OrgOnboardingScope,
    extension: OrgOnboardingExtension,
    apiBase: string,
  ) => Promise<void>;
}

function failure(error: unknown): { success: false; error: string } {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return {
    success: false,
    error: code ?? (error instanceof Error ? error.message : String(error)),
  };
}

function isFsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^E[A-Z]+$/u.test(error.code)
  );
}

/** A packing or preview failure: a coded refusal keeps its code and (path-only) message; anything else is a fixed code, never an OS error with a user path. */
function packFailure(error: unknown): { success: false; error: string; detail?: string } {
  if (error instanceof OrgArchiveError) {
    return { success: false, error: error.code, detail: error.message };
  }
  return { success: false, error: "pack-failed" };
}

/** Reads `identity` and `version` of a package's runtime-extension.json; undefined when it is not one. */
async function readIdentity(
  dir: string,
): Promise<{ identity: string; version: string } | undefined> {
  try {
    const text = await readFile(path.join(dir, "runtime-extension.json"), "utf8");
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const identity: unknown = Reflect.get(raw, "identity");
    const version: unknown = Reflect.get(raw, "version");
    return typeof identity === "string" && typeof version === "string"
      ? { identity, version }
      : undefined;
  } catch {
    return undefined;
  }
}

export class OrgExtensionCatalog {
  constructor(private readonly deps: OrgExtensionCatalogDeps) {}

  private async org() {
    const org = await this.deps.getOrg();
    if (!org) throw Object.assign(new Error("not signed in"), { code: "not-signed-in" });
    return org;
  }

  async get(scope?: OrgOnboardingScope): Promise<OrgCatalogResult> {
    try {
      const org = await this.org();
      const catalog = parseOrgExtensionCatalog(await this.deps.requestJson("GET", CATALOG_ROUTE));
      if (!catalog) return { success: false, error: "invalid-catalog" };
      const installed = scope ? await this.installedStates(scope, catalog) : undefined;
      return {
        success: true,
        orgName: org.orgName ?? "your organization",
        catalog,
        ...(installed ? { installed } : {}),
      };
    } catch (error) {
      return failure(error);
    }
  }

  /** The install state of each catalog entry that is installed here, matched by identity; undefined when the list can't be read. */
  private async installedStates(
    scope: OrgOnboardingScope,
    catalog: OrgExtensionCatalogValue,
  ): Promise<Record<string, OrgCatalogInstalled> | undefined> {
    const listed = await this.deps.runtime.listExtensions({
      sessionId: scope.sessionId,
      workspaceName: scope.workspaceName,
    });
    if (!listed.ok) return undefined;
    const records = new Map(listed.value.map((record) => [record.identity, record]));
    const states: Record<string, OrgCatalogInstalled> = {};
    for (const entry of [...catalog.recommended, ...catalog.available]) {
      const record = records.get(entry.id);
      if (!record) continue;
      const order = compareExtensionVersions(record.version, entry.version);
      const integrity = record.integrity.value;
      // An org-service identity whose installed package the organization never vouched for runs without those services.
      const localBuild =
        this.deps.isOrgServiceIdentity(entry.id) &&
        this.deps.isTrusted !== undefined &&
        !this.deps.isTrusted(entry.id, integrity);
      states[entry.id] = {
        version: record.version,
        state: localBuild ? "local-build" : order < 0 ? "update" : order > 0 ? "newer" : "current",
      };
    }
    return states;
  }

  /** Admin: change the tier, pin a version, or remove an extension. The server checks the admin role. */
  async update(request: OrgCatalogUpdateRequest): Promise<OrgCatalogActionResult> {
    try {
      await this.org();
      if (!EXTENSION_ID.test(request.id)) return { success: false, error: "invalid-id" };
      const body = request.remove
        ? { remove: true }
        : {
            ...(request.tier ? { tier: request.tier } : {}),
            ...(request.version ? { version: request.version } : {}),
          };
      if (request.version !== undefined && !VERSION.test(request.version)) {
        return { success: false, error: "invalid-version" };
      }
      await this.deps.requestJson(
        "PUT",
        `${CATALOG_ROUTE}/${encodeURIComponent(request.id)}`,
        body,
      );
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  }

  /** Admin: approve or reject a pending entry. */
  async review(request: OrgCatalogReviewRequest): Promise<OrgCatalogActionResult> {
    try {
      await this.org();
      if (!EXTENSION_ID.test(request.id) || !VERSION.test(request.version)) {
        return { success: false, error: "invalid-id" };
      }
      const answer = await this.deps.requestJson(
        "POST",
        `${CATALOG_ROUTE}/${encodeURIComponent(request.id)}/${encodeURIComponent(request.version)}/review`,
        {
          decision: request.decision,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      );
      const entry = parseOrgCatalogEntry(answer);
      return { success: true, ...(entry ? { entry } : {}) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Installs an approved (or own pending) catalog entry through the onboarding install path. */
  async installEntry(
    scope: OrgOnboardingScope,
    id: string,
    version: string,
  ): Promise<OrgOnboardingInstallResult> {
    try {
      const org = await this.org();
      const result = await this.get();
      if (!result.success) return result;
      const all = [
        ...result.catalog.recommended,
        ...result.catalog.available,
        ...result.catalog.pending,
      ];
      const entry = all.find((candidate) => candidate.id === id && candidate.version === version);
      if (!entry) return { success: false, error: "unknown extension" };
      try {
        await this.deps.install(scope, entry, org.apiBase);
        return { success: true, results: [{ id, ok: true }] };
      } catch (error) {
        return { success: true, results: [{ id, ok: false, error: failure(error).error }] };
      }
    } catch (error) {
      return failure(error);
    }
  }

  /** Local extensions the person installed that they could publish: not bundled, not org-service identities. */
  async publishable(scope: OrgOnboardingScope): Promise<OrgPublishableResult> {
    try {
      const listed = await this.deps.runtime.listExtensions({
        sessionId: scope.sessionId,
        workspaceName: scope.workspaceName,
      });
      if (!listed.ok) return { success: false, error: listed.error.message };
      const extensions = listed.value
        .filter(
          (record) =>
            EXTENSION_ID.test(record.identity) &&
            VERSION.test(record.version) &&
            !this.deps.isBundled(record.identity) &&
            !this.deps.isOrgServiceIdentity(record.identity),
        )
        .map((record) => ({ identity: record.identity, version: record.version }));
      return { success: true, extensions };
    } catch (error) {
      return failure(error);
    }
  }

  /** The installed folder of an extension, found by identity, version and package integrity. */
  private async installedPackageRoot(record: {
    identity: string;
    version: string;
    integrity: { value: string };
  }): Promise<string | undefined> {
    const root = await realpath(this.deps.trustedExtensionRoot());
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(LOCAL_COPY_PREFIX)) continue;
      const dir = path.join(root, entry.name);
      // eslint-disable-next-line no-await-in-loop -- few copies; each is checked in turn
      const found = await readIdentity(dir);
      if (found?.identity !== record.identity || found.version !== record.version) continue;
      if (computeRuntimeExtensionIntegrity(dir).value === record.integrity.value) return dir;
    }
    return undefined;
  }

  /** Validates a publish or preview request and finds the installed copy to pack. */
  private async publishSource(
    scope: OrgOnboardingScope,
    identity: string,
  ): Promise<
    | { ok: true; record: { identity: string; version: string }; packageRoot: string }
    | { ok: false; error: string }
  > {
    if (!EXTENSION_ID.test(identity)) return { ok: false, error: "invalid-id" };
    if (this.deps.isBundled(identity)) return { ok: false, error: "bundled-extension" };
    if (this.deps.isOrgServiceIdentity(identity)) {
      return { ok: false, error: "org-service-extension" };
    }
    const listed = await this.deps.runtime.listExtensions({
      sessionId: scope.sessionId,
      workspaceName: scope.workspaceName,
    });
    if (!listed.ok) return { ok: false, error: listed.error.message };
    const record = listed.value.find((candidate) => candidate.identity === identity);
    if (!record) return { ok: false, error: "not-installed" };
    let packageRoot: string | undefined;
    try {
      packageRoot = await this.installedPackageRoot(record);
    } catch {
      packageRoot = undefined;
    }
    if (!packageRoot) return { ok: false, error: "no-local-copy" };
    return { ok: true, record, packageRoot };
  }

  /** The file list and size an upload would hold, after the same secret checks as publishing. */
  async publishPreview(
    request: OrgCatalogPublishPreviewRequest,
  ): Promise<OrgCatalogPublishPreviewResult> {
    try {
      await this.org();
      const source = await this.publishSource(request.scope, request.identity);
      if (!source.ok) return { success: false, error: source.error };
      const plan = await previewExtensionPack(source.packageRoot);
      return {
        success: true,
        version: source.record.version,
        files: plan.files.map((file) => ({ path: file.relative, bytes: file.bytes })),
        totalBytes: plan.totalBytes,
        skipped: plan.skipped,
      };
    } catch (error) {
      return error instanceof OrgArchiveError || isFsError(error)
        ? packFailure(error)
        : failure(error);
    }
  }

  /** Packs an installed local extension (same archive format and sha256 as C2) and uploads it as a pending entry. */
  async publish(request: OrgCatalogPublishRequest): Promise<OrgCatalogActionResult> {
    try {
      await this.org();
      const title = request.title.trim();
      const why = request.why.trim();
      if (!title || title.length > 256 || !why || why.length > 1024) {
        return { success: false, error: "invalid-description" };
      }
      const source = await this.publishSource(request.scope, request.identity);
      if (!source.ok) return { success: false, error: source.error };
      const { record } = source;
      let packed;
      try {
        packed = await packExtensionDirectory(source.packageRoot);
      } catch (error) {
        return packFailure(error);
      }
      const answer = await this.deps.uploadBytes(
        PUBLISH_ROUTE,
        {
          [PUBLISH_HEADERS.id]: record.identity,
          [PUBLISH_HEADERS.version]: record.version,
          [PUBLISH_HEADERS.title]: encodeURIComponent(title),
          [PUBLISH_HEADERS.why]: encodeURIComponent(why),
          [PUBLISH_HEADERS.sha256]: packed.sha256,
        },
        packed.bytes,
      );
      log.info("published an extension", { files: packed.files, bytes: packed.bytes.length });
      const entry = parseOrgCatalogEntry(answer);
      return { success: true, ...(entry ? { entry } : {}) };
    } catch (error) {
      return failure(error);
    }
  }
}
