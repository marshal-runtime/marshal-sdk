import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CloudCache } from "../src/cache";
import { configuredProcedures, listProcedureRuns, messagesOf, ProcedureCache, procedureTranscript, type ProcedureGroup } from "../src/procedures";

const NOW = new Date("2026-11-16T12:00:00Z");
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `procedures-${name}-`));

/** A records folder as the SDK's directoryRunSink writes it (runs/<id>/summary.json + sessions/<s>.jsonl). */
function writeRun(root: string, fields: { day?: string; workflow?: string; hash: string; brand: string; conversation: string; env: string; kind?: string; text?: string }) {
  const workflow = fields.workflow ?? "marley-chat";
  const runId = `${fields.day ?? "2026-11-16"}-${workflow}-${fields.hash}`;
  const dir = path.join(root, "runs", runId);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const session = `front-${fields.hash.slice(0, 8)}`;
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      version: 1,
      runId,
      workflow,
      source: "chat",
      title: `${workflow} · ${fields.brand} · ${fields.conversation} · ${fields.kind ?? "dm"} · ${fields.env}`,
      status: "succeeded",
      startedAt: `${fields.day ?? "2026-11-16"}T08:00:00.000Z`,
      costUsd: 0.05,
      links: [{ kind: "chat", key: `${fields.brand}:${fields.conversation}`, role: "origin" }],
      labels: { procedure: workflow, env: fields.env, brand: fields.brand, conversation: fields.conversation, channel: "whatsapp", kind: fields.kind ?? "dm" },
      sessions: [{ session, role: "front", status: "succeeded", turns: 1 }],
      counts: { events: 4 },
    }),
  );
  fs.writeFileSync(
    path.join(dir, "sessions", `${session}.jsonl`),
    [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "How were sales yesterday?" }] }, timestamp: "2026-11-16T08:00:00.000Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "zs.data.query", input: { q: 1 } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "rows: 7" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: fields.text ?? "41 orders yesterday." }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return { runId, session };
}

function seed() {
  const root = tmp("records");
  writeRun(root, { hash: "aaaaaaaaaaa1", brand: "test-brand-pine", conversation: "dm-1", env: "local" });
  writeRun(root, { hash: "aaaaaaaaaaa2", brand: "test-brand-pine", conversation: "dm-2", env: "staging" });
  writeRun(root, { hash: "aaaaaaaaaaa3", brand: "test-brand-sunrise", conversation: "group-1", env: "production", kind: "group" });
  writeRun(root, { hash: "aaaaaaaaaaa4", workflow: "marley-routine", brand: "test-brand-sunrise", conversation: "dm-3", env: "production" });
  writeRun(root, { hash: "bbbbbbbbbbb1", workflow: "slack-turn", brand: "x", conversation: "y", env: "production" });
  writeRun(root, { day: "2026-10-01", hash: "ccccccccccc1", brand: "test-brand-old", conversation: "dm-9", env: "production" });
  const group: ProcedureGroup = { id: "marley", name: "Marley", prefix: "marley-", sources: [root] };
  return { root, group };
}

test("lists only the group's runs of the window, as rows, with workflow, brand and env facets and filters", async () => {
  const { group } = seed();
  const all = await listProcedureRuns(group, {}, NOW);
  assert.deepEqual(all.runs.map((run) => run.conversation).sort(), ["dm-1", "dm-2", "dm-3", "group-1"]);
  assert.deepEqual(all.facets, { workflows: ["marley-chat", "marley-routine"], brands: ["test-brand-pine", "test-brand-sunrise"], envs: ["local", "staging", "production"] });
  for (const run of all.runs) {
    assert.equal(Object.hasOwn(run, "messages"), false);
    assert.ok(!JSON.stringify(run).includes("sales"), "a row carries no message text");
  }
  const chat = await listProcedureRuns(group, { workflow: "marley-chat", brand: "test-brand-pine", env: "staging" }, NOW);
  assert.deepEqual(chat.runs.map((run) => [run.workflow, run.brand, run.env, run.conversation]), [["marley-chat", "test-brand-pine", "staging", "dm-2"]]);
  assert.equal((await listProcedureRuns(group, { days: 60 }, NOW)).runs.length, 4, "days is capped at 31, so a run 46 days back stays out");
});

