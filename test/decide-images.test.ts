import assert from "node:assert/strict";
import { test } from "node:test";

import { createDecideService } from "../src/models/decide.js";
import { createModelServices, createModelsProvider } from "../src/models/index.js";

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
const chat = (output: unknown) => json({ model: "gpt-5-mini-2026", choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 900, completion_tokens: 20 } });

const ENV = { OPENAI_API_KEY: "sk-test" };
const SHOT = "data:image/png;base64,iVBORw0KGgo=";
const BUTTON = "https://example.com/button.png";

const STEP_QUESTIONS = {
  next_action: { type: "choice" as const, criteria: { "click e12": "the Sign in button", scroll_down: "" }, instructions: "Which ONE action next?" },
  goal_met: { type: "predicate" as const, instructions: "Is the goal met?" },
  needs_owner: { type: "predicate" as const, instructions: "Is this a login or payment step?" },
  page_ready: { type: "predicate" as const, instructions: "Is the page ready?", images: [{ url: BUTTON, detail: "low" as const }] },
};

test("decisions: a step's choice and three yes/no questions go in ONE request, the screenshot on the state, a question's own image in its instructions", async () => {
  const { fetch, calls } = fakeFetch([
    json({
      model: "gpt-6-luna",
      answers: [
        { type: "choice", name: "next_action", choice: "click e12", confidence: 0.9, probabilities: [{ value: "click e12", probability: 0.9 }, { value: "scroll_down", probability: 0.1 }] },
        { type: "predicate", name: "goal_met", probability: 0.04 },
        { type: "refusal", name: "needs_owner" },
        { type: "predicate", name: "page_ready", probability: 0.97 },
      ],
      usage: { input_tokens: 1400, output_tokens: 0 },
    }),
  ]);
  const decide = createDecideService({ provider: "decisions" }, { fetch, env: ENV });
  const judged = await decide.judge({ state: "e12 button 'Sign in'", images: [SHOT, { url: BUTTON, detail: "high" }], questions: STEP_QUESTIONS });

  assert.equal(calls.length, 1);
  const sent = body(calls[0]!);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/decisions");
  assert.deepEqual(sent.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "e12 button 'Sign in'" },
        { type: "input_image", image_url: SHOT },
        { type: "input_image", image_url: BUTTON, detail: "high" },
      ],
    },
  ]);
  assert.deepEqual(sent.questions.map((q: { type: string; name: string }) => [q.type, q.name]), [
    ["choice", "next_action"],
    ["predicate", "goal_met"],
    ["predicate", "needs_owner"],
    ["predicate", "page_ready"],
  ]);
  assert.equal(sent.questions[1].instructions, "Is the goal met?");
  assert.deepEqual(sent.questions[3].instructions, [
    { type: "input_text", text: "Is the page ready?" },
    { type: "input_image", image_url: BUTTON, detail: "low" },
  ]);

  assert.deepEqual(judged.answers.goal_met, { type: "predicate", probability: 0.04 });
  assert.deepEqual(judged.answers.page_ready, { type: "predicate", probability: 0.97 });
  assert.deepEqual(judged.answers.needs_owner, { type: "refusal" });
  const next = judged.answers.next_action as { type: string; choice: string; confidence: number };
  assert.equal(next.type, "choice");
  assert.equal(next.choice, "click e12");
  assert.ok(Math.abs(next.confidence - 0.9) < 1e-9);
  assert.equal(judged.usage.input_tokens, 1400);
});

test("decisions: decide() with images sends one user message of text and images; no images keeps the plain string input", async () => {
  const answer = json({ answers: [{ type: "choice", name: "decision", probabilities: [{ value: "e3", probability: 0.8 }, { value: "e9", probability: 0.2 }] }] });
  const { fetch, calls } = fakeFetch([answer, json({ answers: [{ type: "choice", name: "decision", probabilities: [{ value: "e3", probability: 1 }, { value: "e9", probability: 0 }] }] })]);
  const decide = createDecideService({ provider: "decisions" }, { fetch, env: ENV });
  const picked = await decide.decide({ question: "Which element holds the price?", options: ["e3", "e9"], context: "e3 $12, e9 Add to cart", images: [SHOT] });
  assert.equal(picked.choice, "e3");
  assert.deepEqual(body(calls[0]!).input, [{ role: "user", content: [{ type: "input_text", text: "e3 $12, e9 Add to cart" }, { type: "input_image", image_url: SHOT }] }]);
  await decide.decide({ question: "Which?", options: ["e3", "e9"], context: "no pictures" });
  assert.equal(body(calls[1]!).input, "no pictures");
});

