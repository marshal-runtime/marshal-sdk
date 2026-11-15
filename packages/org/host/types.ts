// Host-side types the org package names. The desktop points these at its IPC contract and runtime contracts; an SDK
// host has no IPC contract, so they are the open shapes the org code reads and writes.

import type { SessionImportRef } from "./session-import-contract";

export type MarshalRuntimeApiErrorCode =
  | "aborted"
  | "approval-required"
  | "idempotency-capacity"
  | "idempotency-conflict"
  | "invalid-request"
  | "not-found"
  | "permission-denied"
  | "runtime-unavailable"
  | "operation-failed";

export interface MarshalRuntimeApiError {
  readonly code: MarshalRuntimeApiErrorCode;
  readonly message: string;
  readonly approval?: unknown;
}

export type MarshalRuntimeApiResult<T> =
  | { readonly ok: true; readonly value: T; readonly receipts: readonly unknown[] }
  | { readonly ok: false; readonly error: MarshalRuntimeApiError; readonly receipts: readonly unknown[] };

export interface MarshalRuntimeScope {
  readonly sessionId: string;
  readonly workspaceName: string;
}

export interface RuntimeExtensionRecord {
  readonly identity: string;
  readonly version: string;
  readonly integrity: { readonly algorithm: string; readonly domain: string; readonly value: string };
  readonly [field: string]: any;
}

export interface FirstPartyExtensionCatalogEntry {
  readonly identity: string;
  readonly version: string;
  readonly packageName: string;
  readonly bundledLocation: readonly string[];
  readonly integrity: { readonly algorithm: string; readonly domain: string; readonly value: string };
}

/** The slice of a runtime host's API the org code calls (catalog listing, capability search). */
export interface MarshalRuntimeApi {
  search(request: any): Promise<
    MarshalRuntimeApiResult<{ matches: Array<{ capability: { name: string; provider: { id: string }; [field: string]: any } }> }>
  >;
  listExtensions(request: any): Promise<MarshalRuntimeApiResult<readonly RuntimeExtensionRecord[]>>;
  [method: string]: any;
}

/** A Marshal session message as the org code reads it (role, content, timestamps, internal-control flags). */
export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  internalControl?: { side?: string; kind?: string; [field: string]: any };
  toolCalls?: any[];
  contentBlocks?: Array<{ type: string; toolCalls?: any[]; [field: string]: any }>;
  content: string;
  [field: string]: any;
}

/** The host's settings object; the org code reads its org section. */
export interface MSettings {
  [field: string]: any;
}

export interface ISessionStore {
  [method: string]: any;
}

export interface SessionImportTarget {
  [field: string]: any;
}

export interface RoutineDefinition {
  id: string;
  [field: string]: any;
}

export interface ClaudeTranscriptImport {
  ref: SessionImportRef;
  title: string;
  cwd?: string;
  /** Folder name under the temporary `projects/` dir; only shapes the temp layout. */
  projectFolder: string;
  /** Writes the conversation: the main `.jsonl` at `mainFile`, subagents as `agent-<id>.jsonl` in `subagentDir`. */
  writeFiles: (paths: { mainFile: string; subagentDir: string }) => Promise<void>;
  tempRoot?: string;
}

export type ClaudeTranscriptImportResult =
  | { success: true; sessionId: string; mode?: string; subagents?: number }
  | { success: false; status: string };
