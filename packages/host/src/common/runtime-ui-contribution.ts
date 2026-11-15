/**
 * Host-side contribution metadata for runtime UI applications. Declared on the
 * published application's `metadata` record (same pattern as
 * `marshal.ui.viewports`): the runtime carries it verbatim, the host interprets it.
 *
 * - `marshal.ui.contribution`: what the application does at its placements
 *   (embedded view, native item, or edits to the host's default parts).
 * - `marshal.ui.icon`: icon wherever the application appears.
 * - `marshal.ui.theme`: allowlisted theme tokens (parse + validate only here).
 *
 * Parsing is strict: anything invalid is dropped and reported as a diagnostic,
 * never thrown.
 */

import { MARSHAL_UI_THEME_TOKEN_NAMES } from "./runtime-ui-theme";

export const MARSHAL_UI_CONTRIBUTION_METADATA_KEY = "marshal.ui.contribution";
export const MARSHAL_UI_ICON_METADATA_KEY = "marshal.ui.icon";
export const MARSHAL_UI_THEME_METADATA_KEY = "marshal.ui.theme";

export const UI_ITEM_TYPES = ["button", "badge", "link", "menu-item", "text"] as const;
export type UiItemType = (typeof UI_ITEM_TYPES)[number];

export const UI_TONES = ["neutral", "accent", "positive", "warning", "negative", "muted"] as const;
export type UiTone = (typeof UI_TONES)[number];

/**
 * `lucide` and `resource` are what authors declare; the host resolves a
 * `resource` to an `image` (data URL) before it reaches the renderer.
 */
export type UiIcon =
  | { readonly kind: "lucide"; readonly name: string }
  | { readonly kind: "resource"; readonly resource: string }
  | { readonly kind: "image"; readonly src: string };

export type UiWhenValue = string | readonly string[] | boolean;
export type UiWhen = Readonly<Record<string, UiWhenValue>>;

export type UiItemAction =
  | {
      readonly type: "capability";
      readonly capability: string;
      readonly input?: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "open"; readonly applicationId: string; readonly surface?: string }
  | { readonly type: "prompt"; readonly text: string };

export interface UiItemPosition {
  readonly before?: string;
  readonly after?: string;
}

export interface UiItemDynamic {
  readonly capability: string;
  readonly refreshMs?: number;
}

export interface UiContributionItem {
  readonly type: UiItemType;
  readonly label: string;
  readonly icon?: UiIcon;
  readonly tooltip?: string;
  readonly tone?: UiTone;
  readonly position?: UiItemPosition;
  readonly when?: UiWhen;
  readonly action?: UiItemAction;
  readonly dynamic?: UiItemDynamic;
}

export type UiEditOp =
  | { readonly op: "hide" | "show"; readonly placementId: string; readonly part: string }
  | {
      readonly op: "relabel";
      readonly placementId: string;
      readonly part: string;
      readonly label: string;
    }
  | {
      readonly op: "icon";
      readonly placementId: string;
      readonly part: string;
      readonly icon: UiIcon;
    }
  | {
      readonly op: "tone";
      readonly placementId: string;
      readonly part: string;
      readonly tone: UiTone;
    }
  | {
      readonly op: "tooltip";
      readonly placementId: string;
      readonly part: string;
      readonly tooltip: string;
    }
  | {
      readonly op: "move";
      readonly placementId: string;
      readonly part: string;
      readonly before?: string;
      readonly after?: string;
    }
  | { readonly op: "order"; readonly placementId: string; readonly parts: readonly string[] }
  | {
      readonly op: "when";
      readonly placementId: string;
      readonly part: string;
      readonly when: UiWhen;
    };

export type UiContribution =
  | { readonly kind: "view"; readonly position?: UiItemPosition }
  | { readonly kind: "item"; readonly item: UiContributionItem }
  | { readonly kind: "edits"; readonly edits: readonly UiEditOp[] };

export interface UiContributionDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface ParseResult<T> {
  readonly value: T | undefined;
  readonly diagnostics: readonly UiContributionDiagnostic[];
}

