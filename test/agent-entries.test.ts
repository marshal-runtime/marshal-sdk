import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

import { fillTask, profileFingerprint, readExtensionAgents, resolveAgent } from "../src/agent-entries.js";
import { systemPromptText, type QueryFn } from "../src/agent-port.js";
import type { FireDecision } from "../src/automations.js";
import { createMarshalHost, type MarshalHost } from "../src/host.js";
import { parseRoutineFile, routineAutomations } from "../src/routine-file.js";
import { labelRunGrouping } from "../src/run-records.js";

// 06:30 in Asia/Jerusalem (UTC+2 in November).
const START = Date.parse("2026-11-16T04:30:00.000Z");
const MINUTE = 60_000;
const ZONE = "Asia/Jerusalem";
const BRAND = "brand-a";
const OTHER = "brand-b";

const AGENT_PROMPT = "You are the meta analysis routine. Read the day, write findings, send nothing.";

interface PackageOptions {
  agents?: unknown[];
  files?: Record<string, string>;
  version?: string;
}

function agentPackage(root: string, options: PackageOptions = {}): string {
  const packageRoot = path.join(root, `pkg-${Math.random().toString(36).slice(2, 8)}`);
  const write = (relative: string, content: string) => {
    const target = path.join(packageRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const agents = options.agents ?? [
    {
      id: "meta-analysis",
      title: "Meta analysis",
      profile: {
        prompt: "profiles/meta-analysis.prompt.md",
        promptMode: "replace",
        model: "claude-sonnet-5-5",
        effort: "medium",
        extensions: ["@marley/brand-data"],
        skills: ["meta-analysis"],
        nativeTools: ["Read", "Bash"],
        mcpServers: [],
        context: ["brand", "clock"],
      },
      input: { type: "object", properties: { day: { type: "string" } } },
      outputs: [{ kind: "file" }],
      ports: ["brand-data", "artifacts"],
      routine: "routines/meta-analysis.yaml",
    },
  ];
  write(
    "runtime-extension.json",
    JSON.stringify({
      schemaVersion: 1,
      identity: "@marley/meta-analysis",
      version: options.version ?? "0.1.0",
      entrypoint: "dist/index.cjs",
      moduleFormat: "commonjs-bundle-v1",
      contributes: { catalog: ["skill:skills/meta-analysis"], agents },
    }),
  );
  write("package.json", JSON.stringify({ name: "@marley/meta-analysis", version: "0.1.0", type: "commonjs", main: "dist/index.cjs" }));
  write("dist/index.cjs", "module.exports = { activate() { return {}; } };");
  write("profiles/meta-analysis.prompt.md", AGENT_PROMPT);
  write("skills/meta-analysis/SKILL.md", '---\nname: meta-analysis\ndescription: "How to read a Meta day."\n---\n\n# Meta analysis\n');
  write("routines/meta-analysis.yaml", "title: Meta analysis\ntriggers:\n  events: [day-complete]\nbody:\n  extension: { id: \"@marley/meta-analysis\", agent: meta-analysis }\n");
  for (const [relative, content] of Object.entries(options.files ?? {})) write(relative, content);
  return packageRoot;
}

function clock() {
  let now = START;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms), set: (at: number) => (now = at) };
}

interface Rig {
  host: MarshalHost;
  calls: { prompt: string; options: Record<string, any> }[];
  time: ReturnType<typeof clock>;
  packageRoot: string;
  policy: { decide: (tenant: string | undefined) => FireDecision; asked: string[] };
}

