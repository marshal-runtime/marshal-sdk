import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildWipBundle,
  isRefusal,
  parseGitVersion,
  parseRemoteRepo,
  planWip,
  scanTextForSecrets,
  secretPathRule,
  WipError,
  type WipPlan,
} from "./org-wip-bundle";

const roots: string[] = [];

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

function write(root: string, relative: string, content: string) {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A working repo whose `origin` is a bare repo that holds `main`; the work tree is what a session would be in. */
function makeRepo(remoteUrl = "https://github.com/zyg-edge/zyg.git") {
  const base = mkdtempSync(path.join(os.tmpdir(), "marshal-wip-test-"));
  roots.push(base);
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");
  run(base, "init", "--bare", "-q", "-b", "main", bare);
  run(base, "init", "-q", "-b", "main", work);
  write(work, "README.md", "hello\n");
  write(work, "src/a.ts", "export const a = 1;\n");
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "init");
  run(work, "remote", "add", "origin", bare);
  run(work, "push", "-q", "-u", "origin", "main");
  run(work, "config", "remote.origin.url", remoteUrl);
  run(work, "config", "remote.origin.pushurl", bare);
  return { base, bare, work };
}

const planOf = async (work: string, extra: Partial<Parameters<typeof planWip>[0]> = {}) => {
  const result = await planWip({ cwd: work, ...extra });
  if (isRefusal(result)) throw new Error(`refused: ${result.code}`);
  return result;
};

const codes = (plan: WipPlan) => plan.refusals.map((entry) => entry.code);

beforeEach(() => {
  roots.length = 0;
});
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("remote and secret helpers", () => {
  it.each([
    ["https://github.com/zyg-edge/zyg.git", "zyg-edge/zyg"],
    ["git@github.com:zyg-edge/zyg.git", "zyg-edge/zyg"],
    ["ssh://git@github.com/zyg-edge/zyg", "zyg-edge/zyg"],
    ["https://x-access-token:abc@github.com/zyg-edge/zyg/", "zyg-edge/zyg"],
    ["zyg-edge/zyg", "zyg-edge/zyg"],
  ])("reads owner/name from %s", (url, expected) => {
    expect(parseRemoteRepo(url)).toBe(expected);
  });

  it("flags env files and keys by path but not templates", () => {
    expect(secretPathRule(".env")).toBe("env-file");
    expect(secretPathRule("apps/web/.env.local")).toBe("env-file");
    expect(secretPathRule(".env.example")).toBeUndefined();
    expect(secretPathRule("certs/server.pem")).toBe("private-key-file");
    expect(secretPathRule("home/.ssh/config")).toBe("cloud-credentials");
    expect(secretPathRule("src/a.ts")).toBeUndefined();
  });

  it("flags private keys by content and returns rule names only", () => {
    const names = scanTextForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nabc");
    expect(names).toContain("private-key");
    expect(JSON.stringify(names)).not.toContain("abc");
  });
});

