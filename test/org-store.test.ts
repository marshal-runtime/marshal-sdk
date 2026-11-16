import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { ClaudeAgentPort, type QueryFn } from "../src/agent-port.js";
import { FileSessionStore } from "../src/session-store.js";
import {
  OrgStore,
  PreconditionFailedError,
  fsObjectStore,
  gcsObjectStore,
  listIndex,
  type ImplDeclaration,
  type ObjectStore,
} from "../src/index.js";
import { startFakeGcs, type FakeGcs } from "./fake-gcs.js";

let gcs: FakeGcs;
before(async () => {
  gcs = await startFakeGcs();
});
after(() => gcs.close());

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `marshal-org-${name}-`));
const origin = (host = "h") => ({ runId: `run-${host}`, host: { id: host, kind: "service" } });
const marley: ImplDeclaration = {
  v: 1,
  workspace: "zygstinct",
  impl: "marley",
  partition: ["env", "brand"],
  fields: { procedure: { from: "label", filter: true }, role: { from: "label", filter: true }, kind: { from: "label", filter: true } },
};
const stores = (): Array<[string, () => ObjectStore]> => [
  ["fsObjectStore", () => fsObjectStore(tmp("fs"))],
  ["gcsObjectStore on a fake bucket", () => gcsObjectStore({ bucket: `b${Math.random().toString(16).slice(2)}`, accessToken: async () => "t", baseUrl: gcs.url })],
];

for (const [name, make] of stores()) {
  describe(`${name}: generations, create-only, compose`, () => {
    test("create-only refuses an existing object, a generation match refuses a changed one", async () => {
      const objects = make();
      const first = await objects.put("a/one", "1", { ifGenerationMatch: 0 });
      await assert.rejects(objects.put("a/one", "2", { ifGenerationMatch: 0 }), PreconditionFailedError);
      const second = await objects.put("a/one", "2", { ifGenerationMatch: first.generation });
      assert.notEqual(second.generation, first.generation);
      await assert.rejects(objects.put("a/one", "3", { ifGenerationMatch: first.generation }), PreconditionFailedError);
      assert.equal(Buffer.from((await objects.get("a/one"))!).toString(), "2");
      assert.equal((await objects.read("a/one"))!.generation, second.generation);
      assert.equal(await objects.get("a/missing"), undefined);
    });

    test("listInfo gives names and generations under a prefix; compose joins sources in order and honours a precondition", async () => {
      const objects = make();
      await objects.put("p/b", "B\n");
      await objects.put("p/a", "A\n");
      await objects.put("q/c", "C\n");
      const info = await objects.listInfo("p/");
      assert.deepEqual(info.map((item) => item.name), ["p/a", "p/b"]);
      assert.ok(info.every((item) => item.generation.length > 0 && item.size === 2));
      const composed = await objects.compose(["p/a", "p/b", "q/c"], "out/all", { ifGenerationMatch: 0 });
      assert.equal(Buffer.from((await objects.get("out/all"))!).toString(), "A\nB\nC\n");
      await assert.rejects(objects.compose(["p/a"], "out/all", { ifGenerationMatch: 0 }), PreconditionFailedError);
      await objects.compose(["out/all", "p/a"], "out/all", { ifGenerationMatch: composed.generation });
      assert.equal(Buffer.from((await objects.get("out/all"))!).toString(), "A\nB\nC\nA\n");
      await assert.rejects(objects.delete("out/all", { ifGenerationMatch: composed.generation }), PreconditionFailedError);
    });
  });
}

