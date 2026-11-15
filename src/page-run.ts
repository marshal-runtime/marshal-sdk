// One Page Studio page from an agent-sandbox page-agent input folder, on a headless Marshal host, written in the
// run contract agent-sandbox's claude_page_agent writes (workspace.py, agent_run.py, launch_check.py):
//   <out>/index.html (+ <out>/assets/ for the brand's pictures, <out>/shots/{mobile,desktop}.png, <out>/notes.md)
//   <logs>/run.jsonl, <logs>/summary.json, <logs>/query/{system_prompt.md, task.md, options.json}
// launch-check.json is written by the caller with agent-sandbox's own LaunchChecker.
//
//   marshal-sdk page-run --input <work>/input --out <work>/out --logs <log dir> --state <dir outside work> [--fake]
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { QueryFn } from "./agent-port.js";
import type { KitOptions, SessionsPublishOptions } from "./kit/index.js";
import { writeRunLogs, type RunSummaryJson } from "./run-contract.js";

export type PageDepth = "quick" | "single" | "deep";

export interface PageRunOptions {
  /** agent-sandbox's input folder: README.md, brand/brand.json, products/<id>/, page/brief.json, page/operator-request.md. */
  input: string;
  out: string;
  logs: string;
  /** Host-private folder (runtime state, the session store, Page Studio's data); keep it outside the work folder. */
  state: string;
  /** The sessions' working folder. Default: the folder holding input/. */
  workspace?: string;
  /** Page Studio's built package. Default: $MARSHAL_SDK_PAGE_STUDIO, else extensions/page-studio in this package. */
  extension?: string;
  depth?: PageDepth;
  model?: string;
  effort?: string;
  /** Page Studio's fast model for small edits (its quickModel). Pinned so local and sandbox runs use the same one. */
  quickModel?: string;
  /** Kit parts on the host (Brain, memory, sessions), as createMarshalHost's kit. Default: none. */
  kit?: readonly KitPartName[];
  /** Publish the run's sessions to the team Brain's session index (adds the Brain and sessions kit parts). */
  publish?: SessionsPublishOptions;
  /** The page request. Default: page/operator-request.md, then the positioning brief from page/brief.json. */
  idea?: string;
  /** Critic rounds for depth single (1 to 4; Page Studio's default is 2). */
  rounds?: number;
  requiredSkills?: readonly string[];
  /** Do not read the product from the public store (the run uses only the input folder). */
  offline?: boolean;
  /** A scripted backend that answers Page Studio's protocols without a model: the dry path. */
  fake?: boolean;
  env?: Record<string, string>;
  host?: { id: string; kind: string };
  labels?: Record<string, string>;
  log?: (line: string) => void;
}

export interface SandboxInput {
  productId: string;
  productDir: string;
  brandName: string;
  domain: string;
  productHandle: string;
  productName: string;
  idea: string;
}

export interface FinishedPage {
  html: string;
  sections: string[];
  assets: string[];
  missingAssets: string[];
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIBRARY_HOST = "pagestudio.library";
const IDEA_LIMIT = 4_000;

/** Runs one page end to end and writes the contract. Resolves with summary.json; a failed run still writes it. */
export async function runPage(options: PageRunOptions): Promise<RunSummaryJson> {
  const log = options.log ?? (() => undefined);
  const depth = options.depth ?? "single";
  const out = path.resolve(options.out);
  const logs = path.resolve(options.logs);
  const state = path.resolve(options.state);
  const inputDir = path.resolve(options.input);
  const studioDir = path.join(state, "page-studio");
  for (const directory of [path.join(out, "shots"), path.join(logs, "query"), path.join(state, "host"), studioDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const extension = path.resolve(options.extension ?? process.env.MARSHAL_SDK_PAGE_STUDIO ?? path.join(PACKAGE_ROOT, "extensions", "page-studio"));
  if (!fs.existsSync(path.join(extension, "runtime-extension.json"))) throw new Error(`No Page Studio package at ${extension} (pass --extension).`);
  const input = readSandboxInput(inputDir);
  const idea = (options.idea ?? input.idea).slice(0, IDEA_LIMIT);

  const env: Record<string, string> = {
    ...(options.env ??
      Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))),
  };
  // Page Studio reads its folder and its Chrome from the process: it runs inside this process.
  process.env.PAGE_STUDIO_DIR = env.PAGE_STUDIO_DIR = studioDir;
  const chrome = await resolveChrome();
  if (chrome) {
    process.env.MARSHAL_SDK_CHROME = env.MARSHAL_SDK_CHROME = chrome;
    process.env.PAGE_STUDIO_CHROME = env.PAGE_STUDIO_CHROME = noSandboxWrapper(chrome, state);
  }

  const started = Date.now();
  const { createMarshalHost } = await import("./host.js");
  const host = await createMarshalHost({
    workspacePath: path.resolve(options.workspace ?? path.dirname(inputDir)),
    stateRoot: path.join(state, "host"),
    extensions: [{ packageRoot: extension }],
    host: options.host ?? { id: "marshal-sdk", kind: "local" },
    labels: { job: "page-run", depth, ...options.labels },
    env,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { reasoningEffort: options.effort } : {}),
    ...hostKit(options.kit, options.publish),
    ...(options.fake ? { query: fakeQuery, browser: false } : {}),
    log,
  });
  const call = async (capability: string, args: Record<string, unknown>): Promise<any> =>
    ((await host.invoke(capability, args)) as { result?: unknown })?.result;

