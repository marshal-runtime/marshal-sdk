import type { UiObserveRenderRequest, UiObserveWindowHandle } from "../ui-observe";
import type { ShowUiRenderProbe } from "./show-ui-health";
import type { RuntimeUiViewHealthStore } from "./ui-view-health";

/**
 * A visible view reports once its template, payload and component documents
 * have loaded (measured 0.3-1s). Opening the hidden observer window earlier
 * renders the whole view a second time and competes with the visible mount.
 */
const VISIBLE_MOUNT_WAIT_MS = 1_500;
/** After the hidden observer window has mounted the view, how long to wait for a report. */
const OBSERVER_REPORT_WAIT_MS = 2_500;
/** Without an observer window there is only the visible-mount signal left. */
const NO_OBSERVER_EXTRA_WAIT_MS = 1_500;
const OBSERVER_OPEN_CAP_MS = 8_000;

export interface UiRenderProbeDeps {
  readonly store: RuntimeUiViewHealthStore;
  /** The hidden `ui.observe` mirror window (electron/ui-observe-window.ts). */
  readonly openObserver?: (request: UiObserveRenderRequest) => Promise<UiObserveWindowHandle>;
  readonly timings?: {
    readonly visibleMountMs?: number;
    readonly observerReportMs?: number;
    readonly noObserverMs?: number;
    readonly observerOpenCapMs?: number;
  };
}

function withCap<T>(promise: Promise<T>, capMs: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), capMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The synchronous verdict behind `runtimeShowUi`: does the placed view paint?
 * It never depends on the placement being visible (slot cards stay hidden until
 * their marker is on screen, dock tabs may be hidden): a mirror of the
 * instance is mounted in the hidden observer window, whose own bridge reports
 * rendered / render-error exactly like a visible client's. If the observer
 * cannot open, the visible-mount signal is all there is, and a view with no
 * signal at all is reported `unverified` rather than guessed.
 */
export function createUiRenderProbe(deps: UiRenderProbeDeps): ShowUiRenderProbe {
  const timings = deps.timings ?? {};
  return async (request) => {
    const verdict = (outcome: Awaited<ReturnType<RuntimeUiViewHealthStore["waitForRender"]>>) => {
      if (outcome === "timeout") return undefined;
      if (outcome.status === "failing") {
        return {
          status: "failing" as const,
          phase: outcome.phase ?? "runtime",
          message: outcome.message ?? "Unknown error",
          ...(outcome.stack ? { stack: outcome.stack } : {}),
        };
      }
      return outcome.status === "ok" ? { status: "ok" as const } : undefined;
    };
    const quick = verdict(
      await deps.store.waitForRender(
        request.applicationId,
        timings.visibleMountMs ?? VISIBLE_MOUNT_WAIT_MS,
        request.signal,
      ),
    );
    if (quick) return quick;

    let handle: UiObserveWindowHandle | undefined;
    if (deps.openObserver) {
      try {
        const opening = deps.openObserver({
          mode: "instance",
          instanceId: request.instanceId,
          scope: request.scope,
          viewport: request.viewport,
          settleMs: 0,
          fullPage: false,
        });
        const opened = await withCap(opening, timings.observerOpenCapMs ?? OBSERVER_OPEN_CAP_MS);
        if (opened === "timeout") {
          void opening.then(
            (late) => late.destroy(),
            () => undefined,
          );
        } else {
          handle = opened;
        }
      } catch {
        handle = undefined;
      }
    }
    try {
      const outcome = verdict(
        await deps.store.waitForRender(
          request.applicationId,
          handle
            ? (timings.observerReportMs ?? OBSERVER_REPORT_WAIT_MS)
            : (timings.noObserverMs ?? NO_OBSERVER_EXTRA_WAIT_MS),
          request.signal,
        ),
      );
      return outcome ?? { status: "unverified" };
    } finally {
      handle?.destroy();
    }
  };
}
