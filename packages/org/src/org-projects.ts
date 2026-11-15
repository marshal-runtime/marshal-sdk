import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../host-deps";
import { validateWorkspaceName } from "../host-deps";
import type {
  OrgProjectCloneOutcome,
  OrgProjectRepo,
  OrgProjectsCloneRequest,
  OrgProjectsCloneResult,
  OrgProjectsEvent,
  OrgProjectsGhStatus,
  OrgProjectsListResult,
} from "./contract/org-types";

const log = createLogger("OrgProjects");

const GH_QUICK_TIMEOUT_MS = 15_000;
const GH_LIST_TIMEOUT_MS = 120_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface GhRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The `gh` executable could not be started. */
  missing?: boolean;
}

export interface GhProcess {
  kill: () => void;
  done: Promise<{ code: number | null; missing?: boolean }>;
  /** Written to the process's stdin. */
  write: (text: string) => void;
}

export interface OrgProjectsDeps {
  runGh: (args: string[], options: { timeoutMs: number }) => Promise<GhRunResult>;
  spawnGh: (
    args: string[],
    options: {
      env?: Record<string, string>;
      timeoutMs: number;
      onStdout: (chunk: string) => void;
      onStderr: (chunk: string) => void;
    },
  ) => GhProcess;
  readOrigin: (folder: string) => Promise<{ repo?: string }>;
  listWorkspaces: () => Array<{ name: string; path: string }>;
  registerWorkspace: (name: string, folder: string) => Promise<{ name: string; path: string }>;
  /** Whether the workspace now maps to an organization workspace; undefined when mapping is unavailable. */
  isOrgMapped: (workspaceName: string) => Promise<boolean | undefined>;
  openExternal: (url: string) => boolean;
  pickFolder: (defaultPath: string) => Promise<string | undefined>;
  emit: (event: OrgProjectsEvent) => void;
  /** Runs `git` for read-only config queries; absent in tests that do not need it. */
  runGit?: (args: string[]) => Promise<GhRunResult>;
  /** Whether onboarding is available (signed in); the service refuses every call while it is off. */
  isEnabled?: () => boolean;
  homeDir?: () => string;
  platform?: NodeJS.Platform;
}

const DISABLED = { success: false, error: "disabled" } as const;

export interface GhRepoRecord {
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  description: string;
  sizeKb: number;
  pushedAt: string;
  canPull: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Expands `~`, resolves to an absolute path, and rejects anything that is not an absolute location. */
export function resolveCloneRoot(
  input: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let expanded = trimmed;
  if (trimmed === "~") expanded = home;
  else if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = pathApi.join(home, trimmed.slice(2));
  }
  if (!pathApi.isAbsolute(expanded)) return null;
  return pathApi.resolve(expanded);
}

/** Reads `gh api --paginate --jq '.[]'` output: one JSON object per line, or several arrays back to back. */
export function parseRepoListing(stdout: string, owner: string): GhRepoRecord[] {
  const records: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      // SF-4: lines come from `gh api` output and are shape-checked below.
      parsed = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) records.push(...(parsed as unknown[]));
    else records.push(parsed);
  }
  const repos = new Map<string, GhRepoRecord>();
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const item = raw;
    const name = typeof item.name === "string" ? item.name : "";
    const ownerLogin = isRecord(item.owner) ? item.owner.login : item.owner_login;
    if (!name || !REPO_PATTERN.test(name) || name === "." || name === "..") continue;
    if (typeof ownerLogin !== "string" || ownerLogin.toLowerCase() !== owner.toLowerCase())
      continue;
    if (item.archived === true || item.disabled === true) continue;
    const canPull = isRecord(item.permissions) ? item.permissions.pull !== false : true;
    if (!canPull) continue;
    repos.set(name.toLowerCase(), {
      name,
      fullName: `${ownerLogin}/${name}`,
      private: item.private === true,
      archived: false,
      description: typeof item.description === "string" ? item.description : "",
      sizeKb: typeof item.size === "number" ? item.size : 0,
      pushedAt: typeof item.pushed_at === "string" ? item.pushed_at : "",
      canPull,
    });
  }
  return [...repos.values()];
}