  let failure = "";
  let settings: Record<string, any> = {};
  let pageId: string | undefined;
  let boardId: string | undefined;
  let finished: FinishedPage | undefined;
  let reply = "";
  let shots: unknown[] = [];
  const warnings: string[] = [];
  try {
    if (options.model || options.effort || options.quickModel) await call("pagestudio.settings", pinnedSettings(options));
    settings = (await call("pagestudio.settings", {})) ?? {};
    log(`page model ${settings.bigModel} at ${settings.bigEffort}, depth ${depth}${options.fake ? ", fake backend" : ""}`);
    const board = await call("pagestudio.brand.add", {
      name: input.brandName,
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.productHandle && input.domain && !options.offline && !options.fake ? { product: input.productHandle } : {}),
    });
    boardId = board.pageId;
    warnings.push(...(board.warnings ?? []));
    const learned = await call("pagestudio.brand.learn", { pageId: boardId, pack: input.productDir });
    log(`brand board ${boardId}: ${learned.pictures} pictures, ${learned.facts} chars of facts`);
    fs.writeFileSync(path.join(logs, "query", "system_prompt.md"), host.systemPrompt() ?? "");
    fs.writeFileSync(path.join(logs, "query", "task.md"), idea);
    fs.writeFileSync(
      path.join(logs, "query", "options.json"),
      JSON.stringify({ capability: "pagestudio.page.create", depth, basedOn: boardId, settings, input, fake: Boolean(options.fake) }, null, 2),
    );
    const created = await call("pagestudio.page.create", {
      title: input.productName || input.brandName,
      idea,
      basedOn: boardId,
      depth,
      ...(options.rounds ? { rounds: options.rounds } : {}),
    });
    pageId = created.pageId;
    log(`page ${pageId}, activity ${created.activity.id}`);
    let step = "";
    for (;;) {
      const activity = await call("pagestudio.activity", { id: created.activity.id, wait: true, timeoutMs: 60_000 });
      if (activity?.step && activity.step !== step) {
        step = activity.step;
        log(`step: ${step} (${host.agents.list().length} sessions so far)`);
      }
      if (activity?.error) throw new Error(`Page Studio stopped: ${activity.error}`);
      if (activity?.doneAt) {
        reply = String(activity.reply ?? "");
        warnings.push(...((activity.failed as string[] | undefined) ?? []));
        break;
      }
    }
    const rendered = await call("pagestudio.render", { pageId });
    const htmlFile = rendered.path ?? rendered.file;
    finished = finishPage(fs.readFileSync(htmlFile, "utf8"), { libraryRoot: path.join(studioDir, "library"), outDir: out });
    fs.writeFileSync(path.join(out, "index.html"), finished.html);
    if (finished.missingAssets.length) warnings.push(`pictures not found: ${finished.missingAssets.join(", ")}`);
    const notes = path.join(studioDir, "polish", String(pageId), "notes.md");
    if (fs.existsSync(notes)) fs.copyFileSync(notes, path.join(out, "notes.md"));
    log(`page written: ${finished.sections.length} sections, ${finished.assets.length} pictures`);
    shots = await screenshots(path.join(out, "index.html"), path.join(out, "shots"), chrome);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${failure}`);
  }

  const sessions = host.sessions.list({ runId: host.runId });
  const summary = writeRunLogs({
    logDir: logs,
    storeRoot: path.join(state, "host", "sessions"),
    sessions,
    model: settings.bigModel,
    effort: settings.bigEffort,
    started,
    error: failure,
    requiredSkills: options.requiredSkills ?? [],
    marshal: {
      runId: host.runId,
      engine: "page-studio",
      fake: Boolean(options.fake),
      depth,
      boardId,
      pageId,
      reply,
      sections: finished?.sections ?? [],
      assets: finished?.assets.length ?? 0,
      warnings,
      shots,
    },
  });
  if (pageId) writePageRunRecord(state, { pageId, boardId, runId: host.runId, depth, settings, at: new Date().toISOString() });
  await host.dispose().catch(() => undefined);
  return summary;
}

type KitPartName = "brain" | "memory" | "sessions";

function pinnedSettings(options: { model?: string; effort?: string; quickModel?: string }): Record<string, string> {
  return {
    ...(options.model ? { bigModel: options.model } : {}),
    ...(options.effort ? { bigEffort: options.effort } : {}),
    ...(options.quickModel ? { quickModel: options.quickModel } : {}),
  };
}

/** The page a run made, kept in its state folder so a later edit turn (page-edit) finds the page to change. */
export interface PageRunRecord {
  pageId: string;
  boardId?: string;
  runId: string;
  depth: string;
  settings: Record<string, unknown>;
  at: string;
  edits?: { at: string; request: string; runId: string; error?: string }[];
}

const PAGE_RUN_RECORD = "page-run.json";

export function readPageRunRecord(state: string): PageRunRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(path.resolve(state), PAGE_RUN_RECORD), "utf8")) as PageRunRecord;
    return typeof record?.pageId === "string" ? record : undefined;
  } catch {
    return undefined;
  }
}

function writePageRunRecord(state: string, record: PageRunRecord): void {
  fs.writeFileSync(path.join(path.resolve(state), PAGE_RUN_RECORD), JSON.stringify(record, null, 2));
}

export interface PageEditOptions {
  /** The finished run's state folder (as page-run left it, or downloaded from the run's agent/marshal-state/). */
  state: string;
  out: string;
  logs: string;
  /** The change in plain words; Page Studio's ask routes it (decisions: look change, quick model or page editor). */
  request: string;
  /** The page to change. Default: the page the run made (page-run.json in the state folder). */
  pageId?: string;
  workspace?: string;
  extension?: string;
  model?: string;
  effort?: string;
  quickModel?: string;
  kit?: readonly KitPartName[];
  publish?: SessionsPublishOptions;
  fake?: boolean;
  env?: Record<string, string>;
  host?: { id: string; kind: string };
  log?: (line: string) => void;
}

/**
 * One edit turn on a finished page: reopens the run's host state (its session store and Page Studio's data), asks
 * Page Studio for the change, then writes the page and the run contract again. The state folder is updated in place,
 * so uploading it again keeps the edit, its sessions and the page's history.
 */
export async function runPageEdit(options: PageEditOptions): Promise<RunSummaryJson> {
  const log = options.log ?? (() => undefined);
  const out = path.resolve(options.out);
  const logs = path.resolve(options.logs);
  const state = path.resolve(options.state);
  const studioDir = path.join(state, "page-studio");
  const record = readPageRunRecord(state);
  const pageId = options.pageId ?? record?.pageId;
  for (const directory of [path.join(out, "shots"), path.join(logs, "query"), path.join(state, "host"), studioDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const extension = path.resolve(options.extension ?? process.env.MARSHAL_SDK_PAGE_STUDIO ?? path.join(PACKAGE_ROOT, "extensions", "page-studio"));
  const env: Record<string, string> = {
    ...(options.env ??
      Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))),
  };
  process.env.PAGE_STUDIO_DIR = env.PAGE_STUDIO_DIR = studioDir;
  const chrome = await resolveChrome();
  if (chrome) {
    process.env.MARSHAL_SDK_CHROME = env.MARSHAL_SDK_CHROME = chrome;
    process.env.PAGE_STUDIO_CHROME = env.PAGE_STUDIO_CHROME = noSandboxWrapper(chrome, state);
  }
  const started = Date.now();
  const { createMarshalHost } = await import("./host.js");
  const host = await createMarshalHost({
    workspacePath: path.resolve(options.workspace ?? path.dirname(out)),
    stateRoot: path.join(state, "host"),
    extensions: [{ packageRoot: extension }],
    host: options.host ?? { id: "marshal-sdk", kind: "local" },
    labels: { job: "page-edit" },
    env,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { reasoningEffort: options.effort } : {}),
    ...hostKit(options.kit, options.publish),
    ...(options.fake ? { query: fakeQuery, browser: false } : {}),
    log,
  });
  const call = async (capability: string, args: Record<string, unknown>): Promise<any> =>
    ((await host.invoke(capability, args)) as { result?: unknown })?.result;
  let failure = "";
  let settings: Record<string, any> = {};
  let finished: FinishedPage | undefined;
  let reply = "";
  let route: unknown;
  let shots: unknown[] = [];
  try {
    if (!pageId) throw new Error(`No page to edit: ${state} has no ${PAGE_RUN_RECORD} and no --page-id was given.`);
    if (options.model || options.effort || options.quickModel) await call("pagestudio.settings", pinnedSettings(options));
    // The dry path has no OpenAI key: route by the fast model instead of the Decisions API.
    if (options.fake) await call("pagestudio.settings", { useDecisions: false });
    settings = (await call("pagestudio.settings", {})) ?? {};
    fs.writeFileSync(path.join(logs, "query", "task.md"), options.request);
    fs.writeFileSync(path.join(logs, "query", "options.json"), JSON.stringify({ capability: "pagestudio.ask", pageId, settings, fake: Boolean(options.fake) }, null, 2));
    const asked = await call("pagestudio.ask", { pageId, text: options.request });
    const activityId = asked?.activity?.id ?? asked?.id;
    if (!activityId) throw new Error(`pagestudio.ask returned no activity: ${JSON.stringify(asked).slice(0, 300)}`);
    for (;;) {
      const activity = await call("pagestudio.activity", { id: activityId, wait: true, timeoutMs: 60_000 });
      if (activity?.error) throw new Error(`Page Studio stopped: ${activity.error}`);
      if (activity?.doneAt) {
        reply = String(activity.reply ?? "");
        route = activity.route ?? activity.tier ?? activity.routedBy;
        break;
      }
    }
    const rendered = await call("pagestudio.render", { pageId });
    finished = finishPage(fs.readFileSync(rendered.path ?? rendered.file, "utf8"), { libraryRoot: path.join(studioDir, "library"), outDir: out });
    fs.writeFileSync(path.join(out, "index.html"), finished.html);
    log(`edit applied (${String(route ?? "routed")}): ${reply.slice(0, 160)}`);
    shots = await screenshots(path.join(out, "index.html"), path.join(out, "shots"), chrome);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log(`FAILED: ${failure}`);
  }
  const sessions = host.sessions.list({ runId: host.runId });
  const summary = writeRunLogs({
    logDir: logs,
    storeRoot: path.join(state, "host", "sessions"),
    sessions,
    model: settings.bigModel,
    effort: settings.bigEffort,
    started,
    error: failure,
    requiredSkills: [],
    marshal: { runId: host.runId, engine: "page-studio", job: "edit", pageId, request: options.request, route, reply, sections: finished?.sections ?? [], shots },
  });
  if (record) {
    writePageRunRecord(state, { ...record, edits: [...(record.edits ?? []), { at: new Date().toISOString(), request: options.request, runId: host.runId, ...(failure ? { error: failure } : {}) }] });
  }
  await host.dispose().catch(() => undefined);
  return summary;
}

/** What one page run needs from agent-sandbox's input folder. */
export function readSandboxInput(inputDir: string): SandboxInput {
  const json = (file: string): any => {
    try {
      return JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8"));
    } catch {
      return {};
    }
  };
  const text = (file: string): string => {
    try {
      return fs.readFileSync(path.join(inputDir, file), "utf8").trim();
    } catch {
      return "";
    }
  };
  const brief = json("page/brief.json");
  const products = fs.existsSync(path.join(inputDir, "products")) ? fs.readdirSync(path.join(inputDir, "products")).filter((name) => !name.startsWith(".")) : [];
  const productId = String(brief.product_id ?? (products.length === 1 ? products[0] : ""));
  if (!productId || !products.includes(productId)) throw new Error(`${inputDir} has no products/<id>/ for the brief's product (${productId || "none named"}).`);
  const productDir = path.join(inputDir, "products", productId);
  const brand = json("brand/brand.json");
  const product = json(`products/${productId}/product.json`);
  const offers = json(`products/${productId}/offers.json`);
  const website = typeof brand.existing_website === "string" ? brand.existing_website : "";
  let domain = typeof offers.domain === "string" ? offers.domain : "";
  if (!domain && website) {
    try {
      domain = new URL(website).hostname;
    } catch {
      domain = "";
    }
  }
  const request = text("page/operator-request.md");
  const positioning = typeof brief.positioning?.brief_markdown === "string" ? brief.positioning.brief_markdown.trim() : "";
  const idea = [request, positioning && `The positioning this page sells:\n${positioning}`].filter(Boolean).join("\n\n");
  return {
    productId,
    productDir,
    brandName: String(brief.brand_name ?? brand.name ?? "").trim() || domain,
    domain: domain.replace(/^www\./, ""),
    productHandle: String(product.core?.product_handle ?? ""),
    productName: String(brief.product_name ?? product.core?.name ?? ""),
    idea: idea || `A landing page for ${String(brief.product_name ?? product.core?.name ?? "the product")}.`,
  };
}

