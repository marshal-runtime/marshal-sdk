import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeProjectDirectoryName,
  detachParentBackgroundTasks,
  forkClaudeNativeState,
  readClaudeNativeState,
  writeClaudeNativeState,
} from "./native-state";

const directories: string[] = [];
function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-state-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ParsedEntry {
  uuid: string;
  message: { content: Record<string, string>[] };
}
function isEntry(value: unknown): value is ParsedEntry {
  return typeof value === "object" && value !== null && "message" in value;
}

describe("Claude native session state", () => {
  it("reads the session file from the project directory of the working directory", async () => {
    const configDir = tempConfigDir();
    const projectDir = path.join(configDir, "projects", claudeProjectDirectoryName("/repo/app"));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "abc-123.jsonl"), '{"type":"user"}\n');
    const state = await readClaudeNativeState(configDir, "abc-123", "/repo/app");
    expect(state?.format).toBe("claude-jsonl");
    expect(Buffer.from(state!.bytes).toString()).toBe('{"type":"user"}\n');
  });

  it("keeps a long working directory's session where Claude Code looks for it", async () => {
    const configDir = tempConfigDir();
    const longDirectory = `/work/${"segment-number-with-a-long-name/".repeat(12)}app`;
    const name = claudeProjectDirectoryName(longDirectory);
    expect(name).toMatch(/^.{200}-[a-z0-9]+$/);
    await writeClaudeNativeState(configDir, "long-1", longDirectory, {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("{}\n"),
    });
    expect(fs.existsSync(path.join(configDir, "projects", name, "long-1.jsonl"))).toBe(true);
  });

  it("finds the file in another project directory and returns null when absent", async () => {
    const configDir = tempConfigDir();
    const other = path.join(configDir, "projects", "-other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "s1.jsonl"), "x\n");
    expect(await readClaudeNativeState(configDir, "s1", "/elsewhere")).not.toBeNull();
    expect(await readClaudeNativeState(configDir, "missing", "/elsewhere")).toBeNull();
  });

  it("writes atomically over an existing file and creates the project directory when new", async () => {
    const configDir = tempConfigDir();
    const bytes = new TextEncoder().encode("new\n");
    await writeClaudeNativeState(configDir, "s2", "/repo/app", { format: "claude-jsonl", bytes });
    const target = path.join(configDir, "projects", "-repo-app", "s2.jsonl");
    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
    await writeClaudeNativeState(configDir, "s2", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("newer\n"),
    });
    expect(fs.readFileSync(target, "utf8")).toBe("newer\n");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["s2.jsonl", "s2.jsonl.bak"]);
  });

  it("discard removes a file it created, and puts back the one it replaced", async () => {
    const configDir = tempConfigDir();
    const file = (name: string) => path.join(configDir, "projects", "-repo-app", name);
    const first = await writeClaudeNativeState(configDir, "s5", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("one\n"),
    });
    await first.discard();
    expect(fs.existsSync(file("s5.jsonl"))).toBe(false);
    await writeClaudeNativeState(configDir, "s5", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("one\n"),
    });
    const second = await writeClaudeNativeState(configDir, "s5", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("two\n"),
    });
    await second.discard();
    expect(fs.readFileSync(file("s5.jsonl"), "utf8")).toBe("one\n");
    expect(fs.existsSync(file("s5.jsonl.bak"))).toBe(false);
  });

  it("refuses unsafe ids and foreign formats", async () => {
    const configDir = tempConfigDir();
    await expect(readClaudeNativeState(configDir, "../x", "/r")).rejects.toThrow("Invalid");
    await expect(
      writeClaudeNativeState(configDir, "s3", "/r", { format: "other", bytes: new Uint8Array(1) }),
    ).rejects.toThrow("unsupported-native-format");
  });

  it("keeps the previous file as .bak and returns the conversation it wrote", async () => {
    const configDir = tempConfigDir();
    await writeClaudeNativeState(configDir, "s4", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode("old\n"),
    });
    const entry = { type: "user", uuid: "u1", message: { role: "user", content: "hello" } };
    const result = await writeClaudeNativeState(configDir, "s4", "/repo/app", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode(`${JSON.stringify(entry)}\n`),
    });
    const target = path.join(configDir, "projects", "-repo-app", "s4.jsonl");
    expect(fs.readFileSync(`${target}.bak`, "utf8")).toBe("old\n");
    expect(result.messages).toMatchObject([{ id: "u1", role: "user", content: "hello" }]);
  });

  it("writes the file without parsing it back when the caller has the transcript", async () => {
    const configDir = tempConfigDir();
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } })}\n`,
    );
    const result = await writeClaudeNativeState(configDir, "s6", "/repo/app", {
      format: "claude-jsonl",
      bytes,
      skipHistory: true,
    });
    expect(result.messages).toBeUndefined();
    const target = path.join(configDir, "projects", "-repo-app", "s6.jsonl");
    expect(fs.readFileSync(target)).toEqual(Buffer.from(bytes));
  });

  it("exports a sanitized copy: redacted strings, no prompt snapshot or capture, image replaced", async () => {
    const configDir = tempConfigDir();
    const pat = `ghp_${"d".repeat(36)}`;
    const lines = [
      { type: "attachment", attachment: { type: "prompt_snapshot", content: "SYSTEM PROMPT" } },
      { type: "api-request", body: "captured" },
      {
        type: "user",
        uuid: "u1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: `password=hunter2hunter2 ${pat}` },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "B".repeat(5000) },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "x", signature: "S+/=" }],
        },
      },
    ];
    const dir = path.join(configDir, "projects", "-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s5.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json with ${pat}\n`,
    );
    const state = await readClaudeNativeState(configDir, "s5", "/repo");
    const text = Buffer.from(state!.bytes).toString("utf8");
    expect(text).not.toContain("SYSTEM PROMPT");
    expect(text).not.toContain("captured");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).not.toContain(pat);
    expect(text).not.toContain("BBBBBBBB");
    expect(text).toContain("[image omitted: image/png");
    expect(text).toContain("S+/=");
    expect(text).toContain('"uuid":"a1"');
  });

  it("drops a thinking block whose text redaction would change, keeps untouched and redacted ones", async () => {
    const configDir = tempConfigDir();
    const pat = `ghp_${"e".repeat(36)}`;
    const assistant = (uuid: string, content: unknown[]) => ({
      type: "assistant",
      uuid,
      message: { role: "assistant", content },
    });
    const lines = [
      assistant("a1", [
        { type: "thinking", thinking: `use ${pat} to log in`, signature: "SIG-CHANGED" },
        { type: "text", text: "ok" },
      ]),
      assistant("a2", [{ type: "thinking", thinking: `token ${pat}`, signature: "SIG-ONLY" }]),
      assistant("a3", [{ type: "thinking", thinking: "plain thought", signature: "SIG-KEPT" }]),
      assistant("a4", [{ type: "redacted_thinking", data: "opaque" }]),
    ];
    const dir = path.join(configDir, "projects", "-repo");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s6.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const state = await readClaudeNativeState(configDir, "s6", "/repo");
    const entries = Buffer.from(state!.bytes)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
      .filter(isEntry);
    const text = JSON.stringify(entries);
    expect(text).not.toContain(pat);
    expect(text).not.toContain("SIG-CHANGED");
    expect(text).not.toContain("SIG-ONLY");
    expect(entries[0]?.message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(entries[1]?.message.content).toEqual([{ type: "text", text: "[reasoning omitted]" }]);
    expect(entries[2]?.message.content[0]).toMatchObject({ signature: "SIG-KEPT" });
    expect(entries[3]?.message.content[0]).toMatchObject({
      type: "redacted_thinking",
      data: "opaque",
    });
  });

  it("rebuilds the visible history without host-injected turns, reminders or the steering prefix", async () => {
    const configDir = tempConfigDir();
    const reminder =
      '<marshal-system-reminder kind="active-relay-access-points">\nuse relay\n</marshal-system-reminder>';
    const steering =
      "<system_instruction>\nThe user sent this while you worked.\n</system_instruction>";
    const user = (uuid: string, content: unknown) => ({
      type: "user",
      uuid,
      message: { role: "user", content },
    });
    const lines = [
      user("u1", `list files\n\n${reminder}`),
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: "done" } },
      user("u2", `${steering}\n\nactually only ts files`),
      user("u3", [
        {
          type: "text",
          text: '<marshal-control kind="background-task">\nfinished\n</marshal-control>',
        },
      ]),
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: "ts only" } },
    ];
    const result = await writeClaudeNativeState(configDir, "s7", "/repo", {
      format: "claude-jsonl",
      bytes: new TextEncoder().encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`),
    });
    expect(result.messages?.map((message) => [message.role, message.content])).toEqual([
      ["user", "list files"],
      ["assistant", "done"],
      ["user", "actually only ts files"],
      ["assistant", "ts only"],
    ]);
  });
});

describe("forkClaudeNativeState", () => {
  const user = {
    type: "user",
    uuid: "u1",
    sessionId: "parent",
    message: { role: "user", content: "go" },
  };
  const forkCall = {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: "parent",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "mcp__marshal__forkSubagents", input: {} },
      ],
    },
  };
  const request = {
    sessionId: "child",
    toolName: "forkSubagents",
    result: "fork 1",
    otherResult: "-",
  };

  function writeSource(configDir: string, entries: object[]): string {
    const projectDir = path.join(configDir, "projects", claudeProjectDirectoryName("/repo"));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, "parent.jsonl");
    fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return projectDir;
  }

  it("waits for the CLI to write the fork call, then writes the child beside the source", async () => {
    const configDir = tempConfigDir();
    const projectDir = writeSource(configDir, [user]);
    setTimeout(() => {
      fs.appendFileSync(path.join(projectDir, "parent.jsonl"), `${JSON.stringify(forkCall)}\n`);
    }, 150);
    const { messages } = await forkClaudeNativeState(configDir, "parent", "/repo", request);
    const child = fs.readFileSync(path.join(projectDir, "child.jsonl"), "utf8");
    expect(child).toContain('"tool_use_id":"toolu_1"');
    expect(child).not.toContain('"sessionId":"parent"');
    expect(messages?.[0]?.content).toBe("go");
  });

  it("leaves the parent's background commands to the parent", async () => {
    const configDir = tempConfigDir();
    const backgroundCall = {
      type: "assistant",
      uuid: "a0",
      parentUuid: "u1",
      sessionId: "parent",
      message: {
        id: "msg_0",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "watch" } }],
      },
    };
    const backgroundStarted = {
      type: "user",
      uuid: "u2",
      parentUuid: "a0",
      sessionId: "parent",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: "toolu_bg",
            type: "tool_result",
            content: "Command running in background with ID: boft0icii.",
          },
        ],
      },
      toolUseResult: { stdout: "", backgroundTaskId: "boft0icii" },
    };
    const projectDir = writeSource(configDir, [
      user,
      backgroundCall,
      backgroundStarted,
      { ...forkCall, parentUuid: "u2" },
    ]);
    await forkClaudeNativeState(configDir, "parent", "/repo", request);
    const child = fs.readFileSync(path.join(projectDir, "child.jsonl"), "utf8");
    expect(child).not.toContain("backgroundTaskId");
    // The model still sees the same tool result, so the prompt cache matches.
    expect(child).toContain("Command running in background with ID: boft0icii.");
    expect(fs.readFileSync(path.join(projectDir, "parent.jsonl"), "utf8")).toContain(
      '"backgroundTaskId":"boft0icii"',
    );
  });

  it("gives up when the fork call never appears", async () => {
    const configDir = tempConfigDir();
    writeSource(configDir, [user]);
    await expect(forkClaudeNativeState(configDir, "parent", "/repo", request, 250)).rejects.toThrow(
      "fork-call-not-found",
    );
  });
});

describe("detachParentBackgroundTasks", () => {
  const started = (id: string, extra: object = {}) =>
    JSON.stringify({ type: "user", uuid: id, toolUseResult: { stdout: "שלום 👋", ...extra } });

  it("rewrites only the entries that started a background command and copies the rest byte for byte", () => {
    const topLevelKey = JSON.stringify({ type: "user", backgroundTaskId: "not a tool result" });
    const source = [
      'not json "backgroundTaskId"',
      `${started("b1", { backgroundTaskId: "b1" })}\r`,
      `${topLevelKey}\r`,
      "",
      started("plain"),
      started("b2", { backgroundTaskId: "b2" }),
    ].join("\n");

    const out = Buffer.from(detachParentBackgroundTasks(Buffer.from(source))).toString("utf8");

    expect(out.split("\n")).toEqual([
      'not json "backgroundTaskId"',
      started("b1"),
      `${topLevelKey}\r`,
      "",
      started("plain"),
      started("b2"),
    ]);
  });

  it("returns the bytes it was given when no entry started a background command", () => {
    const bytes = Buffer.from(`${started("plain")}\n`);
    expect(detachParentBackgroundTasks(bytes)).toBe(bytes);
  });
});
