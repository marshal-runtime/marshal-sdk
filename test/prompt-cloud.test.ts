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
    job: "page-run",
    purpose: "build one landing page",
    runId: "812",
    startedBy: "omer@zyg.com",
    stateLocation: "gs://bucket/run-812/agent/marshal-state/",
    contract: ["out/index.html", "logs/summary.json"],
    pageStudio: true,
    kit: { brain: true, memory: true, sessions: true, publishes: true },
  });
  const prompt = assembleHostPrompt(mergePromptLayers(base, layer)).content;
  assert.match(prompt, /cloud sandbox for the person who started this run \(omer@zyg\.com\)/);
  assert.match(prompt, /## This run/);
  assert.match(prompt, /Run `812`/);
  assert.match(prompt, /out\/index\.html; logs\/summary\.json/);
  assert.match(prompt, /gs:\/\/bucket\/run-812\/agent\/marshal-state\//);
  assert.match(prompt, /published to the team Brain's session index/);
  assert.match(prompt, /## Page Studio on this host/);
  assert.match(prompt, /`memory\.recall \{query\}`/);
  assert.match(prompt, /mcp__marshal__runtime_exec \{targetType: 'operation'/);
  for (const absent of ["marshal.tool.recall", "marshal.tool.remember", "marshal.tool.forget", "`WebFetch`", "runtimeSearch {query}", "ask once, the way this surface allows"]) {
    assert.ok(!prompt.includes(absent), `still names ${absent}`);
  }
  for (const tool of ["`Bash`", "`Read`", "`Write`", "`Edit`", "`WebSearch`", "`mcp__marshal__runtime_exec`"]) assert.ok(prompt.includes(tool), tool);
});

test("without memory or Page Studio the layer says so and adds no Page Studio section", () => {
  const prompt = assembleHostPrompt(mergePromptLayers(base, cloudRunLayer({ job: "page-edit" }))).content;
  assert.match(prompt, /This run has no memory store/);
  assert.doesNotMatch(prompt, /## Page Studio on this host/);
  assert.doesNotMatch(prompt, /published to the team Brain/);
  assert.match(prompt, /This run cannot save memories/);
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
