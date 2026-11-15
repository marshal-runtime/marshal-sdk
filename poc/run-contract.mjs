// The run logs agent-sandbox's claude_page_agent writes, from a marshal-sdk session store. The implementation
// is src/run-contract.ts; this file keeps the POC's call shape ({settings}) and its replay command.
//
// Replay an existing store into the layout without a model:
//   node poc/run-contract.mjs <state dir> <log dir> [run id]
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeRunLogs as write } from "../dist/src/run-contract.js";

export function writeRunLogs({ settings = {}, ...rest }) {
  return write({ ...rest, model: settings.bigModel, effort: settings.bigEffort });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateDir, logDir, runId] = process.argv.slice(2);
  if (!stateDir || !logDir) throw new Error("usage: node poc/run-contract.mjs <state dir> <log dir> [run id]");
  const { FileSessionStore } = await import("../dist/src/index.js");
  const storeRoot = path.join(path.resolve(stateDir), "sessions");
  const store = new FileSessionStore(storeRoot, { runId: "replay", host: { id: "replay", kind: "local" } });
  const sessions = store.list(runId ? { runId } : {});
  const finished = Math.max(...sessions.map((session) => Date.parse(session.updatedAt)));
  const summary = write({ logDir: path.resolve(logDir), storeRoot, sessions, finished, marshal: { runId: runId ?? sessions[0]?.runId } });
  process.stdout.write(
    `${sessions.length} sessions -> run.jsonl ${Object.values(summary.message_counts).reduce((sum, count) => sum + count, 0)} rows, ${summary.results.length} results, $${summary.totals?.total_cost_usd}\n`,
  );
}