async function rig(options: PackageOptions & { hang?: boolean } = {}): Promise<Rig> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agents-")));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const packageRoot = agentPackage(root, options);
  const calls: Rig["calls"] = [];
  const time = clock();
  const policy: Rig["policy"] = { decide: () => "go", asked: [] };
  const query: QueryFn = ({ prompt, options: sdkOptions }) => {
    calls.push({ prompt: String(prompt), options: sdkOptions });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: `native-${calls.length}` };
      if (options.hang) await new Promise<void>((resolve) => (sdkOptions.abortController as AbortController | undefined)?.signal.addEventListener("abort", () => resolve()));
      yield { type: "result", subtype: "success", is_error: false, result: "findings written", num_turns: 1, usage: {} };
    })();
  };
  const host = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    browser: false,
    query,
    automations: {
      now: time.now,
      start: false,
      tenantLabel: "brand",
      timezoneFor: () => ZONE,
      extensions: { resolve: (id) => (id === "@marley/meta-analysis" ? { packageRoot } : undefined) },
      firePolicy: ({ tenant, trigger, automation }) => {
        policy.asked.push(`${automation.name}:${trigger}:${tenant}`);
        return policy.decide(tenant);
      },
      inputFor: ({ tenant, fields }) => (tenant === BRAND ? { currency: "ILS", month: fields.yesterday.slice(0, 7) } : undefined),
      contextFor: ({ tenant, slots }) => Object.fromEntries(slots.map((slot) => [slot, slot === "brand" ? `Brand ${tenant}` : time.now().toISOString()])),
    },
  });
  return { host, calls, time, packageRoot, policy };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function finish(r: Rig, sessionId: string) {
  await r.host.agents.wait(sessionId);
  await settle();
}

test("a declared agent entry resolves into its pinned profile; the fingerprint ignores list order and follows the prompt", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agents-")));
  const packageRoot = agentPackage(root);
  const declared = readExtensionAgents(packageRoot);
  assert.equal(declared.identity, "@marley/meta-analysis");
  assert.deepEqual(declared.agents.map((agent) => agent.id), ["meta-analysis"]);
  const resolved = resolveAgent(packageRoot, "meta-analysis");
  assert.equal(resolved.profile.prompt, AGENT_PROMPT);
  assert.deepEqual(resolved.profile.extensions, ["@marley/meta-analysis", "@marley/brand-data"], "its own extension is always in scope");
  assert.match(resolved.fingerprint, /^[0-9a-f]{64}$/);
  const reordered = { ...resolved.profile, extensions: [...resolved.profile.extensions].reverse() };
  assert.equal(profileFingerprint(reordered), resolved.fingerprint);
  assert.notEqual(profileFingerprint({ ...resolved.profile, prompt: `${AGENT_PROMPT} Also send a message.` }), resolved.fingerprint);
  assert.notEqual(profileFingerprint({ ...resolved.profile, extensionVersion: "0.1.1" }), resolved.fingerprint);
  assert.notEqual(resolveAgent(packageRoot, "meta-analysis", { model: "claude-opus-5-5" }).fingerprint, resolved.fingerprint);
});

test("refusals: an unknown agent, a prompt outside the package, a disabled native tool, a tools field, operating modes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agents-")));
  const base = (profile: Record<string, unknown>, extra: Record<string, unknown> = {}) => [{ id: "a", profile: { prompt: "p.md", ...profile }, ...extra }];
  assert.throws(() => resolveAgent(agentPackage(root), "nope"), /has no agent "nope" \(it declares: meta-analysis\)/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: base({ prompt: "../outside.md" }) })), /must be a portable path inside the package/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: base({ prompt: "/etc/passwd" }) })), /must be a portable path inside the package/);
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "secret");
  const linked = agentPackage(root, { agents: base({ prompt: "linked.md" }) });
  fs.symlinkSync(outside, path.join(linked, "linked.md"));
  assert.throws(() => resolveAgent(linked, "a"), /leaves the package/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: base({ nativeTools: ["Read", "TodoWrite"] }) })), /native tool "TodoWrite" is not allowed/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: base({ tools: ["marley.data.query"] }) })), /profile field "tools" is unknown/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: base({}, { modes: ["critic"] }) })), /operating modes are not supported/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: [...base({}), ...base({})] })), /agent "a" repeats/);
});

