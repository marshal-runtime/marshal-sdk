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
  /** Per extension id: where its UI contributions apply. Absent = all of Marshal. */
  readonly extensionScopes?: Readonly<Record<string, InterfaceExtensionScope>>;
}

/**
 * Where an extension's UI contributions (theme, edits, items, views) apply:
 * everywhere, only in threads of the named workspaces, or only in the named threads.
 */
export type InterfaceExtensionScope =
  | { readonly level: "marshal" }
  | { readonly level: "workspace"; readonly workspaceNames: readonly string[] }
  | { readonly level: "thread"; readonly sessionIds: readonly string[] };

/** The thread the interface is showing; both fields absent outside a thread. */
export interface InterfaceActiveContext {
  readonly sessionId?: string;
  readonly workspaceName?: string;
}

export function isExtensionInScope(
  customization: InterfaceCustomization,
  extensionId: string,
  active: InterfaceActiveContext,
): boolean {
  const scope = customization.extensionScopes?.[extensionId];
  if (!scope || scope.level === "marshal") return true;
  if (scope.level === "workspace") {
    return (
      active.workspaceName !== undefined && scope.workspaceNames.includes(active.workspaceName)
    );
  }
  return active.sessionId !== undefined && scope.sessionIds.includes(active.sessionId);
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
  const extensionScopes = sanitizeExtensionScopes(raw.extensionScopes);
  return {
    edits,
    disabledContributions,
    replacementChoice,
    theme,
    ...(spotlight ? { spotlight } : {}),
    ...(extensionScopes ? { extensionScopes } : {}),
  };
}

const MAX_SCOPED_EXTENSIONS = 128;
const MAX_SCOPE_TARGETS = 256;

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0 && entry.length <= MAX_KEY,
      ),
    ),
  ].slice(0, MAX_SCOPE_TARGETS);
}

function sanitizeExtensionScope(raw: unknown): InterfaceExtensionScope | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.level === "marshal") return { level: "marshal" };
  if (raw.level === "workspace") {
    const workspaceNames = stringList(raw.workspaceNames);
    return workspaceNames.length > 0 ? { level: "workspace", workspaceNames } : undefined;
  }
  if (raw.level === "thread") {
    const sessionIds = stringList(raw.sessionIds);
    return sessionIds.length > 0 ? { level: "thread", sessionIds } : undefined;
  }
  return undefined;
}

function sanitizeExtensionScopes(
  raw: unknown,
): Record<string, InterfaceExtensionScope> | undefined {
  if (!isRecord(raw)) return undefined;
  const scopes: Record<string, InterfaceExtensionScope> = {};
  for (const [extensionId, value] of Object.entries(raw).slice(0, MAX_SCOPED_EXTENSIONS)) {
    if (extensionId.length === 0 || extensionId.length > MAX_KEY) continue;
    const scope = sanitizeExtensionScope(value);
    // "marshal" is the default; storing it would only add noise.
    if (scope && scope.level !== "marshal") scopes[extensionId] = scope;
  }
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

/** Returns the scope or the reason it is invalid, for writers that must not drop input silently. */
export function parseExtensionScope(
  raw: unknown,
): { ok: true; value: InterfaceExtensionScope } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "Scope must be an object." };
  if (raw.level !== "marshal" && raw.level !== "workspace" && raw.level !== "thread") {
    return { ok: false, error: 'Scope level must be "marshal", "workspace" or "thread".' };
  }
  const scope = sanitizeExtensionScope(raw);
  if (!scope) {
    return {
      ok: false,
      error:
        raw.level === "workspace"
          ? "A workspace scope needs at least one workspace name."
          : "A thread scope needs at least one session id.",
    };
  }
  return { ok: true, value: scope };
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
  /** Per extension id; replaces the whole map. A `marshal` scope removes the restriction. */
  readonly extensionScopes?: Readonly<Record<string, unknown>>;
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
  if (patch.extensionScopes !== undefined) {
    for (const [extensionId, scope] of Object.entries(patch.extensionScopes)) {
      const parsed = parseExtensionScope(scope);
      if (!parsed.ok) errors.push(`Extension "${extensionId}": ${parsed.error}`);
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
      extensionScopes: patch.extensionScopes ?? current.extensionScopes,
    }),
  };
}
