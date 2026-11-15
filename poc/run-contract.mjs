// The run logs agent-sandbox's claude_page_agent writes (agent_run.py RunRecorder/RunSummary, run_log.py),
// assembled from a marshal-sdk session store: one run is many Marshal sessions, each with its SDK events.
//
//   writeRunLogs({ logDir, storeRoot, sessions, settings, started, error, marshal }) -> summary
//
// Replay an existing store into the layout without a model:
//   node poc/run-contract.mjs <state dir> <log dir> [run id]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function writeRunLogs({ logDir, storeRoot, sessions, settings = {}, started, finished = Date.now(), error = "", marshal = {} }) {
  fs.mkdirSync(logDir, { recursive: true });
  const events = runEvents(storeRoot, sessions);
  fs.writeFileSync(path.join(logDir, "run.jsonl"), events.map((row) => JSON.stringify(row)).join("\n") + (events.length ? "\n" : ""));
  const results = events.filter((row) => row.type === "result").map(runResult);
  const messageCounts = {};
  for (const row of events) messageCounts[row.type] = (messageCounts[row.type] ?? 0) + 1;
  const skills = [...new Set(events.filter((row) => row.type === "system" && row.subtype === "init").flatMap((row) => row.skills ?? []))];
  const usage = sessions.reduce(
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
  const startedAt = started ?? Math.min(...sessions.map((session) => Date.parse(session.createdAt)));
  const summary = {
    // agent_run.py RunSummary
    model: settings.bigModel ?? "",
    effort: settings.bigEffort ?? "",
    wall_seconds: Math.round((finished - startedAt) / 100) / 10,
    skills,
    skills_required: [],
    skills_used: [],
    skills_missing: [],
    subagent_skills_used: [],
    launch_issues: [],
    message_counts: messageCounts,
    results,
    totals: results.length
      ? {
          results: results.length,
          subtype: error ? "error" : "success",
          is_error: Boolean(error) || results.some((result) => result.is_error),
          num_turns: results.reduce((sum, result) => sum + result.num_turns, 0),
          duration_ms: finished - startedAt,
          duration_api_ms: results.reduce((sum, result) => sum + result.duration_api_ms, 0),
          // Sessions run in parallel and each reports its own running cost, so the run's cost is their sum.
          total_cost_usd: Math.round(usage.costUsd * 1e6) / 1e6,
        }
      : null,
    error,
    // Marshal: the run is many sessions, each one a Marshal session in the host's store.
    marshal: {
      ...marshal,
      usage,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        parentId: session.parentId,
        state: session.state,
        model: session.model,
        effort: session.reasoningEffort,
        nativeSessionId: session.native.sessionId,
        messages: session.messageCount,
        usage: session.usage,
      })),
    },
  };
  fs.writeFileSync(path.join(logDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

/** Every session's SDK messages as run.jsonl rows ({type, at, session, ...message}), oldest first. */
function runEvents(storeRoot, sessions) {
  const rows = [];
  for (const session of sessions) {
    const file = path.join(storeRoot, session.id, "events.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      const event = entry.event ?? {};
      rows.push({ ...event, type: event.type ?? "unknown", at: Date.parse(entry.at) / 1000, session: session.id, seq: entry.seq });
    }
  }
  return rows.sort((left, right) => left.at - right.at || left.seq - right.seq);
}

function runResult(row) {
  return {
    subtype: row.subtype ?? "",
    is_error: Boolean(row.is_error),
    num_turns: row.num_turns ?? 0,
    duration_ms: row.duration_ms ?? 0,
    duration_api_ms: row.duration_api_ms ?? 0,
    total_cost_usd: row.total_cost_usd ?? null,
    usage: row.usage ?? null,
    model_usage: row.modelUsage ?? row.model_usage ?? null,
    stop_reason: row.stop_reason ?? null,
    terminal_reason: row.terminal_reason ?? null,
    origin_kind: row.origin?.kind ?? null,
    final_text: row.result ?? null,
    session: row.session,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateDir, logDir, runId] = process.argv.slice(2);
  if (!stateDir || !logDir) throw new Error("usage: node poc/run-contract.mjs <state dir> <log dir> [run id]");
  const { FileSessionStore } = await import("../dist/src/index.js");
  const storeRoot = path.join(path.resolve(stateDir), "sessions");
  const store = new FileSessionStore(storeRoot, { runId: "replay", host: { id: "replay", kind: "local" } });
  const sessions = store.list(runId ? { runId } : {});
  const finished = Math.max(...sessions.map((session) => Date.parse(session.updatedAt)));
  const summary = writeRunLogs({ logDir: path.resolve(logDir), storeRoot, sessions, finished, marshal: { runId: runId ?? sessions[0]?.runId } });
  process.stdout.write(
    `${sessions.length} sessions -> run.jsonl ${Object.values(summary.message_counts).reduce((sum, count) => sum + count, 0)} rows, ${summary.results.length} results, $${summary.totals?.total_cost_usd}\n`,
  );
}
