import {
  RUNTIME_UI_HOST_PLACEMENTS,
  type RuntimeUiPlacementMetadata,
  type RuntimeUiSurface,
} from "./runtime-ui";
import {
  RUNTIME_UI_PLACEMENT_NAMES,
  surfaceForPlacement,
  type RuntimeUiPlacementName,
} from "./runtime-ui-layout";
import { RUNTIME_UI_SESSION_SEATS, type RuntimeUiSeatPlacement } from "./runtime-ui-seats";
import { MARSHAL_UI_THEME_TOKENS } from "./runtime-ui-theme";
import { AUTHORED_UI_CLIENT_VIEWPORT_PROP } from "./runtime-ui-viewports";

function seatSemantics(placement: RuntimeUiSeatPlacement): {
  readonly description: string;
  readonly persisted: boolean;
  readonly notes?: string;
} {
  const seat = RUNTIME_UI_SESSION_SEATS.find((candidate) => candidate.placement === placement);
  return {
    description: seat?.description ?? placement,
    persisted: true,
    ...(seat ? { notes: seat.behavior.join(" ") } : {}),
  };
}

/** What each agent-facing placement means. Keyed by the placement names `runtimeShowUi` accepts. */
export const RUNTIME_UI_PLACEMENT_SEMANTICS: Readonly<
  Record<
    RuntimeUiPlacementName,
    { readonly description: string; readonly persisted: boolean; readonly notes?: string }
  >
> = Object.freeze({
  "chat-tab": {
    description: "A tab beside Chat in the main dock. Long-lived workspaces.",
    persisted: true,
  },
  side: {
    description: "The right dock. Evidence, documents, inspectors.",
    persisted: true,
  },
  bottom: {
    description: "The dock under the chat. Terminals, logs, run output.",
    persisted: true,
  },
  floating: { description: "A movable window above the layout.", persisted: true },
  card: {
    description:
      "A permanent card in the conversation. With `slot` it renders inside the assistant message that contains the marker `<!--ui:<slot>-->` and stays hidden until the marker is on screen; with `afterMessageId` it sits after that message.",
    persisted: true,
    notes: "Default placement. Slot ids match ^[A-Za-z0-9_.-]{1,64}$.",
  },
  transient: {
    description:
      "A card docked just above the chat input (bottom sheet on phones). Not saved; closes on dismiss, on close, or after `timeoutMs` (1s to 24h).",
    persisted: false,
    notes: "Use for sign-ins, confirmations, short-lived prompts. Close it when its job is done.",
  },
  fullscreen: { description: "A chat tab, maximized.", persisted: true },
  overlay: seatSemantics("overlay"),
  "tool-result": seatSemantics("tool-result"),
  "chat-header": seatSemantics("chat-header"),
});

export type RuntimeUiSeatKind = "session-placement" | "host-contribution";

/** One place a view can appear, and whether a session-authored view can use it. */
export interface RuntimeUiSeatDescriptor {
  readonly id: string;
  readonly kind: RuntimeUiSeatKind;
  readonly title: string;
  readonly description: string;
  /** True when `runtimeShowUi` can put a session-authored view here. */
  readonly sessionViewsCanUse: boolean;
  /** How a caller reaches the seat (the `runtimeShowUi` argument or the extension contribution). */
  readonly reachedBy: string;
  readonly surface?: RuntimeUiSurface;
  /** Seat arguments, props, limits and behavior, for seats that take more than a placement name. */
  readonly details?: Readonly<{
    cardinality: "list" | "keyed";
    params: Readonly<Record<string, string>>;
    props?: Readonly<Record<string, string>>;
    limits: Readonly<Record<string, number | string>>;
    behavior: readonly string[];
  }>;
}

/**
 * Seats other lanes add: overlay, tool-result renderer, chat-header. Append one
 * entry per seat; `ui.surfaces.describe` lists them next to the placements and
 * the extension-only host contribution points.
 */
export const RUNTIME_UI_ADDITIONAL_SEATS: readonly RuntimeUiSeatDescriptor[] = Object.freeze(
  RUNTIME_UI_SESSION_SEATS.map(
    (seat): RuntimeUiSeatDescriptor => ({
      id: seat.placement,
      kind: "session-placement",
      title: seat.title,
      description: seat.description,
      sessionViewsCanUse: true,
      reachedBy: `runtimeShowUi {placement: "${seat.placement}"${Object.keys(seat.params)
        .map((param) => `, ${param}`)
        .join("")}}`,
      surface: "inline-card",
      details: {
        cardinality: seat.cardinality,
        params: seat.params,
        ...(seat.props ? { props: seat.props } : {}),
        limits: seat.limits,
        behavior: seat.behavior,
      },
    }),
  ),
);