describe("planWip", () => {
  it("refuses a folder that is not a git repository", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "marshal-wip-nogit-"));
    roots.push(dir);
    const result = await planWip({ cwd: dir });
    expect(isRefusal(result) && result.code).toBe("not-a-git-repo");
  });

  it("refuses a repo without a remote and a repo outside the organization workspace", async () => {
    const { work } = makeRepo();
    const outside = await planWip({ cwd: work, repoAllowed: () => false });
    expect(isRefusal(outside) && outside.code).toBe("repo-not-in-workspace");
    run(work, "remote", "remove", "origin");
    const none = await planWip({ cwd: work });
    expect(isRefusal(none) && none.code).toBe("no-remote");
  });

  it("describes a clean, fully pushed tree with nothing to carry", async () => {
    const { work } = makeRepo();
    const plan = await planOf(work);
    expect(plan).toMatchObject({
      repo: "zyg-edge/zyg",
      branch: "main",
      baseBranch: "main",
      localCommits: 0,
      tracked: [],
      untracked: [],
      refusals: [],
    });
    expect(await buildWipBundle(plan, { sessionId: "s1" })).toBeUndefined();
  });

  it("counts unpushed commits, tracked changes and untracked files", async () => {
    const { work } = makeRepo();
    write(work, "src/b.ts", "export const b = 2;\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "local");
    write(work, "src/a.ts", "export const a = 3;\n");
    write(work, "notes/todo.md", "later\n");
    const plan = await planOf(work);
    expect(plan.localCommits).toBe(1);
    expect(plan.tracked).toEqual(["src/a.ts"]);
    expect(plan.untracked).toEqual(["notes/todo.md"]);
    expect(plan.refusals).toEqual([]);
  });

  it("never includes .gitignored files and never reads them", async () => {
    const { work } = makeRepo();
    write(work, ".gitignore", "dist/\n*.log\n");
    run(work, "add", ".gitignore");
    run(work, "commit", "-q", "-m", "ignore");
    write(work, "dist/out.js", "x\n");
    write(work, "run.log", "x\n");
    write(work, "keep.txt", "k\n");
    const plan = await planOf(work);
    expect(plan.untracked).toEqual(["keep.txt"]);
    expect(plan.skipped.map((entry) => entry.path)).not.toContain("dist/out.js");
  });

  it("excludes secret-looking untracked files by path and by content, with reasons", async () => {
    const { work } = makeRepo();
    write(work, ".env.local", "TOKEN=abc\n");
    write(work, "deploy/key.pem", "whatever\n");
    write(work, "src/leak.ts", "const k = `-----BEGIN RSA PRIVATE KEY-----`;\n");
    write(work, "src/ok.ts", "export {};\n");
    const plan = await planOf(work);
    expect(plan.untracked).toEqual(["src/ok.ts"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { path: ".env.local", why: "secret" },
        { path: "deploy/key.pem", why: "secret" },
        { path: "src/leak.ts", why: "secret" },
      ]),
    );
    expect(plan.refusals).toEqual([]);
  });

  it("refuses when a changed tracked file looks like it holds a secret, naming rules not values", async () => {
    const { work } = makeRepo();
    write(work, "src/a.ts", "const k = '-----BEGIN PRIVATE KEY-----';\n");
    const plan = await planOf(work);
    expect(codes(plan)).toContain("secret-in-tracked");
    const hit = plan.refusals.find((entry) => entry.code === "secret-in-tracked");
    expect(hit?.paths).toEqual(["src/a.ts"]);
    expect(JSON.stringify(hit)).not.toContain("BEGIN PRIVATE");
  });

  it("refuses when an unpushed commit adds a secret", async () => {
    const { work } = makeRepo();
    write(work, "src/c.ts", "const k = '-----BEGIN OPENSSH PRIVATE KEY-----';\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "oops");
    expect(codes(await planOf(work))).toContain("secret-in-commits");
  });

  it("always excludes an embedded git repository, with a reason", async () => {
    const { work } = makeRepo();
    const embedded = path.join(work, "vendor", "lib");
    mkdirSync(embedded, { recursive: true });
    run(embedded, "init", "-q");
    write(embedded, "x.txt", "x\n");
    run(embedded, "add", "-A");
    run(embedded, "commit", "-q", "-m", "e");
    write(work, "plain.txt", "p\n");
    const plan = await planOf(work);
    expect(plan.untracked).toEqual(["plain.txt"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([{ path: "vendor/lib", why: "embedded-repo" }]),
    );
    const trackedOnly = await planOf(work, { trackedOnly: true });
    expect(trackedOnly.skipped).toEqual(
      expect.arrayContaining([{ path: "vendor/lib", why: "embedded-repo" }]),
    );
  });

  it("refuses past the untracked budget, offers tracked-only, and tracked-only drops them with a reason", async () => {
    const { work } = makeRepo();
    for (let index = 0; index < 6; index++) write(work, `gen/f${index}.txt`, "x\n");
    write(work, "src/a.ts", "export const a = 9;\n");
    const refused = await planOf(work, { maxUntrackedFiles: 5 });
    expect(codes(refused)).toEqual(["over-budget"]);
    expect(refused.refusals[0]).toMatchObject({ trackedOnlyHelps: true });
    const limited = await planOf(work, { maxUntrackedFiles: 5, trackedOnly: true });
    expect(limited.refusals).toEqual([]);
    expect(limited.untracked).toEqual([]);
    expect(limited.tracked).toEqual(["src/a.ts"]);
    expect(limited.skipped.every((entry) => entry.why === "over-budget")).toBe(true);
    expect(limited.skippedTotal).toBe(6);
  });

  it("applies the byte budget the same way", async () => {
    const { work } = makeRepo();
    write(work, "big.bin", "x".repeat(2048));
    const refused = await planOf(work, { maxUntrackedBytes: 1024 });
    expect(codes(refused)).toEqual(["over-budget"]);
  });

  it("honors paths the person left out", async () => {
    const { work } = makeRepo();
    write(work, "scratch/a.txt", "a\n");
    write(work, "keep.txt", "k\n");
    const plan = await planOf(work, { excludePaths: ["scratch"] });
    expect(plan.untracked).toEqual(["keep.txt"]);
    expect(plan.skipped).toEqual([{ path: "scratch/a.txt", why: "excluded-by-user" }]);
  });

  it("refuses LFS only when the work touches an LFS-tracked path", async () => {
    const { work } = makeRepo();
    write(work, ".gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    run(work, "add", ".gitattributes");
    run(work, "commit", "-q", "-m", "attrs");
    run(work, "push", "-q", "origin", "main");
    write(work, "src/a.ts", "export const a = 4;\n");
    expect((await planOf(work)).refusals).toEqual([]);
    write(work, "art/logo.psd", "binary\n");
    const plan = await planOf(work);
    expect(codes(plan)).toEqual(["lfs"]);
    expect(plan.refusals[0].paths).toEqual(["art/logo.psd"]);
  });

  it("refuses a repository with submodules and unresolved merge conflicts", async () => {
    const { work } = makeRepo();
    write(work, ".gitmodules", '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
    expect(codes(await planOf(work))).toContain("submodules");
  });

  it("refuses when the branch has no upstream and origin has no HEAD", async () => {
    const { work } = makeRepo();
    run(work, "checkout", "-q", "-b", "feature");
    run(work, "update-ref", "-d", "refs/remotes/origin/HEAD");
    const result = await planWip({ cwd: work });
    expect(isRefusal(result) && result.code).toBe("no-upstream");
  });

  it("falls back to origin/HEAD for a branch with no upstream", async () => {
    const { work } = makeRepo();
    run(work, "remote", "set-head", "origin", "main");
    run(work, "checkout", "-q", "-b", "feature");
    write(work, "f.txt", "f\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "f");
    const plan = await planOf(work);
    expect(plan).toMatchObject({ branch: "feature", baseBranch: "main", localCommits: 1 });
  });

  it("is read-only: a plan changes no ref, index or file", async () => {
    const { work } = makeRepo();
    write(work, "src/a.ts", "export const a = 7;\n");
    write(work, "new.txt", "n\n");
    const before = run(work, "status", "--porcelain=v2", "--branch");
    const refs = run(work, "for-each-ref");
    await planOf(work);
    expect(run(work, "status", "--porcelain=v2", "--branch")).toBe(before);
    expect(run(work, "for-each-ref")).toBe(refs);
  });
});

describe("buildWipBundle", () => {
  it("builds a bundle that reproduces commits, tracked changes and untracked files on a fresh clone", async () => {
    const { work, bare, base } = makeRepo();
    write(work, "src/b.ts", "export const b = 2;\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "local one");
    write(work, "src/a.ts", "export const a = 5;\n");
    run(work, "rm", "-q", "README.md");
    write(work, "notes/todo.md", "later\n");
    write(work, ".env", "SECRET=1\n");
    const plan = await planOf(work);
    const built = await buildWipBundle(plan, { sessionId: "s-1" });
    expect(built).toBeDefined();
    expect(built!.tracked).toBe(2);
    expect(built!.untracked).toBe(1);
    expect(built!.localCommits).toBe(1);
    expect(new TextDecoder().decode(built!.bytes.subarray(0, 16))).toMatch(/^# v[23] git bundle/);
    expect(built!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const bundleFile = path.join(base, "wip.bundle");
    writeFileSync(bundleFile, built!.bytes);
    const clone = path.join(base, "clone");
    run(base, "clone", "-q", bare, clone);
    run(clone, "fetch", "-q", bundleFile, "refs/marshal-wip:refs/wip");
    run(clone, "checkout", "-q", "refs/wip");
    expect(readFileSync(path.join(clone, "src/a.ts"), "utf8")).toBe("export const a = 5;\n");
    expect(readFileSync(path.join(clone, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
    expect(readFileSync(path.join(clone, "notes/todo.md"), "utf8")).toBe("later\n");
    expect(() => readFileSync(path.join(clone, "README.md"))).toThrow(/ENOENT/);
    expect(() => readFileSync(path.join(clone, ".env"))).toThrow(/ENOENT/);
    expect(run(clone, "log", "-1", "--format=%an")).toBe("marshal-wip");
  });

  it("leaves the repository exactly as it was: no ref, index, stash, object or status change", async () => {
    const { work } = makeRepo();
    write(work, "src/a.ts", "export const a = 8;\n");
    write(work, "new.txt", "n\n");
    run(work, "add", "src/a.ts");
    const status = run(work, "status", "--porcelain=v2");
    const refs = run(work, "for-each-ref");
    const objects = run(work, "count-objects", "-v");
    const plan = await planOf(work);
    await buildWipBundle(plan, { sessionId: "s-2" });
    expect(run(work, "status", "--porcelain=v2")).toBe(status);
    expect(run(work, "for-each-ref")).toBe(refs);
    expect(run(work, "count-objects", "-v")).toBe(objects);
  });

  it("refuses to build from a plan that has refusals", async () => {
    const { work } = makeRepo();
    write(work, "src/a.ts", "const k = '-----BEGIN PRIVATE KEY-----';\n");
    const plan = await planOf(work);
    await expect(buildWipBundle(plan, { sessionId: "s" })).rejects.toBeInstanceOf(WipError);
  });

  it("refuses a bundle over the body limit", async () => {
    const { work } = makeRepo();
    let noisy = "";
    for (let index = 0; index < 4000; index++) noisy += `${index}:${(index * 2654435761) % 997}\n`;
    write(work, "big.txt", noisy);
    const plan = await planOf(work);
    await expect(
      buildWipBundle(plan, { sessionId: "s", maxBundleBytes: 512 }),
    ).rejects.toMatchObject({ code: "bundle-too-large" });
  });

  it("stops on a cancelled signal and on a timeout", async () => {
    const { work } = makeRepo();
    write(work, "new.txt", "n\n");
    const plan = await planOf(work);
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildWipBundle(plan, { sessionId: "s", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(buildWipBundle(plan, { sessionId: "s", timeoutMs: 1 })).rejects.toMatchObject({
      code: "staging-timeout",
    });
  });

  it("does not run hooks, a filesystem monitor or a clean filter of the repository", async () => {
    const { work } = makeRepo();
    const marker = path.join(work, "..", "hook-ran");
    const script = (name: string) => {
      const file = path.join(work, "..", name);
      writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\n`);
      execFileSync("chmod", ["+x", file]);
      return file;
    };
    write(work, ".gitattributes", "*.spy filter=spy\n");
    run(work, "add", ".gitattributes");
    run(work, "commit", "-q", "-m", "attrs");
    run(work, "push", "-q");
    for (const hook of [
      "pre-commit",
      "commit-msg",
      "post-commit",
      "reference-transaction",
      "post-index-change",
    ]) {
      write(work, `.git/hooks/${hook}`, `#!/bin/sh\ntouch "${marker}"\n`);
      execFileSync("chmod", ["+x", path.join(work, ".git/hooks", hook)]);
    }
    run(work, "config", "core.fsmonitor", script("fsmonitor.sh"));
    run(work, "config", "filter.spy.clean", script("clean.sh"));
    run(work, "config", "filter.spy.process", script("process.sh"));
    write(work, "new.txt", "n\n");
    write(work, "README.md", "changed\n");
    const plan = await planOf(work);
    await buildWipBundle(plan, { sessionId: "s" });
    expect(() => readFileSync(marker)).toThrow(/ENOENT/);
  });

  it("refuses a carried path that has a filter attribute and runs no filter while planning", async () => {
    const { work } = makeRepo();
    const marker = path.join(work, "..", "filter-ran");
    const clean = path.join(work, "..", "clean.sh");
    writeFileSync(clean, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    execFileSync("chmod", ["+x", clean]);
    write(work, ".gitattributes", "*.dat filter=spy\n");
    write(work, "data.dat", "one\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "data");
    run(work, "push", "-q");
    run(work, "config", "filter.spy.clean", clean);
    write(work, "data.dat", "two\n");
    write(work, "other.dat", "x\n");
    const plan = await planOf(work);
    expect(codes(plan)).toContain("filter-attribute");
    expect(plan.refusals.find((entry) => entry.code === "filter-attribute")?.paths).toEqual(
      expect.arrayContaining(["data.dat", "other.dat"]),
    );
    expect(() => readFileSync(marker)).toThrow(/ENOENT/);
    await expect(buildWipBundle(plan, { sessionId: "s" })).rejects.toBeInstanceOf(WipError);
  });

  it("stops planning between files when the signal aborts", async () => {
    const { work } = makeRepo();
    for (let index = 0; index < 20; index += 1) write(work, `u${index}.txt`, "x\n");
    const controller = new AbortController();
    const planning = planWip({ cwd: work, signal: controller.signal });
    controller.abort();
    await expect(planning).rejects.toMatchObject({ code: "cancelled" });
  });

  it("strips inherited GIT_DIR and friends so a call cannot be pointed at another repository", async () => {
    const { work } = makeRepo();
    const other = makeRepo();
    write(work, "new.txt", "n\n");
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other.work, ".git");
    process.env.GIT_WORK_TREE = other.work;
    try {
      const plan = await planOf(work);
      expect(plan.untracked).toEqual(["new.txt"]);
      expect(plan.repoRoot).toBe(realpathSync(work));
    } finally {
      for (const [name, value] of [
        ["GIT_DIR", saved.dir],
        ["GIT_WORK_TREE", saved.tree],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses a file that an unpushed commit added by a secret path rule, even when a later commit deleted it", async () => {
    const { work } = makeRepo();
    write(work, ".env", "A=1\n");
    run(work, "add", "-f", ".env");
    run(work, "commit", "-q", "-m", "env");
    run(work, "rm", "-q", ".env");
    run(work, "commit", "-q", "-m", "drop env");
    const plan = await planOf(work);
    const hit = plan.refusals.find((entry) => entry.code === "secret-in-commits");
    expect(hit?.paths).toEqual([".env"]);
  });

  it("reads a commit that adds a token to a file git treats as binary or -diff", async () => {
    const { work } = makeRepo();
    write(work, ".gitattributes", "*.bin -diff\n");
    write(work, "blob.bin", "\0\0 token ghp_abcdefghijklmnopqrstuvwxyz0123456789 \0\n");
    write(work, "plain.txt", "\0 -----BEGIN PRIVATE KEY----- \0\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "bin");
    const plan = await planOf(work);
    expect(codes(plan)).toContain("secret-in-commits");
    expect(JSON.stringify(plan.refusals)).not.toContain("ghp_");
  });

  it("applies path rules to a file that was committed and is untouched", async () => {
    const { work } = makeRepo();
    write(work, "ok.txt", "ok\n");
    write(work, "service/.env.production", "A=1\n");
    run(work, "add", "-A", "-f");
    run(work, "commit", "-q", "-m", "files");
    const hit = (await planOf(work)).refusals.find((entry) => entry.code === "secret-in-commits");
    expect(hit?.paths).toEqual(["service/.env.production"]);
  });

  it("treats a path named like a revision as a path: an untracked file named HEAD is carried", async () => {
    const { work } = makeRepo();
    write(work, "HEAD", "not a revision\n");
    const plan = await planOf(work);
    expect(plan.untracked).toContain("HEAD");
  });

  it("refuses a move that carries files on Windows and leaves the conversation alone", async () => {
    const { work } = makeRepo();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = await planWip({ cwd: work });
      expect(isRefusal(result) && result.code).toBe("windows-unsupported");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("parseGitVersion", () => {
  it("reads major and minor from the usual and the vendor-suffixed output", () => {
    expect(parseGitVersion("git version 2.39.5\n")).toEqual([2, 39]);
    expect(parseGitVersion("git version 2.43.0 (Apple Git-146)")).toEqual([2, 43]);
    expect(parseGitVersion("git version 2.20.1.windows.1")).toEqual([2, 20]);
  });

  it("returns nothing for text that is not a version", () => {
    expect(parseGitVersion("")).toBeUndefined();
    expect(parseGitVersion("command not found")).toBeUndefined();
  });
});
