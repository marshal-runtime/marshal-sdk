import * as fs from "node:fs/promises";
import path from "node:path";

import type {
  RuntimeExtensionSourceState,
  RuntimeExtensionUpdatePolicy,
} from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import type { GitRunner, GitSourceLocation } from "./git-source";
import { GitSourceCache, detectGitSource, remoteHead, runGit } from "./git-source";
import {
  type CommandRunner,
  PackageBuildError,
  buildPackage,
  planPackageBuild,
  readExtensionManifest,
  runCommand,
} from "./package-build";
import { findExtensionSources } from "./source-discovery";
import type { ExtensionSourceRecord, ExtensionSourceStore } from "./source-store";

const log = createLogger("ExtensionSources");
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60_000;
const DEFAULT_FIRST_CHECK_DELAY_MS = 60_000;

export interface ExtensionSourceServiceOptions {
  readonly store: ExtensionSourceStore;
  readonly cache: GitSourceCache;
  /** Installed extensions right now. */
  readonly listInstalled: () => Promise<readonly { identity: string; version: string }[]>;
  /**
   * Transactional update from a package directory; a failure must leave the old version live.
   * `scope` is set when a person asked for the update from a session, so it is authorized there;
   * background updates (auto policy, hot reload) omit it.
   */
  readonly applyPackage: (
    identity: string,
    packageRoot: string,
    scope?: InteractiveScope,
  ) => Promise<void>;
  /** Directories to scan when looking for the sources of extensions installed before tracking. */
  readonly searchRoots: () => Promise<readonly string[]>;
  readonly hotReload: {
    watch(identity: string, sourceRoot: string): void;
    unwatch(identity: string): void;
  };
  readonly notify: (title: string, body: string) => void;
  readonly onChanged: () => void;
  readonly git?: GitRunner;
  readonly runCommand?: CommandRunner;
  readonly now?: () => Date;
}

export interface InteractiveScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export class ExtensionSourceService {
  private readonly updating = new Set<string>();
  private readonly git: GitRunner;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private checking: Promise<unknown> | undefined;

  constructor(private readonly options: ExtensionSourceServiceOptions) {
    this.git = options.git ?? runGit;
    this.run = options.runCommand ?? runCommand;
    this.now = options.now ?? (() => new Date());
  }

  /** Records the directory an extension was just installed from, and watches it when asked. */
  async recordInstall(
    identity: string,
    packageRoot: string,
    options: { hotReload?: boolean; scope?: InteractiveScope },
  ): Promise<RuntimeExtensionSourceState> {
    const existing = this.options.store.get(identity);
    const record = await this.describeSource(identity, packageRoot, {
      policy: existing?.policy ?? "notify",
      hotReload: options.hotReload ?? existing?.hotReload ?? false,
      ...(options.scope ? { scope: options.scope } : {}),
    });
    this.options.store.put(record);
    this.syncWatch(record);
    this.options.onChanged();
    return this.toState(record);
  }

  /** Re-watches the source directories of extensions that had hot reload on before a restart. */
  async restoreWatches(): Promise<void> {
    const installed = new Set((await this.options.listInstalled()).map((entry) => entry.identity));
    for (const record of this.options.store.list()) {
      if (!installed.has(record.identity)) continue;
      // eslint-disable-next-line no-await-in-loop -- a handful of stat calls
      if (record.hotReload && (await isDirectory(record.localPath))) {
        this.options.hotReload.watch(record.identity, record.localPath);
      }
    }
  }

  async list(): Promise<RuntimeExtensionSourceState[]> {
    const installed = new Set((await this.options.listInstalled()).map((entry) => entry.identity));
    for (const record of this.options.store.list()) {
      if (!installed.has(record.identity)) {
        this.options.hotReload.unwatch(record.identity);
        this.options.store.delete(record.identity);
      }
    }
    return this.options.store.list().map((record) => this.toState(record));
  }