/** Sorts the preselected repositories first (in manifest order), then the rest by name. */
export function orderRepos<T extends { name: string }>(repos: T[], preselect: string[]): T[] {
  const rank = new Map(preselect.map((name, index) => [name.toLowerCase(), index]));
  return [...repos].sort((a, b) => {
    const ra = rank.get(a.name.toLowerCase());
    const rb = rank.get(b.name.toLowerCase());
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Pulls the one-time device code and the URL out of what `gh auth login --web` prints. */
export function parseDeviceCode(text: string): { code: string; url: string } | null {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text)?.[1];
  if (!code) return null;
  const url =
    /(https:\/\/github\.com\/login\/device)\b/.exec(text)?.[1] ?? "https://github.com/login/device";
  return { code, url };
}

/** `git clone --progress` writes `Receiving objects:  45% (…)` separated by carriage returns. */
export function parseCloneProgress(text: string): { phase: string; percent?: number } | null {
  const segments = text.split(/[\r\n]+/).filter((segment) => segment.trim());
  const last = segments[segments.length - 1];
  if (!last) return null;
  const match = /^(?:remote: )?([A-Za-z][A-Za-z ]+?):\s+(\d{1,3})%/.exec(last.trim());
  if (match) return { phase: match[1], percent: Math.min(100, Number(match[2])) };
  const phase = /^(Cloning into|Updating files|Resolving deltas)/.exec(last.trim())?.[1];
  return phase ? { phase } : null;
}

/** Reads an `X-GitHub-SSO` response header; a `required` header carries a URL, a `partial-results` one only flags that orgs were left out. */
export function parseSsoUrl(headers: string, owner: string): string | undefined {
  const line = /^x-github-sso:\s*(.+)$/im.exec(headers)?.[1];
  if (!line) return undefined;
  const url = /url=(https:\/\/github\.com\/[^\s;,]+)/i.exec(line)?.[1];
  if (url) return url;
  return `https://github.com/orgs/${owner}/sso`;
}

export function ghInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "brew install gh";
  if (platform === "win32") return "winget install --id GitHub.cli";
  return "https://github.com/cli/cli#installation";
}

function ghEnvPath(platform: NodeJS.Platform): string {
  const current = process.env.PATH ?? "";
  if (platform === "win32") return current;
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].filter(
    (entry) => !current.split(":").includes(entry),
  );
  return [current, ...extra].filter(Boolean).join(":");
}

export class OrgProjects {
  private loginProcess: GhProcess | null = null;
  private cloneAbort: { cancelled: boolean; current?: GhProcess } | null = null;

  constructor(private readonly deps: OrgProjectsDeps) {}

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private get home(): string {
    return (this.deps.homeDir ?? os.homedir)();
  }

  private get disabled(): boolean {
    return this.deps.isEnabled ? !this.deps.isEnabled() : false;
  }

  async status(): Promise<OrgProjectsGhStatus | typeof DISABLED> {
    if (this.disabled) return DISABLED;
    const version = await this.deps.runGh(["--version"], { timeoutMs: GH_QUICK_TIMEOUT_MS });
    if (version.missing || version.code !== 0) {
      return { success: true, gh: "missing", installHint: ghInstallHint(this.platform) };
    }
    const auth = await this.deps.runGh(["api", "user", "--jq", ".login"], {
      timeoutMs: GH_QUICK_TIMEOUT_MS,
    });
    const login = auth.stdout.trim();
    if (auth.code === 0 && login) return { success: true, gh: "ready", login };
    return { success: true, gh: "unauthed" };
  }

  async login(): Promise<OrgProjectsGhStatus | { success: false; error: string }> {
    if (this.disabled) return DISABLED;
    if (this.loginProcess) return { success: false, error: "A sign-in is already running" };
    const current = await this.status();
    if (!current.success || current.gh !== "unauthed") return current;

    let announced = false;
    let buffer = "";
    const onText = (chunk: string) => {
      if (announced) return;
      buffer += chunk;
      const device = parseDeviceCode(buffer);
      if (!device) return;
      announced = true;
      this.deps.emit({ kind: "device-code", ...device });
      this.deps.openExternal(device.url);
    };
    const processHandle = this.deps.spawnGh(
      ["auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"],
      {
        env: { GH_BROWSER: this.platform === "win32" ? "cmd /c exit" : "true" },
        timeoutMs: LOGIN_TIMEOUT_MS,
        onStdout: onText,
        onStderr: onText,
      },
    );
    this.loginProcess = processHandle;
    processHandle.write("\n");
    const finished = await processHandle.done;
    this.loginProcess = null;
    if (finished.code !== 0) {
      const error = finished.missing ? "GitHub CLI not found" : "GitHub sign-in did not finish";
      this.deps.emit({ kind: "login-finished", ok: false, error });
      return { success: false, error };
    }
    const foreignHelper = await this.foreignGithubCredentialHelper();
    if (foreignHelper) {
      this.deps.emit({ kind: "login-finished", ok: true });
      const status = await this.status();
      return status.success && status.gh === "ready"
        ? {
            ...status,
            credentialNotice: `Git already uses another credential helper for github.com (${foreignHelper}). Marshal left it unchanged.`,
          }
        : status;
    }
    const setup = await this.setupGit();
    if (!setup.success) {
      this.deps.emit({ kind: "login-finished", ok: false, error: setup.error });
      return setup;
    }
    this.deps.emit({ kind: "login-finished", ok: true });
    return this.status();
  }

