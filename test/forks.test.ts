import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeSessionFilePath } from "@marshal/agent-runtime-claude";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { SessionForks } from "../src/forks.js";
import { createMarshalHost } from "../src/host.js";
import { FileSessionStore } from "../src/session-store.js";

interface Call {
  prompt: string;
  options: Record<string, any>;
}

/**
 * A backend whose native ids are UUIDs like Claude's: a resume keeps the id, a resume with forkSession gets a new one.
 * `hold` makes a turn wait until released (or aborted), so a test can act while a turn runs.
 */
function fakeBackend(reply: (prompt: string) => string | Error) {
  const calls: Call[] = [];
  const holds = new Map<string, () => void>();
  let holdNext: string | undefined;
  const query: QueryFn = ({ prompt, options }) => {
    const text = typeof prompt === "string" ? prompt : "pictures";
    calls.push({ prompt: text, options });
    const holdKey = holdNext && text.includes(`Your task:\n${holdNext}`) ? holdNext : holdNext && text === holdNext ? holdNext : undefined;
    if (holdKey) holdNext = undefined;
    return (async function* () {
      const resume = options.resume as string | undefined;
      const sessionId = resume && !options.forkSession ? resume : randomUUID();
      yield { type: "system", subtype: "init", session_id: sessionId };
      if (holdKey) {
        await new Promise<void>((resolve, reject) => {
          holds.set(holdKey, resolve);
          (options.abortController as AbortController).signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      const answer = reply(text);
      if (answer instanceof Error) throw answer;
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: answer }] } };
      yield { type: "result", subtype: "success", is_error: false, result: answer, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01 };
    })();
  };
  return {
    query,
    calls,
    /** The next turn whose prompt contains `marker` waits for release(marker). */
    holdTurn: (marker: string) => {
      holdNext = marker;
    },
    release: (marker: string) => holds.get(marker)?.(),
    held: (marker: string) => holds.has(marker),
  };
}

function setup(reply: (prompt: string) => string | Error = (prompt) => `done: ${prompt.split("\n")[0]}`, root?: string) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "sdk-forks-"));
  fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
  const cwd = fs.realpathSync(path.join(dir, "ws"));
  const configDir = path.join(dir, "claude");
  const backend = fakeBackend(reply);
  const store = new FileSessionStore(path.join(dir, "sessions"), { runId: "run-1", host: { id: "test-host", kind: "local" } });
  const port = new ClaudeAgentPort({
    query: backend.query,
    store,
    cwd,
    env: { CLAUDE_CONFIG_DIR: configDir },
    defaultModel: "claude-opus-5-5",
    defaultReasoningEffort: "high",
    systemPrompt: () => "host prompt",
    mcpServers: () => ({}),
  });
  const forks = new SessionForks(port, store, { flushTimeoutMs: 300 });
  return { dir, cwd, configDir, backend, store, port, forks };
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an idle parent forks through the backend: resume + forkSession, assignment with siblings, fork record", async () => {
  const { store, port, forks, backend } = setup();
  const parent = port.launch({ task: "plan the work", idempotencyKey: "p" });
  await port.wait(parent.id, 2000);
  const parentNative = store.get(parent.id)!.native.sessionId!;

  const group = await forks.fork(parent.id, [{ task: "write the API" }, { task: "write the UI", model: "claude-sonnet-5", reasoningEffort: "low" }], false);
  assert.equal(group.mode, "backend-fork");
  assert.equal(group.forks.length, 2);
  for (const fork of group.forks) await port.wait(fork.sessionId, 2000);

  const first = backend.calls.find((call) => call.prompt.startsWith("Fork assignment 1/2"))!;
  assert.equal(first.options.resume, parentNative);
  assert.equal(first.options.forkSession, true);
  assert.equal(first.options.model, "claude-opus-5-5");
  assert.equal(first.options.effort, "high");
  assert.match(first.prompt, new RegExp(`You are a fork of session ${parent.id}`));
  assert.match(first.prompt, /Your task:\nwrite the API/);
  assert.match(first.prompt, new RegExp(`Fork 2 \\(${group.forks[1]!.sessionId}\\): write the UI`));
  const second = backend.calls.find((call) => call.prompt.startsWith("Fork assignment 2/2"))!;
  assert.equal(second.options.model, "claude-sonnet-5");
  assert.equal(second.options.effort, "low");

  const record = store.get(group.forks[0]!.sessionId)!;
  assert.equal(record.parentId, parent.id);
  assert.deepEqual(record.fork, { groupId: group.groupId, index: 1, total: 2, task: "write the API" });
  assert.equal(record.native.forkOf, parentNative);
  assert.notEqual(record.native.sessionId, parentNative, "the backend's fork got its own native id");
  assert.equal(store.messages(record.id)[0]!.from?.sessionId, parent.id);
});

