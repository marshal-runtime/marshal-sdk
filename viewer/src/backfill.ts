// Backfill: gives a run made before manifests its manifest v1 and version 1 of its pages, from what its output already holds.
// Only objects of this module's own are written (artifacts/, the extra run.json fields); their files are never touched.
import { extendRunJson, seedArtifact, type ArtifactRef, type RunManifest, type SessionEntry, type Visibility } from "./artifacts";
import { gcsList, gcsRead, gcsWrite, generationOf } from "./gcs";

type Row = Record<string, any>;
const trim = (uri: string) => uri.replace(/\/+$/, "");

export interface BackfillInput {
  root: string;
  /** The run's Marshal state folder; <root>/agent/marshal-state for a run, <root>/marshal-state for an edit conversation. */
  state?: string;
  workspace?: string;
  workflow?: string;
  visibility?: Visibility;
  /** Page ids to give versions; the run's own pageId and boardId by default. */
  pages?: { id: string; kind: string }[];
  dryRun?: boolean;
}

export interface BackfillResult {
  root: string;
  runId: string;
  manifest: RunManifest;
  artifacts: { id: string; kind: string; created: boolean; versions: number }[];
  sessions: number;
  wrote: boolean;
}

const read = async (uri: string): Promise<Row | undefined> => {
  const got = await gcsRead(uri);
  return got ? (JSON.parse(got.data.toString("utf8")) as Row) : undefined;
};

export async function backfillRun(input: BackfillInput): Promise<BackfillResult> {
  const root = trim(input.root);
  const state = trim(input.state ?? `${root}/agent/marshal-state`);
  const runUri = `${state}/run.json`;
  const runRead = await gcsRead(runUri);
  const runJson = runRead ? (JSON.parse(runRead.data.toString("utf8")) as Row) : {};
  const pageRun = (await read(`${state}/page-run.json`)) ?? {};
  const runId = String(runJson.runId ?? root.split("/").pop());
  const wanted = input.pages ?? [
    ...(typeof (runJson.pageId ?? pageRun.pageId) === "string" ? [{ id: String(runJson.pageId ?? pageRun.pageId), kind: "landing-page" }] : []),
    ...(typeof (runJson.boardId ?? pageRun.boardId) === "string" ? [{ id: String(runJson.boardId ?? pageRun.boardId), kind: "brand-board" }] : []),
  ];
  const artifacts: ArtifactRef[] = [];
  const outcome: BackfillResult["artifacts"] = [];
  for (const page of wanted) {
    if (input.dryRun) {
      outcome.push({ id: page.id, kind: page.kind, created: false, versions: 0 });
      continue;
    }
    const seeded = await seedArtifact({ root, state, app: "page", kind: page.kind, id: page.id });
    if (!seeded) continue;
    artifacts.push({ app: "page", kind: page.kind, id: page.id, title: seeded.manifest.title, current: seeded.manifest.current });
    outcome.push({ id: page.id, kind: page.kind, created: seeded.created, versions: seeded.manifest.versions.length });
  }
  const sessions: SessionEntry[] = [];
  const index = await gcsRead(`${state}/host/sessions/index.json`);
  const rows = index ? (JSON.parse(index.data.toString("utf8")) as Row[]) : [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== "string") continue;
    const files = await gcsList(`${state}/host/sessions/${row.id}`);
    sessions.push({ id: row.id, role: String(row.title ?? "session"), bytes: files.reduce((sum, file) => sum + (file.size ?? 0), 0), hasEnvelope: false });
  }
  const titled = typeof runJson.title === "string" && runJson.title ? runJson.title : undefined;
  const page = artifacts.find((artifact) => artifact.kind === "landing-page");
  const manifest = extendRunJson(runJson, {
    runId,
    title: titled ?? page?.title ?? runId,
    workspace: input.workspace ?? "pages",
    workflow: input.workflow ?? "page-generation",
    visibility: input.visibility ?? "team",
    labels: { ...(typeof runJson.brand === "string" ? { brand: runJson.brand } : {}), ...(typeof runJson.depth === "string" ? { depth: runJson.depth } : {}) },
    sessions,
    artifacts: input.dryRun ? [] : artifacts,
    stateLocation: state,
    ...(typeof runJson.starter?.email === "string" && typeof runJson.startedBy !== "string" ? { requester: runJson.starter.email } : {}),
  });
  if (!input.dryRun) await gcsWrite(runUri, JSON.stringify(manifest, null, 2), { contentType: "application/json", cacheControl: "no-cache", ifGenerationMatch: generationOf(runRead) });
  return { root, runId, manifest, artifacts: outcome, sessions: sessions.length, wrote: !input.dryRun };
}
