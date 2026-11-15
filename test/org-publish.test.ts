import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { OrgClient, fetchOrgDiscovery, type UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";

import { claudeNativePath, publishToOrg } from "../src/org-publish.js";
import { FileSessionStore } from "../src/session-store.js";

const ADA: UserPrincipal = "user:ada@example.test";
const BOB: UserPrincipal = "user:bob@example.test";
const WORKSPACE = "ws:pages" as const;
const NATIVE = '{"type":"user","sessionId":"native-1","message":{"role":"user","content":"Write the hero"}}\n';

/** A fake organization (the contract's in-memory server) with sessions, leases, the cloud envelope store and forks. */
async function org() {
  const provider = createInMemoryOrgProvider({
    users: [
      { principal: ADA, email: "ada@example.test", displayName: "Ada" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
    ],
    workspaces: [{ id: WORKSPACE, displayName: "Pages", repositories: [] }],
    features: ["signIn", "workspaces", "sessions", "leases", "cloudRuns", "forks"],
    cloud: { formats: ["claude-jsonl"] },
  });
  const discovery = await fetchOrgDiscovery(provider.orgUrl, { fetch: provider.fetch });
  const clientFor = (principal: UserPrincipal) =>
    new OrgClient({ discovery, accessToken: async () => provider.issueToken(principal), fetch: provider.fetch });
  return { provider, ada: clientFor(ADA), bob: clientFor(BOB) };
}

function storeWithRun(): FileSessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-publish-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-7", host: { id: "e2b-42", kind: "e2b" } });
  const session = store.create({
    title: "Page Studio · section hero",
    runtime: "claude",
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
    native: { kind: "claude", sessionId: "native-1", cwd: "/sandbox/ws" },
    labels: { extension: "@zyg/page-studio", page: "rawdog" },
  });
  store.appendMessage(session.id, { role: "user", content: "Write the hero" });
  store.appendMessage(session.id, { role: "assistant", content: "<section>hero</section>" });
  store.update(session.id, { state: "idle" });
  return store;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("a run's session becomes an org session a teammate can read, fork and take home", async () => {
  const { ada, bob } = await org();
  const store = storeWithRun();
  const [result] = await publishToOrg({
    client: ada,
    store,
    owner: ADA,
    workspaceId: WORKSPACE,
    host: "e2b-42",
    nativeState: () => new TextEncoder().encode(NATIVE),
  });
  assert.equal(result!.error, undefined);
  assert.equal(result!.messageCount, 3);
  assert.equal(result!.envelope, "uploaded");

  const view = await ada.getSession(result!.orgSessionId);
  assert.equal(view.session.runtime, "marshal-sdk");
  assert.equal(view.session.labels, "team");
  assert.equal(view.session.title, "Page Studio · section hero · run run-7 on e2b-42");

  await ada.grantSession(result!.orgSessionId, { principal: BOB, role: "driver" });
  const transcript = await bob.getTranscript(result!.orgSessionId);
  assert.deepEqual(
    transcript.messages.map((message) => message.role),
    ["system", "user", "assistant"],
  );
  assert.match(transcript.messages[0]!.text, /run run-7 on host e2b-42 \(e2b\)/);
  assert.match(transcript.messages[0]!.text, /labels extension=@zyg\/page-studio page=rawdog/);

  // What the desktop's org fork does before sessions.createFromNative: fork, then download the checkpointed state.
  const fork = await bob.forkSession(result!.orgSessionId, { clientForkId: "bob-fork-1" });
  assert.equal(fork.session.owner, BOB);
  assert.equal(fork.envelope?.format, "claude-jsonl");
  const state = gunzipSync(await readStream((await bob.getForkEnvelope(fork.session.id)).body));
  assert.equal(state.toString("utf8"), NATIVE);
});

test("publishing again appends only new messages and re-uploads the state only when it changed", async () => {
  const { ada } = await org();
  const store = storeWithRun();
  let native = NATIVE;
  const options = {
    client: ada,
    store,
    owner: ADA,
    workspaceId: WORKSPACE,
    host: "e2b-42",
    nativeState: () => new TextEncoder().encode(native),
  };
  await publishToOrg(options);
  const [unchanged] = await publishToOrg(options);
  assert.equal(unchanged!.appended, 0);
  assert.equal(unchanged!.envelope, "unchanged");

  const id = store.list()[0]!.id;
  store.appendMessage(id, { role: "user", content: "Make it shorter" });
  store.appendMessage(id, { role: "assistant", content: "<section>short</section>" });
  native += '{"type":"user","sessionId":"native-1","message":{"role":"user","content":"Make it shorter"}}\n';
  const [next] = await publishToOrg(options);
  assert.equal(next!.appended, 2);
  assert.equal(next!.messageCount, 5);
  assert.equal(next!.envelope, "uploaded");
  assert.equal((await ada.getTranscript(next!.orgSessionId)).total, 5);
});

test("a running session is published without a checkpoint; long messages are cut to the page limit", async () => {
  const { ada } = await org();
  const store = storeWithRun();
  const id = store.list()[0]!.id;
  store.appendMessage(id, { role: "assistant", content: "x".repeat(70 * 1024) });
  store.update(id, { state: "running" });
  const [result] = await publishToOrg({ client: ada, store, owner: ADA, workspaceId: WORKSPACE, host: "e2b-42", nativeState: () => new Uint8Array([1]) });
  assert.equal(result!.error, undefined);
  assert.equal(result!.envelope, "skipped-running");
  const last = (await ada.getTranscript(result!.orgSessionId)).messages.at(-1)!;
  assert.ok(Buffer.byteLength(last.text) <= 64 * 1024);
  assert.match(last.text, /\[cut:/);
});

test("the organization takes a session only from its owner: a service publishing for someone else is refused", async () => {
  const { bob } = await org();
  const [result] = await publishToOrg({ client: bob, store: storeWithRun(), owner: ADA, workspaceId: WORKSPACE, host: "e2b-42", envelopes: false });
  assert.match(result!.error ?? "", /403|forbidden|owner/i);
});

test("the native path follows Claude's projects layout", () => {
  assert.equal(
    claudeNativePath({ native: { kind: "claude", sessionId: "abc", cwd: "/Users/omer/marshal/marshal-sdk/.runs/quick1/ws", configDir: "/accounts/max" } }),
    "/accounts/max/projects/-Users-omer-marshal-marshal-sdk--runs-quick1-ws/abc.jsonl",
  );
});
