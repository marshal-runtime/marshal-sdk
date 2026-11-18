import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ClaudeAgentPort,
  mergeLaunchOptions,
  systemPromptText,
  TURN_EXTRAS,
  TURN_ID,
  type AgentLaunchOptions,
  type LiveProcessCloseReason,
  type AgentPortOptions,
  type QueryFn,
} from "../src/agent-port.js";
import { sessionConfig } from "../src/provider-query.js";
import { agentSdkOnly } from "../src/provider-selection.js";
import { FileSessionStore } from "../src/session-store.js";

interface Started {
  options: Record<string, any>;
  /** Text of each user message the process read. */
  messages: string[];
  /** The port's turn id on each user message the process read (live). */
  turnIds: unknown[];
  ended: boolean;
  aborted: boolean;
}

/**
 * A fake Claude Agent SDK. A streaming prompt gets one process that answers each user message with a result whose
 * total_cost_usd is the process's running total (as the SDK reports it); a string prompt gets one turn. A message
 * "hang" waits until the process is aborted. Every turn first runs the PreToolUse hooks on a Bash call and answers
 * "denied: <reason>" when one denies it. A message "boom" fails the stream; "end" ends it without an answer.
 */
function backend(costPerTurn = 0.1) {
  const started: Started[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const run: Started = { options, messages: [], turnIds: [], ended: false, aborted: false };
    started.push(run);
    const abort = options.abortController as AbortController | undefined;
    abort?.signal.addEventListener("abort", () => (run.aborted = true), { once: true });
    const nativeId = typeof options.resume === "string" && !options.forkSession ? options.resume : `native-${started.length}`;
    let total = 0;
    async function* answer(text: string): AsyncGenerator<Record<string, any>> {
      run.messages.push(text);
      if (text === "boom") throw new Error("backend exploded");
      if (text === "hang") {
        await new Promise<void>((resolve) => {
          if (abort?.signal.aborted) resolve();
          abort?.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      let reply = `answer to ${text}`;
      for (const matcher of ((options.hooks as Record<string, unknown> | undefined)?.PreToolUse ?? []) as { hooks: Function[] }[]) {
        for (const hook of matcher.hooks) {
          const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "tool-1", {});
          if (out?.hookSpecificOutput?.permissionDecision === "deny") reply = `denied: ${out.hookSpecificOutput.permissionDecisionReason}`;
        }
      }
      total += costPerTurn;
      yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } };
      yield { type: "result", subtype: "success", is_error: false, result: reply, num_turns: 2, total_cost_usd: total, usage: { input_tokens: 10, output_tokens: 5 } };
    }
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: nativeId };
      try {
        if (typeof prompt === "string") {
          yield* answer(prompt);
          return;
        }
        for await (const message of prompt as AsyncIterable<any>) {
          const content = message.message.content;
          run.turnIds.push(message[TURN_ID]);
          if (content === "end") return;
          yield* answer(typeof content === "string" ? content : String(content.at(-1)?.text));
        }
      } finally {
        run.ended = true;
      }
    })();
  };
  return { query, started };
}

function rig(extra: Partial<AgentPortOptions> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-live-"))) {
  const fake = backend();
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run", host: { id: "h", kind: "local" } });
  const logs: string[] = [];
  const port = new ClaudeAgentPort({
    query: fake.query,
    store,
    cwd: root,
    env: {},
    defaultModel: "m",
    systemPrompt: () => "host prompt",
    mcpServers: () => ({ marshal: { type: "sdk", name: "marshal" } }),
    log: (line) => logs.push(line),
    ...extra,
  });
  return { port, store, root, logs, ...fake };
}

const denyBash = (reason: string) => async (input: { tool_name?: string }) =>
  input.tool_name === "Bash"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : { continue: true };

