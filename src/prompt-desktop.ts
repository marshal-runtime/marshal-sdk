import type { PromptLayer } from "../packages/prompt/src/index.js";
import { DESKTOP_V2_SLOTS } from "./prompt-desktop-slots.js";

/**
 * The desktop's v2 prompt words (its 24 slot values) as a surface. A host that runs Marshal's own prompt, the
 * `marshal` profile of an extension, uses this as `MarshalHostOptions.prompt.surface`: the shared v2 core plus the
 * desktop's sections, not the cloud-headless text. A cloud host's own facts (`cloudRunLayer`) go on top of it.
 * test/prompt.test.ts keeps this file equal to the slots the desktop's renderer was fixtured with.
 */
export function desktopSurface(): Exclude<NonNullable<PromptLayer["surface"]>, string> {
  return { id: "desktop", coreSlots: { ...DESKTOP_V2_SLOTS }, sections: [] };
}
