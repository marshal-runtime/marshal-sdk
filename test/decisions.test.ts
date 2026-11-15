import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryFn } from "../src/agent-port.js";
import { FilePersonRoute, TestPersonRoute } from "../src/decisions.js";
import { createMarshalHost, type MarshalHost } from "../src/host.js";

/** Sessions act through their own `marshal` MCP server; `script` decides what each prompt does. */
function scripted(script: (prompt: string, call: (target: string, input: unknown) => Promise<any>) => Promise<string>): QueryFn {
  let count = 0;
  return ({ prompt, options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${++count}` };
      const tools = (options.mcpServers as any).marshal.instance._registeredTools;
      const call = async (target: string, input: unknown) => {
        const result = await tools.runtime_exec.handler({ targetType: "operation", target, input }, {});
        const response = JSON.parse(result.content[0].text);
        if (response.status !== "success") throw new Error(`${target}: ${JSON.stringify(response.error)}`);
        return response.result.output;
      };
      yield { type: "result", subtype: "success", is_error: false, result: await script(String(prompt), call), usage: {} };
    })();
}

function dirs() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-decisions-")));
  fs.mkdirSync(path.join(root, "workspace"));
  return { root, workspacePath: path.join(root, "workspace"), stateRoot: path.join(root, "state") };
}

const QUESTION = "Keep the old export format as a fallback?";

test("a session records a decision, a question and a gap, and asks a person; the answer comes back as a message from that person", async () => {
  const where = dirs();
  const route = new TestPersonRoute("whatsapp-test");
  const seen: Record<string, any> = {};
  const host = await createMarshalHost({
    workspacePath: where.workspacePath,
    stateRoot: where.stateRoot,
    browser: false,
    automations: { start: false },
    routes: [route],
    query: scripted(async (prompt, call) => {
      if (prompt !== "plan the export") return "noted";
      seen.decision = await call("marshal.tool.recordDecision", { kind: "decision", text: "Named the flag exportV2." });
      seen.gap = await call("marshal.tool.recordDecision", { kind: "gap", text: "Windows path not tested.", ref: "src/export.ts" });
      seen.question = await call("marshal.tool.recordDecision", {
        kind: "question",
        text: "Ship behind a flag?",
        defaultTaken: "Shipped behind the flag.",
        options: ["Keep the flag", "Remove it"],
      });
      seen.ask = await call("marshal.tool.askUser", {
        question: QUESTION,
        answers: [{ title: "Keep it" }, { title: "Remove it", description: "Drop the old path" }],
        recommendedIndex: 0,
      });
      seen.badRoute = await call("marshal.tool.askUser", { question: "x?", answers: [{ title: "a" }, { title: "b" }], to: ["nowhere"] });
      return "asked";
    }),
  });
  try {
    const session = host.agents.launch({ task: "plan the export", idempotencyKey: "s", name: "Export planner" });
    await host.agents.wait(session.id);

    assert.equal(seen.decision.success, true);
    assert.deepEqual(seen.ask.deliveries, [{ route: "whatsapp-test", delivered: true, ref: "test:4" }]);
    assert.match(seen.ask.note, /end your turn/);
    assert.deepEqual(seen.badRoute, { success: false, error: "No route nowhere on this host." });
    assert.deepEqual(route.sent.map((entry) => entry.kind), ["decision", "gap", "question", "question"]);
    const asked = route.sent[3]!;
    assert.equal(asked.asked, true);
    assert.equal(asked.sessionTitle, "Export planner");
    assert.equal(asked.runId, host.runId);
    assert.deepEqual(asked.options, [{ title: "Keep it" }, { title: "Remove it", description: "Drop the old path" }]);

    const record = host.decisions.list({ sessionId: session.id });
    assert.deepEqual(record.map((entry) => [entry.kind, entry.status]), [
      ["decision", "recorded"],
      ["gap", "recorded"],
      ["question", "open"],
      ["question", "open"],
    ]);
    assert.equal(record[2]!.defaultTaken, "Shipped behind the flag.");
    // Stored with the run, beside its sessions.
    assert.ok(fs.readFileSync(path.join(host.sessions.root, "decisions.jsonl"), "utf8").includes(QUESTION));

    const answered = await route.answer(seen.ask.questionId, { choice: 1, by: { name: "Omer", personId: "+972500000000" } });
    assert.equal(answered.accepted, true);
    await host.agents.wait(session.id);
    const message = host.sessions.messages(session.id).find((item) => item.from?.kind === "person")!;
    assert.equal(message.content, `Message from Omer:\n\nAnswer to your question "${QUESTION}" (${seen.ask.questionId}): Remove it`);
    assert.deepEqual(message.from, { kind: "person", name: "Omer", personId: "+972500000000" });
    const stored = host.decisions.get(seen.ask.questionId)!;
    assert.equal(stored.status, "answered");
    assert.deepEqual([stored.answer!.choice, stored.answer!.text, stored.answer!.route], [1, "Remove it", "whatsapp-test"]);

    assert.match((await route.answer(seen.ask.questionId, { choice: 0 })).error!, /already answered/);
    assert.match((await route.answer(seen.decision.id, { text: "ok" })).error!, /No question/);
    assert.match((await route.answer(seen.question.id, { choice: 7 })).error!, /does not exist/);

    const listed = await host.invoke<any>("marshal.decisions.list", { status: "open" });
    assert.deepEqual(listed.entries.map((entry: any) => entry.id), [seen.question.id]);
  } finally {
    await host.dispose();
  }
});

test("the file route: entries land in outbox/, an answer file in inbox/ is read, delivered and moved to done/", async () => {
  const where = dirs();
  const folder = path.join(where.root, "person");
  const route = new FilePersonRoute(folder, { pollMs: 0 });
  let questionId = "";
  const host = await createMarshalHost({
    workspacePath: where.workspacePath,
    stateRoot: where.stateRoot,
    browser: false,
    automations: { start: false },
    routes: [route],
    query: scripted(async (prompt, call) => {
      if (prompt === "ask") questionId = (await call("marshal.tool.askUser", { question: "Which hero?", answers: [{ title: "A" }, { title: "B" }] })).questionId;
      return "ok";
    }),
  });
  try {
    const session = host.agents.launch({ task: "ask", idempotencyKey: "f" });
    await host.agents.wait(session.id);
    const outbox = JSON.parse(fs.readFileSync(path.join(folder, "outbox", `${questionId}.json`), "utf8"));
    assert.equal(outbox.text, "Which hero?");
    fs.writeFileSync(path.join(folder, "inbox", "reply.json"), JSON.stringify({ questionId, choice: 0, text: "the bold one", by: { name: "Gal" } }));
    const polled = await route.poll();
    assert.deepEqual(polled.map((item) => [item.file, item.result.accepted]), [["reply.json", true]]);
    assert.ok(fs.existsSync(path.join(folder, "inbox", "done", "reply.json")));
    await host.agents.wait(session.id);
    assert.equal(
      host.sessions.messages(session.id).at(-2)!.content,
      `Message from Gal:\n\nAnswer to your question "Which hero?" (${questionId}): A (the bold one)`,
    );
    fs.writeFileSync(path.join(folder, "inbox", "junk.json"), "{}");
    assert.equal((await route.poll())[0]!.result.accepted, false);
  } finally {
    await host.dispose();
  }
});

test("an open question survives a host restart, and an answer through marshal.decisions.answer reaches the stored session", async () => {
  const where = dirs();
  let questionId = "";
  const first: MarshalHost = await createMarshalHost({
    workspacePath: where.workspacePath,
    stateRoot: where.stateRoot,
    browser: false,
    automations: { start: false },
    query: scripted(async (prompt, call) => {
      if (prompt === "ask") questionId = (await call("marshal.tool.askUser", { question: "Deploy now?", answers: [{ title: "Yes" }, { title: "Later" }] })).questionId;
      return "ok";
    }),
  });
  const session = first.agents.launch({ task: "ask", idempotencyKey: "r" });
  await first.agents.wait(session.id);
  assert.equal(first.decisions.get(questionId)!.deliveries.length, 0, "no routes: recorded, not delivered");
  await first.dispose();

  const prompts: string[] = [];
  const second = await createMarshalHost({
    workspacePath: where.workspacePath,
    stateRoot: where.stateRoot,
    browser: false,
    automations: { start: false },
    query: scripted(async (prompt) => {
      prompts.push(prompt);
      return "thanks";
    }),
  });
  try {
    assert.equal(second.decisions.get(questionId)!.status, "open");
    const answered = await second.invoke<any>("marshal.decisions.answer", { questionId, choice: 1, by: { name: "Omer" }, route: "marshal-desktop" });
    assert.equal(answered.accepted, true);
    await second.agents.wait(session.id);
    assert.deepEqual(prompts, [`Message from Omer:\n\nAnswer to your question "Deploy now?" (${questionId}): Later`]);
    assert.equal(second.decisions.get(questionId)!.answer!.route, "marshal-desktop");
  } finally {
    await second.dispose();
  }
});
