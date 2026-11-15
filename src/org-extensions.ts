/**
 * The organization side of onboarding: an ExtensionResolver on the org contract's client
 * (@marshal/agent-runtime-org OrgClient), installing the way the desktop does (electron/org/org-onboarding.ts):
 * the catalog's approved entries are what the organization admits; an archive comes from the API origin only, with
 * the person's bearer token, and must match the announced size and sha256 (onboarding.ts checks the hash again and
 * unpacks); a `bundled` delivery means the host ships the package itself.
 */
import { createHash } from "node:crypto";

import { MAX_ONBOARDING_ARCHIVE_BYTES, type OrgCatalogEntry, type OrgClient } from "@marshal/agent-runtime-org";

import { OnboardingError, type ExtensionResolver, type ResolvedPackage } from "./onboarding.js";

export interface OrgExtensionResolverOptions {
  client: Pick<OrgClient, "discovery" | "supports" | "getExtensionCatalog">;
  /** The signed-in person's token (the same credentials they use in Marshal); the archive route needs it. */
  accessToken: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  /** Where this host keeps an extension the organization delivers as `bundled`. */
  bundled?: (id: string) => string | undefined;
  timeoutMs?: number;
}

export function orgExtensionResolver(options: OrgExtensionResolverOptions): ExtensionResolver {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiBase = options.client.discovery.apiBase.replace(/\/+$/, "");
  let catalog: Promise<OrgCatalogEntry[]> | undefined;
  const approved = () =>
    (catalog ??= (async () => {
      if (!options.client.supports("onboarding")) {
        throw new OnboardingError("org-unsupported", `The organization at ${apiBase} does not offer extensions (no "onboarding" feature).`);
      }
      const answer = await options.client.getExtensionCatalog();
      // A member also sees their own pending and rejected entries; only approved ones are admitted.
      return [...answer.recommended, ...answer.available].filter((entry) => entry.status === "approved");
    })());

  return {
    async admitted() {
      // One version per extension: the newest the organization approved.
      const newest = new Map<string, string>();
      for (const entry of await approved()) {
        const seen = newest.get(entry.id);
        if (!seen || compareVersions(entry.version, seen) > 0) newest.set(entry.id, entry.version);
      }
      return [...newest].map(([id, version]) => ({ id, version }));
    },
    async fetch({ id, version }): Promise<ResolvedPackage> {
      const entries = (await approved()).filter((entry) => entry.id === id);
      const entry = version ? entries.find((candidate) => candidate.version === version) : entries.sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!entry) {
        const offered = entries.map((candidate) => candidate.version).join(", ");
        throw new OnboardingError(
          "org-not-admitted",
          `${id}${version ? `@${version}` : ""} is not among the organization's approved extensions${offered ? ` (it admits ${offered})` : ""}.`,
        );
      }
      if (entry.delivery.kind === "bundled") {
        const packageRoot = options.bundled?.(id);
        if (!packageRoot) throw new OnboardingError("org-bundled", `${id}: the organization expects the host to ship it, and this host has no copy.`);
        return { id, version: entry.version, packageRoot };
      }
      const { delivery } = entry;
      const url = delivery.url.startsWith("/") ? `${apiBase}${delivery.url}` : new URL(delivery.url).toString();
      if (new URL(url).origin !== new URL(apiBase).origin) throw new OnboardingError("org-untrusted", `${id}: the archive is not on the organization's API origin.`);
      if (delivery.bytes > MAX_ONBOARDING_ARCHIVE_BYTES) throw new OnboardingError("org-too-large", `${id}: the archive is larger than onboarding allows.`);
      const response = await fetchFn(url, {
        headers: { authorization: `Bearer ${await options.accessToken()}` },
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
      if (!response.ok) throw new OnboardingError("org-download", `${id}@${entry.version}: the organization answered HTTP ${response.status}.`);
      const archive = new Uint8Array(await response.arrayBuffer());
      const digest = createHash("sha256").update(archive).digest("hex");
      if (archive.length !== delivery.bytes || digest !== delivery.sha256.toLowerCase()) {
        throw new OnboardingError("archive-mismatch", `${id}@${entry.version}: the download does not match the size and sha256 the organization announced.`);
      }
      return { id, version: entry.version, archive, sha256: delivery.sha256 };
    },
  };
}

/** Semver order: 1.2.10 after 1.2.9, a prerelease before its release. */
function compareVersions(left: string, right: string): number {
  const split = (value: string) => {
    const [core = "", pre] = value.split("+")[0]!.split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}
