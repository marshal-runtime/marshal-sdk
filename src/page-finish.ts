// The page a run hands over: library pictures copied beside it as assets/, and every top-level section marked
// with data-zyg-section (what agent-sandbox's launch check and publisher key on). Shared by page-run and by the
// SDK sessions viewer when it pushes an edited page back to a cloud run.
import fs from "node:fs";
import path from "node:path";

export interface FinishedPage {
  html: string;
  sections: string[];
  assets: string[];
  missingAssets: string[];
}

const LIBRARY_HOST = "pagestudio.library";

export function finishPage(html: string, where: { libraryRoot: string; outDir: string }): FinishedPage {
  const assets = new Set<string>();
  const missing = new Set<string>();
  const assetsDir = path.join(where.outDir, "assets");
  const roots = [...new Set([where.libraryRoot, encodeURI(where.libraryRoot)])].map(escapeRegExp).join("|");
  const picture = new RegExp(`(?:file://(?:${roots})/([A-Za-z0-9._-]+)/pictures/|https://${escapeRegExp(LIBRARY_HOST)}/([A-Za-z0-9._-]+)/)([A-Za-z0-9._%-]+)`, "g");
  const linked = html.replace(picture, (_match, fileBrand: string | undefined, hostBrand: string | undefined, rawName: string) => {
    const brand = fileBrand ?? hostBrand ?? "";
    const name = decodeURIComponent(rawName);
    const source = path.join(where.libraryRoot, brand, "pictures", name);
    if (!fs.existsSync(source)) {
      missing.add(`${brand}/${name}`);
      return _match;
    }
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(source, path.join(assetsDir, name));
    assets.add(name);
    return `assets/${rawName}`;
  });
  const marked = markSections(linked);
  return { html: marked.html, sections: marked.keys, assets: [...assets], missingAssets: [...missing] };
}

const BARRIERS = new Set(["section", "header", "footer", "article", "aside", "nav", "template", "noscript"]);
const TARGETS = new Set(["section", "header", "footer"]);
const SECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

/** Adds data-zyg-section to every top-level section/header/footer that lacks one, keyed by the section's own key. */
export function markSections(html: string): { html: string; keys: string[] } {
  const elements: { name: string; tagEnd: number; attrs: string; bodyStart: number; bodyEnd: number }[] = [];
  const open: { name: string; index?: number }[] = [];
  for (const match of html.matchAll(TOKEN)) {
    const name = match[3]?.toLowerCase();
    if (!name || !BARRIERS.has(name)) continue;
    const end = match.index! + match[0].length;
    if (match[2] === "/") {
      const at = open.map((entry) => entry.name).lastIndexOf(name);
      if (at < 0) continue;
      const element = elements[open.splice(at)[0]!.index ?? -1];
      if (element) element.bodyEnd = match.index!;
      continue;
    }
    if (match[4]!.trimEnd().endsWith("/")) continue;
    const topLevel = open.length === 0 && TARGETS.has(name);
    if (topLevel) elements.push({ name, tagEnd: match.index! + 1 + name.length, attrs: match[4]!, bodyStart: end, bodyEnd: html.length });
    open.push({ name, ...(topLevel ? { index: elements.length - 1 } : {}) });
  }
  const keys: string[] = [];
  const taken = new Set<string>();
  const inserts: { at: number; text: string }[] = [];
  elements.forEach((element, index) => {
    const own = attribute(element.attrs, "data-zyg-section");
    if (own) {
      keys.push(own);
      taken.add(own);
      return;
    }
    const id = attribute(element.attrs, "id") ?? "";
    const inner = /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bid\s*=\s*"([^"]+)"/.exec(html.slice(element.bodyStart, element.bodyEnd))?.[1] ?? "";
    const shopify = /__([A-Za-z0-9_-]+)$/.exec(id)?.[1];
    const candidate = shopify ?? (id && !id.startsWith("shopify-section") ? id : inner) ?? "";
    let key = sectionKey(candidate) || `section-${index + 1}`;
    for (let n = 2; taken.has(key); n += 1) key = `${key.replace(/-\d+$/, "").slice(0, 58)}-${n}`;
    taken.add(key);
    keys.push(key);
    inserts.push({ at: element.tagEnd, text: ` data-zyg-section="${key}"` });
  });
  let result = html;
  for (const insert of inserts.sort((left, right) => right.at - left.at)) result = result.slice(0, insert.at) + insert.text + result.slice(insert.at);
  return { html: result, keys };
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs)?.slice(1).find((value) => value !== undefined);
}

function sectionKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return SECTION_ID.test(key) ? key : "";
}

export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
