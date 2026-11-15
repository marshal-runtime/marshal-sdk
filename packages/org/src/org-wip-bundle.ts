/* eslint-disable no-await-in-loop -- every git step depends on the one before it */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SECRET_PATTERNS } from "../host-deps";

/** S1 limits (design §5): measured on real sessions, p90 of a delta is 0.5 MiB. */
export const MAX_UNTRACKED_FILES = 2000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
/** The body limit of one bundle upload. */
export const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
export const STAGING_TIMEOUT_MS = 30_000;
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_COMMIT_PATCH_BYTES = 64 * 1024 * 1024;
const STAT_BATCH = 64;
const MAX_SKIPPED_LISTED = 200;
const MAX_PATHS_IN_MESSAGE = 10;
const WIP_AUTHOR = "marshal-wip";

/** What a plan or a build refuses, as a code the UI maps to words; `paths` names what is in the way. */
export type WipRefusalCode =
  | "not-a-git-repo"
  | "no-commits"
  | "no-remote"
  | "repo-not-in-workspace"
  | "no-upstream"
  | "submodules"
  | "lfs"
  | "unmerged-paths"
  | "secret-in-tracked"
  | "secret-in-commits"
  | "over-budget"
  | "commits-too-large"
  | "filter-attribute"
  | "windows-unsupported"
  | "git-too-old";

export interface WipRefusal {
  code: WipRefusalCode;
  /** A sentence for the preview card. Never carries file contents or a matched secret. */
  message: string;
  /** Repo-relative paths (at most 10), when the refusal is about files. */
  paths?: string[];
  /** For `secret-*`: the names of the rules that matched, never the matches. */
  rules?: string[];
  /** For `over-budget`: choosing tracked-only lifts it. */
  trackedOnlyHelps?: boolean;
}

export interface WipSkip {
  path: string;
  /** `secret`, `embedded-repo`, `unreadable`, `excluded-by-user`, `over-budget`. */
  why: "secret" | "embedded-repo" | "unreadable" | "excluded-by-user" | "over-budget";
}

export interface WipPlan {
  repoRoot: string;
  /** `owner/name` of `origin`. */
  repo: string;
  branch?: string;
  baseBranch?: string;
  baseCommit: string;
  headCommit: string;
  localCommits: number;
  /** Changed tracked paths (staged, unstaged or deleted), repo-relative. */
  tracked: string[];
  trackedBytes: number;
  /** Untracked, non-ignored files that will travel, repo-relative. */
  untracked: string[];
  untrackedBytes: number;
  /** Untracked files that stay on the laptop, listed (at most 200) and counted. */
  skipped: WipSkip[];
  skippedTotal: number;
  /** Anything that stops the mount from moving; empty means it can move. */
  refusals: WipRefusal[];
  /** The untracked files and bytes found when they went past the budget. */
  overBudget?: { files: number; bytes: number };
  trackedOnly: boolean;
}

export type WipErrorCode = "cancelled" | "staging-timeout" | "bundle-too-large" | "git-failed";

export class WipError extends Error {
  constructor(
    readonly code: WipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WipError";
  }
}

export interface WipPlanOptions {
  /** A directory inside the repository (the session's working directory). */
  cwd: string;
  trackedOnly?: boolean;
  /** Repo-relative untracked paths or directories the person left out. */
  excludePaths?: readonly string[];
  /** False for a repository that is not a repository of the session's organization workspace. */
  repoAllowed?: (repo: string) => boolean;
  maxUntrackedFiles?: number;
  maxUntrackedBytes?: number;
  signal?: AbortSignal;
}

interface GitResult {
  stdout: Buffer;
}

type GitEnv = Record<string, string | undefined>;

/** Variables that would point git at another repository, index or object store than the one a call names. */
const INHERITED_GIT_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
];

/**
 * Every call runs without the repository's own code: no hook (`core.hooksPath` names no directory, so `post-index-change` and the
 * others cannot fire) and no filesystem monitor program. Filter programs are blanked per repository (`filterOverrides`), and a
 * carried path with a filter attribute is refused by the plan.
 */
const NO_REPO_CODE = ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];

/** `-c` arguments that blank every filter program the repository's config names, so that `git status`, `git diff` and `git add` cannot run one; reading the config runs nothing. */
async function filterOverrides(cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
  const names = await git(["config", "--name-only", "--get-regexp", "^filter\\."], {
    cwd,
    signal,
    allowFailure: true,
  });
  const drivers = new Set<string>();
  for (const line of names.stdout.toString("utf8").split("\n")) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(line.trim());
    if (match) drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => [
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.smudge=`,
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.required=false`,
  ]);
}

