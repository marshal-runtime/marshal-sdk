import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMarshalHost } from "../src/host.js";

test("marshal.agent.transcript carries eventCount and lastEventAt while a turn runs (Page Studio's quiet deadline reads them)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    browser: false,
    automations: { start: false },
    query: () =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "native-big", tools: ["Read", "Bash"], mcp_servers: [{ name: "playwright", status: "connected" }], skills: ["lp-design", "animate"] };
        yield { type: "system", subtype: "thinking_tokens", estimated_tokens: 150 };
        await gate;
        yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "{\"ops\":[]}" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: "{\"ops\":[]}", usage: {} };
      })(),
  });
  try {
    const call = async (name: string, input: Record<string, unknown>) => {
      const answer = (await host.invoke(name, input)) as any;
      const output = answer?.agent ? answer : answer?.result;
      if (!output?.agent) throw new Error(`${name}: ${JSON.stringify(answer).slice(0, 600)}`);
      return output;
    };
    const launched = await call("marshal.agent.launch", { task: "edit the big page", idempotencyKey: "big-edit" });
    const agentId = launched.agent?.id ?? launched.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const working = await call("marshal.agent.transcript", { agentId, limit: 1 });
    assert.equal(working.agent.state, "running");
    // The runtime's agent schema is closed; its usage object is open, so the activity rides there.
    assert.equal(working.agent.usage.eventCount, 2);
    assert.equal(typeof working.agent.usage.lastEventAt, "string");
    // What the backend really gave the session (its init event), sorted: Page Studio fingerprints it next to what it asked for.
    assert.deepEqual(working.agent.usage.environment, { tools: ["Bash", "Read"], mcpServers: ["playwright"], skills: ["animate", "lp-design"] });
    release();
    for (let i = 0; i < 100 && (await call("marshal.agent.transcript", { agentId, limit: 1 })).agent.state !== "idle"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = await call("marshal.agent.transcript", { agentId, limit: 1 });
    assert.equal(done.agent.usage.eventCount, 4);
  } finally {
    release();
    await host.dispose();
  }
});
