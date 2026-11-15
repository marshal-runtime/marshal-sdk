import { randomUUID } from "node:crypto";

import type { SessionMessage } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import {
  SESSION_IMPORT_SOURCE_LABELS,
  sessionImportKey,
  type SessionImportCandidate,
  type SessionImportItemResult,
  type SessionImportOrigin,
  type SessionImportRef,
  type SessionImportRunOptions,
  type SessionImportSourceId,
  type SessionImportSourceSummary,
} from "../../common/session-import-contract";
import { errorText, type ImportedConversation, type SessionImportReader } from "./sources";

const log = createLogger("SessionImport");

const SOURCE_IDS = Object.keys(SESSION_IMPORT_SOURCE_LABELS).filter(
  (id): id is SessionImportSourceId => id in SESSION_IMPORT_SOURCE_LABELS,
);

/** The session store side of an import (SessionManager in production). */
function subagentKey(ref: SessionImportRef, agentId: string): string {
  return sessionImportKey({ ...ref, externalId: `${ref.externalId}/${agentId}` });
}

export interface SessionImportTarget {
  /** Session ids by `sessionImportKey`. */
  listImportedSessions(): Map<string, string>;
  importExternalSession(request: {
    name: string;
    messages: SessionMessage[];
    createdAt: string;
    updatedAt: string;
    cwd?: string;
    addWorkspace: boolean;
    importedFrom: SessionImportOrigin;
    sourceLabel: string;
    claudeNative?: { backendId: string; jsonl: Uint8Array };
    /** Imports the conversation as a subagent of this session. */
    parentSessionId?: string;
  }): Promise<{ sessionId: string; mode: "native" | "transcript" }>;
}

