import { z } from "zod";

export const GEMINI_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina",
  "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Puck",
  "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;
export const VOICE_SCHEMA = z.union([z.enum(GEMINI_VOICES), z.string().regex(/^elevenlabs:[A-Za-z0-9_-]{1,128}$/)]);
export type VoiceSelection = z.infer<typeof VOICE_SCHEMA>;
export const GEMINI_VOICE_OPTIONS = GEMINI_VOICES.map(id => ({ id, label: id }));
export const VOICE_CATALOG_SCHEMA = z.object({
  elevenlabs: z.enum(["not-configured", "ready", "unavailable"]),
  voices: z.array(z.object({ id: VOICE_SCHEMA, label: z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict()).max(530),
}).strict();
export type VoiceCatalog = z.infer<typeof VOICE_CATALOG_SCHEMA>;
export const DEFAULT_VOICE_CATALOG: VoiceCatalog = { elevenlabs: "not-configured", voices: GEMINI_VOICE_OPTIONS };
