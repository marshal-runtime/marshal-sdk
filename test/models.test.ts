import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMarshalHost } from "../src/host.js";
import { createDecideService } from "../src/models/decide.js";
import { createEmbedService, EmbedError, formatForGemini } from "../src/models/embed.js";
import { createModelServices } from "../src/models/index.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${call.url}`);
    return typeof next === "function" ? next(call) : next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const body = (call: Call) => JSON.parse(String(call.init.body));
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

function chat(output: unknown, usage = { prompt_tokens: 120, completion_tokens: 30 }) {
  return json({ model: "gpt-5-mini-2026", choices: [{ message: { content: JSON.stringify(output) } }], usage });
}

/** A structurally valid Ogg Opus file with no real audio (copied from zygstinct packages/speech/test/support.ts). */
function fakeOggOpus(seconds = 2): Buffer {
  const page = (serial: number, seq: number, granule: bigint, flags: number, content: Buffer) => {
    const head = Buffer.alloc(28);
    head.write("OggS", 0, "latin1");
    head[5] = flags;
    head.writeBigUInt64LE(granule, 6);
    head.writeUInt32LE(serial, 14);
    head.writeUInt32LE(seq, 18);
    head[26] = 1;
    head[27] = content.length;
    return Buffer.concat([head, content]);
  };
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "latin1");
  opusHead[8] = 1;
  opusHead[9] = 1;
  opusHead.writeUInt16LE(312, 10);
  opusHead.writeUInt32LE(48000, 12);
  const tags = Buffer.from("OpusTags\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000", "latin1");
  return Buffer.concat([page(1, 0, 0n, 2, opusHead), page(1, 1, 0n, 0, tags), page(1, 2, BigInt(seconds * 48000 + 312), 4, Buffer.from([1, 2, 3]))]);
}

const ENV = { OPENAI_API_KEY: "sk-test-openai" };

test("decide on Jev: options become a choice question; the ranking comes back as a full, validated distribution", async () => {
  const fake = fakeFetch([chat({ decision: { ranking: [{ option: "ship", probability: 0.7 }, { option: "wait", probability: 0.2 }] } })]);
  const decide = createDecideService({}, { fetch: fake.fetch, env: ENV });
  const result = await decide.decide({ question: "Ship the release today?", options: ["ship", "wait", "cancel"], context: { ci: "green" } });
  assert.equal(result.choice, "ship");
  assert.equal(result.provider, "jev");
  assert.ok(Math.abs(result.probabilities!.ship! - 0.7 / 0.9) < 1e-9);
  assert.equal(result.probabilities!.cancel, 0);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30 });
  const sent = body(fake.calls[0]!);
  assert.equal(fake.calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(header(fake.calls[0]!, "authorization"), "Bearer sk-test-openai");
  assert.equal(sent.model, "gpt-5-mini");
  assert.deepEqual(JSON.parse(sent.messages[1].content).state, { ci: "green" });
  assert.deepEqual(sent.response_format.json_schema.schema.properties.decision.properties.ranking.items.properties.option.enum, ["ship", "wait", "cancel"]);
});

test("decide on Jev without options is yes/no; the key can come from a file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-key-"));
  fs.writeFileSync(path.join(dir, "key"), "sk-from-file\n");
  const fake = fakeFetch([chat({ decision: { probability_true: 0.2 } })]);
  const decide = createDecideService({}, { fetch: fake.fetch, env: { OPENAI_API_KEY_FILE: path.join(dir, "key") } });
  const result = await decide.decide({ question: "Is the page broken on a phone?" });
  assert.equal(result.choice, false);
  assert.equal(result.confidence, 0.8);
  assert.equal(header(fake.calls[0]!, "authorization"), "Bearer sk-from-file");
});

