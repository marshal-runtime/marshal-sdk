// Pages a run made with Page Studio. A host that runs Page Studio keeps them in its PAGE_STUDIO_DIR: pages/<id>.json
// (the page record with its sections) and library/<brand>/{brand.json, pictures/} (the pictures pages show as
// https://pagestudio.library/<brand>/<name>). The link exports one page with the pictures it shows, and
// writePage() lays it out as a Page Studio data folder again, which pagestudio.page.import takes in.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,160}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const PICTURE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
const LIBRARY_URL = /https:\/\/pagestudio\.library\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})/g;
/** A page belongs to a run when the run last changed it: from shortly before the run started to a while after it ended. */
const BEFORE_RUN_MS = 60_000;
const AFTER_RUN_MS = 15 * 60_000;
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

type Row = Record<string, any>;

export interface PageSummary {
  id: string;
  title: string;
  brand: { id: string; name: string };
  product: string | null;
  source: string;
  sections: number;
  labels: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  notesOpen: number;
  pictures: { library: number; missing: number };
  /** The run that last changed this page, or null for a page that was already there (a base page). */
  runId: string | null;
}

export interface PagePicture {
  url: string;
  brand: string;
  name: string;
  bytes: number;
  sha256: string;
  /** The library's record of it (what it shows, crop notes), when it has one. */
  record?: Row;
}

export interface PageManifest {
  format: "page-studio-page";
  version: 1;
  page: Row;
  pictures: PagePicture[];
  /** Library pictures the page shows that this host does not have. */
  missing: string[];
  /** Per brand: what Page Studio knows beyond the pictures (facts, design plan, offers, product). */
  brands: Record<string, Row>;
}

export interface RunWindow {
  runId: string;
  startedAt: string;
  updatedAt: string;
  running?: number;
}

const contentType = (name: string): string =>
  ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", svg: "image/svg+xml" })[
    path.extname(name).slice(1).toLowerCase()
  ] ?? "application/octet-stream";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function libraryUrls(page: Row): string[] {
  const urls = new Set<string>();
  const scan = (text: unknown) => {
    if (typeof text === "string") for (const match of text.matchAll(LIBRARY_URL)) urls.add(match[0]);
  };
  for (const section of Array.isArray(page.sections) ? page.sections : []) scan(section?.src);
  for (const value of Object.values(page.tokens ?? {})) scan(value);
  return [...urls];
}

/** Page Studio's own rule (create.ts isPlumbing): a section of only styles and tokens, nothing a visitor reads or sees. */
function isPlumbing(section: Row): boolean {
  const body = String(section?.src ?? "").replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, "");
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return !text && !/<(img|picture|video|svg|iframe|form|input|button)\b/i.test(body);
}

const isPage = (value: unknown): value is Row => {
  const page = value as Row | null;
  return !!page && typeof page === "object" && typeof page.title === "string" && !!page.brand && Array.isArray(page.sections);
};

export class PageStore {
  constructor(readonly dir: string) {}

  private pageFile(id: string): string | undefined {
    if (!PAGE_ID.test(id)) return undefined;
    return this.inside(path.join(this.dir, "pages", `${id}.json`));
  }

