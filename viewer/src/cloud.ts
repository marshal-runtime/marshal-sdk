// Cloud runs: page generations agent-sandbox ran on the Marshal SDK, kept in GCS under each run's output root.
//
//   <outputRoot>/preview/index.html          the page their page generator UI shows (pictures at ../images/<name>)
//   <outputRoot>/images/<name>               the page's pictures
//   <outputRoot>/agent/marshal-state/        the run's Marshal state: run.json, state/sessions/ (SDK session
//                                            store), data/ (PAGE_STUDIO_DIR: pages/, library/, polish/)
//   <outputRoot>/agent/edits/<stamp>-<who>.json   one record per edit a person pushed back from their Marshal
//
// A cloud host mirrors each run's marshal-state into a local cache folder shaped like a local run
// (<cache>/<run>/state/sessions, <cache>/<run>/data), so everything the folder host does (runs, sessions,
// transcripts, telemetry, pages, continue, open in Page Studio) works on it unchanged. Runs from the older pipeline
// (no marshal-state) are listed too, with their preview, so their pages can be brought into Page Studio to compare.
import { execFile } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { finishPage } from "../../src/page-finish";
import { folderHost, type Host } from "./hosts";

type Row = Record<string, any>;

export interface CloudHostConfig {
  id: string;
  name?: string;
  /** gs://bucket/prefix under which run output roots live (any depth). */
  uri: string;
  /** Output roots to list even when they are not under uri. */
  runs?: string[];
}

export interface CloudRun {
  hostId: string;
  outputRoot: string;
  /** Has agent/marshal-state (a run on the Marshal SDK); false for the older pipeline. */
  marshal: boolean;
  run?: Row;
  previewUri: string;
  previewUrl: string;
  cacheDir?: string;
  edits?: number;
  updated?: string;
}

const STATE = "agent/marshal-state";
const EDITS = "agent/edits";
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SYNC_EVERY_MS = 20_000;
const MAX_RUNS = 40;

const home = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const safe = (value: string) => value.replace(/^gs:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
const trim = (uri: string) => uri.replace(/\/+$/, "");
/** The console URL a signed-in person opens the object with (no public access needed). */
export const consoleUrl = (uri: string) => `https://storage.cloud.google.com/${uri.replace(/^gs:\/\//, "")}`;

export function gcloud(args: string[], options: { timeoutMs?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.MARSHAL_SDK_GCLOUD || "gcloud",
      args,
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`gcloud ${args.slice(0, 3).join(" ")}: ${String(stderr || error.message).trim().split("\n").slice(-2).join(" ")}`));
        else resolve(String(stdout));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export function configuredClouds(configuration: Row | undefined): { clouds: CloudHostConfig[]; problems: string[] } {
  const clouds: CloudHostConfig[] = [];
  const problems: string[] = [];
  const entries: Row[] = Array.isArray(configuration?.cloud) ? configuration!.cloud : [];
  const fromEnv = (process.env.MARSHAL_SDK_CLOUD_ROOTS ?? "").split(",").map((uri) => uri.trim()).filter(Boolean);
  fromEnv.forEach((uri, index) => entries.push({ id: index ? `cloud-${index + 1}` : "cloud", uri }));
  for (const [index, entry] of entries.entries()) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!HOST_ID.test(id) || id === "local") {
      problems.push(`cloud[${index}]: id must be lowercase letters, digits and dashes (and not "local").`);
      continue;
    }
    if (typeof entry.uri !== "string" || !/^gs:\/\/[a-z0-9._-]+/.test(entry.uri)) {
      problems.push(`${id}: uri must be gs://bucket/prefix.`);
      continue;
    }
    if (clouds.some((cloud) => cloud.id === id)) continue;
    const runs = Array.isArray(entry.runs) ? entry.runs.filter((uri: unknown): uri is string => typeof uri === "string" && uri.startsWith("gs://")).map(trim) : [];
    clouds.push({ id, uri: trim(entry.uri), ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}), ...(runs.length ? { runs } : {}) });
  }
  return { clouds, problems };
}

/** Output roots under a prefix: runs on the SDK (agent/marshal-state/run.json) and older-pipeline runs (preview only). */
async function listRoots(config: CloudHostConfig): Promise<{ root: string; marshal: boolean }[]> {
  const found = new Map<string, boolean>();
  const ls = async (pattern: string) => {
    try {
      return (await gcloud(["storage", "ls", pattern], { timeoutMs: 60_000 })).split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      if (/matched no objects|One or more URLs matched no objects|not found/i.test(String((error as Error).message))) return [];
      throw error;
    }
  };
  for (const line of await ls(`${config.uri}/**/${STATE}/run.json`)) found.set(line.slice(0, -`/${STATE}/run.json`.length), true);
  for (const line of await ls(`${config.uri}/**/preview/index.html`)) {
    const root = line.slice(0, -"/preview/index.html".length);
    if (!found.has(root)) found.set(root, false);
  }
  for (const root of config.runs ?? []) if (!found.has(root)) found.set(root, true);
  return [...found.entries()].map(([root, marshal]) => ({ root, marshal })).slice(-MAX_RUNS);
}

