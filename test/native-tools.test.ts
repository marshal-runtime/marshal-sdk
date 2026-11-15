import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { ClaudeAgentPort, TURN_EXTRAS, type QueryFn } from "../src/agent-port.js";
import { createMarshalHost } from "../src/host.js";
import { DISABLED_NATIVE_TOOLS, NATIVE_SUBAGENT_ALLOWLIST } from "../src/native-tools.js";
import { createProviderQuery } from "../src/provider-query.js";
import type { RuntimeClient, RuntimeClientFactory, RuntimeSessionConfig, RuntimeSendOptions } from "../src/providers.js";
import { loadRepositoryInstructions, repositoryRulesPrompt } from "../src/repo-rules.js";
import { FileSessionStore } from "../src/session-store.js";

const HOST_PROMPT = "You are a Marshal agent.";
const surface = { disabled: DISABLED_NATIVE_TOOLS, subagentAllowlist: NATIVE_SUBAGENT_ALLOWLIST };

/** A Claude Agent SDK double that records each turn's options. */
function recording(): { query: QueryFn; turns: Record<string | symbol, any>[] } {
  const turns: Record<string | symbol, any>[] = [];
  let count = 0;
  const query: QueryFn = ({ options }) =>
    (async function* () {
      turns.push(options);
      yield { type: "system", subtype: "init", session_id: (options.resume as string | undefined) ?? `native-${++count}` };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
    })();
  return { query, turns };
}

function port(query: QueryFn, extra: { projectSettings?: boolean; nativeTools?: typeof surface } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-native-tools-"));
  const store = new FileSessionStore(path.join(root, "sessions"), { runId: "run-1", host: { id: "test", kind: "local" } });
  return new ClaudeAgentPort({ query, store, cwd: root, env: {}, defaultModel: "m", systemPrompt: () => HOST_PROMPT, mcpServers: () => ({}), ...extra });
}

test("Agent SDK path: a session on the host's prompt loses the desktop's native tools, and native subagents other than web-fetch are denied", async () => {
  const { query, turns } = recording();
  const agents = port(query, { projectSettings: true, nativeTools: surface });
  await agents.wait(agents.launch({ task: "a", idempotencyKey: "a" }).id);
  const options = turns[0]!;
  assert.deepEqual(options.disallowedTools, [...DISABLED_NATIVE_TOOLS]);
  for (const name of ["TodoWrite", "AskUserQuestion", "TaskCreate", "CronCreate", "EnterWorktree", "EnterPlanMode"]) {
    assert.ok(options.disallowedTools.includes(name), name);
  }
  assert.deepEqual(options.settingSources, ["project"]);
  const { sessionId, ...extras } = options[TURN_EXTRAS];
  assert.equal(typeof sessionId, "string", "the turn carries its Marshal session for the session engine");
  assert.deepEqual(extras, { attachments: [], nativeSubagentAllowlist: ["web-fetch"] });
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /forkSubagents.*Allowed native agent types: web-fetch\./);
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { subagent_type: "web-fetch" } }), {});
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), {});

  // A launch's own tool cuts and hooks stay, after the surface's.
  const launchHook = async () => ({});
  await agents.wait(agents.launch({ task: "b", idempotencyKey: "b", options: { disallowedTools: ["Bash"], hooks: { PreToolUse: [{ hooks: [launchHook] }] } } }).id);
  assert.deepEqual(turns[1]!.disallowedTools, [...DISABLED_NATIVE_TOOLS, "Bash"]);
  assert.equal(turns[1]!.hooks.PreToolUse[0].hooks[0], launchHook);
  assert.equal(turns[1]!.hooks.PreToolUse.length, 2);

  // A launch that brings its own prompt keeps the backend's tools, as the desktop does off its v2 prompt.
  await agents.wait(agents.launch({ task: "c", idempotencyKey: "c", systemPrompt: "You build pages." }).id);
  assert.equal(turns[2]!.disallowedTools, undefined);
  assert.equal(turns[2]!.hooks, undefined);
  assert.equal(turns[2]![TURN_EXTRAS].nativeSubagentAllowlist, undefined);

  // A fork carries its parent's prompt text: the same surface.
  await agents.wait(agents.launch({ task: "d", idempotencyKey: "d", systemPrompt: HOST_PROMPT }).id);
  assert.deepEqual(turns[3]!.disallowedTools, [...DISABLED_NATIVE_TOOLS]);

  const bare = recording();
  const plain = port(bare.query);
  await plain.wait(plain.launch({ task: "e", idempotencyKey: "e" }).id);
  assert.deepEqual(bare.turns[0]!.settingSources, [], "without projectSettings nothing loads from the checkout");
  assert.equal(bare.turns[0]!.disallowedTools, undefined);
});

