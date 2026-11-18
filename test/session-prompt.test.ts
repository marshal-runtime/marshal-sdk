import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { CLAUDE_NATIVE_PROMPT_TOOLS } from "../src/native-tools.js";
import { defaultSessionPrompt } from "../src/session-prompt.js";

const silent: QueryFn = () =>
  (async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
  })();

test("a bare embedder gets the same prompt createMarshalHost gives a top-level session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-session-prompt-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    query: silent,
    browser: false,
    repoRules: false,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    automations: { start: false },
  });
  try {
    const hosted = host.systemPrompt() ?? "";
    assert.ok(hosted.length > 0);
    assert.equal(defaultSessionPrompt({ nativeTools: [] }), hosted);
  } finally {
    await host.dispose();
  }
});

test("lists exactly the tools the session holds", () => {
  const prompt = defaultSessionPrompt({
    nativeTools: ["Read", "Grep"],
    readResourceTool: false,
    otherTools: [{ name: "mcp__zyg__dd_logs", description: "Datadog logs." }],
  });
  assert.match(prompt, /mcp__marshal__runtime_exec/);
  assert.doesNotMatch(prompt, /mcp__marshal__runtime_read_resource/);
  assert.match(prompt, /`?Read`?: Read a file, an image/);
  assert.match(prompt, /`?Grep`?: The Grep tool\./);
  assert.match(prompt, /mcp__zyg__dd_logs`?: Datadog logs\./);
  assert.doesNotMatch(prompt, /`?Bash`?: Run shell commands/);
});

test("defaults to the Claude native tools, the runtime tools and the forks section", () => {
  const prompt = defaultSessionPrompt();
  for (const tool of CLAUDE_NATIVE_PROMPT_TOOLS) assert.ok(prompt.includes(tool.name), tool.name);
  assert.match(prompt, /mcp__marshal__runtime_read_resource/);
  assert.match(prompt, /## Forks, lanes and messages on this host/);
});

test("no runtime tools and no forks: neither is named", () => {
  const prompt = defaultSessionPrompt({ runtimeTools: false, forks: false, nativeTools: [] });
  assert.doesNotMatch(prompt, /mcp__marshal__runtime_(search|exec)/);
  assert.doesNotMatch(prompt, /## Forks, lanes and messages on this host/);
});

test("a forks call and a host layer are honored", () => {
  const prompt = defaultSessionPrompt({
    forks: { call: "mcp__marshal__runtimeInvoke {capability: '<name>', input}" },
    layer: { sections: [{ id: "extra", text: "## Extra\n\nhello" }] },
  });
  assert.match(prompt, /call them with mcp__marshal__runtimeInvoke/);
  assert.match(prompt, /## Extra\n\nhello/);
});

test("an invalid section id throws instead of falling back", () => {
  assert.throws(() => defaultSessionPrompt({ layer: { sections: [{ id: "Bad Id", text: "x" }] } }), /Invalid prompt section id/);
});
