import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { FileSessionStore } from "../src/session-store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("streamed deltas keep a session's activity time moving without becoming events, transcript or usage", async () => {
  let options: Record<string | symbol, any> | undefined;
  const steps: Array<() => void> = [];
  const next = () => new Promise<void>((resolve) => steps.push(resolve));
  const query: QueryFn = (input) =>
    (async function* () {
      options = input.options;
      yield { type: "system", subtype: "init", session_id: "native-1" };
      await next();
      for (let index = 0; index < 20; index += 1) yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "x" } } };
      await next();
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "y" } } };
      await next();
      yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 3, output_tokens: 4 } };
    })();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-stream-activity-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  const port = new ClaudeAgentPort({ query, store, cwd: root, env: {}, defaultModel: "m", systemPrompt: () => "P", mcpServers: () => ({}) });
  const { id } = port.launch({ task: "write", idempotencyKey: "w" });
  const release = async () => {
    while (!steps.length) await sleep(5);
    steps.shift()!();
  };
  while (store.activity(id).eventCount < 1) await sleep(5);
  assert.equal(options!.includePartialMessages, true, "the query asks for partial messages");
  const quiet = store.activity(id);

  await release(); // 20 deltas in a burst
  await sleep(50);
  const burst = store.activity(id);
  assert.ok(burst.lastEventAt! > quiet.lastEventAt!, "a delta moves lastEventAt");
  assert.equal(burst.eventCount, quiet.eventCount, "a delta is not an event");
  await sleep(100);
  assert.equal(store.activity(id).lastEventAt, burst.lastEventAt, "a burst of deltas touches at most once a second");

  await sleep(1100);
  await release(); // one more delta, a second later
  await sleep(50);
  const later = store.activity(id);
  assert.ok(later.lastEventAt! > burst.lastEventAt!, "a later delta moves it again");
  assert.equal(later.eventCount, quiet.eventCount);

  await release();
  await port.wait(id);
  const events = store.events(id).map((row) => (row.event as { type: string }).type);
  assert.deepEqual(events, ["system", "assistant", "result"], "no stream events in events.jsonl");
  const session = store.get(id)!;
  assert.equal(session.usage.inputTokens, 3);
  assert.equal(session.usage.outputTokens, 4);
  assert.deepEqual(store.messages(id).map((m) => [m.role, m.content]), [["user", "write"], ["assistant", "done"]]);
});
