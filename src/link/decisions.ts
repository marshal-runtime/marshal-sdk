// Decisions, questions and gaps of a host's sessions over the link (src/decisions.ts keeps them in
// <sessions root>/decisions.jsonl). Read from the file, so a store-only host serves them too; answering needs a live host.
import fs from "node:fs";
import path from "node:path";

import type { DecisionAnswer, DecisionEntry, PersonRoute } from "../decisions.js";

export const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface DecisionFilter {
  kind?: string;
  status?: string;
  runId?: string;
  sessionId?: string;
}

/** The record as `DecisionDesk` folds it: entries, then their deliveries and first answer. */
export function readDecisions(sessionsRoot: string, filter: DecisionFilter = {}): DecisionEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(sessionsRoot, "decisions.jsonl"), "utf8");
  } catch {
    return [];
  }
  const entries = new Map<string, DecisionEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { type?: string; entry?: DecisionEntry; id?: string; answer?: DecisionAnswer; deliveries?: DecisionEntry["deliveries"] };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.type === "entry" && parsed.entry?.id) entries.set(parsed.entry.id, parsed.entry);
    const known = parsed.id ? entries.get(parsed.id) : undefined;
    if (!known) continue;
    if (parsed.type === "answer" && parsed.answer) entries.set(known.id, { ...known, status: "answered", answer: parsed.answer });
    if (parsed.type === "deliveries" && Array.isArray(parsed.deliveries)) entries.set(known.id, { ...known, deliveries: parsed.deliveries });
  }
  return [...entries.values()]
    .filter(
      (entry) =>
        (!filter.kind || entry.kind === filter.kind) &&
        (!filter.status || entry.status === filter.status) &&
        (!filter.runId || entry.runId === filter.runId) &&
        (!filter.sessionId || entry.sessionId === filter.sessionId),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The route a linked Marshal answers on: every entry is posted on the link (`GET /v1/decisions`), and an answer comes
 * back as `POST /v1/decisions/:id/answer`, which the host passes to `DecisionDesk.answer` with route `link`.
 */
export function linkPersonRoute(linkUrl: string): PersonRoute {
  return {
    id: "link",
    deliver: async (entry) => ({ delivered: true, ref: `${linkUrl}/v1/decisions/${entry.id}` }),
  };
}
