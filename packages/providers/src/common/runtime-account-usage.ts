export type RuntimeUsageWindowKind =
  | "five_hour"
  | "weekly"
  | "weekly_opus"
  | "weekly_sonnet"
  | "other";

export interface RuntimeUsageWindow {
  kind: RuntimeUsageWindowKind;
  /** Display name for `other` windows, e.g. a model-scoped weekly limit. */
  label?: string;
  /** Share of the window already used, 0-100. */
  usedPercent: number;
  /** Epoch ms when the window resets; absent when the runtime does not report it. */
  resetsAt?: number;
  /** `fetch` came from an explicit usage read; `event` from a rate-limit notice during a turn. */
  source: "fetch" | "event";
  /** Epoch ms when this window was read. */
  fetchedAt: number;
}

export type RuntimeAccountUsageUnavailableReason =
  /** API key, cloud provider, or a runtime that reports no plan usage. */
  | "not_applicable"
  | "signed_out"
  /** Signed in on paper but the login can no longer be used; signing in again fixes it. */
  | "auth_expired"
  | "error";

export type RuntimeAccountUsage =
  | {
      available: true;
      /** Plan name as the runtime reports it, lower-case: `max`, `pro`, `team`, `plus`. */
      plan?: string;
      windows: RuntimeUsageWindow[];
      fetchedAt: number;
    }
  | {
      available: false;
      reason: RuntimeAccountUsageUnavailableReason;
      message?: string;
      fetchedAt: number;
    };

export function unavailableUsage(
  reason: RuntimeAccountUsageUnavailableReason,
  message?: string,
  fetchedAt: number = Date.now(),
): RuntimeAccountUsage {
  return { available: false, reason, ...(message ? { message } : {}), fetchedAt };
}

const MODEL_FAMILY_WINDOWS: ReadonlyArray<readonly [RuntimeUsageWindowKind, string]> = [
  ["weekly_opus", "opus"],
  ["weekly_sonnet", "sonnet"],
];

/** The windows that can stop `model` on this account: 5-hour, weekly, and its model family's own limits. */
function gatingWindows(
  usage: RuntimeAccountUsage,
  model: string | undefined,
  now: number,
): RuntimeUsageWindow[] {
  if (!usage.available) return [];
  const name = model?.toLowerCase() ?? "";
  return usage.windows.filter((window) => {
    if (window.resetsAt !== undefined && window.resetsAt <= now) return false;
    if (window.kind === "five_hour" || window.kind === "weekly") return true;
    const family = MODEL_FAMILY_WINDOWS.find(([kind]) => kind === window.kind)?.[1];
    if (family) return name.includes(family);
    return Boolean(window.label && name.includes(window.label.toLowerCase()));
  });
}

/** Percent left in the tightest window that gates `model`; undefined when usage is not reported. */
export function usageHeadroomPercent(
  usage: RuntimeAccountUsage,
  model?: string,
  now: number = Date.now(),
): number | undefined {
  if (!usage.available) return undefined;
  const windows = gatingWindows(usage, model, now);
  if (windows.length === 0) return 100;
  return 100 - Math.max(...windows.map((window) => window.usedPercent));
}

/** The first fully used window that gates `model`, if any. */
export function exhaustedUsageWindow(
  usage: RuntimeAccountUsage,
  model?: string,
  now: number = Date.now(),
): RuntimeUsageWindow | undefined {
  return gatingWindows(usage, model, now).find((window) => window.usedPercent >= 100);
}

export function clampUsedPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
