// kit.brain.claimsFor: one host serving sessions that act for different people, brands and members. The claims a
// capability sees come from the host's session record on every call, never from what the session writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { QueryFn } from "../src/agent-port.js";
import { createMarshalHost, type MarshalHostOptions } from "../src/host.js";
import { kitProvider } from "../src/kit/call.js";
import { prepareKit } from "../src/kit/index.js";
import { checkedSessionClaims } from "../src/session-claims.js";
import type { SessionRecord } from "../src/session-store.js";

/** An @marshal/brain stand-in: the kit installs it; nothing here calls the Brain itself. */
function brainStub(): string {
  const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claims-brain-"))), "package");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "runtime-extension.json"),
    JSON.stringify({ schemaVersion: 1, identity: "@marshal/brain", version: "0.0.0-stub", entrypoint: "dist/index.cjs", moduleFormat: "commonjs-bundle-v1", contributes: {} }),
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@marshal/brain", version: "0.0.0-stub", type: "commonjs", main: "dist/index.cjs" }));
  fs.writeFileSync(path.join(root, "dist", "index.cjs"), "module.exports = { activate() { return {}; } };");
  return root;
}

/** A capability that answers with the principal claims of the invocation that reached it; `hold` waits for a release so two calls overlap. */
function probe() {
  const waiting: Array<() => void> = [];
  let held = 0;
  const provider = kitProvider("claims-probe", {
    "probe.claims": {
      title: "Claims probe",
      description: "Returns the invocation's principal claims.",
      permission: "probe.read",
      risk: "low",
      input: { type: "object", additionalProperties: true },
      output: {
        type: "object",
        additionalProperties: false,
        properties: { claims: { type: ["object", "null"], additionalProperties: true }, sessionId: { type: ["string", "null"] } },
      },
      async run(input, context) {
        if (input.hold) {
          held += 1;
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
        return { claims: context.principal?.claims ?? null, sessionId: context.scope?.sessionId ?? null };
      },
    },
  });
  return { source: () => provider, release: () => waiting.splice(0).forEach((resolve) => resolve()), held: () => held };
}

function recording(): { query: QueryFn; turns: Record<string | symbol, any>[] } {
  const turns: Record<string | symbol, any>[] = [];
  let count = 0;
  const query: QueryFn = ({ options }) =>
    (async function* () {
      turns.push(options);
      yield { type: "system", subtype: "init", session_id: `native-${++count}` };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
    })();
  return { query, turns };
}

async function host(options: Partial<MarshalHostOptions>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-claims-"));
  const workspacePath = path.join(root, "ws");
  fs.mkdirSync(workspacePath);
  const backend = recording();
  const created = await createMarshalHost({
    workspacePath,
    stateRoot: path.join(root, "state"),
    runtimeRoot: path.join(root, "runtime"),
    query: backend.query,
    browser: false,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    automations: { start: false },
    trustedTypeScript: true,
    ...options,
  });
  return { host: created, turns: backend.turns };
}

/** Launches a session with these labels and connects an MCP client to its `marshal` server, as the backend would. */
async function sessionClient(created: Awaited<ReturnType<typeof host>>, labels: Record<string, string>) {
  const session = created.host.agents.launch({ task: "t", idempotencyKey: `claims-${Math.random()}`, labels });
  await created.host.agents.wait(session.id);
  const server = created.turns.at(-1)!.mcpServers.marshal as { instance: { connect(transport: unknown): Promise<void> } };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "claims-test", version: "0.0.1" });
  await client.connect(clientSide);
  const claimsOf = async (input: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name: "runtime_exec", arguments: { targetType: "operation", target: "probe.claims", input } })) as {
      structuredContent?: { result?: { output?: { claims: Record<string, unknown> | null; sessionId: string | null } } };
      content?: { text: string }[];
    };
    const output = result.structuredContent?.result?.output ?? (JSON.parse(result.content?.[0]?.text ?? "{}") as { result?: { output?: any } }).result?.output;
    if (!output) throw new Error(`probe.claims: ${JSON.stringify(result).slice(0, 800)}`);
    return output;
  };
  return { session, client, claimsOf };
}

/** What a Marley-like host derives from its own session labels. */
const fromLabels = (session: SessionRecord) =>
  session.labels.brand
    ? {
        callerEmail: session.labels.person,
        conversationId: session.labels.conversation,
        brand: session.labels.brand,
        ...(session.labels.member ? { member: session.labels.member, access: [`person:${session.labels.member}`] } : { access: ["brand"] }),
      }
    : undefined;

