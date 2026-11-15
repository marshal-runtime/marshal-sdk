// POC: one Page Studio page generated on a headless Marshal host, the way agent-sandbox would run it.
// The extension drives the run; its workers are Marshal sessions started through marshal.agent.launch.
//
//   node poc/page-studio-run.mjs --run <dir> --extension <packageRoot> [--depth quick|single|deep]
//        [--claude-config-dir <dir>] [--model <id>] [--effort <level>] [--idea <text>] [--based-on <pageId>]
//
// Output follows agent-sandbox's claude_page_agent layout (workspace.py, agent_run.py, launch_check.py):
//   <dir>/page-agent/out/index.html, <dir>/page-agent/out/shots/{mobile,desktop}.png
//   <dir>/page-agent-logs/run.jsonl      every SDK message of every session, in time order
//   <dir>/page-agent-logs/summary.json   RunSummary fields, plus the Marshal run and its sessions
//   <dir>/page-agent-logs/query/         system_prompt.md, task.md, options.json
// Host-private state (runtime state, the session store) goes to <dir>/state, Page Studio's own folder to
// <dir>/data, and the sessions' working folder is <dir>/ws.
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { createMarshalHost } from "../dist/src/index.js";
import { writeRunLogs } from "./run-contract.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
const need = (name) => {
  if (!args.get(name)) throw new Error(`--${name} is required`);
  return args.get(name);
};

const run = path.resolve(need("run"));
const depth = args.get("depth") ?? "quick";
const basedOn = args.get("based-on") ?? "rawdog--new-page-7n8n5";
const idea =
  args.get("idea") ??
  "A landing page for the Caffeine Under Eye Cream aimed at men in their 30s and 40s who look tired on video calls. Lead with looking awake fast, back it with the ingredients and customer reviews already on record, and keep the buy box and the 90-day guarantee.";
const outDir = path.join(run, "page-agent", "out");
const logDir = path.join(run, "page-agent-logs");
for (const directory of [path.join(run, "ws"), path.join(run, "state"), path.join(run, "data"), path.join(outDir, "shots"), path.join(logDir, "query")]) {
  fs.mkdirSync(directory, { recursive: true });
}
process.env.PAGE_STUDIO_DIR = path.join(run, "data");

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
if (args.get("claude-config-dir")) {
  env.CLAUDE_CONFIG_DIR = path.resolve(args.get("claude-config-dir"));
  delete env.ANTHROPIC_API_KEY;
}
const log = (line) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);

if (args.get("shots-only")) {
  // Re-shoot an existing page: --shots-only <index.html>.
  log(JSON.stringify(await screenshots(path.resolve(args.get("shots-only")), path.join(outDir, "shots"))));
  process.exit(0);
}

const started = Date.now();
const host = await createMarshalHost({
  workspacePath: path.join(run, "ws"),
  stateRoot: path.join(run, "state"),
  extensions: [{ packageRoot: path.resolve(need("extension")) }],
  host: { id: args.get("host-id") ?? "poc", kind: args.get("host-kind") ?? "local" },
  env,
  log,
});
log(`host up, run ${host.runId}`);

let failure;
let pageId;
let settings = {};
const shots = [];
try {
  if (args.get("model") || args.get("effort")) {
    await host.invoke("pagestudio.settings", {
      ...(args.get("model") ? { bigModel: args.get("model") } : {}),
      ...(args.get("effort") ? { bigEffort: args.get("effort") } : {}),
    });
  }
  settings = (await host.invoke("pagestudio.settings", {})).result;
  log(`page model ${settings.bigModel} at ${settings.bigEffort}, depth ${depth}`);
  fs.writeFileSync(path.join(logDir, "query", "system_prompt.md"), host.systemPrompt() ?? "");
  fs.writeFileSync(path.join(logDir, "query", "task.md"), idea);
  fs.writeFileSync(
    path.join(logDir, "query", "options.json"),
    JSON.stringify({ capability: "pagestudio.page.create", depth, basedOn, settings }, null, 2),
  );
  const created = (await host.invoke("pagestudio.page.create", { title: `Headless ${depth}`, idea, basedOn, depth })).result;
  pageId = created.pageId;
  log(`page ${pageId} created, activity ${created.activity.id}`);
  let step = "";
  for (;;) {
    const activity = (await host.invoke("pagestudio.activity", { id: created.activity.id, wait: true, timeoutMs: 60_000 })).result;
    const current = activity?.step ?? "";
    if (current !== step) {
      step = current;
      log(`step: ${step} (${host.agents.list().length} sessions so far)`);
    }
    if (activity?.error) throw new Error(`Page Studio stopped: ${activity.error}`);
    if (activity?.doneAt) break;
  }
  const rendered = (await host.invoke("pagestudio.render", { pageId })).result;
  const htmlPath = rendered.path ?? rendered.file;
  fs.copyFileSync(htmlPath, path.join(outDir, "index.html"));
  log(`rendered ${htmlPath}`);
  shots.push(...(await screenshots(path.join(outDir, "index.html"), path.join(outDir, "shots"))));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
}

const sessions = host.sessions.list({ runId: host.runId });
const page = pageId ? (await host.invoke("pagestudio.page.get", { pageId }).catch(() => undefined))?.result : undefined;
const summary = writeRunLogs({
  logDir,
  storeRoot: path.join(run, "state", "sessions"),
  sessions,
  settings,
  started,
  error: failure ?? "",
  marshal: { runId: host.runId, depth, idea, basedOn, pageId, sections: page?.sections?.map((section) => section.key) ?? [], shots },
});
log(`${sessions.length} sessions, $${summary.marshal.usage.costUsd.toFixed(2)} at list price, ${summary.wall_seconds}s; summary at ${path.join(logDir, "summary.json")}`);
await host.dispose().catch(() => undefined);
process.exit(failure ? 1 : 0);

/**
 * Phone and desktop screenshots at a real viewport width. Chrome's own --screenshot flag is no good for the
 * phone: headless Chrome lays the page out at least 500px wide and then crops the PNG to the window size.
 */
async function screenshots(htmlFile, shotsDir) {
  fs.mkdirSync(shotsDir, { recursive: true });
  const executablePath = process.env.MARSHAL_SDK_CHROME || process.env.PAGE_STUDIO_CHROME || defaultChrome();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: process.env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  const taken = [];
  try {
    for (const [name, width, height, scale, mobile] of [
      ["mobile", 390, 844, 2, true],
      ["desktop", 1280, 800, 1, false],
    ]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
      const tab = await context.newPage();
      await tab.goto(`file://${htmlFile}`, { waitUntil: "load" });
      await tab.waitForTimeout(1500);
      const file = path.join(shotsDir, `${name}.png`);
      await tab.screenshot({ path: file, fullPage: true });
      const layout = await tab.evaluate(() => ({
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      taken.push({ name, file, viewportWidth: width, ...layout, overflowsX: layout.scrollWidth > layout.innerWidth });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return taken;
}

function defaultChrome() {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return process.platform === "darwin" && fs.existsSync(mac) ? mac : undefined;
}
