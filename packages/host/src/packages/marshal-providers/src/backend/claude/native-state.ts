import fs from "node:fs";

import {
  CLAUDE_NATIVE_STATE_FORMAT,
  claudeProjectDirectoryName,
  findClaudeSessionFile,
  forkClaudeSessionFile,
  isClaudeSessionId,
  MAX_NATIVE_STATE_BYTES,
  writeClaudeSessionFile,
  type ClaudeForkRequest,
} from "@marshal/agent-runtime-claude";

import type { ProviderSessionMessage as SessionMessage } from "../../contract/host-types";
import type { RuntimeNativeSessionState } from "../runtime-contract";
import { claudeJsonlToSessionMessages } from "./native-state-history";
import { sanitizeClaudeJsonl } from "./native-state-sanitizer";

export { CLAUDE_NATIVE_STATE_FORMAT, MAX_NATIVE_STATE_BYTES, claudeProjectDirectoryName };
export type { ClaudeForkRequest };

const INVALID_SESSION_ID = "Invalid Claude session id";

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
 * Writes a fork of a live session as `targetId`: the source file is copied unsanitized (it never
 * leaves this computer, and the copy must match the source byte for byte to reuse its prompt cache)
 * with the open fork call answered for the child. The CLI can run a tool before it has written the
 * assistant entry that called it, so the file is read again until that call is in it.
 */
export async function forkClaudeNativeState(
  configDir: string,
  sourceId: string,
  workingDirectory: string,
  request: ClaudeForkRequest,
  timeoutMs?: number,
): Promise<{ messages?: SessionMessage[]; discard: () => Promise<void> }> {
  const written = await forkClaudeSessionFile(
    configDir,
    sourceId,
    workingDirectory,
    request,
    timeoutMs,
  );
  return {
    messages: claudeJsonlToSessionMessages(written.bytes),
    discard: written.discard,
  };
}