test("claimsFor: each session's calls carry that session's claims, over the host's, and nothing the session writes changes them", { timeout: 120_000 }, async () => {
  const seen = probe();
  const created = await host({
    providerSources: [seen.source],
    kit: { parts: ["brain"], brain: { packageRoot: brainStub(), callerMode: "delegated", access: ["staff"], claimsFor: fromLabels } },
  });
  try {
    const okoa = await sessionClient(created, { brand: "brand-okoa", person: "Owner@OKOA.test", conversation: "wa:dm:1", member: "m-1" });
    const first = await okoa.claimsOf({ callerEmail: "attacker@evil.test", brand: "brand-other", claims: { member: "m-9" } });
    assert.deepEqual(first.claims, { access: ["person:m-1"], callerEmail: "owner@okoa.test", conversationId: "wa:dm:1", brand: "brand-okoa", member: "m-1" });
    assert.equal(first.sessionId, okoa.session.id);

    const group = await sessionClient(created, { brand: "brand-archie", person: "lead@archie.test", conversation: "wa:group:7" });
    assert.deepEqual((await group.claimsOf()).claims, { access: ["brand"], callerEmail: "lead@archie.test", conversationId: "wa:group:7", brand: "brand-archie" });

    // A session the hook names nothing for keeps the host's claims (here: access only, no person, so the Brain would refuse it).
    const plain = await sessionClient(created, {});
    assert.deepEqual((await plain.claimsOf()).claims, { access: ["staff"] });

    // A TypeScript block inside a session runs its nested calls with that session's claims.
    const nested = (await okoa.client.callTool({
      name: "runtime_exec",
      arguments: { targetType: "inline_module", source: 'export default async (_input: unknown, context: any) => context.runtime.invoke("probe.claims", {});' },
    })) as { structuredContent?: { result?: { output?: unknown } }; content?: { text: string }[] };
    const text = JSON.stringify(nested);
    assert.match(text, /owner@okoa\.test/, text.slice(0, 800));
    assert.match(text, /brand-okoa/);
    assert.doesNotMatch(text, /brand-archie/);

    // Two sessions' calls in flight at once each keep their own claims.
    const [a, b] = await Promise.all([
      okoa.claimsOf({ hold: true }),
      group.claimsOf({ hold: true }),
      (async () => {
        for (let i = 0; i < 200 && seen.held() < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        seen.release();
      })(),
    ]);
    assert.equal(a.claims?.brand, "brand-okoa");
    assert.equal(b.claims?.brand, "brand-archie");
    assert.equal(b.claims?.member, undefined, "a group session never carries another session's member");
  } finally {
    seen.release();
    await created.host.dispose();
  }
});

test("claimsFor absent: every session's calls carry the host's claims, as before", { timeout: 120_000 }, async () => {
  const seen = probe();
  const created = await host({
    providerSources: [seen.source],
    kit: { parts: ["brain"], brain: { packageRoot: brainStub(), callerMode: "delegated", callerEmail: "Svc@Zyg.test", access: ["staff"] } },
  });
  try {
    const one = await sessionClient(created, { brand: "brand-okoa", person: "owner@okoa.test" });
    assert.deepEqual((await one.claimsOf()).claims, { callerEmail: "svc@zyg.test", access: ["staff"] });
  } finally {
    await created.host.dispose();
  }
});

test("claimsFor that throws leaves the call with the host's claims and logs it", { timeout: 120_000 }, async () => {
  const seen = probe();
  const lines: string[] = [];
  const created = await host({
    providerSources: [seen.source],
    log: (line: string) => lines.push(line),
    kit: {
      parts: ["brain"],
      brain: {
        packageRoot: brainStub(),
        callerMode: "delegated",
        claimsFor: () => {
          throw new Error("session store down");
        },
      },
    },
  } as Partial<MarshalHostOptions>);
  try {
    const one = await sessionClient(created, { brand: "brand-okoa" });
    assert.equal((await one.claimsOf()).claims, null);
    assert.ok(lines.some((line) => /kit\.brain\.claimsFor failed/.test(line) && /session store down/.test(line)), lines.join("\n"));
  } finally {
    await created.host.dispose();
  }
});

test("prepareKit: claimsFor lets a service host with no person keep the Brain, and rides along only with the Brain", () => {
  const packageRoot = brainStub();
  const store = {} as never;
  const claimsFor = () => ({ callerEmail: "a@b.test" });
  const personless = prepareKit({ kit: { parts: ["brain", "memory"], brain: { packageRoot, callerMode: "delegated" } }, sessions: store, workspacePath: "/w/marley" });
  assert.equal(personless.parts.has("brain"), false);
  assert.ok(personless.warning);
  assert.equal(personless.claimsFor, undefined);
  const perSession = prepareKit({ kit: { parts: ["brain", "memory"], brain: { packageRoot, callerMode: "delegated", claimsFor } }, sessions: store, workspacePath: "/w/marley" });
  assert.equal(perSession.parts.has("brain"), true);
  assert.equal(perSession.warning, undefined);
  assert.equal(perSession.claimsFor, claimsFor);
  assert.deepEqual(perSession.denied.has("knowledge.search"), false);
  const sessionsOnly = prepareKit({ kit: { parts: ["sessions"], brain: { claimsFor } }, sessions: store, workspacePath: "/w/marley" });
  assert.equal(sessionsOnly.claimsFor, undefined);
});

test("checkedSessionClaims keeps the five known fields when well formed and drops the rest", () => {
  assert.deepEqual(
    checkedSessionClaims({ callerEmail: " Owner@OKOA.test ", conversationId: "wa:dm:1", brand: "brand-okoa", member: "m-1", access: ["person:m-1", 7, ""], role: "admin" }),
    { callerEmail: "owner@okoa.test", conversationId: "wa:dm:1", brand: "brand-okoa", member: "m-1", access: ["person:m-1"] },
  );
  assert.deepEqual(checkedSessionClaims({ callerEmail: "not an email", brand: "has space", member: "x".repeat(600) }), undefined);
  assert.equal(checkedSessionClaims(undefined), undefined);
  assert.equal(checkedSessionClaims(["callerEmail"]), undefined);
  assert.deepEqual(checkedSessionClaims({ access: [] }), { access: [] }, "an empty access list is kept: it replaces the host's labels with none");
});
