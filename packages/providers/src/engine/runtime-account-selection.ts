import {
  exhaustedUsageWindow,
  usageHeadroomPercent,
  type RuntimeAccountUsage,
  type RuntimeUsageWindow,
} from "../common/runtime-account-usage";

export type ReadRuntimeAccountUsage = (
  runtimeId: string,
  accountId: string,
) => Promise<RuntimeAccountUsage>;

/** A cold usage read starts a short-lived runtime client; a slow one must not hold a fork back. */
const USAGE_READ_TIMEOUT_MS = 10_000;

const WINDOW_NAMES: Record<RuntimeUsageWindow["kind"], string> = {
  five_hour: "5-hour limit",
  weekly: "weekly limit",
  weekly_opus: "weekly Opus limit",
  weekly_sonnet: "weekly Sonnet limit",
  other: "model limit",
};

async function readWithTimeout(
  read: ReadRuntimeAccountUsage,
  runtimeId: string,
  accountId: string,
): Promise<RuntimeAccountUsage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), USAGE_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(runtimeId, accountId).catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describeReset(window: RuntimeUsageWindow, now: number): string {
  if (window.resetsAt === undefined) return "";
  const minutes = Math.max(1, Math.round((window.resetsAt - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `, resets in ${hours > 0 ? `${hours}h ${rest}m` : `${rest}m`}`;
}

function describeExhausted(window: RuntimeUsageWindow, now: number): string {
  const name =
    window.kind === "other" && window.label ? `${window.label} limit` : WINDOW_NAMES[window.kind];
  return `${name} ${window.usedPercent}% used${describeReset(window, now)}`;
}

function signedOut(usage: RuntimeAccountUsage): boolean {
  return !usage.available && (usage.reason === "signed_out" || usage.reason === "auth_expired");
}

/**
 * Throws when an account the agent named cannot run `model` right now (no usage left, or signed
 * out), so the caller fails before creating anything. Unknown usage passes.
 */
export async function assertRuntimeAccountUsable(args: {
  read: ReadRuntimeAccountUsage;
  runtimeId: string;
  accountId: string;
  model?: string;
  now?: () => number;
}): Promise<void> {
  const usage = await readWithTimeout(args.read, args.runtimeId, args.accountId);
  if (!usage) return;
  const target = `${args.runtimeId}@${args.accountId}`;
  if (signedOut(usage)) {
    throw new Error(
      `Account ${target} is signed out; nothing was started. Pick another account, or omit the account to use the one with the most usage left.`,
    );
  }
  const now = args.now?.() ?? Date.now();
  const window = exhaustedUsageWindow(usage, args.model, now);
  if (window) {
    throw new Error(
      `Account ${target} has no usage left (${describeExhausted(window, now)}); nothing was started. Pick another account, or omit the account to use the one with the most usage left.`,
    );
  }
}

/**
 * The account with the most usage left for `model`. Ties go to the earliest id in `prefer`.
 * Accounts that report no usage rank after every account with known usage left; signed-out and
 * exhausted accounts are skipped. Throws when every account with known usage is exhausted and
 * none is left to try; returns undefined when nothing could be read.
 */
export async function pickRuntimeAccountWithMostUsage(args: {
  read: ReadRuntimeAccountUsage;
  runtimeId: string;
  candidates: readonly string[];
  prefer: readonly string[];
  model?: string;
  now?: () => number;
}): Promise<string | undefined> {
  const reads = await Promise.all(
    args.candidates.map(async (accountId) => ({
      accountId,
      usage: await readWithTimeout(args.read, args.runtimeId, accountId),
    })),
  );
  const now = args.now?.() ?? Date.now();
  const rank = (accountId: string): number => {
    const index = args.prefer.indexOf(accountId);
    return index < 0 ? args.prefer.length : index;
  };
  const known: { accountId: string; headroom: number }[] = [];
  const unknown: string[] = [];
  const exhausted: { accountId: string; window: RuntimeUsageWindow }[] = [];
  for (const { accountId, usage } of reads) {
    if (!usage) {
      unknown.push(accountId);
      continue;
    }
    if (signedOut(usage)) continue;
    const window = exhaustedUsageWindow(usage, args.model, now);
    if (window) {
      exhausted.push({ accountId, window });
      continue;
    }
    const headroom = usageHeadroomPercent(usage, args.model, now);
    if (headroom === undefined) unknown.push(accountId);
    else known.push({ accountId, headroom });
  }
  if (known.length > 0) {
    known.sort((a, b) => b.headroom - a.headroom || rank(a.accountId) - rank(b.accountId));
    return known[0]?.accountId;
  }
  if (unknown.length > 0) {
    return [...unknown].sort((a, b) => rank(a) - rank(b))[0];
  }
  if (exhausted.length > 0) {
    const detail = exhausted
      .map(
        ({ accountId, window }) =>
          `${args.runtimeId}@${accountId}: ${describeExhausted(window, now)}`,
      )
      .join("; ");
    throw new Error(
      `No ${args.runtimeId} account has usage left (${detail}); nothing was started. Use another runtime or wait for a reset.`,
    );
  }
  return undefined;
}