/**
 * The rendered page made publishable by agent-sandbox: the brand's pictures copied to <out>/assets and linked
 * relatively (its publisher uploads local media under the work folder), and a data-zyg-section id on every
 * top-level section, header and footer (its launch check and editor key sections by it).
 */
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

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Chrome or Chromium: $MARSHAL_SDK_CHROME, $PAGE_STUDIO_CHROME, Playwright's installed Chromium, else the Mac's Chrome. */
/**
 * The first Chrome that answers Page Studio's DevTools pipe. Found 2026-11-15: Playwright's "Google Chrome for
 * Testing" on macOS starts but never answers the pipe, so every Page Studio look and polish waited out its 90-120 s
 * kill timer; a given path is trusted, the others are probed.
 */
async function resolveChrome(): Promise<string | undefined> {
  const given = process.env.MARSHAL_SDK_CHROME || process.env.PAGE_STUDIO_CHROME;
  if (given) return given;
  const candidates: string[] = [];
  try {
    const { chromium } = await import("playwright-core");
    candidates.push(chromium.executablePath());
  } catch {
    // Playwright has no Chromium installed for this platform.
  }
  if (process.platform === "darwin") candidates.unshift("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  const present = candidates.filter((candidate) => candidate && fs.existsSync(candidate));
  for (const candidate of present) if (await answersPipe(candidate)) return candidate;
  return present[0];
}

async function answersPipe(chrome: string, timeoutMs = 10_000): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-chrome-"));
  const flags = ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"];
  if (process.env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1") flags.unshift("--no-sandbox");
  const child = spawn(chrome, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const [toChrome, fromChrome] = [child.stdio[3], child.stdio[4]] as [NodeJS.WritableStream, NodeJS.ReadableStream];
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("error", () => resolve(false));
      child.once("exit", () => resolve(false));
      fromChrome.once("data", () => {
        clearTimeout(timer);
        resolve(true);
      });
      toChrome.write(`${JSON.stringify({ id: 1, method: "Browser.getVersion" })}\0`);
    });
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve(undefined)));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Page Studio starts Chrome itself without --no-sandbox, which Chrome refuses as root and which fails in a
 * container without user namespaces; with MARSHAL_SDK_CHROME_NO_SANDBOX=1 it gets a wrapper that adds the flag.
 */
