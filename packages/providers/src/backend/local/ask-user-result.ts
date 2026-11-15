function firstTextBlock(blocks: readonly unknown[]): string | undefined {
  for (const block of blocks) {
    if (
      block !== null &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return undefined;
}

/**
 * The askUser self-tool's JSON text from a PostToolUse `toolResult`, in every
 * shape a runtime reports it: a plain string, an MCP CallToolResult
 * (`{content: [...]}`), the bare content array the Claude CLI passes for MCP
 * tools (before this was handled, every askUser card on Claude was silently
 * dropped), or the Copilot mock's `{textResultForLlm}`. "" when none match.
 */
export function extractAskUserResultText(toolResult: unknown): string {
  if (typeof toolResult === "string") return toolResult;
  if (Array.isArray(toolResult)) return firstTextBlock(toolResult) ?? "";
  if (toolResult !== null && typeof toolResult === "object") {
    if ("content" in toolResult && Array.isArray(toolResult.content)) {
      const text = firstTextBlock(toolResult.content);
      if (text !== undefined) return text;
    }
    if ("textResultForLlm" in toolResult && typeof toolResult.textResultForLlm === "string") {
      return toolResult.textResultForLlm;
    }
  }
  return "";
}