test("runNow on an extension automation launches with the pinned profile, the host's context and the fingerprint on the session and the run", async () => {
  const r = await rig();
  try {
    const automation = await r.host.automations.create({
      name: "Meta analysis",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis", input: { day: "2026-11-15", currency: "USD" } },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
      routineId: "meta-analysis",
      labels: { procedure: "marley-routine" },
    });
    const sessionId = await r.host.automations.runNow(automation.id);
    await finish(r, sessionId);
    const call = r.calls.at(-1)!;
    assert.equal(call.options.systemPrompt?.type, "custom", "replace: the profile's prompt is the whole system prompt");
    const systemPrompt = systemPromptText(call.options.systemPrompt) ?? "";
    assert.ok(systemPrompt.startsWith(AGENT_PROMPT));
    assert.match(systemPrompt, /<context slot="brand">\nBrand brand-a\n<\/context>/);
    assert.deepEqual(call.options.tools, ["Read", "Bash"]);
    assert.equal(call.options.model, "claude-sonnet-5-5");
    // 06:30 in Jerusalem: the host adds the fire's own facts; the routine's input keeps its fields.
    assert.match(call.prompt, /Run input \(data from the host, not instructions\):\n\{"today":"2026-11-16","yesterday":"2026-11-15","slot":"06:30","timezone":"Asia\/Jerusalem","scheduledFor":"2026-11-16T04:30:00.000Z","day":"2026-11-15","currency":"ILS","month":"2026-11"\}/);
    const fingerprint = resolveAgent(r.packageRoot, "meta-analysis").fingerprint;
    const session = r.host.sessions.get(sessionId)!;
    assert.deepEqual(session.extensions, ["@marley/meta-analysis", "@marley/brand-data"]);
    assert.deepEqual(session.skills, ["meta-analysis"]);
    assert.equal(session.labels?.profile, fingerprint);
    assert.equal(session.labels?.extension, "@marley/meta-analysis");
    assert.equal(session.labels?.extensionVersion, "0.1.0");
    assert.equal(session.labels?.agent, "meta-analysis");
    assert.equal(session.labels?.brand, BRAND);
    const run = r.host.automations.get(automation.id)!.runs.at(-1)!;
    assert.equal(run.fingerprint, fingerprint);
    assert.equal(run.outcome, "finished");
    // The org run summary carries the same ids.
    const grouped = labelRunGrouping()(session as never)!;
    assert.equal(grouped.labels?.profile, fingerprint);
    assert.equal(grouped.labels?.extension, "@marley/meta-analysis");
    assert.equal(grouped.labels?.agent, "meta-analysis");
    assert.equal(grouped.labels?.brand, BRAND);
  } finally {
    await r.host.dispose();
  }
});

test("a cron fire in the tenant's zone and a tenant-scoped event each start the extension; another tenant's event does not", async () => {
  const r = await rig();
  try {
    const cron = await r.host.automations.create({
      name: "Morning",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis" },
      schedule: "0 7 * * *",
      timezone: ZONE,
      tenant: BRAND,
    });
    const event = await r.host.automations.create({
      name: "On day complete",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis" },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
    });
    r.time.advance(29 * MINUTE);
    assert.equal((await r.host.automations.tick()).fired, 0);
    r.time.advance(2 * MINUTE); // 07:01 local
    assert.equal((await r.host.automations.tick()).fired, 1);
    assert.equal(r.host.automations.get(cron.id)!.runs.length, 1);
    assert.equal(r.host.automations.get(cron.id)!.runs[0]!.agent, "meta-analysis");

    assert.deepEqual(await r.host.automations.emit("day-complete", {}, OTHER), []);
    assert.deepEqual(await r.host.automations.emit("day-complete", {}), [], "an event without a tenant does not reach a tenant's automation");
    const started = await r.host.automations.emit("day-complete", { day: "2026-11-15" }, BRAND);
    assert.deepEqual(started.map((item) => item.automationId), [event.id]);
  } finally {
    await r.host.dispose();
  }
});

test("after: a downstream run waits for the upstream run to finish and for notBefore in the tenant's zone, then runs once", async () => {
  const r = await rig();
  try {
    const upstream = await r.host.automations.create({
      name: "Meta analysis",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis" },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
      routineId: "meta-analysis",
    });
    const brief = await r.host.automations.create({
      name: "Brief send",
      prompt: "Send the frozen brief.",
      after: { routine: "meta-analysis", notBefore: "09:00", within: "6h", timezone: "tenant" },
      tenant: BRAND,
    });
    const other = await r.host.automations.create({
      name: "Other brand's brief",
      prompt: "Never for brand-a.",
      after: { routine: "meta-analysis" },
      tenant: OTHER,
    });
    const [first] = await r.host.automations.emit("day-complete", {}, BRAND);
    await finish(r, first!.sessionId);
    const owed = r.host.automations.get(brief.id)!.owed!;
    assert.equal(owed.length, 1);
    assert.equal(owed[0]!.dueAt, "2026-11-16T07:00:00.000Z", "09:00 in Jerusalem");
    assert.equal(r.host.automations.get(brief.id)!.runs.length, 0);
    assert.equal(r.host.automations.get(other.id)!.owed, undefined, "another tenant's after does not follow it");

    r.time.set(Date.parse("2026-11-16T06:59:00.000Z"));
    await r.host.automations.tick();
    assert.equal(r.host.automations.get(brief.id)!.runs.length, 0);
    r.time.set(Date.parse("2026-11-16T07:00:30.000Z"));
    await r.host.automations.tick();
    assert.equal(r.host.automations.get(brief.id)!.runs.length, 1);
    assert.equal(r.host.automations.get(brief.id)!.runs[0]!.trigger, "after");
    assert.equal(r.host.automations.get(brief.id)!.owed, undefined);
    await r.host.automations.tick();
    assert.equal(r.host.automations.get(brief.id)!.runs.length, 1, "runs once");
    assert.equal(r.host.automations.get(upstream.id)!.runs[0]!.outcome, "finished");
  } finally {
    await r.host.dispose();
  }
});