  /** Points git's github.com credentials at `gh`; only run on the person's say-so when a helper already exists. */
  async setupGit(): Promise<{ success: true } | { success: false; error: string }> {
    if (this.disabled) return DISABLED;
    const setup = await this.deps.runGh(["auth", "setup-git"], { timeoutMs: GH_QUICK_TIMEOUT_MS });
    if (setup.code !== 0) {
      log.warn("gh auth setup-git failed", { code: setup.code });
      return { success: false, error: "Signed in, but git credentials could not be set up" };
    }
    return { success: true };
  }

  /** The first github.com credential helper in git config that is not `gh`, if any. */
  private async foreignGithubCredentialHelper(): Promise<string | undefined> {
    if (!this.deps.runGit) return undefined;
    const result = await this.deps.runGit([
      "config",
      "--get-regexp",
      String.raw`^credential\.(https://github\.com\.)?helper$`,
    ]);
    if (result.code !== 0) return undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      const [key, ...rest] = line.trim().split(/\s+/);
      const value = rest.join(" ");
      if (!key || !value) continue;
      if (/\bgh\b.*auth git-credential|gh auth git-credential/.test(value)) continue;
      return value;
    }
    return undefined;
  }

  cancelLogin(): void {
    this.loginProcess?.kill();
    this.loginProcess = null;
  }

  async pickFolder(defaultPath?: string): Promise<string | undefined> {
    if (this.disabled) return undefined;
    const start = resolveCloneRoot(defaultPath ?? "", this.home, this.platform) ?? this.home;
    return this.deps.pickFolder(start);
  }

  async list(request: { owner: string; root: string }): Promise<OrgProjectsListResult> {
    if (this.disabled) return DISABLED;
    if (!OWNER_PATTERN.test(request.owner)) return { success: false, error: "invalid-owner" };
    const root = resolveCloneRoot(request.root, this.home, this.platform);
    if (!root) return { success: false, error: "invalid-root" };
    const result = await this.deps.runGh(
      [
        "api",
        "--paginate",
        "user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed",
        "--jq",
        ".[] | {name, owner: {login: .owner.login}, private, archived, disabled, description, size, pushed_at, permissions: {pull: .permissions.pull}}",
      ],
      { timeoutMs: GH_LIST_TIMEOUT_MS },
    );
    if (result.missing) return { success: false, error: "gh-missing" };
    if (result.code !== 0) return { success: false, error: "gh-list-failed" };
    const records = parseRepoListing(result.stdout, request.owner);
    const known = await this.knownFolders();
    const repos: OrgProjectRepo[] = [];
    for (const record of records) {
      // eslint-disable-next-line no-await-in-loop -- one cheap git read per repo, kept sequential
      const state = await this.repoState(record, root, known);
      repos.push({
        name: record.name,
        fullName: record.fullName,
        private: record.private,
        description: record.description,
        sizeKb: record.sizeKb,
        pushedAt: record.pushedAt,
        state,
      });
    }
    const ssoUrl = repos.length === 0 ? await this.probeSsoUrl(request.owner) : undefined;
    return { success: true, owner: request.owner, root, repos, ...(ssoUrl ? { ssoUrl } : {}) };
  }

  /** The SAML SSO authorization link `gh` receives in the `X-GitHub-SSO` header, or the org's SSO page when only partial results were flagged. */
  private async probeSsoUrl(owner: string): Promise<string | undefined> {
    const probe = await this.deps.runGh(
      [
        "api",
        "--include",
        "user/repos?per_page=1&affiliation=owner,collaborator,organization_member",
      ],
      { timeoutMs: GH_QUICK_TIMEOUT_MS },
    );
    return parseSsoUrl(probe.stdout + "\n" + probe.stderr, owner);
  }

  private async knownFolders(): Promise<Array<{ name: string; path: string; repo?: string }>> {
    const known: Array<{ name: string; path: string; repo?: string }> = [];
    for (const workspace of this.deps.listWorkspaces()) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the number of workspaces
      const origin = await this.deps.readOrigin(workspace.path);
      known.push({ name: workspace.name, path: workspace.path, repo: origin.repo });
    }
    return known;
  }

  private async repoState(
    record: GhRepoRecord,
    root: string,
    known: Array<{ name: string; path: string; repo?: string }>,
  ): Promise<OrgProjectRepo["state"]> {
    const wanted = record.fullName.toLowerCase();
    const target = path.join(root, record.name);
    const workspace = known.find((entry) => entry.repo === wanted);
    if (workspace) return { kind: "cloned", path: workspace.path, workspaceName: workspace.name };
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat) return { kind: "not-cloned" };
    if (!stat.isDirectory()) {
      return { kind: "conflict", path: target, reason: "A file with this name is in the way" };
    }
    const origin = await this.deps.readOrigin(target);
    if (origin.repo === wanted) return { kind: "cloned", path: target };
    const entries = await fs.readdir(target).catch(() => [] as string[]);
    if (entries.length === 0) return { kind: "not-cloned" };
    return {
      kind: "conflict",
      path: target,
      reason: origin.repo
        ? `Folder already holds ${origin.repo}`
        : "Folder exists and is not this repository",
    };
  }

  async clone(request: OrgProjectsCloneRequest): Promise<OrgProjectsCloneResult> {
    if (this.disabled) return DISABLED;
    if (this.cloneAbort) return { success: false, error: "A clone is already running" };
    if (!OWNER_PATTERN.test(request.owner)) return { success: false, error: "invalid-owner" };
    if (request.repos.length === 0 || !request.repos.every((repo) => REPO_PATTERN.test(repo))) {
      return { success: false, error: "invalid-repos" };
    }
    const root = resolveCloneRoot(request.root, this.home, this.platform);
    if (!root) return { success: false, error: "invalid-root" };

    const abort: { cancelled: boolean; current?: GhProcess } = { cancelled: false };
    this.cloneAbort = abort;
    const outcomes: OrgProjectCloneOutcome[] = [];
    try {
      const listing = await this.list({ owner: request.owner, root });
      if (!listing.success) return listing;
      const byName = new Map(listing.repos.map((repo) => [repo.name.toLowerCase(), repo]));
      await fs.mkdir(root, { recursive: true });
      for (const name of request.repos) {
        const repo = byName.get(name.toLowerCase());
        let outcome: OrgProjectCloneOutcome;
        if (abort.cancelled) outcome = { repo: name, status: "cancelled" };
        else if (!repo) {
          outcome = {
            repo: name,
            status: "failed",
            error: "You do not have access to this repository",
          };
        } else {
          // eslint-disable-next-line no-await-in-loop -- clones run one at a time to keep disk and network sane
          outcome = await this.cloneOne(repo, root, abort);
        }
        outcomes.push(outcome);
        this.deps.emit({ kind: "clone-finished", outcome });
      }
    } finally {
      this.cloneAbort = null;
    }
    return { success: true, outcomes };
  }

  cancelClone(): void {
    if (!this.cloneAbort) return;
    this.cloneAbort.cancelled = true;
    this.cloneAbort.current?.kill();
  }

  private async cloneOne(
    repo: OrgProjectRepo,
    root: string,
    abort: { cancelled: boolean; current?: GhProcess },
  ): Promise<OrgProjectCloneOutcome> {
    const target = path.join(root, repo.name);
    let status: OrgProjectCloneOutcome["status"] = "registered";
    if (repo.state.kind === "conflict") {
      return { repo: repo.name, status: "failed", path: target, error: repo.state.reason };
    }
    let folder = repo.state.kind === "cloned" ? repo.state.path : target;
    if (repo.state.kind === "not-cloned") {
      const cloned = await this.runClone(repo, target, abort);
      if (cloned.kind !== "ok") {
        return {
          repo: repo.name,
          status: cloned.kind === "cancelled" ? "cancelled" : "failed",
          path: target,
          ...(cloned.kind === "error" ? { error: cloned.message } : {}),
        };
      }
      status = "cloned";
      folder = target;
    }
    const existingName = repo.state.kind === "cloned" ? repo.state.workspaceName : undefined;
    try {
      const workspace = existingName
        ? { name: existingName, path: folder }
        : await this.registerUnderFreeName(repo, folder);
      const orgMapped = await this.deps.isOrgMapped(workspace.name);
      return {
        repo: repo.name,
        status,
        path: workspace.path,
        workspaceName: workspace.name,
        ...(orgMapped === undefined ? {} : { orgMapped }),
      };
    } catch (error) {
      log.warn("Workspace registration failed", { repo: repo.name });
      return {
        repo: repo.name,
        status: "failed",
        path: folder,
        error: error instanceof Error ? error.message : "Could not add the workspace",
      };
    }
  }

  private registerUnderFreeName(
    repo: OrgProjectRepo,
    folder: string,
  ): Promise<{ name: string; path: string }> {
    const taken = new Set(this.deps.listWorkspaces().map((w) => w.name.toLowerCase()));
    const owner = repo.fullName.split("/")[0];
    const name = [
      repo.name,
      `${owner}-${repo.name}`,
      `${owner}-${repo.name}-${Date.now().toString(36)}`,
    ].find((candidate) => !validateWorkspaceName(candidate) && !taken.has(candidate.toLowerCase()));
    return this.deps.registerWorkspace(name ?? repo.name, folder);
  }

  private async runClone(
    repo: OrgProjectRepo,
    target: string,
    abort: { cancelled: boolean; current?: GhProcess },
  ): Promise<{ kind: "ok" } | { kind: "cancelled" } | { kind: "error"; message: string }> {
    const emitProgress = (chunk: string) => {
      const progress = parseCloneProgress(chunk);
      if (progress) this.deps.emit({ kind: "clone-progress", repo: repo.name, ...progress });
    };
    const before = await fs.lstat(target).catch(() => undefined);
    if (before && (!before.isDirectory() || (await fs.readdir(target)).length > 0)) {
      return { kind: "error", message: "Something already exists at the target folder" };
    }
    const createdTarget = !before;
    this.deps.emit({ kind: "clone-progress", repo: repo.name, phase: "Starting" });
    const handle = this.deps.spawnGh(
      ["repo", "clone", repo.fullName, target, "--", "--filter=blob:none", "--progress"],
      { timeoutMs: 60 * 60_000, onStdout: emitProgress, onStderr: emitProgress },
    );
    abort.current = handle;
    const finished = await handle.done;
    abort.current = undefined;
    if (finished.code === 0 && !abort.cancelled) return { kind: "ok" };
    if (createdTarget) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    if (abort.cancelled) return { kind: "cancelled" };
    return {
      kind: "error",
      message: finished.missing ? "GitHub CLI not found" : "Clone failed; try again",
    };
  }
}

