import { z } from "zod";
import { VOICE_SCHEMA } from "./voices.js";

export const PERSONA_FILE = "config/persona.json";
export const PERSONA_SCHEMA = z.object({
  version: z.literal(1).default(1),
  tone: z.enum(["warm-direct", "professional", "casual", "analytical"]).default("warm-direct"),
  length: z.enum(["brief", "balanced", "detailed"]).default("brief"),
  emoji: z.enum(["none", "sparingly", "expressive"]).default("sparingly"),
  voice: VOICE_SCHEMA.default("Charon"),
  language: z.string().max(12).regex(/^(match-user|[a-z]{2,3}(?:-[A-Za-z]{2,8})?)$/).default("match-user"),
  signOff: z.string().max(80).refine((value) => !/[<>\r\n\u0000-\u001f]/.test(value)).default(""),
}).strict();

export type BrandPersona = z.infer<typeof PERSONA_SCHEMA>;
export const DEFAULT_PERSONA = PERSONA_SCHEMA.parse({});

export const PERSONA_SNAPSHOT_SCHEMA = z.object({
  persona: PERSONA_SCHEMA,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  usingDefault: z.boolean(),
}).strict();
export type PersonaSnapshot = z.infer<typeof PERSONA_SNAPSHOT_SCHEMA>;

export function parsePersona(content: string): BrandPersona {
  if (Buffer.byteLength(content, "utf8") > 8192) throw new Error("persona is too large");
  return PERSONA_SCHEMA.parse(JSON.parse(content));
}
