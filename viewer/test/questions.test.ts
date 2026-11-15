import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startLinkServer } from "../../src/link/server";
import { FileSessionStore } from "../../src/session-store";
import { createExtension } from "../src/index";

const LINK_TOKEN = "viewer-questions-token-0123456789";
const OPTIONS = [{ title: "Keep the hero" }, { title: "Shorter hero" }];

/** A run whose session asked a question and recorded a decision (src/decisions.ts writes decisions.jsonl this way). */
function askingRun(runFolder: string, runId: string) {
  const store = new FileSessionStore(path.join(runFolder, "state", "sessions"), { runId, host: { id: "coder-1", kind: "container" } });
  const session = store.create({ title: "Page Studio · section hero", runtime: "claude", native: { kind: "claude", cwd: "/ws" } });
  const base = { runId, host: "coder-1", sessionId: session.id, sessionTitle: session.title, deliveries: [] };
  const question = { ...base, id: "question-1", kind: "question", text: "Which hero?", options: OPTIONS, recommendedIndex: 1, asked: true, createdAt: "2026-11-15T10:00:00.000Z", status: "open" };
  const decision = { ...base, id: "decision-1", kind: "decision", text: "Used the brand's green", createdAt: "2026-11-15T10:01:00.000Z", status: "recorded" };
  fs.writeFileSync(
    path.join(store.root, "decisions.jsonl"),
    [{ type: "entry", entry: question }, { type: "deliveries", id: "question-1", deliveries: [{ route: "link", delivered: true }] }, { type: "entry", entry: decision }]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return { store, session };
}

const invoke = async (extension: ReturnType<typeof createExtension>, name: string, input: Record<string, unknown>) =>
  ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;

test("a run's questions show on this Mac read-only, and a linked host takes the answer from this Marshal's person", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-questions-"));
  const { store, session } = askingRun(path.join(root, ".runs", "coder1"), "run-c");

  const local = createExtension({ configuration: { roots: [path.join(root, ".runs")] } });
  const listed = await invoke(local, "sdksessions.questions", { runId: "run-c" });
  assert.equal(listed.answers, false);
  assert.deepEqual(listed.decisions.map((entry: any) => [entry.id, entry.kind, entry.status]), [["question-1", "question", "open"], ["decision-1", "decision", "recorded"]]);
  assert.deepEqual((await invoke(local, "sdksessions.questions", { runId: "run-c", status: "open" })).decisions.map((entry: any) => entry.id), ["question-1"]);
  const refused = await invoke(local, "sdksessions.answer", { questionId: "question-1", choice: 0 });
  assert.deepEqual([refused.ok, refused.reason], [false, "read-only"]);

  // A live host's answer port, standing in for DecisionDesk.answer.
  const answers: any[] = [];
  const server = await startLinkServer({
    token: LINK_TOKEN,
    sessionsRoot: store.root,
    host: { id: "coder-1", kind: "container" },
    live: {
      send: () => ({}),
      cancel: () => ({}),
      invoke: async () => ({}),
      extensions: () => [],
      capabilities: async () => [],
      answer: async (input) => {
        if (answers.length) return { accepted: false, error: "This question is already answered." };
        answers.push(input);
        return { accepted: true, messageId: "answer-question-1" };
      },
    },
  });
  try {
    const linked = createExtension({
      configuration: { roots: [fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))], hosts: [{ id: "coder", name: "Coder", url: server.url, token: LINK_TOKEN }], person: { name: "Omer", personId: "user:omer@zyg.com" } },
    });
    const open = await invoke(linked, "sdksessions.questions", { hostId: "coder", runId: "run-c", kind: "question" });
    assert.equal(open.answers, true);
    assert.deepEqual(open.decisions.map((entry: any) => [entry.id, entry.sessionId, entry.options.length]), [["question-1", session.id, 2]]);

    const out = await invoke(linked, "sdksessions.answer", { hostId: "coder", questionId: "question-1", choice: 1 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(answers, [{ questionId: "question-1", choice: 1, by: { name: "Omer", personId: "user:omer@zyg.com" } }]);
    const again = await invoke(linked, "sdksessions.answer", { hostId: "coder", questionId: "question-1", text: "Keep it" });
    assert.deepEqual([again.ok, again.reason], [false, "not-accepted"]);
    assert.match(again.message, /already answered/);
    assert.deepEqual([(await invoke(linked, "sdksessions.answer", { hostId: "coder", questionId: "question-1" })).reason], ["invalid"]);
    assert.ok(!JSON.stringify(out).includes(LINK_TOKEN));
  } finally {
    await server.close();
  }
});
