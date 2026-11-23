import { errorMessage, type Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import { shellQuote } from "../../sandbox/ssh.js";

/** What the reindex and the follow-up mirror need from a brand's machine: a command runner. `BrandVm` fits. */
export interface ReindexVm {
  run(command: string, options?: { stdin?: string | Buffer; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string; raw: Buffer }>;
}

export interface ReindexResult {
  ok: boolean;
  ms: number;
  error?: string;
}

const NODE_BIN = "/usr/local/bin/node";
const TIMEOUT_MS = 90_000;
const SCRIPT_MARGIN_MS = 10_000;

/**
 * Runs on the VM as the brand user. It starts the brand's `marshal` MCP server exactly as the brand's Claude config says (the
 * way the sandbox's runtime check does), calls the runtime operation `zs.repo.reindex` once and prints one JSON line. The
 * Quillstone index lives on disk under the brand home, so every later session sees the result.
 *
 * The server and what it starts (its schema proxy, and the private-index lease helper, which holds a lock for as long as it
 * lives) run in a process group of their own. Every way out of the script stops that whole group first: the normal end, an
 * error, a missing config, the timeout, a signal, and any crash (the exit hook). A server left running would keep the lease
 * and make every later reindex fail with "Private index is busy".
 */
const SCRIPT = `
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const home = process.argv[2];
const started = Date.now();
let child;
let finishing = false;
const killGroup = (signal) => { try { if (child?.pid) process.kill(-child.pid, signal); } catch {} };
const groupGone = () => { try { process.kill(-child.pid, 0); return false; } catch { return true; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopGroup = async () => {
  if (!child?.pid) return;
  killGroup("SIGTERM");
  for (let waited = 0; waited < 2000 && !groupGone(); waited += 50) await pause(50);
  killGroup("SIGKILL");
};
process.on("exit", () => killGroup("SIGKILL"));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(1));
const done = async (value) => {
  if (finishing) return new Promise(() => {});
  finishing = true;
  process.stdout.write(JSON.stringify({ ms: Date.now() - started, ...value }) + "\\n");
  await stopGroup();
  process.exit(0);
};
let entry;
try { entry = JSON.parse(readFileSync(path.join(home, ".claude", ".claude.json"), "utf8")).mcpServers?.marshal; } catch (error) { await done({ ok: false, error: "cannot read the Claude config: " + error.message }); }
if (!entry?.command) await done({ ok: false, error: "the Claude config has no marshal server" });
child = spawn(entry.command, entry.args ?? [], { cwd: path.join(home, "work"), env: entry.env ?? {}, stdio: ["pipe", "pipe", "pipe"], detached: true });
let stderr = "", buffer = "", counter = 0;
const waiting = new Map();
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1500); });
child.stdin.on("error", () => {});
const fail = (message) => { for (const resolve of waiting.values()) resolve({ error: { message } }); waiting.clear(); };
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    try { const message = JSON.parse(line); if (message.id !== undefined) waiting.get(message.id)?.(message); } catch {}
  }
});
child.on("close", (code) => fail("the marshal server exited (" + code + "): " + (stderr.trim().split("\\n").pop() ?? "")));
child.on("error", (error) => fail("cannot start the marshal server: " + error.message));
const call = (method, params) => new Promise((resolve) => { const id = ++counter; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
const timer = setTimeout(() => { void done({ ok: false, error: "timed out" }); }, Number(process.argv[3]));
try {
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "zs-brand-reindex", version: "1" } });
  if (init.error) await done({ ok: false, error: init.error.message });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  const run = await call("tools/call", { name: "runtime_exec", arguments: { targetType: "operation", target: "zs.repo.reindex", input: {} } });
  const text = JSON.stringify(run.result ?? run.error);
  if (run.error || run.result?.isError) await done({ ok: false, error: text.slice(0, 400) });
  await done({ ok: true });
} catch (error) {
  await done({ ok: false, error: String(error?.message ?? error).slice(0, 400) });
} finally {
  clearTimeout(timer);
}
`;

/** Rebuilds the Quillstone index of the brand repo on the VM, so `knowledge.search` finds what was just published. Never throws. */
export async function reindexBrandRepo(vm: ReindexVm, brandHome: string, nodeBin: string = NODE_BIN, timeoutMs: number = TIMEOUT_MS): Promise<ReindexResult> {
  const started = Date.now();
  try {
    const result = await vm.run(`${shellQuote(nodeBin)} --input-type=module - ${shellQuote(brandHome)} ${Math.max(timeoutMs - SCRIPT_MARGIN_MS, 1_000)}`, { stdin: SCRIPT, timeoutMs });
    const line = result.stdout.trim().split("\n").pop() ?? "";
    let parsed: { ok?: boolean; error?: string } = {};
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return { ok: false, ms: Date.now() - started, error: `no answer from the VM (exit ${result.code}): ${(result.stderr || line).trim().slice(0, 200)}` };
    }
    return parsed.ok ? { ok: true, ms: Date.now() - started } : { ok: false, ms: Date.now() - started, error: String(parsed.error ?? "unknown").slice(0, 400) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: errorMessage(error) };
  }
}

/** The reindex script's own failure text (the runtime's error, never a query or a document), on one line and short, so a log line says why. */
const boundedError = (error: string | undefined): string => (error ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

export interface AfterGraphPublishDeps {
  /** The brand's machine. */
  vmOf: (brandId: string) => Promise<ReindexVm>;
  /** The brand home on its VM (`/srv/zygstinct/brands/<id>` by default). */
  homeOf: (brandId: string) => string;
  /** The GitHub mirror (`createBrandMirror`). */
  mirror: (brandId: string, vm: ReindexVm) => Promise<unknown>;
  logger: Logger;
  nodeBin?: string;
}

/**
 * What runs after a graph publish changed the repo: reindex the repo in Quillstone on the VM, then push the repo to GitHub.
 * Each step is independent and a failure of either is logged, never thrown, so the ingest still counts as done.
 */
export function afterGraphPublish(deps: AfterGraphPublishDeps): (brandId: string) => Promise<void> {
  return async (brandId) => {
    let vm: ReindexVm;
    try {
      vm = await deps.vmOf(brandId);
    } catch (error) {
      deps.logger.warn("brand_graph.after_publish_failed", { brandId, step: "vm", ...failureFields(error) });
      return;
    }
    const reindexed = await reindexBrandRepo(vm, deps.homeOf(brandId), deps.nodeBin);
    if (reindexed.ok) deps.logger.info("brand_graph.reindexed", { brandId, ms: reindexed.ms });
    else deps.logger.warn("brand_graph.reindex_failed", { brandId, ms: reindexed.ms, operation: "repo_reindex", exitCode: null, errorClass: "OperationError", error: boundedError(reindexed.error) });
    try {
      await deps.mirror(brandId, vm);
    } catch (error) {
      deps.logger.warn("brand_graph.after_publish_failed", { brandId, step: "mirror", ...failureFields(error) });
    }
  };
}
