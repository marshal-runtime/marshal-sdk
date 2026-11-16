// Cloud pages the lazy way. The list is built from rows the cloud host already holds (a run's manifest says which artifacts
// it made); nothing is downloaded for it. Opening one page fetches that page's record and the pictures it shows into the
// cache, writes them as a small Page Studio data folder, and leaves everything else of the run in the bucket.
import fs from "fs";
import path from "path";

import { legacyPage, picturesOfPage, readArtifactManifest, type ArtifactManifest, type PictureEntry } from "./artifacts";
import type { CloudCache, Transfer } from "./cache";
import type { CloudRun } from "./cloud";

type Row = Record<string, any>;
const trim = (uri: string) => uri.replace(/\/+$/, "");

export interface PageRow {
  hostId: string;
  outputRoot: string;
  runId: string;
  runTitle: string;
  workspace: string;
  workflow: string;
  brand: string | null;
  labels: Record<string, string>;
  visibility: string;
  requester: string | null;
  status: string;
  startedAt: string | null;
  /** The run made this page on the Marshal SDK (its page can be opened and pushed back as artifact versions). */
  marshal: boolean;
  artifact: { app: string; kind: string; id: string; title: string; current: number | null; legacy: boolean };
  previewUrl: string;
}

export interface PageFilter {
  /** Words matched against the structured fields of a row (title, brand, ids, workspace, workflow, labels, requester). */
  query?: string;
  workspace?: string;
  workflow?: string;
  brand?: string;
  requester?: string;
  status?: string;
  kind?: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** One row per page artifact of each run. A run without a manifest still shows its page (legacy: no versions yet). */
export function pageRows(runs: readonly CloudRun[]): PageRow[] {
  const rows: PageRow[] = [];
  for (const run of runs) {
    const info = run.run ?? {};
    const base = {
      hostId: run.hostId,
      outputRoot: run.outputRoot,
      runId: text(info.runId) || run.outputRoot.split("/").pop()!,
      runTitle: text(info.title) || run.outputRoot.split("/").pop()!,
      workspace: text(info.workspace) || "pages",
      workflow: text(info.workflow) || (run.marshal ? "page-generation" : "page-generation"),
      brand: text(info.brand) || null,
      labels: info.labels && typeof info.labels === "object" ? (info.labels as Record<string, string>) : {},
      visibility: text(info.visibility) || "team",
      requester: text(info.requester) || text(info.startedBy) || null,
      status: text(info.status) || (run.marshal ? "unknown" : "done"),
      startedAt: text(info.startedAt) || null,
      marshal: run.marshal,
      previewUrl: run.previewUrl,
    };
    const artifacts = Array.isArray(info.artifacts) ? (info.artifacts as Row[]).filter((a) => a && a.app === "page" && typeof a.id === "string") : [];
    if (artifacts.length) {
      for (const a of artifacts) rows.push({ ...base, artifact: { app: "page", kind: text(a.kind) || "landing-page", id: a.id, title: text(a.title) || base.runTitle, current: Number.isInteger(a.current) && a.current >= 1 ? a.current : null, legacy: !(Number.isInteger(a.current) && a.current >= 1) } });
    } else if (run.marshal && typeof info.pageId === "string") {
      rows.push({ ...base, artifact: { app: "page", kind: "landing-page", id: info.pageId, title: base.runTitle, current: null, legacy: true } });
    } else {
      rows.push({ ...base, artifact: { app: "page", kind: "landing-page", id: base.runId, title: base.runTitle, current: null, legacy: true } });
    }
  }
  return rows;
}

export function filterRows(rows: readonly PageRow[], filter: PageFilter): PageRow[] {
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => (filter.workspace ? row.workspace === filter.workspace : true))
    .filter((row) => (filter.workflow ? row.workflow === filter.workflow : true))
    .filter((row) => (filter.brand ? (row.brand ?? "").toLowerCase() === filter.brand.toLowerCase() : true))
    .filter((row) => (filter.requester ? (row.requester ?? "") === filter.requester : true))
    .filter((row) => (filter.status ? row.status === filter.status : true))
    .filter((row) => (filter.kind ? row.artifact.kind === filter.kind : true))
    .filter((row) => {
      if (!words.length) return true;
      const hay = [row.runTitle, row.artifact.title, row.artifact.id, row.runId, row.brand, row.workspace, row.workflow, row.requester, ...Object.values(row.labels)].join(" ").toLowerCase();
      return words.every((word) => hay.includes(word));
    })
    .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
}

