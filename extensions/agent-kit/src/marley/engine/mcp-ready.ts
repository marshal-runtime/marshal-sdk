import type { McpServerStatus, Query } from "@zygstinct/marshal-sdk-port/agent-sdk";

import { InputQueue } from "../live-session.js";
import type { QueryFn } from "./run-role.js";

// A background worker is a fresh Claude Code process: Claude Code connects its MCP servers (the brand's `marshal` runtime) in the
// background, and a first model request that starts before they are registered offers no `mcp__marshal__*` tools, so the model's first
// calls fail with "No such tool available" and it gives up or guesses (local worker transcripts, 2026-11-04: 6 of 12 runs, also with
// MCP_TIMEOUT raised). The worker's prompt is therefore not sent until `mcpServerStatus()` reports the servers connected.
// SB01 holds: this only waits on the VM-side server; every model-selected tool still runs on the brand VM.

export interface McpReadyOptions {
  /** Servers that must be connected before the prompt is sent. */
  servers: string[];
  /** Longest wait; after it the prompt is sent with a notice that the tools may be missing. */
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: "mcp.ready" | "mcp.not_ready", fields: Record<string, unknown>) => void;
}

export interface McpReadiness {
  ready: boolean;
  waitedMs: number;
  states: Record<string, string>;
}

const MAX_RECONNECTS = 2;

/** Polls the process's MCP server status until every wanted server is connected, one is unusable, the deadline passes or the signal aborts. */
export async function waitForMcp(handle: Pick<Query, "mcpServerStatus"> & Partial<Pick<Query, "reconnectMcpServer">>, options: McpReadyOptions, signal?: AbortSignal): Promise<McpReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 500;
  const startedAt = now();
  const states: Record<string, string> = Object.fromEntries(options.servers.map((name) => [name, "unseen"]));
  let reconnects = 0;
  for (;;) {
    let statuses: McpServerStatus[] = [];
    try { statuses = await handle.mcpServerStatus(); } catch { /* the control channel is not up yet: poll again */ }
    for (const name of options.servers) states[name] = statuses.find((status) => status.name === name)?.status ?? "unseen";
    const waitedMs = now() - startedAt;
    if (options.servers.every((name) => states[name] === "connected")) return { ready: true, waitedMs, states };
    if (options.servers.some((name) => states[name] === "needs-auth" || states[name] === "disabled")) return { ready: false, waitedMs, states };
    if (signal?.aborted || waitedMs >= options.timeoutMs) return { ready: false, waitedMs, states };
    for (const name of options.servers) {
      if (states[name] === "failed" && reconnects < MAX_RECONNECTS && handle.reconnectMcpServer) {
        reconnects += 1;
        try { await handle.reconnectMcpServer(name); } catch { /* counted: the next poll shows the state */ }
      }
    }
    await sleep(pollMs);
  }
}

/** What the worker is told when its tool server did not come up: no guessing, the scripts that need no MCP, and a plain statement in the finding. */
export function mcpNotice(readiness: McpReadiness): string {
  const states = Object.entries(readiness.states).map(([name, state]) => `${name}: ${state}`).join(", ");
  return `Tool server notice: the brand's tool server (the mcp__marshal__* tools) was not connected when this task started (${states}, after ${Math.round(readiness.waitedMs / 1000)} s). Try one cheap mcp__marshal__runtime_search call first. If it still fails with "No such tool available", do not guess a tool name, a table or a figure: run the shipped scripts that need no tool server through Bash (owner reports: node /opt/zygstinct/experience/skills/owner-reports/run.mjs daily or monthly) for what they cover, and say in the finding which tools were unavailable and exactly which questions you could not check.\n\n`;
}

/**
 * Wraps a query function so a string prompt reaches the process only after its MCP servers are connected. The process starts at once (its
 * servers connect meanwhile) and reads its prompt from a streaming input that this wrapper feeds. A query without a control channel
 * (a test fake) gets the prompt immediately.
 */
export function gateOnMcp(inner: QueryFn, options: McpReadyOptions): QueryFn {
  return ({ prompt, options: queryOptions }) => {
    const input = new InputQueue();
    const started = inner({ prompt: input as unknown as string, options: queryOptions });
    const handle = started as Partial<Query>;
    if (typeof handle.mcpServerStatus !== "function") {
      input.push(prompt);
      input.end();
      return started;
    }
    void waitForMcp(handle as Query, options, queryOptions.abortController?.signal)
      .catch((): McpReadiness => ({ ready: false, waitedMs: 0, states: {} }))
      .then((readiness) => {
        options.log?.(readiness.ready ? "mcp.ready" : "mcp.not_ready", { waitedMs: readiness.waitedMs, states: readiness.states });
        if (queryOptions.abortController?.signal.aborted) return input.end();
        input.push(readiness.ready ? prompt : mcpNotice(readiness) + prompt);
        input.end();
      });
    return started;
  };
}
