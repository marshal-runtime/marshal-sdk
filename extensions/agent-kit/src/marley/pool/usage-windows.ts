// Extract of zygstinct apps/agent-server/src/pool/usage-windows.ts at 7110e58c8: only windowsFromHeaders.
import type { PlanUsage } from "./pool-types.js";

const PERCENT = 100;

const MS_PER_SECOND = 1000;

/** Reads only observed subscription headers, never inferring a missing window as zero. */
export function windowsFromHeaders(headers: Record<string, string | string[] | undefined>): Partial<PlanUsage> {
  const normalized = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const weekly = headerNumber(normalized["anthropic-ratelimit-unified-7d-utilization"]);
  const usage: Partial<PlanUsage> = {};
  for (const [name, value] of Object.entries(normalized)) {
    const match = /^anthropic-ratelimit-unified-(5h|7d(?:[-_][a-z0-9]+)*)-utilization$/.exec(name);
    const fraction = headerNumber(value);
    if (!match || fraction === null || !Number.isFinite(fraction * PERCENT)) continue;
    const reset = headerNumber(normalized[name.replace(/utilization$/, "reset")]);
    const resetsAt = reset !== null && reset > 0 && Number.isSafeInteger(reset * MS_PER_SECOND) ? reset * MS_PER_SECOND : undefined;
    const kind = match[1] === "5h" ? "fiveHour" : "weekly";
    if (kind === "weekly" && (weekly === null || !Number.isFinite(weekly * PERCENT))) continue;
    const window = { percent: fraction * PERCENT, resetsAt };
    if (!usage[kind] || window.percent > usage[kind]!.percent) usage[kind] = window;
  }
  return usage;
}

function headerNumber(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
