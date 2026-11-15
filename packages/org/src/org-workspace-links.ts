import { execFile } from "node:child_process";

import type { OrgClient } from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import type { OrgWorkspaceMapping } from "./contract/org-types";
import type { OrgFlags } from "./org-service";
import { parseRemoteRepo } from "./org-wip-bundle";

const log = createLogger("OrgWorkspaceLinks");

const ORG_WORKSPACES_TTL_MS = 60_000;
const MAPPING_TTL_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;

type OrgWorkspaceRecord = Awaited<ReturnType<OrgClient["listWorkspaces"]>>[number];

export interface LocalWorkspaceFolders {
  name: string;
  folders: string[];
}

/** `repo` is the normalized `owner/name` of the folder's `origin`; undefined when it has none. */
export type FolderOrigin = { repo?: string };

export interface OrgWorkspaceLinksDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<Pick<OrgClient, "supports" | "listWorkspaces"> | null>;
  /** The organization the person is signed in to now; undefined when signed out. */
  getSignedInOrgId: () => string | undefined;
  listLocalWorkspaces: () => LocalWorkspaceFolders[];
  readOrigin?: (folder: string) => Promise<FolderOrigin>;
}

export type OrgWorkspaceMappingsResult =
  | { success: true; mappings: Record<string, OrgWorkspaceMapping> }
  | { success: false; error: string };

export const WORKSPACE_MAPPING_ERROR_CODES = {
  "no-workspace": "workspace-not-linked",
  "no-origin": "workspace-no-origin",
  "repo-not-in-org": "workspace-repo-not-in-org",
  ambiguous: "workspace-ambiguous-repo",
  "origin-mismatch": "workspace-origin-mismatch",
  unavailable: "workspace-mapping-unavailable",
} as const satisfies Record<
  Extract<OrgWorkspaceMapping, { mapped: false }>["reason"],
  `workspace-${string}`
>;

export function readGitOrigin(folder: string): Promise<FolderOrigin> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: folder, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve({});
        const url = stdout.split(/\r?\n/)[0] ?? "";
        const repo = parseRemoteRepo(url);
        resolve(repo ? { repo: repo.toLowerCase() } : {});
      },
    );
  });
}

const normalizeRepo = (repository: string): string =>
  (parseRemoteRepo(repository) ?? repository.trim()).toLowerCase();

const unmapped = (
  reason: Extract<OrgWorkspaceMapping, { mapped: false }>["reason"],
  message: string,
  repo?: string,
): OrgWorkspaceMapping => ({ mapped: false, reason, message, ...(repo ? { repo } : {}) });

/**
 * Derives which organization workspace a local workspace belongs to from the git `origin` of its
 * folders: the organization workspace whose manifest lists that repository. The same repository is the
 * same organization workspace whatever the local workspace is called. Inert unless `org.workspaces` is on.
 *
 * `resolve` is synchronous over a cache that is refreshed on use and when the organization changes;
 * paths that gate an outbound action use `resolveFresh`, which re-reads the origin first.
 */
export class OrgWorkspaceLinks {
  private orgWorkspaces: { orgId: string; at: number; list: OrgWorkspaceRecord[] } | null = null;
  private readonly cache = new Map<
    string,
    { orgId: string; at: number; mapping: OrgWorkspaceMapping }
  >();
  private readonly refreshing = new Set<string>();

  constructor(private readonly deps: OrgWorkspaceLinksDeps) {}

  private active(): string | undefined {
    if (!this.deps.getFlags().workspaces) return undefined;
    return this.deps.getSignedInOrgId();
  }

  /** The derived organization workspace id; undefined when off, signed out or not mapped. Refreshes stale entries in the background. */
  resolve(workspaceName: string): string | undefined {
    const orgId = this.active();
    if (!orgId) return undefined;
    const entry = this.cache.get(workspaceName);
    if (!entry || entry.orgId !== orgId || Date.now() - entry.at > MAPPING_TTL_MS) {
      this.refreshInBackground(workspaceName);
    }
    return entry?.orgId === orgId && entry.mapping.mapped
      ? entry.mapping.orgWorkspaceId
      : undefined;
  }

  /** Re-reads the folder's origin now and maps it. Used before any share or cloud move. */
  async resolveFresh(workspaceName: string): Promise<OrgWorkspaceMapping> {
    const orgId = this.active();
    if (!orgId)
      return unmapped("unavailable", "Sign in to your organization to share this workspace.");
    const local = this.deps.listLocalWorkspaces().find((entry) => entry.name === workspaceName);
    if (!local) {
      return unmapped(
        "no-origin",
        "This workspace has no git origin, so it can't be shared or moved to the cloud.",
      );
    }
    return this.mapOne(orgId, local, false);
  }

