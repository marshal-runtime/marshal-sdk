import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { FileSessionStore } from "../src/session-store.js";

interface Call {
  prompt: unknown;
  options: Record<string, any>;
}

/** A backend that answers `reply(prompt)` after `delayMs`, and stops when its turn is aborted. */
function fakeBackend(reply: (text: string) => string, delayMs = 0): { query: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  let sessions = 0;
  const query: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      const sessionId = (options.resume as string | undefined) ?? `native-${++sessions}`;
      yield { type: "system", subtype: "init", session_id: sessionId };
      const text = typeof prompt === "string" ? prompt : "pictures";
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          (options.abortController as AbortController).signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
      const answer = reply(text);
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: answer }] } };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: answer,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
      };
    })();
  };
  return { query, calls };
}

function portWith(backend: { query: QueryFn }): { port: ClaudeAgentPort; store: FileSessionStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-test-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  const port = new ClaudeAgentPort({
    query: backend.query,
    store,
    cwd: root,
    env: { CLAUDE_CONFIG_DIR: "/accounts/test" },
    defaultModel: "test-model",
    systemPrompt: () => "You are a Marshal agent.",
    mcpServers: () => ({}),
  });
  return { port, store, root };
}

test("a running turn's transcript shows the backend working: eventCount grows and lastEventAt moves (Page Studio big edit)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const query: QueryFn = () =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "native-busy" };
      yield { type: "system", subtype: "thinking_tokens", estimated_tokens: 100 };
      await gate;
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "done", usage: {} };
    })();
  const { port } = portWith({ query });
  const agent = port.launch({ task: "edit the big page", idempotencyKey: "busy" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const working = port.transcript(agent.id, 1).agent;
  assert.equal(working.state, "running");
  assert.equal(working.eventCount, 2);
  assert.ok(working.lastEventAt && Date.parse(working.lastEventAt) <= Date.now());
  release();
  await port.wait(agent.id);
  const done = port.transcript(agent.id, 1).agent;
  assert.equal(done.eventCount, 4);
  assert.ok(Date.parse(done.lastEventAt!) >= Date.parse(working.lastEventAt!));
});

test("a turn ends at its result even when the backend's stream never closes (c2-real-2 hero, 900008 critic)", async () => {
  let returned = 0;
  let nextAfterResult = 0;
  const query: QueryFn = () => {
    const events: unknown[] = [
      { type: "system", subtype: "init", session_id: "native-stuck" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "<section>hero</section>" }] } },
      { type: "result", subtype: "success", is_error: false, result: "<section>hero</section>", total_cost_usd: 1.49, usage: { input_tokens: 56, output_tokens: 37709 } },
    ];
    const iterator: AsyncIterator<any> = {
      next: () => {
        const value = events.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        nextAfterResult++;
        return new Promise(() => {});
      },
      return: () => {
        returned++;
        return new Promise(() => {});
      },
    };
    return { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<any>;
  };
  const { port } = portWith({ query });
  const agent = port.launch({ task: "write the hero", idempotencyKey: "stuck" });
  const waited = await Promise.race([
    port.wait(agent.id),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the turn never finished")), 2000)),
  ]);
  assert.equal(waited.state, "completed");
  assert.equal(waited.result, "<section>hero</section>");
  const transcript = port.transcript(agent.id, 1);
  assert.equal(transcript.agent.state, "idle");
  assert.equal(transcript.messageCount, 2);
  assert.equal(transcript.messages.at(-1)?.role, "assistant");
  assert.equal(nextAfterResult, 0, "nothing is read after the result");
  assert.equal(returned, 1, "the stream is asked to close");
});

test("a launch is a Marshal session: one user and one assistant message, idle, with its native session id", async () => {
  const backend = fakeBackend((text) => `echo: ${text}`);
  const { port, store } = portWith(backend);
  const agent = port.launch({ task: "say hi", idempotencyKey: "k1", name: "Greeter", labels: { extension: "@zyg/page-studio" } });
  assert.equal(agent.state, "running");
  const waited = await port.wait(agent.id);
  assert.equal(waited.state, "completed");
  assert.equal(waited.result, "echo: say hi");
  const transcript = port.transcript(agent.id, 1);
  assert.equal(transcript.agent.state, "idle");
  assert.equal(transcript.messageCount, 2);
  assert.equal(transcript.messages.at(-1)?.role, "assistant");
  assert.equal(transcript.result, "echo: say hi");
  const record = store.get(agent.id)!;
  assert.equal(record.native.sessionId, "native-1");
  assert.equal(record.native.configDir, "/accounts/test");
  assert.equal(record.runId, "run-1");
  assert.equal(record.labels.extension, "@zyg/page-studio");
  assert.deepEqual(record.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7, costUsd: 0.01, turns: 1, modelTurns: 0 });
  assert.deepEqual(backend.calls[0]!.options.systemPrompt, { type: "custom", prompt: "You are a Marshal agent.", snapshot: false });
  assert.equal(backend.calls[0]!.options.permissionMode, "bypassPermissions");
  assert.equal(backend.calls[0]!.options.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "1");
});

