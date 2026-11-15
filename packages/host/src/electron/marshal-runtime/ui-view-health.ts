import {
  RUNTIME_UI_HEALTH_MAX_MESSAGE,
  RUNTIME_UI_HEALTH_MAX_STACK,
  type RuntimeUiViewFailurePhase,
  type RuntimeUiViewHealth,
} from "../../common/runtime-ui-health";

const MAX_TRACKED_VIEWS = 500;

export interface RuntimeUiViewHealthUpdate {
  readonly instanceId: string;
  readonly sessionId?: string;
  readonly applicationId?: string;
  readonly status: "ok" | "failing";
  readonly phase?: RuntimeUiViewFailurePhase;
  readonly message?: string;
  readonly stack?: string;
  readonly revision?: string;
}

export interface RuntimeUiViewHealthChange {
  readonly previous: RuntimeUiViewHealth["status"];
  readonly current: RuntimeUiViewHealth;
}

export type RuntimeUiViewHealthListener = (change: RuntimeUiViewHealthChange) => void;

/**
 * Per-instance health of agent-authored views, fed by the sandboxed document's
 * own render-error / rendered notifications. It is current state: a `rendered`
 * report after a failure returns the view to `ok`, and a closed view is
 * forgotten. Reports for the same status refresh the detail but keep `since`.
 */
export class RuntimeUiViewHealthStore {
  private readonly entries = new Map<string, RuntimeUiViewHealth>();
  private readonly listeners = new Set<RuntimeUiViewHealthListener>();

  constructor(private readonly clock: () => number = Date.now) {}

  report(update: RuntimeUiViewHealthUpdate): RuntimeUiViewHealth {
    const previous = this.entries.get(update.instanceId);
    const sameStatus = previous?.status === update.status;
    const current: RuntimeUiViewHealth = {
      instanceId: update.instanceId,
      ...(update.sessionId ? { sessionId: update.sessionId } : {}),
      ...(update.applicationId ? { applicationId: update.applicationId } : {}),
      status: update.status,
      ...(update.status === "failing"
        ? {
            phase: update.phase ?? "runtime",
            message: (update.message ?? "Unknown error").slice(0, RUNTIME_UI_HEALTH_MAX_MESSAGE),
            ...(update.stack ? { stack: update.stack.slice(0, RUNTIME_UI_HEALTH_MAX_STACK) } : {}),
          }
        : {}),
      ...(update.revision ? { revision: update.revision } : {}),
      since: sameStatus && previous ? previous.since : new Date(this.clock()).toISOString(),
    };
    this.entries.delete(update.instanceId);
    this.entries.set(update.instanceId, current);
    while (this.entries.size > MAX_TRACKED_VIEWS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const change: RuntimeUiViewHealthChange = {
      previous: previous?.status ?? "unknown",
      current,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // A listener must never break health reporting.
      }
    }
    return current;
  }

  get(instanceId: string): RuntimeUiViewHealth | undefined {
    return this.entries.get(instanceId);
  }

  list(): readonly RuntimeUiViewHealth[] {
    return [...this.entries.values()];
  }

  /**
   * The newest report for a view: its own, or one from a mirror of the same
   * render (an observer window renders a copy under its own instance id).
   */
  forView(instanceId: string, applicationId?: string): RuntimeUiViewHealth | undefined {
    let found: RuntimeUiViewHealth | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.instanceId === instanceId ||
        (applicationId !== undefined && entry.applicationId === applicationId)
      ) {
        found = entry;
      }
    }
    return found;
  }

  findByApplication(applicationId: string): RuntimeUiViewHealth | undefined {
    let found: RuntimeUiViewHealth | undefined;
    for (const entry of this.entries.values()) {
      if (entry.applicationId === applicationId) found = entry;
    }
    return found;
  }

  forget(instanceId: string): void {
    this.entries.delete(instanceId);
  }

  subscribe(listener: RuntimeUiViewHealthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves with the first report for a render (by application id) made after
   * this call, or with the already-known outcome of a render that has reported
   * before (renders are content-addressed and immutable). `timeout` means
   * nothing reported in time.
   */
  waitForRender(
    applicationId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RuntimeUiViewHealth | "timeout"> {
    const known = this.findByApplication(applicationId);
    if (known && known.status !== "unknown") return Promise.resolve(known);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: RuntimeUiViewHealth | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish("timeout");
      const unsubscribe = this.subscribe(({ current }) => {
        if (current.applicationId === applicationId) finish(current);
      });
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const defaultStore = new RuntimeUiViewHealthStore();

export function runtimeUiViewHealthStore(): RuntimeUiViewHealthStore {
  return defaultStore;
}

/** Current health of one view; `undefined` when nothing has been reported. */
export function getRuntimeUiViewHealth(
  instanceId: string,
  applicationId?: string,
): RuntimeUiViewHealth | undefined {
  return defaultStore.forView(instanceId, applicationId);
}

/** Current health of every tracked view (most recently reported last). */
export function listRuntimeUiViewHealth(): readonly RuntimeUiViewHealth[] {
  return defaultStore.list();
}