  /** Looks for the source directory of every installed extension that has no recorded source yet. */
  async findSources(): Promise<RuntimeExtensionSourceState[]> {
    const installed = await this.options.listInstalled();
    const missing = installed.filter((entry) => !this.options.store.get(entry.identity));
    if (missing.length > 0) {
      const found = await findExtensionSources(missing, await this.options.searchRoots(), this.git);
      for (const [identity, candidate] of found) {
        try {
          // Backfilled sources are not watched: editing a checkout should not silently replace
          // an extension the user installed some other way.
          // eslint-disable-next-line no-await-in-loop -- git detection per source
          const record = await this.describeSource(identity, candidate.packageRoot, {
            policy: "notify",
            hotReload: false,
          });
          this.options.store.put(record);
        } catch (error) {
          log.warn(`Could not record a found extension source (${errorName(error)})`);
        }
      }
      if (found.size > 0) this.options.onChanged();
    }
    return this.list();
  }

  async link(identity: string, packageRoot: string): Promise<RuntimeExtensionSourceState> {
    const manifest = await readExtensionManifest(packageRoot);
    if (!manifest) throw new Error(`${packageRoot} has no readable runtime-extension.json.`);
    if (manifest.identity !== identity) {
      throw new Error(`${packageRoot} holds ${manifest.identity}, not ${identity}.`);
    }
    const existing = this.options.store.get(identity);
    const record = await this.describeSource(identity, packageRoot, {
      policy: existing?.policy ?? "notify",
      hotReload: existing?.hotReload ?? false,
    });
    this.options.store.put(record);
    this.syncWatch(record);
    this.options.onChanged();
    return this.toState(record);
  }

  setPolicy(
    identity: string,
    changes: { policy?: RuntimeExtensionUpdatePolicy; hotReload?: boolean },
  ): RuntimeExtensionSourceState {
    const record = this.options.store.patch(identity, {
      ...(changes.policy ? { policy: changes.policy } : {}),
      ...(changes.hotReload !== undefined ? { hotReload: changes.hotReload } : {}),
    });
    this.syncWatch(record);
    this.options.onChanged();
    return this.toState(record);
  }

  /** Checks one extension, or every tracked one, for new commits; applies them under the auto policy. */
  async check(identity?: string): Promise<RuntimeExtensionSourceState[]> {
    const installed = new Set((await this.options.listInstalled()).map((entry) => entry.identity));
    const records = this.options.store
      .list()
      .filter(
        (record) =>
          installed.has(record.identity) &&
          record.kind === "git" &&
          (identity ? record.identity === identity : record.policy !== "pinned"),
      );
    for (const record of records) {
      // eslint-disable-next-line no-await-in-loop -- one network round trip at a time per check
      await this.checkOne(record);
    }
    this.options.onChanged();
    return this.list();
  }

  /** Brings an extension to the newest commit of its branch (git) or re-installs its directory (local). */
  async apply(
    identity: string,
    options: { scope?: InteractiveScope } = {},
  ): Promise<RuntimeExtensionSourceState> {
    const record = this.options.store.get(identity);
    if (!record) throw new Error(`No source is recorded for ${identity}.`);
    if (this.updating.has(identity)) throw new Error(`${identity} is already updating.`);
    this.updating.add(identity);
    this.options.onChanged();
    try {
      const next =
        record.kind === "git" && record.repoUrl && record.branch
          ? await this.applyGit(record, record.repoUrl, record.branch, options.scope)
          : await this.applyDirectory(record, options.scope);
      return this.toState(next);
    } catch (error) {
      const message = describeError(error);
      this.options.store.patch(identity, { lastError: message });
      throw new Error(message, { cause: error });
    } finally {
      this.updating.delete(identity);
      this.options.onChanged();
    }
  }

