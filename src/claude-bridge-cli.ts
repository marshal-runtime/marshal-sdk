#!/usr/bin/env node
// The `marshal-claude` bin: what marshal_sdk (python/) gives claude_agent_sdk as its cli_path. See claude-bridge.ts.
import { runClaudeBridge } from "./claude-bridge.js";

runClaudeBridge(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`[marshal-claude] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