function noSandboxWrapper(chrome: string, state: string): string {
  if (process.env.MARSHAL_SDK_CHROME_NO_SANDBOX !== "1" || process.platform === "win32") return chrome;
  const wrapper = path.join(state, "chrome-no-sandbox.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${chrome.replaceAll("'", "'\\''")}' --no-sandbox "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/** Phone (390 px, 2x) and desktop (1280 px) full-page captures at a real viewport width. */
async function screenshots(htmlFile: string, shotsDir: string, chrome: string | undefined): Promise<unknown[]> {
  const { chromium } = await import("playwright-core");
  fs.mkdirSync(shotsDir, { recursive: true });
  const browser = await chromium.launch({
    ...(chrome ? { executablePath: chrome } : {}),
    args: process.env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  const taken: unknown[] = [];
  try {
    for (const [name, width, height, scale, mobile] of [
      ["mobile", 390, 844, 2, true],
      ["desktop", 1280, 800, 1, false],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
      const tab = await context.newPage();
      await tab.goto(`file://${htmlFile}`, { waitUntil: "load" });
      await tab.waitForTimeout(1_500);
      const file = path.join(shotsDir, `${name}.png`);
      await tab.screenshot({ path: file, fullPage: true });
      const layout = await tab.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length,
      }));
      taken.push({ name, file: path.relative(path.dirname(shotsDir), file), viewportWidth: width, ...layout, overflowsX: layout.scrollWidth > layout.innerWidth });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return taken;
}

/**
 * The dry path's backend: answers each of Page Studio's protocols with a fixed, valid reply and no model.
 * The page it writes uses the first library picture it was offered, so the asset path is exercised too.
 */
export const fakeQuery: QueryFn = (params) =>
  (async function* () {
    const text = await promptText(params.prompt);
    const answer = fakeAnswer(text);
    const sessionId = randomUUID();
    yield { type: "system", subtype: "init", session_id: sessionId, model: String(params.options.model ?? "fake"), skills: [], tools: [], cwd: params.options.cwd };
    yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] }, parent_tool_use_id: null, session_id: sessionId };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      result: answer,
      session_id: sessionId,
    };
  })();