test("jev (chat completions): the screenshot rides as an image_url part and a predicate comes back as a predicate, in one call", async () => {
  const { fetch, calls } = fakeFetch([
    chat({ next_action: { ranking: [{ option: "click e12", probability: 0.8 }, { option: "scroll_down", probability: 0.2 }] }, goal_met: { probability_true: 0.1 } }),
  ]);
  const decide = createDecideService({}, { fetch, env: ENV });
  const { next_action, goal_met } = STEP_QUESTIONS;
  const judged = await decide.judge({ state: "page", images: [{ url: SHOT, detail: "original" }], questions: { next_action, goal_met } });
  assert.equal(calls.length, 1);
  const sent = body(calls[0]!);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  const content = sent.messages[1].content;
  assert.equal(content[0].type, "text");
  assert.deepEqual(JSON.parse(content[0].text).questions.goal_met, { type: "noul", instructions: "Is the goal met?" });
  assert.deepEqual(content[1], { type: "image_url", image_url: { url: SHOT, detail: "high" } });
  assert.deepEqual(judged.answers.goal_met, { type: "predicate", probability: 0.1 });
  assert.equal((judged.answers.next_action as { choice: string }).choice, "click e12");
});

test("jev and openai refuse images on one question with JEV_UNSUPPORTED before sending anything", async () => {
  for (const provider of ["jev", "openai"] as const) {
    const { fetch, calls } = fakeFetch([]);
    const decide = createDecideService({ provider }, { fetch, env: ENV });
    await assert.rejects(decide.judge({ state: "page", images: [SHOT], questions: STEP_QUESTIONS }), (error: { code?: string; message: string }) => {
      assert.equal(error.code, "JEV_UNSUPPORTED");
      assert.match(error.message, /page_ready/);
      return true;
    });
    assert.equal(calls.length, 0, provider);
  }
});

test("a malformed image is a bad request, never dropped, and nothing is sent", async () => {
  const { fetch, calls } = fakeFetch([]);
  for (const provider of ["decisions", "jev"] as const) {
    const decide = createDecideService({ provider }, { fetch, env: ENV });
    await assert.rejects(decide.decide({ question: "?", options: ["a", "b"], images: ["/tmp/shot.png"] }), { code: "JEV_BAD_REQUEST" });
    await assert.rejects(decide.judge({ state: "x", images: [{ url: SHOT, detail: "max" as never }], questions: { q: { type: "predicate", instructions: "?" } } }), { code: "JEV_BAD_REQUEST" });
  }
  assert.equal(calls.length, 0);
});

test("a schema answer (rung 2) takes the screenshot too, on chat completions even when the provider is decisions", async () => {
  const { fetch, calls } = fakeFetch([chat({ answer: { total: "49.90", currency: "EUR" }, reasoning: "read from the summary box" })]);
  const decide = createDecideService({ provider: "decisions" }, { fetch, env: ENV });
  const read = await decide.decide({
    question: "Read the order total",
    context: "checkout page",
    images: [SHOT],
    schema: { type: "object", properties: { total: { type: "string" }, currency: { type: "string" } }, required: ["total", "currency"], additionalProperties: false },
  });
  assert.deepEqual(read.choice, { total: "49.90", currency: "EUR" });
  const sent = body(calls[0]!);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent.model, "gpt-5-mini");
  assert.deepEqual(sent.messages[1].content[1], { type: "image_url", image_url: { url: SHOT } });
});

test("marshal.models.decide: images and predicate questions pass through; a refusal is a typed failure output, not a throw", async () => {
  const { fetch, calls } = fakeFetch([
    json({ answers: [{ type: "predicate", name: "goal_met", probability: 0.7 }], usage: { input_tokens: 800, output_tokens: 0 } }),
  ]);
  const provider = createModelsProvider(createModelServices({ decide: { provider: "jev" } }, { fetch, env: ENV }));
  const descriptors = (await provider.list({} as never)) as unknown as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
  assert.ok(descriptors.find((descriptor) => descriptor.name === "marshal.models.decide")?.inputSchema.properties.images);

  const judged = (await provider.invoke("marshal.models.decide", { provider: "decisions", state: "page", images: [SHOT], questions: { goal_met: { type: "predicate", instructions: "Done?" } } }, {} as never)) as { output: any };
  assert.equal(judged.output.success, true);
  assert.deepEqual(judged.output.answers.goal_met, { type: "predicate", probability: 0.7 });
  assert.equal(body(calls[0]!).input[0].content[1].image_url, SHOT);

  const refused = (await provider.invoke("marshal.models.decide", { state: "page", questions: STEP_QUESTIONS }, {} as never)) as { output: any };
  assert.deepEqual([refused.output.success, refused.output.code], [false, "JEV_UNSUPPORTED"]);
  assert.equal(calls.length, 1);
});
