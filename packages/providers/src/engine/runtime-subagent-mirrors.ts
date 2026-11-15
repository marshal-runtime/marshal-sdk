import type { SessionMessage, SessionMetadata } from "../../host/engine-host-types";
import type { ISessionStore, PersistedSession } from "../../host/engine-host-types";
import type { BackendEvent } from "../backend/types";
import { createLogger } from "../common/marshal-logger";
import {
  type RuntimeSubagentRef,
  type RuntimeSubagentStatus,
  isRuntimeSubagentRunning,
} from "../common/runtime-subagent";

const log = createLogger("RuntimeSubagentMirrors");

const TRANSCRIPT_REFRESH_MIN_INTERVAL_MS = 1_500;
const MAX_NAME_LENGTH = 100;

type SubagentUpdate = Extract<BackendEvent, { type: "runtime-subagent-update" }>;

export interface RuntimeSubagentMirrorDeps {
  store: Pick<
    ISessionStore,
    | "loadSessionData"
    | "saveSessionData"
    | "loadSessionHeader"
    | "loadSessionScope"
    | "withIndexLock"
    | "deleteSessionData"
    | "loadIndex"
    | "loadIndexReadOnly"
  >;
  /** The subagent's transcript, readable whether or not the parent has a live backend session. */
  readTranscript(parentSessionId: string, taskId: string): Promise<SessionMessage[]>;
  onListChanged(): void;
  onTranscriptChanged(sessionId: string): void;
}

