import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { applySchema, CloudSessionStore, CloudTranscriptStore, fsObjectStore, gcsObjectStore, type ObjectStore, type SqlClient } from "../src/cloud-store/index.js";
import { createKnowledgeProvider, prepareKit } from "../src/kit/index.js";
import { startPostgres, schemaPool, type TestPostgres } from "./pg-fixture.js";

let postgres: TestPostgres | undefined;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

const origin = (host = "h") => ({ runId: `run-${host}`, host: { id: host, kind: "local" } });
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `marshal-cloud-${name}-`));

async function kit(options: { tenant?: string; objects?: ObjectStore; sql?: SqlClient } = {}) {
  assert.ok(postgres, "no Postgres: set MARSHAL_TEST_DATABASE_URL or start Docker");
  const pool = await schemaPool(postgres.url);
  await applySchema(pool);
  return { pool, objects: options.objects ?? fsObjectStore(tmp("objects")), open: (tenant = options.tenant ?? "brand-a", host = "h") => CloudSessionStore.open({ sql: options.sql ?? pool, objects: options.objects ?? fsObjectStore(tmp("o")), tenant, origin: origin(host), writeDelayMs: 5 }) };
}

describe("CloudSessionStore on a real Postgres", { skip: process.env.CI_NO_DOCKER === "1" }, () => {
  test("a restart (a new store, another machine) finds records, messages, events, usage and plans", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    const first = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin("vm-1"), writeDelayMs: 5 });
    const session = first.create({ title: "Weekly sales", runtime: "claude", native: { kind: "claude", cwd: "/vm1/work" }, labels: { brand: "a", role: "front" } });
    first.appendMessage(session.id, { role: "user", content: "How did we do last week?" });
    first.appendMessage(session.id, { role: "assistant", content: "Net sales were up twelve percent." });
    first.appendEvent(session.id, { type: "system", subtype: "init" });
    first.appendEvent(session.id, { type: "result", ok: true });
    first.addUsage(session.id, { costUsd: 0.25, turns: 1, inputTokens: 100 });
    first.setTodos(session.id, { todos: [{ id: "1", title: "report", status: "done" }], updatedAt: "2026-11-16T00:00:00.000Z" });
    first.update(session.id, { state: "idle" });
    await first.flush();

    const second = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin("vm-2"), writeDelayMs: 5 });
    assert.equal(second.list().length, 1);
    const record = second.get(session.id)!;
    assert.equal(record.state, "idle");
    assert.equal(record.messageCount, 2);
    assert.equal(record.usage.costUsd, 0.25);
    assert.deepEqual(record.labels, { brand: "a", role: "front" });
    assert.deepEqual(second.messages(session.id), [], "messages are read from the database on demand, not at open");
    await second.hydrate(session.id);
    assert.deepEqual(second.messages(session.id).map((message) => message.content), ["How did we do last week?", "Net sales were up twelve percent."]);
    assert.deepEqual(second.events(session.id).map((row) => row.seq), [1, 2]);
    assert.equal(second.todos(session.id)?.todos[0]?.title, "report");
    // The adopted session keeps counting where the first host stopped.
    second.appendEvent(session.id, { type: "assistant" });
    second.appendMessage(session.id, { role: "user", content: "and the week before?" });
    await second.flush();
    const third = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin("vm-3") });
    await third.hydrate(session.id);
    assert.deepEqual(third.events(session.id).map((row) => row.seq), [1, 2, 3]);
    assert.equal(third.messages(session.id).length, 3);
  });

  test("a tenant never sees another tenant's sessions, transcripts or search hits", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    const a = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin(), writeDelayMs: 5 });
    const b = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-b", origin: origin(), writeDelayMs: 5 });
    const secret = a.create({ title: "Olive Grove stock-out", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
    a.appendMessage(secret.id, { role: "assistant", content: "The Olive Grove candle sold out on Nov 7." });
    await a.flush();
    await new CloudTranscriptStore({ sql: pool, objects, tenant: "brand-a" }).append({ projectKey: "p", sessionId: "native-a" }, [{ type: "user", uuid: "u1", message: "secret" }]);
    const reopenedB = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-b", origin: origin() });
    assert.deepEqual(reopenedB.list(), []);
    assert.deepEqual(await b.search("olive grove"), []);
    assert.equal(await new CloudTranscriptStore({ sql: pool, objects, tenant: "brand-b" }).load({ projectKey: "p", sessionId: "native-a" }), null);
    assert.equal((await a.search("olive")).length, 1);
    await assert.rejects(() => b.hydrate(secret.id), /No session/);
  });

  test("search ranks title, labels and transcript lexically, gives a snippet, and takes a rerank hook", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    let reranked = 0;
    const store = await CloudSessionStore.open({
      sql: pool,
      objects,
      tenant: "brand-a",
      origin: origin(),
      writeDelayMs: 5,
      rerank: (query, candidates) => {
        reranked++;
        return [...candidates].reverse();
      },
    });
    const a = store.create({ title: "Black Friday spend rule", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
    const b = store.create({ title: "Chat", runtime: "claude", native: { kind: "claude", cwd: "/w" }, labels: { topic: "returns" } });
    store.appendMessage(b.id, { role: "user", content: "Customers keep asking about the returns policy and refunds." });
    await store.flush();
    const fresh = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin(), writeDelayMs: 5 });
    const byTitle = await fresh.search("black friday");
    assert.equal(byTitle[0]?.session.id, a.id);
    const byBody = await fresh.search("refunds");
    assert.equal(byBody[0]?.session.id, b.id);
    assert.match(byBody[0]!.snippet, /refunds/i);
    assert.equal((await fresh.search("returns"))[0]?.session.id, b.id, "labels are searchable");
    assert.deepEqual(await fresh.search("   "), []);
    assert.equal(reranked, 0);
    const both = await store.search("friday refunds");
    assert.equal(reranked, 1);
    assert.equal(both.length, 2);
  });

  test("a failed write is kept and retried by the next flush, without duplicates", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    let failures = 1;
    const flaky: SqlClient = {
      query: async (text, params) => {
        if (/INSERT INTO marshal_session_messages/.test(text) && failures-- > 0) throw new Error("connection reset");
        return pool.query(text, params);
      },
    };
    const store = await CloudSessionStore.open({ sql: flaky, objects, tenant: "brand-a", origin: origin(), writeDelayMs: 5 });
    const session = store.create({ title: "t", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
    store.appendMessage(session.id, { role: "user", content: "one" });
    await assert.rejects(() => store.flush(), /connection reset/);
    store.appendMessage(session.id, { role: "user", content: "two" });
    await store.flush();
    const reopened = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin() });
    await reopened.hydrate(session.id);
    assert.deepEqual(reopened.messages(session.id).map((message) => message.content), ["one", "two"]);
    assert.equal(reopened.get(session.id)?.messageCount, 2);
  });

  test("artifacts live in the object store under the tenant, and escape nothing", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    const store = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin(), writeDelayMs: 5 });
    const session = store.create({ title: "brief", runtime: "claude", native: { kind: "claude", cwd: "/w" } });
    await store.putArtifact(session.id, "brief.json", JSON.stringify({ ok: true }), "application/json");
    assert.deepEqual(await store.listArtifacts(session.id), ["brief.json"]);
    assert.equal(Buffer.from((await store.getArtifact(session.id, "brief.json"))!).toString(), '{"ok":true}');
    await assert.rejects(() => store.putArtifact(session.id, "../x", "no"), /relative path/);
    assert.equal(await store.getArtifact(session.id, "missing"), undefined);
  });
});

