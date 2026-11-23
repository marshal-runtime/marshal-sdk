// Extract of zygstinct apps/agent-server/src/prompt-v2.ts at 7110e58c8: only loadSoul.
import fs from "node:fs";
import path from "node:path";
import { resolvePromptLayers } from "@zygstinct/marshal-sdk-port";
import { fileURLToPath } from "node:url";

/** The persona package's identity: the agents' shared rules and the composer's soul are its prompt layers (`extensions/persona`). */
export const PERSONA_IDENTITY = "@marley/persona";

const here = path.dirname(fileURLToPath(import.meta.url));

/** In the image the package sits beside dist/ (`/app/extensions/persona`); in the repo it is two folders above the app. */
export const PERSONA_DIR = ((): string => {
  const inImage = path.resolve(here, "..", "extensions", "persona");
  return fs.existsSync(inImage) ? inImage : path.resolve(here, "..", "..", "..", "extensions", "persona");
})();

/** The soul (`@marley/persona#soul`): who Marley is and how he sounds. Its only reader is the outbox composer (outbox/outbox.ts composerSystem). */
export function loadSoul(personaDir: string = PERSONA_DIR): string {
  const [layer] = resolvePromptLayers([`${PERSONA_IDENTITY}#soul`], { [PERSONA_IDENTITY]: personaDir }, [PERSONA_IDENTITY]);
  if (!layer?.text) throw new Error(`persona layer ${PERSONA_IDENTITY}#soul is empty`);
  return layer.text;
}
