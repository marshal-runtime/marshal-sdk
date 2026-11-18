import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const GIT_TIMEOUT_MS = 120_000;
const MAX_PENDING_COMMITS = 20;

export interface GitRunner {
  (args: readonly string[], options: { cwd: string; timeoutMs?: number }): Promise<string>;
}

/** Runs git without a terminal so a missing credential fails instead of waiting for a prompt. */
export const runGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim().slice(-400);
          reject(new Error(`git ${args[0] ?? ""} failed: ${detail}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

export interface DetectedGitSource {
  readonly repoRoot: string;
  readonly headCommit: string;
  readonly dirty: boolean;
  readonly subdir: string;
  /** Present only when the repository has a remote to follow. */
  readonly remoteName?: string;
  readonly repoUrl?: string;
  readonly branch?: string;
}

/** Removes credentials embedded in an http(s) remote URL; other URL forms are returned unchanged. */
export function redactRemoteUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

async function optionalGit(
  git: GitRunner,
  args: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const value = await git(args, { cwd });
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Describes the git repository a package directory lives in, or undefined when it is not in one. */
export async function detectGitSource(
  packageRoot: string,
  git: GitRunner = runGit,
): Promise<DetectedGitSource | undefined> {
  const root = await fs.realpath(packageRoot);
  const repoRoot = await optionalGit(git, ["rev-parse", "--show-toplevel"], root);
  if (!repoRoot) return undefined;
  const canonicalRepoRoot = await fs.realpath(repoRoot);
  const headCommit = await optionalGit(git, ["rev-parse", "HEAD"], root);
  if (!headCommit) return undefined;
  const subdir = path.relative(canonicalRepoRoot, root).split(path.sep).join("/");
  const status = await optionalGit(
    git,
    ["status", "--porcelain", "--", subdir || "."],
    canonicalRepoRoot,
  );
  const base = { repoRoot: canonicalRepoRoot, headCommit, dirty: Boolean(status), subdir };

  // The upstream of the checked-out branch is what "the source" means; without one, fall back to
  // origin and the current branch, then origin's default branch.
  const upstream = await optionalGit(
    git,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    root,
  );
  let remoteName: string | undefined;
  let branch: string | undefined;
  if (upstream?.includes("/")) {
    const separator = upstream.indexOf("/");
    remoteName = upstream.slice(0, separator);
    branch = upstream.slice(separator + 1);
  } else {
    const remotes = (await optionalGit(git, ["remote"], root))?.split("\n") ?? [];
    remoteName = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remoteName) return base;
    branch =
      (await optionalGit(git, ["symbolic-ref", "--short", "-q", "HEAD"], root)) ??
      (await optionalGit(git, ["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`], root))
        ?.split("/")
        .slice(1)
        .join("/");
  }
  const remoteUrl = await optionalGit(git, ["remote", "get-url", remoteName], root);
  if (!remoteUrl || !branch) return base;
  return { ...base, remoteName, repoUrl: redactRemoteUrl(remoteUrl), branch };
}

