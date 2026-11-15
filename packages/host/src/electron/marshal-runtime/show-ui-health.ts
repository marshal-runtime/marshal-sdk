import type { RuntimeUiViewFailurePhase } from "../../common/runtime-ui-health";
import type { MarshalUiViewport } from "../../common/runtime-ui-viewports";
import type { MarshalRuntimeScope } from "./contracts";
import type { RuntimeUiRevisionLedger, UiViewRevision } from "./ui-view-store";

export interface ShowUiRenderProbeRequest {
  readonly scope: MarshalRuntimeScope;
  readonly instanceId: string;
  /** The render id the instance now shows. */
  readonly applicationId: string;
  readonly viewport: MarshalUiViewport;
  readonly signal?: AbortSignal;
}

export type ShowUiRenderVerdict =
  | { readonly status: "ok" }
  | {
      readonly status: "failing";
      readonly phase: RuntimeUiViewFailurePhase;
      readonly message: string;
      readonly stack?: string;
    }
  | { readonly status: "unverified" };

/** Decides whether a freshly placed view actually paints. Never throws. */
export type ShowUiRenderProbe = (request: ShowUiRenderProbeRequest) => Promise<ShowUiRenderVerdict>;

export type ShowUiRevisionLedger = Pick<
  RuntimeUiRevisionLedger,
  "list" | "live" | "append" | "markLive"
>;

export const NEXT_AFTER_SHOWN = "Shown. Mention it in one sentence; don't restate its contents.";
export const NEXT_AFTER_UPDATED =
  "Updated in place. Mention the change in one sentence; don't restate its contents.";

export function nextAfterFailure(instanceId: string | undefined): string {
  return instanceId
    ? `Fix the source and call runtimeShowUi again with instanceId=${instanceId}; do not open a new view.`
    : "Fix the source and call runtimeShowUi again.";
}

export function revisionSummary(revisions: readonly UiViewRevision[]) {
  return revisions.slice(-5).map((revision) => ({
    id: revision.revisionId,
    status: revision.status,
    at: revision.createdAt,
    ...(revision.failure
      ? { failure: `${revision.failure.stage}: ${revision.failure.message}` }
      : {}),
  }));
}

/** The revision a `rollback` argument names, or why none matches. */
export function resolveRollbackTarget(
  revisions: readonly UiViewRevision[],
  rollback: string,
): { readonly revision: UiViewRevision } | { readonly error: string } {
  const live = [...revisions].reverse().find((entry) => entry.status === "live");
  const candidates = revisions.filter(
    (entry) => entry.renderId && entry.status !== "failed" && entry.revisionId !== live?.revisionId,
  );
  if (rollback === "previous") {
    const previous = candidates.at(-1);
    return previous
      ? { revision: previous }
      : { error: "There is no earlier working revision to roll back to." };
  }
  const named = candidates.find((entry) => entry.revisionId === rollback);
  return named
    ? { revision: named }
    : { error: `Revision "${rollback}" is not an earlier working revision of this view.` };
}
