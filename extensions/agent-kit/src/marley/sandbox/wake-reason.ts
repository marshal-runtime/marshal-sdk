import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why the server asked for a brand's sandbox. Every `ensure` names one, and a sandbox that this server starts or creates logs it on `daytona.ready`, so a
 * wake always says which work woke it (a stopped sandbox costs nothing; a woken one costs at least an idle period). A closed list: log fields stay bounded.
 */
export const WAKE_REASONS = [
  "turn", "task", "wake_on_arrival", "test_ingress",
  "brand_graph", "routines_brain_publish", "recall_publish", "store_watch", "owner_reports", "acting_ahead", "proactive", "pixel_watch",
  "onboarding_audit", "routine_import", "meta_change", "meta_grant", "brain_tokens", "server_vm_write", "composer", "transcript", "snapshot_upgrade",
  "vm_command", "brain_memory", "brand_events", "daily_review",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

const scope = new AsyncLocalStorage<WakeReason>();

/** Runs `work` with `reason` as the wake reason of every sandbox lookup inside it that does not name its own (a `BrandVm` command's address lookup). */
export function withWakeReason<T>(reason: WakeReason, work: () => T): T {
  return scope.run(reason, work);
}

/** The reason of the enclosing `withWakeReason`, or `vm_command` (a VM command outside any named work). */
export function currentWakeReason(): WakeReason {
  return scope.getStore() ?? "vm_command";
}

const noWake = new AsyncLocalStorage<true>();

/**
 * Runs `work` so that no sandbox lookup inside it can start a sandbox: a `BrandVm` command reaches a sandbox that runs right now and fails with
 * `SandboxNotStartedError` otherwise. For work that rides on a wake something else made (publishing after a turn), never one of its own.
 */
export function withoutWake<T>(work: () => T): T {
  return noWake.run(true, work);
}

export function wakeForbidden(): boolean {
  return noWake.getStore() === true;
}

/** A command inside `withoutWake` found the brand's sandbox stopped (or replaced): nothing was started. */
export class SandboxNotStartedError extends Error {
  constructor(readonly brandId: string) {
    super(`the sandbox of brand ${brandId} is not running and this work does not start it`);
    this.name = "SandboxNotStartedError";
  }
}