test("each fork's final message is queued into the parent, worded as the desktop's notice", async () => {
  const { store, port, forks } = setup((prompt) => (prompt.includes("write the API") ? "API done, tests 4/4" : `ok: ${prompt.split("\n")[0]}`));
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await port.wait(parent.id, 2000);
  const group = await forks.fork(parent.id, [{ task: "write the API", name: "api" }], false);
  await port.wait(group.forks[0]!.sessionId, 2000);
  await until(() => store.messages(parent.id).some((message) => message.content.startsWith("[Marshal notice]")));
  await port.wait(parent.id, 2000);
  const notice = store.messages(parent.id).find((message) => message.content.startsWith("[Marshal notice]"))!;
  assert.equal(notice.content, '[Marshal notice] Subagent "api" is idle and ready for follow-up.\n\nIts final message:\nAPI done, tests 4/4');
  assert.equal(notice.from?.sessionId, group.forks[0]!.sessionId);
  assert.equal(store.get(parent.id)!.state, "idle", "the parent woke on the report and answered it");
  assert.equal(store.messages(parent.id).at(-1)!.role, "assistant");
});

test("a fork the parent makes inside its running turn continues from a copy of its session file", async () => {
  const { store, port, forks, backend, configDir, cwd } = setup();
  backend.holdTurn("plan");
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await until(() => backend.held("plan"));
  const parentNative = store.get(parent.id)!.native.sessionId!;
  // What the CLI has written so far: the user turn and the assistant entry with the open fork call.
  const callId = "toolu_fork";
  const lines = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: parentNative, cwd, message: { role: "user", content: "plan" } },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: parentNative,
      cwd,
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "tool_use", id: callId, name: "mcp__marshal__runtime_exec", input: { targetType: "operation", target: "marshal.tool.forkSubagents", input: {} } },
          { type: "tool_use", id: "toolu_other", name: "Read", input: { file_path: "/x" } },
        ],
      },
    },
  ];
  const parentFile = claudeSessionFilePath(configDir, cwd, parentNative);
  fs.mkdirSync(path.dirname(parentFile), { recursive: true });
  fs.writeFileSync(parentFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  const group = await forks.fork(parent.id, [{ task: "part A" }], true);
  assert.equal(group.mode, "file-copy");
  const fork = store.get(group.forks[0]!.sessionId)!;
  const childNative = fork.native.sessionId!;
  assert.ok(childNative && childNative !== parentNative);
  const childEntries = fs
    .readFileSync(claudeSessionFilePath(configDir, cwd, childNative), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(childEntries.every((entry) => entry.sessionId === childNative));
  const answer = childEntries.at(-1);
  const results = answer.message.content as { tool_use_id: string; content: { text: string }[] }[];
  assert.match(results.find((result) => result.tool_use_id === callId)!.content[0]!.text, new RegExp(`^Forked\\. You are fork 1 of 1 \\(session ${fork.id}\\)`));
  assert.match(results.find((result) => result.tool_use_id === "toolu_other")!.content[0]!.text, /Not part of this fork/);

  await port.wait(fork.id, 2000);
  const forkCall = backend.calls.find((call) => call.prompt.startsWith("Fork assignment 1/1"))!;
  assert.equal(forkCall.options.resume, childNative);
  assert.equal(forkCall.options.forkSession, undefined);
  backend.release("plan");
  await port.wait(parent.id, 2000);
});