test("opens a transcript on demand, serves the second open from the cache, and marks the run restricted", async () => {
  const { group } = seed();
  const cacheDir = tmp("cache");
  const cache = new ProcedureCache(new CloudCache(cacheDir));
  const { runs } = await listProcedureRuns(group, { brand: "test-brand-pine", env: "local" }, NOW);
  assert.equal(fs.readdirSync(cacheDir).length, 0, "listing downloads nothing");
  const run = runs[0]!;
  const lines: string[] = [];
  const first = await procedureTranscript(group, { source: run.source, runId: run.id, session: run.sessions[0]!.session }, cache, (line) => lines.push(line));
  assert.equal(first.servedFrom, "source");
  assert.deepEqual(first.messages.map((message) => message.role), ["user", "tool", "tool", "assistant"]);
  fs.rmSync(path.join(group.sources[0]!, "runs", run.id), { recursive: true });
  const second = await procedureTranscript(group, { source: run.source, runId: run.id, session: run.sessions[0]!.session }, cache, (line) => lines.push(line));
  assert.equal(second.servedFrom, "cache");
  assert.deepEqual(second.messages, first.messages);
  assert.match(lines[1]!, /served from cache/);
  const file = cache.fileOf(run.source, run.id, `${run.sessions[0]!.session}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(file)), ".restricted")));
  assert.equal(cache.cloud.clearRestricted(), 1, "the cloud cache's sign-out wipe clears it");
  assert.equal(fs.existsSync(file), false);
});

test("keeps the cache under its cap, least recently used out first", async () => {
  const { group } = seed();
  const { runs } = await listProcedureRuns(group, { workflow: "marley-chat" }, NOW);
  const size = fs.statSync(path.join(group.sources[0]!, "runs", runs[0]!.id, "sessions", `${runs[0]!.sessions[0]!.session}.jsonl`)).size;
  const cache = new ProcedureCache(new CloudCache(tmp("lru"), Math.floor(size * 2.5)));
  const open = (index: number) => procedureTranscript(group, { source: runs[index]!.source, runId: runs[index]!.id, session: runs[index]!.sessions[0]!.session }, cache);
  await open(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await open(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await open(0)).servedFrom, "cache", "touching 0 makes 1 the oldest");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await open(2);
  const present = runs.slice(0, 3).map((run) => fs.existsSync(cache.fileOf(run.source, run.id, `${run.sessions[0]!.session}.jsonl`)));
  assert.deepEqual(present, [true, false, true]);
});

test("refuses a source, run or session outside the group", async () => {
  const { group } = seed();
  const cache = new ProcedureCache(new CloudCache(tmp("refuse")));
  const { runs } = await listProcedureRuns(group, {}, NOW);
  const run = runs[0]!;
  await assert.rejects(procedureTranscript(group, { source: "/etc", runId: run.id, session: run.sessions[0]!.session }, cache), /not a source/);
  await assert.rejects(procedureTranscript(group, { source: run.source, runId: "2026-11-16-slack-turn-bbbbbbbbbbb1", session: "front-bbbbbbbb" }, cache), /not a Marley run/);
  await assert.rejects(procedureTranscript(group, { source: run.source, runId: run.id, session: "../../summary" }, cache), /Bad session/);
});

test("configures the Marley group from configuration or MARSHAL_SDK_MARLEY_RUNS", () => {
  const before = process.env.MARSHAL_SDK_MARLEY_RUNS;
  process.env.MARSHAL_SDK_MARLEY_RUNS = "/a:gs://bucket";
  try {
    assert.deepEqual(configuredProcedures({}).map((group) => [group.id, group.sources]), [["marley", ["/a", "gs://bucket"]]]);
    assert.deepEqual(configuredProcedures({ procedures: [{ id: "marley", name: "Marley", sources: ["/b"] }] }).map((group) => group.sources), [["/b"]]);
  } finally {
    if (before === undefined) delete process.env.MARSHAL_SDK_MARLEY_RUNS;
    else process.env.MARSHAL_SDK_MARLEY_RUNS = before;
  }
});

test("reads user, assistant and tool lines of a session stream", () => {
  const out = messagesOf('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\nnot json\n{"type":"assistant","message":{"content":"hello"}}\n');
  assert.deepEqual(out, [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]);
});
