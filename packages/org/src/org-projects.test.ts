import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrgProjectsEvent } from "../../../common/marshal-ipc-contract";
import {
  OrgProjects,
  createGhRunners,
  parseSsoUrl,
  ghInstallHint,
  orderRepos,
  parseCloneProgress,
  parseDeviceCode,
  parseRepoListing,
  resolveCloneRoot,
  type GhProcess,
  type GhRunResult,
  type OrgProjectsDeps,
} from "./org-projects";

const repoLine = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name,
    owner: { login: "zyg-edge" },
    private: true,
    archived: false,
    description: `${name} repo`,
    size: 10,
    pushed_at: "2026-11-01T00:00:00Z",
    permissions: { pull: true },
    ...extra,
  });

describe("parseRepoListing", () => {
  it("keeps accessible, unarchived repos of the owner and drops the rest", () => {
    const stdout = [
      repoLine("zyg"),
      repoLine("old", { archived: true }),
      repoLine("hidden", { permissions: { pull: false } }),
      JSON.stringify({ name: "other", owner: { login: "someone" } }),
      "not json",
    ].join("\n");
    const repos = parseRepoListing(stdout, "zyg-edge");
    expect(repos.map((repo) => repo.fullName)).toEqual(["zyg-edge/zyg"]);
  });

  it("accepts arrays and rejects names that could escape the clone folder", () => {
    const stdout = `[${repoLine("a")},${repoLine("..")},${repoLine("b/c")}]`;
    expect(parseRepoListing(stdout, "zyg-edge").map((repo) => repo.name)).toEqual(["a"]);
  });
});

describe("orderRepos", () => {
  it("puts preselected repos first in manifest order", () => {
    const ordered = orderRepos([{ name: "b" }, { name: "zyg" }, { name: "a" }], ["zyg"]);
    expect(ordered.map((repo) => repo.name)).toEqual(["zyg", "a", "b"]);
  });
});

describe("resolveCloneRoot", () => {
  it("expands ~ and keeps spaces", () => {
    expect(resolveCloneRoot("~/My Projects/zyg-edge", "/Users/a b", "darwin")).toBe(
      "/Users/a b/My Projects/zyg-edge",
    );
    expect(resolveCloneRoot("~", "/home/me", "linux")).toBe("/home/me");
  });

  it("uses Windows separators on win32 (not run on Windows in this lane)", () => {
    expect(resolveCloneRoot("~\\Projects\\zyg-edge", "C:\\Users\\me", "win32")).toBe(
      "C:\\Users\\me\\Projects\\zyg-edge",
    );
    expect(resolveCloneRoot("D:\\code", "C:\\Users\\me", "win32")).toBe("D:\\code");
  });

  it("rejects empty and relative paths", () => {
    expect(resolveCloneRoot("  ", "/h", "linux")).toBeNull();
    expect(resolveCloneRoot("projects", "/h", "linux")).toBeNull();
    expect(resolveCloneRoot("./x", "/h", "linux")).toBeNull();
  });
});

describe("parseSsoUrl", () => {
  it("prefers the header URL and falls back to the org SSO page", () => {
    expect(
      parseSsoUrl(
        "X-Github-Sso: required; url=https://github.com/orgs/o/sso?authorization_request=x",
        "o",
      ),
    ).toBe("https://github.com/orgs/o/sso?authorization_request=x");
    expect(parseSsoUrl("X-GitHub-SSO: partial-results; organizations=1", "o")).toBe(
      "https://github.com/orgs/o/sso",
    );
    expect(parseSsoUrl("HTTP/2 200", "o")).toBeUndefined();
  });
});

describe("gh output parsers", () => {
  it("reads the device code and URL", () => {
    expect(
      parseDeviceCode(
        "! First copy your one-time code: E2E3-E420\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
      ),
    ).toEqual({ code: "E2E3-E420", url: "https://github.com/login/device" });
    expect(parseDeviceCode("nothing yet")).toBeNull();
  });

  it("reads the latest git progress line", () => {
    expect(
      parseCloneProgress("Receiving objects:  12% (1/8)\rReceiving objects:  45% (4/8)\r"),
    ).toEqual({
      phase: "Receiving objects",
      percent: 45,
    });
    expect(parseCloneProgress("Cloning into 'x'...\n")).toEqual({ phase: "Cloning into" });
    expect(parseCloneProgress("garbage")).toBeNull();
  });

  it("suggests a platform install command", () => {
    expect(ghInstallHint("darwin")).toBe("brew install gh");
    expect(ghInstallHint("win32")).toContain("winget");
  });
});

