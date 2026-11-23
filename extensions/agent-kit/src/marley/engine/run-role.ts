import { query, type Options, type SDKMessage } from "@zygstinct/marshal-sdk-port/agent-sdk";

import { RoleRunError, sdkErrorFields } from "./role-run-error.js";
import type { Role } from "./roles.js";

export { RoleRunError, sdkErrorFields };

// Adapted from zyg-agents src/runner/engine/run-role.ts: a role session and its result record. A run has no turn, budget or time limit.
// The server needs the session id and context size while the session runs, so this variant streams to callbacks.

/** Starts an Agent SDK session; a seam for tests. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** The record of one finished session: what the nightly cost report and agent_turns rows need. */
export interface RoleRunRecord {
  text: string;
  sessionId: string | null;
  costUsd: number;
  turns: number;
  durationMs: number;
  subtype: string;
  contextTokens: number;
  /** The uuid of the session's last top-level assistant message: where a worker forks this turn's conversation (tasks/fork.ts). */
  lastMessageUuid?: string | null;
  /** The session's structured output (`outputFormat`), as the SDK validated it against the schema; absent when the run asked for none or gave none. */
  structuredOutput?: unknown;
}

export interface RunRoleRequest {
  role: Role;
  prompt: string;
  options: Options;
  signal?: AbortSignal;
  onSession?(sessionId: string): void;
  /** Sees every message of the stream; its errors are ignored. */
  onMessage?(message: SDKMessage): void;
  now?: () => number;
}

/**
 * The SDK options a role fixes: model and thinking (no turn or budget limit). Callers add tools, cwd, resume, hooks and servers.
 * A role with an effort thinks adaptively at that effort, with summarized thinking kept in the transcript for the inspector.
 */
export function roleOptions(role: Role, abortController: AbortController): Options {
  return {
    model: role.model,
    permissionMode: "dontAsk",
    settingSources: [],
    abortController,
    ...(role.effort ? { effort: role.effort, thinking: { type: "adaptive", display: "summarized" } as const } : {}),
  };
}

/** Runs a role session until it ends. Ends with a RoleRunError on an error result. */
export async function runRole(request: RunRoleRequest, queryFn: QueryFn = query): Promise<RoleRunRecord> {
  const { role, signal } = request;
  const now = request.now ?? Date.now;
  const controller = request.options.abortController ?? new AbortController();
  const startedAt = now();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const record: RoleRunRecord = { text: "", sessionId: null, costUsd: 0, turns: 0, durationMs: 0, subtype: "no_result", contextTokens: 0 };
  let finished = false;
  let thrown: { error: unknown } | null = null;
  try {
    for await (const message of queryFn({ prompt: request.prompt, options: { ...request.options, abortController: controller } })) {
      try { request.onMessage?.(message); } catch { /* an observer never fails the session */ }
      if (message.type === "system" && message.subtype === "init" && message.session_id !== record.sessionId) {
        record.sessionId = message.session_id;
        request.onSession?.(message.session_id);
      } else if (message.type === "assistant" && !message.parent_tool_use_id) {
        if (typeof message.uuid === "string") record.lastMessageUuid = message.uuid;
        const usage = message.message.usage as
          | { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
          | undefined;
        if (usage) record.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      } else if (message.type === "result") {
        finished = true;
        record.subtype = message.subtype;
        record.costUsd = message.total_cost_usd ?? 0;
        record.turns = message.num_turns ?? 0;
        record.sessionId = message.session_id ?? record.sessionId;
        if (message.subtype === "success" && !message.is_error) {
          record.text = message.result;
          if (message.structured_output !== undefined) record.structuredOutput = message.structured_output;
        } else record.subtype = message.is_error && message.subtype === "success" ? "error" : message.subtype;
      }
    }
  } catch (error) {
    // The SDK throws when the CLI exits after an error result: that ends as a RoleRunError with the result's subtype, so a caller never retries it as a
    // transport failure. Any other throw (a transport failure before a result, the caller's own abort) goes out unchanged.
    if (!(finished && record.subtype !== "success")) throw error;
    thrown = { error };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    record.durationMs = now() - startedAt;
  }
  if (!finished) {
    record.subtype = signal?.aborted ? "aborted" : "no_result";
  }
  if (record.subtype !== "success") {
    const error = new RoleRunError(role.name, record.subtype, record.costUsd);
    Object.assign(error, { record }, thrown ? { cause: thrown.error, ...sdkErrorFields(thrown.error) } : {});
    throw error;
  }
  return record;
}
