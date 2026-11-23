// Loads the packed kit (node_modules/@marshal/agent-kit, extracted from .pack) and runs one outbox moment on a fresh SQLite file:
// a turn's words are buffered, the flush asks a scripted composer, and the send the host gave the outbox is called.
//   node extensions/agent-kit/scripts/smoke.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { composer, outbox, outboxStore } from "@marshal/agent-kit";

const db = new Database(join(mkdtempSync(join(tmpdir(), "agent-kit-smoke-")), "kit.db"));
const key = { brandId: "zyg", channel: "slack", conversationId: "D0SMOKE" };
const log = { debug() {}, info() {}, warn: (event, fields) => console.log("warn", event, JSON.stringify(fields ?? {})), error: (event, fields) => console.log("error", event, JSON.stringify(fields ?? {})) };
const scripted = new composer.FakeComposer((context) => ({ invalid: true, material: context.material.length }));
const box = new outbox.Outbox({
  store: new outboxStore.OutboxStore(db),
  composer: scripted,
  brands: new Set(["zyg"]),
  messages: { recentMessages: () => [], getMessage: () => null, recentOutbound: () => [] },
  logger: log,
  answerBudgetMs: 3_000,
  retryMinMs: 500,
});
box.buffer({ key: "turn-1:0", conversation: key, memberId: "U1", turnId: "turn-1", kind: "text", text: "The deploy finished green at 15:20.", lang: "en", voiceName: null, origin: "front", answersMessageId: "m1", checked: true, pendingIds: ["m1"], at: Date.now() });
const sent = [];
const result = await box.flush(key, () => "Asia/Jerusalem", async (part, idempotencyKey, origin) => { sent.push({ part, idempotencyKey, origin }); return "sent"; });
console.log(JSON.stringify({ composerCalls: scripted.calls.length, actions: result.actions, sent: result.sent, parts: sent.map((entry) => ({ kind: entry.part.kind, text: entry.part.text, key: entry.idempotencyKey })) }, null, 2));
if (result.sent !== 1 || sent.length !== 1) process.exit(1);