describe("OrgProjects", () => {
  let tmp: string;
  let events: OrgProjectsEvent[];
  let registered: Array<{ name: string; path: string }>;
  let origins: Record<string, string | undefined>;
  let workspaces: Array<{ name: string; path: string }>;
  let cloneExit: number;
  let spawned: string[][];
  let authed: boolean;
  let ghMissing: boolean;
  let cloneGate: Promise<void> | undefined;
  let emptyListing: boolean;
  let ssoHeader: string;
  let gitHelpers: string;
  let setupGitCalls: number;
  let enabled: boolean;

  const listingStdout = () => [repoLine("zyg"), repoLine("tools"), repoLine("docs")].join("\n");

  const buildDeps = (): OrgProjectsDeps => ({
    runGh: async (args): Promise<GhRunResult> => {
      if (ghMissing) return { code: 1, stdout: "", stderr: "", missing: true };
      if (args[0] === "--version") return { code: 0, stdout: "gh 2", stderr: "" };
      if (args[0] === "api" && args[1] === "user") {
        return authed
          ? { code: 0, stdout: "omer\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "not logged in" };
      }
      if (args[0] === "api" && args.includes("--include")) {
        return { code: 0, stdout: `HTTP/2.0 200 OK\n${ssoHeader}\n\n[]`, stderr: "" };
      }
      if (args[0] === "api") {
        return { code: 0, stdout: emptyListing ? "" : listingStdout(), stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "setup-git") {
        setupGitCalls++;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    spawnGh: (args, options): GhProcess => {
      spawned.push(args);
      if (args[0] === "auth") {
        options.onStderr("! First copy your one-time code: ABCD-1234\n");
        return {
          kill: () => {},
          write: () => {},
          done: Promise.resolve({ code: 0 }).then((result) => {
            authed = true;
            return result;
          }),
        };
      }
      const target = args[3];
      const done = (async () => {
        options.onStderr("Receiving objects:  50% (1/2)\r");
        await cloneGate;
        if (cloneExit === 0) {
          await fs.mkdir(target, { recursive: true });
          origins[target] = "zyg-edge/" + path.basename(target);
        }
        return { code: cloneExit };
      })();
      return { kill: () => {}, write: () => {}, done };
    },
    runGit: async () => ({ code: gitHelpers ? 0 : 1, stdout: gitHelpers, stderr: "" }),
    isEnabled: () => enabled,
    readOrigin: async (folder) => ({ repo: origins[folder] }),
    listWorkspaces: () => workspaces,
    registerWorkspace: async (name, folder) => {
      registered.push({ name, path: folder });
      workspaces.push({ name, path: folder });
      return { name, path: folder };
    },
    isOrgMapped: async () => true,
    openExternal: vi.fn<(url: string) => boolean>(() => true),
    pickFolder: async () => undefined,
    emit: (event) => events.push(event),
    homeDir: () => tmp,
    platform: "darwin",
  });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "org-projects-"));
    events = [];
    registered = [];
    origins = {};
    workspaces = [];
    cloneExit = 0;
    spawned = [];
    authed = true;
    ghMissing = false;
    cloneGate = undefined;
    emptyListing = false;
    ssoHeader = "";
    gitHelpers = "";
    setupGitCalls = 0;
    enabled = true;
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("reports missing, unauthed and ready states", async () => {
    const projects = new OrgProjects(buildDeps());
    ghMissing = true;
    expect(await projects.status()).toMatchObject({
      gh: "missing",
      installHint: "brew install gh",
    });
    ghMissing = false;
    authed = false;
    expect(await projects.status()).toEqual({ success: true, gh: "unauthed" });
    authed = true;
    expect(await projects.status()).toEqual({ success: true, gh: "ready", login: "omer" });
  });

  it("signs in through the device flow and opens the browser itself", async () => {
    authed = false;
    const deps = buildDeps();
    const projects = new OrgProjects(deps);
    const result = await projects.login();
    expect(result).toEqual({ success: true, gh: "ready", login: "omer" });
    expect(events).toContainEqual({
      kind: "device-code",
      code: "ABCD-1234",
      url: "https://github.com/login/device",
    });
    expect(deps.openExternal).toHaveBeenCalledWith("https://github.com/login/device");
    expect(events.at(-1)).toEqual({ kind: "login-finished", ok: true });
  });

  it("lists repos and detects existing clones by origin", async () => {
    const root = path.join(tmp, "zyg-edge");
    await fs.mkdir(path.join(root, "tools"), { recursive: true });
    origins[path.join(root, "tools")] = "zyg-edge/tools";
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "x.txt"), "x");
    workspaces.push({ name: "elsewhere", path: "/somewhere/zyg" });
    origins["/somewhere/zyg"] = "zyg-edge/zyg";

    const listing = await new OrgProjects(buildDeps()).list({ owner: "zyg-edge", root });
    if (!listing.success) throw new Error("expected success");
    const byName = Object.fromEntries(listing.repos.map((repo) => [repo.name, repo.state]));
    expect(byName.zyg).toEqual({
      kind: "cloned",
      path: "/somewhere/zyg",
      workspaceName: "elsewhere",
    });
    expect(byName.tools).toEqual({ kind: "cloned", path: path.join(root, "tools") });
    expect(byName.docs).toMatchObject({ kind: "conflict" });
  });

  it("clones missing repos with a partial filter and registers them", async () => {
    const root = path.join(tmp, "My Projects");
    const projects = new OrgProjects(buildDeps());
    const result = await projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    expect(result).toMatchObject({
      success: true,
      outcomes: [{ repo: "tools", status: "cloned", orgMapped: true }],
    });
    expect(spawned[0]).toEqual([
      "repo",
      "clone",
      "zyg-edge/tools",
      path.join(root, "tools"),
      "--",
      "--filter=blob:none",
      "--progress",
    ]);
    expect(registered).toEqual([{ name: "tools", path: path.join(root, "tools") }]);
    expect(events).toContainEqual({
      kind: "clone-progress",
      repo: "tools",
      phase: "Receiving objects",
      percent: 50,
    });
  });

  it("registers an already-cloned repo without cloning again", async () => {
    const root = path.join(tmp, "zyg-edge");
    await fs.mkdir(path.join(root, "tools"), { recursive: true });
    origins[path.join(root, "tools")] = "zyg-edge/tools";
    const result = await new OrgProjects(buildDeps()).clone({
      owner: "zyg-edge",
      repos: ["tools"],
      root,
    });
    expect(result).toMatchObject({ success: true, outcomes: [{ status: "registered" }] });
    expect(spawned).toHaveLength(0);
    expect(registered).toHaveLength(1);
  });

  it("does not re-register a repo that already is a workspace", async () => {
    workspaces.push({ name: "zyg", path: "/code/zyg" });
    origins["/code/zyg"] = "zyg-edge/zyg";
    const result = await new OrgProjects(buildDeps()).clone({
      owner: "zyg-edge",
      repos: ["zyg"],
      root: path.join(tmp, "r"),
    });
    expect(result).toMatchObject({
      success: true,
      outcomes: [{ status: "registered", workspaceName: "zyg" }],
    });
    expect(registered).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it("reports a failed clone, leaves no partial folder, and succeeds on retry", async () => {
    const root = path.join(tmp, "r");
    const projects = new OrgProjects(buildDeps());
    cloneExit = 1;
    const first = await projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    expect(first).toMatchObject({ success: true, outcomes: [{ status: "failed" }] });
    expect(registered).toHaveLength(0);
    cloneExit = 0;
    const second = await projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    expect(second).toMatchObject({ success: true, outcomes: [{ status: "cloned" }] });
  });

  it("rejects a second clone started while the first is still listing or cloning", async () => {
    const root = path.join(tmp, "r");
    let release: () => void = () => {};
    cloneGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const projects = new OrgProjects(buildDeps());
    const first = projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    const second = await projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    expect(second).toEqual({ success: false, error: "A clone is already running" });
    release();
    expect(await first).toMatchObject({ success: true, outcomes: [{ status: "cloned" }] });
    expect(await fs.stat(path.join(root, "tools"))).toBeTruthy();
    expect(spawned).toHaveLength(1);
  });

  it("treats a regular file at the target as a conflict and never deletes it", async () => {
    const root = path.join(tmp, "r");
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "tools");
    await fs.writeFile(file, "mine");
    const projects = new OrgProjects(buildDeps());
    const listing = await projects.list({ owner: "zyg-edge", root });
    if (!listing.success) throw new Error("expected success");
    expect(listing.repos.find((repo) => repo.name === "tools")?.state).toMatchObject({
      kind: "conflict",
    });
    const result = await projects.clone({ owner: "zyg-edge", repos: ["tools"], root });
    expect(result).toMatchObject({ success: true, outcomes: [{ status: "failed" }] });
    expect(await fs.readFile(file, "utf8")).toBe("mine");
    expect(spawned).toHaveLength(0);
  });

  it("keeps a pre-existing empty folder when its clone fails", async () => {
    const root = path.join(tmp, "r");
    await fs.mkdir(path.join(root, "tools"), { recursive: true });
    cloneExit = 1;
    const result = await new OrgProjects(buildDeps()).clone({
      owner: "zyg-edge",
      repos: ["tools"],
      root,
    });
    expect(result).toMatchObject({ success: true, outcomes: [{ status: "failed" }] });
    expect((await fs.stat(path.join(root, "tools"))).isDirectory()).toBe(true);
  });

  it("explains an empty listing with the SSO authorization link", async () => {
    emptyListing = true;
    ssoHeader =
      "X-GitHub-SSO: required; url=https://github.com/orgs/zyg-edge/sso?authorization_request=abc";
    const listing = await new OrgProjects(buildDeps()).list({
      owner: "zyg-edge",
      root: path.join(tmp, "r"),
    });
    expect(listing).toMatchObject({
      success: true,
      repos: [],
      ssoUrl: "https://github.com/orgs/zyg-edge/sso?authorization_request=abc",
    });
  });

  it("leaves another github.com credential helper alone and says so", async () => {
    authed = false;
    gitHelpers = "credential.https://github.com.helper osxkeychain";
    const result = await new OrgProjects(buildDeps()).login();
    expect(setupGitCalls).toBe(0);
    expect(result).toMatchObject({
      success: true,
      gh: "ready",
      credentialNotice: expect.stringContaining("osxkeychain"),
    });
  });

  it("sets up git credentials when none exist or only gh's own is present", async () => {
    authed = false;
    await new OrgProjects(buildDeps()).login();
    expect(setupGitCalls).toBe(1);
    authed = false;
    gitHelpers = "credential.https://github.com.helper !/opt/homebrew/bin/gh auth git-credential";
    await new OrgProjects(buildDeps()).login();
    expect(setupGitCalls).toBe(2);
  });

  it("refuses every call while onboarding is unavailable", async () => {
    enabled = false;
    const projects = new OrgProjects(buildDeps());
    const root = path.join(tmp, "r");
    expect(await projects.status()).toEqual({ success: false, error: "disabled" });
    expect(await projects.login()).toEqual({ success: false, error: "disabled" });
    expect(await projects.list({ owner: "zyg-edge", root })).toEqual({
      success: false,
      error: "disabled",
    });
    expect(await projects.clone({ owner: "zyg-edge", repos: ["tools"], root })).toEqual({
      success: false,
      error: "disabled",
    });
    expect(await projects.setupGit()).toEqual({ success: false, error: "disabled" });
  });

  it("fails repos the person cannot access and rejects bad input", async () => {
    const projects = new OrgProjects(buildDeps());
    const root = path.join(tmp, "r");
    expect(await projects.clone({ owner: "zyg-edge", repos: ["secret"], root })).toMatchObject({
      outcomes: [{ status: "failed" }],
    });
    expect(await projects.clone({ owner: "zyg-edge", repos: ["../x"], root })).toEqual({
      success: false,
      error: "invalid-repos",
    });
    expect(await projects.clone({ owner: "bad owner", repos: ["a"], root })).toEqual({
      success: false,
      error: "invalid-owner",
    });
    expect(await projects.clone({ owner: "zyg-edge", repos: ["a"], root: "relative" })).toEqual({
      success: false,
      error: "invalid-root",
    });
  });
});

describe.skipIf(process.platform === "win32")("OrgProjects with a stubbed gh executable", () => {
  let tmp: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "org-projects-gh-"));
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin);
    const listing = [repoLine("zyg"), repoLine("tools")].join("\n");
    const script = `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "gh version stub";;
  "api user") echo "stub-user";;
  "api --paginate") cat <<'JSON'
${listing}
JSON
  ;;
  "repo clone")
    mkdir -p "$4"
    git -C "$4" init -q
    git -C "$4" remote add origin "https://github.com/$3.git"
    echo "Receiving objects: 100% (1/1)" >&2
  ;;
  *) exit 1;;
esac
`;
    await fs.writeFile(path.join(bin, "gh"), script, { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("lists, clones into a folder with spaces, and detects the clone afterwards", async () => {
    const events: OrgProjectsEvent[] = [];
    const registered: Array<{ name: string; path: string }> = [];
    const projects = new OrgProjects({
      ...createGhRunners(),
      readOrigin: async (folder) => {
        const { readGitOrigin } = await import("./org-workspace-links");
        return readGitOrigin(folder);
      },
      listWorkspaces: () => registered,
      registerWorkspace: async (name, folder) => {
        registered.push({ name, path: folder });
        return { name, path: folder };
      },
      isOrgMapped: async () => undefined,
      openExternal: () => true,
      pickFolder: async () => undefined,
      emit: (event) => events.push(event),
      homeDir: () => tmp,
    });

    expect(await projects.status()).toEqual({ success: true, gh: "ready", login: "stub-user" });
    const root = "~/My Projects/zyg-edge";
    const result = await projects.clone({ owner: "zyg-edge", repos: ["zyg"], root });
    const target = path.join(tmp, "My Projects", "zyg-edge", "zyg");
    expect(result).toMatchObject({
      success: true,
      outcomes: [{ repo: "zyg", status: "cloned", path: target }],
    });
    expect(events).toContainEqual({
      kind: "clone-progress",
      repo: "zyg",
      phase: "Receiving objects",
      percent: 100,
    });

    const listing = await projects.list({ owner: "zyg-edge", root });
    if (!listing.success) throw new Error("expected success");
    expect(listing.repos.find((repo) => repo.name === "zyg")?.state).toMatchObject({
      kind: "cloned",
    });
    expect(listing.repos.find((repo) => repo.name === "tools")?.state).toEqual({
      kind: "not-cloned",
    });
  });

  it("cancel kills gh and the git it started before cleaning up", async () => {
    const bin = path.join(tmp, "bin");
    const pidFile = path.join(tmp, "git.pid");
    await fs.writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  "--version "*) echo stub;;
  "api user") echo u;;
  "api --paginate") echo '${repoLine("zyg")}';;
  "repo clone")
    mkdir -p "$4"
    sh -c 'echo $$ > "${pidFile}"; exec sleep 60' &
    wait;;
esac
`,
      { mode: 0o755 },
    );
    const projects = new OrgProjects({
      ...createGhRunners(),
      readOrigin: async () => ({}),
      listWorkspaces: () => [],
      registerWorkspace: async (name, folder) => ({ name, path: folder }),
      isOrgMapped: async () => undefined,
      openExternal: () => true,
      pickFolder: async () => undefined,
      emit: () => {},
      homeDir: () => tmp,
    });
    const root = path.join(tmp, "out");
    const running = projects.clone({ owner: "zyg-edge", repos: ["zyg"], root });
    await vi.waitFor(() => fs.stat(pidFile), { timeout: 5000, interval: 50 });
    const childPid = Number(await fs.readFile(pidFile, "utf8"));
    projects.cancelClone();
    expect(await running).toMatchObject({ success: true, outcomes: [{ status: "cancelled" }] });
    expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
    await expect(fs.stat(path.join(root, "zyg"))).rejects.toThrow(/ENOENT/);
  });
});
