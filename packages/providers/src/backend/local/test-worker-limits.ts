import os from "node:os";

// Vitest defaults to one worker per core minus one, and agents in parallel
// worktrees each start their own run, so a handful of agents oversubscribe the
// machine many times over. Vitest 3 reads the THREADS/FORKS names, vitest 4
// reads MAX_WORKERS; both let the env win over the project's config.
export const VITEST_WORKER_LIMIT_KEYS = [
  "VITEST_MAX_WORKERS",
  "VITEST_MAX_THREADS",
  "VITEST_MAX_FORKS",
];

export function defaultAgentTestWorkerLimit(cores = os.availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 4));
}

/** Caps test-runner workers for agent subprocesses unless the user already set a limit. */
export function applyAgentTestWorkerLimits(
  env: Record<string, string | undefined>,
  limit = defaultAgentTestWorkerLimit(),
): void {
  for (const key of VITEST_WORKER_LIMIT_KEYS) {
    if (!env[key]) env[key] = String(limit);
  }
}
