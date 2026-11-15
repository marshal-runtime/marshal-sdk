import type { RuntimeUiScope } from "./runtime-ui";

/**
 * Health of an agent-authored view as the sandboxed document itself reports it
 * (`ui/notifications/render-error` and `ui/notifications/rendered`). `unknown`
 * means nothing has been reported yet (a view that is still loading, or one
 * restored after a restart).
 */
export type RuntimeUiViewHealthStatus = "ok" | "failing" | "unknown";

export type RuntimeUiViewFailurePhase = "render" | "runtime" | "promise" | "compile";

export const RUNTIME_UI_HEALTH_MAX_MESSAGE = 2_048;
export const RUNTIME_UI_HEALTH_MAX_STACK = 4_096;

function isFailurePhase(value: unknown): value is RuntimeUiViewFailurePhase {
  return value === "render" || value === "runtime" || value === "promise" || value === "compile";
}

/** What a renderer (or the observer harness) sends to main. */
export interface RuntimeUiViewHealthReport {
  readonly scope: RuntimeUiScope;
  readonly instanceId: string;
  /** The owning render id (the authored application id). */
  readonly applicationId?: string;
  readonly status: "ok" | "failing";
  readonly phase?: RuntimeUiViewFailurePhase;
  readonly message?: string;
  readonly stack?: string;
  /** Compiled component id of the revision that produced this report. */
  readonly revision?: string;
}

export interface RuntimeUiViewHealth {
  readonly instanceId: string;
  readonly sessionId?: string;
  readonly applicationId?: string;
  readonly status: RuntimeUiViewHealthStatus;
  readonly phase?: RuntimeUiViewFailurePhase;
  readonly message?: string;
  readonly stack?: string;
  readonly revision?: string;
  /** ISO time the current status began. */
  readonly since: string;
}

export interface RuntimeUiRenderHealthNotification {
  readonly status: "ok" | "failing";
  readonly phase?: RuntimeUiViewFailurePhase;
  readonly message?: string;
  readonly stack?: string;
  readonly revision?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

/** Bounds and validates a render-health notification from the sandboxed document. */
export function parseRuntimeUiRenderHealthNotification(
  method: string,
  params: unknown,
): RuntimeUiRenderHealthNotification | undefined {
  const body = isRecord(params) ? params : {};
  const revision = clip(body.componentId, 128);
  if (method === "ui/notifications/rendered") {
    return { status: "ok", ...(revision ? { revision } : {}) };
  }
  if (method !== "ui/notifications/render-error") return undefined;
  const phase = isFailurePhase(body.phase) ? body.phase : "runtime";
  const message = clip(body.message, RUNTIME_UI_HEALTH_MAX_MESSAGE) ?? "Unknown error";
  const stack = clip(body.stack, RUNTIME_UI_HEALTH_MAX_STACK);
  return {
    status: "failing",
    phase,
    message,
    ...(stack ? { stack } : {}),
    ...(revision ? { revision } : {}),
  };
}

const MAX_LINE_MESSAGE = 200;

function inertLine(value: string): string {
  const flat = value
    .replace(/[\r\n\t"[\]<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_LINE_MESSAGE ? `${flat.slice(0, MAX_LINE_MESSAGE - 1)}…` : flat;
}

/** The current-state clause appended to a failing view's line in the per-turn view list. */
export function describeViewHealthFailure(health: RuntimeUiViewHealth | undefined): string {
  if (health?.status !== "failing") return "";
  const detail = inertLine(health.message ?? "unknown error");
  return ` — not rendering: ${health.phase ?? "runtime"}: ${detail}. This is current state; it disappears once the view renders.`;
}