function hostContributionSeat(metadata: RuntimeUiPlacementMetadata): RuntimeUiSeatDescriptor {
  return {
    id: metadata.id,
    kind: "host-contribution",
    title: metadata.title,
    description: metadata.description,
    sessionViewsCanUse: false,
    reachedBy: "extension manifest contribution",
  };
}

export function listRuntimeUiSeats(
  additional: readonly RuntimeUiSeatDescriptor[] = RUNTIME_UI_ADDITIONAL_SEATS,
): readonly RuntimeUiSeatDescriptor[] {
  const detailed = new Set(additional.map((seat) => seat.id));
  const placements = RUNTIME_UI_PLACEMENT_NAMES.filter((name) => !detailed.has(name)).map(
    (name): RuntimeUiSeatDescriptor => ({
      id: name,
      kind: "session-placement",
      title: name,
      description: RUNTIME_UI_PLACEMENT_SEMANTICS[name].description,
      sessionViewsCanUse: true,
      reachedBy: `runtimeShowUi {placement: "${name}"}`,
      surface: surfaceForPlacement(name),
    }),
  );
  const seen = new Set<string>();
  return [...placements, ...RUNTIME_UI_HOST_PLACEMENTS.map(hostContributionSeat), ...additional]
    .filter((seat) => {
      if (seen.has(seat.id)) return false;
      seen.add(seat.id);
      return true;
    })
    .map((seat) => Object.freeze({ ...seat }));
}

export const MARSHAL_CLIENT_METHODS = Object.freeze([
  {
    name: "marshal.sendMessage({role: 'user', content: [{type: 'text', text}]})",
    description:
      "Sends a message into the session that opened this view. It arrives attributed to the view, as untrusted UI-originated text, and starts or queues a turn. At most 4 KB, 3 in a burst, then one per 2 s.",
  },
  {
    name: "marshal.updateModelContext({content: [{type: 'text', text}]})",
    description:
      "Replaces this view's context line in the agent's per-turn view list. At most 4 KB, replaced on every call, cleared when the view closes. No turn starts.",
  },
  {
    name: "marshal.subscribe(listener)",
    description: "Host-context changes: theme, display mode, container size.",
  },
  {
    name: "marshal.requestDisplayMode('inline'|'fullscreen'|'pip')",
    description: "Typed result granted | unsupported | denied | fallback | timed_out.",
  },
  {
    name: "marshal.openLink({url})",
    description: "Opens an http(s) link through the host's validated opener.",
  },
] as const);

export const AUTHORED_UI_COMPONENT_CONTRACT = Object.freeze({
  module: "One TSX file whose default export is a React component.",
  props: [
    "Everything you pass as `props` to runtimeShowUi.",
    `\`${AUTHORED_UI_CLIENT_VIEWPORT_PROP}\`: "mobile" | "desktop", the viewing client (injected by the host).`,
    "`marshal`: the host client (methods below). Present on every runtimeShowUi view.",
  ],
  marshalClient: MARSHAL_CLIENT_METHODS,
  persistedState:
    "`localStorage` inside the view is shimmed and persists per view across reloads; the agent reads it with `ui.view.state.get {instanceId}`.",
  sandbox:
    "Network-denied allow-scripts iframe behind a strict CSP. No fetch, no capability calls except through the declared `marshal` client.",
  viewports:
    "A view renders only on the viewports it was given (`views: {desktop, mobile}` or `viewports`).",
});

/**
 * Host theme tokens visible to authored views, with the values Marshal's
 * stylesheet resolves to in each theme (src/index.css). One list, read by
 * `ui.surfaces.describe` and by the sandbox theme stamp.
 */
export interface RuntimeUiThemeToken {
  readonly name: string;
  /** The host CSS variable the value is read from. */
  readonly source: string;
  readonly light: string;
  readonly dark: string;
}

export const RUNTIME_UI_THEME_TOKENS: readonly RuntimeUiThemeToken[] = MARSHAL_UI_THEME_TOKENS;

/** Bounds on what a view can say back to the agent or have read from it. */
export const UI_VIEW_MESSAGE_MAX_BYTES = 4 * 1024;
export const UI_VIEW_MODEL_CONTEXT_MAX_BYTES = 4 * 1024;
export const UI_VIEW_STATE_MAX_BYTES = 64 * 1024;
