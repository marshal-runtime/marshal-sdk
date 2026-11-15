// The desktop's runtime host, built from packages/host, starts here on the pinned runtime packs and serves a search.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createRuntimeServiceContainer } from "@marshal/runtime";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The bundle is built by build.mjs; tests import it from dist.
const hostModulePath = path.join(repoRoot, "dist", "host-runtime.js");

test("the shared desktop runtime host starts outside Electron and answers a search", async () => {
  const shared = await import(hostModulePath);
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "msdk-host-runtime-"));
  try {
    for (const dir of ["workspace", "scope", "protected", "worktrees", "extensions", "user"]) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    shared.configureHostPlatform({ paths: { userData: path.join(root, "user"), temp: root }, version: "0.0.0-test" });
    const host = new shared.MarshalRuntimeHost({
      location: { isPackaged: false, appPath: repoRoot, resourcesPath: repoRoot },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot: path.join(root, "extensions"),
      authority: {
        async resolveScope(scope: { sessionId: string; workspaceName: string }) {
          return { ...scope, workspacePath: path.join(root, "scope") };
        },
        async authorize() {
          return { decision: "allow" };
        },
      },
      catalog: {
        listTools: () => [],
        listSkills: () => [],
        getSkill: () => null,
        listWorkspaces: () => [],
        getSessionContext: async () => null,
      },
      serviceContainer: createRuntimeServiceContainer(),
    });
    try {
      await host.start();
      const api = new shared.ProductionMarshalRuntimeApi(host);
      const result = await api.search({ sessionId: "session-1", workspaceName: "workspace", query: "" });
      assert.equal(result.ok, true, JSON.stringify(result));
      const names = result.value.matches.map((match: { capability?: { name?: string } }) => match.capability?.name);
      assert.ok(names.length > 0, "the runtime's built-in capabilities are listed");
    } finally {
      host.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createMarshalHost composes its runtime on this shared host, not a runtime of its own", async () => {
  const { readFile } = await import("node:fs/promises");
  const hostSource = await readFile(path.join(repoRoot, "src", "host.ts"), "utf8");
  assert.match(hostSource, /createSharedRuntime\(/);
  assert.doesNotMatch(hostSource, /createAgentRuntime\b/);
  const shared = await readFile(path.join(repoRoot, "src", "shared-runtime.ts"), "utf8");
  assert.match(shared, /new shared\.MarshalRuntimeHost\(/);
});
