# Permissions

Permission management is the SDK's; the person-facing part is the host's.

`packages/permissions` is the Marshal desktop's permission engine, moved here unchanged. The desktop vendors
`packages/permissions/src` as `packages/marshal-permissions/src`, pinned to a marshal-sdk commit and checked by
a content hash (`scripts/marshal-permissions-source.mjs` and its test in the desktop), so a tool request is
decided by the same code in both shells.

## What the engine is

- **The policy** (`policy/permission-policy.ts`): every tool request (shell, write, read, MCP, URL, custom
  tool, memory, settings) gets `approve`, `deny`, or `prompt`. Pre-hook checks, then the ordered rules in
  `policy/policy-rules/`: tenant deny and force-prompt, sensitive paths, reads, user-disabled MCP servers
  (blocked, not disconnected), folder grants, remote-auth vectors, server auto-approve, read-only auto-approve,
  deny patterns, structured tools, allow patterns, background deny, default prompt.
- **The 3-tier shell classifier**: read-only commands auto-approve when `autoApproveReadOnly` is on, writes and
  network prompt, dangerous commands are blocked. Pipes, `&&`, and `>`/`>>` redirects are checked segment by
  segment (`policy/permission-patterns.ts`, `policy/shell-syntax-permission-utils.ts`).
- **Guards**: workspace and folder scope (`permission-path-scope.ts`), sensitive paths such as `~/.ssh`
  (`sensitive-path-permission-guard.ts`), credential-bearing commands (`remote-auth-permission-guard.ts`), the
  browser-use classifier, reviewer sessions (read-only, dedicated validation).
- **Audit records** (`policy/audit-contract.ts`): one row per decision with its source. The sink is a port
  (`AuditLogger.log`); the desktop's sink writes the JSONL audit log.
- **"Always allow" patterns**: the card's pattern is computed by the guardrails, and an accepted rule is written
  back through the host's settings store.

The host supplies only what lives with it: a settings store (`get().permissions`, `update({permissions})`), the
tenant policy, the audit sink, the workspace roots, and the approval port.

## Using it in a host

```ts
import { createMarshalHost, createMarshalPermissions } from "@marshal/sdk";

const permissions = createMarshalPermissions({
  mode: "policy",                          // default "allow-all": unattended hosts keep today's behaviour
  permissions: { autoApproveReadOnly: true, allow: ["npm test"], tools: {}, servers: {} },
  approval: {                              // optional: who answers a "prompt"
    async requestPrompt({ permissionRequest, sessionId }) {
      const action = await askOnSlack(sessionId, permissionRequest);   // "allow" | "allow-session" | "always-allow" | "deny"
      return action ? { outcome: "resolved", action } : { outcome: "timed-out" };
    },
  },
  audit: { log: (row) => auditSink.write(row) },
  workspaceDir: "/work/repo",
});

const host = await createMarshalHost({ /* … */ permissions: { canUseTool: permissions.canUseTool } });
```

- `mode: "allow-all"` (the default) approves every request, as SDK hosts did before (R7.6, POC).
- `mode: "policy"` without `approval`: a `prompt` decision is denied, the way the desktop denies when no window
  can show a card. Unattended runs stay safe without a person.
- `permissions.policy` is the `PermissionPolicy` itself, for per-session grants, entity permissions
  (automations, heartbeat), deny-prompt and unattended sessions.

The approval port has the shape of the desktop's `ApprovalBroker.requestPrompt`, so the desktop's cards plug in
as they are. The decision flow is the desktop's `approval-adapter` without its background LLM classifier.

## Changing it

Edit `packages/permissions/src` here, merge, then in the desktop run
`node scripts/marshal-permissions-source.mjs sync <marshal-sdk checkout>` and commit the vendored tree with
the updated `packages/marshal-permissions/SOURCE.json`. `host-deps.ts` (outside `src`) is each repo's own: it
points the engine at that repo's copy of the provider layer for the logger, tool names and permission kinds.
