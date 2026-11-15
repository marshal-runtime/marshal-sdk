import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { rewriteClaudeSessionId } from "@marshal/agent-runtime-claude";

import type { SessionImportRef } from "../../common/session-import-contract";
import { ClaudeCodeImportSource } from "./claude-code";
import { SessionImporter, type SessionImportTarget } from "./importer";
import type { ImportedConversation, SessionImportReader } from "./sources";

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

/**
 * Imports one Claude conversation (and its subagents) as a normal local chat, the way a Claude Code conversation
 * is imported: written into a throwaway Claude config folder, read back by the Claude Code import source, and
 * created under `ref` so a later open of the same source finds this copy. The temp folder is always removed.
 */
export async function importClaudeTranscript(
  target: SessionImportTarget,
  input: ClaudeTranscriptImport,
): Promise<ClaudeTranscriptImportResult> {
  const configDir = await fs.promises.mkdtemp(
    path.join(input.tempRoot ?? os.tmpdir(), "marshal-chat-import-"),
  );
  try {
    const fileId = randomUUID();
    const projectDir = path.join(configDir, "projects", input.projectFolder);
    const subagentDir = path.join(projectDir, fileId, "subagents");
    await fs.promises.mkdir(subagentDir, { recursive: true });
    await input.writeFiles({ mainFile: path.join(projectDir, `${fileId}.jsonl`), subagentDir });
    const source = new ClaudeCodeImportSource({
      claudeConfigDir: configDir,
      claudeAppDir: path.join(configDir, "app"),
      codexHome: path.join(configDir, "codex"),
      cursorUserDir: path.join(configDir, "cursor"),
    });
    const reader: SessionImportReader = {
      scan: () => Promise.reject(new Error("A single conversation is never scanned")),
      load: async (_source, _externalId, backendId): Promise<ImportedConversation | null> => {
        const loaded = await source.load(fileId);
        if (!loaded) return null;
        const { claudeJsonl, ...rest } = loaded;
        return {
          ...rest,
          title: input.title,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(rest.subagents
            ? {
                subagents: rest.subagents.map((subagent) => ({
                  ...subagent,
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                })),
              }
            : {}),
          ...(claudeJsonl && backendId
            ? {
                claudeNative: {
                  backendId,
                  jsonl: rewriteClaudeSessionId(claudeJsonl, backendId),
                },
              }
            : {}),
        };
      },
    };
    const [result] = await new SessionImporter(target, reader).run([input.ref], {
      addWorkspaces: false,
    });
    if (result?.status !== "imported" || !result.sessionId) {
      return { success: false, status: result?.status ?? "none" };
    }
    return {
      success: true,
      sessionId: result.sessionId,
      ...(result.mode ? { mode: result.mode } : {}),
      ...(result.subagents !== undefined ? { subagents: result.subagents } : {}),
    };
  } finally {
    await fs.promises.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