test("after: a failed upstream run owes nothing, and a wait longer than `within` is skipped", async () => {
  const r = await rig();
  try {
    await r.host.automations.create({ name: "Up", prompt: "up", triggerType: "event", event: "go", tenant: BRAND, routineId: "up" });
    const tight = await r.host.automations.create({ name: "Tight", prompt: "t", after: { routine: "up", notBefore: "09:00", within: "1h" }, tenant: BRAND });
    const up = r.host.automations.list(BRAND)[0]!;
    await r.host.automations.runFinished(up.id, "no-such-session", "finished");
    assert.equal(r.host.automations.get(tight.id)!.owed, undefined, "an unknown run is ignored");
    const [run] = await r.host.automations.emit("go", {}, BRAND);
    await finish(r, run!.sessionId);
    // Finished 06:30, notBefore 09:00 is 2.5 h away: more than within 1h.
    assert.equal(r.host.automations.get(tight.id)!.owed, undefined);
    assert.equal(r.host.automations.get(tight.id)!.lastDecision?.decision, "skip");

    const later = await r.host.automations.create({ name: "Later", prompt: "l", after: { routine: "up" }, tenant: BRAND });
    const [second] = await r.host.automations.emit("go", {}, BRAND);
    await r.host.automations.runFinished(up.id, second!.sessionId, "failed");
    await settle();
    assert.equal(r.host.automations.get(later.id)!.runs.length, 0);
    assert.equal(r.host.automations.get(up.id)!.runs.at(-1)!.outcome, "failed");
  } finally {
    await r.host.dispose();
  }
});

test("fire policy: a held fire is owed and asked again each tick until go; skip drops it; a manual run bypasses the policy", async () => {
  const r = await rig();
  try {
    let held = true;
    r.policy.decide = (tenant) => (tenant === BRAND && held ? "hold" : tenant === OTHER ? "skip" : "go");
    const mine = await r.host.automations.create({ name: "Mine", prompt: "m", schedule: "every 1 hour", tenant: BRAND });
    const theirs = await r.host.automations.create({ name: "Theirs", prompt: "t", schedule: "every 1 hour", tenant: OTHER });
    r.time.advance(60 * MINUTE);
    await r.host.automations.tick();
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 0);
    assert.equal(r.host.automations.get(mine.id)!.owed?.length, 1);
    assert.equal(r.host.automations.get(mine.id)!.lastDecision?.decision, "hold");
    assert.equal(r.host.automations.get(theirs.id)!.runs.length, 0);
    assert.equal(r.host.automations.get(theirs.id)!.owed, undefined, "skip drops the fire");

    r.time.advance(MINUTE);
    await r.host.automations.tick();
    assert.equal(r.host.automations.get(mine.id)!.owed?.length, 1, "still held");
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 0);

    held = false;
    r.time.advance(MINUTE);
    const released = await r.host.automations.tick();
    assert.equal(released.fired, 1);
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 1);
    assert.equal(r.host.automations.get(mine.id)!.runs[0]!.trigger, "schedule");
    assert.equal(r.host.automations.get(mine.id)!.owed, undefined);

    held = true;
    const asked = r.policy.asked.length;
    await r.host.automations.runNow(mine.id);
    assert.equal(r.policy.asked.length, asked, "a person's run now is not a fire");
    assert.equal(r.host.automations.get(mine.id)!.runs.length, 2);
  } finally {
    await r.host.dispose();
  }
});