describe("OrgStore on a bucket", () => {
  const session = (store: FileSessionStore, labels: Record<string, string>, createdAt?: string) => {
    const record = store.create({ title: "t", runtime: "claude", labels, native: { sessionId: `native-${Math.random().toString(16).slice(2, 8)}` } } as never);
    return createdAt ? store.update(record.id, { createdAt } as never) : record;
  };
  const open = (objects: ObjectStore, root = tmp("sessions")) => {
    const sessions = new FileSessionStore(root, origin());
    return { sessions, org: new OrgStore({ objects, impl: marley }, sessions) };
  };
  const labels = { procedure: "marley-chat", env: "staging", brand: "brand-1", role: "front", kind: "dm" };

  test("a root session is published transcripts first, session.json last, with an ids-only row and a day shard", async () => {
    const puts: string[] = [];
    const inner = gcsObjectStore({ bucket: "pub1", accessToken: async () => "t", baseUrl: gcs.url });
    const objects: ObjectStore = { ...inner, put: async (key, data, options) => (puts.push(key), inner.put(key, data, options)) };
    const { sessions, org } = open(objects);
    const root = session(sessions, labels);
    const fork = sessions.create({ title: "f", runtime: "claude", parentId: root.id, labels: { ...labels, role: "worker" }, native: { sessionId: "n-fork" } } as never);
    sessions.appendMessage(root.id, { role: "user", content: "my phone is 555-0100 and my secret is hunter2" });
    sessions.appendMessage(fork.id, { role: "assistant", content: "done" });
    const published = await org.publish(root.id);
    assert.ok(published);
    const dir = published.dir;
    assert.match(dir, new RegExp(`^sdk/v1/zygstinct/marley/env=staging/brand=brand-1/${root.createdAt.slice(0, 10)}/${root.id}$`));
    const order = puts.filter((key) => key.startsWith(dir));
    assert.equal(order.at(-1), `${dir}/session.json`, "session.json is the commit marker, written after every transcript");
    assert.ok(order.slice(0, -1).every((key) => key.includes("/transcripts/")));
    assert.equal(order.length, 3, "two members' transcripts and session.json");
    assert.ok(gcs.objects.has("sdk/v1/zygstinct/marley/_impl.json"));
    const rows = await listIndex({ objects, impl: marley, partition: { env: "staging", brand: "brand-1" } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, root.id);
    assert.equal(rows[0]!.members.length, 2);
    const rowJson = JSON.stringify(rows[0]);
    assert.ok(!rowJson.includes("hunter2") && !rowJson.includes("555-0100"), "no message text in an index row");
    assert.ok([...gcs.objects.keys()].some((key) => key.endsWith(`${root.createdAt.slice(0, 10)}.jsonl`) && key.startsWith("sdk-index/v1/zygstinct/marley/env=staging/brand=brand-1/")));
    // Filters are exact matches on labels and a prefix of the partition keys; the order is newest first, not a rank.
    assert.equal((await listIndex({ objects, impl: marley, where: { role: "front" } })).filter((row) => row.id === root.id).length, 1);
    assert.equal((await listIndex({ objects, impl: marley, partition: { env: "staging", brand: "other" } })).length, 0);
  });

  test("a session missing a partition label publishes nothing", async () => {
    const objects = fsObjectStore(tmp("missing"));
    const { sessions, org } = open(objects);
    const root = session(sessions, { procedure: "marley-chat", env: "staging" });
    assert.equal(await org.publish(root.id), undefined);
    assert.deepEqual(await objects.list(""), []);
  });

  test("two writers compacting one day with different sessions lose no row, and a stale generation retries", async () => {
    const objects = fsObjectStore(tmp("race"));
    const a = open(objects);
    const b = open(objects);
    const day = "2026-11-10";
    const one = session(a.sessions, labels, `${day}T09:00:00.000Z`);
    const two = session(b.sessions, labels, `${day}T10:00:00.000Z`);
    await Promise.all([a.org.publish(one.id), b.org.publish(two.id)]);
    await Promise.all([a.org.compactDay("env=staging/brand=brand-1", day), b.org.compactDay("env=staging/brand=brand-1", day)]);
    const shard = Buffer.from((await objects.get(`sdk-index/v1/zygstinct/marley/env=staging/brand=brand-1/${day}.jsonl`))!).toString().trim().split("\n");
    assert.deepEqual(shard.map((line) => JSON.parse(line).id).sort(), [one.id, two.id].sort());
    // A writer that read an old shard generation retries instead of overwriting.
    let raced = false;
    const racy: ObjectStore = {
      ...objects,
      put: async (key, data, options) => {
        if (!raced && key.endsWith(`${day}.jsonl`)) {
          raced = true;
          await objects.put(key, Buffer.from(data as string) + "", {});
        }
        return objects.put(key, data, options);
      },
    };
    const c = open(racy);
    const three = session(c.sessions, labels, `${day}T11:00:00.000Z`);
    await c.org.publish(three.id);
    const rows = await listIndex({ objects, impl: marley });
    assert.deepEqual(rows.map((row) => row.id).sort(), [one.id, two.id, three.id].sort());
  });

  test("a restart mid-publish leaves no row: the row is written after session.json", async () => {
    const objects = fsObjectStore(tmp("crash"));
    const failing: ObjectStore = { ...objects, put: async (key, data, options) => { if (key.endsWith("session.json")) throw new Error("crash"); return objects.put(key, data, options); } };
    const { sessions, org } = open(failing);
    const root = session(sessions, labels);
    await assert.rejects(org.publish(root.id), /crash/);
    assert.deepEqual(await listIndex({ objects, impl: marley }), []);
  });
});

describe("OrgStore fixed labels", () => {
  test("a deployment-wide label (env) completes the partition for sessions that do not carry it", async () => {
    const objects = fsObjectStore(tmp("fixed"));
    const sessions = new FileSessionStore(tmp("fixed-s"), origin());
    const org = new OrgStore({ objects, impl: marley, fixedLabels: { env: "local" } }, sessions);
    const record = sessions.create({ title: "t", runtime: "claude", labels: { procedure: "marley-chat", brand: "brand-9" }, native: { sessionId: "n" } } as never);
    const published = await org.publish(record.id);
    assert.match(published!.dir, /^sdk\/v1\/zygstinct\/marley\/env=local\/brand=brand-9\//);
    assert.deepEqual((await listIndex({ objects, impl: marley, partition: { env: "local" } })).map((row) => row.id), [record.id]);
  });
});

describe("OrgTranscriptStore, the Agent SDK sessionStore on a bucket", () => {
  const setup = (isCurrent?: (id: string) => boolean) => {
    const objects = gcsObjectStore({ bucket: `t${Math.random().toString(16).slice(2)}`, accessToken: async () => "t", baseUrl: gcs.url });
    const sessions = new FileSessionStore(tmp("ts"), origin());
    const org = new OrgStore({ objects, impl: marley }, sessions, isCurrent);
    const record = sessions.create({ title: "t", runtime: "claude", labels: { procedure: "marley-chat", env: "staging", brand: "brand-1" }, native: { sessionId: "n1" } } as never);
    return { objects, sessions, org, id: record.id, bound: org.transcripts.bind(record.id) };
  };
  const key = { projectKey: "p", sessionId: "n1" };

  test("batches are create-only objects, load dedupes by uuid, compose folds them without changing what load returns", async () => {
    const { objects, org, id, bound } = setup();
    await bound.append(key, [{ type: "user", uuid: "u1" }, { type: "assistant", uuid: "a1" }]);
    await bound.append(key, [{ type: "assistant", uuid: "a1" }, { type: "user", uuid: "u2" }]);
    await bound.append({ ...key, subpath: "subagents/agent-1" }, [{ type: "user", uuid: "s1" }]);
    const dir = org.locate(id)!;
    await org.transcripts.drain(id);
    assert.equal((await objects.list(`${dir}/native/_batches/`)).length, 3);
    const before = await bound.load(key);
    assert.deepEqual(before!.map((entry) => entry.uuid), ["u1", "a1", "u2"]);
    assert.deepEqual(await bound.listSubkeys!(key), ["subagents/agent-1"]);
    await org.transcripts.compose(id);
    assert.equal((await objects.list(`${dir}/native/_batches/`)).length, 0);
    assert.ok((await objects.list(`${dir}/native/`)).includes(`${dir}/native/n1.jsonl`));
    assert.deepEqual((await bound.load(key))!.map((entry) => entry.uuid), ["u1", "a1", "u2"]);
    assert.deepEqual((await bound.load({ ...key, subpath: "subagents/agent-1" }))!.map((entry) => entry.uuid), ["s1"]);
    assert.deepEqual(await bound.listSubkeys!(key), ["subagents/agent-1"]);
    await bound.append(key, [{ type: "user", uuid: "u3" }]);
    await org.transcripts.compose(id);
    assert.deepEqual((await bound.load(key))!.map((entry) => entry.uuid), ["u1", "a1", "u2", "u3"]);
    await bound.delete!(key);
    assert.equal(await bound.load(key), null);
  });

  test("R31: append returns before the cloud write; load, compose and close wait for it; a failed write is kept and retried", async () => {
    let delay = 400;
    let failures = 1;
    const base = fsObjectStore(tmp("wb"));
    const objects = {
      ...base,
      get: base.get.bind(base),
      read: base.read.bind(base),
      list: base.list.bind(base),
      listInfo: base.listInfo.bind(base),
      compose: base.compose.bind(base),
      delete: base.delete.bind(base),
      async put(name: string, data: Uint8Array | string, options?: never) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (failures > 0 && name.includes("_batches")) { failures--; throw new Error("503"); }
        return base.put(name, data, options);
      },
    };
    const sessions = new FileSessionStore(tmp("wb-s"), origin());
    const org = new OrgStore({ objects, impl: marley }, sessions);
    const record = sessions.create({ title: "t", runtime: "claude", labels: { procedure: "marley-chat", env: "staging", brand: "brand-1" }, native: { sessionId: "n1" } } as never);
    const bound = org.transcripts.bind(record.id);
    const started = Date.now();
    await bound.append(key, [{ type: "user", uuid: "u1" }]);
    await bound.append(key, [{ type: "assistant", uuid: "a1" }]);
    assert.ok(Date.now() - started < 100, "append does not wait for the cloud");
    assert.deepEqual((await bound.load(key))!.map((entry) => entry.uuid), ["u1", "a1"], "a load sees what this process appended, in order, after the failed write was retried");
    delay = 0;
    await bound.append(key, [{ type: "user", uuid: "u2" }]);
    await org.close();
    assert.deepEqual((await bound.load(key))!.map((entry) => entry.uuid), ["u1", "a1", "u2"]);
  });

  test("more than 31 batches compose in chunks", async () => {
    const { org, id, bound } = setup();
    for (let index = 0; index < 70; index++) await bound.append(key, [{ type: "user", uuid: `u${index}` }]);
    await org.transcripts.compose(id);
    assert.equal((await bound.load(key))!.length, 70);
  });

  test("R31: a warm machine reads nothing from the cloud on resume; a cold one loads the transcript", async () => {
    let warm = false;
    const { bound, objects } = setup((id) => warm && id === "n1");
    await bound.append(key, [{ type: "user", uuid: "u1" }]);
    const before = gcs.requests.length;
    warm = true;
    assert.equal(await bound.load(key), null);
    assert.equal(gcs.requests.length, before, "no request at all for a warm resume");
    warm = false;
    assert.equal((await bound.load(key))!.length, 1);
    assert.ok(gcs.requests.length > before);
    void objects;
  });
});

describe("the agent port with the org store", () => {
  test("a session reads idle without waiting for the cloud, and a warm resume makes no load", async () => {
    const root = tmp("port");
    const sessions = new FileSessionStore(root, origin());
    let loads = 0;
    let warm = false;
    const slow = new Map<string, unknown[]>();
    const transcripts = {
      bind: () => ({
        async append(_key: unknown, entries: unknown[]) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          slow.set("n", [...(slow.get("n") ?? []), ...entries]);
        },
        async load() {
          loads++;
          return warm ? null : ((slow.get("n") ?? null) as never);
        },
      }),
      async append() {},
      async load() { return null; },
    };
    sessions.transcripts = transcripts as never;
    let mirror: Promise<void> | undefined;
    const backend: QueryFn = ({ options }) => {
      const store = options.sessionStore as { append(k: unknown, e: unknown[]): Promise<void>; load(k: unknown): Promise<unknown[] | null> };
      return (async function* () {
        if (typeof options.resume === "string") await store.load({ projectKey: "p", sessionId: options.resume });
        yield { type: "system", subtype: "init", session_id: "native-1" };
        mirror = store.append({ projectKey: "p", sessionId: "native-1" }, [{ type: "user", uuid: "u" }]);
        yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    };
    const port = new ClaudeAgentPort({ query: backend, store: sessions, cwd: "/w", env: {}, defaultModel: "m", systemPrompt: () => "host", mcpServers: () => ({}) });
    const started = Date.now();
    const agent = port.launch({ task: "hi", idempotencyKey: "k", labels: {} } as never);
    await port.wait(agent.id, 5_000);
    assert.ok(Date.now() - started < 1000, `idle took ${Date.now() - started} ms; the 1500 ms cloud write must not be waited for`);
    assert.equal(sessions.get(agent.id)!.state, "idle");
    await mirror;
    assert.equal(loads, 0, "a first turn does not load");
    warm = true;
    port.send(agent.id, "again");
    await port.wait(agent.id, 5_000);
    assert.equal(loads, 1, "the resume asked, and was told the machine is current");
    assert.equal(slow.get("n")!.length >= 1, true);
  });
});