export interface OpenInput {
  hostId: string;
  root: string;
  /** The run's Marshal state folder in the bucket. */
  state: string;
  runKey: string;
  visibility?: string;
  id: string;
  /** A version to open; the current one by default. */
  version?: number;
  cache: CloudCache;
}

export interface OpenedPage {
  dataDir: string;
  pageId: string;
  /** The artifact version opened; 0 for a page the run built before artifacts had versions. */
  version: number;
  current: number;
  title: string;
  pictures: number;
  manifest?: ArtifactManifest;
  transfer: Transfer;
  files: string[];
}

/** Fetches one page (record and the pictures it shows) into the cache and lays it out as a Page Studio data folder. */
export async function openPage(input: OpenInput): Promise<OpenedPage> {
  const root = trim(input.root);
  const { cache, hostId, runKey } = input;
  if (input.visibility === "restricted") cache.markRestricted(hostId, runKey);
  const transfer: Transfer = { downloaded: 0, cached: 0, files: 0 };
  const { manifest } = await readArtifactManifest(root, "page", input.id);
  let pictures: PictureEntry[];
  let doc: Row;
  let docFile: string;
  let version = 0;
  const used: string[] = [];
  const track = (part: Transfer) => {
    transfer.downloaded += part.downloaded;
    transfer.cached += part.cached;
    transfer.files += part.files;
  };
  if (manifest) {
    const entry = manifest.versions.find((candidate) => candidate.v === (input.version ?? manifest.current));
    if (!entry) throw new Error(`Version ${input.version} of ${input.id} does not exist (current is ${manifest.current}).`);
    version = entry.v;
    const base = `${root}/artifacts/page/${input.id}/${entry.dir}`;
    const first = await cache.fetchAll(hostId, runKey, [
      { uri: `${base}/page.json`, rel: `artifacts/page/${input.id}/${entry.dir}/page.json` },
      { uri: `${base}/pictures.json`, rel: `artifacts/page/${input.id}/${entry.dir}/pictures.json` },
    ]);
    track(first.transfer);
    used.push(...first.files);
    docFile = first.files[0]!;
    doc = JSON.parse(fs.readFileSync(docFile, "utf8")) as Row;
    pictures = JSON.parse(fs.readFileSync(first.files[1]!, "utf8")) as PictureEntry[];
  } else {
    const legacy = await legacyPage(root, input.state, input.id);
    if (!legacy) throw new Error(`The run has no page ${input.id}.`);
    doc = legacy.doc;
    pictures = legacy.pictures;
    docFile = cache.write(hostId, runKey, `legacy/${input.id}.json`, JSON.stringify(doc));
    used.push(docFile);
    transfer.downloaded += Buffer.byteLength(JSON.stringify(doc));
    transfer.files += 1;
  }
  const blobs = await cache.fetchAll(hostId, runKey, pictures.map((picture) => ({ uri: `${root}/${picture.path}`, rel: picture.path, ...(picture.bytes !== undefined ? { bytes: picture.bytes } : {}) })));
  track(blobs.transfer);
  used.push(...blobs.files);
  const dataDir = cache.fileOf(hostId, runKey, `pagedata/${input.id}-v${version}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pages", `${input.id}.json`), JSON.stringify(doc));
  pictures.forEach((picture, index) => {
    const target = path.join(dataDir, "library", picture.brand, "pictures", picture.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(blobs.files[index]!, target);
    } catch {
      fs.copyFileSync(blobs.files[index]!, target);
    }
  });
  cache.evict(new Set(used));
  const stillNamed = new Set(picturesOfPage(doc).map((picture) => picture.name));
  return { dataDir, pageId: input.id, version, current: manifest?.current ?? 0, title: String(doc.title ?? input.id), pictures: pictures.filter((picture) => stillNamed.has(picture.name)).length, ...(manifest ? { manifest } : {}), transfer, files: used };
}

/** Just the current version of a page artifact (a small read), or 0 when the run keeps no versions of it. */
export async function currentVersion(root: string, id: string): Promise<number> {
  const { manifest } = await readArtifactManifest(root, "page", id);
  return manifest?.current ?? 0;
}

