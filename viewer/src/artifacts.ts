// Run manifest v1 and versioned artifacts. A cloud run's truth is one small manifest; what a run made (a Page Studio page)
// is an artifact with immutable versions and a `current` pointer that only moves by a conditional write.
//
//   <root>/agent/marshal-state/run.json        the run manifest (their fields untouched, ours added)
//   <root>/artifacts/<app>/<id>/manifest.json   {app, kind, id, title, versions[{v, dir, at, by, summary, pictures}], current}
//   <root>/artifacts/<app>/<id>/versions/<n>/   page.json (the page record), pictures.json (what it shows), preview.html
//   <root>/artifacts/<app>/<id>/pictures/<sha256><ext>   pictures a push added, by content
//
// A picture entry's `path` is relative to the run root: images/<name> for a picture the platform's own output already
// holds (never copied), or artifacts/.../pictures/<sha256><ext> for one a push added.
import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";

import { gcsList, gcsRead, gcsWrite, generationOf, PreconditionFailed } from "./gcs";

type Row = Record<string, any>;

export const MANIFEST_SCHEMA_VERSION = 1;
export const VISIBILITIES = ["public", "team", "restricted"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

const trim = (uri: string) => uri.replace(/\/+$/, "");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const isSafeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value);

// ---- The run manifest ----

export interface SessionEntry {
  id: string;
  role: string;
  bytes: number;
  hasEnvelope: boolean;
}

export interface ArtifactRef {
  app: string;
  kind: string;
  id: string;
  title: string;
  current: number;
}

export interface RunManifest extends Row {
  schemaVersion: 1;
  runId: string;
  title: string;
  /** The org workspace the run belongs to (brand is a label). */
  workspace: string;
  /** The procedure: page-generation, page-edit, marley-turn, routine:<id>. */
  workflow: string;
  labels: Record<string, string>;
  visibility: Visibility;
  requester: string | null;
  status: string;
  sessions: SessionEntry[];
  artifacts: ArtifactRef[];
  links: { rel: string; url: string }[];
  stateLocation?: string;
}

/** What is wrong with a manifest, empty when it is a valid v1. Extra fields are allowed: runs carry their own. */
export function manifestProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["not an object"];
  const row = raw as Row;
  if (row.schemaVersion !== MANIFEST_SCHEMA_VERSION) problems.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  for (const key of ["runId", "title", "workspace", "workflow", "status"]) if (typeof row[key] !== "string" || !row[key]) problems.push(`${key} must be a non-empty string`);
  if (!VISIBILITIES.includes(row.visibility)) problems.push(`visibility must be one of ${VISIBILITIES.join(", ")}`);
  if (row.requester !== null && typeof row.requester !== "string") problems.push("requester must be a string or null");
  if (!row.labels || typeof row.labels !== "object" || Array.isArray(row.labels) || Object.values(row.labels).some((value) => typeof value !== "string")) problems.push("labels must map names to strings");
  if (!Array.isArray(row.sessions) || row.sessions.some((s: Row) => !isSafeId(s?.id) || typeof s.role !== "string" || typeof s.bytes !== "number" || typeof s.hasEnvelope !== "boolean")) problems.push("sessions must list {id, role, bytes, hasEnvelope}");
  if (!Array.isArray(row.artifacts) || row.artifacts.some((a: Row) => typeof a?.app !== "string" || !isSafeId(a?.id) || typeof a.kind !== "string" || typeof a.title !== "string" || !Number.isInteger(a.current) || a.current < 0)) problems.push("artifacts must list {app, kind, id, title, current}");
  if (!Array.isArray(row.links) || row.links.some((l: Row) => typeof l?.rel !== "string" || typeof l?.url !== "string")) problems.push("links must list {rel, url}");
  return problems;
}

/**
 * Adds manifest v1 fields to an existing run.json without touching the ones already there: the platform's and agent-sandbox's
 * keys keep their values; only fields the run did not have are filled from `fill`. `artifacts`, `sessions` and `links`
 * from `fill` replace the old ones (the runner rewrites them as they grow).
 */