test("decide on OpenAI: one structured answer, an option outside the list is refused, a schema fills an object", async () => {
  const fake = fakeFetch([
    chat({ choice: "wait", confidence: 0.9, reasoning: "CI is red." }),
    chat({ choice: "explode", confidence: 1, reasoning: "?" }),
    chat({ answer: { severity: "high", owner: "bar" }, reasoning: "Payments are down." }),
  ]);
  const decide = createDecideService({ provider: "openai", model: "gpt-5-nano" }, { fetch: fake.fetch, env: ENV });
  const picked = await decide.decide({ question: "Ship?", options: { ship: "Ship now", wait: "Hold until CI is green" } });
  assert.deepEqual([picked.choice, picked.confidence, picked.reasoning, picked.provider, picked.model], ["wait", 0.9, "CI is red.", "openai", "gpt-5-mini-2026"]);
  assert.deepEqual(body(fake.calls[0]!).response_format.json_schema.schema.properties.choice.enum, ["ship", "wait"]);
  await assert.rejects(decide.decide({ question: "Ship?", options: ["ship", "wait"] }), /not one of the options/);
  const filled = await decide.decide({
    question: "Triage this alert",
    schema: { type: "object", properties: { severity: { enum: ["low", "high"] }, owner: { type: "string" } }, required: ["severity", "owner"], additionalProperties: false },
  });
  assert.deepEqual(filled.choice, { severity: "high", owner: "bar" });
});

test("decide without a key says which variable to set; Jev's own contract (judge) answers several questions at once", async () => {
  await assert.rejects(createDecideService({}, { env: {} }).decide({ question: "x" }), /OPENAI_API_KEY/);
  const fake = fakeFetch([chat({ pick: { ranking: [{ option: "a", probability: 1 }] }, broken: { probability_true: 0.9 } })]);
  const judged = await createDecideService({}, { fetch: fake.fetch, env: ENV }).judge({
    state: "page html",
    questions: { pick: { type: "choice", criteria: { a: "first", b: "second" } }, broken: { type: "noul" } },
  });
  assert.equal((judged.answers.pick as { choice: string }).choice, "a");
  assert.equal((judged.answers.broken as { noul: number }).noul, 0.9);
});