/** A Claude client double that records each session config and each send. */
function clientDouble() {
  const configs: RuntimeSessionConfig[] = [];
  const sends: RuntimeSendOptions[] = [];
  const factory: RuntimeClientFactory = async () =>
    ({
      async createSession(config: RuntimeSessionConfig) {
        configs.push(config);
        const handlers = new Set<(event: any) => void>();
        return {
          sessionId: `native-${configs.length}`,
          on: (handler: (event: any) => void) => (handlers.add(handler), () => handlers.delete(handler)),
          async send(options: RuntimeSendOptions) {
            sends.push(options);
            setTimeout(() => {
              for (const handler of handlers) handler({ type: "assistant.message", data: { content: "ok" } });
              for (const handler of handlers) handler({ type: "session.idle", data: {} });
            }, 0);
            return "m";
          },
          async abort() {},
          async disconnect() {},
        };
      },
      async resumeSession() {
        throw new Error("not in this test");
      },
      async stop() {},
    }) as unknown as RuntimeClient;
  return { factory, configs, sends };
}

test("client path: the same surface and project rules reach the desktop's Claude client as its own config fields, and files as attachments", async () => {
  const client = clientDouble();
  const agents = port(createProviderQuery({ factory: client.factory }), { projectSettings: true, nativeTools: surface });
  const image = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-attach-")), "shot.png");
  fs.writeFileSync(image, "png");
  await agents.wait(agents.launch({ task: "look", idempotencyKey: "a", attachments: [image] }).id);
  const config = client.configs[0]!;
  assert.deepEqual(config.disabledBuiltInTools, [...DISABLED_NATIVE_TOOLS]);
  assert.deepEqual(config.nativeSubagentAllowlist, ["web-fetch"]);
  assert.equal(typeof config.hooks?.onPreToolUse, "function", "the client enforces the allowlist in its PreToolUse hook");
  assert.equal(config.projectContext, undefined, "project rules load (the client's default)");
  assert.deepEqual(client.sends[0], { prompt: "look", attachments: [{ type: "file", path: image }] });

  const off = clientDouble();
  const closed = port(createProviderQuery({ factory: off.factory }));
  await closed.wait(closed.launch({ task: "x", idempotencyKey: "b" }).id);
  assert.equal(off.configs[0]!.projectContext, false);
  assert.equal(off.configs[0]!.disabledBuiltInTools, undefined);
  assert.equal(off.configs[0]!.nativeSubagentAllowlist, undefined);
});

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-repo-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("repo rules: Claude reads CLAUDE.md itself; AGENTS.md, .github and .cursor rules are forwarded, scoped ones listed", () => {
  const root = repo({
    "CLAUDE.md": "# Claude\nClaude-only rule.",
    "AGENTS.md": "# Agents\nUse tabs.",
    "pkg/AGENTS.md": "# Package\nPackage rule.",
    ".github/copilot-instructions.md": "Copilot rule.",
    ".github/instructions/api.instructions.md": "---\napplyTo: \"src/api/**\"\ndescription: API rules\n---\nAPI rule.",
    ".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nCursor rule.",
    ".claude/rules/testing.md": "Claude rules dir.",
    "node_modules/x/AGENTS.md": "never read",
  });
  const found = loadRepositoryInstructions(root).map((item) => [item.path, item.source, item.alwaysApply]);
  assert.deepEqual(found, [
    [".github/copilot-instructions.md", "copilot", true],
    [".github/instructions/api.instructions.md", "copilot", false],
    ["AGENTS.md", "shared", true],
    ["CLAUDE.md", "claude", true],
    ["pkg/AGENTS.md", "shared", false],
    [".cursor/rules/style.mdc", "cursor", true],
    [".claude/rules/testing.md", "claude", true],
  ]);
  const claude = repositoryRulesPrompt(root, "claude");
  assert.match(claude, /^## Repository Instructions\n/);
  assert.match(claude, /### AGENTS\.md\n\n# Agents\nUse tabs\./);
  assert.match(claude, /### \.github\/copilot-instructions\.md\n\nCopilot rule\./);
  assert.match(claude, /Cursor rule\./);
  assert.match(claude, /- \.github\/instructions\/api\.instructions\.md: API rules \(applies to src\/api\/\*\*\)/);
  assert.match(claude, /- pkg\/AGENTS\.md \(applies to pkg\/\*\*\)/);
  assert.doesNotMatch(claude, /Claude-only rule|Claude rules dir|never read/);
  const codex = repositoryRulesPrompt(root, "codex");
  assert.match(codex, /Claude-only rule/);
  assert.doesNotMatch(codex, /Use tabs/, "Codex reads the root AGENTS.md itself");
  assert.equal(repositoryRulesPrompt(repo({ "CLAUDE.md": "only Claude's" }), "claude"), "");
});

test("host: repo rules on by default (prompt section + project setting source), off with repoRules false; Claude client by default", async () => {
  const workspace = repo({ "AGENTS.md": "# Agents\nUse tabs.", "CLAUDE.md": "Claude-only rule." });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-native-host-"));
  const { query, turns } = recording();
  const on = await createMarshalHost({ workspacePath: workspace, stateRoot: path.join(stateRoot, "a"), query, browser: false, env: {}, automations: { start: false } });
  try {
    assert.match(on.systemPrompt() ?? "", /## Repository Instructions[\s\S]*### AGENTS\.md\n\n# Agents\nUse tabs\./);
    assert.doesNotMatch(on.systemPrompt() ?? "", /Claude-only rule/);
    await on.agents.wait(on.agents.launch({ task: "x", idempotencyKey: "x" }).id);
    assert.deepEqual(turns[0]!.settingSources, ["project"]);
    assert.ok(turns[0]!.disallowedTools.includes("TodoWrite"));
  } finally {
    await on.dispose();
  }
  const off = await createMarshalHost({ workspacePath: workspace, stateRoot: path.join(stateRoot, "b"), query, browser: false, env: {}, repoRules: false, automations: { start: false } });
  try {
    assert.doesNotMatch(off.systemPrompt() ?? "", /Repository Instructions/);
    await off.agents.wait(off.agents.launch({ task: "y", idempotencyKey: "y" }).id);
    assert.deepEqual(turns[1]!.settingSources, []);
  } finally {
    await off.dispose();
  }
  const lines: string[] = [];
  const real = await createMarshalHost({ workspacePath: workspace, stateRoot: path.join(stateRoot, "c"), browser: false, env: {}, log: (line) => lines.push(line), automations: { start: false } });
  await real.dispose();
  assert.match(lines.join("\n"), /provider claude \(Claude client\)/);
});

// Drift: the lists are copies of the desktop's. MARSHAL_DESKTOP_DIR, or the sibling `marshal` checkout of this repo,
// read at MARSHAL_DESKTOP_REF (default origin/main).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopRoot = process.env.MARSHAL_DESKTOP_DIR ?? path.resolve(repoRoot, "..", "marshal");
const assemblePath = "electron/prompt/v2/assemble.ts";
const hasDesktop = fs.existsSync(path.join(desktopRoot, assemblePath));

/** A top-level `export const NAME = [ "..." ]` string array in a TypeScript file. */
function stringArray(source: string, name: string): string[] | undefined {
  const file = ts.createSourceFile("assemble.ts", source, ts.ScriptTarget.Latest);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) return undefined;
      return initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : `<${ts.SyntaxKind[element.kind]}>`));
    }
  }
  return undefined;
}

test(
  "native tool lists match the desktop's V2_DISABLED_NATIVE_TOOLS and V2_NATIVE_SUBAGENT_ALLOWLIST",
  { skip: hasDesktop ? false : `no desktop checkout at ${desktopRoot} (set MARSHAL_DESKTOP_DIR)` },
  () => {
    const source = execFileSync("git", ["show", `${process.env.MARSHAL_DESKTOP_REF ?? "origin/main"}:${assemblePath}`], { cwd: desktopRoot, encoding: "utf8" });
    assert.deepEqual(stringArray(source, "V2_DISABLED_NATIVE_TOOLS"), [...DISABLED_NATIVE_TOOLS], "update src/native-tools.ts from the desktop");
    assert.deepEqual(stringArray(source, "V2_NATIVE_SUBAGENT_ALLOWLIST"), [...NATIVE_SUBAGENT_ALLOWLIST], "update src/native-tools.ts from the desktop");
  },
);
