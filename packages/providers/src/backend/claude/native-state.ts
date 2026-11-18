import fs from "node:fs";

import {
  CLAUDE_NATIVE_STATE_FORMAT,
  claudeProjectDirectoryName,
  findClaudeSessionFile,
  FORK_CALL_FLUSH_TIMEOUT_MS,
  FORK_CALL_NOT_FOUND,
  forkClaudeJsonl,
  isClaudeSessionId,
  MAX_NATIVE_STATE_BYTES,
  writeClaudeSessionFile,
  type ClaudeForkRequest,
} from "@marshal/agent-runtime-claude";

import type { ProviderSessionMessage as SessionMessage } from "../../contract/host-types";
import type { RuntimeNativeSessionState } from "../runtime-contract";
import { bufferOver, concatBytes } from "./jsonl-lines";
import { claudeJsonlToSessionMessages } from "./native-state-history";
import { sanitizeClaudeJsonl } from "./native-state-sanitizer";

export { CLAUDE_NATIVE_STATE_FORMAT, MAX_NATIVE_STATE_BYTES, claudeProjectDirectoryName };
export type { ClaudeForkRequest };

const INVALID_SESSION_ID = "Invalid Claude session id";
const FORK_CALL_POLL_MS = 100;
const NEWLINE_BYTE = 0x0a;
const BACKGROUND_TASK_KEY = Buffer.from('"backgroundTaskId"');

/**
 * Reads the session's native JSONL for export, or null when Claude has not persisted it. The bytes
 * are sanitized: prompt snapshots dropped, every string redacted, inline images replaced.
 */
export async function readClaudeNativeState(
  configDir: string,
  sessionId: string,
  workingDirectory: string,
): Promise<RuntimeNativeSessionState | null> {
  if (!isClaudeSessionId(sessionId)) throw new Error(INVALID_SESSION_ID);
  const file = await findClaudeSessionFile(configDir, sessionId, workingDirectory);
  if (!file) return null;
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_NATIVE_STATE_BYTES) throw new Error("native-state-too-large");
  return {
    format: CLAUDE_NATIVE_STATE_FORMAT,
    bytes: sanitizeClaudeJsonl(await fs.promises.readFile(file)),
  };
}

/**
 * Replaces the session's native JSONL atomically, keeping the previous file as `.bak`. Returns the
 * conversation the new file holds so the caller can rebuild the visible history.
 */
export async function writeClaudeNativeState(
  configDir: string,
  sessionId: string,
  workingDirectory: string,
  state: RuntimeNativeSessionState,
): Promise<{ messages?: SessionMessage[]; discard: () => Promise<void> }> {
  if (!isClaudeSessionId(sessionId)) throw new Error(INVALID_SESSION_ID);
  if (state.format !== CLAUDE_NATIVE_STATE_FORMAT) throw new Error("unsupported-native-format");
  if (state.bytes.byteLength > MAX_NATIVE_STATE_BYTES) throw new Error("native-state-too-large");
  const written = await writeClaudeSessionFile(configDir, sessionId, workingDirectory, state.bytes);
  return {
    ...(state.skipHistory ? {} : { messages: claudeJsonlToSessionMessages(state.bytes) }),
    discard: written.discard,
  };
}

/**
 * Background commands stay with the session that started them. On resume the CLI reports every
 * command it finds started in the file (`toolUseResult.backgroundTaskId`) without a completion
 * record as stopped, and that notice runs as the fork's first turn, ahead of its task (2026-11-16,
 * fork c26e32f8 woke on its parent's merge watcher). The fork's copy drops those ids. The model
 * never sees `toolUseResult`, so the copy still matches the parent's prompt cache.
 */
export function detachParentBackgroundTasks(bytes: Uint8Array): Uint8Array {
  const source = bufferOver(bytes);
  const parts: Uint8Array[] = [];
  let copied = 0;
  // Only the lines that name a background task are decoded; the rest is copied as bytes.
  for (let at = source.indexOf(BACKGROUND_TASK_KEY); at >= 0; ) {
    const lineStart = source.lastIndexOf(NEWLINE_BYTE, at) + 1;
    const newline = source.indexOf(NEWLINE_BYTE, at);
    const lineEnd = newline < 0 ? source.length : newline;
    const detached = withoutBackgroundTask(source.toString("utf8", lineStart, lineEnd));
    if (detached !== undefined) {
      parts.push(source.subarray(copied, lineStart), Buffer.from(detached));
      copied = lineEnd;
    }
    at = source.indexOf(BACKGROUND_TASK_KEY, lineEnd);
  }
  if (parts.length === 0) return bytes;
  parts.push(source.subarray(copied));
  return concatBytes(parts);
}

/** The line without its background task id, or undefined when it does not carry one. */
function withoutBackgroundTask(line: string): string | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const result = (entry as { toolUseResult?: unknown }).toolUseResult;
  if (typeof result !== "object" || result === null || !("backgroundTaskId" in result)) {
    return undefined;
  }
  delete (result as { backgroundTaskId?: unknown }).backgroundTaskId;
  return JSON.stringify(entry);
}

/**
 * Writes a fork of a live session as `targetId`: the source file is copied unsanitized (it never
 * leaves this computer, and the copy must match the source byte for byte to reuse its prompt cache)
 * with the open fork call answered for the child and the parent's background commands left to the
 * parent. The CLI can run a tool before it has written the assistant entry that called it, so the
 * file is read again until that call is in it.
 */
export async function forkClaudeNativeState(
  configDir: string,
  sourceId: string,
  workingDirectory: string,
  request: ClaudeForkRequest,
  timeoutMs = FORK_CALL_FLUSH_TIMEOUT_MS,
): Promise<{ messages?: SessionMessage[]; discard: () => Promise<void> }> {
  if (!isClaudeSessionId(sourceId)) throw new Error(INVALID_SESSION_ID);
  const file = await findClaudeSessionFile(configDir, sourceId, workingDirectory);
  if (!file) throw new Error("fork-source-missing");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_NATIVE_STATE_BYTES) throw new Error("native-state-too-large");
    let forked: Uint8Array;
    try {
      forked = forkClaudeJsonl(await fs.promises.readFile(file), request);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== FORK_CALL_NOT_FOUND) throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, FORK_CALL_POLL_MS));
      continue;
    }
    const written = await writeClaudeSessionFile(
      configDir,
      request.sessionId,
      workingDirectory,
      detachParentBackgroundTasks(forked),
    );
    return {
      messages: claudeJsonlToSessionMessages(written.bytes),
      discard: written.discard,
    };
  }
}