test("an extension body is refused when the host cannot resolve it or the agent is unknown; a session cannot set the tenant", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.host.automations.create({ name: "x", extension: { id: "@marley/unknown", agent: "a" }, event: "e" }), /not available to this host/);
    await assert.rejects(r.host.automations.create({ name: "x", extension: { id: "@marley/meta-analysis", agent: "nope" }, event: "e" }), /has no agent "nope"/);
    await assert.rejects(r.host.automations.create({ name: "x", event: "e" }), /prompt is required/);
    const created = await r.host.invoke<any>("marshal.tool.createAutomation", {
      name: "From a session",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis" },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
      labels: { brand: BRAND },
    });
    assert.equal(created.success, true);
    assert.equal(created.automation.tenant, undefined, "the capability never sets a tenant");
    assert.equal(r.host.automations.get(created.automation.id)!.labels, undefined);
  } finally {
    await r.host.dispose();
  }
});

test("routine files: the extension body, after and timezone parse, and a routine becomes the automations that run it", async () => {
  const parsed = parseRoutineFile(
    "brief-send",
    [
      "title: Brief send",
      "triggers:",
      "  manual: true",
      "  timezone: brand",
      "  after: { routine: daily-brief, notBefore: \"09:00\", within: 6h }",
      "body:",
      "  extension: { id: \"@marley/brief-send\", agent: brief-send, input: { channel: owner-dm } }",
    ].join("\n"),
  );
  assert.equal(parsed.ok, true);
  const routine = (parsed as Extract<typeof parsed, { ok: true }>).routine;
  const inputs = routineAutomations(routine, { tenant: BRAND, labels: { procedure: "marley-routine" }, timezone: ZONE });
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0]!.after, { routine: "daily-brief", notBefore: "09:00", within: "6h", timezone: "tenant" });
  assert.deepEqual(inputs[0]!.extension, { id: "@marley/brief-send", agent: "brief-send", input: { channel: "owner-dm" } });
  assert.equal(inputs[0]!.tenant, BRAND);
  assert.equal(inputs[0]!.routineId, "brief-send");

  const bad = parseRoutineFile("x", "title: X\ntriggers:\n  after: { routine: y, notBefore: \"9am\" }\nbody:\n  agent: { prompt: p }\n");
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /triggers\.after\.notBefore/);

  const r = await rig();
  try {
    const shipped = fs.readFileSync(path.join(r.packageRoot, "routines/meta-analysis.yaml"), "utf8");
    const own = parseRoutineFile("meta-analysis", shipped);
    assert.equal(own.ok, true);
    for (const input of routineAutomations((own as Extract<typeof own, { ok: true }>).routine, { tenant: BRAND })) {
      await r.host.automations.create(input);
    }
    const started = await r.host.automations.emit("day-complete", {}, BRAND);
    assert.equal(started.length, 1);
    await finish(r, started[0]!.sessionId);
    assert.equal(r.host.sessions.get(started[0]!.sessionId)!.labels?.agent, "meta-analysis");
  } finally {
    await r.host.dispose();
  }
});

const TASKED = (limits: Record<string, unknown> = { maxTurns: 8, maxBudgetUsd: 0.5, timeoutMinutes: 20 }) => ({
  agents: [
    {
      id: "meta-analysis",
      task: "tasks/meta-analysis.md",
      profile: { prompt: "profiles/meta-analysis.prompt.md", nativeTools: ["Read"], limits },
    },
  ],
  files: { "tasks/meta-analysis.md": "Analyse {{input.day}} for {{ input.brand }}; look back {{input.lookbackDays}} days. Fired {{input.today}} {{input.slot}} {{input.timezone}}." },
});