const MAX_LABEL = 80;
const MAX_TOOLTIP = 240;
const MAX_PROMPT = 4_000;
const MAX_EDITS = 64;
const MAX_WHEN_KEYS = 8;
const MAX_WHEN_VALUES = 16;
const MAX_ORDER_PARTS = 64;
const MAX_REFRESH_MS_FLOOR = 1_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LUCIDE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WHEN_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/;
const OPEN_SURFACES: ReadonlySet<string> = new Set([
  "inline-card",
  "fullscreen",
  "tab",
  "panel",
  "bottom-panel",
  "floating",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail<T>(code: string, message: string): ParseResult<T> {
  return { value: undefined, diagnostics: [{ code, message }] };
}

function ok<T>(value: T): ParseResult<T> {
  return { value, diagnostics: [] };
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

export function parseUiIcon(raw: unknown): ParseResult<UiIcon> {
  if (typeof raw === "string") {
    if (!raw.startsWith("lucide:")) {
      return fail("invalid-icon", `Icon "${raw}" must be "lucide:<kebab-name>" or {resource}.`);
    }
    const name = raw.slice("lucide:".length);
    if (!LUCIDE_NAME_PATTERN.test(name) || name.length > 64) {
      return fail("invalid-icon", `Lucide icon name "${name}" is not a kebab-case name.`);
    }
    return ok({ kind: "lucide", name });
  }
  if (isRecord(raw) && raw.kind === "lucide" && typeof raw.name === "string") {
    return parseUiIcon(`lucide:${raw.name}`);
  }
  if (isRecord(raw) && typeof raw.resource === "string") {
    const resource = boundedString(raw.resource, 512);
    if (!resource) return fail("invalid-icon", "Icon resource must be a non-empty uri.");
    return ok({ kind: "resource", resource });
  }
  return fail("invalid-icon", "Icon must be a string like lucide:rocket or {resource: uri}.");
}

export function parseUiWhen(raw: unknown): ParseResult<UiWhen> {
  if (!isRecord(raw)) return fail("invalid-when", "`when` must be an object.");
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_WHEN_KEYS) {
    return fail("invalid-when", `\`when\` needs 1-${MAX_WHEN_KEYS} context paths.`);
  }
  const result: Record<string, UiWhenValue> = {};
  for (const [path, value] of entries) {
    if (!WHEN_PATH_PATTERN.test(path)) {
      return fail("invalid-when", `\`when\` path "${path}" is not a context path.`);
    }
    if (typeof value === "boolean") result[path] = value;
    else if (typeof value === "string" && value.length <= 200) result[path] = value;
    else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_WHEN_VALUES &&
      value.every((entry): entry is string => typeof entry === "string" && entry.length <= 200)
    ) {
      result[path] = [...value];
    } else {
      return fail(
        "invalid-when",
        `\`when\` value for "${path}" must be a string, string[] or boolean.`,
      );
    }
  }
  return ok(result);
}

function parseTone(raw: unknown): UiTone | undefined {
  return UI_TONES.find((tone) => tone === raw);
}

function parseAction(raw: unknown): ParseResult<UiItemAction> {
  if (!isRecord(raw)) return fail("invalid-action", "`action` must be an object.");
  if (raw.type === "capability") {
    if (typeof raw.capability !== "string" || !CAPABILITY_PATTERN.test(raw.capability)) {
      return fail("invalid-action", "Capability action needs a valid `capability` name.");
    }
    if (raw.input !== undefined && !isRecord(raw.input)) {
      return fail("invalid-action", "Capability action `input` must be an object.");
    }
    return ok({
      type: "capability",
      capability: raw.capability,
      ...(raw.input ? { input: { ...raw.input } } : {}),
    });
  }
  if (raw.type === "open") {
    const applicationId = boundedString(raw.applicationId, 256);
    if (!applicationId) return fail("invalid-action", "Open action needs an `applicationId`.");
    if (
      raw.surface !== undefined &&
      (typeof raw.surface !== "string" || !OPEN_SURFACES.has(raw.surface))
    ) {
      return fail("invalid-action", "Open action `surface` is not a known surface.");
    }
    return ok({
      type: "open",
      applicationId,
      ...(typeof raw.surface === "string" ? { surface: raw.surface } : {}),
    });
  }
  if (raw.type === "prompt") {
    const text = boundedString(raw.text, MAX_PROMPT);
    if (!text) return fail("invalid-action", `Prompt action needs 1-${MAX_PROMPT} chars of text.`);
    return ok({ type: "prompt", text });
  }
  return fail("invalid-action", 'Action `type` must be "capability", "open" or "prompt".');
}

function parseItem(raw: unknown): ParseResult<UiContributionItem> {
  if (!isRecord(raw)) return fail("invalid-item", "`item` must be an object.");
  const type = UI_ITEM_TYPES.find((candidate) => candidate === raw.type);
  if (!type) return fail("invalid-item", `Item type must be one of ${UI_ITEM_TYPES.join(", ")}.`);
  const label = boundedString(raw.label, MAX_LABEL);
  if (!label) return fail("invalid-item", `Item label must be 1-${MAX_LABEL} characters.`);
  const diagnostics: UiContributionDiagnostic[] = [];
  let icon: UiIcon | undefined;
  if (raw.icon !== undefined) {
    const parsed = parseUiIcon(raw.icon);
    if (!parsed.value) return { value: undefined, diagnostics: parsed.diagnostics };
    icon = parsed.value;
  }
  let tooltip: string | undefined;
  if (raw.tooltip !== undefined) {
    tooltip = boundedString(raw.tooltip, MAX_TOOLTIP);
    if (!tooltip) return fail("invalid-item", `Item tooltip must be 1-${MAX_TOOLTIP} characters.`);
  }
  let tone: UiTone | undefined;
  if (raw.tone !== undefined) {
    tone = parseTone(raw.tone);
    if (!tone) return fail("invalid-item", `Item tone must be one of ${UI_TONES.join(", ")}.`);
  }
  let position: UiItemPosition | undefined;
  if (raw.position !== undefined) {
    position = parseItemPosition(raw.position);
    if (!position) {
      return fail("invalid-item", "Item `position` takes exactly one of before/after, a part id.");
    }
  }
  let when: UiWhen | undefined;
  if (raw.when !== undefined) {
    const parsed = parseUiWhen(raw.when);
    if (!parsed.value) return { value: undefined, diagnostics: parsed.diagnostics };
    when = parsed.value;
  }
  let action: UiItemAction | undefined;
  if (raw.action !== undefined) {
    const parsed = parseAction(raw.action);
    if (!parsed.value) return { value: undefined, diagnostics: parsed.diagnostics };
    action = parsed.value;
  }
  let dynamic: UiItemDynamic | undefined;
  if (raw.dynamic !== undefined) {
    if (
      !isRecord(raw.dynamic) ||
      typeof raw.dynamic.capability !== "string" ||
      !CAPABILITY_PATTERN.test(raw.dynamic.capability)
    ) {
      return fail("invalid-item", "Item `dynamic` needs a valid `capability` name.");
    }
    const refreshMs = raw.dynamic.refreshMs;
    if (
      refreshMs !== undefined &&
      (typeof refreshMs !== "number" ||
        !Number.isFinite(refreshMs) ||
        refreshMs < MAX_REFRESH_MS_FLOOR)
    ) {
      return fail(
        "invalid-item",
        `Item dynamic.refreshMs must be a number >= ${MAX_REFRESH_MS_FLOOR}.`,
      );
    }
    dynamic = {
      capability: raw.dynamic.capability,
      ...(typeof refreshMs === "number" ? { refreshMs: Math.floor(refreshMs) } : {}),
    };
  }
  return {
    value: {
      type,
      label,
      ...(icon ? { icon } : {}),
      ...(tooltip ? { tooltip } : {}),
      ...(tone ? { tone } : {}),
      ...(position ? { position } : {}),
      ...(when ? { when } : {}),
      ...(action ? { action } : {}),
      ...(dynamic ? { dynamic } : {}),
    },
    diagnostics,
  };
}

function parseEditOp(raw: unknown, index: number): ParseResult<UiEditOp> {
  const at = `edits[${index}]`;
  if (!isRecord(raw)) return fail("invalid-edit", `${at} must be an object.`);
  const placementId =
    typeof raw.placementId === "string" && ID_PATTERN.test(raw.placementId)
      ? raw.placementId
      : undefined;
  if (!placementId) return fail("invalid-edit", `${at} needs a valid placementId.`);
  const partOf = (): string | undefined =>
    typeof raw.part === "string" && ID_PATTERN.test(raw.part) ? raw.part : undefined;
  switch (raw.op) {
    case "hide":
    case "show": {
      const part = partOf();
      return part
        ? ok({ op: raw.op, placementId, part })
        : fail("invalid-edit", `${at} needs a part id.`);
    }
    case "relabel": {
      const part = partOf();
      const label = boundedString(raw.label, MAX_LABEL);
      return part && label
        ? ok({ op: "relabel", placementId, part, label })
        : fail("invalid-edit", `${at} relabel needs a part and a 1-${MAX_LABEL} char label.`);
    }
    case "tooltip": {
      const part = partOf();
      const tooltip = boundedString(raw.tooltip, MAX_TOOLTIP);
      return part && tooltip
        ? ok({ op: "tooltip", placementId, part, tooltip })
        : fail("invalid-edit", `${at} tooltip needs a part and a 1-${MAX_TOOLTIP} char tooltip.`);
    }
    case "icon": {
      const part = partOf();
      const icon = parseUiIcon(raw.icon);
      return part && icon.value
        ? ok({ op: "icon", placementId, part, icon: icon.value })
        : fail("invalid-edit", `${at} icon needs a part and a valid icon.`);
    }
    case "tone": {
      const part = partOf();
      const tone = parseTone(raw.tone);
      return part && tone
        ? ok({ op: "tone", placementId, part, tone })
        : fail("invalid-edit", `${at} tone needs a part and one of ${UI_TONES.join(", ")}.`);
    }
    case "move": {
      const part = partOf();
      const before =
        typeof raw.before === "string" && ID_PATTERN.test(raw.before) ? raw.before : undefined;
      const after =
        typeof raw.after === "string" && ID_PATTERN.test(raw.after) ? raw.after : undefined;
      return part && (before === undefined) !== (after === undefined)
        ? ok({
            op: "move",
            placementId,
            part,
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          })
        : fail("invalid-edit", `${at} move needs a part and exactly one of before/after.`);
    }
    case "order": {
      const parts = raw.parts;
      return Array.isArray(parts) &&
        parts.length > 0 &&
        parts.length <= MAX_ORDER_PARTS &&
        parts.every((entry): entry is string => typeof entry === "string" && ID_PATTERN.test(entry))
        ? ok({ op: "order", placementId, parts: [...parts] })
        : fail("invalid-edit", `${at} order needs a non-empty list of part ids.`);
    }
    case "when": {
      const part = partOf();
      const when = parseUiWhen(raw.when);
      return part && when.value
        ? ok({ op: "when", placementId, part, when: when.value })
        : fail("invalid-edit", `${at} when needs a part and a valid condition.`);
    }
    default:
      return fail("invalid-edit", `${at} has an unknown op.`);
  }
}

/** Validates a list of edit ops, dropping invalid entries with diagnostics. Used for extension metadata and user settings. */
export function parseUiEditOps(raw: unknown): ParseResult<readonly UiEditOp[]> {
  if (!Array.isArray(raw)) return fail("invalid-edits", "`edits` must be an array.");
  const diagnostics: UiContributionDiagnostic[] = [];
  if (raw.length > MAX_EDITS) {
    diagnostics.push({
      code: "too-many-edits",
      message: `Only the first ${MAX_EDITS} edits are used.`,
    });
  }
  const edits: UiEditOp[] = [];
  raw.slice(0, MAX_EDITS).forEach((entry, index) => {
    const parsed = parseEditOp(entry, index);
    if (parsed.value) edits.push(parsed.value);
    diagnostics.push(...parsed.diagnostics);
  });
  return { value: edits, diagnostics };
}

function parseItemPosition(value: unknown): UiItemPosition | undefined {
  if (!isRecord(value)) return undefined;
  const { before, after } = value;
  if (
    (before !== undefined && (typeof before !== "string" || !ID_PATTERN.test(before))) ||
    (after !== undefined && (typeof after !== "string" || !ID_PATTERN.test(after))) ||
    (before !== undefined) === (after !== undefined)
  ) {
    return undefined;
  }
  return {
    ...(typeof before === "string" ? { before } : {}),
    ...(typeof after === "string" ? { after } : {}),
  };
}

/**
 * Parses `metadata["marshal.ui.contribution"]`. Absent = `{kind: "view"}`.
 * Invalid = `value: undefined` plus diagnostics (the registration is dropped).
 */
export function parseUiContribution(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ParseResult<UiContribution> {
  const raw = metadata?.[MARSHAL_UI_CONTRIBUTION_METADATA_KEY];
  if (raw === undefined || raw === null) return ok({ kind: "view" });
  if (!isRecord(raw)) return fail("invalid-contribution", "Contribution must be an object.");
  switch (raw.kind) {
    case undefined:
    case "view": {
      if (raw.position === undefined) return ok({ kind: "view" });
      const position = parseItemPosition(raw.position);
      return position
        ? ok({ kind: "view", position })
        : fail(
            "invalid-contribution",
            "View `position` takes exactly one of before/after, a part id.",
          );
    }
    case "item": {
      const item = parseItem(raw.item);
      return item.value
        ? { value: { kind: "item", item: item.value }, diagnostics: item.diagnostics }
        : { value: undefined, diagnostics: item.diagnostics };
    }
    case "edits": {
      const edits = parseUiEditOps(raw.edits);
      if (!edits.value || edits.value.length === 0) {
        return {
          value: undefined,
          diagnostics: [
            ...edits.diagnostics,
            { code: "invalid-contribution", message: "Edits contribution has no valid edit." },
          ],
        };
      }
      return { value: { kind: "edits", edits: edits.value }, diagnostics: edits.diagnostics };
    }
    default:
      return fail("invalid-contribution", 'Contribution kind must be "view", "item" or "edits".');
  }
}

export function parseUiIconMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ParseResult<UiIcon> {
  const raw = metadata?.[MARSHAL_UI_ICON_METADATA_KEY];
  if (raw === undefined || raw === null) return { value: undefined, diagnostics: [] };
  return parseUiIcon(raw);
}

export type UiDensity = "compact" | "default" | "comfortable";

export interface UiThemeContribution {
  readonly light?: Readonly<Record<string, string>>;
  readonly dark?: Readonly<Record<string, string>>;
  readonly density?: UiDensity;
}

const THEME_EXTRA_TOKENS: readonly string[] = ["--radius", "--font-sans"];
const THEME_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  ...MARSHAL_UI_THEME_TOKEN_NAMES,
  ...THEME_EXTRA_TOKENS,
]);
export const UI_THEME_FONT_FAMILIES: readonly string[] = Object.freeze([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "Inter",
  "Helvetica Neue",
  "Georgia",
  "Menlo",
]);
const COLOR_PATTERNS: readonly RegExp[] = [
  /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/-]+\)$/,
  /^(?:oklch|oklab)\(\s*[0-9.%\s/-]+\)$/,
];
const LENGTH_PATTERN = /^(?:0|(?:\d{1,2}(?:\.\d{1,3})?)(?:px|rem))$/;