export function fakeAnswer(prompt: string): string {
  const head = prompt.trimStart().slice(0, 400);
  if (/Reply with the single word ready/.test(prompt) && prompt.length < 600) return "ready";
  if (head.startsWith("You are a fresh-eyes critic")) {
    return JSON.stringify({ score: 8, verdict: "pass", summary: "Dry run: no model looked at this page.", findings: [] });
  }
  if (head.startsWith("You look at a brand's pictures")) return JSON.stringify({ pictures: [] });
  if (head.startsWith("You are the fast hands of ZyG Page Studio")) return JSON.stringify({ tier: "edit", ops: [], reply: "Dry run: no model changed the page." });
  if (head.startsWith("You are the page editor of ZyG Page Studio")) return JSON.stringify({ ops: [], reply: "Dry run: no model changed the page." });
  if (head.startsWith("You design and write one long")) {
    if (prompt.includes("You are FIXING the page")) return "";
    const picture = new RegExp(`https://${escapeRegExp(LIBRARY_HOST)}/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp|avif|gif)`).exec(prompt)?.[0];
    const image = picture ? `<img class="zs-pg-hero__img" src="${picture}" alt="The product" width="800" height="800">` : "";
    return [
      `<!--page title="Dry run page"-->`,
      `<!--section key="hero" label="Hero"-->`,
      `<style>.zs-pg-hero{padding:48px 20px;text-align:center}.zs-pg-hero__img{display:block;width:100%;max-width:480px;height:auto;margin:24px auto 0}</style><section id="hero" class="zs-pg-hero"><h1 class="zs-pg-hero__title">A page written without a model</h1><p class="zs-pg-hero__text">The dry path of marshal-sdk page-run.</p>${image}</section>`,
      `<!--section key="proof" label="Proof"-->`,
      `<style>.zs-pg-proof{padding:40px 20px}.zs-pg-proof__title{margin:0 0 12px}</style><section id="proof" class="zs-pg-proof"><h2 class="zs-pg-proof__title">What the run proves</h2><p class="zs-pg-proof__text">Input mapped, brand library learned, page written, rendered and logged.</p></section>`,
    ].join("\n");
  }
  if (head.includes('{"ops"') || prompt.includes('reply with exactly {"ops":[],"reply":"ready"}')) return JSON.stringify({ ops: [], reply: "ready" });
  return "{}";
}

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  if (prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const message of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
      const content = message?.message?.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) for (const block of content) if (block?.type === "text") parts.push(String(block.text));
    }
  }
  return parts.join("\n");
}