function gitEnv(extra: GitEnv | undefined): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const name of INHERITED_GIT_VARIABLES) delete inherited[name];
  return {
    ...inherited,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
    ...extra,
  };
}

function git(
  args: readonly string[],
  options: {
    cwd: string;
    env?: GitEnv;
    input?: string | Buffer;
    signal?: AbortSignal;
    maxBytes?: number;
    allowFailure?: boolean;
    config?: readonly string[];
  },
): Promise<GitResult & { code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new WipError("cancelled", "cancelled"));
      return;
    }
    const child = execFile(
      "git",
      [...NO_REPO_CODE, ...(options.config ?? []), "-c", "core.quotepath=off", ...args],
      {
        cwd: options.cwd,
        env: gitEnv(options.env),
        encoding: "buffer",
        maxBuffer: options.maxBytes ?? MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout) => {
        if (!error) {
          resolve({ stdout, code: 0 });
          return;
        }
        if (options.signal?.aborted) {
          reject(new WipError("cancelled", "cancelled"));
          return;
        }
        const exit = typeof error.code === "number" ? error.code : -1;
        if (options.allowFailure && exit !== -1 && !/maxBuffer/i.test(error.message)) {
          resolve({ stdout, code: exit });
          return;
        }
        reject(new WipError("git-failed", `git ${args[0] ?? ""} failed`));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** The `[major, minor]` of `git --version` output, or undefined for text that is not one. */
export function parseGitVersion(output: string): [number, number] | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** `--pathspec-from-file`, which the staging uses, arrived in git 2.25. */
const MIN_GIT: [number, number] = [2, 25];

const text = (result: GitResult) => result.stdout.toString("utf8").trim();
const nulList = (result: GitResult) =>
  result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");

/** Tokens and keys by content; the names are for the card, the matches never leave this function. */
const CONTENT_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  ...SECRET_PATTERNS.map(({ name, pattern }) => ({
    name,
    pattern: new RegExp(pattern.source, pattern.flags.replace("g", "")),
  })),
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
];

export function scanTextForSecrets(content: string): string[] {
  return CONTENT_RULES.filter((rule) => rule.pattern.test(content)).map((rule) => rule.name);
}

const SAFE_ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;
const PATH_RULES: ReadonlyArray<{
  name: string;
  test: (relative: string, base: string) => boolean;
}> = [
  {
    name: "env-file",
    test: (_p, base) => /^\.env(?:\..+)?$/i.test(base) && !SAFE_ENV_TEMPLATE.test(base),
  },
  {
    name: "private-key-file",
    test: (_p, base) => /\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(base),
  },
  { name: "ssh-key", test: (_p, base) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i.test(base) },
  {
    name: "credentials-file",
    test: (_p, base) =>
      /^(?:\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|service-account.*\.json)$/i.test(
        base,
      ),
  },
  { name: "cloud-credentials", test: (p) => /(?:^|\/)\.(?:aws|ssh|gnupg|kube)\//.test(p) },
  { name: "terraform-state", test: (_p, base) => /\.tfstate(?:\.backup)?$/i.test(base) },
];

/** The name of the path rule a file hits, checked without opening the file. */
export function secretPathRule(relative: string): string | undefined {
  const base = relative.slice(relative.lastIndexOf("/") + 1);
  return PATH_RULES.find((rule) => rule.test(relative, base))?.name;
}

/** `owner/name` of a GitHub-style remote URL (https, ssh or scp form). */
export function parseRemoteRepo(url: string): string | undefined {
  const match =
    /(?:^|[:/])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function underPath(candidate: string, entry: string): boolean {
  const normalized = entry.replace(/\/+$/, "");
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

/** Groups paths by their first directory so a long list stays readable on a card and in a manifest. */
function summarizeSkips(skips: WipSkip[]): WipSkip[] {
  if (skips.length <= MAX_SKIPPED_LISTED) return skips;
  const groups = new Map<string, WipSkip>();
  for (const skip of skips) {
    const head = skip.path.includes("/") ? skip.path.slice(0, skip.path.indexOf("/")) : skip.path;
    if (!groups.has(head)) groups.set(head, { path: head, why: skip.why });
  }
  return [...groups.values()].slice(0, MAX_SKIPPED_LISTED);
}

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WipError("cancelled", "cancelled");
}

async function statBatch(
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ bytes: number; unreadable: string[] }> {
  let bytes = 0;
  const unreadable: string[] = [];
  for (let index = 0; index < paths.length; index += STAT_BATCH) {
    stopIfAborted(signal);
    const batch = paths.slice(index, index + STAT_BATCH);
    const stats = await Promise.all(
      batch.map((relative) => fs.lstat(path.join(root, relative)).catch(() => undefined)),
    );
    stats.forEach((stat, offset) => {
      if (!stat) unreadable.push(batch[offset]);
      else if (stat.isFile()) bytes += stat.size;
    });
  }
  return { bytes, unreadable };
}

async function scanFile(
  root: string,
  relative: string,
  signal?: AbortSignal,
): Promise<string[] | "too-large"> {
  stopIfAborted(signal);
  const full = path.join(root, relative);
  const stat = await fs.lstat(full).catch(() => undefined);
  if (!stat || !stat.isFile()) return [];
  if (stat.size > MAX_SCAN_FILE_BYTES) return "too-large";
  const content = await fs.readFile(full).catch(() => undefined);
  return content ? scanTextForSecrets(content.toString("latin1")) : [];
}

function listed(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_PATHS_IN_MESSAGE);
}

function refusal(
  code: WipRefusalCode,
  message: string,
  extra: Partial<WipRefusal> = {},
): WipRefusal {
  return { code, message, ...extra };
}

/**
 * Works out what a move would carry from the session's repository and what stops it, without staging anything and without
 * reading a file that a path rule already excludes. Reads the repository only: no index, ref or object is written.
 */
export async function planWip(options: WipPlanOptions): Promise<WipPlan | WipRefusal> {
  const { signal } = options;
  if (process.platform === "win32") {
    return refusal(
      "windows-unsupported",
      "Moving files from Windows is not supported yet. The conversation can still move.",
    );
  }
  const version = await git(["--version"], { cwd: options.cwd, signal, allowFailure: true });
  const parsedVersion = parseGitVersion(text(version));
  if (
    version.code !== 0 ||
    !parsedVersion ||
    parsedVersion[0] < MIN_GIT[0] ||
    (parsedVersion[0] === MIN_GIT[0] && parsedVersion[1] < MIN_GIT[1])
  ) {
    return refusal(
      "git-too-old",
      `Moving files needs git ${MIN_GIT.join(".")} or newer. Update git, or move the conversation only.`,
    );
  }
  const top = await git(["rev-parse", "--show-toplevel"], {
    cwd: options.cwd,
    signal,
    allowFailure: true,
  });
  if (top.code !== 0) {
    return refusal("not-a-git-repo", "This session's folder is not a git repository.");
  }
  const repoRoot = text(top);
  const config = await filterOverrides(repoRoot, signal);
  const run = (args: readonly string[], allowFailure = false) =>
    git(args, { cwd: repoRoot, signal, allowFailure, config });

  const head = await run(["rev-parse", "--verify", "-q", "HEAD"], true);
  if (head.code !== 0) return refusal("no-commits", "This repository has no commits yet.");
  const headCommit = text(head);

  const originUrl = await run(["config", "--get", "remote.origin.url"], true);
  const repo = originUrl.code === 0 ? parseRemoteRepo(text(originUrl)) : undefined;
  if (!repo) return refusal("no-remote", "This repository has no GitHub remote named origin.");
  if (options.repoAllowed && !options.repoAllowed(repo)) {
    return refusal(
      "repo-not-in-workspace",
      `${repo} is not a repository of this session's organization workspace.`,
    );
  }

  const branchResult = await run(["symbolic-ref", "--short", "-q", "HEAD"], true);
  const branch = branchResult.code === 0 ? text(branchResult) : undefined;
  const upstreamResult = await run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    true,
  );
  let upstream = upstreamResult.code === 0 ? text(upstreamResult) : undefined;
  if (!upstream) {
    const originHead = await run(
      ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
      true,
    );
    upstream = originHead.code === 0 ? text(originHead) : undefined;
  }
  if (!upstream) {
    return refusal(
      "no-upstream",
      "Marshal cannot tell which commits are already on the remote: this branch has no upstream.",
    );
  }
  const mergeBase = await run(["merge-base", "HEAD", upstream], true);
  if (mergeBase.code !== 0) {
    return refusal("no-upstream", "This branch shares no history with its upstream.");
  }
  const baseCommit = text(mergeBase);
  const baseBranch = upstream.startsWith("origin/") ? upstream.slice("origin/".length) : undefined;

  const refusals: WipRefusal[] = [];
  const hasGitmodules = await fs
    .access(path.join(repoRoot, ".gitmodules"))
    .then(() => true)
    .catch(() => false);
  if (hasGitmodules) {
    refusals.push(
      refusal("submodules", "This repository has submodules, which a move does not carry."),
    );
  }

  const localCommits = Number(text(await run(["rev-list", "--count", `${baseCommit}..HEAD`])));

  const diff = nulList(
    await run([
      "diff",
      "-z",
      "--name-status",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ]),
  );
  const tracked: string[] = [];
  const unmerged: string[] = [];
  for (let index = 0; index + 1 < diff.length; index += 2) {
    const status = diff[index];
    const file = diff[index + 1];
    if (status.startsWith("U")) unmerged.push(file);
    else tracked.push(file);
  }
  if (unmerged.length > 0) {
    refusals.push(
      refusal("unmerged-paths", "Resolve the merge conflicts before moving.", {
        paths: listed(unmerged),
      }),
    );
  }

  const found = nulList(await run(["ls-files", "-o", "--exclude-standard", "-z"]));
  const skipped: WipSkip[] = [];
  const candidates: string[] = [];
  const userExcluded = options.excludePaths ?? [];
  const secretNames = new Set<string>();
  for (const entry of found) {
    if (entry.endsWith("/")) {
      skipped.push({ path: entry.replace(/\/+$/, ""), why: "embedded-repo" });
    } else if (userExcluded.some((excluded) => underPath(entry, excluded))) {
      skipped.push({ path: entry, why: "excluded-by-user" });
    } else if (secretPathRule(entry)) {
      skipped.push({ path: entry, why: "secret" });
    } else {
      candidates.push(entry);
    }
  }

  const maxFiles = options.maxUntrackedFiles ?? MAX_UNTRACKED_FILES;
  const maxBytes = options.maxUntrackedBytes ?? MAX_UNTRACKED_BYTES;
  let untracked = candidates;
  let untrackedBytes = 0;
  let overBudget: WipPlan["overBudget"];
  let eligible = candidates;
  if (candidates.length > maxFiles) {
    overBudget = { files: candidates.length, bytes: 0 };
  } else {
    const sized = await statBatch(repoRoot, candidates, signal);
    for (const lost of sized.unreadable) skipped.push({ path: lost, why: "unreadable" });
    const lostSet = new Set(sized.unreadable);
    eligible = candidates.filter((entry) => !lostSet.has(entry));
    untrackedBytes = sized.bytes;
    if (sized.bytes > maxBytes) overBudget = { files: eligible.length, bytes: sized.bytes };
  }
  if (overBudget) {
    if (options.trackedOnly) {
      for (const entry of candidates) skipped.push({ path: entry, why: "over-budget" });
      untracked = [];
      untrackedBytes = 0;
    } else {
      untracked = [];
      refusals.push(
        refusal(
          "over-budget",
          `${overBudget.files.toLocaleString("en-US")} untracked files${overBudget.bytes > 0 ? ` (${Math.ceil(overBudget.bytes / (1024 * 1024))} MiB)` : ""} are more than a move carries (${maxFiles.toLocaleString("en-US")} files or ${maxBytes / (1024 * 1024)} MiB). Move only the tracked changes and commits, and leave the untracked files here.`,
          { trackedOnlyHelps: true },
        ),
      );
    }
  } else {
    untracked = eligible;
  }

  const trackedSized = await statBatch(repoRoot, tracked, signal);
  const trackedBytes = trackedSized.bytes;

  // Content scans: untracked files are excluded on a hit, tracked changes and local commits stop the move (the delta cannot be applied without them).
  if (untracked.length > 0) {
    const keep: string[] = [];
    for (const entry of untracked) {
      const hit = await scanFile(repoRoot, entry, signal);
      if (hit === "too-large") skipped.push({ path: entry, why: "over-budget" });
      else if (hit.length > 0) {
        skipped.push({ path: entry, why: "secret" });
        for (const rule of hit) secretNames.add(rule);
      } else keep.push(entry);
    }
    untracked = keep;
  }
  const trackedHits: string[] = [];
  const trackedRules = new Set<string>();
  for (const entry of tracked) {
    const pathRule = secretPathRule(entry);
    if (pathRule) {
      trackedHits.push(entry);
      trackedRules.add(pathRule);
      continue;
    }
    const hit = await scanFile(repoRoot, entry, signal);
    if (hit === "too-large") {
      trackedHits.push(entry);
      trackedRules.add("too-large-to-scan");
    } else if (hit.length > 0) {
      trackedHits.push(entry);
      for (const rule of hit) trackedRules.add(rule);
    }
  }
  if (trackedHits.length > 0) {
    refusals.push(
      refusal(
        "secret-in-tracked",
        "A changed tracked file looks like it holds a secret, so the changes cannot move. Nothing is redacted into an upload.",
        { paths: listed(trackedHits), rules: [...trackedRules] },
      ),
    );
  }
  const commitRules = new Set<string>();
  if (localCommits > 0) {
    const patch = await run(
      [
        "log",
        "-p",
        "-m",
        "-U0",
        "--text",
        "--no-textconv",
        "--no-ext-diff",
        "--no-color",
        "--format=",
        `${baseCommit}..HEAD`,
        "--",
      ],
      true,
    ).catch((error: unknown) => {
      if (error instanceof WipError && error.code === "cancelled") throw error;
      return undefined;
    });
    if (!patch || patch.code !== 0 || patch.stdout.length > MAX_COMMIT_PATCH_BYTES) {
      refusals.push(
        refusal(
          "commits-too-large",
          "The unpushed commits are too large to check for secrets, so they cannot move.",
        ),
      );
    } else {
      const added = patch.stdout
        .toString("latin1")
        .split("\n")
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .join("\n");
      for (const rule of scanTextForSecrets(added)) commitRules.add(rule);
    }
  }

  // Every file any unpushed commit added or modified travels in the bundle's history, even one that a later commit deleted.
  const committedPaths =
    localCommits > 0
      ? nulList(
          await run([
            "log",
            "-z",
            "-m",
            "--name-only",
            "--no-renames",
            "--diff-filter=AM",
            "--format=",
            `${baseCommit}..HEAD`,
            "--",
          ]),
        )
      : [];
  const commitPathHits: string[] = [];
  for (const entry of new Set(committedPaths)) {
    const pathRule = secretPathRule(entry);
    if (pathRule) {
      commitPathHits.push(entry);
      commitRules.add(pathRule);
    }
  }
  if (commitRules.size > 0) {
    refusals.push(
      refusal(
        "secret-in-commits",
        "An unpushed commit adds something that looks like a secret, so the commits cannot move.",
        {
          rules: [...commitRules],
          ...(commitPathHits.length > 0 ? { paths: listed(commitPathHits) } : {}),
        },
      ),
    );
  }

  const touchedByCommits =
    localCommits > 0
      ? nulList(
          await run([
            "diff",
            "-z",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            baseCommit,
            "HEAD",
            "--",
          ]),
        )
      : [];
  const attrPaths = [...new Set([...tracked, ...untracked, ...touchedByCommits])];
  if (attrPaths.length > 0) {
    const attrs = await git(["check-attr", "-z", "--stdin", "filter"], {
      cwd: repoRoot,
      input: attrPaths.join("\0"),
      signal,
      allowFailure: true,
    });
    const fields = attrs.stdout.toString("utf8").split("\0");
    const lfsPaths: string[] = [];
    const filteredPaths: string[] = [];
    const carried = new Set([...tracked, ...untracked]);
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const value = fields[index + 2];
      if (value === "lfs") lfsPaths.push(fields[index]);
      else if (value !== "unspecified" && value !== "unset" && carried.has(fields[index])) {
        filteredPaths.push(fields[index]);
      }
    }
    if (lfsPaths.length > 0) {
      refusals.push(
        refusal("lfs", "These changes include Git LFS files, which a move does not carry.", {
          paths: listed(lfsPaths),
        }),
      );
    }
    if (filteredPaths.length > 0) {
      refusals.push(
        refusal(
          "filter-attribute",
          "These files use a git filter, and a move does not run filters. Leave them out or move the conversation only.",
          { paths: listed(filteredPaths) },
        ),
      );
    }
  }

  void secretNames;
  return {
    repoRoot,
    repo,
    ...(branch ? { branch } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    baseCommit,
    headCommit,
    localCommits,
    tracked,
    trackedBytes,
    untracked,
    untrackedBytes,
    skipped: summarizeSkips(skipped),
    skippedTotal: skipped.length,
    refusals,
    ...(overBudget ? { overBudget } : {}),
    trackedOnly: options.trackedOnly === true,
  };
}

export function isRefusal(value: WipPlan | WipRefusal): value is WipRefusal {
  return "code" in value;
}

export interface WipBundle {
  bytes: Uint8Array;
  sha256: string;
  tracked: number;
  untracked: number;
  localCommits: number;
}

/**
 * Builds the bundle of `<base>..<wip>` without touching the repository: a temporary index, a private object directory in front
 * of the repository's own (so the new blobs, trees and the WIP commit never land in `.git`), and a scratch bare repository
 * that holds the one ref a bundle needs. No branch, index entry, file or hook is touched, and no `git commit` runs.
 * Returns `undefined` when there is nothing to carry (a clean tree with everything pushed).
 */
export async function buildWipBundle(
  plan: WipPlan,
  options: {
    sessionId: string;
    maxBundleBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<WipBundle | undefined> {
  if (plan.refusals.length > 0) {
    throw new WipError("git-failed", "the plan has refusals");
  }
  if (plan.localCommits === 0 && plan.tracked.length === 0 && plan.untracked.length === 0) {
    return undefined;
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? STAGING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-wip-"));
  try {
    return await buildInScratch(plan, options, scratch, signal);
  } catch (error) {
    if (error instanceof WipError && error.code === "cancelled" && timeout.aborted) {
      throw new WipError("staging-timeout", "staging took too long");
    }
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildInScratch(
  plan: WipPlan,
  options: { sessionId: string; maxBundleBytes?: number },
  scratch: string,
  signal: AbortSignal,
): Promise<WipBundle> {
  const objectsPath = path.resolve(
    plan.repoRoot,
    text(await git(["rev-parse", "--git-path", "objects"], { cwd: plan.repoRoot, signal })),
  );
  const ownObjects = path.join(scratch, "objects");
  await fs.mkdir(ownObjects, { recursive: true });
  const stagingEnv: GitEnv = {
    GIT_INDEX_FILE: path.join(scratch, "index"),
    GIT_OBJECT_DIRECTORY: ownObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsPath,
  };
  const config = await filterOverrides(plan.repoRoot, signal);
  const run = (args: readonly string[], input?: string) =>
    git(args, { cwd: plan.repoRoot, env: stagingEnv, input, signal, config });

  await run(["read-tree", "HEAD"]);
  const carried = [...plan.tracked, ...plan.untracked];
  if (carried.length > 0) {
    await run(
      ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      `${carried.join("\0")}\0`,
    );
  }
  const tree = text(await run(["write-tree"]));
  const identity = {
    GIT_AUTHOR_NAME: WIP_AUTHOR,
    GIT_AUTHOR_EMAIL: `${WIP_AUTHOR}@localhost`,
    GIT_COMMITTER_NAME: WIP_AUTHOR,
    GIT_COMMITTER_EMAIL: `${WIP_AUTHOR}@localhost`,
  };
  const wip = text(
    await git(
      [
        "commit-tree",
        tree,
        "-p",
        "HEAD",
        "-m",
        `marshal-wip: work in progress of session ${options.sessionId}\n\nmarshal-wip: ${options.sessionId}`,
      ],
      { cwd: plan.repoRoot, env: { ...stagingEnv, ...identity }, signal, config },
    ),
  );

  const bare = path.join(scratch, "bundle-repo");
  await git(["init", "--bare", "-q", bare], { cwd: scratch, signal });
  await fs.writeFile(
    path.join(bare, "objects", "info", "alternates"),
    `${objectsPath}\n${ownObjects}\n`,
  );
  await git(["update-ref", "refs/marshal-wip", wip], { cwd: bare, signal });
  const file = path.join(scratch, "wip.bundle");
  await git(["bundle", "create", file, "refs/marshal-wip", `^${plan.baseCommit}`], {
    cwd: bare,
    signal,
  });
  const stat = await fs.stat(file);
  const cap = options.maxBundleBytes ?? MAX_BUNDLE_BYTES;
  if (stat.size > cap) {
    throw new WipError(
      "bundle-too-large",
      `the bundle is ${stat.size} bytes, more than the ${cap} a move carries`,
    );
  }
  const bytes = new Uint8Array(await fs.readFile(file));
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tracked: plan.tracked.length,
    untracked: plan.untracked.length,
    localCommits: plan.localCommits,
  };
}
