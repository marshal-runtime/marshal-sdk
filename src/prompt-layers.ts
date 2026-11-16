import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Prompt layers an extension contributes (`contributes.promptLayers`): named pieces of system prompt that agent profiles
 * (and host launches) compose by name, in the order they list them. A persona (soul, voice, shared rules) is one
 * extension with several layers; each agent that speaks in it lists the layers instead of embedding a copy.
 * A layer is named `<extension identity>#<id>`, for example `@marley/persona#soul`.
 */

const IDENTITY = /^@?[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/;
const LAYER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9@._+-]+$/;
const MAX_LAYERS = 64;
const MAX_LAYER_BYTES = 262_144;
/** What joins the pieces of a composed prompt. */
export const LAYER_SEPARATOR = "\n\n";

export class PromptLayerError extends Error {
  readonly code = "invalid-request";
}

const fail = (message: string): never => {
  throw new PromptLayerError(message);
};

export interface PromptLayerEntry {
  id: string;
  /** Package-relative file. */
  file: string;
}

export interface ExtensionPromptLayers {
  identity: string;
  version: string;
  packageRoot: string;
  layers: (PromptLayerEntry & { ref: string })[];
}

/** One layer of a composed prompt: its name, the version of the extension that supplied it and its text. */
export interface ComposedLayer {
  ref: string;
  version: string;
  text: string;
  sha256: string;
}

/** Where a host finds the installed packages that contribute layers: identity to package root. */
export type PromptLayerSources = Readonly<Record<string, string>> | ((identity: string) => string | undefined);

export const layerRef = (identity: string, id: string): string => `${identity}#${id}`;

export function parseLayerRef(ref: string): { identity: string; id: string } {
  const at = ref.lastIndexOf("#");
  const identity = at < 0 ? "" : ref.slice(0, at);
  const id = at < 0 ? "" : ref.slice(at + 1);
  if (!IDENTITY.test(identity) || !LAYER_ID.test(id)) return fail(`"${ref}" is not a prompt layer name (<extension identity>#<layer id>).`);
  return { identity, id };
}

/** Reads and validates `contributes.promptLayers` of the package at `packageRoot`. A package without layers returns none. */
export function readExtensionPromptLayers(packageRoot: string): ExtensionPromptLayers {
  const root = fs.realpathSync(packageRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "runtime-extension.json"), "utf8")) as Record<string, any>;
  const identity = String(manifest.identity ?? "");
  if (!IDENTITY.test(identity)) fail(`runtime-extension.json identity "${identity}" is not a package identity.`);
  const version = String(manifest.version ?? "");
  if (!version) fail(`${identity}: runtime-extension.json has no version.`);
  const raw = manifest.contributes?.promptLayers;
  if (raw === undefined) return { identity, version, packageRoot: root, layers: [] };
  if (!Array.isArray(raw)) fail(`${identity}: contributes.promptLayers must be a list.`);
  if (raw.length > MAX_LAYERS) fail(`${identity}: more than ${MAX_LAYERS} prompt layers.`);
  const seen = new Set<string>();
  const layers = (raw as unknown[]).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${identity}: each prompt layer must be an object.`);
    const entry = value as Record<string, unknown>;
    const id = String(entry.id ?? "");
    if (!LAYER_ID.test(id)) fail(`${identity}: prompt layer id "${id}" must be lowercase letters, digits, ".", "_" or "-".`);
    if (seen.has(id)) fail(`${identity}: prompt layer "${id}" repeats.`);
    seen.add(id);
    const file = String(entry.file ?? "");
    checkPackagePath(file, `${identity}: prompt layer "${id}" file`);
    return { id, file, ref: layerRef(identity, id) };
  });
  return { identity, version, packageRoot: root, layers };
}

/** The text of one layer of a package. */
export function readPromptLayer(contributed: ExtensionPromptLayers, id: string): ComposedLayer {
  const entry = contributed.layers.find((layer) => layer.id === id);
  if (!entry) {
    const known = contributed.layers.map((layer) => layer.id).join(", ") || "none";
    return fail(`${contributed.identity} has no prompt layer "${id}" (it contributes: ${known}).`);
  }
  const text = readPackageFile(contributed.packageRoot, entry.file, `${entry.ref}`);
  return { ref: entry.ref, version: contributed.version, text, sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * The layers named by `refs`, in that order, read from the packages `sources` finds. When `scope` is given, a layer's
 * extension must be in it (a profile's `extensions`, plus its own package): the same rule as for skills and tools.
 */
export function resolvePromptLayers(refs: readonly string[], sources: PromptLayerSources, scope?: readonly string[]): ComposedLayer[] {
  const cache = new Map<string, ExtensionPromptLayers>();
  const seen = new Set<string>();
  return refs.map((ref) => {
    const { identity, id } = parseLayerRef(ref);
    if (seen.has(ref)) fail(`prompt layer "${ref}" repeats.`);
    seen.add(ref);
    if (scope && !scope.includes(identity)) fail(`prompt layer "${ref}" is not in scope: ${identity} is not one of the extensions this profile sees.`);
    let contributed = cache.get(identity);
    if (!contributed) {
      const root = typeof sources === "function" ? sources(identity) : sources[identity];
      if (!root) return fail(`prompt layer "${ref}": ${identity} is not installed.`);
      contributed = readExtensionPromptLayers(root);
      if (contributed.identity !== identity) fail(`prompt layer "${ref}": the package at ${root} is ${contributed.identity}.`);
      cache.set(identity, contributed);
    }
    return readPromptLayer(contributed, id);
  });
}

/** The composed system prompt: the layers in order, then `own` (a profile's own text), joined by a blank line. */
export function composePromptLayers(layers: readonly Pick<ComposedLayer, "text">[], own?: string): string {
  return [...layers.map((layer) => layer.text), ...(own === undefined ? [] : [own])].join(LAYER_SEPARATOR);
}

/** A portable package-relative path: no absolute path, backslash, empty, "." or ".." segment. */
function checkPackagePath(relative: string, label: string): void {
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === ".." || !SEGMENT.test(segment))
  ) {
    fail(`${label} "${relative}" must be a portable path inside the package.`);
  }
}

/** Reads a package file, refusing one that leaves the package through a link. */
function readPackageFile(root: string, relative: string, label: string): string {
  checkPackagePath(relative, label);
  const file = path.join(root, ...relative.split("/"));
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return fail(`${label}: ${relative} is missing.`);
  }
  if (!real.startsWith(`${root}${path.sep}`)) fail(`${label}: ${relative} leaves the package.`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) fail(`${label}: ${relative} is not a file.`);
  if (stat.size > MAX_LAYER_BYTES) fail(`${label}: ${relative} is larger than ${MAX_LAYER_BYTES} bytes.`);
  return fs.readFileSync(real, "utf8");
}