/** Stable per (parent, task): a subagent the runtime resumes lands on the same row. */
export function runtimeSubagentSessionId(parentSessionId: string, taskId: string): string {
  return `${parentSessionId}-agent-${taskId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Read-only child rows for the subagents a runtime (Claude's Task/Agent tool) runs inside the
 * parent's process. The runtime owns the work; this class only records its state and loads its
 * transcript on demand. A row is never a Marshal-run subagent: it has no backend session, takes no
 * messages, and does not count as a running child of its parent.
 *
 * Progress stays in memory; the row is saved when it opens and whenever its status changes, and
 * the session list is refreshed only for those changes.
 */
export class RuntimeSubagentMirrors {
  private readonly live = new Map<string, RuntimeSubagentRef>();
  private readonly parentOf = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly transcriptSyncs = new Map<string, { at: number; pending?: Promise<boolean> }>();
  private startupReconcile: Promise<void> | undefined;

  constructor(private readonly deps: RuntimeSubagentMirrorDeps) {}

  /** True while the runtime reports the subagent running in this process. */
  isRunning(sessionId: string): boolean {
    return isRuntimeSubagentRunning(this.live.get(sessionId));
  }

  getLive(sessionId: string): RuntimeSubagentRef | undefined {
    return this.live.get(sessionId);
  }

  /** Cheap enough for every send and every chat open: answered from memory once a session was read. */
  isMirror(sessionId: string): boolean {
    if (this.live.has(sessionId)) return true;
    const { store } = this.deps;
    const scope = store.loadSessionScope?.(sessionId);
    if (scope !== undefined) return scope?.source === "claude-subagent";
    return store.loadSessionHeader(sessionId)?.source === "claude-subagent";
  }

  /**
   * What to show for a row. A row stored as running that this process is not tracking belongs to a
   * process that ended, so it reads as interrupted even before the startup reconcile has saved it.
   */
  resolve(
    sessionId: string,
    persisted: RuntimeSubagentRef | undefined,
  ): RuntimeSubagentRef | undefined {
    const live = this.live.get(sessionId);
    if (live) return live;
    return persisted && isRuntimeSubagentRunning(persisted)
      ? endedRef(persisted, "interrupted")
      : persisted;
  }

  handleUpdate(parentSessionId: string, event: SubagentUpdate): void {
    const id = runtimeSubagentSessionId(parentSessionId, event.taskId);
    const existing = this.live.get(id) ?? this.deps.store.loadSessionHeader(id)?.runtimeSubagent;
    if (!existing) {
      // Only the runtime's own task start opens a row; a stray update never recreates one.
      if (event.restarted) this.create(parentSessionId, id, event);
      return;
    }
    if (!isRuntimeSubagentRunning(existing) && !event.restarted) return;
    const next = mergeRef(existing, event);
    this.live.set(id, next);
    this.parentOf.set(id, parentSessionId);
    if (next.status === existing.status) return;
    this.queue(id, () => this.persist(id));
    if (!isRuntimeSubagentRunning(next)) void this.syncTranscript(id).catch(() => {});
    this.deps.onListChanged();
  }

  /** The parent's turn ended: a foreground subagent cannot outlive it, whatever frames did or did not arrive. */
  closeForeground(parentSessionId: string, outcome: "completed" | "interrupted"): void {
    this.endRunning(parentSessionId, outcome, (ref) => !ref.background);
  }

  /** The runtime process that held these subagents ended: they cannot continue. */
  interruptRunning(parentSessionId: string): void {
    this.endRunning(parentSessionId, "interrupted", () => true);
  }

  /** Drop the parent's mirrors with it, so none is left pointing at a missing session. */
  deleteForParent(parentSessionId: string): void {
    const { store } = this.deps;
    const mirrors = (store.loadIndexReadOnly?.() ?? store.loadIndex()).sessions.filter(
      (meta) => meta.source === "claude-subagent" && meta.parentSessionId === parentSessionId,
    );
    const ids = new Set(mirrors.map((meta) => meta.id));
    for (const [id, parent] of this.parentOf) {
      if (parent === parentSessionId) ids.add(id);
    }
    if (!ids.size) return;
    for (const id of ids) {
      this.forgetRow(id);
      store.deleteSessionData(id);
    }
    void store
      .withIndexLock((index) => {
        index.sessions = index.sessions.filter((meta) => !ids.has(meta.id));
      })
      .then(() => this.deps.onListChanged())
      .catch((error: unknown) => {
        log.warn(`Failed to remove subagent rows (${errorName(error)})`);
      });
  }

  /** Forget a row that was deleted on its own. */
  forget(sessionId: string): void {
    this.forgetRow(sessionId);
  }

  /** A row left "running" by a process that is gone can never finish. Runs once per start. */
  reconcileOnStartup(): Promise<void> {
    this.startupReconcile ??= this.deps.store
      .withIndexLock((index) => {
        const stale: SessionMetadata[] = [];
        for (const meta of index.sessions) {
          if (
            meta.source !== "claude-subagent" ||
            !isRuntimeSubagentRunning(meta.runtimeSubagent) ||
            this.live.has(meta.id)
          ) {
            continue;
          }
          if (meta.runtimeSubagent) {
            meta.runtimeSubagent = endedRef(meta.runtimeSubagent, "interrupted");
            stale.push(meta);
          }
        }
        return stale.map((meta) => ({ ...meta }));
      })
      .then((stale) => {
        for (const meta of stale) {
          const data = this.deps.store.loadSessionData(meta.id);
          if (!data) continue;
          data.runtimeSubagent = meta.runtimeSubagent;
          this.deps.store.saveSessionData(data);
        }
        if (stale.length) this.deps.onListChanged();
      })
      .catch((error: unknown) => {
        log.warn(`Startup reconcile of subagent rows failed (${errorName(error)})`);
      });
    return this.startupReconcile;
  }

  /**
   * Load the subagent's transcript from the runtime into the row. Cheap to call on every open:
   * calls inside the refresh interval and calls while a read is in flight share one result, and a
   * session that is not a mirror returns without reading anything.
   */
  syncTranscript(sessionId: string): Promise<boolean> {
    if (!this.isMirror(sessionId)) return Promise.resolve(false);
    const header = this.deps.store.loadSessionHeader(sessionId);
    const parentSessionId = header?.parentSessionId ?? this.parentOf.get(sessionId);
    const ref = this.live.get(sessionId) ?? header?.runtimeSubagent;
    if (!parentSessionId || !ref) return Promise.resolve(false);
    const state = this.transcriptSyncs.get(sessionId);
    if (state?.pending) return state.pending;
    if (state && Date.now() - state.at < TRANSCRIPT_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve(false);
    }
    const pending = this.readIntoRow(sessionId, parentSessionId, ref).finally(() => {
      this.transcriptSyncs.set(sessionId, { at: Date.now() });
    });
    this.transcriptSyncs.set(sessionId, { at: state?.at ?? 0, pending });
    return pending;
  }

  private endRunning(
    parentSessionId: string,
    status: RuntimeSubagentStatus,
    matches: (ref: RuntimeSubagentRef) => boolean,
  ): void {
    let changed = false;
    for (const [id, ref] of this.live) {
      if (this.parentOf.get(id) !== parentSessionId) continue;
      if (!isRuntimeSubagentRunning(ref) || !matches(ref)) continue;
      this.live.set(id, endedRef(ref, status));
      this.queue(id, () => this.persist(id));
      void this.syncTranscript(id).catch(() => {});
      changed = true;
    }
    if (changed) this.deps.onListChanged();
  }

  private async readIntoRow(
    sessionId: string,
    parentSessionId: string,
    ref: RuntimeSubagentRef,
  ): Promise<boolean> {
    let messages: SessionMessage[];
    try {
      messages = await this.deps.readTranscript(parentSessionId, ref.taskId);
    } catch (error) {
      log.with({ sessionId }).warn(`Subagent transcript read failed (${errorName(error)})`);
      return false;
    }
    if (!messages.length) return false;
    const data = this.deps.store.loadSessionData(sessionId);
    if (!data) return false;
    const stamped = messages.map((message) =>
      Date.parse(message.timestamp) > 0 ? message : { ...message, timestamp: ref.startedAt },
    );
    if (transcriptSignature(data.messages) === transcriptSignature(stamped)) return false;
    data.messages = stamped;
    this.deps.store.saveSessionData(data);
    this.deps.onTranscriptChanged(sessionId);
    return true;
  }

  private create(parentSessionId: string, id: string, event: SubagentUpdate): void {
    const parent = this.deps.store.loadSessionHeader(parentSessionId);
    if (!parent) return;
    const now = new Date().toISOString();
    const ref = mergeRef(
      {
        runtimeId: parent.runtimeId ?? "claude",
        taskId: event.taskId,
        agentId: event.taskId,
        background: false,
        readOnly: true,
        status: "running",
        startedAt: now,
      },
      event,
    );
    this.live.set(id, ref);
    this.parentOf.set(id, parentSessionId);
    const session: PersistedSession = {
      id,
      name: nameFor(ref, event.description),
      createdAt: now,
      updatedAt: now,
      hasUnread: false,
      isActive: false,
      source: "claude-subagent",
      parentSessionId,
      runtimeSubagent: ref,
      messages: [],
      ...(parent.model ? { model: parent.model } : {}),
      ...(parent.runtimeId ? { runtimeId: parent.runtimeId } : {}),
      ...(parent.backendOrigin ? { backendOrigin: parent.backendOrigin } : {}),
      ...(parent.workspaceName ? { workspaceName: parent.workspaceName } : {}),
      ...(parent.originWorkspaceName ? { originWorkspaceName: parent.originWorkspaceName } : {}),
      ...(parent.workspaceIdentity ? { workspaceIdentity: parent.workspaceIdentity } : {}),
      ...(parent.repoPath ? { repoPath: parent.repoPath } : {}),
    };
    this.queue(id, async () => {
      if (!this.live.has(id)) return;
      this.deps.store.saveSessionData(session);
      await this.deps.store.withIndexLock((index) => {
        if (index.sessions.some((meta) => meta.id === id)) return;
        index.sessions.unshift(indexEntry(session));
      });
      this.deps.onListChanged();
    });
  }

  private async persist(id: string): Promise<void> {
    const ref = this.live.get(id);
    if (!ref) return;
    const data = this.deps.store.loadSessionData(id);
    if (!data) return;
    data.runtimeSubagent = ref;
    data.updatedAt = new Date().toISOString();
    data.name = nameFor(ref, data.name);
    this.deps.store.saveSessionData(data);
    await this.deps.store.withIndexLock((index) => {
      const meta = index.sessions.find((entry) => entry.id === id);
      if (!meta) return;
      meta.runtimeSubagent = ref;
      meta.updatedAt = data.updatedAt;
      meta.name = data.name;
    });
  }

  private queue(id: string, task: () => Promise<void>): void {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => {
        log.with({ sessionId: id }).warn(`Subagent row update failed (${errorName(error)})`);
      })
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      });
    this.chains.set(id, next);
  }

  private forgetRow(id: string): void {
    this.live.delete(id);
    this.parentOf.delete(id);
    this.transcriptSyncs.delete(id);
  }
}

function endedRef(ref: RuntimeSubagentRef, status: RuntimeSubagentStatus): RuntimeSubagentRef {
  return { ...ref, status, endedAt: new Date().toISOString() };
}

function mergeRef(base: RuntimeSubagentRef, event: SubagentUpdate): RuntimeSubagentRef {
  const { endedAt, ...rest } = base;
  const status = event.restarted ? "running" : (event.status ?? base.status);
  return {
    ...rest,
    ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
    ...(event.agentType ? { agentType: event.agentType } : {}),
    ...(event.spawnDepth !== undefined ? { spawnDepth: event.spawnDepth } : {}),
    ...(event.parentTaskId ? { parentTaskId: event.parentTaskId } : {}),
    ...(event.background !== undefined ? { background: event.background } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.lastToolName ? { lastToolName: event.lastToolName } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    status,
    ...(isRuntimeSubagentRunning({ status })
      ? {}
      : { endedAt: endedAt ?? new Date().toISOString() }),
  };
}

function nameFor(ref: RuntimeSubagentRef, fallback: string | undefined): string {
  const text = (fallback ?? "").trim() || ref.agentType || "Claude subagent";
  return text.length > MAX_NAME_LENGTH ? `${text.slice(0, MAX_NAME_LENGTH - 1)}…` : text;
}

function indexEntry(session: PersistedSession): SessionMetadata {
  const { messages: _messages, ...meta } = session;
  return meta;
}

/** Changes whenever a message is added or a tool call gains its output, which can happen without a new message. */
function transcriptSignature(messages: readonly SessionMessage[]): string {
  return messages
    .map((message) => {
      const calls = (message.toolCalls ?? [])
        .map(
          (call) =>
            `${call.id}:${call.success ?? ""}:${call.output?.length ?? 0}:${call.error?.length ?? 0}`,
        )
        .join(",");
      return `${message.id}:${message.content.length}:${calls}`;
    })
    .join("|");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