/** Waits (bounded) for an asynchronous close to be observed. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 2_000) assert.fail(`not observed within 2 s: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const turn = async (port: ClaudeAgentPort, id: string, text: string) => {
  port.send(id, text);
  return (await port.wait(id, 5_000)).result;
};

test("live off: every turn starts its own process, as before", async () => {
  const { port, started } = rig();
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  assert.equal(started.length, 2);
  assert.deepEqual(started[0]!.options.systemPrompt, { type: "custom", prompt: "host prompt", snapshot: false });
  assert.equal(started[1]!.options.resume, "native-1");
  assert.deepEqual(port.liveSessions(), []);
});

test("the host's prompt is not recorded: a resumed turn sends the prompt its own turn rendered (memories chosen on the task turn, R153)", async () => {
  let memory = "";
  const { port, started } = rig({ systemPrompt: () => `host prompt${memory}` });
  const agent = port.launch({ task: "Reply with the single word ready.", idempotencyKey: "k" });
  await port.wait(agent.id);
  memory = "\n\n## Memory\n\nRAWDOG: the FAQ heading reads 'Your Eye Cream Questions, Answered'.";
  await turn(port, agent.id, "Write the FAQ section.");
  assert.equal(started[1]!.options.resume, "native-1");
  assert.deepEqual(started[1]!.options.systemPrompt, { type: "custom", prompt: `host prompt${memory}`, snapshot: false });
});

test("live: one process serves every turn; each turn's cost is its share of the running total", async () => {
  const { port, started, store } = rig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  assert.equal((await port.wait(agent.id)).result, "answer to one");
  assert.equal(await turn(port, agent.id, "two"), "answer to two");
  assert.equal(await turn(port, agent.id, "three"), "answer to three");
  assert.equal(started.length, 1, "one process for three turns");
  assert.deepEqual(started[0]!.messages, ["one", "two", "three"]);
  assert.equal(typeof started[0]!.options.prompt, "undefined");
  assert.deepEqual(Object.keys(started[0]!.options.mcpServers), ["marshal"], "the host's servers reach the process");
  assert.deepEqual(port.liveSessions(), [agent.id]);
  const usage = store.get(agent.id)!.usage;
  assert.equal(usage.turns, 3);
  assert.equal(Math.round(usage.costUsd * 1000) / 1000, 0.3, "running totals 0.1, 0.2, 0.3 count once: 0.1 per turn");
  assert.equal(usage.modelTurns, 6, "num_turns is per turn");
  assert.equal(usage.inputTokens, 30, "usage is per turn");
  assert.match(store.messages(agent.id, 10).map((m) => m.content).join("|"), /answer to three/);
  await port.dispose();
  await eventually(() => started[0]!.ended, "dispose closes the process");
  assert.deepEqual(port.liveSessions(), []);
});

test("live: an idle process closes after idleSeconds; the next turn resumes the session in a new one", async () => {
  const { port, started } = rig({ live: { idleSeconds: 0.05 } });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(started[0]!.ended, true);
  assert.deepEqual(port.liveSessions(), []);
  assert.equal(await turn(port, agent.id, "two"), "answer to two");
  assert.equal(started.length, 2);
  assert.equal(started[1]!.options.resume, "native-1");
  await port.dispose();
});

test("live: past maxLive the least recently used idle process closes", async () => {
  const { port, started } = rig({ live: { maxLive: 2 } });
  const a = port.launch({ task: "a", idempotencyKey: "a" });
  await port.wait(a.id);
  const b = port.launch({ task: "b", idempotencyKey: "b" });
  await port.wait(b.id);
  await turn(port, a.id, "a2"); // a is now the more recently used
  const c = port.launch({ task: "c", idempotencyKey: "c" });
  await port.wait(c.id);
  assert.deepEqual(port.liveSessions().sort(), [a.id, c.id].sort(), "b, the least recently used, was evicted");
  assert.equal(started[1]!.ended, true);
  assert.equal(started[0]!.ended, false);
  await port.dispose();
});

test("live: a process is recycled after maxTurns turns", async () => {
  const { port, started } = rig({ live: { maxTurns: 2 } });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  await turn(port, agent.id, "three");
  assert.equal(started.length, 2);
  assert.deepEqual(started[0]!.messages, ["one", "two"]);
  assert.deepEqual(started[1]!.messages, ["three"]);
  assert.equal(started[0]!.ended, true);
  assert.equal(started[1]!.options.resume, "native-1");
  await port.dispose();
});

test("live: a new model (or any changed option) starts a new process", async () => {
  const { port, started } = rig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  port.setModel(agent.id, "other");
  await turn(port, agent.id, "two");
  assert.equal(started.length, 2);
  assert.equal(started[0]!.ended, true);
  assert.equal(started[1]!.options.model, "other");
  await port.dispose();
});

test("live: fresh hook closures each turn keep the process (hooks count by shape)", async () => {
  const { port, started } = rig({
    live: {},
    launchOptionsFor: () => ({ hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] } }),
  });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  assert.equal(started.length, 1);
  await port.dispose();
});

test("live: an interrupt cancels the running turn and closes its process; the next message runs in a new one", async () => {
  const { port, started, store } = rig({ live: {} });
  const agent = port.launch({ task: "hang", idempotencyKey: "k" });
  while (started[0]?.messages.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  port.send(agent.id, "after", "interrupt");
  const done = await port.wait(agent.id, 5_000);
  assert.equal(done.state, "completed");
  assert.equal(done.result, "answer to after");
  assert.equal(started[0]!.aborted, true);
  assert.equal(started.length, 2);
  assert.equal(started[1]!.options.resume, "native-1");
  assert.ok(store.messages(agent.id, 20).some((m) => m.content === "Turn cancelled."));
  await port.dispose();
});

test("live: cancel closes the session's process", async () => {
  const { port, started } = rig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  port.cancel(agent.id);
  assert.equal(started[0]!.aborted, true);
  assert.deepEqual(port.liveSessions(), []);
});

test("live is Claude only: another runtime keeps one process per turn", async () => {
  const { port, started } = rig({ live: {}, runtimeId: "codex" });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  assert.equal(started.length, 2);
  assert.equal(started[0]!.options.prompt, undefined);
});

test("a live turn goes to the Claude Agent SDK, never the Claude client", () => {
  assert.deepEqual(agentSdkOnly({ [TURN_EXTRAS]: { attachments: [], live: true } } as never), ["a live process"]);
  assert.deepEqual(agentSdkOnly({ [TURN_EXTRAS]: { attachments: [] } } as never), []);
});

test("launchOptionsFor: a session adopted after a restart still runs the host's PreToolUse gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-adopt-"));
  const gate = (session: { labels?: Record<string, string> }): AgentLaunchOptions | undefined =>
    session.labels?.role === "front" ? { hooks: { PreToolUse: [{ hooks: [denyBash("front may not run Bash")] }] } } : undefined;
  const first = rig({ launchOptionsFor: gate }, root);
  const agent = first.port.launch({ task: "one", idempotencyKey: "k", labels: { role: "front" } });
  assert.equal((await first.port.wait(agent.id)).result, "denied: front may not run Bash");
  await first.port.dispose();

  // The host restarts: a new port on the same store, with no memory of the launch.
  const second = rig({ launchOptionsFor: gate }, root);
  second.port.send(agent.id, "two");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await second.port.wait(agent.id)).result, "denied: front may not run Bash");
  assert.equal(second.started[0]!.options.resume, "native-1");

  // The control: without launchOptionsFor an adopted session runs ungated (what the port did before).
  const third = rig({}, root);
  third.port.send(agent.id, "three");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await third.port.wait(agent.id)).result, "answer to three");
});

test("launchOptionsFor merges with the launch's own: both hooks run, tools union, the launch wins the rest", async () => {
  const host: AgentLaunchOptions = {
    hooks: { PreToolUse: [{ hooks: [denyBash("host")] }], Stop: [{ hooks: [async () => ({})] }] },
    disallowedTools: ["Task"],
    env: { A: "host", B: "host" },
    maxTurns: 5,
    mcpServers: { brand: { type: "stdio", command: "host" } },
  };
  const own: AgentLaunchOptions = {
    hooks: { PreToolUse: [{ hooks: [denyBash("launch")] }] },
    disallowedTools: ["Bash", "Task"],
    env: { B: "launch", C: null },
    maxTurns: 9,
  };
  const merged = mergeLaunchOptions(host, own);
  assert.equal((merged.hooks!.PreToolUse as unknown[]).length, 2);
  assert.equal((merged.hooks!.Stop as unknown[]).length, 1);
  assert.deepEqual(merged.disallowedTools, ["Task", "Bash"]);
  assert.deepEqual(merged.env, { A: "host", B: "launch", C: null });
  assert.equal(merged.maxTurns, 9);
  assert.deepEqual(Object.keys(merged.mcpServers!), ["brand"]);
  assert.equal(mergeLaunchOptions(undefined, own), own);
  assert.equal(mergeLaunchOptions(host, undefined), host);

  const { port, started } = rig({ launchOptionsFor: () => host });
  const agent = port.launch({ task: "one", idempotencyKey: "k", options: own });
  // The host's gate runs first, then the launch's: the last deny is the launch's.
  assert.equal((await port.wait(agent.id)).result, "denied: launch");
  assert.equal(started[0]!.options.maxTurns, 9);
  assert.deepEqual(started[0]!.options.disallowedTools, ["Task", "Bash"]);
});

test("launchOptionsFor that throws fails the turn instead of running without the policy", async () => {
  const { port, started, store } = rig({
    launchOptionsFor: () => {
      throw new Error("no gate for this brand");
    },
  });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  assert.equal(started.length, 0);
  assert.equal(store.get(agent.id)!.state, "failed");
  assert.match(store.get(agent.id)!.lastError ?? "", /no gate for this brand/);
});

test("a launch's own prompt is sent unrecorded (snapshot false), so a fork of it never runs on its parent's prompt", async () => {
  const { port, started } = rig();
  const parent = port.launch({ task: "plan", idempotencyKey: "p", systemPrompt: "You are the chat front." });
  await port.wait(parent.id);
  assert.deepEqual(started[0]!.options.systemPrompt, { type: "custom", prompt: "You are the chat front.", snapshot: false });

  const worker = port.launch({
    task: "do the task",
    idempotencyKey: "w",
    systemPrompt: "You are a background worker.",
    native: { forkOf: "native-1", forkAt: "msg-7" },
  });
  await port.wait(worker.id);
  const forking = started[1]!.options;
  assert.equal(forking.resume, "native-1");
  assert.equal(forking.forkSession, true);
  assert.equal(forking.resumeSessionAt, "msg-7");
  assert.deepEqual(forking.systemPrompt, { type: "custom", prompt: "You are a background worker.", snapshot: false });

  await turn(port, worker.id, "next");
  assert.deepEqual(started[2]!.options.systemPrompt, { type: "custom", prompt: "You are a background worker.", snapshot: false });
});

test("other providers read a launch's custom prompt as its text", () => {
  assert.equal(systemPromptText({ type: "custom", prompt: "Own prompt.", snapshot: false }), "Own prompt.");
  assert.equal(systemPromptText("plain"), "plain");
  assert.equal(systemPromptText({ type: "preset", preset: "claude_code" }), undefined);
  const config = sessionConfig({ systemPrompt: { type: "custom", prompt: "Own prompt.", snapshot: false } }, "/tmp", undefined);
  assert.deepEqual(config.systemMessage, { content: "Own prompt.", mode: "replace" });
});

/** A rig that records every onLiveProcessClosed call. */
function closingRig(extra: Partial<AgentPortOptions> = {}) {
  const closed: [string, LiveProcessCloseReason][] = [];
  const r = rig({ onLiveProcessClosed: (id, reason) => closed.push([id, reason]), ...extra });
  return { ...r, closed };
}

