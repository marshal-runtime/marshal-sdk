import type { MessageToolCall, SessionMessage } from "../../common/marshal-ipc-contract";

/**
 * Imported tool inputs and outputs are kept for reading back, not replay; huge payloads are cut.
 * At 20k a Codex thread with 8.6k tool calls stored 51 MB and a 17 MB chunk; at 8k, 36 MB / 13 MB.
 */
export const IMPORTED_TOOL_FIELD_CHARS = 8_000;

export function clipImported(text: string, limit = IMPORTED_TOOL_FIELD_CHARS): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… [truncated on import]` : text;
}

export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds and milliseconds both occur; nothing imported predates 2001 in seconds.
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    if (/^\d+$/.test(value)) return toIsoTimestamp(Number(value));
  }
  return undefined;
}

/**
 * Builds Marshal's message shape from another tool's history: user prompts, and one assistant
 * message per turn holding its text, reasoning and tool calls in order.
 */
export class TranscriptBuilder {
  private readonly messages: SessionMessage[] = [];
  private assistant: SessionMessage | null = null;
  private lastTimestamp = new Date(0).toISOString();

  user(text: string, timestamp: string | undefined, id: string): void {
    const content = text.trim();
    if (!content) return;
    this.assistant = null;
    this.messages.push({ id, role: "user", content, timestamp: this.stamp(timestamp) });
  }

  assistantText(text: string, timestamp: string | undefined, id: string): void {
    const content = text.trim();
    if (!content) return;
    const message = this.currentAssistant(timestamp, id);
    message.content = message.content ? `${message.content}\n\n${content}` : content;
  }

  reasoning(text: string, timestamp: string | undefined, id: string): void {
    const content = text.trim();
    if (!content) return;
    const message = this.currentAssistant(timestamp, id);
    message.reasoning = {
      text: message.reasoning ? `${message.reasoning.text}\n\n${content}` : content,
      durationSeconds: null,
    };
  }

  /** Returns the stored call, so an output that arrives later can be attached to it. */
  tool(call: MessageToolCall, timestamp: string | undefined, id: string): MessageToolCall {
    const message = this.currentAssistant(timestamp, id);
    const stored: MessageToolCall = {
      ...call,
      ...(call.input !== undefined ? { input: clipImported(call.input) } : {}),
      ...(call.output !== undefined ? { output: clipImported(call.output) } : {}),
      ...(call.error !== undefined ? { error: clipImported(call.error) } : {}),
    };
    (message.toolCalls ??= []).push(stored);
    return stored;
  }

  build(): SessionMessage[] {
    return this.messages.filter((message) => message.content || message.toolCalls?.length);
  }

  private currentAssistant(timestamp: string | undefined, id: string): SessionMessage {
    if (!this.assistant) {
      this.assistant = { id, role: "assistant", content: "", timestamp: this.stamp(timestamp) };
      this.messages.push(this.assistant);
    }
    return this.assistant;
  }

  private stamp(timestamp: string | undefined): string {
    if (timestamp) this.lastTimestamp = timestamp;
    return this.lastTimestamp;
  }
}

/** First line of a prompt, shortened for a session title. */
export function titleFromPrompt(text: string | undefined, fallback: string): string {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