test("embed on Gemini with an API key: the proxy's task wording, requested dimensions, L2-normalized vectors in order", async () => {
  const fake = fakeFetch([
    json({ embedding: { values: [3, 4, 0] }, usageMetadata: { promptTokenCount: 7 } }),
    json({ embedding: { values: [0, 0, 2] }, usageMetadata: { promptTokenCount: 5 } }),
  ]);
  const embed = createEmbedService({ concurrency: 1 }, { fetch: fake.fetch, env: { GEMINI_API_KEY: "gm-key" } });
  const result = await embed.embed({ texts: ["first", "second"], task: "document", dimensions: 3 });
  assert.deepEqual(result.vectors, [[0.6, 0.8, 0], [0, 0, 1]]);
  assert.deepEqual([result.provider, result.model, result.dimensions, result.tokens], ["gemini", "gemini-embedding-2", 3, 12]);
  assert.equal(fake.calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent");
  assert.equal(header(fake.calls[0]!, "x-goog-api-key"), "gm-key");
  assert.deepEqual(body(fake.calls[0]!), { content: { parts: [{ text: "title: none | text: first" }] }, outputDimensionality: 3 });
  assert.equal(formatForGemini("find invoices", "query"), "task: code retrieval | query: find invoices");
});

test("embed on Gemini through Vertex: bearer token from ADC, the project's endpoint; a wrong-sized vector is refused", async () => {
  const fake = fakeFetch([json({ embedding: { values: [1, 0] } }), json({ embedding: { values: [1, 0, 0] } })]);
  const embed = createEmbedService({ project: "zyg-ecom-zygstinct" }, { fetch: fake.fetch, env: {}, googleToken: async () => "ya29.token" });
  const result = await embed.embed({ texts: ["q"], task: "query", dimensions: 2 });
  assert.deepEqual(result.vectors, [[1, 0]]);
  assert.equal(
    fake.calls[0]!.url,
    "https://aiplatform.googleapis.com/v1/projects/zyg-ecom-zygstinct/locations/global/publishers/google/models/gemini-embedding-2:embedContent",
  );
  assert.equal(header(fake.calls[0]!, "authorization"), "Bearer ya29.token");
  await assert.rejects(embed.embed({ texts: ["q"], task: "query", dimensions: 2 }), (error: unknown) => error instanceof EmbedError && error.code === "invalid-vector");
});

test("embed swaps to the local model: same call, the local embedder's vectors; a missing local runtime says what to install", async () => {
  let loads = 0;
  const local = createEmbedService(
    { provider: "local" },
    {
      loadLocal: async () => {
        loads++;
        return { model: "mixedbread-ai/mxbai-embed-xsmall-v1", dimensions: 2, embed: async (texts) => texts.map(() => [2, 0]) };
      },
    },
  );
  const result = await local.embed({ texts: ["a", "b"], task: "query" });
  await local.embed({ texts: ["c"], task: "document" });
  assert.deepEqual(result.vectors, [[1, 0], [1, 0]]);
  assert.deepEqual([result.provider, result.model, result.dimensions, loads], ["local", "mixedbread-ai/mxbai-embed-xsmall-v1", 2, 1]);
  await assert.rejects(local.embed({ texts: ["a"], task: "query", dimensions: 384 }), /gives 2 dimensions/);
  const missing = createEmbedService({ provider: "local" });
  await assert.rejects(missing.embed({ texts: ["a"], task: "query" }), (error: unknown) => error instanceof EmbedError && error.code === "not-installed");
});

test("speech: Google Gemini TTS gives a WhatsApp voice note; ElevenLabs transcribes when it is the chosen provider", async () => {
  const voice = fakeOggOpus(2);
  const fake = fakeFetch([
    json({ audioContent: voice.toString("base64") }),
    json({ text: " שלום עולם ", language_code: "heb", audio_duration_secs: 1.5 }),
  ]);
  const models = createModelServices(
    { speech: { sttProvider: "elevenlabs", ttsProvider: "google" } },
    { fetch: fake.fetch, env: { GOOGLE_ACCESS_TOKEN: "ya29.speech", ELEVENLABS_API_KEY: "el-key" } },
  );
  const spoken = await models.speech().synthesize({ text: "Hello there", language: "en" });
  assert.equal(spoken.provider, "google");
  assert.equal(spoken.mimeType, "audio/ogg");
  assert.equal(fake.calls[0]!.url, "https://texttospeech.googleapis.com/v1/text:synthesize");
  assert.equal(header(fake.calls[0]!, "authorization"), "Bearer ya29.speech");
  assert.equal(body(fake.calls[0]!).voice.modelName, "gemini-2.5-flash-tts");
  const heard = await models.speech().transcribe({ audio: voice, mimeType: "audio/ogg" });
  assert.deepEqual([heard.text, heard.provider, heard.durationSec], ["שלום עולם", "elevenlabs", 1.5]);
  assert.equal(header(fake.calls[1]!, "xi-api-key"), "el-key");
  assert.deepEqual(models.describe(), {
    decide: { provider: "jev", model: "gpt-5-mini" },
    embed: { provider: "gemini", model: "gemini-embedding-2" },
    speech: { tts: "google", stt: "elevenlabs" },
  });
});

test("a host exposes host.models and the marshal.models.* capabilities with the manifest's providers", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-models-")));
  fs.mkdirSync(path.join(root, "workspace"));
  const fake = fakeFetch([
    chat({ decision: { ranking: [{ option: "b", probability: 1 }] } }),
    json({ embedding: { values: [0, 5] } }),
    json({ audioContent: fakeOggOpus(1).toString("base64") }),
  ]);
  const host = await createMarshalHost({
    workspacePath: path.join(root, "workspace"),
    stateRoot: path.join(root, "state"),
    browser: false,
    automations: { start: false },
    env: { OPENAI_API_KEY: "sk-host", GEMINI_API_KEY: "gm-host", GOOGLE_ACCESS_TOKEN: "ya29.host" },
    models: { embed: { dimensions: 2 }, speech: { ttsProvider: "google" } },
    modelsFetch: fake.fetch,
  });
  try {
    assert.equal(host.models.embed.provider, "gemini");
    const decided = await host.invoke<any>("marshal.models.decide", { question: "Which?", options: ["a", "b"] });
    assert.deepEqual([decided.success, decided.choice, decided.provider], [true, "b", "jev"]);
    const embedded = await host.invoke<any>("marshal.models.embed", { texts: ["x"], task: "query" });
    assert.deepEqual([embedded.success, embedded.vectors, embedded.dimensions], [true, [[0, 1]], 2]);
    const spoken = await host.invoke<any>("marshal.models.speak", { text: "Hi", language: "en" });
    assert.deepEqual([spoken.success, spoken.mimeType, spoken.provider], [true, "audio/ogg", "google"]);
    assert.ok(Buffer.from(spoken.audioBase64, "base64").subarray(0, 4).equals(Buffer.from("OggS")));
    const failed = await host.invoke<any>("marshal.models.embed", { texts: ["x"], task: "query", dimensions: 99999 });
    assert.deepEqual([failed.success, failed.code], [false, "bad-request"]);
  } finally {
    await host.dispose();
  }
});