const USAGE = `marshal-sdk page-run: one Page Studio page from an agent-sandbox page-agent input folder, written in its run contract.

  --input <dir>      the page agent's input folder (README.md, brand/, products/<id>/, page/)       (required)
  --out <dir>        where index.html, assets/, shots/ and notes.md go (their page-agent/out)       (required)
  --logs <dir>       where run.jsonl, summary.json and query/ go (their page-agent-logs)            (required)
  --state <dir>      host-private folder outside the work folder                                    (required)
  --extension <dir>  Page Studio's built package (default: $MARSHAL_SDK_PAGE_STUDIO, else the bundled one)
  --depth <quick|single|deep>  (default single)   --rounds <1-4>   --idea <text | @file>
  --model <id>  --effort <low|medium|high|xhigh|max>   --quick-model <id>   --required-skill <name> (repeatable)
  --kit <brain,memory,sessions>  kit parts on the host (default: $MARSHAL_SDK_KIT, else none)
  --publish-sessions <team|email,...>  publish the run's sessions to the team Brain's session index, for the team or
                     those people (default: $MARSHAL_SDK_PUBLISH_SESSIONS, else off); adds the Brain and sessions kit
  --publish-context <text>  one line in front of each published session's first prompt, e.g. the run id and the
                     state folder's GCS path (default: $MARSHAL_SDK_PUBLISH_CONTEXT)
  --workspace <dir>  the sessions' working folder (default: the folder holding --input)
  --claude-config-dir <dir>  run the backend on that Claude account and drop ANTHROPIC_API_KEY
  --offline          do not read the product from the public store
  --fake             a scripted backend instead of a model: the dry path, no credentials needed
  --host-id <id>  --host-kind <local|container|e2b>

Exit code 0 when the page was written, 1 when the run failed (summary.json carries the error).
`;