/** Finds conversations in other tools and copies the chosen ones into Marshal. Sources are only read. */
export class SessionImporter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly target: SessionImportTarget,
    private readonly reader: SessionImportReader,
  ) {}

  async scan(): Promise<{
    sources: SessionImportSourceSummary[];
    candidates: SessionImportCandidate[];
  }> {
    const imported = this.target.listImportedSessions();
    const scans = await Promise.all(
      SOURCE_IDS.map((id) =>
        this.reader.scan(id).catch((error: unknown) => ({
          summary: {
            id,
            label: SESSION_IMPORT_SOURCE_LABELS[id],
            available: false,
            location: "",
            sessionCount: 0,
            error: errorText(error),
          },
          candidates: [],
        })),
      ),
    );
    // A conversation whose subagents did not all make it in is offered again for the missing ones.
    const candidates = scans.flatMap((scan) =>
      scan.candidates.map(({ subagentIds, ...candidate }) => ({
        ...candidate,
        alreadyImported:
          imported.has(sessionImportKey(candidate)) &&
          (subagentIds ?? []).every((agentId) => imported.has(subagentKey(candidate, agentId))),
      })),
    );
    log.info(
      `Scan: ${scans.map((scan) => `${scan.summary.id}=${scan.summary.sessionCount}`).join(", ")}`,
    );
    return { sources: scans.map((scan) => scan.summary), candidates };
  }

  /** Imports one at a time, in order; concurrent calls queue behind each other. */
  run(
    refs: SessionImportRef[],
    options: SessionImportRunOptions,
    onResult?: (result: SessionImportItemResult) => void,
  ): Promise<SessionImportItemResult[]> {
    const run = this.queue.then(() => this.runNow(refs, options, onResult));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runNow(
    refs: SessionImportRef[],
    options: SessionImportRunOptions,
    onResult?: (result: SessionImportItemResult) => void,
  ): Promise<SessionImportItemResult[]> {
    const imported = this.target.listImportedSessions();
    const results: SessionImportItemResult[] = [];
    for (const ref of refs) {
      const existing = imported.get(sessionImportKey(ref));
      const result: SessionImportItemResult =
        // eslint-disable-next-line no-await-in-loop -- sequential: each import may register a workspace the next one reuses
        await (existing
          ? this.importMissingSubagents(ref, existing, imported, options)
          : this.importOne(ref, imported, options));
      results.push(result);
      onResult?.(result);
    }
    const count = (status: SessionImportItemResult["status"]) =>
      results.filter((result) => result.status === status).length;
    log.info(
      `Import: ${count("imported")} imported, ${count("skipped")} skipped, ${count("failed")} failed`,
    );
    return results;
  }

  /** An already imported Claude Code conversation gets the subagents an earlier run missed. */
  private async importMissingSubagents(
    ref: SessionImportRef,
    sessionId: string,
    imported: Map<string, string>,
    options: SessionImportRunOptions,
  ): Promise<SessionImportItemResult> {
    if (ref.source !== "claude-code") return { ...ref, status: "skipped" };
    try {
      const conversation = await this.reader.load(ref.source, ref.externalId);
      const missing = conversation?.subagents?.some(
        (subagent) => !imported.has(subagentKey(ref, subagent.agentId)),
      );
      if (!conversation || !missing) return { ...ref, status: "skipped" };
      const subagents = await this.importSubagents(ref, conversation, sessionId, imported, options);
      return subagents
        ? { ...ref, status: "imported", sessionId, subagents }
        : { ...ref, status: "skipped" };
    } catch (error) {
      log.warn(
        `Subagent recovery for a ${ref.source} conversation failed (${error instanceof Error ? error.name : "unknown"})`,
      );
      return { ...ref, status: "failed", error: errorText(error) };
    }
  }

  private async importOne(
    ref: SessionImportRef,
    imported: Map<string, string>,
    options: SessionImportRunOptions,
  ): Promise<SessionImportItemResult> {
    try {
      const conversation = await this.reader.load(
        ref.source,
        ref.externalId,
        ref.source === "claude-code" ? randomUUID() : undefined,
      );
      if (!conversation) return { ...ref, status: "failed", error: "Conversation not found" };
      if (!conversation.messages.length)
        return { ...ref, status: "failed", error: "Conversation has no messages" };
      const { sessionId, mode } = await this.target.importExternalSession({
        name: conversation.title,
        messages: conversation.messages,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        ...(conversation.cwd ? { cwd: conversation.cwd } : {}),
        addWorkspace: options.addWorkspaces,
        importedFrom: { ...ref, importedAt: new Date().toISOString() },
        sourceLabel: SESSION_IMPORT_SOURCE_LABELS[ref.source],
        ...(conversation.claudeNative ? { claudeNative: conversation.claudeNative } : {}),
      });
      imported.set(sessionImportKey(ref), sessionId);
      const subagents = await this.importSubagents(ref, conversation, sessionId, imported, options);
      return { ...ref, status: "imported", sessionId, mode, ...(subagents ? { subagents } : {}) };
    } catch (error) {
      log.warn(
        `Import of a ${ref.source} conversation failed (${error instanceof Error ? error.name : "unknown"})`,
      );
      return { ...ref, status: "failed", error: errorText(error) };
    }
  }

  /**
   * Claude Code's subagents become child sessions of the imported conversation, the way Marshal's
   * own subagents sit under their parent. One that fails is left out and offered again by the next
   * scan; the parent stays imported. Ones already imported are skipped.
   */
  private async importSubagents(
    ref: SessionImportRef,
    conversation: ImportedConversation,
    parentSessionId: string,
    imported: Map<string, string>,
    options: SessionImportRunOptions,
  ): Promise<number> {
    let count = 0;
    for (const subagent of conversation.subagents ?? []) {
      const key = subagentKey(ref, subagent.agentId);
      if (imported.has(key)) continue;
      const cwd = subagent.cwd ?? conversation.cwd;
      try {
        // eslint-disable-next-line no-await-in-loop -- one session write at a time
        const { sessionId } = await this.target.importExternalSession({
          name: subagent.title,
          messages: subagent.messages,
          createdAt: subagent.createdAt,
          updatedAt: subagent.updatedAt,
          ...(cwd ? { cwd } : {}),
          addWorkspace: options.addWorkspaces,
          importedFrom: {
            ...ref,
            externalId: `${ref.externalId}/${subagent.agentId}`,
            importedAt: new Date().toISOString(),
          },
          sourceLabel: `a ${SESSION_IMPORT_SOURCE_LABELS[ref.source]} subagent`,
          parentSessionId,
        });
        imported.set(key, sessionId);
        count += 1;
      } catch (error) {
        log.warn(
          `Import of a ${ref.source} subagent failed (${error instanceof Error ? error.name : "unknown"})`,
        );
      }
    }
    return count;
  }
}
