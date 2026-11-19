// What one SDK run's host loads, from the caller's marshal-sdk.json: its extensions with their configuration, the kit
// (Brain, memory, sessions) with the person the run works for, the model and the agent the caller chose.
import fs from "node:fs";
import path from "node:path";

import type { KitOptions, KitSelection, SessionsPublishOptions } from "./kit/index.js";
import { manifestPath } from "./onboarding-cli.js";
import { forgetHandedServiceKey, MANIFEST_FILE, readPackageManifest, resolveManifest } from "./onboarding.js";

export type KitPartName = "brain" | "memory" | "sessions";

/** A run's host as its marshal-sdk.json declares it (or package folders given directly, for developing an extension). */
export interface DeclaredHost {
  extensions: { packageRoot: string; identity: string; configuration?: unknown }[];
  kit?: KitOptions;
  model?: string;
  effort?: string;
  /** The agent the manifest names (`"agent": "@scope/name"` or `"@scope/name:id"`). */
  agent?: string;
  /** The manifest it came from; absent when only package folders were given. */
  manifest?: string;
}

/**
 * The host's extensions, kit, model and agent from the manifest. `extensions` (package folders) load next to the
 * manifest's, or instead of it when no manifest is found: the way to run an extension under development.
 */
export async function declaredHost(
  options: {
    manifest?: string;
    extensions?: readonly string[];
    kit?: readonly KitPartName[];
    publish?: SessionsPublishOptions;
    person?: string;
    model?: string;
    effort?: string;
    env?: Record<string, string | undefined>;
  },
  log: (line: string) => void = () => undefined,
): Promise<DeclaredHost> {
  const env = options.env ?? process.env;
  const person = (options.person ?? env.MARSHAL_SDK_BRAIN_CALLER)?.trim().toLowerCase() || undefined;
  const folders = (options.extensions ?? []).map((dir) => {
    const packageRoot = path.resolve(dir);
    return { packageRoot, identity: readPackageManifest(packageRoot).identity };
  });
  const file = manifestPath(options.manifest, env);
  if (!file) {
    if (!folders.length) throw new Error(`A run needs a ${MANIFEST_FILE}: pass --manifest <file> or set MARSHAL_SDK_MANIFEST (or --extension <package folder>).`);
    log(`package folders, no manifest: ${folders.map((folder) => `${folder.identity} (${folder.packageRoot})`).join(", ")}`);
    const kit = hostKit(options.kit ?? kitArgument(undefined), options.publish, person).kit;
    return {
      extensions: folders,
      ...(kit ? { kit } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    };
  }
  const resolved = await resolveManifest(file, { env });
  forgetHandedServiceKey(env, process.env);
  log(`manifest ${file}: ${resolved.extensions.map((extension) => `${extension.identity}@${extension.version} (${extension.source})`).join(", ")}`);
  const kit = runKit(resolved.kit, options.kit, options.publish, person);
  const model = options.model ?? resolved.model;
  const effort = options.effort ?? resolved.reasoningEffort;
  const listed = resolved.extensions.map((extension) => ({
    packageRoot: extension.packageRoot,
    identity: extension.identity,
    ...(extension.configuration !== undefined ? { configuration: extension.configuration } : {}),
  }));
  return {
    extensions: [...listed.filter((extension) => !folders.some((folder) => folder.identity === extension.identity)), ...folders],
    ...(kit ? { kit } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(resolved.agent ? { agent: resolved.agent } : {}),
    manifest: file,
  };
}

/**
 * The manifest's kit for one run: its parts (or the ones --kit names), the Brain and sessions when the run publishes
 * its sessions, and the person the run works for as the Brain's caller, never taken from model input.
 */
export function runKit(
  declared: KitSelection | undefined,
  parts: readonly KitPartName[] | undefined,
  publish: SessionsPublishOptions | undefined,
  person: string | undefined,
): KitOptions | undefined {
  const base: KitOptions | undefined = !declared ? undefined : Array.isArray(declared) ? { parts: [...declared] as KitOptions["parts"] } : { ...(declared as KitOptions) };
  let chosen = (parts?.length ? [...parts] : [...(base?.parts ?? [])]) as KitOptions["parts"];
  if (publish) chosen = [...new Set([...chosen, "brain", "sessions"])] as KitOptions["parts"];
  if (!chosen.length) return undefined;
  const brain = { ...base?.brain, ...(person ? { callerEmail: person } : {}) };
  return {
    ...base,
    parts: chosen,
    ...(Object.keys(brain).length ? { brain } : {}),
    ...(publish ? { sessions: { ...base?.sessions, publish } } : {}),
  };
}

/**
 * The host's kit: the parts asked for, plus the Brain and sessions when the run publishes its sessions. The Brain
 * caller (default $MARSHAL_SDK_BRAIN_CALLER) gives the host that person's memory home, so their always-on
 * preferences reach the sessions; without it a cloud run sees only the workspace home.
 */
export function hostKit(
  kit: readonly KitPartName[] | undefined,
  publish: SessionsPublishOptions | undefined,
  brainCaller: string | undefined = process.env.MARSHAL_SDK_BRAIN_CALLER,
): { kit?: KitOptions } {
  const caller = brainCaller?.trim();
  const brain = caller ? { brain: { callerEmail: caller } } : {};
  if (!publish) return kit?.length ? { kit: { parts: [...kit], ...brain } } : {};
  const parts = new Set<KitPartName>([...(kit ?? []), "brain", "sessions"]);
  return { kit: { parts: [...parts], sessions: { publish }, ...brain } };
}

export function publishArgument(audience: string | undefined, context: string | undefined): { publish?: SessionsPublishOptions } {
  const raw = (audience ?? process.env.MARSHAL_SDK_PUBLISH_SESSIONS ?? "").trim();
  if (!raw || raw === "off") return {};
  const line = (context ?? process.env.MARSHAL_SDK_PUBLISH_CONTEXT ?? "").trim();
  const people = raw === "team" ? [] : raw.split(",").map((email) => email.trim()).filter(Boolean);
  return { publish: { audience: people.length ? { people } : "team", ...(line ? { context: line } : {}) } };
}

export function kitArgument(value: string | undefined): KitPartName[] | undefined {
  const raw = value ?? process.env.MARSHAL_SDK_KIT ?? "";
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) if (!["brain", "memory", "sessions"].includes(part)) throw new Error(`--kit takes brain, memory and sessions, got ${part}.`);
  return parts.length ? (parts as KitPartName[]) : undefined;
}

/** Reads a `--x @file` argument: the file's text, or the value as written. */
export function textArgument(value: string): string {
  return value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
}