  /** Names of the local workspaces whose git origin maps to the organization workspace, derived now. */
  async workspacesMappedTo(orgWorkspaceId: string): Promise<string[]> {
    const orgId = this.active();
    if (!orgId) return [];
    const names: string[] = [];
    for (const local of this.deps.listLocalWorkspaces()) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the number of local workspaces; keeps git spawns serial
      const mapping = await this.mapOne(orgId, local, false);
      if (mapping.mapped && mapping.orgWorkspaceId === orgWorkspaceId) names.push(local.name);
    }
    return names;
  }

  /** Maps every local workspace; `force` refetches the organization's workspace list instead of using the cached one. */
  async refreshAll(force = true): Promise<OrgWorkspaceMappingsResult> {
    if (!this.deps.getFlags().workspaces) return { success: false, error: "disabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const locals = this.deps.listLocalWorkspaces();
    const loaded = await this.loadOrgWorkspaces(orgId, force);
    if (!loaded.ok) {
      return loaded.error === "workspaces-unsupported" || loaded.error === "not-signed-in"
        ? { success: false, error: loaded.error }
        : { success: true, mappings: this.unavailableFor(locals) };
    }
    const mappings: Record<string, OrgWorkspaceMapping> = {};
    for (const entry of locals) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the number of local workspaces; keeps git spawns serial
      mappings[entry.name] = await this.mapOne(orgId, entry, false);
    }
    const names = new Set(locals.map((entry) => entry.name));
    for (const name of [...this.cache.keys()]) if (!names.has(name)) this.cache.delete(name);
    return { success: true, mappings };
  }

  /**
   * Fills the cache after startup. Saved sign-ins load lazily, so the client is requested first to make
   * the signed-in organization known; failures are logged and never thrown.
   */
  async prime(): Promise<void> {
    if (!this.deps.getFlags().workspaces) return;
    try {
      await this.deps.getClient();
      await this.refreshAll(false);
    } catch (error) {
      log.warn("Mapping prime failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** `refreshAll(false)` for fire-and-forget callers: failures are logged and never thrown. */
  async refreshQuietly(): Promise<void> {
    try {
      await this.refreshAll(false);
    } catch (error) {
      log.warn("Mapping refresh failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /** Drops everything derived, for sign-out and organization changes. */
  invalidate(): void {
    this.orgWorkspaces = null;
    this.cache.clear();
  }

  private unavailableFor(locals: LocalWorkspaceFolders[]): Record<string, OrgWorkspaceMapping> {
    return Object.fromEntries(
      locals.map((entry) => [
        entry.name,
        unmapped(
          "unavailable",
          "Couldn't load the organization's workspaces. Check your connection.",
        ),
      ]),
    );
  }

  private refreshInBackground(workspaceName: string): void {
    if (this.refreshing.has(workspaceName)) return;
    this.refreshing.add(workspaceName);
    void this.resolveFresh(workspaceName)
      .catch((error: unknown) => log.warn("Mapping refresh failed", { error: String(error) }))
      .finally(() => this.refreshing.delete(workspaceName));
  }

  private async loadOrgWorkspaces(
    orgId: string,
    force: boolean,
  ): Promise<{ ok: true; list: OrgWorkspaceRecord[] } | { ok: false; error: string }> {
    const cached = this.orgWorkspaces;
    if (
      cached &&
      cached.orgId === orgId &&
      !force &&
      Date.now() - cached.at < ORG_WORKSPACES_TTL_MS
    ) {
      return { ok: true, list: cached.list };
    }
    try {
      const client = await this.deps.getClient();
      if (!client) return { ok: false, error: "not-signed-in" };
      if (!client.supports("workspaces")) return { ok: false, error: "workspaces-unsupported" };
      const list = await client.listWorkspaces();
      this.orgWorkspaces = { orgId, at: Date.now(), list };
      return { ok: true, list };
    } catch {
      if (cached && cached.orgId === orgId) return { ok: true, list: cached.list };
      return { ok: false, error: "unreachable" };
    }
  }

  private async mapOne(
    orgId: string,
    local: LocalWorkspaceFolders,
    forceList: boolean,
  ): Promise<OrgWorkspaceMapping> {
    const loaded = await this.loadOrgWorkspaces(orgId, forceList);
    if (!loaded.ok) {
      return unmapped(
        "unavailable",
        "Couldn't load the organization's workspaces. Check your connection.",
      );
    }
    const mapping = await this.derive(local.folders, loaded.list);
    this.cache.set(local.name, { orgId, at: Date.now(), mapping });
    return mapping;
  }

  private async derive(
    folders: string[],
    workspaces: OrgWorkspaceRecord[],
  ): Promise<OrgWorkspaceMapping> {
    const readOrigin = this.deps.readOrigin ?? readGitOrigin;
    const repos = new Set<string>();
    let withoutOrigin = false;
    for (const folder of folders) {
      // eslint-disable-next-line no-await-in-loop -- a workspace has a handful of folders at most
      const origin = await readOrigin(folder);
      if (origin.repo) repos.add(origin.repo);
      else withoutOrigin = true;
    }
    const [repo, secondRepo] = [...repos];
    if (!repo) {
      return unmapped(
        "no-origin",
        "This workspace has no git origin, so it can't be shared or moved to the cloud.",
      );
    }
    if (secondRepo || withoutOrigin) {
      return unmapped(
        "origin-mismatch",
        "This workspace's folders don't all point to the same git repository, so it can't be shared or moved to the cloud.",
      );
    }
    const matches = workspaces.filter((workspace) =>
      workspace.repositories.some((entry) => normalizeRepo(entry.repository) === repo),
    );
    const [match, otherMatch] = matches;
    if (!match) {
      return unmapped(
        "repo-not-in-org",
        `${repo} isn't in any organization workspace; ask an admin to add it.`,
        repo,
      );
    }
    if (otherMatch) {
      return unmapped(
        "ambiguous",
        `${repo} is listed in more than one organization workspace; ask an admin to leave it in one.`,
        repo,
      );
    }
    return { mapped: true, orgWorkspaceId: match.id, orgWorkspaceName: match.displayName, repo };
  }
}
