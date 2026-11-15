/** Tools whose local conversations Marshal can import as its own sessions. */
export type SessionImportSourceId = "claude-code" | "codex" | "cursor";

export const SESSION_IMPORT_SOURCE_LABELS: Record<SessionImportSourceId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Where an imported session came from. Stored on the session; used to skip re-imports. */
export interface SessionImportOrigin {
  source: SessionImportSourceId;
  externalId: string;
  importedAt: string;
  /** The absolute folder the conversation ran in, kept even when it is not a registered workspace. */
  cwd?: string;
}

export interface SessionImportSourceSummary {
  id: SessionImportSourceId;
  label: string;
  /** True when the tool's local history was found on this machine. */
  available: boolean;
  /** The folder or database read, for display. */
  location: string;
  sessionCount: number;
  error?: string;
}

export interface SessionImportCandidate {
  source: SessionImportSourceId;
  externalId: string;
  title: string;
  /** The app that ran the conversation, e.g. "Claude Code CLI", "Claude app", "Codex app". */
  app: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  alreadyImported: boolean;
}

export interface SessionImportRef {
  source: SessionImportSourceId;
  externalId: string;
}

export interface SessionImportRunOptions {
  /** Register each conversation's project folder as a workspace when it is not one already. */
  addWorkspaces: boolean;
}

export interface SessionImportItemResult {
  source: SessionImportSourceId;
  externalId: string;
  status: "imported" | "skipped" | "failed";
  sessionId?: string;
  /** "native": the runtime resumes the original conversation; "transcript": it continues from the imported history. */
  mode?: "native" | "transcript";
  /** Claude Code subagents imported with it, as child sessions of `sessionId`. */
  subagents?: number;
  error?: string;
}

/** An import running in the background. Owned by the main process, so it survives closing the dialog. */
export interface SessionImportJob {
  id: string;
  status: "running" | "finished";
  total: number;
  /** Results so far, in request order; `results.length` is how many are done. */
  results: SessionImportItemResult[];
  startedAt: string;
  finishedAt?: string;
}

export function sessionImportKey(ref: SessionImportRef): string {
  return `${ref.source}:${ref.externalId}`;
}
