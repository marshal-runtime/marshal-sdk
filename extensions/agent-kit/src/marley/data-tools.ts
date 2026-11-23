// Extract of zygstinct apps/agent-server/src/data-tools.ts at 7110e58c8: only fail, ok, DataToolSpec.
import { z } from "zod";

const MAX_RESULT_CHARS = 20_000;

export type ToolText = {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (value: unknown): ToolText => ({ content: [{ type: "text", text: clip(typeof value === "string" ? value : JSON.stringify(value)) }] });

export const fail = (message: string): ToolText => ({ content: [{ type: "text", text: message }], isError: true });

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
}

/** One tool, independent of how it is served (in-process SDK server, stdio or streamable HTTP). */
export interface DataToolSpec {
  /** The key the VM extension sends in `/call`. Lower case letters, digits and underscores. */
  name: string;
  /** The runtime capability id the VM registers for this tool. Defaults to `zs.data.<name>`. */
  capability?: string;
  /** `brand`: same answer for everyone of the brand. `session`: bound to the conversation and speaker the token belongs to. */
  scope?: "brand" | "session";
  description: string;
  /** Server-owned fixed text added to the turn prompt only in a turn whose tool list includes this tool. */
  turnNote?: string;
  shape: z.ZodRawShape;
  handler(args: Record<string, unknown>): Promise<ToolText>;
  /** A read the VM answers from the staged turn snapshot (`reads[capability]`, no call to the server): the value staged with the turn. Present only for a tool listed in that turn, so only that turn's viewer gets it. */
  snapshot?(): unknown;
}
