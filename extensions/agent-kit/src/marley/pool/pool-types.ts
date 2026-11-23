// Extract of zygstinct apps/agent-server/src/pool/pool-types.ts at 7110e58c8: only PlanUsage.
/** The use of one rate-limit window in percent, and its reset time in epoch milliseconds. */
export interface UsageWindow {
  percent: number;
  resetsAt?: number;
}

/** The two subscription windows that the pool caps. */
export interface PlanUsage {
  weekly: UsageWindow;
  fiveHour: UsageWindow;
}
