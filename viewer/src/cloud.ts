// Cloud runs: page generations agent-sandbox ran on the Marshal SDK, kept in GCS under each run's output root.
//
//   <outputRoot>/preview/index.html          the page their page generator UI shows (pictures at ../images/<name>)
//   <outputRoot>/preview/inline/index.html   the same page with its pictures inlined, which their UI also serves
//   <outputRoot>/images/<name>               the page's pictures
//   <outputRoot>/agent/marshal-state/        the run's Marshal state: run.json, state/sessions/ (SDK session
//                                            store), data/ (PAGE_STUDIO_DIR: pages/, library/, polish/)
//   <outputRoot>/agent/edits/<stamp>-<who>.json   one record per edit a person pushed back from their Marshal
//
// A cloud host mirrors each run's marshal-state into a local cache folder shaped like a local run
// (<cache>/<run>/state/sessions, <cache>/<run>/data), so everything the folder host does (runs, sessions,
// transcripts, telemetry, pages, continue, open in Page Studio) works on it unchanged. Runs from the older pipeline
// (no marshal-state) are listed too, with their preview, so their pages can be brought into Page Studio to compare.
import { spawn } from "node:child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import { finishPage } from "../../src/page-finish";
import { commitPageVersion, extendRunJson, type ArtifactRef, type NewPicture } from "./artifacts";
import { gcloud, gcsCat, gcsGlob, gcsRead, gcsWrite, PreconditionFailed, pool } from "./gcs";
import { folderHost, type Host } from "./hosts";
import { notesOf, reviewRunId, syncReviewComments, type ReviewApiConfig, type ReviewSync } from "./review";

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
/**
 * Where a root keeps its Marshal state. A run keeps it at <outputRoot>/agent/marshal-state; an agent-sandbox edit
 * conversation (page-edit-conversations/<id>) keeps its own at <root>/marshal-state. Roots learnt from a state location
 * the org's session index named are remembered here.
 */
const stateDirs = new Map<string, string>();
export const stateOf = (root: string) => stateDirs.get(trim(root)) ?? `${trim(root)}/${STATE}`;
/** The root a state location belongs to, and whether it is an edit conversation's own state. */
export function rootOfState(stateLocation: string): { root: string; conversation: boolean } | null {
  const state = trim(stateLocation);
  if (!/^gs:\/\/[^/]+\/.+/.test(state)) return null;
  if (state.endsWith(`/${STATE}`)) return { root: state.slice(0, -`/${STATE}`.length), conversation: false };
  if (state.endsWith("/marshal-state")) return { root: state.slice(0, -"/marshal-state".length), conversation: true };
  return null;
}
const EDITS = "agent/edits";
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SYNC_EVERY_MS = 20_000;
// Published pages are runs too, so the list grows with what people share.
const MAX_RUNS = 150;

