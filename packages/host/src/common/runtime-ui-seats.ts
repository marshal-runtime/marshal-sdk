/**
 * Host seats a session-authored view can occupy beyond docks and conversation
 * cards. A seat view is an ordinary sandboxed authored view (same iframe, CSP,
 * declared capabilities, permission policy); the seat only decides where the
 * host mounts it. Seat views live on the `inline-card` surface with a `seat`
 * marker, so persistence, `ui.layout.get`, `ui.view.move`, and close work
 * unchanged.
 */

export const RUNTIME_UI_OVERLAY_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type RuntimeUiOverlayAnchor = (typeof RUNTIME_UI_OVERLAY_ANCHORS)[number];

export const RUNTIME_UI_DEFAULT_OVERLAY_ANCHOR: RuntimeUiOverlayAnchor = "bottom-right";
export const RUNTIME_UI_CHAT_HEADER_MODES = ["popover", "widget"] as const;
export type RuntimeUiChatHeaderMode = (typeof RUNTIME_UI_CHAT_HEADER_MODES)[number];

export const RUNTIME_UI_SEAT_PLACEMENTS = ["overlay", "tool-result", "chat-header"] as const;
export type RuntimeUiSeatPlacement = (typeof RUNTIME_UI_SEAT_PLACEMENTS)[number];

export const RUNTIME_UI_OVERLAY_MAX_WIDTH = 640;
export const RUNTIME_UI_OVERLAY_MAX_HEIGHT = 480;
export const RUNTIME_UI_OVERLAY_DEFAULT_WIDTH = 320;
export const RUNTIME_UI_OVERLAY_DEFAULT_HEIGHT = 120;
export const RUNTIME_UI_SEAT_MAX_PER_SESSION = 6;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_LABEL_LENGTH = 40;

/** A frame-wide click-through layer above every column. */
export interface RuntimeUiOverlaySeat {
  readonly kind: "overlay";
  readonly anchor: RuntimeUiOverlayAnchor;
  /** Pixels; clamped to the overlay maximum. */
  readonly width: number;
  readonly height: number;
  /** Whether the view can be clicked; false leaves the pointer to the app underneath. */
  readonly interactive: boolean;
}

/** The renderer for one tool's results in the owning session's chat. */
export interface RuntimeUiToolResultSeat {
  readonly kind: "tool-result";
  /** The normalized tool name the chat renderer shows (see normalizeActivityToolName). */
  readonly toolName: string;
}

/** An action in the chat header that opens the view or shows it compactly. */
export interface RuntimeUiChatHeaderSeat {
  readonly kind: "chat-header";
  readonly label: string;
  readonly mode: RuntimeUiChatHeaderMode;
  readonly width: number;
  readonly height: number;
}

export type RuntimeUiSeat =
  | RuntimeUiOverlaySeat
  | RuntimeUiToolResultSeat
  | RuntimeUiChatHeaderSeat;

/** Open-time seat fields as an agent supplies them; every field but the kind is optional. */
export interface RuntimeUiSeatRequest {
  readonly kind: RuntimeUiSeat["kind"];
  readonly anchor?: string;
  readonly width?: number;
  readonly height?: number;
  readonly interactive?: boolean;
  readonly toolName?: string;
  readonly label?: string;
  readonly mode?: string;
}

export function isRuntimeUiSeatPlacement(value: unknown): value is RuntimeUiSeatPlacement {
  return RUNTIME_UI_SEAT_PLACEMENTS.some((placement) => placement === value);
}

/** The agent-facing placement name for a seat view. */
export function placementForSeat(seat: RuntimeUiSeat): RuntimeUiSeatPlacement {
  return seat.kind;
}

/** Tool names compare case-insensitively with separators folded, matching the chat's normalized names. */
export function normalizeSeatToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s.:/-]+/g, "_");
}

function clamp(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(80, Math.min(max, Math.round(value)));
}

type Fail = (message: string) => Error;

/** Validates a seat request into the persisted seat; throws through `fail` on invalid input. */
export function normalizeSeatRequest(value: unknown, fail: Fail): RuntimeUiSeat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("Seat must be an object.");
  }
  const request: Partial<RuntimeUiSeatRequest> = Object.fromEntries(Object.entries(value));
  if (request.kind === "overlay") {
    const anchor = request.anchor ?? RUNTIME_UI_DEFAULT_OVERLAY_ANCHOR;
    const known = RUNTIME_UI_OVERLAY_ANCHORS.find((candidate) => candidate === anchor);
    if (!known) {
      throw fail(`Overlay anchor must be one of: ${RUNTIME_UI_OVERLAY_ANCHORS.join(", ")}.`);
    }
    return {
      kind: "overlay",
      anchor: known,
      width: clamp(request.width, RUNTIME_UI_OVERLAY_DEFAULT_WIDTH, RUNTIME_UI_OVERLAY_MAX_WIDTH),
      height: clamp(
        request.height,
        RUNTIME_UI_OVERLAY_DEFAULT_HEIGHT,
        RUNTIME_UI_OVERLAY_MAX_HEIGHT,
      ),
      interactive: request.interactive !== false,
    };
  }
  if (request.kind === "tool-result") {
    const toolName = typeof request.toolName === "string" ? request.toolName.trim() : "";
    if (!toolName || toolName.length > MAX_TOOL_NAME_LENGTH) {
      throw fail(
        `tool-result placement needs toolName (1-${MAX_TOOL_NAME_LENGTH} characters), the tool name the chat shows.`,
      );
    }
    return { kind: "tool-result", toolName: normalizeSeatToolName(toolName) };
  }
  if (request.kind === "chat-header") {
    const label = typeof request.label === "string" ? request.label.trim() : "";
    if (!label || label.length > MAX_LABEL_LENGTH) {
      throw fail(`chat-header placement needs label (1-${MAX_LABEL_LENGTH} characters).`);
    }
    const mode = request.mode ?? "popover";
    const known = RUNTIME_UI_CHAT_HEADER_MODES.find((candidate) => candidate === mode);
    if (!known) {
      throw fail(`chat-header mode must be one of: ${RUNTIME_UI_CHAT_HEADER_MODES.join(", ")}.`);
    }
    return {
      kind: "chat-header",
      label,
      mode: known,
      width: clamp(request.width, 360, RUNTIME_UI_OVERLAY_MAX_WIDTH),
      height: clamp(request.height, 240, RUNTIME_UI_OVERLAY_MAX_HEIGHT),
    };
  }
  throw fail(`Seat kind must be one of: ${RUNTIME_UI_SEAT_PLACEMENTS.join(", ")}.`);
}

