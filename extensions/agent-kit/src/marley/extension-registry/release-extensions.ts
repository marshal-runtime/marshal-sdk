import { OWNER_REPORT_DAILY, UA_CBO } from "@zygstinct/routines-public";

import type { RoutineSpec } from "./routine-spec-schema.js";
import type { ExtensionFiles } from "./sdk-registry.js";

/**
 * Which release extension and agent each routine id resolves to when a brand has no binding of its own, and the package a brand's saved spec becomes
 * (`RoutineSpecs.saveSpec`). The one-way import of the legacy `routine_specs` table that used to live beside this is gone (2026-11-18).
 */
export const RELEASE_EXTENSION_FOR: Readonly<Record<string, { extensionId: string; agentId: string }>> = {
  // Only the registry key of older ua-cbo spec rows: the package is gone and nothing runs it (the server runs the UA analysis itself, routines/ua-server).
  [UA_CBO]: { extensionId: "@marley/meta-analysis", agentId: "meta-analysis" },
  [OWNER_REPORT_DAILY]: { extensionId: "@marley/daily-brief", agentId: "daily-brief" },
  // Free time: reviews the day's runs and proposes what worked (a release routine with no routine_specs row).
  dream: { extensionId: "@marley/free-time", agentId: "dream" },
  // The chat itself: the front and the background worker are the two agents of @marley/chat (agent-extensions/chat-profile.ts).
  "chat-front": { extensionId: "@marley/chat", agentId: "front" },
  "chat-worker": { extensionId: "@marley/chat", agentId: "worker" },
  // The server-fired routines (routine-engine.ts ENGINE_ROUTINES `server: true`): without a release mapping the registry resolves them to nothing, so the
  // engine recorded no run pin for them (dev audit 2026-11-18: no pin for brief-send, free-time, pixel-check, ahead-first-look or the store check).
  onboarding: { extensionId: "@marley/onboarding", agentId: "onboarding" },
  "pixel-check": { extensionId: "@marley/pixel-check", agentId: "pixel-check" },
  "brief-send": { extensionId: "@marley/daily-brief", agentId: "brief-send" },
  "free-time": { extensionId: "@marley/free-time", agentId: "free-time" },
  "free-time-watch": { extensionId: "@marley/free-time", agentId: "free-time-watch" },
  "free-time-follow": { extensionId: "@marley/free-time", agentId: "free-time-follow" },
  "free-time-scout": { extensionId: "@marley/free-time", agentId: "free-time-scout" },
  "free-time-unlock": { extensionId: "@marley/free-time", agentId: "free-time-unlock" },
  "store-watch": { extensionId: "@marley/store-watch", agentId: "store-watch" },
  "source-notice": { extensionId: "@marley/source-notice", agentId: "source-notice" },
  "intake-reveal": { extensionId: "@marley/intake-reveal", agentId: "intake-reveal" },
  "stack-scan": { extensionId: "@marley/stack-scan", agentId: "stack-scan" },
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The extension and agent a routine id maps to; an owner-made routine is `@brand/<id>`. */
export function extensionFor(routineId: string): { extensionId: string; agentId: string } {
  const known = RELEASE_EXTENSION_FOR[routineId];
  if (known) return known;
  const slug = routineId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!SLUG.test(slug)) throw new Error(`routine id ${routineId} has no extension name`);
  return { extensionId: `@brand/${slug}`, agentId: slug };
}

/** The release image's skills (same shape as extensions/authoring's ReleaseSkills). */
export interface ReleaseSkillSource {
  has(name: string): boolean;
  files(name: string): ExtensionFiles;
}

/**
 * A spec as a package. A release version names the image's skills; a brand version (pass `copySkills`) carries a copy of
 * each one the image has, declared in `contributes.catalog`, so it stays whole when the image changes.
 */
export function specToExtensionFiles(spec: RoutineSpec, copySkills?: ReleaseSkillSource): ExtensionFiles {
  const { extensionId, agentId } = extensionFor(spec.id);
  const copied = copySkills ? spec.skills.filter((skill) => copySkills.has(skill)) : [];
  const manifest = {
    schemaVersion: 1,
    identity: extensionId,
    version: `0.0.${spec.version}`,
    displayName: spec.metadata.name,
    contributes: {
      agents: [
        {
          id: agentId,
          title: spec.metadata.name,
          description: spec.metadata.description,
          profile: {
            prompt: "profiles/instructions.prompt.md",
            promptMode: "append",
            // A spec names the VM's routine extension and its tools; today they are offered in every routine turn.
            extensions: spec.extension ? [spec.extension.id] : [],
            skills: spec.skills,
            context: ["brand", "clock"],
          },
          input: { type: "object", properties: {} },
          outputs: [],
          ports: [],
        },
      ],
      ...(copied.length ? { catalog: copied.map((skill) => `skill:skills/${skill}`) } : {}),
    },
    marley: { importedFrom: "routine_specs", routineId: spec.id, specVersion: spec.version, origin: spec.origin, tools: spec.extension?.tools ?? [] },
  };
  const files: ExtensionFiles = {
    "runtime-extension.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "profiles/instructions.prompt.md": spec.prompt,
    "marley-routine-spec.json": `${JSON.stringify(spec, null, 2)}\n`,
  };
  for (const skill of copied) for (const [name, content] of Object.entries(copySkills!.files(skill))) files[`skills/${skill}/${name}`] = content;
  return files;
}