test("list, siblings, steer with interrupt, message every fork, and refusals", async () => {
  const { store, port, forks, backend } = setup((prompt) => `ok: ${prompt.split("\n").at(-1)}`);
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await port.wait(parent.id, 2000);
  backend.holdTurn("slow part");
  const group = await forks.fork(parent.id, [{ task: "slow part" }, { task: "quick part" }], false);
  const [slow, quick] = group.forks.map((fork) => fork.sessionId) as [string, string];
  await until(() => backend.held("slow part"));

  const listed = forks.subagents(parent.id);
  assert.deepEqual(listed.map((item) => item.id), [slow, quick]);
  assert.equal(listed[0]!.isBusy, true);
  assert.equal(listed[0]!.fork?.groupId, group.groupId);

  const siblings = forks.siblings(slow)!;
  assert.equal(siblings.parentSessionId, parent.id);
  assert.deepEqual(siblings.you, { index: 1, total: 2 });
  assert.deepEqual(siblings.siblings.map((item) => item.sessionId), [quick]);
  assert.equal(forks.siblings(parent.id), undefined);

  const steered = await forks.messageSubagent(parent.id, slow, "change of plan: stop", { deliveryMode: "interrupt" });
  assert.equal(steered.accepted, true);
  await port.wait(slow, 2000);
  const slowMessages = store.messages(slow);
  assert.ok(slowMessages.some((message) => message.content === "Turn cancelled."));
  const steer = slowMessages.find((message) => message.content.includes("change of plan"))!;
  assert.match(steer.content, new RegExp(`^Message from session plan \\(${parent.id}\\):`));
  assert.equal(steer.from?.sessionId, parent.id);

  await port.wait(quick, 2000);
  assert.deepEqual(forks.forkIds(parent.id, group.groupId).sort(), [slow, quick].sort());
  const other = port.launch({ task: "unrelated", idempotencyKey: "o" });
  await port.wait(other.id, 2000);
  const refused = await forks.messageSubagent(other.id, slow, "hi");
  assert.equal(refused.success, false);
  assert.match(refused.error!, /Not your subagent/);
  const topLevel = await forks.messageSubagent(parent.id, other.id, "hi");
  assert.match(topLevel.error!, /Not a subagent/);

  const up = await forks.messageParent(quick, "blocking question", { deliveryMode: "queue" });
  assert.equal(up.accepted, true);
  await until(() => store.messages(parent.id).some((message) => message.content.includes("blocking question")));
});

test("a cancelled fork does not report; a failed fork reports its error", async () => {
  const { store, port, forks, backend } = setup((prompt) => (prompt.includes("breaks") ? new Error("backend exploded") : "fine"));
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await port.wait(parent.id, 2000);
  backend.holdTurn("long part");
  const group = await forks.fork(parent.id, [{ task: "long part" }, { task: "breaks" }], false);
  await until(() => backend.held("long part"));
  port.cancel(group.forks[0]!.sessionId);
  await port.wait(group.forks[0]!.sessionId, 2000);
  await port.wait(group.forks[1]!.sessionId, 2000);
  await until(() => store.messages(parent.id).some((message) => message.content.includes("stopped on an error")));
  await port.wait(parent.id, 2000);
  const notices = store.messages(parent.id).filter((message) => message.content.startsWith("[Marshal notice]"));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, /Subagent "breaks" stopped on an error and is idle\.\n\nError:\nbackend exploded/);
});

test("forks survive a host restart: listed from the store, steered by resuming, and still report", async () => {
  const first = setup((prompt) => `answer to ${prompt.split("\n").at(-1)}`);
  const parent = first.port.launch({ task: "plan", idempotencyKey: "p" });
  await first.port.wait(parent.id, 2000);
  const group = await first.forks.fork(parent.id, [{ task: "part A" }], false);
  const forkId = group.forks[0]!.sessionId;
  await first.port.wait(forkId, 2000);
  await until(() => first.store.messages(parent.id).some((message) => message.content.startsWith("[Marshal notice]")));
  await first.port.wait(parent.id, 2000);
  const forkNative = first.store.get(forkId)!.native.sessionId!;
  await first.port.dispose();
  first.forks.dispose();

  const second = setup((prompt) => `answer to ${prompt.split("\n").at(-1)}`, first.dir);
  assert.deepEqual(second.forks.subagents(parent.id).map((item) => item.id), [forkId]);
  assert.equal(second.forks.siblings(forkId)!.parentSessionId, parent.id);
  const before = second.store.messages(parent.id).length;
  const sent = await second.forks.messageSubagent(parent.id, forkId, "one more thing");
  assert.equal(sent.accepted, true);
  await second.port.wait(forkId, 2000);
  const resumed = second.backend.calls.find((call) => call.prompt.includes("one more thing"))!;
  assert.equal(resumed.options.resume, forkNative);
  assert.equal(resumed.options.forkSession, undefined);
  await until(() => second.store.messages(parent.id).length > before);
  await second.port.wait(parent.id, 2000);
  assert.match(second.store.messages(parent.id).find((message, index) => index >= before && message.content.startsWith("[Marshal notice]"))!.content, /answer to one more thing/);
});