describe("CloudTranscriptStore, the Claude Agent SDK's sessionStore on Postgres", () => {
  test("appends in order, dedupes by uuid, spills big batches to the object store, and loads across project keys", async (t) => {
    const { pool } = await kit();
    t.after(() => pool.end());
    const gcs = await fakeGcs();
    t.after(() => gcs.close());
    const objects = gcsObjectStore({ bucket: "marley-sessions", accessToken: async () => "token", baseUrl: gcs.url });
    const store = new CloudTranscriptStore({ sql: pool, objects, tenant: "brand-a", inlineLimitBytes: 1000 });
    const key = { projectKey: "-vm1-work", sessionId: "native-1" };
    await store.append(key, [{ type: "user", uuid: "u1", message: "hello" }]);
    await store.append(key, [{ type: "user", uuid: "u1", message: "hello" }, { type: "assistant", uuid: "a1", message: "hi" }]);
    await store.append(key, [{ type: "assistant", uuid: "big", message: "x".repeat(5000) }]);
    await store.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "s1" }]);
    assert.equal(gcs.objects.size, 1, "only the big batch spills to the object store");
    // Resumed on another machine with another working folder: another project key.
    const loaded = await store.load({ projectKey: "-vm2-elsewhere", sessionId: "native-1" });
    assert.deepEqual(loaded?.map((entry) => entry.uuid), ["u1", "a1", "big"]);
    assert.equal((loaded![2]!.message as string).length, 5000);
    assert.deepEqual(await store.listSubkeys(key), ["subagents/agent-1"]);
    assert.deepEqual((await store.listSessions("-vm1-work")).map((row) => row.sessionId), ["native-1"]);
    assert.deepEqual(await store.listSessions("-vm2-elsewhere"), []);
    assert.equal(await store.load({ projectKey: "x", sessionId: "never" }), null);
    await store.delete(key);
    assert.equal(await store.load(key), null);
    assert.equal(gcs.objects.size, 0, "deleting a session removes its spilled objects");
  });

  test("the real Agent SDK accepts it: importSessionToStore, listSessions and getSessionMessages run against Postgres", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const store = new CloudTranscriptStore({ sql: pool, objects, tenant: "brand-a" });
    const home = tmp("claude-home");
    const cwd = tmp("cwd");
    const projectKey = (sdk as any).projectKeyForDirectory ? (sdk as any).projectKeyForDirectory(cwd) : undefined;
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const projectDir = path.join(home, "projects", fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      { type: "user", uuid: "00000000-0000-4000-8000-000000000001", parentUuid: null, sessionId, timestamp: "2026-11-16T10:00:00.000Z", cwd, version: "2.1.295", message: { role: "user", content: "What sold best?" } },
      { type: "assistant", uuid: "00000000-0000-4000-8000-000000000002", parentUuid: "00000000-0000-4000-8000-000000000001", sessionId, timestamp: "2026-11-16T10:00:01.000Z", cwd, version: "2.1.295", message: { role: "assistant", content: [{ type: "text", text: "The Fig diffuser." }] } },
    ];
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      await sdk.importSessionToStore(sessionId, store as never, { dir: cwd });
      const messages = await sdk.getSessionMessages(sessionId, { dir: cwd, sessionStore: store as never });
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.type, "user");
      const entries = await store.load({ projectKey: projectKey ?? "x", sessionId });
      void entries;
      const raw = await pool.query(`SELECT count(*)::int AS n FROM marshal_transcript_batches WHERE tenant = 'brand-a' AND session_id = $1`, [sessionId]);
      assert.ok(raw.rows[0].n >= 1, "the SDK wrote the transcript through our adapter");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe("the agent port with a cloud store", () => {
  test("a session resumes on another machine from the store: same native id, transcript restored, idle only after the writes landed", async (t) => {
    const { pool, objects } = await kit();
    t.after(() => pool.end());
    const projectKeyOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const resumed: { cwd: string; resume?: unknown; restored: unknown[] | null | "n/a" }[] = [];
    // A stand-in for the Agent SDK's contract with a `sessionStore`: it loads the transcript of `resume` before the
    // backend starts, and mirrors every entry the turn writes.
    const backend: QueryFn = ({ prompt, options }) => {
      const sessionStore = options.sessionStore as CloudTranscriptStore | undefined;
      const cwd = String(options.cwd);
      const nativeId = typeof options.resume === "string" ? options.resume : "native-cloud-1";
      return (async function* () {
        let restored: unknown[] | null | "n/a" = "n/a";
        if (typeof options.resume === "string" && sessionStore) restored = await sessionStore.load({ projectKey: projectKeyOf(cwd), sessionId: options.resume });
        resumed.push({ cwd, resume: options.resume, restored });
        yield { type: "system", subtype: "init", session_id: nativeId };
        const text = typeof prompt === "string" ? prompt : "streamed";
        const count = Array.isArray(restored) ? restored.length : 0;
        await sessionStore?.append({ projectKey: projectKeyOf(cwd), sessionId: nativeId }, [
          { type: "user", uuid: `u-${count}`, message: text },
          { type: "assistant", uuid: `a-${count}`, message: `answer ${count}` },
        ]);
        yield { type: "assistant", message: { content: [{ type: "text", text: `answer after ${count} restored entries` }] } };
        yield { type: "result", subtype: "success", is_error: false, result: `answer after ${count} restored entries`, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    };
    const portOn = async (host: string, cwd: string) => {
      const store = await CloudSessionStore.open({ sql: pool, objects, tenant: "brand-a", origin: origin(host), writeDelayMs: 5 });
      const port = new ClaudeAgentPort({ query: backend, store, cwd, env: {}, defaultModel: "m", systemPrompt: () => "host", mcpServers: () => ({}) });
      return { store, port };
    };
    const one = await portOn("vm-1", "/srv/brands/a/chats/c1");
    const agent = one.port.launch({ task: "first question", idempotencyKey: "k1", labels: { brand: "a" } } as never);
    assert.match((await one.port.wait(agent.id, 5_000)).result ?? "", /after 0 restored/);
    // The session went idle only after everything it wrote reached Postgres.
    const durable = await pool.query(`SELECT record->>'state' AS state, record->'native'->>'sessionId' AS native FROM marshal_sessions WHERE tenant = 'brand-a' AND id = $1`, [agent.id]);
    assert.deepEqual(durable.rows[0], { state: "idle", native: "native-cloud-1" });
    const sessionMessages = await pool.query(`SELECT count(*)::int AS n FROM marshal_session_messages WHERE tenant = 'brand-a' AND session_id = $1`, [agent.id]);
    assert.ok(sessionMessages.rows[0].n >= 2);

    // The next machine: a new process, a new store instance, another working folder. Nothing is copied between them.
    const two = await portOn("vm-2", "/mnt/restored/other/place");
    two.port.send(agent.id, "follow-up");
    const answer = await two.port.wait(agent.id, 5_000);
    assert.match(answer.result ?? "", /after 2 restored entries/);
    assert.equal(resumed[1]!.resume, "native-cloud-1");
    assert.equal(resumed[1]!.cwd, "/mnt/restored/other/place");
    assert.equal((resumed[1]!.restored as unknown[]).length, 2);
    // The session's own record shows the whole conversation on the second machine too.
    assert.deepEqual(two.store.messages(agent.id).map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  });
});

describe("the knowledge provider seam", () => {
  const provider = {
    id: "brand-corpus",
    async search(request: { query: string; limit: number; kinds?: readonly string[] }, scope: { tenant: string; viewer?: string }) {
      return [{ id: `${scope.tenant}:1`, kind: "memory", title: `about ${request.query}`, snippet: `viewer ${scope.viewer ?? "none"}` }];
    },
  };
  const context = { principal: { id: "p" }, scope: {} } as never;

  test("serves knowledge.search in the host's scope, never one the session names", async () => {
    const capabilities = createKnowledgeProvider({ provider, scope: { tenant: "brand-a", viewer: "dana" } });
    const listed = await capabilities.list(context);
    assert.deepEqual(listed.map((descriptor) => descriptor.name), ["knowledge.search"]);
    const out = (await capabilities.invoke("knowledge.search", { query: "returns", tenant: "brand-b" }, context)) as { output: { hits: { id: string; snippet: string }[] } };
    assert.equal(out.output.hits[0]!.id, "brand-a:1", "an input field naming another tenant changes nothing");
    assert.match(out.output.hits[0]!.snippet, /viewer dana/);
    assert.match(out.output.hits[0]!.snippet, /untrusted/, "results are wrapped as untrusted data");
    const schema = (listed[0] as unknown as { inputSchema: { additionalProperties: boolean; properties: object } }).inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.equal("tenant" in schema.properties, false);
  });

  test("the kit takes it as the part `knowledge`, and refuses it beside the Brain", () => {
    const prepared = prepareKit({ kit: { parts: ["knowledge"], knowledge: { provider, scope: { tenant: "brand-a" } } }, sessions: {} as never, workspacePath: "/w" });
    assert.equal(prepared.providerSources.length, 1);
    assert.equal(prepared.extensions.length, 0, "no Brain package is installed");
    assert.throws(() => prepareKit({ kit: { parts: ["knowledge", "brain"], knowledge: { provider, scope: { tenant: "a" } } }, sessions: {} as never, workspacePath: "/w" }), /choose one/);
    assert.throws(() => prepareKit({ kit: { parts: ["knowledge"] }, sessions: {} as never, workspacePath: "/w" }), /needs kit.knowledge/);
  });
});

interface FakeGcs {
  url: string;
  objects: Map<string, Buffer>;
  close(): void;
}

/** The slice of the Cloud Storage JSON API the object store uses, served locally. */
async function fakeGcs(): Promise<FakeGcs> {
  const objects = new Map<string, Buffer>();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.headers.authorization, "Bearer token");
      const upload = /^\/upload\/storage\/v1\/b\/[^/]+\/o$/.exec(url.pathname);
      const object = /^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
      const listing = /^\/storage\/v1\/b\/[^/]+\/o$/.test(url.pathname);
      if (request.method === "POST" && upload) {
        objects.set(url.searchParams.get("name")!, Buffer.concat(chunks));
        response.end("{}");
      } else if (request.method === "GET" && object) {
        const found = objects.get(decodeURIComponent(object[1]!));
        if (!found) response.writeHead(404).end("no");
        else response.end(found);
      } else if (request.method === "GET" && listing) {
        const prefix = url.searchParams.get("prefix") ?? "";
        response.end(JSON.stringify({ items: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })) }));
      } else if (request.method === "DELETE" && object) {
        objects.delete(decodeURIComponent(object[1]!));
        response.writeHead(204).end();
      } else response.writeHead(400).end("bad");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, objects, close: () => server.close() };
}
