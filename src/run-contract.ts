// The run logs agent-sandbox's claude_page_agent writes (agent_run.py RunRecorder/RunSummary, run_log.py),
// assembled from a marshal-sdk session store: one run is many Marshal sessions, each with its SDK events.
import fs from "node:fs";
import path from "node:path";

import type { SessionRecord, SessionUsage } from "./session-store.js";

/**
 * The sessions one turn on a reopened state used: the ones this host run made, plus earlier sessions it resumed
 * (Page Studio keeps one fast-hands session per page), each with only the usage it added during the turn.
 * `before` is every session's usage when the host opened the state.
 */
export function turnSessions(
  sessions: readonly SessionRecord[],
  before: ReadonlyMap<string, SessionUsage>,
  runId: string,
  started: number,
): SessionRecord[] {
  return sessions
    .filter((session) => session.runId === runId || Date.parse(session.updatedAt) >= started)
    .map((session) => {
      const earlier = before.get(session.id);
      if (!earlier) return session;
      const usage: SessionUsage = {
        inputTokens: session.usage.inputTokens - earlier.inputTokens,
        outputTokens: session.usage.outputTokens - earlier.outputTokens,
        cacheReadTokens: session.usage.cacheReadTokens - earlier.cacheReadTokens,
        cacheWriteTokens: session.usage.cacheWriteTokens - earlier.cacheWriteTokens,
        costUsd: session.usage.costUsd - earlier.costUsd,
        turns: session.usage.turns - earlier.turns,
        ...(session.usage.modelTurns !== undefined ? { modelTurns: session.usage.modelTurns - (earlier.modelTurns ?? 0) } : {}),
      };
      return { ...session, usage };
    })
    .filter((session) => session.runId === runId || session.usage.turns > 0 || session.usage.costUsd > 0);
}

export interface RunLogsInput {
  logDir: string;
  /** The session store's root (<state>/sessions): each session's events.jsonl sits under <root>/<id>/. */
  storeRoot: string;
  sessions: readonly SessionRecord[];
  model?: string;
  effort?: string;
  started?: number;
  finished?: number;
  /** Only events from this time on (ms): a resumed session's earlier turns belong to earlier runs. */
  since?: number;
  error?: string;
  /** Skills the caller's manifest requires; the ones no session called land in skills_missing. */
  requiredSkills?: readonly string[];
  launchIssues?: readonly string[];
  marshal?: Record<string, unknown>;
}

export interface RunLogRow {
  type: string;
  at: number;
  session: string;
  seq: number;
  [key: string]: unknown;
}

export interface RunSummaryJson {
  model: string;
  effort: string;
  wall_seconds: number;
  skills: string[];
  skills_required: string[];
  skills_used: string[];
  skills_missing: string[];
  subagent_skills_used: string[];
  launch_issues: string[];
  message_counts: Record<string, number>;
  results: Record<string, unknown>[];
  totals: Record<string, unknown> | null;
  error: string;
  marshal: Record<string, unknown>;
}

/** Writes run.jsonl and summary.json in agent-sandbox's layout and returns the summary. */
export function writeRunLogs(input: RunLogsInput): RunSummaryJson {
  const { logDir, storeRoot, sessions } = input;
  const finished = input.finished ?? Date.now();
  const error = input.error ?? "";
  fs.mkdirSync(logDir, { recursive: true });
  const events = runEvents(storeRoot, sessions, input.since);
  fs.writeFileSync(path.join(logDir, "run.jsonl"), events.map((row) => JSON.stringify(row)).join("\n") + (events.length ? "\n" : ""));
  const results = events.filter((row) => row.type === "result").map(runResult);
  const messageCounts: Record<string, number> = {};
  for (const row of events) messageCounts[row.type] = (messageCounts[row.type] ?? 0) + 1;
  const skills = [
    ...new Set(events.filter((row) => row.type === "system" && row.subtype === "init").flatMap((row) => (Array.isArray(row.skills) ? row.skills.map(String) : []))),
  ];
  const used = skillCalls(events, false);
  const subagentUsed = skillCalls(events, true);
  const required = [...(input.requiredSkills ?? [])];
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
  const startedAt = input.started ?? Math.min(finished, ...sessions.map((session) => Date.parse(session.createdAt)));
  const summary: RunSummaryJson = {
    model: input.model ?? "",
    effort: input.effort ?? "",
    wall_seconds: Math.round((finished - startedAt) / 100) / 10,
    skills,
    skills_required: required,
    skills_used: used,
    skills_missing: required.filter((name) => !used.includes(name)),
    subagent_skills_used: subagentUsed,
    launch_issues: [...(input.launchIssues ?? [])],
    message_counts: messageCounts,
    results,
    totals: results.length
      ? {
          results: results.length,
          subtype: error ? "error" : "success",
          is_error: Boolean(error) || results.some((result) => result.is_error),
          num_turns: results.reduce((sum, result) => sum + Number(result.num_turns), 0),
          duration_ms: finished - startedAt,
          duration_api_ms: results.reduce((sum, result) => sum + Number(result.duration_api_ms), 0),
          // Sessions run in parallel and each reports its own running cost, so the run's cost is their sum.
          total_cost_usd: Math.round(usage.costUsd * 1e6) / 1e6,
        }
      : null,
    error,
    marshal: {
      ...input.marshal,
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

/** Every session's SDK messages as run.jsonl rows ({...message, type, at, session, seq}), oldest first. */
export function runEvents(storeRoot: string, sessions: readonly SessionRecord[], since?: number): RunLogRow[] {
  const rows: RunLogRow[] = [];
  for (const session of sessions) {
    const file = path.join(storeRoot, session.id, "events.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { seq?: number; at?: string; event?: Record<string, unknown> };
      const event = entry.event ?? {};
      rows.push({
        ...event,
        type: typeof event.type === "string" ? event.type : "unknown",
        at: Date.parse(String(entry.at)) / 1000,
        session: session.id,
        seq: entry.seq ?? 0,
      });
    }
  }
  const kept = since === undefined ? rows : rows.filter((row) => row.at * 1000 >= since);
  return kept.sort((left, right) => left.at - right.at || left.seq - right.seq);
}

/** Skill tool calls in assistant messages: the session's own (subagents false) or its subagents'. */
function skillCalls(events: readonly RunLogRow[], subagents: boolean): string[] {
  const names = new Set<string>();
  for (const row of events) {
    if (row.type !== "assistant" || Boolean(row.parent_tool_use_id) !== subagents) continue;
    const content = (row.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, any>[]) {
      if (block?.type === "tool_use" && block.name === "Skill" && typeof block.input?.skill === "string") names.add(block.input.skill);
    }
  }
  return [...names];
}

function runResult(row: RunLogRow): Record<string, unknown> {
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
    origin_kind: (row.origin as { kind?: string } | undefined)?.kind ?? null,
    final_text: row.result ?? null,
    session: row.session,
  };
}
