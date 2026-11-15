import { createLogger } from "../../common/marshal-logger";
import type { RuntimeUiViewHealthStore } from "./ui-view-health";

const log = createLogger("RuntimeUiViewHealthWake");
const DEFAULT_DEBOUNCE_MS = 1_000;

export const RUNTIME_UI_VIEW_FAILURE_WAKE_MESSAGE =
  "A view you opened is not rendering — its failure is in the view list. " +
  "If the view list shows no failure it recovered; say nothing and carry on.";

export const RUNTIME_UI_STREAM_FAILURE_WAKE_MESSAGE =
  "The `marshal-ui` block in your last message did not compile, so the user sees an error " +
  "instead of the UI. Send a corrected block or open the view with runtimeShowUi. Compiler output:";

export interface RuntimeUiViewHealthWakeOptions {
  readonly store: RuntimeUiViewHealthStore;
  /** True only while the session has no turn running or queued work in flight. */
  readonly isSessionIdle: (sessionId: string) => boolean;
  /** Delivers one system-labeled message into the session. */
  readonly deliver: (input: {
    readonly sessionId: string;
    readonly instanceId: string;
    /** When the failure began; unique per transition, for idempotency. */
    readonly since: string;
    readonly content: string;
  }) => Promise<unknown>;
  readonly debounceMs?: number;
}

/**
 * One wake per healthy→failing transition of a view whose owning session is
 * idle. The first failure of a view that never rendered is the synchronous
 * runtimeShowUi verdict's job, and a failure while a turn runs shows up in the
 * next per-turn view list, so neither wakes the session.
 */
export function attachRuntimeUiViewHealthWake(options: RuntimeUiViewHealthWakeOptions): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = (instanceId: string) => {
    const timer = timers.get(instanceId);
    if (timer) clearTimeout(timer);
    timers.delete(instanceId);
  };
  const unsubscribe = options.store.subscribe(({ previous, current }) => {
    if (current.status === "ok") {
      clear(current.instanceId);
      return;
    }
    if (previous !== "ok" || current.status !== "failing" || !current.sessionId) return;
    clear(current.instanceId);
    const { instanceId, sessionId } = current;
    const timer = setTimeout(() => {
      timers.delete(instanceId);
      if (options.store.get(instanceId)?.status !== "failing") return;
      if (!options.isSessionIdle(sessionId)) return;
      options
        .deliver({
          sessionId,
          instanceId,
          since: current.since,
          content: RUNTIME_UI_VIEW_FAILURE_WAKE_MESSAGE,
        })
        .catch((error: unknown) => {
          log.warn("Failed to deliver the view failure wake", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
    timers.set(instanceId, timer);
  });
  return () => {
    unsubscribe();
    for (const instanceId of [...timers.keys()]) clear(instanceId);
  };
}