const run = (
  args: string[],
  timeoutMs: number,
  platform: NodeJS.Platform,
  command = "gh",
): Promise<GhRunResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PATH: ghEnvPath(platform), GH_PROMPT_DISABLED: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = "code" in error ? error.code : undefined;
          return resolve({
            code: typeof code === "number" ? code : 1,
            stdout: stdout,
            stderr: stderr,
            missing: code === "ENOENT",
          });
        }
        resolve({ code: 0, stdout: stdout, stderr: stderr });
      },
    );
  });

/** Real `gh` process adapters; the token stays inside `gh` and the git credential helper it installs. */
const GROUP_EXIT_WAIT_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops `gh` and the `git` it started: the whole process group on POSIX, `taskkill /T /F` on Windows. */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Real `gh` process adapters; the token stays inside `gh` and the git credential helper it installs. */
export function createGhRunners(
  platform: NodeJS.Platform = process.platform,
): Pick<OrgProjectsDeps, "runGh" | "spawnGh" | "runGit"> {
  return {
    runGh: (args, { timeoutMs }) => run(args, timeoutMs, platform),
    runGit: (args) => run(args, GH_QUICK_TIMEOUT_MS, platform, "git"),
    spawnGh: (args, options) => {
      const child = spawn("gh", args, {
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: ghEnvPath(platform), ...options.env },
      });
      child.stdout.setEncoding("utf8").on("data", options.onStdout);
      child.stderr.setEncoding("utf8").on("data", options.onStderr);
      const kill = () => {
        if (child.pid !== undefined) killProcessTree(child.pid, platform);
      };
      const timer = setTimeout(kill, options.timeoutMs);
      const done = new Promise<{ code: number | null; missing?: boolean }>((resolve) => {
        child.on("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          resolve({ code: null, missing: error.code === "ENOENT" });
        });
        child.on("close", async (code) => {
          clearTimeout(timer);
          if (platform !== "win32" && child.pid !== undefined) {
            const deadline = Date.now() + GROUP_EXIT_WAIT_MS;
            while (groupAlive(child.pid) && Date.now() < deadline) {
              // eslint-disable-next-line no-await-in-loop -- poll until the group has exited
              await sleep(50);
            }
          }
          resolve({ code });
        });
      });
      return {
        kill,
        done,
        write: (text) => {
          child.stdin.on("error", () => {});
          child.stdin.write(text);
        },
      };
    },
  };
}
