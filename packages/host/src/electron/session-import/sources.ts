import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SessionMessage } from "../../common/marshal-ipc-contract";
import type {
  SessionImportCandidate,
  SessionImportSourceId,
  SessionImportSourceSummary,
} from "../../common/session-import-contract";

/**
 * Where each tool keeps its history. These are the tools' own default locations: Marshal sets
 * CLAUDE_CONFIG_DIR and CODEX_HOME to its own folders, so those variables must not be read here.
 */
export interface SessionImportPaths {
  claudeConfigDir: string;
  claudeAppDir: string;
  codexHome: string;
  cursorUserDir: string;
}

export function defaultSessionImportPaths(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  appData: string | undefined = process.env["APPDATA"],
): SessionImportPaths {
  const appSupport =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? (appData ?? path.join(home, "AppData", "Roaming"))
        : path.join(home, ".config");
  return {
    claudeConfigDir: path.join(home, ".claude"),
    claudeAppDir: path.join(appSupport, "Claude"),
    codexHome: path.join(home, ".codex"),
    cursorUserDir: path.join(appSupport, "Cursor", "User"),
  };
}

export type ImportCandidate = Omit<SessionImportCandidate, "alreadyImported"> & {
  /** Claude Code subagents of the conversation, so a partly imported one is offered again. */
  subagentIds?: string[];
};

export interface ImportSourceScan {
  summary: SessionImportSourceSummary;
  candidates: ImportCandidate[];
}

export interface LoadedConversation {
  title: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  /** Claude Code's own session file, restored natively when the Claude runtime is available. */
  claudeJsonl?: Uint8Array;
  /** Subagents Claude Code launched from this conversation (its Agent/Task tool), oldest first. */
  subagents?: ImportedSubagent[];
}

export interface ImportedSubagent {
  agentId: string;
  /** The description the parent gave the agent. */
  title: string;
  agentType?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

/** A conversation ready to store: a Claude session file arrives already pointed at its new id. */
export interface ImportedConversation extends Omit<LoadedConversation, "claudeJsonl"> {
  claudeNative?: { backendId: string; jsonl: Uint8Array };
}

export interface SessionImportSource {
  readonly id: SessionImportSourceId;
  scan(): Promise<ImportSourceScan>;
  load(externalId: string): Promise<LoadedConversation | null>;
}

/** What the importer reads through: the import process in production (`ImportWorkerClient`). */
export interface SessionImportReader {
  scan(source: SessionImportSourceId): Promise<ImportSourceScan>;
  /** `claudeBackendId`: for Claude Code, the id a restorable session file is rewritten to. */
  load(
    source: SessionImportSourceId,
    externalId: string,
    claudeBackendId?: string,
  ): Promise<ImportedConversation | null>;
}

type Database = import("node:sqlite").DatabaseSync;

/**
 * Opens another app's SQLite database without writing to it. A live app may hold it in WAL mode;
 * when a read-only open fails, the file is read as immutable (the last checkpointed state).
 */
export function openReadOnlyDatabase(file: string): Database | null {
  if (!fs.existsSync(file)) return null;
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (!sqlite) return null;
  try {
    const database = new sqlite.DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    database.exec("PRAGMA busy_timeout = 2000");
    return database;
  } catch {
    try {
      return new sqlite.DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    } catch {
      return null;
    }
  }
}

export function withDatabase<T>(file: string, read: (database: Database) => T): T | null {
  const database = openReadOnlyDatabase(file);
  if (!database) return null;
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export function sqliteText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonRecord(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text); // SF-4: narrowed to a plain object below
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
