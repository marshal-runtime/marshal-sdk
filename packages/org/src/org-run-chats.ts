import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { OrgClient } from "@marshal/agent-runtime-org";

import type { OrgRunChatError, OrgRunChatResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import { sessionImportKey, type SessionImportRef } from "../host-deps";
import { MAX_NATIVE_STATE_BYTES } from "../host-deps";
import { importClaudeTranscript } from "../host-deps";
import type { SessionImportTarget } from "../host-deps";
import { classifyOrgFailure } from "./org-errors";
import { parseRunViewId } from "./org-session-audit";

const log = createLogger("OrgRunChats");

const MAX_SUBAGENTS = 64;
const MAX_TITLE_CHARS = 160;
const EXTERNAL_ID_PREFIX = "org-run:";
const PROJECT_FOLDER = "org-run";

export type RunChatClient = Pick<
  OrgClient,
  "supports" | "getRun" | "getRunEnvelope" | "listRunSubagents" | "getRunSubagentEnvelope"
>;

export interface OrgRunChatsDeps {
  /** Whether run views are on (the session-audit setting that also shows the read-only run view). */
  enabled: () => boolean;
  getClient: () => Promise<RunChatClient | null>;
  /** Where the run's sessions are stored: the session manager. */
  target: SessionImportTarget;
  /** The folder of the local workspace mapped to the organization workspace, when one is. */
  workspaceFolder: (orgWorkspaceId: string) => Promise<string | undefined>;
  /** Announces imported sessions to the renderer: imports skip the per-session list event. */
  notifySessionsChanged: () => void;
  /** Shows the session in the app: making it active in main does not move the renderer. */
  openSession: (sessionId: string) => void;
  maxDecompressedBytes?: number;
  tempRoot?: string;
}

const KNOWN_ERRORS: Record<string, OrgRunChatError> = {
  "not-signed-in": "not-signed-in",
  unauthorized: "unauthorized",
  "feature-unavailable": "unsupported",
  "not-found": "not-found",
  "no-envelope": "no-transcript",
  "envelope-too-large": "too-large",
  "too-large": "too-large",
  "invalid-request": "invalid-request",
  timeout: "unreachable",
  unreachable: "unreachable",
};

function failureCode(error: unknown): OrgRunChatError {
  const { code, transient } = classifyOrgFailure(error);
  return KNOWN_ERRORS[code] ?? (transient ? "unreachable" : "unavailable");
}

/** The import key of a run session: one local copy per run session, whoever opens it again. */
export function runChatRef(runId: string, session: string): SessionImportRef {
  const readable = `${EXTERNAL_ID_PREFIX}${runId}/${session}`;
  return {
    source: "claude-code",
    externalId:
      readable.length <= 128
        ? readable
        : `${EXTERNAL_ID_PREFIX}${createHash("sha256").update(`${runId}/${session}`).digest("hex")}`,
  };
}

function clipTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

/**
 * Opens an organization run as a normal local chat: downloads the run session's own Claude
 * transcript and its subagents' (full readers only; the server audits and screens them), imports
 * them the way a Claude Code conversation is imported, in the workspace mapped to the run's
 * organization workspace, and shows the session. Sending continues this local copy only. A run
 * opened before reuses the session that open made.
 */
export class OrgRunChats {
  private readonly running = new Map<string, Promise<OrgRunChatResult>>();

  constructor(private readonly deps: OrgRunChatsDeps) {}

  /** Imports the run (or finds the copy an earlier open made) and, unless `show` is false, switches the app to it. */
  async open(viewId: string, options: { show?: boolean } = {}): Promise<OrgRunChatResult> {
    let running = this.running.get(viewId);
    if (!running) {
      running = this.openNow(viewId).finally(() => this.running.delete(viewId));
      this.running.set(viewId, running);
    }
    const result = await running;
    if (result.success && options.show !== false) this.show(result.sessionId);
    return result;
  }

  private async openNow(viewId: string): Promise<OrgRunChatResult> {
    if (!this.deps.enabled()) return { success: false, error: "disabled" };
    const parsed = parseRunViewId(viewId);
    if (!parsed) return { success: false, error: "invalid-request" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (!client.supports("runEnvelopes")) return { success: false, error: "unsupported" };
      const detail = await client.getRun(parsed.runId);
      const session = parsed.session ?? detail.sessions.find((entry) => entry.hasEnvelope)?.session;
      if (!session) return { success: false, error: "no-transcript" };
      const ref = runChatRef(parsed.runId, session);
      const existing = this.deps.target.listImportedSessions().get(sessionImportKey(ref));
      if (existing) return { success: true, sessionId: existing, reused: true };
      const cwd = await this.deps.workspaceFolder(detail.run.workspace);
      const imported = await this.importRun(client, {
        runId: parsed.runId,
        session,
        ref,
        title: `Fork of run: ${clipTitle(detail.run.title)}`,
        ...(cwd ? { cwd } : {}),
      });
      if (!imported.success) return imported;
      this.deps.notifySessionsChanged();
      return { success: true, sessionId: imported.sessionId, reused: false };
    } catch (error) {
      if (error instanceof RangeError) return { success: false, error: "too-large" };
      const failure = classifyOrgFailure(error);
      log.warn(
        `Opening a run as a chat failed: code=${failure.code} status=${failure.status ?? 0}`,
      );
      return { success: false, error: failureCode(error) };
    }
  }

  private show(sessionId: string): void {
    try {
      this.deps.openSession(sessionId);
    } catch {
      log.warn("Could not switch the app to the run's session: code=open-session-failed");
    }
  }

  private gunzip(bytes: Uint8Array): Buffer {
    return gunzipSync(bytes, {
      maxOutputLength: this.deps.maxDecompressedBytes ?? MAX_NATIVE_STATE_BYTES,
    });
  }

  private async importRun(
    client: RunChatClient,
    run: { runId: string; session: string; ref: SessionImportRef; title: string; cwd?: string },
  ): Promise<{ success: true; sessionId: string } | { success: false; error: OrgRunChatError }> {
    const envelope = await client.getRunEnvelope(run.runId, run.session);
    const agents = (await client.listRunSubagents(run.runId, run.session)).slice(0, MAX_SUBAGENTS);
    const result = await importClaudeTranscript(this.deps.target, {
      ref: run.ref,
      title: run.title,
      ...(run.cwd ? { cwd: run.cwd } : {}),
      projectFolder: PROJECT_FOLDER,
      ...(this.deps.tempRoot ? { tempRoot: this.deps.tempRoot } : {}),
      writeFiles: async ({ mainFile, subagentDir }) => {
        await fs.promises.writeFile(mainFile, this.gunzip(envelope.body));
        for (const agent of agents) {
          // eslint-disable-next-line no-await-in-loop -- bounded; one download at a time keeps the server's audit rows in order
          const download = await client
            .getRunSubagentEnvelope(run.runId, run.session, agent)
            .catch((error: unknown) => {
              log.info(`A run subagent was left out: code=${classifyOrgFailure(error).code}`);
              return undefined;
            });
          if (!download) continue;
          // eslint-disable-next-line no-await-in-loop -- sequential writes of the bounded list above
          await fs.promises.writeFile(
            path.join(subagentDir, `agent-${agent}.jsonl`),
            this.gunzip(download.body),
          );
        }
      },
    });
    if (!result.success) {
      log.warn(`A run could not be imported as a chat: status=${result.status}`);
      return { success: false, error: "unavailable" };
    }
    log.info(
      `Opened a run as a chat: mode=${result.mode ?? "unknown"} subagents=${result.subagents ?? 0}`,
    );
    return { success: true, sessionId: result.sessionId };
  }
}