  /** Hot-reload entry point: re-installs from the recorded directory and records its commit. */
  async reloadFromDirectory(identity: string, scope?: InteractiveScope): Promise<void> {
    const record = this.options.store.get(identity);
    if (!record) throw new Error(`No source is recorded for ${identity}.`);
    await this.applyDirectory(record, scope);
    this.options.onChanged();
  }

  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS, firstDelayMs = DEFAULT_FIRST_CHECK_DELAY_MS): void {
    let firstRun = true;
    const tick = () => {
      if (this.checking) return;
      // Looking for sources walks the workspace folders, so it runs once per start; new installs
      // record their source directly.
      const lookForSources = firstRun ? this.findSources() : Promise.resolve();
      firstRun = false;
      this.checking = lookForSources
        .then(() => this.check())
        .catch((error: unknown) => log.warn(`Extension update check failed (${errorName(error)})`))
        .finally(() => {
          this.checking = undefined;
        });
    };
    const first = setTimeout(() => {
      tick();
      const interval = setInterval(tick, intervalMs);
      interval.unref?.();
      this.timers.push(interval);
    }, firstDelayMs);
    first.unref?.();
    this.timers.push(first);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private async checkOne(record: ExtensionSourceRecord): Promise<void> {
    if (!record.repoUrl || !record.branch) return;
    try {
      const latest = await remoteHead(
        {
          repoUrl: record.repoUrl,
          branch: record.branch,
          ...(record.repoRoot ? { repoRoot: record.repoRoot } : {}),
          ...(record.remoteName ? { remoteName: record.remoteName } : {}),
        },
        this.git,
      );
      let changes: Partial<ExtensionSourceRecord>;
      if (latest === record.installedCommit) {
        changes = { latestCommit: latest, updateAvailable: false, pendingCommits: [] };
      } else if (latest === record.latestCommit && record.updateAvailable !== undefined) {
        changes = {};
      } else {
        await this.options.cache.fetch(gitLocation(record, record.repoUrl, record.branch));
        const pending = await this.options.cache.pendingCommits(
          record.repoUrl,
          record.installedCommit,
          latest,
          record.subdir ?? "",
        );
        changes = {
          latestCommit: latest,
          updateAvailable: pending.relevant,
          pendingCommits: pending.commits,
        };
      }
      const next = this.options.store.patch(record.identity, {
        ...changes,
        checkedAt: this.now().toISOString(),
        lastError: undefined,
      });
      await this.actOnUpdate(next);
    } catch (error) {
      this.options.store.patch(record.identity, {
        checkedAt: this.now().toISOString(),
        lastError: describeError(error),
      });
    }
  }

  private async actOnUpdate(record: ExtensionSourceRecord): Promise<void> {
    if (!record.updateAvailable || !record.latestCommit) return;
    if (record.policy === "auto") {
      try {
        const next = await this.apply(record.identity);
        this.options.notify(
          "Extension updated",
          `${record.identity} is now at ${shortSha(next.installedCommit)} (${record.branch ?? "branch"}).`,
        );
      } catch (error) {
        this.options.notify(
          "Extension update failed",
          `${record.identity}: ${describeError(error)}`.slice(0, 200),
        );
      }
      return;
    }
    if (record.policy === "notify" && record.notifiedCommit !== record.latestCommit) {
      const count = record.pendingCommits?.length ?? 0;
      this.options.notify(
        "Extension update available",
        `${record.identity}: ${count > 0 ? `${count} new commit${count === 1 ? "" : "s"}` : "new commits"} on ${record.branch ?? "its branch"}. Update it in Plugins.`,
      );
      this.options.store.patch(record.identity, { notifiedCommit: record.latestCommit });
    }
  }

  private async applyGit(
    record: ExtensionSourceRecord,
    repoUrl: string,
    branch: string,
    scope: InteractiveScope | undefined,
  ): Promise<ExtensionSourceRecord> {
    const target = await this.options.cache.fetch(gitLocation(record, repoUrl, branch));
    await this.options.cache.withCheckout(repoUrl, target, async (repoDirectory) => {
      const packageRoot = path.join(repoDirectory, ...(record.subdir ?? "").split("/"));
      const manifest = await readExtensionManifest(packageRoot);
      if (!manifest) {
        throw new Error(
          `runtime-extension.json is not committed at ${record.subdir || "the repository root"} on ${branch}.`,
        );
      }
      if (manifest.identity !== record.identity) {
        throw new Error(
          `${branch} now holds ${manifest.identity} at that path, not ${record.identity}.`,
        );
      }
      const plan = await planPackageBuild(packageRoot, repoDirectory);
      await buildPackage(packageRoot, plan, this.run);
      if (
        manifest.entrypoint &&
        !plan.declaresInstallation &&
        !(await exists(path.join(packageRoot, manifest.entrypoint)))
      ) {
        throw new Error(
          plan.runBuild
            ? `The build did not produce ${manifest.entrypoint}.`
            : `${manifest.entrypoint} is not committed and the package has no build script.`,
        );
      }
      await this.options.applyPackage(record.identity, packageRoot, scope);
    });
    return this.options.store.patch(record.identity, {
      installedCommit: target,
      installedFromDirtyTree: false,
      latestCommit: target,
      updateAvailable: false,
      pendingCommits: [],
      notifiedCommit: target,
      lastError: undefined,
      lastUpdatedAt: this.now().toISOString(),
    });
  }

  private async applyDirectory(
    record: ExtensionSourceRecord,
    scope?: InteractiveScope,
  ): Promise<ExtensionSourceRecord> {
    await this.options.applyPackage(record.identity, record.localPath, scope);
    const git = await detectGitSource(record.localPath, this.git).catch(() => undefined);
    return this.options.store.patch(record.identity, {
      ...(git
        ? {
            installedCommit: git.headCommit,
            installedFromDirtyTree: git.dirty,
            updateAvailable: record.latestCommit ? record.latestCommit !== git.headCommit : false,
          }
        : {}),
      lastError: undefined,
      lastUpdatedAt: this.now().toISOString(),
    });
  }

  private async describeSource(
    identity: string,
    packageRoot: string,
    settings: Pick<ExtensionSourceRecord, "policy" | "hotReload" | "scope">,
  ): Promise<ExtensionSourceRecord> {
    const localPath = await fs.realpath(packageRoot);
    const git = await detectGitSource(localPath, this.git).catch(() => undefined);
    const base: ExtensionSourceRecord = {
      identity,
      kind: "local",
      localPath,
      ...settings,
      lastUpdatedAt: this.now().toISOString(),
    };
    if (!git) return base;
    const withCommit = {
      ...base,
      repoRoot: git.repoRoot,
      subdir: git.subdir,
      installedCommit: git.headCommit,
      installedFromDirtyTree: git.dirty,
    };
    if (!git.repoUrl || !git.branch || !git.remoteName) return withCommit;
    return {
      ...withCommit,
      kind: "git",
      repoUrl: git.repoUrl,
      remoteName: git.remoteName,
      branch: git.branch,
    };
  }

  private syncWatch(record: ExtensionSourceRecord): void {
    if (record.hotReload) this.options.hotReload.watch(record.identity, record.localPath);
    else this.options.hotReload.unwatch(record.identity);
  }

  private toState(record: ExtensionSourceRecord): RuntimeExtensionSourceState {
    return {
      identity: record.identity,
      kind: record.kind,
      localPath: record.localPath,
      ...(record.repoUrl ? { repoUrl: record.repoUrl } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.subdir !== undefined ? { subdir: record.subdir } : {}),
      ...(record.installedCommit ? { installedCommit: record.installedCommit } : {}),
      ...(record.installedFromDirtyTree ? { installedFromDirtyTree: true } : {}),
      policy: record.policy,
      hotReload: record.hotReload,
      ...(record.latestCommit ? { latestCommit: record.latestCommit } : {}),
      ...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
      updateAvailable: record.updateAvailable === true,
      ...(record.pendingCommits?.length ? { pendingCommits: record.pendingCommits } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      ...(record.lastUpdatedAt ? { lastUpdatedAt: record.lastUpdatedAt } : {}),
      updating: this.updating.has(record.identity),
    };
  }
}

function gitLocation(
  record: ExtensionSourceRecord,
  repoUrl: string,
  branch: string,
): GitSourceLocation {
  return {
    repoUrl,
    branch,
    ...(record.repoRoot ? { repoRoot: record.repoRoot } : {}),
    ...(record.remoteName ? { remoteName: record.remoteName } : {}),
  };
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "error";
}

function describeError(error: unknown): string {
  if (error instanceof PackageBuildError) {
    const tail = error.outputTail.trim().split("\n").slice(-8).join("\n");
    return tail ? `${error.message}\n${tail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