/** The page-run command: parses its own arguments, prints summary.json's path and outcome. */
export async function pageRunCommand(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.\n\n${USAGE}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.add(token.slice(2));
    else {
      values.set(token.slice(2), [...(values.get(token.slice(2)) ?? []), next]);
      index += 1;
    }
  }
  const one = (name: string): string | undefined => values.get(name)?.at(-1);
  const required = (name: string): string => {
    const value = one(name);
    if (!value) throw new Error(`--${name} is required.\n\n${USAGE}`);
    return value;
  };
  const depth = (one("depth") ?? "single") as PageDepth;
  if (!["quick", "single", "deep"].includes(depth)) throw new Error(`--depth takes quick, single or deep, got ${depth}.`);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const configDir = one("claude-config-dir");
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = path.resolve(configDir);
    delete env.ANTHROPIC_API_KEY;
  }
  const idea = one("idea");
  const summary = await runPage({
    input: required("input"),
    out: required("out"),
    logs: required("logs"),
    state: required("state"),
    depth,
    env,
    ...(one("workspace") ? { workspace: one("workspace")! } : {}),
    ...(one("extension") ? { extension: one("extension")! } : {}),
    ...(one("model") ? { model: one("model")! } : {}),
    ...(one("effort") ? { effort: one("effort")! } : {}),
    ...(one("rounds") ? { rounds: Number(one("rounds")) } : {}),
    ...(one("quick-model") ? { quickModel: one("quick-model")! } : {}),
    ...(kitArgument(one("kit")) ? { kit: kitArgument(one("kit"))! } : {}),
    ...publishArgument(one("publish-sessions"), one("publish-context")),
    ...(idea ? { idea: idea.startsWith("@") ? fs.readFileSync(idea.slice(1), "utf8") : idea } : {}),
    requiredSkills: values.get("required-skill") ?? [],
    offline: flags.has("offline"),
    fake: flags.has("fake"),
    host: { id: one("host-id") ?? "marshal-sdk", kind: one("host-kind") ?? "local" },
    log: (line) => process.stderr.write(`[marshal-sdk page-run ${new Date().toISOString().slice(11, 19)}] ${line}\n`),
  });
  const marshal = summary.marshal as { sections?: string[]; usage?: { costUsd?: number } };
  process.stdout.write(
    `${JSON.stringify({
      summary: path.join(path.resolve(required("logs")), "summary.json"),
      error: summary.error,
      sections: marshal.sections?.length ?? 0,
      wall_seconds: summary.wall_seconds,
      cost_usd: marshal.usage?.costUsd ?? 0,
    })}\n`,
  );
  return summary.error ? 1 : 0;
}