const home = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const safe = (value: string) => value.replace(/^gs:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
const trim = (uri: string) => uri.replace(/\/+$/, "");
export { gcloud, gcsCat, gcsGlob };
/** The console URL a signed-in person opens the object with (no public access needed). */
export const consoleUrl = (uri: string) => `https://storage.cloud.google.com/${uri.replace(/^gs:\/\//, "")}`;



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
async function listRoots(config: CloudHostConfig, discoveredLocations: Promise<readonly string[]> = Promise.resolve([])): Promise<{ root: string; marshal: boolean }[]> {
  const found = new Map<string, boolean>();
  const ls = gcsGlob;
  // run.json (page-run folders) or page-run.json (agent-sandbox's runner) marks a run with Marshal state.
  const [states, previews, pointers] = await Promise.all([
    ls(`${config.uri}/**/${STATE}/*.json`),
    ls(`${config.uri}/**/preview/index.html`),
    // Runs whose output root is elsewhere in the bucket (their page-generation-runs/<id>/output) announce themselves with a
    // pointer under the prefix: <uri>/index/<run>.json {outputRoot}. Listing a whole bucket for marshal-state is too slow.
    ls(`${config.uri}/index/*.json`),
  ]);
  for (const line of states) {
    const name = line.slice(line.lastIndexOf("/") + 1);
    if (name === "run.json" || name === "page-run.json") found.set(line.slice(0, -`/${STATE}/${name}`.length), true);
  }
  for (const line of previews) {
    const root = line.slice(0, -"/preview/index.html".length);
    if (!found.has(root)) found.set(root, false);
  }
  const roots = await pool(pointers, 12, async (uri) => (await readJson(uri))?.outputRoot);
  for (const root of roots) if (typeof root === "string" && /^gs:\/\/[^/]+\/.+/.test(root) && !found.has(trim(root))) found.set(trim(root), true);
  for (const root of config.runs ?? []) if (!found.has(root)) found.set(root, true);
  // Runs whose sessions were shared to the org's session index (it names each run's state location); GCS still backs them.
  const bucket = config.uri.slice(0, config.uri.indexOf("/", "gs://".length) + 1);
  for (const location of await discoveredLocations) {
    const known = rootOfState(location);
    if (!known || !known.root.startsWith(bucket) || found.has(known.root)) continue;
    if (known.conversation) stateDirs.set(known.root, trim(location));
    found.set(known.root, true);
  }
  return [...found.entries()].map(([root, marshal]) => ({ root, marshal })).slice(-MAX_RUNS);
}

async function readJson(uri: string): Promise<Row | undefined> {
  try {
    return JSON.parse(await gcsCat(uri)) as Row;
  } catch {
    return undefined;
  }
}

/** A cloud host: the folder host over a local mirror of each run's marshal-state, plus the cloud's own run list. */
export function cloudHost(config: CloudHostConfig, pullRoot: string, discover: () => Promise<string[]> = async () => []): Host & {
  cloudRuns(refresh?: boolean): Promise<CloudRun[]>;
  pulledRuns(): Promise<Row[]>;
  rootOfRun(runId: string): Promise<string | undefined>;
  cacheRoot: string;
} {
  const cacheRoot = path.join(home(pullRoot), `.cloud-${config.id}`);
  const local = () => folderHost([cacheRoot]);
  let listed: CloudRun[] = [];
  let syncedAt = 0;
  let listing: Promise<CloudRun[]> | undefined;
  const pulled = new Map<string, number>();
  const pulling = new Map<string, Promise<void>>();
  const olderRuns = new Map<string, Row>();

  // Listing reads a few small objects per run straight from the bucket. A run's whole Marshal state (sessions, pictures,
  // Claude files: 100-300 MB) is mirrored into the cache only when something asks for that run: its sessions, pages,
  // transcript or files.
  const pageRecordOf = async (state: string, pageId: string): Promise<Row | undefined> =>
    (await readJson(`${state}/page-studio/pages/${pageId}.json`)) ?? (await readJson(`${state}/data/pages/${pageId}.json`));

  const describe = async (root: string, marshal: boolean): Promise<CloudRun> => {
    const previewUri = `${root}/preview/index.html`;
    const entry: CloudRun = { hostId: config.id, outputRoot: root, marshal, previewUri, previewUrl: consoleUrl(previewUri) };
    if (!marshal) {
      // Their pipeline's plan (agent/plan.json) names the product and the page idea; a finished run doesn't change.
      if (!olderRuns.has(root)) {
        const plan = await readJson(`${root}/agent/plan.json`);
        olderRuns.set(root, plan ? { title: typeof plan.product === "string" ? plan.product : undefined, idea: typeof plan.page_idea === "string" ? plan.page_idea.slice(0, 300) : undefined } : {});
      }
      entry.run = { ...olderRuns.get(root) };
      return entry;
    }
    const state = stateOf(root);
    const [pageRun, runJson] = await Promise.all([readJson(`${state}/page-run.json`), readJson(`${state}/run.json`)]);
    if (pageRun) entry.run = { runId: pageRun.runId, pageId: pageRun.pageId, depth: pageRun.depth, edits: Array.isArray(pageRun.edits) ? pageRun.edits.length : 0 };
    if (runJson) entry.run = { ...(entry.run ?? {}), ...runJson };
    // agent-sandbox's runner writes no run.json (only a desktop push or backfill adds one), so its status and sessions
    // come from its own files: output.json is its finish line, host/sessions/index.json its session store's index.
    if (pageRun) {
      const [output, index] = await Promise.all([
        entry.run?.status ? undefined : readJson(`${root}/output.json`),
        readJson(`${state}/host/sessions/index.json`) as Promise<unknown>,
      ]);
      const sessions = Array.isArray(index) ? (index as Row[]) : [];
      const starts = sessions.map((session) => session.createdAt).filter((at): at is string => typeof at === "string").sort();
      entry.run = {
        ...(entry.run ?? {}),
        ...(entry.run?.status ? {} : { status: output ? "done" : "running" }),
        ...(!entry.run?.startedAt && starts[0] ? { startedAt: starts[0] } : {}),
        sessionCount: sessions.length,
      };
    }
    // agent-sandbox's run.json carries no title or brand: they live in the run's page (pageId) in page-studio/.
    const pageId = entry.run?.pageId;
    if (!entry.run?.title && typeof pageId === "string" && /^[A-Za-z0-9._-]+$/.test(pageId)) {
      const page = await pageRecordOf(state, pageId);
      if (page) entry.run = { ...(entry.run ?? {}), ...(typeof page.title === "string" ? { title: page.title } : {}), ...(page.brand?.name ? { brand: page.brand.name } : {}) };
    }
    if (pulled.has(root)) entry.cacheDir = path.join(cacheRoot, safe(root));
    return entry;
  };

  const list = async (force = false): Promise<CloudRun[]> => {
    if (!force && Date.now() - syncedAt < SYNC_EVERY_MS && listed.length) return listed;
    if (listing) return listing;
    listing = (async () => {
      fs.mkdirSync(cacheRoot, { recursive: true });
      // Locations the org index named are remembered on this Mac: the kit host that serves the index can be down or restarted.
      const known = path.join(home(pullRoot), `cloud-discovered-${config.id}.json`);
      const remembered = (): string[] => {
        try {
          const rows = JSON.parse(fs.readFileSync(known, "utf8")) as unknown;
          return Array.isArray(rows) ? rows.filter((row): row is string => typeof row === "string") : [];
        } catch {
          return [];
        }
      };
      const discovered = discover()
        .catch(() => [] as string[])
        .then((found) => {
          const all = [...new Set([...remembered(), ...found.map(trim)])];
          if (all.length > remembered().length) {
            fs.mkdirSync(path.dirname(known), { recursive: true });
            fs.writeFileSync(known, JSON.stringify(all, null, 2));
          }
          return all;
        });
      const roots = await listRoots(config, discovered);
      const runs = await pool(roots, 12, ({ root, marshal }) => describe(root, marshal));
      listed = runs;
      syncedAt = Date.now();
      return runs;
    })().finally(() => {
      listing = undefined;
    });
    return listing;
  };

  /** Mirrors one run's Marshal state into the cache (once per SYNC_EVERY_MS unless forced). */
  const pull = async (root: string, force = false): Promise<void> => {
    const at = pulled.get(root);
    if (!force && at !== undefined && Date.now() - at < SYNC_EVERY_MS) return;
    const running = pulling.get(root);
    if (running) return running;
    const job = (async () => {
      const cacheDir = path.join(cacheRoot, safe(root));
      fs.mkdirSync(cacheDir, { recursive: true });
      await gcloud(["storage", "rsync", "-r", stateOf(root), cacheDir], { timeoutMs: 300_000 });
      fs.writeFileSync(path.join(cacheDir, ".cloud.json"), JSON.stringify({ hostId: config.id, outputRoot: root, syncedAt: new Date().toISOString() }));
      pulled.set(root, Date.now());
      const entry = listed.find((candidate) => candidate.outputRoot === root);
      if (entry) entry.cacheDir = cacheDir;
    })().finally(() => {
      pulling.delete(root);
    });
    pulling.set(root, job);
    return job;
  };

  const pullAll = async (force = false): Promise<void> => {
    const runs = (await list()).filter((run) => run.marshal);
    await pool(runs, 4, (run) => pull(run.outputRoot, force).catch(() => undefined));
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
  /** Mirrors the run (or, with no run named, every run) a request is about before the folder host answers it. */
  const pullFor = async (runId?: string, force = false): Promise<void> => {
    await list();
    const root = runId ? await rootOfRunId(runId) : undefined;
    if (root && listed.some((entry) => entry.outputRoot === root && entry.marshal)) await pull(root, force);
    else await pullAll(force);
  };
  /** A session id alone does not name its run: look in what is pulled, then pull the rest. */
  const pullForSession = async (sessionId: string): Promise<void> => {
    if (!(await local().session(sessionId))) await pullAll();
  };
  const host: Host = {
    ...base,
    summary: { id: config.id, name: config.name ?? `Cloud (${config.uri.replace(/^gs:\/\//, "")})`, kind: "folder", roots: [cacheRoot], url: config.uri },
    async info() {
      const runs = await list().catch(() => listed);
      return { status: "cloud", mode: "cloud", uri: config.uri, cache: cacheRoot, runs: runs.length, marshalRuns: runs.filter((run) => run.marshal).length, pulled: pulled.size, files: ["workspace", "output", "data"] };
    },
    async runs() {
      await pullAll();
      return annotate(await local().runs());
    },
    async sessions(runId) {
      await pullFor(runId);
      return local().sessions(runId);
    },
    async session(sessionId) {
      await pullForSession(sessionId);
      return local().session(sessionId);
    },
    async transcript(sessionId, options) {
      await pullForSession(sessionId);
      return local().transcript(sessionId, options);
    },
    async watch(sessionId, options) {
      // A live cloud run keeps uploading its state; pull it again before each watch.
      await pullForSession(sessionId);
      const row = await local().session(sessionId);
      const root = row ? rootOfStore(String((row as Row).store ?? "")) : undefined;
      if (root) await pull(root, true).catch(() => undefined);
      return local().watch(sessionId, { ...options, waitMs: Math.min(options.waitMs, 2_000) });
    },
    async telemetry(target) {
      if (target.sessionId) await pullForSession(target.sessionId);
      else await pullFor(target.runId);
      return base.telemetry(target);
    },
    async files(runId, root, relative) {
      await pullFor(runId);
      return base.files(runId, root, relative);
    },
    async readFile(runId, root, relative, maxBytes) {
      await pullFor(runId);
      return base.readFile(runId, root, relative, maxBytes);
    },
    async events(sessionId, since, limit) {
      await pullForSession(sessionId);
      return base.events(sessionId, since, limit);
    },
    async search(query, limit) {
      await pullAll();
      return base.search(query, limit);
    },
    async decisions(filter) {
      await pullAll();
      return base.decisions(filter);
    },
    async native(sessionId) {
      await pullForSession(sessionId);
      return base.native(sessionId);
    },
    async pages(runId) {
      await list();
      await pullFor(runId);
      // One cache folder holds one run, so every page in it is that run's, also after an edit pushed later than the
      // run's time window (the folder host attributes pages by updatedAt).
      const root = runId ? await rootOfRunId(runId) : undefined;
      if (!runId || !root) return local().pages(runId);
      const listedPages = await folderHost([path.join(cacheRoot, safe(root))]).pages(undefined);
      // Pages untouched since before the run (the brand base it started from) aren't the run's.
      const run = listed.find((entry) => entry.outputRoot === root)?.run;
      const startedAt = String(run?.startedAt ?? "");
      // Without a start time (agent-sandbox's page-run.json), the run's own page is the one it names.
      const pages = listedPages.pages.filter((page) => (startedAt ? String(page.updatedAt) >= startedAt : !run?.pageId || page.id === run.pageId));
      return { ...listedPages, pages: pages.map((page) => ({ ...page, runId })) };
    },
    async pageFolder(pageId, runId) {
      await pullFor(runId);
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
    await list();
    const named = listed.find((entry) => entry.run?.runId === runId || path.basename(entry.outputRoot) === runId)?.outputRoot;
    if (named) return named;
    const runs = await local().runs();
    const row = runs.find((entry) => entry.runId === runId);
    const store = row ? String(row.store ?? row.sources?.[0]?.store ?? "") : "";
    return store ? rootOfStore(store) : undefined;
  };

  return Object.assign(host, {
    cacheRoot,
    cloudRuns: (refresh?: boolean) => list(Boolean(refresh)),
    /** Runs already mirrored into the cache (no pulling): their sessions and cost. */
    pulledRuns: async () => annotate(await local().runs()),
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
  /** The artifact version of the run's page this local copy was made from (or last pushed as); 0 before the run kept versions. */
  baseVersion?: number;
  /** The artifact id when it differs from cloudPageId (it never does for pages opened from the lazy list). */
  artifactId?: string;
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
  /**
   * The artifact version of the run's page this copy was made from (see CloudLink.baseVersion). The push is refused when
   * the run's page has moved on since; 0 (or absent) means the copy was made before the run kept versions.
   */
  baseVersion?: number;
  workDir: string;
  /** Screenshots htmlFile into pngFile at their thumbnail's phone viewport; defaults to a headless Chrome. */
  capture?: (htmlFile: string, pngFile: string) => Promise<void>;
  /** Their page generator's review API: the page's notes become comments in its /lp-review panel. */
  review?: ReviewApiConfig | null;
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
  /** The new preview/thumbnail.png their run list shows, or null when no Chrome could take it. */
  thumbnail: string | null;
  /** What the notes did in their review panel, or null when no review API is configured or the run has no id there. */
  review: ReviewSync | null;
  /** The artifact version this push wrote (artifacts/page/<id>/versions/<n>) and what it moved. */
  artifact: { id: string; version: number; dir: string; seeded: boolean; uploaded: number; reused: number };
  warnings: string[];
}

/**
 * Writes the edited page where their page generator UI reads it (preview/index.html, pictures under images/, and the
 * inlined copy at preview/inline/index.html), keeps
 * the previous preview under agent/edits/, updates the page record in the run's Marshal state, and records the edit.
 */
export interface PushRefused {
  ok: false;
  reason: "still-running" | "edit-conversation" | "cloud-moved";
  message: string;
  /** For cloud-moved: the version the run's page is at now and the one this copy was made from. */
  current?: number;
  baseVersion?: number;
}

const STATE_META = "marshal-page-state";

/** The page with a marshal-page-state meta tag naming its Marshal state (replacing an older one). */
export function stampStateLocation(html: string, location: string): string {
  const meta = `<meta name="${STATE_META}" content="${location.replace(/[<>"&]/g, "")}">`;
  const bare = html.replace(new RegExp(`<meta\\s+name="${STATE_META}"\\s+content="[^"]*"\\s*/?>\\s*`, "g"), "");
  const head = /<head[^>]*>/i.exec(bare);
  return head ? `${bare.slice(0, head.index + head[0].length)}${meta}${bare.slice(head.index + head[0].length)}` : `${meta}${bare}`;
}

export async function pushToCloud(input: PushInput): Promise<PushResult | PushRefused> {
  const root = trim(input.outputRoot);
  if (stateOf(root) !== `${root}/${STATE}`) {
    return { ok: false, reason: "edit-conversation", message: "This is an edit conversation's own state, not a run: push the page to the run it edits." };
  }
  // agent-sandbox's runner keeps PAGE_STUDIO_DIR as page-studio/ and the finished page as sandbox-page.html (the
  // baseline its next edit turn diffs against); page-run folders keep it as data/.
  // Decided by where the run keeps its pages, not by page-run.json: the page generator's runs carry a run.json too and
  // write page-run.json only at the end.
  const sandboxLayout =
    Boolean(await readJson(`${root}/${STATE}/page-run.json`)) ||
    (await gcloud(["storage", "ls", `${root}/${STATE}/page-studio/pages/*.json`], { timeoutMs: 30_000 }).then((out) => out.trim().length > 0).catch(() => false));
  // A run still building uploads its whole state and publishes its preview at the end, over anything pushed meanwhile.
  // agent-sandbox writes <outputRoot>/output.json last and never writes under the root after it (lane C2), so that file
  // is the finish line there; other runs say so in run.json.
  const runJson = await readJson(`${root}/${STATE}/run.json`);
  const runDone = sandboxLayout ? Boolean(await readJson(`${root}/output.json`)) : runJson?.status !== "running";
  if (!runDone) {
    return { ok: false, reason: "still-running", message: "This run is still building; its final upload would replace your edit. Push once it has finished." };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const who = (input.by.email ?? input.by.name ?? os.userInfo().username).replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 60);
  const out = path.join(input.workDir, `push-${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  const finished = finishPage(input.renderedHtml, { libraryRoot: path.join(input.studioDir, "library"), outDir: out });
  // Their preview points pictures at ../images/<name> beside it; keep that shape so the UI renders it unchanged.
  // The page names the state this push updates, so the run's next edit (marshal_sdk's Page Studio route) continues
  // from this version instead of the page as the build left it.
  const html = stampStateLocation(finished.html.replace(/(["'(\s])assets\//g, "$1../images/"), stateOf(root));
  fs.writeFileSync(path.join(out, "index.html"), html);
  // The new version is committed first, with a conditional write on the artifact's manifest: a copy made from an older
  // version is refused here, before anything of the run's preview is touched.
  const libraryDir = path.join(input.studioDir, "library");
  const named = new Map<string, string>();
  for (const match of input.renderedHtml.matchAll(/(?:\/library\/|https:\/\/pagestudio\.library\/)([A-Za-z0-9._-]+)\/(?:pictures\/)?/g)) named.set(match[1]!, match[1]!);
  const pictures: NewPicture[] = [];
  for (const name of finished.assets) {
    const brand = [...named.keys()].find((candidate) => fs.existsSync(path.join(libraryDir, candidate, "pictures", name)));
    if (brand) pictures.push({ brand, name, file: path.join(libraryDir, brand, "pictures", name) });
  }
  const committed = await commitPageVersion({
    root,
    state: stateOf(root),
    app: "page",
    kind: "landing-page",
    id: input.cloudPageId,
    title: String(input.pageDoc.title ?? runJson?.title ?? input.cloudPageId),
    baseVersion: input.baseVersion ?? 0,
    doc: { ...input.pageDoc, id: input.cloudPageId },
    previewHtml: html,
    pictures,
    by: input.by,
    ...(input.summary ? { summary: input.summary } : {}),
  });
  if (!committed.ok) return { ok: false, reason: "cloud-moved", message: committed.message, current: committed.current, baseVersion: committed.baseVersion };
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
  // Their UI also serves a copy with the pictures inlined as base64 (preview/inline/index.html); without a new one it
  // keeps showing the page from before the edit.
  const inlineUri = `${root}/preview/inline/index.html`;
  await gcloud(["storage", "cp", inlineUri, `${root}/${EDITS}/${stamp}-${who}/preview.inline.before.html`], { timeoutMs: 60_000 }).catch(() => undefined);
  const inline = await previewHtml(root, out);
  const inlineFile = path.join(out, "inline.html");
  fs.writeFileSync(inlineFile, inline.html);
  await gcloud(["storage", "cp", "--content-type=text/html; charset=utf-8", "--cache-control=no-cache", inlineFile, inlineUri], { timeoutMs: 120_000 });
  // Their run list shows preview/thumbnail.png, which store-manager takes once after the build (agent-sandbox's
  // CaptureScreenshot of the preview at 393x852); without a new one the list card keeps the page from before the edit.
  const warnings: string[] = [];
  const thumbnailUri = `${root}/preview/thumbnail.png`;
  let thumbnail: string | null = null;
  try {
    const png = path.join(out, "thumbnail.png");
    await (input.capture ?? captureThumbnail)(inlineFile, png);
    await gcloud(["storage", "cp", thumbnailUri, `${root}/${EDITS}/${stamp}-${who}/thumbnail.before.png`], { timeoutMs: 60_000 }).catch(() => undefined);
    await gcloud(["storage", "cp", "--content-type=image/png", "--cache-control=no-cache", png, thumbnailUri], { timeoutMs: 60_000 });
    thumbnail = thumbnailUri;
  } catch (error) {
    warnings.push(`The run list's thumbnail was not updated: ${error instanceof Error ? error.message : String(error)}`);
  }

  const studio = `${root}/${STATE}/${sandboxLayout ? "page-studio" : "data"}`;
  const doc: Row = { ...input.pageDoc, id: input.cloudPageId };
  const docFile = path.join(out, `${input.cloudPageId}.json`);
  fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));
  await gcloud(["storage", "cp", docFile, `${studio}/pages/${input.cloudPageId}.json`], { timeoutMs: 60_000 });
  if (sandboxLayout) {
    const baseline = path.join(out, "sandbox-page.html");
    fs.writeFileSync(baseline, finished.html);
    await gcloud(["storage", "cp", baseline, `${root}/${STATE}/sandbox-page.html`], { timeoutMs: 60_000 });
  }
  // The run's own Page Studio library gets the pictures the edited page shows, so the page record opens there too.
  const libraryRoot = path.join(input.studioDir, "library");
  const brands = new Set<string>();
  for (const match of input.renderedHtml.matchAll(/(?:\/library\/|https:\/\/pagestudio\.library\/)([A-Za-z0-9._-]+)\/(?:pictures\/)?/g)) brands.add(match[1]!);
  for (const brand of brands) {
    const pictures = finished.assets.map((name) => path.join(libraryRoot, brand, "pictures", name)).filter((file) => fs.existsSync(file));
    if (pictures.length) await gcloud(["storage", "cp", ...pictures, `${studio}/library/${brand}/pictures/`], { timeoutMs: 300_000 }).catch(() => undefined);
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
    artifactVersion: committed.version,
  };
  const edit = `${root}/${EDITS}/${stamp}-${who}.json`;
  const recordFile = path.join(out, "edit.json");
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
  await gcloud(["storage", "cp", recordFile, edit], { timeoutMs: 60_000 });
  const runWarning = await recordArtifactInRun(root, runJson, { app: "page", kind: "landing-page", id: input.cloudPageId, title: String(doc.title ?? input.cloudPageId), current: committed.version });
  if (runWarning) warnings.push(runWarning);

  let review: ReviewSync | null = null;
  const notes = notesOf(doc);
  const reviewRun = reviewRunId(root, runJson);
  if (input.review && reviewRun !== null) {
    const mapUri = `${root}/${EDITS}/review-comments.json`;
    const sent = ((await readJson(mapUri))?.comments ?? {}) as Record<string, number>;
    try {
      review = await syncReviewComments(input.review, reviewRun, notes, sent);
    } catch (error) {
      warnings.push(`The notes did not reach their review panel: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (review) {
      const mapFile = path.join(out, "review-comments.json");
      fs.writeFileSync(mapFile, JSON.stringify({ runId: reviewRun, api: input.review.url, updatedAt: new Date().toISOString(), comments: review.comments }, null, 2));
      await gcloud(["storage", "cp", mapFile, mapUri], { timeoutMs: 60_000 });
    }
  } else if (notes.some((note) => (note.status ?? "open") === "open")) {
    warnings.push(input.review ? "This run has no page generator run id, so its notes stay in the page record only." : "No review API is configured (configuration.review), so the notes stay in the page record only.");
  }
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
    thumbnail,
    review,
    artifact: { id: input.cloudPageId, version: committed.version, dir: committed.dir, seeded: committed.seeded, uploaded: committed.uploaded, reused: committed.reused },
    warnings,
  };
}

// ---- Publish a page made in this Marshal as a new cloud run ----

export interface PublishInput extends Omit<PushInput, "outputRoot" | "cloudPageId" | "baseVersion"> {
  /** The cloud host's prefix (gs://bucket/prefix); the run goes under <uri>/published/<runId>. */
  uri: string;
  /** The page's id here; the cloud page keeps it. */
  pageId: string;
  title?: string;
  brand?: string;
  /** Who published it: the run's requester. */
  requester: string | null;
  now?: () => Date;
}

export type PublishResult = (PushResult & { outputRoot: string; runId: string; cloudPageId: string }) | (PushRefused & { outputRoot: string; runId: string });

/**
 * A page made in this Marshal (not opened from a cloud run) becomes a run of its own under the cloud prefix: a manifest
 * (run.json, status done, the person as requester), then the same push an edit takes, which writes the page as artifact
 * version 1, its preview, pictures and record. Every Marshal listing that prefix shows it; pushes after this are version n+1.
 */
export async function publishToCloud(input: PublishInput): Promise<PublishResult> {
  const now = (input.now ?? (() => new Date()))();
  const slug = input.pageId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
  const runId = `${slug}-${now.getTime().toString(36)}`;
  const root = `${trim(input.uri)}/published/${runId}`;
  const cloudPageId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(input.pageId) ? input.pageId : slug;
  const title = input.title || String(input.pageDoc.title ?? input.pageId);
  const brand = input.brand || (typeof input.pageDoc.brand?.name === "string" ? input.pageDoc.brand.name : undefined);
  const manifest = {
    ...extendRunJson(
      { title, ...(brand ? { brand } : {}), pageId: cloudPageId, startedAt: now.toISOString(), finishedAt: now.toISOString(), source: "published" },
      { runId, title, workspace: "pages", workflow: "page-publish", visibility: "team", requester: input.requester, status: "done", labels: brand ? { brand } : {}, stateLocation: stateOf(root) },
    ),
  };
  await gcsWrite(`${stateOf(root)}/run.json`, JSON.stringify(manifest, null, 2), { contentType: "application/json", cacheControl: "no-cache", ifGenerationMatch: "0" });
  const { uri: _uri, pageId: _pageId, title: _title, brand: _brand, requester: _requester, now: _now, ...push } = input;
  const pushed = await pushToCloud({ ...push, outputRoot: root, cloudPageId, baseVersion: 0, summary: input.summary ?? "Published from Marshal" });
  return pushed.ok ? { ...pushed, outputRoot: root, runId, cloudPageId } : { ...pushed, outputRoot: root, runId };
}

/** Records the page's current version in the run manifest (run.json), upgrading a run that had none; a lost race is only a warning. */
async function recordArtifactInRun(root: string, runJson: Row | undefined, artifact: ArtifactRef): Promise<string | null> {
  const uri = `${stateOf(root)}/run.json`;
  try {
    const read = await gcsRead(uri);
    const existing = read ? (JSON.parse(read.data.toString("utf8")) as Row) : (runJson ?? {});
    const others = (Array.isArray(existing.artifacts) ? (existing.artifacts as ArtifactRef[]) : []).filter((entry) => !(entry.app === artifact.app && entry.id === artifact.id));
    const next = extendRunJson(existing, { runId: String(existing.runId ?? root.split("/").pop()), title: String(existing.title ?? artifact.title), artifacts: [...others, artifact] });
    await gcsWrite(uri, JSON.stringify(next, null, 2), { contentType: "application/json", cacheControl: "no-cache", ifGenerationMatch: read ? read.generation : "0" });
    return null;
  } catch (error) {
    return error instanceof PreconditionFailed ? "run.json changed while the push ran; its artifact list will catch up on the next push." : `run.json was not updated: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Chrome or Chromium: $MARSHAL_SDK_CHROME, $PAGE_STUDIO_CHROME, else the usual install places (as page-run looks). */
function findChrome(): string | null {
  const candidates = [process.env.MARSHAL_SDK_CHROME, process.env.PAGE_STUDIO_CHROME];
  if (process.platform === "darwin") candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  if (process.platform === "linux") candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
  if (process.platform === "win32") {
    for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  }
  return candidates.find((file): file is string => Boolean(file) && fs.existsSync(file!)) ?? null;
}

/**
 * Their thumbnail's shape (agent-sandbox services/screenshot: a 393x852 viewport at 1x, load, then 1.5 s). Driven over
 * DevTools because headless Chrome on a Mac won't make a window narrower than about 500 px, so --window-size=393 lays
 * the page out wider and crops it.
 */
export async function captureThumbnail(htmlFile: string, pngFile: string): Promise<void> {
  const chrome = findChrome();
  if (!chrome) throw new Error("no Chrome or Chromium found (set MARSHAL_SDK_CHROME)");
  if (typeof WebSocket !== "function") throw new Error("this Node has no WebSocket to drive Chrome");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-thumb-"));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []), "about:blank"], { stdio: "ignore", windowsHide: true });
  let socket: WebSocket | undefined;
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let tries = 0; !fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n"); tries++) {
      if (tries > 150 || child.exitCode !== null) throw new Error("Chrome did not open DevTools");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const port = fs.readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    const targets = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    const page = (JSON.parse(targets) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((target) => target.type === "page");
    if (!page) throw new Error("Chrome has no page to drive");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("could not reach Chrome's DevTools"));
    });
    let next = 0;
    const pending = new Map<number, { resolve: (value: Row) => void; reject: (error: Error) => void }>();
    const events = new Map<string, () => void>();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: Row; error?: { message: string } };
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method) events.get(message.method)?.();
    };
    const send = (method: string, params: Row = {}) =>
      new Promise<Row>((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    const loaded = new Promise<void>((resolve) => events.set("Page.loadEventFired", resolve));
    await send("Page.navigate", { url: pathToFileURL(path.resolve(htmlFile)).href });
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (typeof shot.data !== "string" || !shot.data) throw new Error("Chrome returned no screenshot");
    fs.writeFileSync(pngFile, Buffer.from(shot.data, "base64"));
  } finally {
    clearTimeout(timer);
    socket?.close();
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null ? resolve(undefined) : child.once("exit", resolve)));
    fs.rmSync(profile, { recursive: true, force: true });
  }
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
  return readJson(`${stateOf(outputRoot)}/run.json`);
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
