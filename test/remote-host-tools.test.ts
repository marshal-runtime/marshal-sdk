import assert from "node:assert/strict";
import { test } from "node:test";

import { hostToolOf, isHostToolCall, isHostToolSearch, REMOTE_HOST_TOOLS, refusedHostTool, remoteHostToolSet } from "../src/remote-tools.js";

test("remoteHostToolSet: all host tools by default, a subset when given, an unknown name refused", () => {
  assert.deepEqual([...remoteHostToolSet(undefined)].sort(), [...REMOTE_HOST_TOOLS].sort());
  const memory = remoteHostToolSet(["marshal.tool.remember", "marshal.tool.recall"]);
  assert.equal(memory.has("marshal.tool.remember"), true);
  assert.equal(memory.has("marshal.tool.searchSessions"), false);
  assert.throws(() => remoteHostToolSet(["marshal.tool.remember", "marshal.tool.shell"]), /not a remote host tool: marshal\.tool\.shell/);
});

test("hostToolOf: names the host tool of an operation call or a by-name search, nothing else", () => {
  assert.equal(hostToolOf("runtime_exec", { targetType: "operation", target: "marshal.tool.searchSessions", input: {} }), "marshal.tool.searchSessions");
  assert.equal(hostToolOf("runtime_search", { name: "marshal.tool.getSessionTranscript" }), "marshal.tool.getSessionTranscript");
  assert.equal(hostToolOf("runtime_exec", { targetType: "operation", target: "zs.data.query" }), undefined);
  assert.equal(hostToolOf("runtime_exec", { targetType: "inline_module", target: "marshal.tool.remember" }), undefined);
  assert.equal(hostToolOf("runtime_search", { query: "marshal.tool.searchSessions" }), undefined);
  assert.equal(isHostToolCall("runtime_exec", { targetType: "operation", target: "marshal.tool.forget" }), true);
  assert.equal(isHostToolSearch("runtime_search", { name: "marshal.tool.forget" }), true);
  assert.equal(isHostToolSearch("runtime_exec", { targetType: "operation", target: "marshal.tool.forget" }), false);
});

test("refusedHostTool: an error result naming the tool", () => {
  assert.deepEqual(refusedHostTool("marshal.tool.searchSessions"), { content: [{ type: "text", text: "marshal.tool.searchSessions is not available in this session." }], isError: true });
});
