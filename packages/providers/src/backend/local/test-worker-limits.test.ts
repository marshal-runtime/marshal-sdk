import { describe, expect, it } from "vitest";

import { createClaudeEnvironment } from "../claude/environment";
import { buildCodexEnvironment } from "../codex/process";
import { applyAgentTestWorkerLimits, defaultAgentTestWorkerLimit } from "./test-worker-limits";

describe("agent test worker limits", () => {
  it("uses a quarter of the cores, at least one", () => {
    expect(defaultAgentTestWorkerLimit(15)).toBe(3);
    expect(defaultAgentTestWorkerLimit(16)).toBe(4);
    expect(defaultAgentTestWorkerLimit(2)).toBe(1);
  });

  it("sets the vitest 3 and 4 limits but keeps limits the user set", () => {
    const env: Record<string, string | undefined> = { VITEST_MAX_FORKS: "8" };
    applyAgentTestWorkerLimits(env, 3);
    expect(env).toMatchObject({
      VITEST_MAX_WORKERS: "3",
      VITEST_MAX_THREADS: "3",
      VITEST_MAX_FORKS: "8",
    });
  });

  it("applies to Claude and Codex agent environments", () => {
    const limit = String(defaultAgentTestWorkerLimit());
    const source = {
      ...process.env,
      VITEST_MAX_WORKERS: undefined,
      VITEST_MAX_THREADS: undefined,
      VITEST_MAX_FORKS: undefined,
    };
    expect(createClaudeEnvironment(source).VITEST_MAX_WORKERS).toBe(limit);
    expect(buildCodexEnvironment("/tmp/codex-home", source).VITEST_MAX_THREADS).toBe(limit);
  });
});