/** The commit a remote branch points at, without cloning. */
export async function remoteHead(
  input: { repoUrl: string; branch: string; repoRoot?: string; remoteName?: string },
  git: GitRunner = runGit,
): Promise<string> {
  // Prefer the user's own checkout and remote name so its configured credentials apply.
  const useCheckout = input.repoRoot && input.remoteName && (await isDirectory(input.repoRoot));
  const output = await git(
    [
      "ls-remote",
      useCheckout ? (input.remoteName ?? input.repoUrl) : input.repoUrl,
      `refs/heads/${input.branch}`,
    ],
    { cwd: useCheckout ? (input.repoRoot ?? process.cwd()) : process.cwd() },
  );
  const sha = output.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Branch ${input.branch} was not found on ${input.repoUrl}.`);
  }
  return sha;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export interface GitSourceLocation {
  readonly repoUrl: string;
  readonly branch: string;
  /** The user's checkout the source was installed from, when it still exists. */
  readonly repoRoot?: string;
  readonly remoteName?: string;
}

/** Marshal-owned clones that updates are fetched and built in; never the user's working checkout. */
export class GitSourceCache {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    private readonly git: GitRunner = runGit,
  ) {}

  directoryFor(repoUrl: string): string {
    const name = createHash("sha256").update(repoUrl).digest("hex").slice(0, 16);
    return path.join(this.root, name);
  }

  /**
   * Fetches the branch into the cache and returns the commit it points at. When the user's checkout
   * still exists, the network fetch runs there (a plain `git fetch`, which only moves remote-tracking
   * refs) so the repository's own credential setup applies, and the cache copies from that checkout.
   */
  fetch(source: GitSourceLocation): Promise<string> {
    const { repoUrl, branch } = source;
    return this.withLock(repoUrl, async (directory) => {
      await this.ensureRepository(repoUrl, directory);
      const remoteName = source.remoteName;
      const checkout =
        source.repoRoot && remoteName && (await isDirectory(source.repoRoot))
          ? source.repoRoot
          : undefined;
      if (checkout && remoteName) {
        await this.git(
          [
            "fetch",
            "--no-tags",
            remoteName,
            `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`,
          ],
          { cwd: checkout },
        );
        await this.git(
          [
            "fetch",
            "--no-tags",
            checkout,
            `+refs/remotes/${remoteName}/${branch}:refs/remotes/origin/${branch}`,
          ],
          { cwd: directory },
        );
      } else {
        await this.git(
          [
            "fetch",
            "--no-tags",
            "--filter=blob:none",
            "origin",
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
          ],
          { cwd: directory, timeoutMs: 10 * 60_000 },
        );
      }
      return this.git(["rev-parse", `refs/remotes/origin/${branch}`], { cwd: directory });
    });
  }

  /**
   * Commits in (from, to] that touch subdir, newest first. `relevant` is false when none do, so a
   * push elsewhere in a monorepo is not offered as an update. Unknown `from` counts as relevant.
   */
  pendingCommits(
    repoUrl: string,
    from: string | undefined,
    to: string,
    subdir: string,
  ): Promise<{ relevant: boolean; commits: { sha: string; subject: string }[] }> {
    return this.withLock(repoUrl, async (directory) => {
      const known =
        from !== undefined &&
        (await this.git(["cat-file", "-e", `${from}^{commit}`], { cwd: directory }).then(
          () => true,
          () => false,
        ));
      const range = known ? `${from}..${to}` : to;
      const pathspec = subdir ? ["--", subdir] : [];
      const output = await this.git(
        ["log", `--max-count=${MAX_PENDING_COMMITS}`, "--format=%H%x09%s", range, ...pathspec],
        { cwd: directory },
      );
      const commits = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha = "", ...subject] = line.split("\t");
          return { sha, subject: subject.join("\t") };
        });
      return { relevant: !known || commits.length > 0, commits: known ? commits : [] };
    });
  }

  /** Checks out `commit` in the cache clone and runs `use` while no other operation touches it. */
  withCheckout<T>(
    repoUrl: string,
    commit: string,
    use: (repoDirectory: string) => Promise<T>,
  ): Promise<T> {
    return this.withLock(repoUrl, async (directory) => {
      await this.ensureRepository(repoUrl, directory);
      await this.git(["checkout", "--force", "--detach", commit], { cwd: directory });
      // Keep node_modules between builds so dependency installs stay incremental.
      await this.git(["clean", "-ffdx", "-e", "node_modules"], { cwd: directory });
      return use(directory);
    });
  }

  private async ensureRepository(repoUrl: string, directory: string): Promise<void> {
    if (await isDirectory(path.join(directory, ".git"))) {
      await this.git(["remote", "set-url", "origin", repoUrl], { cwd: directory });
      return;
    }
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true });
    await this.git(["init", "--quiet"], { cwd: directory });
    await this.git(["remote", "add", "origin", repoUrl], { cwd: directory });
  }

  private withLock<T>(repoUrl: string, run: (directory: string) => Promise<T>): Promise<T> {
    const directory = this.directoryFor(repoUrl);
    const previous = this.locks.get(directory) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => run(directory));
    this.locks.set(directory, next);
    void next
      .finally(() => {
        if (this.locks.get(directory) === next) this.locks.delete(directory);
      })
      .catch(() => undefined);
    return next;
  }
}
