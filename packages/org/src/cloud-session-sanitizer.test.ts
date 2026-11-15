import { describe, expect, it } from "vitest";

import type { SessionMessage } from "../../../common/marshal-ipc-contract";
import {
  findRestrictedItems,
  sanitizeSessionForOrg,
  scrubText,
  type ShareableSession,
} from "./cloud-session-sanitizer";

const ROOTS = { workspaceRoot: "/Users/ada/code/platform", homeDir: "/Users/ada" };
const GITHUB_PAT = `ghp_${"a".repeat(36)}`;

function message(partial: Partial<SessionMessage> & { id: string }): SessionMessage {
  return { role: "user", content: "hi", timestamp: "2026-11-03T10:00:00.000Z", ...partial };
}

function session(messages: SessionMessage[]): ShareableSession {
  return {
    id: "sess-1",
    name: "Fix the build",
    createdAt: "2026-11-03T09:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    runtimeId: "claude",
    workspaceName: "Platform",
    repoPath: ROOTS.workspaceRoot,
    messages,
  };
}

describe("scrubText", () => {
  it("redacts known tokens, bearer headers and credential assignments", () => {
    const out = scrubText(
      `token ${GITHUB_PAT} and Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and password=hunter2hunter2`,
      ROOTS,
    );
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("[REDACTED:");
  });

  it.each([
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PRIVATE KEY",
  ])("redacts a PEM %s block, with real or escaped line breaks", (kind) => {
    const body = "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun";
    const real = `before\n-----BEGIN ${kind}-----\n${body}\n${body}\n-----END ${kind}-----\nafter`;
    const escaped = `{"cmd":"-----BEGIN ${kind}-----\\n${body}\\n-----END ${kind}-----\\n"} tail`;
    for (const input of [real, escaped]) {
      const out = scrubText(input, ROOTS);
      expect(out).not.toContain(body);
      expect(out).not.toContain("BEGIN");
      expect(out).toContain("[REDACTED:private-key]");
    }
    expect(scrubText(real, ROOTS)).toMatch(/^before\n.*\nafter$/s);
  });

  it("limits an unterminated PEM header to the header and its base64 lines", () => {
    const out = scrubText(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfV\nMIIEowIBAAKCAQEAu1SU1LfV\nthe build failed: see log",
      ROOTS,
    );
    expect(out).toBe("[REDACTED:private-key]\nthe build failed: see log");
  });

  it("redacts a PEM key cut off before its END line, and leaves public keys alone", () => {
    expect(scrubText("x -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA", ROOTS)).toBe(
      "x [REDACTED:private-key]",
    );
    const publicKey = "-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----";
    expect(scrubText(publicKey, ROOTS)).toBe(publicKey);
  });

  it("makes workspace paths relative and collapses other home paths", () => {
    const out = scrubText(
      "edit /Users/ada/code/platform/src/a.ts, see /Users/ada/.ssh/config and /home/bob/x and C:\\Users\\carol\\y",
      ROOTS,
    );
    expect(out).toBe("edit ./src/a.ts, see ~/.ssh/config and ~/x and ~\\y");
  });

  it("does not treat a longer sibling directory as the workspace root", () => {
    expect(scrubText("/Users/ada/code/platform-other/a.ts", ROOTS)).toBe(
      "~/code/platform-other/a.ts",
    );
  });
});

