import {
  RUNTIME_UI_SURFACES,
  type RuntimeUiSurface,
  type RuntimeUiViewOptions,
} from "../../common/runtime-ui";
import {
  isRuntimeUiPlacementName,
  RUNTIME_UI_PLACEMENT_NAMES,
  surfaceForPlacement,
} from "../../common/runtime-ui-layout";
import {
  isRuntimeUiSeatPlacement,
  RUNTIME_UI_OVERLAY_ANCHORS,
  RUNTIME_UI_CHAT_HEADER_MODES,
  type RuntimeUiSeatRequest,
} from "../../common/runtime-ui-seats";

/** Capability-schema properties shared by every call that places a view. */
export const VIEW_OPTION_PROPERTIES = {
  title: { type: "string", minLength: 1, maxLength: 256 },
  slot: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" },
  afterMessageId: { type: "string", minLength: 1, maxLength: 256 },
  timeoutMs: { type: "integer", minimum: 1_000, maximum: 86_400_000 },
  anchor: { enum: RUNTIME_UI_OVERLAY_ANCHORS },
  width: { type: "integer", minimum: 80, maximum: 640 },
  height: { type: "integer", minimum: 80, maximum: 480 },
  interactive: { type: "boolean" },
  toolName: { type: "string", minLength: 1, maxLength: 128 },
  label: { type: "string", minLength: 1, maxLength: 40 },
  mode: { enum: RUNTIME_UI_CHAT_HEADER_MODES },
} as const;

export const PLACEMENT_PROPERTY = {
  placement: { enum: RUNTIME_UI_PLACEMENT_NAMES },
} as const;

export const PLACEMENT_DESCRIPTION =
  "Pass placement to choose where the view goes: chat-tab (a tab beside Chat), side (the right dock), bottom (the dock under the chat), floating (a movable window), card (a permanent card in the conversation; add slot to render inside your message at a <!--ui:<slot>--> line you write in your final reply after this call, or afterMessageId), transient (a card just above the chat input that is not part of the conversation and closes when you close it, the user dismisses it, or timeoutMs passes), or fullscreen. Host seats: overlay (a click-through layer above the whole session frame for toasts, pills, and floating widgets; anchor, width, height, optional timeoutMs), tool-result (renders one tool's results in this session's chat, with props {toolName, input, output, status, callId}; needs toolName), chat-header (a button in the chat header; needs label, mode popover or widget). Opening never replaces another view; every view becomes its own tab or card.";

export interface ParsedPlacement {
  readonly surface: RuntimeUiSurface;
  readonly options: RuntimeUiViewOptions;
}

/**
 * Resolves `placement` (preferred) or the legacy `surface` plus the card and
 * transient options into a surface and view options. `fallbackTransient`
 * decides what a bare inline card means for the calling capability.
 */
export function parsePlacementInput(
  value: Readonly<Record<string, unknown>>,
  options: { readonly fallbackSurface?: RuntimeUiSurface; readonly fallbackTransient: boolean },
): ParsedPlacement {
  const placement = value.placement;
  if (placement !== undefined && !isRuntimeUiPlacementName(placement)) {
    throw new TypeError(
      `Runtime UI placement must be one of: ${RUNTIME_UI_PLACEMENT_NAMES.join(", ")}.`,
    );
  }
  const legacySurface = RUNTIME_UI_SURFACES.find((surface) => surface === value.surface);
  if (value.surface !== undefined && !legacySurface) {
    throw new TypeError("Runtime UI surface is invalid.");
  }
  const surface =
    (placement ? surfaceForPlacement(placement) : undefined) ??
    legacySurface ??
    options.fallbackSurface;
  if (!surface) throw new TypeError("Runtime UI placement or surface is required.");

  const slot = optionalString(value.slot, "slot");
  const afterMessageId = optionalString(value.afterMessageId, "afterMessageId");
  const title = optionalString(value.title, "title");
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new TypeError("Runtime UI timeoutMs must be a number.");
  }
  const anchored = slot !== undefined || afterMessageId !== undefined;
  const seat = isRuntimeUiSeatPlacement(placement) ? seatRequest(placement, value) : undefined;
  if (seat && anchored) {
    throw new TypeError("slot and afterMessageId do not apply to host seat placements.");
  }
  if (seat && timeoutMs !== undefined && seat.kind !== "overlay") {
    throw new TypeError("timeoutMs applies to overlay seats only.");
  }
  const transient =
    surface === "inline-card" &&
    (placement === "transient" ||
      (seat?.kind === "overlay" && timeoutMs !== undefined) ||
      timeoutMs !== undefined ||
      (placement === undefined && !anchored && options.fallbackTransient));
  if (anchored && surface !== "inline-card") {
    throw new TypeError("slot and afterMessageId only apply to card placement.");
  }
  if (timeoutMs !== undefined && !transient) {
    throw new TypeError("timeoutMs only applies to transient placement.");
  }
  return {
    surface,
    options: {
      ...(title ? { title } : {}),
      ...(seat ? { seat } : {}),
      ...(transient ? { transient: timeoutMs === undefined ? {} : { timeoutMs } } : {}),
      ...(anchored
        ? {
            anchor: {
              ...(slot ? { slot } : {}),
              ...(afterMessageId ? { afterMessageId } : {}),
            },
          }
        : {}),
    },
  };
}

function seatRequest(
  kind: RuntimeUiSeatRequest["kind"],
  value: Readonly<Record<string, unknown>>,
): RuntimeUiSeatRequest {
  const text = (field: string): string | undefined => {
    const entry = value[field];
    return typeof entry === "string" ? entry : undefined;
  };
  const size = (field: string): number | undefined => {
    const entry = value[field];
    return typeof entry === "number" ? entry : undefined;
  };
  return {
    kind,
    ...(text("anchor") !== undefined ? { anchor: text("anchor") } : {}),
    ...(text("toolName") !== undefined ? { toolName: text("toolName") } : {}),
    ...(text("label") !== undefined ? { label: text("label") } : {}),
    ...(text("mode") !== undefined ? { mode: text("mode") } : {}),
    ...(size("width") !== undefined ? { width: size("width") } : {}),
    ...(size("height") !== undefined ? { height: size("height") } : {}),
    ...(typeof value.interactive === "boolean" ? { interactive: value.interactive } : {}),
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Runtime UI ${label} must be a non-empty string.`);
  }
  return value.trim();
}
