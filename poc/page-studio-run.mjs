// POC: one Page Studio page generated on a headless Marshal host, the way agent-sandbox would run it.
// The extension drives the run; its workers are Marshal sessions started through marshal.agent.launch.
//
//   node poc/page-studio-run.mjs --run <dir> --extension <packageRoot> [--depth quick|single|deep]
//        [--claude-config-dir <dir>] [--model <id>] [--effort <level>] [--idea <text>] [--based-on <pageId>]
//
// <dir> gets ws/ (the sessions' working folder), state/ (runtime state and sessions), data/ (Page Studio's
// own folder) and out/ (index.html, shots/, summary.json: the artifacts a sandbox run hands back).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createMarshalHost } from "../dist/src/index.js";

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
for (const directory of ["ws", "state", "data", "out/shots"]) fs.mkdirSync(path.join(run, directory), { recursive: true });
process.env.PAGE_STUDIO_DIR = path.join(run, "data");

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
if (args.get("claude-config-dir")) {
  env.CLAUDE_CONFIG_DIR = path.resolve(args.get("claude-config-dir"));
  delete env.ANTHROPIC_API_KEY;
}
const log = (line) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
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
try {
  if (args.get("model") || args.get("effort")) {
    await host.invoke("pagestudio.settings", {
      ...(args.get("model") ? { bigModel: args.get("model") } : {}),
      ...(args.get("effort") ? { bigEffort: args.get("effort") } : {}),
    });
  }
  const settings = (await host.invoke("pagestudio.settings", {})).result;
  log(`page model ${settings.bigModel} at ${settings.bigEffort}, depth ${depth}`);
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
  fs.copyFileSync(htmlPath, path.join(run, "out", "index.html"));
  log(`rendered ${htmlPath}`);
  const chrome = process.env.PAGE_STUDIO_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const [name, width, height] of [
    ["mobile", 390, 4200],
    ["desktop", 1280, 3600],
  ]) {
    try {
      execFileSync(
        chrome,
        [
          "--headless=new",
          "--no-sandbox",
          "--hide-scrollbars",
          `--user-data-dir=${path.join(run, "state", "chrome-profile")}`,
          `--window-size=${width},${height}`,
          "--virtual-time-budget=8000",
          `--screenshot=${path.join(run, "out", "shots", `${name}.png`)}`,
          `file://${path.join(run, "out", "index.html")}`,
        ],
        { stdio: "ignore", timeout: 90_000 },
      );
    } catch (error) {
      log(`screenshot ${name} failed: ${error.message.slice(0, 200)}`);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${failure}`);
}

const sessions = host.sessions.list({ runId: host.runId });
const page = pageId ? (await host.invoke("pagestudio.page.get", { pageId }).catch(() => undefined))?.result : undefined;
const totals = sessions.reduce(
  (sum, session) => ({
    inputTokens: sum.inputTokens + session.usage.inputTokens,
    outputTokens: sum.outputTokens + session.usage.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + session.usage.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + session.usage.cacheWriteTokens,
    costUsd: sum.costUsd + session.usage.costUsd,
    turns: sum.turns + session.usage.turns,
  }),
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 },
);
const summary = {
  runId: host.runId,
  depth,
  idea,
  basedOn,
  pageId,
  sections: page?.sections?.map((section) => section.key) ?? [],
  wallSeconds: Math.round((Date.now() - started) / 100) / 10,
  error: failure ?? "",
  totals,
  sessions: sessions.map((session) => ({
    id: session.id,
    title: session.title,
    state: session.state,
    model: session.model,
    effort: session.reasoningEffort,
    nativeSessionId: session.native.sessionId,
    messages: session.messageCount,
    usage: session.usage,
  })),
};
fs.writeFileSync(path.join(run, "out", "summary.json"), JSON.stringify(summary, null, 2));
log(`${sessions.length} sessions, $${totals.costUsd.toFixed(2)} at list price, ${summary.wallSeconds}s; summary at ${path.join(run, "out", "summary.json")}`);
await host.dispose().catch(() => undefined);
process.exit(failure ? 1 : 0);