describe("sanitizeSessionForOrg", () => {
  const context = { owner: "user:ada" as const, workspaceId: "ws:platform", homeDir: "/Users/ada" };

  it("uploads a participant's own words and inbox message id instead of the wrapped prompt", () => {
    const result = sanitizeSessionForOrg(
      session([
        message({
          id: "org-live-m1",
          content: '<participants>…</participants>\n<message author="user:bob">run it</message>',
          orgParticipant: {
            principal: "user:bob",
            role: "collaborator",
            orgMessageId: "m1",
            text: "run it",
          },
        }),
        message({ id: "2", role: "assistant", content: "ran" }),
      ]),
      context,
    );
    expect(result.success && result.session.messages).toEqual([
      expect.objectContaining({ role: "user", text: "run it", messageId: "m1" }),
      expect.not.objectContaining({ messageId: expect.anything() }),
    ]);
  });

  it("builds a contract envelope and keeps only scrubbed user, assistant and system text", () => {
    const result = sanitizeSessionForOrg(
      session([
        message({ id: "1", content: `use ${GITHUB_PAT} in /Users/ada/code/platform/x.ts` }),
        message({
          id: "2",
          role: "assistant",
          content: "done",
          reasoning: { text: "secret thoughts", durationSeconds: 1 },
          toolCalls: [{ name: "shell", description: "", input: "cat ~/.env", output: "TOKEN=xyz" }],
        }),
        message({
          id: "3",
          content: "hidden",
          internalControl: { kind: "goal-continuation-composer", exchangeId: "x", side: "request" },
        }),
        message({ id: "4", content: "   " }),
      ]),
      context,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.session.upload).toEqual({
      id: "sess-1",
      workspaceId: "ws:platform",
      title: "Fix the build",
      owner: "user:ada",
      createdAt: "2026-11-03T09:00:00.000Z",
      updatedAt: "2026-11-03T10:00:00.000Z",
      labels: "team",
      runtime: "claude",
    });
    expect(result.session.messages).toHaveLength(2);
    const serialized = JSON.stringify(result.session);
    expect(serialized).not.toContain(GITHUB_PAT);
    expect(serialized).not.toContain("secret thoughts");
    expect(serialized).not.toContain("TOKEN=xyz");
    expect(result.session.messages[0]?.text).toContain("./x.ts");
  });

  it("truncates a message to the 64 KiB contract cap on a character boundary", () => {
    const result = sanitizeSessionForOrg(
      session([message({ id: "1", content: "é".repeat(60_000) })]),
      context,
    );
    if (!result.success) throw new Error("expected success");
    const text = result.session.messages[0].text;
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(64 * 1024);
    expect(text.endsWith("[truncated]")).toBe(true);
  });

  it("rejects ids and workspaces the contract would refuse", () => {
    expect(sanitizeSessionForOrg({ ...session([]), id: "bad id/../x" }, context)).toEqual({
      success: false,
      error: "invalid-session-id",
    });
    expect(sanitizeSessionForOrg(session([]), { ...context, workspaceId: "platform" })).toEqual({
      success: false,
      error: "invalid-workspace",
    });
  });

  it("marks the envelope restricted when a Brain result is wider than team", () => {
    const result = sanitizeSessionForOrg(
      session([
        message({
          id: "1",
          role: "assistant",
          toolCalls: [
            {
              id: "t1",
              name: "knowledge.search",
              description: "",
              output: JSON.stringify({ hits: [{ title: "Q3 plan", audience: "staff" }] }),
            },
          ],
        }),
      ]),
      context,
    );
    if (!result.success) throw new Error("expected success");
    expect(result.session.upload.labels).toBe("restricted");
  });
});

describe("findRestrictedItems", () => {
  const call = (name: string, output: unknown, id = "c1") => ({
    id,
    name,
    description: "",
    output: typeof output === "string" ? output : JSON.stringify(output),
  });

  it("lists Brain and memory results whose audience is not team", () => {
    const items = findRestrictedItems([
      message({
        id: "m1",
        role: "assistant",
        toolCalls: [
          call("knowledge.search", {
            hits: [
              { title: "Public roadmap", audience: "team" },
              { title: "Board notes", audience: "staff" },
            ],
          }),
          call("recall", [{ fact: "Alice's private reminder", audience: "user:alice" }], "c2"),
        ],
      }),
    ]);
    expect(items.map((item) => [item.source, item.audience, item.label])).toEqual([
      ["brain", "staff", "Board notes"],
      ["memory", "user:alice", "Alice's private reminder"],
    ]);
  });

  it("ignores team audiences, other tools, and unparseable output", () => {
    expect(
      findRestrictedItems([
        message({
          id: "m1",
          toolCalls: [
            call("knowledge.search", { hits: [{ title: "x", audience: ["team", "team"] }] }),
            call("shell", { hits: [{ title: "y", audience: "staff" }] }, "c2"),
            call("recall", "not json audience: staff", "c3"),
          ],
        }),
      ]),
    ).toEqual([]);
  });
});
