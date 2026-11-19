import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { InvocationContext } from "@marshal/runtime";

import { createSessionToolsProvider } from "../src/agent-provider.js";
import { sdkBaseLayer, assembleHostPrompt, mergePromptLayers } from "../src/prompt.js";
import { cloudRunLayer } from "../src/prompt-cloud.js";
import { CLAUDE_NATIVE_PROMPT_TOOLS } from "../src/native-tools.js";
import { FileSessionStore } from "../src/session-store.js";

const base = sdkBaseLayer({ browser: false, extensionGuidance: [], sections: [], nativeTools: CLAUDE_NATIVE_PROMPT_TOOLS });

test("the cloud run layer names the run, its contract and state, and drops what a sandbox does not have", () => {
  const layer = cloudRunLayer({
    job: "@acme/pages:page",
    purpose: "build one landing page",
    runId: "812",
    startedBy: "omer@zyg.com",
    stateLocation: "gs://bucket/run-812/agent/marshal-state/",
    contract: ["out/index.html", "logs/summary.json"],
    kit: { brain: true, memory: true, sessions: true, publishes: true },
  });
  const prompt = assembleHostPrompt(mergePromptLayers(base, layer)).content;
  assert.match(prompt, /cloud sandbox for the person who started this run \(omer@zyg\.com\)/);
  assert.match(prompt, /## This run/);
  assert.match(prompt, /Run `812`/);
  assert.match(prompt, /out\/index\.html; logs\/summary\.json/);
  assert.match(prompt, /gs:\/\/bucket\/run-812\/agent\/marshal-state\//);
  assert.match(prompt, /published to the team Brain's session index/);
  assert.match(prompt, /`@acme\/pages:page`: build one landing page/);
  assert.match(prompt, /`marshal\.tool\.recall \{query\}`/);
  assert.match(prompt, /`marshal\.tool\.remember \{fact, category, home, appliesTo\?, replaces\?, links\?\}` writes a memory node into the Brain graph at once/);
  assert.match(prompt, /It has one of two homes; always name it/);
  assert.match(prompt, /`home: "personal"` is the person's own, private and in every workspace/);
  assert.match(prompt, /`home: "workspace"` is this workspace's own Brain, where links reach its real code/);
  assert.match(prompt, /mcp__marshal__runtime_exec \{targetType: 'operation'/);
  for (const absent of ["memory.propose", "approves it before", "`WebFetch`", "runtimeSearch {query}", "ask once, the way this surface allows"]) {
    assert.ok(!prompt.includes(absent), `still names ${absent}`);
  }
  for (const tool of ["`Bash`", "`Read`", "`Write`", "`Edit`", "`WebSearch`", "`mcp__marshal__runtime_exec`"]) assert.ok(prompt.includes(tool), tool);
});

test("the layer names no extension of its own; memory is always the Brain graph", () => {
  const prompt = assembleHostPrompt(mergePromptLayers(base, cloudRunLayer({ job: "@acme/pages:page" }))).content;
  assert.doesNotMatch(prompt, /pagestudio/);
  assert.doesNotMatch(prompt, /published to the team Brain/);
  assert.match(prompt, /You have a long-term memory that lasts across sessions/);
  assert.match(prompt, /Each memory is a node in the Brain's knowledge graph/);
  assert.doesNotMatch(prompt, /already in your context below/);
});

test("marshal.tool.setSessionTodos keeps the calling session's plan in its state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-todos-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r", host: { id: "h", kind: "container" } });
  const session = store.create({ title: "writer", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
  const provider = createSessionToolsProvider({ hostId: "h" } as never, store);
  const context = { scope: { sessionId: session.id } } as unknown as InvocationContext;
  const out = (await provider.invoke(
    "marshal.tool.setSessionTodos",
    { todos: [{ title: "Plan sections", status: "done" }, { title: "Write hero", status: "in-progress" }], goalLabel: "RAWDOG page" },
    context,
  )) as { output: { success: boolean; count: number } };
  assert.deepEqual(out.output, { success: true, count: 2 });
  const plan = store.todos(session.id)!;
  assert.equal(plan.goalLabel, "RAWDOG page");
  assert.deepEqual(plan.todos.map((todo) => [todo.title, todo.status]), [["Plan sections", "done"], ["Write hero", "in_progress"]]);
  const anonymous = (await provider.invoke("marshal.tool.setSessionTodos", { todos: [] }, {} as InvocationContext)) as { output: { success: boolean } };
  assert.equal(anonymous.output.success, false);
});
