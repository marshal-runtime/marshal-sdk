import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMarshalPermissions,
  createMemoryPermissionSettings,
  DEFAULT_POLICY_PERMISSIONS,
  type AuditLogInput,
  type PermissionAction,
  type PermissionApprovalPort,
  type PermissionPrompt,
} from "../src/permissions.js";

const session = { sessionId: "s1" };
const shell = (command: string) => ({ kind: "shell" as const, fullCommandText: command, toolCallId: `t-${command}` });

function scriptedApproval(actions: (PermissionAction | "timeout")[]): PermissionApprovalPort & { prompts: PermissionPrompt[] } {
  const prompts: PermissionPrompt[] = [];
  return {
    prompts,
    async requestPrompt(prompt) {
      prompts.push(prompt);
      const next = actions.shift();
      if (!next) return { outcome: "resolved", action: "deny" };
      return next === "timeout" ? { outcome: "timed-out" } : { outcome: "resolved", action: next };
    },
  };
}

test("default mode approves every tool request, as unattended hosts do today", async () => {
  const permissions = createMarshalPermissions();
  assert.equal(permissions.mode, "allow-all");
  assert.equal(permissions.policy, undefined);
  assert.deepEqual(await permissions.canUseTool(shell("rm -rf build"), session), { kind: "approve-once" });
});

test("policy mode without anyone to ask denies what the policy would prompt for", async () => {
  const permissions = createMarshalPermissions({ mode: "policy" });
  assert.deepEqual(await permissions.canUseTool(shell("npm publish"), session), { kind: "user-not-available" });
});

test("read-only shell commands auto-approve when the permissions say so, through the 3-tier classifier", async () => {
  const permissions = createMarshalPermissions({
    mode: "policy",
    permissions: { ...DEFAULT_POLICY_PERMISSIONS, autoApproveReadOnly: true },
  });
  assert.deepEqual(await permissions.canUseTool(shell("ls -la"), session), { kind: "approve-once" });
  assert.deepEqual(await permissions.canUseTool(shell("git log | head"), session), { kind: "approve-once" });
  // Segments are checked one by one: a redirect into a file is not read-only.
  assert.deepEqual(await permissions.canUseTool(shell("echo > file.txt"), session), { kind: "user-not-available" });
});

test("allow rules in the permissions approve matching commands", async () => {
  const permissions = createMarshalPermissions({
    mode: "policy",
    permissions: { ...DEFAULT_POLICY_PERMISSIONS, allow: ["npm test"] },
  });
  assert.deepEqual(await permissions.canUseTool(shell("npm test"), session), { kind: "approve-once" });
});

test("a prompt goes to the approval port with the request and a suggested always-allow pattern", async () => {
  const approval = scriptedApproval(["allow"]);
  const permissions = createMarshalPermissions({ mode: "policy", approval });
  assert.deepEqual(await permissions.canUseTool(shell("npm run build"), session), { kind: "approve-once" });
  assert.equal(approval.prompts.length, 1);
  const [prompt] = approval.prompts;
  assert.equal(prompt.sessionId, "s1");
  assert.equal(prompt.permissionRequest.kind, "shell");
  assert.ok(prompt.permissionRequest.approvalPattern, "the card gets the pattern 'Always allow' would store");
});

test("'always allow' writes a rule through the settings store and later calls skip the prompt", async () => {
  const settings = createMemoryPermissionSettings();
  const approval = scriptedApproval(["always-allow"]);
  const permissions = createMarshalPermissions({ mode: "policy", approval, settings });
  assert.deepEqual(await permissions.canUseTool(shell("npm run build"), session), { kind: "approve-once" });
  assert.ok((settings.get().permissions?.allow.length ?? 0) > 0, "a durable allow rule was written");
  assert.deepEqual(await permissions.canUseTool(shell("npm run build"), session), { kind: "approve-once" });
  assert.equal(approval.prompts.length, 1, "the second call was approved by the stored rule");
});

test("a person's deny rejects the call; a timeout denies it", async () => {
  const approval = scriptedApproval(["deny", "timeout"]);
  const permissions = createMarshalPermissions({ mode: "policy", approval });
  assert.deepEqual(await permissions.canUseTool(shell("npm publish"), session), { kind: "reject" });
  assert.deepEqual(await permissions.canUseTool(shell("npm publish"), session), { kind: "user-not-available" });
});

test("writes to credential files are gated even when the person would allow the command", async () => {
  const permissions = createMarshalPermissions({
    mode: "policy",
    permissions: { ...DEFAULT_POLICY_PERMISSIONS, allow: ["echo *"] },
  });
  assert.deepEqual(await permissions.canUseTool(shell("echo hello"), session), { kind: "approve-once" });
  const result = await permissions.canUseTool(shell('echo "Host evil" >> ~/.ssh/config'), session);
  assert.notDeepEqual(result, { kind: "approve-once" }, "an allow rule does not cover a write into ~/.ssh");
});

test("decisions are written to the host's audit sink", async () => {
  const rows: AuditLogInput[] = [];
  const approval = scriptedApproval(["allow"]);
  const permissions = createMarshalPermissions({ mode: "policy", approval, audit: { log: (row) => rows.push(row) } });
  await permissions.canUseTool(shell("npm run build"), session);
  assert.ok(rows.some((row) => row.source === "user-interactive" && row.decision === "approved" && row.commandText === "npm run build"));
});

test("the engine plugs into createMarshalHost as permissions.canUseTool and decides the model backend's tool calls", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createMarshalHost } = await import("../src/host.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-policy-"));
  fs.mkdirSync(path.join(root, "ws"));
  const turns: Record<string, any>[] = [];
  const query = ({ options }: { options: Record<string, any> }) =>
    (async function* () {
      turns.push(options);
      yield { type: "system", subtype: "init", session_id: "native-1" };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
    })();
  const engine = createMarshalPermissions({
    mode: "policy",
    permissions: { ...DEFAULT_POLICY_PERMISSIONS, autoApproveReadOnly: true },
  });
  const host = await createMarshalHost({
    workspacePath: path.join(root, "ws"),
    stateRoot: path.join(root, "state"),
    query: query as never,
    browser: false,
    env: { CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    automations: { start: false },
    permissions: { canUseTool: engine.canUseTool },
  });
  try {
    const session = host.agents.launch({ task: "t", idempotencyKey: "policy" });
    await host.agents.wait(session.id);
    const options = turns[0]!;
    assert.equal(options.permissionMode, "default");
    const signal = new AbortController().signal;
    const read = await options.canUseTool("Bash", { command: "ls -la" }, { toolUseID: "u1", signal });
    assert.equal(read.behavior, "allow");
    const publish = await options.canUseTool("Bash", { command: "npm publish" }, { toolUseID: "u2", signal });
    assert.equal(publish.behavior, "deny", "nobody to ask: the policy's prompt is denied");
  } finally {
    await host.dispose();
  }
});