export function extendRunJson(existing: Row, fill: Partial<RunManifest> & { runId: string }): RunManifest {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...(fill.labels ?? {}), ...(existing.labels && typeof existing.labels === "object" ? existing.labels : {}) })) if (typeof value === "string") labels[key] = value;
  const out: Row = { ...existing };
  const keep = (key: string, value: unknown) => {
    if (out[key] === undefined || out[key] === null || out[key] === "") out[key] = value;
  };
  keep("runId", fill.runId);
  keep("title", fill.title ?? fill.runId);
  keep("workspace", fill.workspace ?? "pages");
  keep("workflow", fill.workflow ?? "page-generation");
  keep("visibility", fill.visibility ?? "team");
  if (!VISIBILITIES.includes(out.visibility)) out.visibility = "team";
  if (out.requester === undefined) out.requester = fill.requester ?? (typeof existing.startedBy === "string" ? existing.startedBy : null);
  keep("status", fill.status ?? "done");
  if (fill.stateLocation) keep("stateLocation", fill.stateLocation);
  out.schemaVersion = MANIFEST_SCHEMA_VERSION;
  out.labels = labels;
  out.sessions = fill.sessions ?? (Array.isArray(existing.sessions) ? existing.sessions : []);
  out.artifacts = fill.artifacts ?? (Array.isArray(existing.artifacts) ? existing.artifacts : []);
  out.links = fill.links ?? (Array.isArray(existing.links) ? existing.links : []);
  return out as RunManifest;
}

// ---- Artifact manifests and versions ----

export interface VersionEntry {
  v: number;
  /** The version's folder relative to the artifact: versions/<v>, or versions/<v>-<nonce> when a crashed push left that one. */
  dir: string;
  at: string;
  by: { name?: string; email?: string };
  summary: string;
  pictures: number;
  /** The page record's own version counter at that point, for people comparing with Page Studio. */
  docVersion?: number;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  app: string;
  kind: string;
  id: string;
  title: string;
  versions: VersionEntry[];
  current: number;
}

export interface PictureEntry {
  brand: string;
  name: string;
  bytes?: number;
  sha256?: string;
  /** Relative to the run root. */
  path: string;
}

export const artifactDir = (root: string, app: string, id: string) => `${trim(root)}/artifacts/${app}/${id}`;

