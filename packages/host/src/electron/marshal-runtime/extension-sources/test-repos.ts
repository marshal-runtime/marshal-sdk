import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Test helper: a bare remote plus a working clone holding one extension package. */
export interface ExtensionRepoFixture {
  readonly root: string;
  readonly remote: string;
  readonly checkout: string;
  readonly packageRoot: string;
  readonly subdir: string;
  git(args: readonly string[], cwd?: string): string;
  /** Commits a file change in the checkout and pushes it; returns the new commit. */
  commitAndPush(relativeFile: string, content: string, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createExtensionRepo(
  options: { identity?: string; subdir?: string; entrypoint?: string } = {},
): Promise<ExtensionRepoFixture> {
  const identity = options.identity ?? "@test/sample";
  const subdir = options.subdir ?? "packages/sample";
  const root = await mkdtemp(path.join(tmpdir(), "marshal-extension-source-"));
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  const git = (args: readonly string[], cwd = checkout) =>
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["clone", remote, checkout], root);
  git(["checkout", "-B", "main"]);
  const packageRoot = path.join(checkout, ...subdir.split("/"));
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "runtime-extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      identity,
      version: "0.1.0",
      entrypoint: options.entrypoint ?? "dist/runtime.cjs",
    }),
  );
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: identity }));
  await writeFile(path.join(packageRoot, "dist", "runtime.cjs"), "module.exports = 1;\n");
  await writeFile(path.join(checkout, "README.md"), "root\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);
  git(["push", "-u", "origin", "main"]);

  return {
    root,
    remote,
    checkout,
    packageRoot,
    subdir,
    git,
    async commitAndPush(relativeFile, content, message) {
      const file = path.join(checkout, ...relativeFile.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      git(["add", "-A"]);
      git(["commit", "-m", message]);
      git(["push", "origin", "main"]);
      return git(["rev-parse", "HEAD"]);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