test("the host serves the fork tools under the desktop's names", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-forks-host-"));
  fs.mkdirSync(path.join(dir, "ws"));
  const backend = fakeBackend((prompt) => `ok ${prompt.split("\n")[0]}`);
  const host = await createMarshalHost({
    workspacePath: path.join(dir, "ws"),
    stateRoot: path.join(dir, "state"),
    query: backend.query,
    browser: false,
    env: { CLAUDE_CONFIG_DIR: path.join(dir, "claude") },
    ...({ automations: { start: false } } as object),
  });
  try {
    assert.match(host.systemPrompt() ?? "", /marshal\.tool\.forkSubagents/);
    const parent = host.agents.launch({ task: "plan", idempotencyKey: "p" });
    await host.agents.wait(parent.id, 2000);
    const forked = await host.invoke<{ success: boolean; groupId: string; forks: { sessionId: string }[]; mode: string }>("marshal.tool.forkSubagents", {
      sessionId: parent.id,
      tasks: [{ task: "part A" }, { task: "part B" }],
    });
    assert.equal(forked.success, true, JSON.stringify(forked));
    assert.equal(forked.mode, "backend-fork");
    for (const fork of forked.forks) await host.agents.wait(fork.sessionId, 2000);
    const listed = await host.invoke<{ subagents: { id: string }[] }>("marshal.tool.listSubagents", {});
    assert.equal(listed.subagents.length, 2);
    const all = await host.invoke<{ success: boolean; results: unknown[] }>("marshal.tool.messageForks", { sessionId: parent.id, message: "pause" });
    assert.equal(all.success, true);
    assert.equal(all.results.length, 2);
    const noParent = await host.invoke<{ success: boolean }>("marshal.tool.messageParent", { message: "x" });
    assert.equal(noParent.success, false);
  } finally {
    await host.dispose();
  }
});

test("forkPoint: a running parent whose file is elsewhere forks through the backend at the embedder's point, or fresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-forks-point-"));
  const { store, port, backend } = setup(undefined, dir);
  let point: { forkAt: string } | { fresh: true } = { forkAt: "11111111-2222-3333-4444-555555555555" };
  const forks = new SessionForks(port, store, { flushTimeoutMs: 300, forkPoint: () => point });
  backend.holdTurn("plan");
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await until(() => backend.held("plan"));
  await until(() => store.get(parent.id)!.native.sessionId !== undefined);
  const parentNative = store.get(parent.id)!.native.sessionId!;

  // In the parent's turn: no session file on this host, and none is looked for.
  const group = await forks.fork(parent.id, [{ task: "write the API" }], true);
  assert.equal(group.mode, "backend-fork");
  await port.wait(group.forks[0]!.sessionId, 2000);
  const call = backend.calls.find((entry) => entry.prompt.includes("Your task:\nwrite the API"))!;
  assert.equal(call.options.resume, parentNative);
  assert.equal(call.options.forkSession, true);
  assert.equal(call.options.resumeSessionAt, "11111111-2222-3333-4444-555555555555");
  assert.equal(store.get(group.forks[0]!.sessionId)!.native.forkOf, parentNative);

  point = { fresh: true };
  const fresh = await forks.fork(parent.id, [{ task: "write the UI" }], true);
  assert.equal(fresh.mode, "fresh");
  await port.wait(fresh.forks[0]!.sessionId, 2000);
  const freshCall = backend.calls.find((entry) => entry.prompt.includes("Your task:\nwrite the UI"))!;
  assert.equal(freshCall.options.resume, undefined);
  assert.equal(freshCall.options.forkSession, undefined);
  assert.equal(store.get(fresh.forks[0]!.sessionId)!.labels.brand, store.get(parent.id)!.labels.brand);
  backend.release("plan");
  await port.wait(parent.id, 2000);
});

test("reportToParent false: a fork's outcome is not queued into its parent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-forks-noreport-"));
  const { store, port , forks: reporting } = setup(undefined, dir);
  reporting.dispose();
  const forks = new SessionForks(port, store, { flushTimeoutMs: 300, reportToParent: false });
  const parent = port.launch({ task: "plan", idempotencyKey: "p" });
  await port.wait(parent.id, 2000);
  const before = store.messages(parent.id).length;
  const group = await forks.fork(parent.id, [{ task: "write the API" }], false);
  await port.wait(group.forks[0]!.sessionId, 2000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.messages(parent.id).length, before);
  assert.equal(store.messages(parent.id).some((message) => message.content.startsWith("[Marshal notice]")), false);
  forks.dispose();
});