test("onLiveProcessClosed: idle", async () => {
  const { port, closed } = closingRig({ live: { idleSeconds: 0.05 } });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  assert.deepEqual(closed, [], "not while the process waits for its next turn");
  await eventually(() => closed.length > 0, "idle close");
  assert.deepEqual(closed, [[agent.id, "idle"]]);
  await port.dispose();
  assert.equal(closed.length, 1, "a closed process is reported once, dispose does not repeat it");
});

test("onLiveProcessClosed: evicted", async () => {
  const { port, closed } = closingRig({ live: { maxLive: 1 } });
  const a = port.launch({ task: "a", idempotencyKey: "a" });
  await port.wait(a.id);
  const b = port.launch({ task: "b", idempotencyKey: "b" });
  await port.wait(b.id);
  assert.deepEqual(closed, [[a.id, "evicted"]]);
  await port.dispose();
  assert.deepEqual(closed, [[a.id, "evicted"], [b.id, "disposed"]]);
});

test("onLiveProcessClosed: recycled after maxTurns", async () => {
  const { port, closed } = closingRig({ live: { maxTurns: 1 } });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  assert.deepEqual(closed, [[agent.id, "recycled"]]);
  await port.dispose();
});

test("onLiveProcessClosed: options changed", async () => {
  const { port, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  port.setModel(agent.id, "other");
  await turn(port, agent.id, "two");
  assert.deepEqual(closed, [[agent.id, "options changed"]]);
  await port.dispose();
});

test("onLiveProcessClosed: turn cancelled (an interrupt)", async () => {
  const { port, started, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "hang", idempotencyKey: "k" });
  while (started[0]?.messages.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  port.send(agent.id, "after", "interrupt");
  await port.wait(agent.id, 5_000);
  assert.deepEqual(closed, [[agent.id, "turn cancelled"]], "the abort's close is the only one; the turn's catch finds it closed");
  await port.dispose();
});

test("onLiveProcessClosed: turn failed", async () => {
  const { port, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "boom", idempotencyKey: "k" });
  await port.wait(agent.id, 5_000);
  assert.equal(port.get(agent.id)?.state, "failed");
  assert.deepEqual(closed, [[agent.id, "turn failed"]]);
  await port.dispose();
});