export function parseArtifactManifest(raw: unknown): ArtifactManifest {
  const row = raw as Row;
  if (!row || typeof row !== "object" || row.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error("artifact manifest: unknown schemaVersion");
  if (typeof row.app !== "string" || !isSafeId(row.id) || typeof row.kind !== "string" || !Array.isArray(row.versions)) throw new Error("artifact manifest: app, kind, id and versions are required");
  const versions: VersionEntry[] = row.versions.map((entry: Row) => {
    if (!Number.isInteger(entry?.v) || entry.v < 1 || typeof entry.dir !== "string" || !/^versions\/[A-Za-z0-9._-]+$/.test(entry.dir)) throw new Error("artifact manifest: a version needs v and dir");
    return { v: entry.v, dir: entry.dir, at: String(entry.at ?? ""), by: entry.by && typeof entry.by === "object" ? entry.by : {}, summary: String(entry.summary ?? ""), pictures: Number(entry.pictures ?? 0), ...(Number.isFinite(entry.docVersion) ? { docVersion: Number(entry.docVersion) } : {}) };
  });
  const current = Number(row.current);
  if (!versions.some((entry) => entry.v === current)) throw new Error(`artifact manifest: current ${row.current} is not a listed version`);
  return { schemaVersion: 1, app: row.app, kind: row.kind, id: row.id, title: String(row.title ?? row.id), versions, current };
}

export async function readArtifactManifest(root: string, app: string, id: string): Promise<{ manifest?: ArtifactManifest; generation: string }> {
  const read = await gcsRead(`${artifactDir(root, app, id)}/manifest.json`);
  if (!read) return { generation: "0" };
  return { manifest: parseArtifactManifest(JSON.parse(read.data.toString("utf8"))), generation: generationOf(read) };
}

// ---- A page as it exists in a run before it had versions ----

/** Where pages of a state folder live: agent-sandbox keeps PAGE_STUDIO_DIR as page-studio/, page-run folders as data/. */
const studioFolders = (state: string) => [`${trim(state)}/page-studio`, `${trim(state)}/data`];

/** Brand and picture names a page record shows (Page Studio's library URLs: a grammar, not language). */
export function picturesOfPage(doc: Row): { brand: string; name: string }[] {
  const seen = new Map<string, { brand: string; name: string }>();
  for (const match of JSON.stringify(doc).matchAll(/(?:\/library\/|pagestudio\.library\/)([A-Za-z0-9._-]+)\/(?:pictures\/)?([A-Za-z0-9._%-]+\.(?:png|jpe?g|webp|gif|avif|svg))/gi)) {
    const name = decodeURIComponent(match[2]!);
    seen.set(`${match[1]}/${name}`, { brand: match[1]!, name });
  }
  return [...seen.values()];
}

export interface PageVersionFiles {
  doc: Row;
  previewHtml: string;
  pictures: PictureEntry[];
}

/** The page record, preview and pictures a run has for a page without versions; undefined when it has no such page. */
export async function legacyPage(root: string, state: string, id: string, options: { preview?: boolean } = {}): Promise<PageVersionFiles | undefined> {
  if (!isSafeId(id)) return undefined;
  let doc: Row | undefined;
  let studio = "";
  for (const folder of studioFolders(state)) {
    const read = await gcsRead(`${folder}/pages/${id}.json`);
    if (read) {
      doc = JSON.parse(read.data.toString("utf8")) as Row;
      studio = folder;
      break;
    }
  }
  if (!doc) return undefined;
  // The run's preview is its landing page's; a brand board or any other page of the run has none of its own.
  const preview = options.preview === false ? undefined : await gcsRead(`${trim(root)}/preview/index.html`);
  const wanted = picturesOfPage(doc);
  const images = new Map((await gcsList(`${trim(root)}/images`)).map((item) => [item.uri.split("/").pop()!, item.size]));
  const pictures: PictureEntry[] = [];
  const libraries = new Map<string, Map<string, number | undefined>>();
  for (const { brand, name } of wanted) {
    if (images.has(name)) {
      pictures.push({ brand, name, path: `images/${name}`, ...(images.get(name) !== undefined ? { bytes: images.get(name) } : {}) });
      continue;
    }
    if (!libraries.has(brand)) libraries.set(brand, new Map((await gcsList(`${studio}/library/${brand}/pictures`)).map((item) => [item.uri.split("/").pop()!, item.size])));
    const inLibrary = libraries.get(brand)!;
    if (inLibrary.has(name)) pictures.push({ brand, name, path: `${studio.slice(trim(root).length + 1)}/library/${brand}/pictures/${name}`, ...(inLibrary.get(name) !== undefined ? { bytes: inLibrary.get(name) } : {}) });
  }
  return { doc, previewHtml: preview ? preview.data.toString("utf8") : "", pictures };
}

// ---- Writing a version ----

export interface NewPicture {
  brand: string;
  name: string;
  file: string;
}

export interface CommitInput {
  root: string;
  /** The run's Marshal state folder, where a page without versions is read from. */
  state: string;
  app: string;
  kind: string;
  id: string;
  title: string;
  /** The artifact version the person's copy was made from; 0 when the run had no manifest for it. */
  baseVersion: number;
  doc: Row;
  previewHtml: string;
  pictures: NewPicture[];
  by: { name?: string; email?: string };
  summary?: string;
  now?: () => Date;
}

export type CommitResult =
  | { ok: true; version: number; dir: string; seeded: boolean; uploaded: number; reused: number; manifest: ArtifactManifest }
  | { ok: false; reason: "cloud-moved"; current: number; baseVersion: number; message: string };

const MIME_EXT = /\.[A-Za-z0-9]{1,5}$/;
const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const moved = (current: number, baseVersion: number): CommitResult => ({
  ok: false,
  reason: "cloud-moved",
  current,
  baseVersion,
  message: `The cloud page is at version ${current} now, and your copy was made from ${baseVersion || "the original"}: pull the latest, then push again.`,
});

/**
 * Writes the next version of a page artifact. The new version's files are written first (immutable, one claim per folder),
 * then the manifest moves `current` to it with ifGenerationMatch: of two pushes made from the same version exactly one
 * commits, the other is refused with "cloud-moved". A run's page that had no versions gets its build as version 1 first.
 */
export async function commitPageVersion(input: CommitInput): Promise<CommitResult> {
  const root = trim(input.root);
  const base = artifactDir(root, input.app, input.id);
  const now = input.now ?? (() => new Date());
  const existing = await readArtifactManifest(root, input.app, input.id);
  let manifest = existing.manifest;
  let seeded = false;
  let previous: PictureEntry[] = [];
  const entries: VersionEntry[] = manifest ? [...manifest.versions] : [];
  if (manifest) {
    if (manifest.current !== input.baseVersion) return moved(manifest.current, input.baseVersion);
    const was = await gcsRead(`${base}/${manifest.versions.find((entry) => entry.v === manifest!.current)!.dir}/pictures.json`);
    if (was) previous = JSON.parse(was.data.toString("utf8")) as PictureEntry[];
  } else {
    if (input.baseVersion !== 0) return moved(0, input.baseVersion);
    const legacy = await legacyPage(root, input.state, input.id, { preview: input.kind === "landing-page" });
    if (legacy) {
      const entry = await writeVersion(base, 1, legacy, { at: now().toISOString(), by: { name: "build" }, summary: "The page as the run built it", docVersion: Number(legacy.doc.version ?? 0) });
      entries.push(entry);
      previous = legacy.pictures;
      seeded = true;
    }
  }
  const next = (entries.at(-1)?.v ?? 0) + 1;
  let uploaded = 0;
  let reused = 0;
  const pictures: PictureEntry[] = [];
  for (const picture of input.pictures) {
    const bytes = fs.statSync(picture.file).size;
    const same = previous.find((entry) => entry.brand === picture.brand && entry.name === picture.name && entry.bytes === bytes);
    if (same) {
      pictures.push(same);
      reused += 1;
      continue;
    }
    const sha256 = sha256File(picture.file);
    const rel = `artifacts/${input.app}/${input.id}/pictures/${sha256}${path.extname(picture.name).match(MIME_EXT)?.[0] ?? ""}`;
    try {
      await gcsWrite(`${root}/${rel}`, fs.readFileSync(picture.file), { ifGenerationMatch: "0", cacheControl: "public, max-age=31536000, immutable" });
      uploaded += 1;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error; // already there: same content by name
      reused += 1;
    }
    pictures.push({ brand: picture.brand, name: picture.name, bytes, sha256, path: rel });
  }
  const entry = await writeVersion(base, next, { doc: input.doc, previewHtml: input.previewHtml, pictures }, { at: now().toISOString(), by: input.by, summary: input.summary ?? "", docVersion: Number(input.doc.version ?? 0) });
  entries.push(entry);
  manifest = { schemaVersion: 1, app: input.app, kind: input.kind, id: input.id, title: input.title, versions: entries, current: next };
  try {
    // For a page that had no manifest the condition is "does not exist"; otherwise the generation read above.
    await gcsWrite(`${base}/manifest.json`, JSON.stringify(manifest, null, 2), { contentType: "application/json", cacheControl: "no-cache", ifGenerationMatch: existing.generation });
  } catch (error) {
    if (!(error instanceof PreconditionFailed)) throw error;
    const now = await readArtifactManifest(root, input.app, input.id);
    return moved(now.manifest?.current ?? 0, input.baseVersion);
  }
  return { ok: true, version: next, dir: entry.dir, seeded, uploaded, reused, manifest };
}

/**
 * Gives a page a run built (and never versioned) its version 1: the page as the run built it, written by the manifest's own
 * conditional create. Backfill uses this for runs made before manifests; a page that already has a manifest is returned as is.
 */
export async function seedArtifact(input: { root: string; state: string; app: string; kind: string; id: string; title?: string; now?: () => Date }): Promise<{ manifest: ArtifactManifest; created: boolean } | undefined> {
  const root = trim(input.root);
  const existing = await readArtifactManifest(root, input.app, input.id);
  if (existing.manifest) return { manifest: existing.manifest, created: false };
  const legacy = await legacyPage(root, input.state, input.id, { preview: input.kind === "landing-page" });
  if (!legacy) return undefined;
  const base = artifactDir(root, input.app, input.id);
  const entry = await writeVersion(base, 1, legacy, { at: (input.now ?? (() => new Date()))().toISOString(), by: { name: "build" }, summary: "The page as the run built it", docVersion: Number(legacy.doc.version ?? 0) });
  const manifest: ArtifactManifest = { schemaVersion: 1, app: input.app, kind: input.kind, id: input.id, title: input.title ?? String(legacy.doc.title ?? input.id), versions: [entry], current: 1 };
  try {
    await gcsWrite(`${base}/manifest.json`, JSON.stringify(manifest, null, 2), { contentType: "application/json", cacheControl: "no-cache", ifGenerationMatch: "0" });
    return { manifest, created: true };
  } catch (error) {
    if (!(error instanceof PreconditionFailed)) throw error;
    const now = await readArtifactManifest(root, input.app, input.id);
    return now.manifest ? { manifest: now.manifest, created: false } : undefined;
  }
}

async function writeVersion(base: string, v: number, files: PageVersionFiles, meta: Pick<VersionEntry, "at" | "by" | "summary" | "docVersion">): Promise<VersionEntry> {
  // page.json claims the folder: a folder a crashed push left behind is skipped, never overwritten.
  let dir = `versions/${v}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await gcsWrite(`${base}/${dir}/page.json`, JSON.stringify(files.doc), { contentType: "application/json", ifGenerationMatch: "0" });
      break;
    } catch (error) {
      if (!(error instanceof PreconditionFailed) || attempt >= 3) throw error;
      dir = `versions/${v}-${createHash("sha256").update(`${Date.now()}-${attempt}-${Math.random()}`).digest("hex").slice(0, 6)}`;
    }
  }
  await gcsWrite(`${base}/${dir}/pictures.json`, JSON.stringify(files.pictures, null, 2), { contentType: "application/json" });
  await gcsWrite(`${base}/${dir}/preview.html`, files.previewHtml, { contentType: "text/html; charset=utf-8" });
  return { v, dir, at: meta.at, by: meta.by, summary: meta.summary, pictures: files.pictures.length, ...(meta.docVersion !== undefined ? { docVersion: meta.docVersion } : {}) };
}

/** Reads one version's files (the page record, its picture list and preview) from the bucket. */
export async function readVersion(root: string, app: string, id: string, entry: VersionEntry): Promise<{ doc: Row; pictures: PictureEntry[]; previewHtml: string; bytes: number }> {
  const base = `${artifactDir(root, app, id)}/${entry.dir}`;
  const [page, pictures, preview] = await Promise.all([gcsRead(`${base}/page.json`), gcsRead(`${base}/pictures.json`), gcsRead(`${base}/preview.html`)]);
  if (!page) throw new Error(`${base}/page.json is missing`);
  return {
    doc: JSON.parse(page.data.toString("utf8")) as Row,
    pictures: pictures ? (JSON.parse(pictures.data.toString("utf8")) as PictureEntry[]) : [],
    previewHtml: preview ? preview.data.toString("utf8") : "",
    bytes: page.data.length + (pictures?.data.length ?? 0) + (preview?.data.length ?? 0),
  };
}
