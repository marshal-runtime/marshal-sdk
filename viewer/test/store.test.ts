import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FileSessionStore } from "../../src/session-store";
import { createExtension } from "../src/index";
import { findStores, searchSessions, summarizeRuns } from "../src/store";

/** Two hosts' stores written by the SDK's own store, the way a run leaves them on disk. */
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-sessions-"));
  const cloud = new FileSessionStore(path.join(root, "cloud", "state", "sessions"), { runId: "run-a", host: { id: "e2b-1", kind: "e2b" } });
  const plan = cloud.create({ title: "Page Studio · plan", runtime: "claude", model: "claude-sonnet-5-5", native: { kind: "claude", sessionId: "n1", cwd: "/ws" }, labels: { page: "rawdog" } });
  cloud.appendMessage(plan.id, { role: "user", content: "Plan the eye cream page" });
  cloud.appendMessage(plan.id, { role: "assistant", content: "Hero, proof, buy box" });
  cloud.addUsage(plan.id, { outputTokens: 100, costUsd: 0.25, turns: 1 });
  cloud.update(plan.id, { state: "idle" });
  const writer = cloud.create({ title: "Page Studio · hero", runtime: "claude", native: { kind: "claude", cwd: "/ws" }, parentId: plan.id });
  cloud.appendMessage(writer.id, { role: "user", content: "Write the hero section" });
  const local = new FileSessionStore(path.join(root, "local", "state", "sessions"), { runId: "run-b", host: { id: "mac", kind: "local" } });
  local.update(local.create({ title: "Smoke", runtime: "claude", native: { kind: "claude", cwd: "/ws" } }).id, { state: "failed" });
  return root;
}

test("finds every store under a root and summarizes its runs", () => {
  const root = fixture();
  const stores = findStores([root]);
  assert.equal(stores.length, 2);
  const runs = summarizeRuns(stores);
  const cloud = runs.find((run) => run.runId === "run-a")!;
  assert.equal(cloud.sessions, 2);
  assert.equal(cloud.running, 1);
  assert.equal(cloud.costUsd, 0.25);
  assert.deepEqual(cloud.host, { id: "e2b-1", kind: "e2b" });
  assert.equal(cloud.firstTitle, "Page Studio · plan");
  assert.equal(runs.find((run) => run.runId === "run-b")!.failed, 1);
});

test("search scores titles, labels and transcripts", () => {
  const root = fixture();
  const hits = searchSessions(findStores([root]), "rawdog buy", 10);
  assert.equal(hits[0]!.session.title, "Page Studio · plan");
  assert.match(hits[0]!.snippet, /buy box/i);
});

test("capabilities answer through the provider with the result envelope", async () => {
  const root = fixture();
  const extension = createExtension({ configuration: { roots: [root] } });
  const provider = extension.capabilityProviders[0]!;
  const runs = (await provider.invoke("sdksessions.runs", {}, {})) as { output: { result: any } };
  assert.equal(runs.output.result.runs.length, 2);
  const sessions = (await provider.invoke("sdksessions.sessions", { runId: "run-a" }, {})) as { output: { result: any } };
  assert.equal(sessions.output.result.sessions.length, 2);
  const child = sessions.output.result.sessions.find((session: any) => session.parentId);
  assert.ok(child);
  const transcript = (await provider.invoke("sdksessions.transcript", { sessionId: child.parentId }, {})) as { output: { result: any } };
  assert.equal(transcript.output.result.found, true);
  assert.deepEqual(
    transcript.output.result.messages.map((message: any) => message.role),
    ["user", "assistant"],
  );
  const missing = (await provider.invoke("sdksessions.transcript", { sessionId: "../../etc" }, {})) as { output: { result: any } };
  assert.equal(missing.output.result.found, false);
  assert.equal(extension.uiApplications[0]!.metadata["marshal.ui.viewports"].length, 2);
});