test("onLiveProcessClosed: stream ended", async () => {
  const { port, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "end", idempotencyKey: "k" });
  await port.wait(agent.id, 5_000);
  assert.deepEqual(closed, [[agent.id, "stream ended"]]);
  await port.dispose();
});

test("onLiveProcessClosed: cancelled", async () => {
  const { port, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  port.cancel(agent.id);
  assert.deepEqual(closed, [[agent.id, "cancelled"]]);
});

test("onLiveProcessClosed: disposed, one call per open process", async () => {
  const { port, closed } = closingRig({ live: {} });
  const a = port.launch({ task: "a", idempotencyKey: "a" });
  const b = port.launch({ task: "b", idempotencyKey: "b" });
  await port.wait(a.id);
  await port.wait(b.id);
  await port.dispose();
  assert.deepEqual(closed.map(([, reason]) => reason), ["disposed", "disposed"]);
  assert.deepEqual(closed.map(([id]) => id).sort(), [a.id, b.id].sort());
});

test("onLiveProcessClosed: a throwing listener is logged and the process still closes", async () => {
  const { port, logs, started } = rig({
    live: {},
    onLiveProcessClosed: () => {
      throw new Error("listener broke");
    },
  });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  port.cancel(agent.id);
  assert.deepEqual(port.liveSessions(), []);
  assert.equal(started[0]!.aborted, true);
  assert.ok(logs.some((line) => line.includes(`live process closed listener for ${agent.id} failed: listener broke`)));
});

test("closeLive: closes an idle session's process, keeps the session; the next turn resumes it in a new process", async () => {
  const { port, started, closed, store } = closingRig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  assert.equal(port.closeLive(agent.id), true);
  assert.deepEqual(closed, [[agent.id, "closed"]]);
  assert.deepEqual(port.liveSessions(), []);
  assert.equal(port.closeLive(agent.id), false, "no live process left");
  assert.equal(port.get(agent.id)?.state, "idle");
  assert.equal(await turn(port, agent.id, "two"), "answer to two");
  assert.equal(started.length, 2);
  assert.equal(started[1]!.options.resume, "native-1");
  assert.ok(!store.messages(agent.id, 20).some((m) => m.content === "Turn cancelled."));
  await port.dispose();
});

test("closeLive: refuses while the session runs, and leaves its queue alone", async () => {
  const { port, started, closed } = closingRig({ live: {} });
  const agent = port.launch({ task: "hang", idempotencyKey: "k" });
  while (started[0]?.messages.length !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  port.send(agent.id, "queued");
  assert.equal(port.closeLive(agent.id), false);
  assert.deepEqual(closed, []);
  port.send(agent.id, "after", "interrupt");
  const done = await port.wait(agent.id, 5_000);
  assert.equal(done.result, "answer to queued", "the queued message still ran, after the interrupting one");
  await port.dispose();
});

test("closeLive: false for a session without a live process (live off)", async () => {
  const { port } = closingRig();
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  assert.equal(port.closeLive(agent.id), false);
});

test("turn ids: the opening turn's options carry its id, and every pushed message carries its own", async () => {
  const { port, started } = rig({ live: {} });
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  const extras = started[0]!.options[TURN_EXTRAS as never] as { turnId?: string };
  const ids = started[0]!.turnIds;
  assert.equal(ids.length, 2);
  assert.equal(typeof ids[0], "string");
  assert.equal(extras.turnId, ids[0], "the process was opened by the first turn");
  assert.notEqual(ids[1], ids[0]);
  assert.equal(JSON.stringify({ x: 1, [TURN_ID]: "t" }), '{"x":1}', "the id never reaches a serialized message");
  await port.dispose();
});

test("turn ids: a per-turn backend gets a fresh id in each turn's options", async () => {
  const { port, started } = rig();
  const agent = port.launch({ task: "one", idempotencyKey: "k" });
  await port.wait(agent.id);
  await turn(port, agent.id, "two");
  const id = (run: Started) => (run.options[TURN_EXTRAS as never] as { turnId?: string }).turnId;
  assert.equal(typeof id(started[0]!), "string");
  assert.notEqual(id(started[0]!), id(started[1]!));
});