/** The host's kit: the parts asked for, plus the Brain and sessions when the run publishes its sessions. */
export function hostKit(kit: readonly KitPartName[] | undefined, publish: SessionsPublishOptions | undefined): { kit?: KitOptions } {
  if (!publish) return kit?.length ? { kit: { parts: [...kit] } } : {};
  const parts = new Set<KitPartName>([...(kit ?? []), "brain", "sessions"]);
  return { kit: { parts: [...parts], sessions: { publish } } };
}

function publishArgument(audience: string | undefined, context: string | undefined): { publish?: SessionsPublishOptions } {
  const raw = (audience ?? process.env.MARSHAL_SDK_PUBLISH_SESSIONS ?? "").trim();
  if (!raw || raw === "off") return {};
  const line = (context ?? process.env.MARSHAL_SDK_PUBLISH_CONTEXT ?? "").trim();
  const people = raw === "team" ? [] : raw.split(",").map((email) => email.trim()).filter(Boolean);
  return { publish: { audience: people.length ? { people } : "team", ...(line ? { context: line } : {}) } };
}

function kitArgument(value: string | undefined): KitPartName[] | undefined {
  const raw = value ?? process.env.MARSHAL_SDK_KIT ?? "";
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) if (!["brain", "memory", "sessions"].includes(part)) throw new Error(`--kit takes brain, memory and sessions, got ${part}.`);
  return parts.length ? (parts as KitPartName[]) : undefined;
}

const EDIT_USAGE = `marshal-sdk page-edit: one edit turn on a page a page-run made, from that run's state folder.

  --state <dir>      the run's state folder (page-run --state, or its agent/marshal-state/ downloaded)  (required)
  --out <dir>        where the edited index.html and shots/ go                                        (required)
  --logs <dir>       where run.jsonl, summary.json and query/ for this turn go                        (required)
  --request <text | @file>  the change in plain words                                                  (required)
  --page-id <id>     default: the page the run made
  --model <id>  --effort <level>  --quick-model <id>  --kit <brain,memory,sessions>  --fake
  --publish-sessions <team|email,...>  --publish-context <text>   (as page-run)
  --claude-config-dir <dir>  --host-id <id>  --host-kind <kind>

Exit code 0 when the edited page was written, 1 otherwise (summary.json carries the error).
`;

/** The page-edit command. */
export async function pageEditCommand(argv: readonly string[]): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      process.stdout.write(EDIT_USAGE);
      return 0;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.\n\n${EDIT_USAGE}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.add(token.slice(2));
    else {
      values.set(token.slice(2), next);
      index += 1;
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required.\n\n${EDIT_USAGE}`);
    return value;
  };
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const configDir = values.get("claude-config-dir");
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = path.resolve(configDir);
    delete env.ANTHROPIC_API_KEY;
  }
  const request = required("request");
  const kit = kitArgument(values.get("kit"));
  const summary = await runPageEdit({
    state: required("state"),
    out: required("out"),
    logs: required("logs"),
    request: request.startsWith("@") ? fs.readFileSync(request.slice(1), "utf8") : request,
    env,
    ...(values.get("page-id") ? { pageId: values.get("page-id")! } : {}),
    ...(values.get("extension") ? { extension: values.get("extension")! } : {}),
    ...(values.get("model") ? { model: values.get("model")! } : {}),
    ...(values.get("effort") ? { effort: values.get("effort")! } : {}),
    ...(values.get("quick-model") ? { quickModel: values.get("quick-model")! } : {}),
    ...(kit ? { kit } : {}),
    ...publishArgument(values.get("publish-sessions"), values.get("publish-context")),
    fake: flags.has("fake"),
    host: { id: values.get("host-id") ?? "marshal-sdk", kind: values.get("host-kind") ?? "local" },
    log: (line) => process.stderr.write(`[marshal-sdk page-edit ${new Date().toISOString().slice(11, 19)}] ${line}\n`),
  });
  const marshal = summary.marshal as { sections?: string[] };
  process.stdout.write(`${JSON.stringify({ summary: path.join(path.resolve(required("logs")), "summary.json"), error: summary.error, sections: marshal.sections?.length ?? 0, wall_seconds: summary.wall_seconds })}\n`);
  return summary.error ? 1 : 0;
}
