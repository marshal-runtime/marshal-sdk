import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { InvocationContext } from "@marshal/runtime";

import { createSessionToolsProvider } from "../src/agent-provider.js";
import { createForkToolsProvider } from "../src/fork-provider.js";
import type { SessionForks } from "../src/forks.js";
import { FileSessionStore } from "../src/session-store.js";

function storeWithTwoTenants() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-scope-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "r", host: { id: "h", kind: "container" } });
  const make = (title: string, labels: Record<string, string>) => store.create({ title, runtime: "claude", native: { kind: "claude", cwd: "/w" }, labels });
  const caller = make("invoice rounding caller", { brand: "a" });
  const sameBrand = make("invoice rounding fix", { brand: "a" });
  const otherBrand = make("invoice rounding secret", { brand: "b" });
  const unlabelled = make("invoice rounding host", {});
  return { store, caller, sameBrand, otherBrand, unlabelled };
}

const as = (sessionId: string | undefined) => (sessionId ? { scope: { sessionId } } : {}) as unknown as InvocationContext;
type Search = { output: { success: boolean; results: { sessionId: string }[] } };
type Transcript = { output: { success?: boolean; error?: string; name?: string } };

test("sessionScopeLabel: searchSessions and getSessionTranscript see only the caller's tenant", async () => {
  const { store, caller, sameBrand, otherBrand, unlabelled } = storeWithTwoTenants();
  const scoped = createSessionToolsProvider({ hostId: "h" } as never, store, { scopeLabel: "brand" });
  const found = (await scoped.invoke("marshal.tool.searchSessions", { query: "invoice rounding" }, as(caller.id))) as Search;
  assert.deepEqual(found.output.results.map((hit) => hit.sessionId), [sameBrand.id]);
  const own = (await scoped.invoke("marshal.tool.getSessionTranscript", { sessionId: sameBrand.id }, as(caller.id))) as Transcript;
  assert.equal(own.output.name, "invoice rounding fix");
  const foreign = (await scoped.invoke("marshal.tool.getSessionTranscript", { sessionId: otherBrand.id }, as(caller.id))) as Transcript;
  assert.deepEqual(foreign.output, { success: false, error: "Session not found" });
  // No calling session, or a caller without the label: nothing.
  const anonymous = (await scoped.invoke("marshal.tool.searchSessions", { query: "invoice rounding" }, as(undefined))) as Search;
  assert.deepEqual(anonymous.output.results, []);
  const bare = (await scoped.invoke("marshal.tool.searchSessions", { query: "invoice rounding" }, as(unlabelled.id))) as Search;
  assert.deepEqual(bare.output.results, []);
  const bareRead = (await scoped.invoke("marshal.tool.getSessionTranscript", { sessionId: sameBrand.id }, as(unlabelled.id))) as Transcript;
  assert.equal(bareRead.output.error, "Session not found");
});

test("without sessionScopeLabel nothing is filtered", async () => {
  const { store, caller, otherBrand } = storeWithTwoTenants();
  const open = createSessionToolsProvider({ hostId: "h" } as never, store);
  const found = (await open.invoke("marshal.tool.searchSessions", { query: "invoice rounding" }, as(caller.id))) as Search;
  assert.equal(found.output.results.length, 3);
  const foreign = (await open.invoke("marshal.tool.getSessionTranscript", { sessionId: otherBrand.id }, as(caller.id))) as Transcript;
  assert.equal(foreign.output.name, "invoice rounding secret");
});

test("requireCaller: subagent tools refuse a call with no calling session", async () => {
  const calls: string[] = [];
  const forks = {
    known: (id: string | undefined) => id,
    subagents: (parent?: string) => (calls.push(`list:${parent ?? "all"}`), []),
    forkIds: (parent: string) => (calls.push(`ids:${parent}`), []),
    messageSubagent: async () => (calls.push("message"), { sessionId: "x", success: true, accepted: true, messageId: "m" }),
  } as unknown as SessionForks;
  const guarded = createForkToolsProvider(forks, { requireCaller: true });
  const list = (await guarded.invoke("marshal.tool.listSubagents", {}, as(undefined))) as { output: { success: boolean } };
  assert.equal(list.output.success, false);
  const message = (await guarded.invoke("marshal.tool.messageSubagent", { sessionId: "x", message: "hi" }, as(undefined))) as { output: { success: boolean } };
  assert.equal(message.output.success, false);
  const broadcast = (await guarded.invoke("marshal.tool.messageForks", { sessionId: "p", message: "hi" }, as(undefined))) as { output: { success: boolean } };
  assert.equal(broadcast.output.success, false);
  assert.deepEqual(calls, []);
  await guarded.invoke("marshal.tool.listSubagents", {}, as("p"));
  assert.deepEqual(calls, ["list:p"]);
});
