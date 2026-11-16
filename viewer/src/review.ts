// Page Studio notes -> their page generator's review comments (the /lp-review panel).
//
// Their review page reads comments from store-manager's page_editor_comment table through the api-gateway
// (GET /api/store_manager/page_editor/comments?run_id=N). A section comment carries a CSS selector the review page
// resolves with document.querySelector, so a note on section "hero" becomes [data-zyg-section="hero"], the attribute
// every pushed section carries. Which comment each note became is kept in the run itself
// (agent/edits/review-comments.json), so pushes from any Mac add each note once and remove it once it is resolved.

import fs from "fs";
import os from "os";
import path from "path";

type Row = Record<string, any>;

export interface ReviewApiConfig {
  /** The api-gateway base URL, e.g. http://127.0.0.1:8080 (dev stacks only). */
  url: string;
  /** File holding a bearer token for a signed-in user (the gateway credits comments to that user's email). */
  tokenFile?: string;
  /** File holding a Cookie header value, for gateways that sign in through a session cookie. */
  cookieFile?: string;
}

export interface ReviewNote {
  uid: string;
  key?: string;
  body: string;
  author?: string;
  status?: string;
  createdAt?: string;
}

export interface ReviewSync {
  runId: number;
  added: number;
  removed: number;
  kept: number;
  /** note uid -> comment id, after this sync. */
  comments: Record<string, number>;
}

const home = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export function configuredReview(configuration: Row | undefined): ReviewApiConfig | null {
  const entry = configuration?.review;
  if (!entry || typeof entry.url !== "string" || !/^https?:\/\/[^/]+/.test(entry.url)) return null;
  return {
    url: entry.url.replace(/\/+$/, ""),
    ...(typeof entry.tokenFile === "string" && entry.tokenFile ? { tokenFile: entry.tokenFile } : {}),
    ...(typeof entry.cookieFile === "string" && entry.cookieFile ? { cookieFile: entry.cookieFile } : {}),
  };
}

/** Their page generator keeps a run's output under page-generation-runs/<id>/output; that id keys its comments. */
export function reviewRunId(outputRoot: string, runJson?: Row): number | null {
  const fromPath = /\/page-generation-runs\/(\d+)\/output\/?$/.exec(outputRoot);
  if (fromPath) return Number(fromPath[1]);
  const fromRun = Number(runJson?.pageGenerationRunId ?? runJson?.runId);
  return Number.isInteger(fromRun) && fromRun > 0 ? fromRun : null;
}

export function notesOf(pageDoc: Row): ReviewNote[] {
  const notes: Row[] = Array.isArray(pageDoc?.notes) ? pageDoc.notes : [];
  return notes
    .filter((note) => typeof note?.uid === "string" && typeof note.body === "string" && note.body.trim())
    .map((note) => ({ uid: note.uid, body: note.body, ...(typeof note.key === "string" ? { key: note.key } : {}), ...(typeof note.author === "string" ? { author: note.author } : {}), ...(typeof note.status === "string" ? { status: note.status } : {}), ...(typeof note.createdAt === "string" ? { createdAt: note.createdAt } : {}) }));
}

function headers(config: ReviewApiConfig): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (config.tokenFile) out.authorization = `Bearer ${fs.readFileSync(home(config.tokenFile), "utf8").trim()}`;
  if (config.cookieFile) out.cookie = fs.readFileSync(home(config.cookieFile), "utf8").trim();
  return out;
}

async function call(config: ReviewApiConfig, method: string, route: string, body?: unknown): Promise<Row> {
  const response = await fetch(`${config.url}${route}`, { method, headers: headers(config), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as Row) : {};
}

/**
 * Brings the run's review comments in line with the page's notes: an open note not sent yet becomes a section comment
 * (or a general one when it has no section), and a note sent earlier that is now resolved or gone is deleted there.
 * Comments people wrote in their UI are never touched.
 */
export async function syncReviewComments(config: ReviewApiConfig, runId: number, notes: ReviewNote[], sent: Record<string, number>): Promise<ReviewSync> {
  const comments: Record<string, number> = { ...sent };
  const open = new Map(notes.filter((note) => (note.status ?? "open") === "open").map((note) => [note.uid, note]));
  let added = 0;
  let removed = 0;
  for (const [uid, id] of Object.entries(sent)) {
    if (open.has(uid)) continue;
    await call(config, "DELETE", `/api/store_manager/page_editor/comments/${id}`).catch((error: Error) => {
      if (!/HTTP 404/.test(error.message)) throw error;
    });
    delete comments[uid];
    removed++;
  }
  for (const note of open.values()) {
    if (comments[note.uid] !== undefined) continue;
    const text = note.author ? `${note.body}\n(${note.author}, from Marshal Page Studio)` : `${note.body}\n(from Marshal Page Studio)`;
    const base = { text, category: "general", timestamp: note.createdAt ?? new Date().toISOString() };
    const created = await call(config, "POST", "/api/store_manager/page_editor/comments", {
      runId,
      ...(note.key ? { sectionComment: { ...base, selector: `[data-zyg-section="${note.key.replace(/["\\]/g, "")}"]` } } : { generalComment: base }),
    });
    const id = Number(created?.response?.id ?? created?.id);
    if (!Number.isInteger(id)) throw new Error("the review API answered without a comment id");
    comments[note.uid] = id;
    added++;
  }
  return { runId, added, removed, kept: Object.keys(comments).length - added, comments };
}