  /** The real path of a file under the data folder, or undefined when it is missing or leaves it. */
  private inside(file: string): string | undefined {
    try {
      const root = fs.realpathSync(this.dir);
      const real = fs.realpathSync(file);
      return real.startsWith(root + path.sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  page(id: string): Row | undefined {
    const file = this.pageFile(id);
    const page = file ? readJson(file) : null;
    return isPage(page) ? page : undefined;
  }

  pictureFile(brand: string, name: string): string | undefined {
    if (!SAFE.test(brand) || !SAFE.test(name) || !PICTURE_EXT.test(name)) return undefined;
    return this.inside(path.join(this.dir, "library", brand, "pictures", name));
  }

  /** Every page in the folder, newest change first, each with the run that last changed it. */
  list(runs: readonly RunWindow[] = []): PageSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(this.dir, "pages")).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const pages: PageSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      const page = this.page(id);
      if (!page) continue;
      const urls = libraryUrls(page);
      const missing = urls.filter((url) => {
        const [, brand, file] = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(url) ?? [];
        return !brand || !file || !this.pictureFile(brand, file);
      }).length;
      const updatedAt = String(page.updatedAt ?? "");
      pages.push({
        id,
        title: page.title,
        brand: { id: String(page.brand?.id ?? ""), name: String(page.brand?.name ?? "") },
        product: typeof page.product === "string" ? page.product : null,
        source: String(page.source ?? ""),
        sections: page.sections.length,
        labels: page.sections.filter((section: Row) => !isPlumbing(section)).map((section: Row) => String(section?.label ?? section?.key ?? "")).slice(0, 24),
        version: Number(page.version ?? 0),
        updatedAt,
        updatedBy: String(page.updatedBy ?? ""),
        notesOpen: Array.isArray(page.notes) ? page.notes.filter((note: Row) => note?.status === "open").length : 0,
        pictures: { library: urls.length - missing, missing },
        runId: runOf(updatedAt, runs),
      });
    }
    return pages.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** One page with the pictures it shows: what a client needs to bring it into its own Page Studio. */
  manifest(id: string): PageManifest | undefined {
    const page = this.page(id);
    if (!page) return undefined;
    const pictures: PagePicture[] = [];
    const missing: string[] = [];
    const brands: Record<string, Row> = {};
    const libraries = new Map<string, Row | null>();
    const library = (brand: string) => {
      if (!libraries.has(brand)) libraries.set(brand, SAFE.test(brand) ? (readJson(path.join(this.dir, "library", brand, "brand.json")) as Row | null) : null);
      return libraries.get(brand) ?? null;
    };
    for (const url of libraryUrls(page)) {
      const [, brand, name] = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(url) ?? [];
      const file = brand && name ? this.pictureFile(brand, name) : undefined;
      if (!brand || !name || !file) {
        missing.push(url);
        continue;
      }
      const bytes = fs.readFileSync(file);
      const record = (Array.isArray(library(brand)?.pictures) ? library(brand)!.pictures : []).find((entry: Row) => entry?.url === url);
      pictures.push({ url, brand, name, bytes: bytes.length, sha256: sha256(bytes), ...(record ? { record } : {}) });
    }
    for (const brand of new Set([String(page.brand?.id ?? ""), ...pictures.map((picture) => picture.brand)])) {
      const lib = brand ? library(brand) : null;
      if (!lib) continue;
      const { pictures: _pictures, ...rest } = lib;
      brands[brand] = rest;
    }
    return { format: "page-studio-page", version: 1, page, pictures, missing, brands };
  }

  /** A picture the page shows, with its content type; undefined when the page doesn't show it. */
  picture(id: string, brand: string, name: string): { bytes: Buffer; type: string } | undefined {
    const page = this.page(id);
    if (!page || !libraryUrls(page).includes(`https://pagestudio.library/${brand}/${name}`)) return undefined;
    const file = this.pictureFile(brand, name);
    if (!file || fs.statSync(file).size > MAX_PICTURE_BYTES) return undefined;
    return { bytes: fs.readFileSync(file), type: contentType(name) };
  }
}

function runOf(updatedAt: string, runs: readonly RunWindow[]): string | null {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return null;
  let best: RunWindow | undefined;
  for (const run of runs) {
    const start = Date.parse(run.startedAt) - BEFORE_RUN_MS;
    const end = run.running ? Number.POSITIVE_INFINITY : Date.parse(run.updatedAt) + AFTER_RUN_MS;
    if (at >= start && at <= end && (!best || run.startedAt > best.startedAt)) best = run;
  }
  return best?.runId ?? null;
}

/**
 * Lays a page out as a Page Studio data folder under `target` (pages/<id>.json, library/<brand>/pictures/<name>,
 * library/<brand>/brand.json with the records of those pictures), fetching each picture and checking its hash.
 */
export async function writePage(
  target: string,
  manifest: PageManifest,
  fetchPicture: (picture: PagePicture) => Promise<Buffer>,
): Promise<{ dataDir: string; pageId: string; pictures: number; bytes: number }> {
  const id = String(manifest.page.id ?? "");
  if (manifest.format !== "page-studio-page" || !PAGE_ID.test(id) || !isPage(manifest.page)) throw new Error("That is not a Page Studio page.");
  let bytes = 0;
  const records = new Map<string, Row[]>();
  for (const picture of manifest.pictures) {
    if (!SAFE.test(picture.brand) || !SAFE.test(picture.name) || !PICTURE_EXT.test(picture.name)) continue;
    const file = path.join(target, "library", picture.brand, "pictures", picture.name);
    let have: Buffer | undefined;
    try {
      have = fs.readFileSync(file);
    } catch {
      // Not pulled yet.
    }
    if (!have || sha256(have) !== picture.sha256) {
      const fetched = await fetchPicture(picture);
      if (sha256(fetched) !== picture.sha256) throw new Error(`Picture ${picture.name} arrived damaged (its hash does not match).`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fetched);
      bytes += fetched.length;
    }
    if (picture.record) records.set(picture.brand, [...(records.get(picture.brand) ?? []), picture.record]);
  }
  for (const brand of new Set([...records.keys(), ...Object.keys(manifest.brands ?? {})])) {
    if (!SAFE.test(brand)) continue;
    const file = path.join(target, "library", brand, "brand.json");
    const existing = readJson(file) as Row | null;
    const library: Row = existing && Array.isArray(existing.pictures) ? existing : { brand, ...(manifest.brands?.[brand] ?? {}), pictures: [] };
    for (const record of records.get(brand) ?? []) {
      library.pictures = [...library.pictures.filter((entry: Row) => entry?.url !== record.url), record];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(library, null, 1));
  }
  const pageFile = path.join(target, "pages", `${id}.json`);
  fs.mkdirSync(path.dirname(pageFile), { recursive: true });
  fs.writeFileSync(`${pageFile}.${process.pid}.tmp`, JSON.stringify(manifest.page));
  fs.renameSync(`${pageFile}.${process.pid}.tmp`, pageFile);
  return { dataDir: target, pageId: id, pictures: manifest.pictures.length, bytes };
}