/** Props every tool-result seat view receives per tool call. */
export type RuntimeUiToolResultProps = {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly callId: string | null;
};

export interface RuntimeUiSeatDescriptor {
  readonly id: string;
  readonly placement: RuntimeUiSeatPlacement;
  readonly title: string;
  readonly description: string;
  readonly cardinality: "list" | "keyed";
  /** `runtimeShowUi` arguments that configure the seat. */
  readonly params: Readonly<Record<string, string>>;
  /** Props the view's default export receives from the host, when the seat supplies any. */
  readonly props?: Readonly<Record<string, string>>;
  readonly limits: Readonly<Record<string, number | string>>;
  readonly behavior: readonly string[];
}

/**
 * Seats session-authored views can occupy through `runtimeShowUi`. The
 * `ui.surfaces.describe` capability reads this registry; add a seat here when
 * a new host contribution point is opened to authored views.
 */
export const RUNTIME_UI_SESSION_SEATS: readonly RuntimeUiSeatDescriptor[] = Object.freeze([
  Object.freeze({
    id: "shell.overlay",
    placement: "overlay",
    title: "Frame-wide overlay",
    description:
      "A layer above the whole session frame (chat and docks) for toasts, status pills, and floating widgets. Click-through except on the view itself.",
    cardinality: "list",
    params: Object.freeze({
      anchor: `one of ${RUNTIME_UI_OVERLAY_ANCHORS.join(", ")} (default ${RUNTIME_UI_DEFAULT_OVERLAY_ANCHOR}); views at one anchor stack`,
      width: `pixels, default ${RUNTIME_UI_OVERLAY_DEFAULT_WIDTH}, max ${RUNTIME_UI_OVERLAY_MAX_WIDTH}`,
      height: `pixels, default ${RUNTIME_UI_OVERLAY_DEFAULT_HEIGHT}, max ${RUNTIME_UI_OVERLAY_MAX_HEIGHT}`,
      interactive: "false makes the view click-through too (default true)",
      timeoutMs: "optional auto-dismiss; omit to keep it until closed",
    }),
    limits: Object.freeze({ maxPerSession: RUNTIME_UI_SEAT_MAX_PER_SESSION }),
    behavior: Object.freeze([
      "Every overlay shows a dismiss control and its owner session label.",
      "Persisted with the session and restored (not when timeoutMs is set); ui.view.move to another placement removes the seat.",
      "On phones the overlay sits above the session view.",
    ]),
  }),
  Object.freeze({
    id: "chat.tool-result",
    placement: "tool-result",
    title: "Tool result renderer",
    description:
      "Renders one tool's results in this session's chat next to the default tool row, with a toggle back to the default. One renderer per tool name: when several views register for a tool, the newest wins.",
    cardinality: "keyed",
    params: Object.freeze({
      toolName: "required: the tool name as the chat shows it, matched case-insensitively",
    }),
    props: Object.freeze({
      toolName: "string",
      input: "parsed JSON input when it parses, else the raw string",
      output: "parsed JSON output when it parses, else the raw string",
      status: "running | completed | failed | cancelled",
      callId: "string | null",
    }),
    limits: Object.freeze({ inputBytes: 65_536, outputBytes: 65_536 }),
    behavior: Object.freeze([
      "Receives props again whenever the call's status or output changes.",
      "Falls back to the default row if the view is closed; the user can switch back per call.",
    ]),
  }),
  Object.freeze({
    id: "chat.header.action",
    placement: "chat-header",
    title: "Chat header action",
    description:
      "A button in this session's chat header. popover opens the view in a popover; widget shows it compactly in the header.",
    cardinality: "list",
    params: Object.freeze({
      label: "required: button text, at most 40 characters",
      mode: "popover (default) or widget",
      width: `popover width in pixels, max ${RUNTIME_UI_OVERLAY_MAX_WIDTH}`,
      height: `popover height in pixels, max ${RUNTIME_UI_OVERLAY_MAX_HEIGHT}`,
    }),
    limits: Object.freeze({ maxPerSession: RUNTIME_UI_SEAT_MAX_PER_SESSION }),
    behavior: Object.freeze([
      "Shown only in the owning session's chat.",
      "On phones the actions sit in a strip above the session view and open full width.",
    ]),
  }),
]);
