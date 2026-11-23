import type { SDKMessage } from "@zygstinct/marshal-sdk-port/agent-sdk";

export interface ToolCallEvents {
  /** A top-level tool call the model made: its id, the SDK's tool name and its input as delivered. */
  start(id: string, name: string, input: unknown): void;
  /** The result of that call came back (succeeded or failed), with the result's content blocks as the tool server answered them. */
  end(id: string, name: string, failed: boolean, content?: unknown): void;
  /**
   * A `start` or `end` handler threw, or the message could not be read: what it feeds (hand-off, skill uses, ran-tools, receipts) misses that call. Required, so
   * no caller can drop it; callers log it with the code `tool.observe_failed`.
   */
  failed(error: ToolObserverError): void;
}

/** Why the observer could not deliver one event: the phase, the call (when known) and the handler's own error as `cause`. */
export class ToolObserverError extends Error {
  readonly code = "tool.observe_failed";
  constructor(readonly phase: "start" | "end" | "read", readonly toolUseId: string | null, readonly tool: string | null, cause: unknown) {
    super(`tool-call observer ${phase} failed${tool ? ` for ${tool}` : ""}`, { cause });
    this.name = "ToolObserverError";
  }
}

/**
 * Tool calls read from a session's own messages: an assistant message's `tool_use` block starts a call, the user message carrying its `tool_result` ends
 * it. This is how Marley sees what a session does now that no session runs a hook. Calls of a subagent (`parent_tool_use_id`) are not the session's own.
 * A handler's error goes to `failed` as a typed ToolObserverError, one per call, and the remaining calls of the message are still delivered; the session's
 * stream is not interrupted by it.
 */
export function toolCallObserver(events: ToolCallEvents): (message: SDKMessage) => void {
  const open = new Map<string, string>();
  const deliver = (phase: "start" | "end", id: string, name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      events.failed(new ToolObserverError(phase, id, name, error));
    }
  };
  return (message) => {
    let blocks: unknown[];
    try {
      if (message.type !== "assistant" && message.type !== "user") return;
      if (message.parent_tool_use_id) return;
      const content = (message.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      blocks = content;
    } catch (error) {
      events.failed(new ToolObserverError("read", null, null, error));
      return;
    }
    if (message.type === "assistant") {
      for (const block of blocks) {
        const call = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
        if (call.type !== "tool_use" || typeof call.id !== "string" || typeof call.name !== "string") continue;
        const { id, name } = call as { id: string; name: string };
        open.set(id, name);
        deliver("start", id, name, () => events.start(id, name, call.input));
      }
      return;
    }
    for (const block of blocks) {
      const result = block as { type?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };
      if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
      const id = result.tool_use_id;
      const name = open.get(id);
      if (name === undefined) continue;
      open.delete(id);
      deliver("end", id, name, () => events.end(id, name, result.is_error === true, result.content));
    }
  };
}

/** Observes a stream without changing it: every message goes to `observe` before the reader gets it. `close` passes through. */
export function observedStream(stream: AsyncIterable<SDKMessage> & { close(): void }, observe: (message: SDKMessage) => void): AsyncIterable<SDKMessage> & { close(): void } {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<SDKMessage> => {
      const inner = stream[Symbol.asyncIterator]();
      return {
        next: async () => {
          const next = await inner.next();
          if (!next.done) observe(next.value);
          return next;
        },
        return: async (value?: unknown) => (inner.return ? inner.return(value) : { value: undefined, done: true }),
      };
    },
    close: () => stream.close(),
  };
}