async function readJson(uri: string): Promise<Row | undefined> {
  try {
    return JSON.parse(await gcloud(["storage", "cat", uri], { timeoutMs: 30_000 })) as Row;
  } catch {
    return undefined;
  }
}

/** A cloud host: the folder host over a local mirror of each run's marshal-state, plus the cloud's own run list. */
export function cloudHost(config: CloudHostConfig, pullRoot: string): Host & {
  cloudRuns(refresh?: boolean): Promise<CloudRun[]>;
  rootOfRun(runId: string): Promise<string | undefined>;
  cacheRoot: string;
} {
  const cacheRoot = path.join(home(pullRoot), `.cloud-${config.id}`);
  const local = () => folderHost([cacheRoot]);
  let listed: CloudRun[] = [];
  let syncedAt = 0;
  let syncing: Promise<CloudRun[]> | undefined;

  const sync = async (force = false): Promise<CloudRun[]> => {
    if (!force && Date.now() - syncedAt < SYNC_EVERY_MS && listed.length) return listed;
    if (syncing) return syncing;
    syncing = (async () => {
      fs.mkdirSync(cacheRoot, { recursive: true });
      const roots = await listRoots(config);
      const runs: CloudRun[] = [];
      for (const { root, marshal } of roots) {
        const previewUri = `${root}/preview/index.html`;
        const entry: CloudRun = { hostId: config.id, outputRoot: root, marshal, previewUri, previewUrl: consoleUrl(previewUri) };
        if (marshal) {
          const cacheDir = path.join(cacheRoot, safe(root));
          fs.mkdirSync(cacheDir, { recursive: true });
          try {
            await gcloud(["storage", "rsync", "-r", `${root}/${STATE}`, cacheDir], { timeoutMs: 300_000 });
          } catch (error) {
            entry.run = { syncError: String((error as Error).message).slice(0, 300) };
          }
          fs.writeFileSync(path.join(cacheDir, ".cloud.json"), JSON.stringify({ hostId: config.id, outputRoot: root, syncedAt: new Date().toISOString() }));
          const runFile = path.join(cacheDir, "run.json");
          if (fs.existsSync(runFile)) {
            try {
              entry.run = { ...(entry.run ?? {}), ...(JSON.parse(fs.readFileSync(runFile, "utf8")) as Row) };
            } catch {
              /* a partial upload; the next sync reads it */
            }
          }
          entry.cacheDir = cacheDir;
        }
        runs.push(entry);
      }
      listed = runs;
      syncedAt = Date.now();
      return runs;
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  };

  /** The run's output root from the cache folder holding its session store. */
  const rootOfStore = (store: string): string | undefined => {
    const folder = path.dirname(path.dirname(store));
    try {
      return (JSON.parse(fs.readFileSync(path.join(folder, ".cloud.json"), "utf8")) as Row).outputRoot;
    } catch {
      return undefined;
    }
  };

  const annotate = (rows: Row[]): Row[] =>
    rows.map((row) => {
      const store = String(row.store ?? row.sources?.[0]?.store ?? "");
      const root = store ? rootOfStore(store) : undefined;
      return root ? { ...row, cloud: { outputRoot: root, previewUrl: consoleUrl(`${root}/preview/index.html`) } } : row;
    });

  const base = local();
  const host: Host = {
    ...base,
    summary: { id: config.id, name: config.name ?? `Cloud (${config.uri.replace(/^gs:\/\//, "")})`, kind: "folder", roots: [cacheRoot], url: config.uri },
    async info() {
      const runs = await sync().catch(() => listed);
      return { status: "cloud", mode: "cloud", uri: config.uri, cache: cacheRoot, runs: runs.length, marshalRuns: runs.filter((run) => run.marshal).length, files: ["workspace", "output", "data"] };
    },
    async runs() {
      await sync();
      return annotate(await local().runs());
    },
    async sessions(runId) {
      return local().sessions(runId);
    },
    async session(sessionId) {
      return local().session(sessionId);
    },
    async transcript(sessionId, options) {
      return local().transcript(sessionId, options);
    },
    async watch(sessionId, options) {
      // A live cloud run keeps uploading its state; pull it before each watch.
      await sync(true).catch(() => undefined);
      return local().watch(sessionId, { ...options, waitMs: Math.min(options.waitMs, 2_000) });
    },
    async pages(runId) {
      await sync();
      // One cache folder holds one run, so every page in it is that run's, also after an edit pushed later than the
      // run's time window (the folder host attributes pages by updatedAt).
      const root = runId ? await rootOfRunId(runId) : undefined;
      if (!runId || !root) return local().pages(runId);
      const listedPages = await folderHost([path.join(cacheRoot, safe(root))]).pages(undefined);
      // Pages untouched since before the run (the brand base it started from) aren't the run's.
      const startedAt = String(listed.find((entry) => entry.outputRoot === root)?.run?.startedAt ?? "");
      const pages = listedPages.pages.filter((page) => !startedAt || String(page.updatedAt) >= startedAt);
      return { ...listedPages, pages: pages.map((page) => ({ ...page, runId })) };
    },
    async pageFolder(pageId, runId) {
      await sync();
      const folder = await local().pageFolder(pageId, runId, cacheRoot);
      const root = runId ? await rootOfRunId(runId) : undefined;
      return { ...folder, origin: `cloud ${config.id}${root ? ` ${root.replace(/^gs:\/\//, "")}` : ""}` };
    },
    async send() {
      return { ok: false, reason: "store-only", message: "A cloud run has finished in its sandbox; continue the session in Marshal instead." };
    },
    async cancel() {
      return { ok: false, reason: "store-only", message: "A cloud run can't be cancelled from here." };
    },
    async answer() {
      return { ok: false, reason: "store-only", message: "A finished cloud run takes no answers; continue the session in Marshal instead." };
    },
  };

  const rootOfRunId = async (runId: string): Promise<string | undefined> => {
    const runs = await local().runs();
    const row = runs.find((entry) => entry.runId === runId);
    const store = row ? String(row.store ?? row.sources?.[0]?.store ?? "") : "";
    if (store) return rootOfStore(store);
    return listed.find((entry) => entry.run?.runId === runId || path.basename(entry.outputRoot) === runId)?.outputRoot;
  };

  return Object.assign(host, {
    cacheRoot,
    cloudRuns: (refresh?: boolean) => sync(Boolean(refresh)),
    rootOfRun: rootOfRunId,
  });
}

// ---- Links between a page in this Marshal's Page Studio and the cloud run it came from ----

export interface CloudLink {
  hostId: string;
  outputRoot: string;
  cloudPageId: string;
  runId?: string;
  linkedAt: string;
  /** When this Mac last pushed the page back; the cloud copy is ours up to then. */
  pushedAt?: string;
}

const linksFile = (pullRoot: string) => path.join(home(pullRoot), "cloud-links.json");

export function readLinks(pullRoot: string): Record<string, CloudLink> {
  try {
    return JSON.parse(fs.readFileSync(linksFile(pullRoot), "utf8")) as Record<string, CloudLink>;
  } catch {
    return {};
  }
}

export function writeLink(pullRoot: string, localPageId: string, link: CloudLink): void {
  const links = readLinks(pullRoot);
  links[localPageId] = link;
  fs.mkdirSync(path.dirname(linksFile(pullRoot)), { recursive: true });
  fs.writeFileSync(linksFile(pullRoot), JSON.stringify(links, null, 2));
}

// ---- Push an edited page back to its cloud run ----

export interface PushInput {
  outputRoot: string;
  cloudPageId: string;
  /** The page as Page Studio rendered it (pagestudio.render's file): library pictures as file:// or library URLs. */
  renderedHtml: string;
  /** The local Page Studio page record (pages/<id>.json), written to the run's state under cloudPageId. */
  pageDoc: Row;
  /** This Marshal's Page Studio data folder (its library/ holds the pictures). */
  studioDir: string;
  by: { name?: string; email?: string };
  summary?: string;
  workDir: string;
}

export interface PushResult {
  ok: true;
  previewUri: string;
  previewUrl: string;
  backup: string;
  edit: string;
  sections: string[];
  pictures: number;
  missing: string[];
  version: number;
}

/**
 * Writes the edited page where their page generator UI reads it (preview/index.html, pictures under images/), keeps
 * the previous preview under agent/edits/, updates the page record in the run's Marshal state, and records the edit.
 */
export async function pushToCloud(input: PushInput): Promise<PushResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const who = (input.by.email ?? input.by.name ?? os.userInfo().username).replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 60);
  const out = path.join(input.workDir, `push-${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  const finished = finishPage(input.renderedHtml, { libraryRoot: path.join(input.studioDir, "library"), outDir: out });
  // Their preview points pictures at ../images/<name> beside it; keep that shape so the UI renders it unchanged.
  const html = finished.html.replace(/(["'(\s])assets\//g, "$1../images/");
  fs.writeFileSync(path.join(out, "index.html"), html);
  const root = trim(input.outputRoot);
  const previewUri = `${root}/preview/index.html`;
  const backup = `${root}/${EDITS}/${stamp}-${who}/preview.before.html`;
  try {
    await gcloud(["storage", "cp", previewUri, backup], { timeoutMs: 60_000 });
  } catch {
    /* no earlier preview to keep */
  }
  if (finished.assets.length) {
    await gcloud(["storage", "cp", ...finished.assets.map((name) => path.join(out, "assets", name)), `${root}/images/`], { timeoutMs: 300_000 });
  }
  await gcloud(["storage", "cp", "--content-type=text/html; charset=utf-8", "--cache-control=no-cache", path.join(out, "index.html"), previewUri], { timeoutMs: 60_000 });

  const doc: Row = { ...input.pageDoc, id: input.cloudPageId };
  const docFile = path.join(out, `${input.cloudPageId}.json`);
  fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
  await gcloud(["storage", "cp", docFile, `${root}/${STATE}/data/pages/${input.cloudPageId}.json`], { timeoutMs: 60_000 });
  // The run's own Page Studio library gets the pictures the edited page shows, so the page record opens there too.
  const libraryRoot = path.join(input.studioDir, "library");
  const brands = new Set<string>();
  for (const match of input.renderedHtml.matchAll(/(?:\/library\/|https:\/\/pagestudio\.library\/)([A-Za-z0-9._-]+)\/(?:pictures\/)?/g)) brands.add(match[1]!);
  for (const brand of brands) {
    const pictures = finished.assets.map((name) => path.join(libraryRoot, brand, "pictures", name)).filter((file) => fs.existsSync(file));
    if (pictures.length) await gcloud(["storage", "cp", ...pictures, `${root}/${STATE}/data/library/${brand}/pictures/`], { timeoutMs: 300_000 }).catch(() => undefined);
  }

  const record = {
    at: new Date().toISOString(),
    by: input.by,
    pageId: input.cloudPageId,
    version: Number(doc.version ?? 0),
    summary: input.summary ?? "",
    sections: finished.sections,
    pictures: finished.assets.length,
    notes: Array.isArray(doc.notes) ? doc.notes.length : 0,
    preview: previewUri,
    previous: backup,
  };
  const edit = `${root}/${EDITS}/${stamp}-${who}.json`;
  const recordFile = path.join(out, "edit.json");
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  await gcloud(["storage", "cp", recordFile, edit], { timeoutMs: 60_000 });
  return {
    ok: true,
    previewUri,
    previewUrl: consoleUrl(previewUri),
    backup,
    edit,
    sections: finished.sections,
    pictures: finished.assets.length,
    missing: finished.missingAssets,
    version: record.version,
  };
}

// ---- Bring any cloud run's page (also the older pipeline's) into Page Studio as an HTML page ----

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml" };

/** The run's preview with its pictures inlined, so it opens anywhere without access to the bucket. */
export async function previewHtml(outputRoot: string, workDir: string): Promise<{ html: string; pictures: number; missing: string[] }> {
  const root = trim(outputRoot);
  const dir = path.join(workDir, `preview-${safe(root)}`);
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  await gcloud(["storage", "cp", `${root}/preview/index.html`, path.join(dir, "index.html")], { timeoutMs: 60_000 });
  let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const names = new Set<string>();
  for (const match of html.matchAll(/\.\.\/images\/([A-Za-z0-9._%-]+)/g)) names.add(decodeURIComponent(match[1]!));
  if (names.size) {
    await gcloud(["storage", "cp", ...[...names].map((name) => `${root}/images/${name}`), path.join(dir, "images") + "/"], { timeoutMs: 300_000 }).catch(() => undefined);
  }
  const missing: string[] = [];
  let pictures = 0;
  html = html.replace(/\.\.\/images\/([A-Za-z0-9._%-]+)/g, (whole, raw: string) => {
    const name = decodeURIComponent(raw);
    const file = path.join(dir, "images", name);
    if (!fs.existsSync(file)) {
      missing.push(name);
      return whole;
    }
    pictures += 1;
    return `data:${MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream"};base64,${fs.readFileSync(file).toString("base64")}`;
  });
  return { html, pictures, missing };
}

export async function readRunJson(outputRoot: string): Promise<Row | undefined> {
  return readJson(`${trim(outputRoot)}/${STATE}/run.json`);
}

export async function listEdits(outputRoot: string): Promise<Row[]> {
  try {
    const lines = (await gcloud(["storage", "ls", `${trim(outputRoot)}/${EDITS}/*.json`], { timeoutMs: 30_000 })).split("\n").map((line) => line.trim()).filter(Boolean);
    const rows: Row[] = [];
    for (const line of lines.slice(-20)) {
      const row = await readJson(line);
      if (row) rows.push({ ...row, uri: line });
    }
    return rows;
  } catch {
    return [];
  }
}
