import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startLinkServer } from "../../src/link/server";
import { FileSessionStore } from "../../src/session-store";
import { createExtension } from "../src/index";

const LINK_TOKEN = "viewer-shared-token-0123456789abc";

const invoke = async (extension: ReturnType<typeof createExtension>, name: string, input: Record<string, unknown>) =>
  ((await extension.capabilityProviders[0]!.invoke(name, input, {})) as { output: { result: any } }).output.result;

test("search adds sessions shared to the org's index through a linked kit host, and opens one it reads for us", async () => {
  const calls: string[] = [];
  const reads: any[] = [];
  // A run this Mac already lists, whose session the org index also returns.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "listed-"));
  const listed = new FileSessionStore(path.join(root, "run-y", "state", "sessions"), { runId: "run-y", host: { id: "agent-sandbox", kind: "container" } });
  const mine = listed.create({ title: "Page Studio · awake picture look", runtime: "claude" });
  const server = await startLinkServer({
    token: LINK_TOKEN,
    sessionsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "kit-store-")),
    host: { id: "kit-1", kind: "local" },
    live: {
      send: () => ({}),
      cancel: () => ({}),
      extensions: () => [],
      capabilities: async () => [],
      invoke: async (capability: string, input: any) => {
        calls.push(capability);
        if (capability === "sessions.search") {
          assert.equal(input.scope, "cloud");
          return {
            results: [
              { id: "shared-1", origin: "cloud", title: "Page Studio · hero", owner: "bar@zyg.com", snippet: "<untrusted_session>awake on camera</untrusted_session>", source: "marshal", runId: "run-x", stateLocation: "gs://bucket/runs/x/output/agent/marshal-state/" },
              { id: mine.id, origin: "cloud", title: "Page Studio · awake picture look", owner: "omer@zyg.com", snippet: "<untrusted_session>awake look</untrusted_session>", source: "marshal", runId: "run-y" },
            ],
            cloud: { status: "ok", hits: 2 },
          };
        }
        if (capability === "sessions.read") reads.push(input);
        if (capability === "sessions.read" && input.sessionId === "shared-1") {
          return { found: true, from: "cloud-state", messages: [{ role: "user", content: "<untrusted_session>Write the hero</untrusted_session>", timestamp: "2026-11-16T00:00:00.000Z" }, { role: "assistant", content: "Awake on camera.", timestamp: "2026-11-16T00:00:05.000Z" }] };
        }
        return { found: false, tried: [] };
      },
    },
  });
  try {
    const viewer = createExtension({ configuration: { roots: [root], hosts: [{ id: "kit", name: "Kit", url: server.url, token: LINK_TOKEN }] } });
    const found = await invoke(viewer, "sdksessions.search", { query: "awake" });
    const fromKit = found.hits.filter((hit: any) => hit.hostId === "kit");
    assert.deepEqual(
      fromKit.map((hit: any) => [hit.hostId, hit.sessionId, hit.runId, hit.shared, hit.owner, hit.outputRoot]),
      [["kit", "shared-1", "run-x", true, "bar@zyg.com", "gs://bucket/runs/x/output"]],
    );
    // Found here too: it stays the hit that opens its run on this Mac, marked as shared by its owner.
    const known = found.hits.filter((hit: any) => hit.sessionId === mine.id);
    assert.equal(known.length, 1);
    assert.deepEqual([known[0].hostId, known[0].runId, known[0].shared, known[0].owner, known[0].sharedVia], ["local", "run-y", true, "omer@zyg.com", "kit"]);
    assert.match(known[0].snippet, /^shared by omer@zyg\.com · /);
    assert.match(fromKit[0].snippet, /shared by bar@zyg\.com · awake on camera/);

    const transcript = await invoke(viewer, "sdksessions.transcript", { hostId: "kit", sessionId: "shared-1", tail: 200 });
    assert.equal(transcript.found, true, JSON.stringify(transcript));
    assert.deepEqual(transcript.messages.map((message: any) => [message.index, message.role, message.content]), [[0, "user", "Write the hero"], [1, "assistant", "Awake on camera."]]);
    assert.equal(transcript.session.id, "shared-1");
    assert.equal(transcript.session.host.kind, "shared (cloud-state)");
    assert.equal(transcript.session.labels.sharedVia, "Kit");

    const watched = await invoke(viewer, "sdksessions.watch", { hostId: "kit", sessionId: "shared-1", since: 2, eventCursor: 0, waitMs: 0 });
    assert.equal(watched.found, false);
    const missing = await invoke(viewer, "sdksessions.transcript", { hostId: "kit", sessionId: "nowhere", tail: 10 });
    assert.equal(missing.found, false);
    assert.deepEqual(calls, ["sessions.search", "sessions.read", "sessions.read"]);
    assert.deepEqual(reads[0], { sessionId: "shared-1", stateLocation: "gs://bucket/runs/x/output/agent/marshal-state/", tail: 200 });
    assert.equal(reads[1].stateLocation, undefined);
  } finally {
    await server.close();
  }
});