test("a host that sets CLAUDE_CODE_DISABLE_BUNDLED_SKILLS keeps its own value", async () => {
  const backend = fakeBackend((text) => `echo: ${text}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-test-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  const port = new ClaudeAgentPort({
    query: backend.query,
    store,
    cwd: root,
    env: { CLAUDE_CONFIG_DIR: "/accounts/test", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "0" },
    defaultModel: "test-model",
    systemPrompt: () => "You are a Marshal agent.",
    mcpServers: () => ({}),
  });
  await port.wait(port.launch({ task: "hi", idempotencyKey: "keep" }).id);
  assert.equal(backend.calls[0]!.options.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "0");
});

test("a second message resumes the same native session and adds two messages", async () => {
  const backend = fakeBackend((text) => `echo: ${text}`);
  const { port } = portWith(backend);
  const agent = port.launch({ task: "one", idempotencyKey: "k2" });
  await port.wait(agent.id);
  port.send(agent.id, "two");
  await port.wait(agent.id);
  const transcript = port.transcript(agent.id, 10);
  assert.equal(transcript.messageCount, 4);
  assert.deepEqual(
    transcript.messages.map((message) => `${message.role}:${message.content}`),
    ["user:one", "assistant:echo: one", "user:two", "assistant:echo: two"],
  );
  assert.equal(backend.calls[1]!.options.resume, "native-1");
});

test("a message sent while a turn runs is queued, and the session stays running until it is answered", async () => {
  const backend = fakeBackend((text) => `echo: ${text}`, 30);
  const { port } = portWith(backend);
  const agent = port.launch({ task: "first", idempotencyKey: "k3" });
  port.send(agent.id, "second");
  assert.equal(port.transcript(agent.id).agent.state, "running");
  await port.wait(agent.id);
  const transcript = port.transcript(agent.id, 10);
  assert.equal(transcript.messageCount, 4);
  assert.equal(transcript.result, "echo: second");
});

test("the same idempotency key launches once", async () => {
  const backend = fakeBackend(() => "ok");
  const { port } = portWith(backend);
  const first = port.launch({ task: "x", idempotencyKey: "same" });
  const second = port.launch({ task: "x", idempotencyKey: "same" });
  assert.equal(first.id, second.id);
  await port.wait(first.id);
  assert.equal(backend.calls.length, 1);
});

test("cancel stops the running turn, drops the queue and leaves the session idle without an answer", async () => {
  const backend = fakeBackend(() => "never", 5_000);
  const { port } = portWith(backend);
  const agent = port.launch({ task: "long", idempotencyKey: "k4" });
  port.send(agent.id, "queued");
  await new Promise((resolve) => setTimeout(resolve, 20));
  port.cancel(agent.id);
  await port.wait(agent.id);
  const transcript = port.transcript(agent.id, 10);
  assert.equal(transcript.agent.state, "idle");
  assert.deepEqual(
    transcript.messages.map((message) => message.role),
    ["user", "system"],
  );
  assert.equal(backend.calls.length, 1);
});

test("a backend failure marks the session failed and keeps the error in the transcript", async () => {
  const query: QueryFn = () =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "native-x" };
      throw new Error("backend exploded");
    })();
  const { port, store } = portWith({ query });
  const agent = port.launch({ task: "x", idempotencyKey: "k5" });
  await port.wait(agent.id);
  const transcript = port.transcript(agent.id, 10);
  assert.equal(transcript.agent.state, "failed");
  assert.equal(transcript.messages.at(-1)?.error, true);
  assert.equal(store.get(agent.id)!.lastError, "backend exploded");
});

test("pictures go to the backend as image blocks ahead of the text", async () => {
  const backend = fakeBackend(() => "seen");
  const { port, root } = portWith(backend);
  const picture = path.join(root, "shot.png");
  fs.writeFileSync(picture, Buffer.from([1, 2, 3]));
  const agent = port.launch({ task: "look", idempotencyKey: "k6", attachments: [picture] });
  await port.wait(agent.id);
  const sent: any[] = [];
  for await (const message of backend.calls[0]!.prompt as AsyncIterable<any>) sent.push(message);
  assert.equal(sent.length, 1);
  const content = sent[0].message.content;
  assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
  assert.deepEqual(content[1], { type: "text", text: "look" });
});

test("sessions are found again from disk by run, label and words", async () => {
  const backend = fakeBackend(() => "the hero section is done");
  const { port, store } = portWith(backend);
  const agent = port.launch({ task: "write the hero", idempotencyKey: "k7", name: "Page Studio · author", labels: { page: "rawdog" } });
  await port.wait(agent.id);
  const reopened = new FileSessionStore(store.root, { runId: "other", host: { id: "reader", kind: "local" } });
  assert.equal(reopened.list({ runId: "run-1" }).length, 1);
  assert.equal(reopened.list({ labels: { page: "rawdog" } })[0]!.id, agent.id);
  assert.equal(reopened.list({ labels: { page: "other" } }).length, 0);
  const hits = reopened.search("hero section");
  assert.equal(hits[0]!.session.id, agent.id);
  assert.match(hits[0]!.snippet, /hero/);
});
