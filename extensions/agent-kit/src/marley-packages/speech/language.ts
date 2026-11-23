const HEBREW = /[֐-׿]/g;
const LATIN = /[A-Za-z]/g;

const ISO3: Record<string, string> = { heb: "he", eng: "en", ara: "ar", rus: "ru", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de", por: "pt", ita: "it", ukr: "uk", tur: "tr", hin: "hi", zho: "zh", jpn: "ja" };

/** Short ISO 639-1 code. Maps the legacy Hebrew code iw to he. */
export function shortLanguage(code: string | undefined): string {
  if (!code) return "und";
  const short = code.toLowerCase().split(/[-_]/)[0]!;
  if (short === "iw") return "he";
  const mapped = ISO3[short];
  if (mapped) return mapped;
  if (short === "auto" || short === "") return "und";
  return short;
}

/** Hebrew when Hebrew letters outnumber Latin letters, otherwise English. */
export function detectTextLanguage(text: string): "he" | "en" {
  const hebrew = text.match(HEBREW)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  return hebrew > 0 && hebrew >= latin ? "he" : "en";
}

const REGION: Record<string, string> = {
  he: "he-IL",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  ar: "ar-XA",
  ru: "ru-RU",
  pt: "pt-BR",
};

/** BCP-47 tag for a short or full language code. */
export function bcp47(code: string): string {
  if (/[-_]/.test(code)) return code.replace("_", "-");
  const short = shortLanguage(code);
  return REGION[short] ?? short;
}