test("task template and limits: the template is filled from the run input, limits reach the launch, both are in the fingerprint", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agents-")));
  const packageRoot = agentPackage(root, TASKED());
  const resolved = resolveAgent(packageRoot, "meta-analysis");
  assert.deepEqual(resolved.profile.limits, { maxTurns: 8, maxBudgetUsd: 0.5, timeoutMinutes: 20 });
  assert.match(resolved.profile.task ?? "", /\{\{input\.day\}\}/);
  assert.equal(
    fillTask(resolved.profile.task!, { day: "2026-11-15", brand: "OKOA", lookbackDays: 7, today: "2026-11-16", slot: "06:30", timezone: "UTC" }),
    "Analyse 2026-11-15 for OKOA; look back 7 days. Fired 2026-11-16 06:30 UTC.",
  );
  assert.throws(() => fillTask(resolved.profile.task!, { day: "2026-11-15" }), /needs the run input fields brand, lookbackDays/);
  assert.notEqual(profileFingerprint({ ...resolved.profile, task: "Something else." }), resolved.fingerprint);
  assert.notEqual(profileFingerprint({ ...resolved.profile, limits: { maxTurns: 9 } }), resolved.fingerprint);

  const r = await rig(TASKED());
  try {
    const automation = await r.host.automations.create({
      name: "Meta analysis",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis", input: { day: "2026-11-15", brand: "OKOA", lookbackDays: 7 } },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
    });
    const sessionId = await r.host.automations.runNow(automation.id);
    await finish(r, sessionId);
    const call = r.calls.at(-1)!;
    assert.match(call.prompt, /^Analyse 2026-11-15 for OKOA; look back 7 days\. Fired 2026-11-16 06:30 Asia\/Jerusalem\./);
    assert.equal(call.options.maxTurns, 8);
    assert.equal(call.options.maxBudgetUsd, 0.5);
    const missing = await r.host.automations.create({
      name: "No input",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis", input: { day: "2026-11-15" } },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
    });
    await assert.rejects(r.host.automations.runNow(missing.id), /needs the run input fields brand, lookbackDays/);
  } finally {
    await r.host.dispose();
  }
});

test("limits.timeoutMinutes cancels a run still going at its limit", async () => {
  const r = await rig({ ...TASKED({ timeoutMinutes: 1 }), hang: true });
  try {
    const automation = await r.host.automations.create({
      name: "Slow",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis", input: { day: "d", brand: "b", lookbackDays: 1 } },
      triggerType: "event",
      event: "day-complete",
      tenant: BRAND,
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    let sessionId: string;
    try {
      sessionId = await r.host.automations.runNow(automation.id);
      assert.equal(r.host.sessions.get(sessionId)?.state, "running");
      mock.timers.tick(59_000);
      assert.equal(r.host.sessions.get(sessionId)?.state, "running");
      mock.timers.tick(2_000);
    } finally {
      mock.timers.reset();
    }
    await settle();
    assert.notEqual(r.host.sessions.get(sessionId)?.state, "running");
  } finally {
    await r.host.dispose();
  }
});

test("refusals: bad limits, an unknown limits field, a task outside the package", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-agents-")));
  const withLimits = (limits: unknown) => [{ id: "a", profile: { prompt: "p.md", limits } }];
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: withLimits({ maxTurns: 0 }) })), /limits\.maxTurns must be a whole number/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: withLimits({ maxBudgetUsd: -1 }) })), /limits\.maxBudgetUsd must be a positive amount/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: withLimits({ timeoutMinutes: 2.5 }) })), /limits\.timeoutMinutes must be a whole number/);
  assert.throws(() => readExtensionAgents(agentPackage(root, { agents: withLimits({ maxCost: 1 }) })), /limits field "maxCost" is unknown/);
  assert.throws(
    () => readExtensionAgents(agentPackage(root, { agents: [{ id: "a", task: "../task.md", profile: { prompt: "p.md" } }] })),
    /task "\.\.\/task\.md" must be a portable path inside the package/,
  );
});

test("fire fields: a cron fire carries its slot instant, today and yesterday in the tenant's zone, and the host's facts", async () => {
  const r = await rig({ ...TASKED(), files: { "tasks/meta-analysis.md": "Cover {{input.yesterday}} ({{input.month}}, {{input.currency}}); slot {{input.scheduledFor}}." } });
  try {
    const cron = await r.host.automations.create({
      name: "Morning",
      extension: { id: "@marley/meta-analysis", agent: "meta-analysis" },
      schedule: "0 7 * * *",
      timezone: ZONE,
      tenant: BRAND,
    });
    r.time.advance(31 * MINUTE); // 07:01 local; the slot was 07:00
    assert.equal((await r.host.automations.tick()).fired, 1);
    const sessionId = r.host.automations.get(cron.id)!.runs[0]!.sessionId;
    await finish(r, sessionId);
    assert.match(r.calls.at(-1)!.prompt, /^Cover 2026-11-15 \(2026-11, ILS\); slot 2026-11-16T05:00:00\.000Z\./);
  } finally {
    await r.host.dispose();
  }
});
