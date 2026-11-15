/**
 * User-level interface customization, persisted in app settings
 * (`MSettings.interfaceCustomization`). Applied after every extension
 * contribution, so the user always wins. Shape is public API for the
 * Settings → Interface page.
 */

import { parseUiEditOps, type UiEditOp } from "./runtime-ui-contribution";
import { PLACEMENT_CATALOG } from "./runtime-ui-placement-catalog";

export interface InterfaceCustomization {
  /** User edits, applied last. */
  readonly edits: readonly UiEditOp[];
  /** Contribution keys (`contributionKey()`) the user switched off. */
  readonly disabledContributions: readonly string[];
  /** Per placement: the `extensionId/applicationId` replacement to use, or "default". */
  readonly replacementChoice: Readonly<Record<string, string>>;
  /** Selected theme key, "default" for Marshal's own, or null when the user has not chosen. */
  readonly theme: string | null;
  /** A red frame drawn around one placement (or one of its parts) to point at it, e.g. in a demo. */
  readonly spotlight?: InterfaceSpotlight;
}

export interface InterfaceSpotlight {
  readonly placementId: string;
  /** Omit to frame the whole placement. */
  readonly part?: string;
  /** Caption shown on the frame. */
  readonly label?: string;
}

export const DEFAULT_INTERFACE_CUSTOMIZATION: InterfaceCustomization = Object.freeze({
  edits: Object.freeze([]),
  disabledContributions: Object.freeze([]),
  replacementChoice: Object.freeze({}),
  theme: null,
});

const MAX_DISABLED = 512;
const MAX_CHOICES = 128;
const MAX_KEY = 600;

export function contributionKey(
  extensionId: string,
  applicationId: string,
  placementId: string,
): string {
  return `${extensionId}/${applicationId}@${placementId}`;
}

export function replacementKey(extensionId: string, applicationId: string): string {
  return `${extensionId}/${applicationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total function: any persisted value becomes a valid customization. */
export function sanitizeInterfaceCustomization(raw: unknown): InterfaceCustomization {
  if (!isRecord(raw)) return DEFAULT_INTERFACE_CUSTOMIZATION;
  const edits = Array.isArray(raw.edits) ? (parseUiEditOps(raw.edits).value ?? []) : [];
  const disabledContributions = Array.isArray(raw.disabledContributions)
    ? [
        ...new Set(
          raw.disabledContributions.filter(
            (entry): entry is string =>
              typeof entry === "string" && entry.length > 0 && entry.length <= MAX_KEY,
          ),
        ),
      ].slice(0, MAX_DISABLED)
    : [];
  const replacementChoice: Record<string, string> = {};
  if (isRecord(raw.replacementChoice)) {
    for (const [placementId, choice] of Object.entries(raw.replacementChoice).slice(
      0,
      MAX_CHOICES,
    )) {
      if (typeof choice === "string" && choice.length > 0 && choice.length <= MAX_KEY) {
        replacementChoice[placementId] = choice;
      }
    }
  }
  const theme =
    typeof raw.theme === "string" && raw.theme.length > 0 && raw.theme.length <= MAX_KEY
      ? raw.theme
      : null;
  const spotlight = sanitizeSpotlight(raw.spotlight);
  return {
    edits,
    disabledContributions,
    replacementChoice,
    theme,
    ...(spotlight ? { spotlight } : {}),
  };
}

const MAX_SPOTLIGHT_LABEL = 160;
const SPOTLIGHT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9.-]{0,127}$/;

function sanitizeSpotlight(raw: unknown): InterfaceSpotlight | undefined {
  if (!isRecord(raw)) return undefined;
  const { placementId, part, label } = raw;
  if (typeof placementId !== "string" || !SPOTLIGHT_ID_PATTERN.test(placementId)) return undefined;
  const validPart = typeof part === "string" && SPOTLIGHT_ID_PATTERN.test(part) ? part : undefined;
  const validLabel =
    typeof label === "string" && label.trim().length > 0
      ? label.trim().slice(0, MAX_SPOTLIGHT_LABEL)
      : undefined;
  return {
    placementId,
    ...(validPart ? { part: validPart } : {}),
    ...(validLabel ? { label: validLabel } : {}),
  };
}

export interface InterfaceCustomizationPatch {
  readonly edits?: readonly unknown[];
  readonly disabledContributions?: readonly string[];
  readonly replacementChoice?: Readonly<Record<string, string>>;
  readonly theme?: string | null;
  /** null clears the spotlight. */
  readonly spotlight?: InterfaceSpotlight | null;
}

/**
 * Applies a patch from outside the Settings page (the agent's updateSettings
 * tool): given fields replace the current ones whole. Strict where the
 * sanitizer is lenient, so a typo is reported instead of silently dropped.
 */
export function mergeInterfaceCustomization(
  current: InterfaceCustomization,
  patch: InterfaceCustomizationPatch,
): { ok: true; value: InterfaceCustomization } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let edits = current.edits;
  if (patch.edits !== undefined) {
    const parsed = parseUiEditOps(patch.edits);
    errors.push(...parsed.diagnostics.map((diagnostic) => diagnostic.message));
    edits = parsed.value ?? [];
    const placementIds = new Set(PLACEMENT_CATALOG.map((definition) => definition.id));
    for (const edit of edits) {
      if (!placementIds.has(edit.placementId)) {
        errors.push(`Unknown placement "${edit.placementId}".`);
      }
    }
  }
  const spotlight = patch.spotlight === undefined ? current.spotlight : patch.spotlight;
  if (patch.spotlight) {
    const definition = PLACEMENT_CATALOG.find((entry) => entry.id === patch.spotlight?.placementId);
    if (!definition) errors.push(`Unknown spotlight placement "${patch.spotlight.placementId}".`);
    else if (
      patch.spotlight.part !== undefined &&
      !definition.parts.some((part) => part.id === patch.spotlight?.part)
    ) {
      errors.push(`Placement "${definition.id}" has no part "${patch.spotlight.part}".`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: sanitizeInterfaceCustomization({
      edits,
      disabledContributions: patch.disabledContributions ?? current.disabledContributions,
      replacementChoice: patch.replacementChoice ?? current.replacementChoice,
      theme: patch.theme === undefined ? current.theme : patch.theme,
      spotlight,
    }),
  };
}
