import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseOrgPlacementRequest } from "@marshal/agent-runtime-org";
import { describe, expect, it } from "vitest";

import {
  buildManifest,
  mountLabel,
  closeInterruptedToolCalls,
  INTERRUPTED_BY_MOVE,
  repoRootSpellings,
  rewriteTranscriptPaths,
} from "./org-placement";
import type { WipPlan } from "./org-wip-bundle";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));
const text = (value: Uint8Array) => Buffer.from(value).toString("utf8");
const jsonl = (...lines: unknown[]) =>
  `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

describe("rewriteTranscriptPaths", () => {
  it("rewrites a repository path and the paths under it, leaving a sibling that shares the prefix", () => {
    const out = rewriteTranscriptPaths(
      bytes(
        jsonl({
          cwd: "/Users/a/repo",
          file: "/Users/a/repo/src/x.ts",
          other: "/Users/a/repo-old/x",
        }),
      ),
      "/Users/a/repo",
      "/work/m1",
    );
    expect(text(out)).toBe(
      jsonl({ cwd: "/work/m1", file: "/work/m1/src/x.ts", other: "/Users/a/repo-old/x" }),
    );
  });

  it("rewrites the JSON-escaped spelling of a Windows path and keeps other bytes untouched", () => {
    const original = jsonl({ cwd: "C:\\src\\repo", note: "héllo ✓" });
    const out = rewriteTranscriptPaths(bytes(original), "C:\\src\\repo", "/work/m1");
    expect(text(out)).toBe(jsonl({ cwd: "/work/m1", note: "héllo ✓" }));
  });

  it("leaves a path that merely ends in the repository path, and rewrites one that ends a sentence", () => {
    const out = rewriteTranscriptPaths(
      bytes(
        jsonl({
          inside: "/mnt/Users/a/repo/x",
          nested: "/data/Users/a/repo",
          text: "I edited /Users/a/repo. Then /Users/a/repo/src. Then (/Users/a/repo) and /Users/a/repo.bak",
          next: "see /Users/a/repo.\nbye",
        }),
      ),
      "/Users/a/repo",
      "/work/m1",
    );
    expect(text(out)).toBe(
      jsonl({
        inside: "/mnt/Users/a/repo/x",
        nested: "/data/Users/a/repo",
        text: "I edited /work/m1. Then /work/m1/src. Then (/work/m1) and /Users/a/repo.bak",
        next: "see /work/m1.\nbye",
      }),
    );
  });

  it("rewrites every spelling it is given, the longest first", () => {
    const out = rewriteTranscriptPaths(
      bytes(jsonl({ a: "/link/repo/x", b: "/real/repo/y", c: "/real/repo-old" })),
      ["/real/repo", "/link/repo"],
      "/work/m1",
    );
    expect(text(out)).toBe(jsonl({ a: "/work/m1/x", b: "/work/m1/y", c: "/real/repo-old" }));
  });

  it("returns the bytes unchanged for an empty or root prefix", () => {
    const input = bytes("/x\n");
    expect(rewriteTranscriptPaths(input, "", "/work/m1")).toBe(input);
    expect(rewriteTranscriptPaths(input, "/", "/work/m1")).toBe(input);
  });
});

describe("closeInterruptedToolCalls", () => {
  const base = { sessionId: "s", cwd: "/work/m1", version: "2.1.0" };
  const withCall = jsonl(
    { type: "user", uuid: "u1", ...base, message: { role: "user", content: "go" } },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      ...base,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "tool_use", id: "t2", name: "Bash", input: {} },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      ...base,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    },
  );

  it("answers only the calls without a result, chained to the call's line, and names the first tool", () => {
    const closed = closeInterruptedToolCalls(
      bytes(withCall),
      () => new Date("2026-11-04T10:00:00Z"),
    );
    expect(closed?.tool).toBe("Bash");
    const last = JSON.parse(text(closed!.bytes).trim().split("\n").at(-1)!);
    expect(last).toMatchObject({
      type: "user",
      parentUuid: "a1",
      sessionId: "s",
      cwd: "/work/m1",
      version: "2.1.0",
      timestamp: "2026-11-04T10:00:00.000Z",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: INTERRUPTED_BY_MOVE, is_error: true },
        ],
      },
    });
    expect(text(closed!.bytes).startsWith(withCall)).toBe(true);
  });

  it("leaves a transcript with every call answered alone", () => {
    const done = jsonl(
      {
        type: "assistant",
        uuid: "a",
        ...base,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
        },
      },
      {
        type: "user",
        uuid: "b",
        ...base,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
        },
      },
    );
    expect(closeInterruptedToolCalls(bytes(done))).toBeUndefined();
  });

  it("tolerates lines that are not JSON", () => {
    expect(closeInterruptedToolCalls(bytes("not json\n"))).toBeUndefined();
  });
});

describe("buildManifest", () => {
  const plan: WipPlan = {
    repoRoot: "/Users/a/zyg",
    repo: "zyg-edge/zyg",
    baseCommit: "b".repeat(40),
    headCommit: "c".repeat(40),
    baseBranch: "main",
    localCommits: 3,
    tracked: ["a", "b"],
    trackedBytes: 5,
    untracked: ["c"],
    untrackedBytes: 5,
    skipped: [{ path: ".env", why: "secret" }],
    skippedTotal: 1,
    refusals: [],
    trackedOnly: false,
  };

  it("never carries a local absolute path and keeps the skipped paths", () => {
    const manifest = buildManifest({
      sessionId: "s1",
      hostId: "desktop-1",
      boundary: "ws:zyg",
      now: new Date("2026-11-04T10:00:00Z"),
      plan,
      bundle: {
        bytes: new Uint8Array(10),
        sha256: "a".repeat(64),
        tracked: 2,
        untracked: 1,
        localCommits: 3,
      },
      midTurn: { tool: "Bash" },
    });
    expect(JSON.stringify(manifest)).not.toContain("/Users/a");
    expect(manifest.mounts[0]).toMatchObject({
      localLabel: "zyg",
      cloudPath: "/work/m1",
      wip: {
        bytes: 10,
        tracked: 2,
        untracked: 1,
        localCommits: 3,
        skipped: [{ path: ".env", why: "secret" }],
      },
    });
    expect(manifest.midTurn).toEqual({ interrupted: true, tool: "Bash" });
  });
});

describe("repoRootSpellings", () => {
  it("adds the session's own spelling of a folder reached through a symlink", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "marshal-spellings-")));
    try {
      const real = path.join(base, "real", "repo");
      mkdirSync(path.join(real, "pkg"), { recursive: true });
      symlinkSync(path.join(base, "real"), path.join(base, "link"));
      const viaLink = path.join(base, "link", "repo");
      expect(repoRootSpellings(viaLink, real).sort()).toEqual([real, viaLink].sort());
      expect(repoRootSpellings(path.join(viaLink, "pkg"), real).sort()).toEqual(
        [real, viaLink].sort(),
      );
      expect(repoRootSpellings(real, real)).toEqual([real]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("adds nothing for a symlink that points into a subfolder of the repository", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "marshal-spellings-")));
    try {
      const real = path.join(base, "real", "repo");
      mkdirSync(path.join(real, "sub"), { recursive: true });
      symlinkSync(path.join(real, "sub"), path.join(base, "inner"));
      expect(repoRootSpellings(path.join(base, "inner"), real)).toEqual([real]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to the repository root when the folder is gone", () => {
    expect(repoRootSpellings("/nonexistent/folder", "/real/repo")).toEqual(["/real/repo"]);
  });
});

describe("buildManifest against the organization's limits", () => {
  const base: WipPlan = {
    repoRoot: "/Users/a/zyg",
    repo: "zyg-edge/zyg",
    baseCommit: "b".repeat(40),
    headCommit: "c".repeat(40),
    baseBranch: "main",
    localCommits: 0,
    tracked: ["a"],
    trackedBytes: 1,
    untracked: [],
    untrackedBytes: 0,
    skipped: [],
    skippedTotal: 0,
    refusals: [],
    trackedOnly: false,
  };
  const bundle = {
    bytes: new Uint8Array(10),
    sha256: "a".repeat(64),
    tracked: 1,
    untracked: 0,
    localCommits: 0,
  };
  const manifestOf = (plan: Partial<WipPlan>, midTurn?: { tool: string }) =>
    buildManifest({
      sessionId: "s1",
      hostId: "desktop-1",
      boundary: "ws:zyg",
      now: new Date("2026-11-04T10:00:00Z"),
      plan: { ...base, ...plan },
      bundle,
      ...(midTurn ? { midTurn } : {}),
    });
  const mountOf = (manifest: ReturnType<typeof manifestOf>) => {
    const mount = manifest.mounts[0];
    if (mount?.kind !== "git") throw new Error("expected a git mount");
    return mount;
  };

  it.each(["fix#12", "feature branch", "a..b", "bad@{x}", "trailing/", "-leading", ""])(
    "leaves baseBranch out when %j is not a branch name the organization accepts",
    (branch) => {
      const manifest = manifestOf({ baseBranch: branch });
      expect(mountOf(manifest)).not.toHaveProperty("baseBranch");
      expect(() => parseOrgPlacementRequest(manifest)).not.toThrow();
    },
  );

  it("keeps a valid baseBranch", () => {
    expect(mountOf(manifestOf({ baseBranch: "release/2026.11" }))).toMatchObject({
      baseBranch: "release/2026.11",
    });
  });

  it("drops skipped paths over 512 characters or with control characters and keeps the rest", () => {
    const long = `${"d/".repeat(300)}file.txt`;
    const manifest = manifestOf({
      skipped: [
        { path: long, why: "secret" },
        { path: "a\nb", why: "secret" },
        { path: "x".repeat(512), why: "over-budget" },
        { path: ".env", why: "secret" },
      ],
      skippedTotal: 4,
    });
    expect(mountOf(manifest).wip?.skipped).toEqual([
      { path: "x".repeat(512), why: "over-budget" },
      { path: ".env", why: "secret" },
    ]);
    expect(() => parseOrgPlacementRequest(manifest)).not.toThrow();
  });

  it.each([
    "~omer",
    "~my repo",
    "~ notes",
    "my ~backup",
    "x ~y",
    "repo ~name",
    "a\\\\host\\Users\\x",
    "file:x",
    "C:proj",
    "a\nb",
    "x".repeat(201),
  ])("uses a neutral label for a folder named %j", (name) => {
    expect(mountLabel(`/work/${name}`)).toBe("repository");
    expect(() => parseOrgPlacementRequest(manifestOf({ repoRoot: `/work/${name}` }))).not.toThrow();
  });

  it("keeps ordinary folder names, including ones that only look like a home reference", () => {
    for (const name of ["my-repo.v2", "my~repo", "a-~b", "tilde ~ alone", "Users", "home"]) {
      expect(mountLabel(`/Users/a/${name}`)).toBe(name);
    }
  });

  it("cleans a tool name with control characters or a home path", () => {
    for (const tool of [
      "Ba\nsh",
      "/Users/omer/bin/tool",
      "run ~omer",
      "x\\\\host\\home\\y",
      "t".repeat(300),
    ]) {
      const manifest = manifestOf({}, { tool });
      expect(() => parseOrgPlacementRequest(manifest)).not.toThrow();
      expect(manifest.midTurn?.tool?.length).toBeLessThanOrEqual(128);
    }
  });
});
