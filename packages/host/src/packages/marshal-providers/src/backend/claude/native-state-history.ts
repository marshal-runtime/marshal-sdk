import type {
  MessageToolCall,
  ProviderSessionMessage as SessionMessage,
} from "../../contract/host-types";
import { stripHostTurnDecorations } from "../conversation-state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function textOfResult(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
    .filter(Boolean)
    .join("\n");
}

function timestampOf(entry: Record<string, unknown>): string {
  const raw = entry["timestamp"];
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? new Date(0).toISOString() : new Date(parsed).toISOString();
}

/**
 * The conversation a Claude session file holds, as the messages Marshal shows: user prompts, and
 * one assistant message per turn with its text, reasoning and tool calls (outputs attached).
 * Side chains (subagent work) and bookkeeping entries are skipped; `sidechain: true` reads a
 * subagent's own file instead, where every entry is a side chain.
 */
export function claudeJsonlToSessionMessages(
  bytes: Uint8Array,
  options: { sidechain?: boolean } = {},
): SessionMessage[] {
  const messages: SessionMessage[] = [];
  const toolCalls = new Map<string, MessageToolCall>();
  let assistant: SessionMessage | null = null;
  for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown; // SF-4: only read through the guards below
    } catch {
      continue;
    }
    if (!isRecord(entry) || (entry["isSidechain"] === true) !== (options.sidechain === true)) {
      continue;
    }
    const type = entry["type"];
    const message = isRecord(entry["message"]) ? entry["message"] : undefined;
    if ((type !== "user" && type !== "assistant") || !message) continue;
    const id = typeof entry["uuid"] === "string" ? entry["uuid"] : `native-${messages.length}`;
    const blocks = blocksOf(message["content"]);
    if (type === "user") {
      for (const block of blocks) {
        if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
        const call = toolCalls.get(block["tool_use_id"]);
        if (!call) continue;
        const output = textOfResult(block["content"]);
        if (block["is_error"] === true) {
          call.success = false;
          call.error = output;
        } else {
          call.success = true;
          call.output = output;
        }
      }
      if (entry["isMeta"] === true) continue;
      const raw = blocks
        .filter((block) => block["type"] === "text" && typeof block["text"] === "string")
        .map((block) => String(block["text"]))
        .join("\n");
      // Host-injected turns (background-task, relay-progress...) were never typed by the user.
      if (raw.trimStart().startsWith("<marshal-control")) continue;
      const text = stripHostTurnDecorations(raw).trim();
      if (!text) continue;
      assistant = null;
      messages.push({ id, role: "user", content: text, timestamp: timestampOf(entry) });
      continue;
    }
    if (!assistant) {
      assistant = { id, role: "assistant", content: "", timestamp: timestampOf(entry) };
      messages.push(assistant);
    }
    for (const block of blocks) {
      if (block["type"] === "text" && typeof block["text"] === "string") {
        assistant.content = assistant.content
          ? `${assistant.content}\n${block["text"]}`
          : block["text"];
      } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        assistant.reasoning = {
          text: assistant.reasoning
            ? `${assistant.reasoning.text}\n${block["thinking"]}`
            : block["thinking"],
          durationSeconds: null,
        };
      } else if (block["type"] === "tool_use" && typeof block["name"] === "string") {
        const call: MessageToolCall = {
          ...(typeof block["id"] === "string" ? { id: block["id"] } : {}),
          name: block["name"],
          description: block["name"],
          input: JSON.stringify(block["input"] ?? {}),
        };
        (assistant.toolCalls ??= []).push(call);
        if (call.id) toolCalls.set(call.id, call);
      }
    }
  }
  return messages.filter((message) => message.content || message.toolCalls?.length);
}

/** Claude Code CLI bookkeeping turns: slash-command echoes and their local output. */
const COMMAND_ECHO =
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;
/** Context Claude Code adds to a prompt (folder notices, reminders); not what the user typed. */
export const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The messages to show, without injected reminders or slash-command bookkeeping. */
export function claudeJsonlToDisplayMessages(
  bytes: Uint8Array,
  options: { sidechain?: boolean } = {},
): SessionMessage[] {
  return claudeJsonlToSessionMessages(bytes, options).flatMap((message) => {
    if (message.role !== "user") return [message];
    const content = message.content.replace(SYSTEM_REMINDER, "").trim();
    return content && !COMMAND_ECHO.test(content) ? [{ ...message, content }] : [];
  });
}