export function isValidThemeValue(token: string, value: string): boolean {
  if (token === "--radius") return LENGTH_PATTERN.test(value);
  if (token === "--font-sans") return UI_THEME_FONT_FAMILIES.includes(value);
  return COLOR_PATTERNS.some((pattern) => pattern.test(value));
}

function parseThemeTokens(
  raw: unknown,
  scheme: string,
  diagnostics: UiContributionDiagnostic[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    diagnostics.push({ code: "invalid-theme", message: `Theme "${scheme}" must be an object.` });
    return undefined;
  }
  const tokens: Record<string, string> = {};
  for (const [token, value] of Object.entries(raw)) {
    if (!THEME_TOKEN_ALLOWLIST.has(token)) {
      diagnostics.push({
        code: "invalid-theme",
        message: `Theme token "${token}" is not allowed.`,
      });
    } else if (typeof value !== "string" || !isValidThemeValue(token, value.trim())) {
      diagnostics.push({
        code: "invalid-theme",
        message: `Theme value for "${token}" is invalid.`,
      });
    } else tokens[token] = value.trim();
  }
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

export function parseUiThemeMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ParseResult<UiThemeContribution> {
  const raw = metadata?.[MARSHAL_UI_THEME_METADATA_KEY];
  if (raw === undefined || raw === null) return { value: undefined, diagnostics: [] };
  if (!isRecord(raw)) return fail("invalid-theme", "Theme must be an object.");
  const diagnostics: UiContributionDiagnostic[] = [];
  const light = parseThemeTokens(raw.light, "light", diagnostics);
  const dark = parseThemeTokens(raw.dark, "dark", diagnostics);
  let density: UiDensity | undefined;
  if (raw.density !== undefined) {
    if (raw.density === "compact" || raw.density === "default" || raw.density === "comfortable") {
      density = raw.density;
    } else diagnostics.push({ code: "invalid-theme", message: "Theme density is not recognized." });
  }
  if (!light && !dark && !density) {
    return {
      value: undefined,
      diagnostics: [
        ...diagnostics,
        { code: "invalid-theme", message: "Theme has no valid token." },
      ],
    };
  }
  return {
    value: {
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {}),
      ...(density ? { density } : {}),
    },
    diagnostics,
  };
}
