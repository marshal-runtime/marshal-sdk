import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { GitRunner } from "./git-source";
import { runGit } from "./git-source";
import { readExtensionManifest } from "./package-build";

const DEFAULT_MAX_DEPTH = 4;
const MAX_DIRECTORIES = 20_000;
const SKIPPED = new Set(["node_modules", "dist", "out", "build", "coverage", "worktrees"]);

/**
 * Registered workspaces and the folders that hold them: extension repos tend to sit beside the
 * project they were built for. The home directory and filesystem roots are never scanned whole.
 */
export function extensionSourceSearchRoots(
  workspaces: readonly { readonly path: string }[],
  homeDirectory: string = os.homedir(),
): string[] {
  const roots = new Set<string>();
  const home = path.resolve(homeDirectory);
  for (const workspace of workspaces) {
    const resolved = path.resolve(workspace.path);
    roots.add(resolved);
    const parent = path.dirname(resolved);
    if (parent !== home && parent !== path.parse(parent).root) roots.add(parent);
  }
  return [...roots];
}

export interface SourceCandidate {
  readonly identity: string;
  readonly version?: string;
  readonly packageRoot: string;
  /** The manifest is committed in a git repository's main checkout (not a linked worktree). */
  readonly tracked: boolean;
  readonly inMainCheckout: boolean;
}

/** Finds directories holding a runtime-extension.json under the given roots. */
export async function scanForExtensionPackages(
  roots: readonly string[],
  maxDepth = DEFAULT_MAX_DEPTH,
): Promise<string[]> {
  const found = new Set<string>();
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (visited++ > MAX_DIRECTORIES) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "runtime-extension.json")) {
      found.add(directory);
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // Hidden folders hold staged copies, caches and Marshal's own installed copies.
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name) || entry.name.includes(".bak")) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- bounded walk keeps file handle use low
      await visit(path.join(directory, entry.name), depth + 1);
    }
  };
  for (const start of new Set(roots.map((candidate) => path.resolve(candidate)))) {
    // eslint-disable-next-line no-await-in-loop -- roots overlap; sequential walk dedupes cheaply
    await visit(start, 0);
  }
  return [...found];
}

async function describeCandidate(
  packageRoot: string,
  git: GitRunner,
): Promise<SourceCandidate | undefined> {
  const manifest = await readExtensionManifest(packageRoot);
  if (!manifest) return undefined;
  const tracked = await git(["ls-files", "--error-unmatch", "runtime-extension.json"], {
    cwd: packageRoot,
  }).then(
    () => true,
    () => false,
  );
  let inMainCheckout = false;
  if (tracked) {
    const gitDir = await git(["rev-parse", "--git-dir"], { cwd: packageRoot }).catch(() => "");
    const commonDir = await git(["rev-parse", "--git-common-dir"], { cwd: packageRoot }).catch(
      () => "",
    );
    inMainCheckout =
      gitDir !== "" && path.resolve(packageRoot, gitDir) === path.resolve(packageRoot, commonDir);
  }
  return {
    identity: manifest.identity,
    ...(manifest.version ? { version: manifest.version } : {}),
    packageRoot,
    tracked,
    inMainCheckout,
  };
}

/**
 * Picks the most likely source directory for each installed identity: a committed manifest in a
 * main checkout first, then one whose version matches the installed version, then the shortest path.
 */
export async function findExtensionSources(
  installed: readonly { identity: string; version: string }[],
  roots: readonly string[],
  git: GitRunner = runGit,
): Promise<Map<string, SourceCandidate>> {
  const wanted = new Map(installed.map((entry) => [entry.identity, entry.version]));
  const directories = await scanForExtensionPackages(roots);
  const byIdentity = new Map<string, SourceCandidate[]>();
  for (const directory of directories) {
    // eslint-disable-next-line no-await-in-loop -- each candidate runs a few git commands; keep it serial
    const candidate = await describeCandidate(directory, git);
    if (!candidate || !wanted.has(candidate.identity)) continue;
    byIdentity.set(candidate.identity, [...(byIdentity.get(candidate.identity) ?? []), candidate]);
  }
  const chosen = new Map<string, SourceCandidate>();
  for (const [identity, candidates] of byIdentity) {
    const installedVersion = wanted.get(identity);
    const score = (candidate: SourceCandidate) =>
      (candidate.tracked ? 4 : 0) +
      (candidate.inMainCheckout ? 2 : 0) +
      (candidate.version === installedVersion ? 1 : 0);
    const best = [...candidates].sort(
      (left, right) =>
        score(right) - score(left) || left.packageRoot.length - right.packageRoot.length,
    )[0];
    if (best) chosen.set(identity, best);
  }
  return chosen;
}
