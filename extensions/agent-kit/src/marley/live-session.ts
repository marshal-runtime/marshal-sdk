// Extract of zygstinct apps/agent-server/src/live-session.ts at 7110e58c8: only InputQueue.
import type { SDKUserMessage } from "@zygstinct/marshal-sdk-port/agent-sdk";

/** An async queue the SDK reads user messages from; `end` lets the process finish. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(prompt: string): void {
    if (this.ended) throw new Error("input closed");
    const message: SDKUserMessage = { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: async () => {
        this.end();
        return { value: undefined, done: true };
      },
    };
  }
}
