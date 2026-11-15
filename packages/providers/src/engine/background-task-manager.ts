import type { BackendEvent } from "../backend/types";
/**
 * BackgroundTaskManager — tracks runtime tasks that outlive the turn that
 * started them (a backgrounded Bash command, a backgrounded Agent subagent,
 * or a host MCP/self tool call Marshal itself detached to the background —
 * see `recordHostToolCompletion` / `tool-backgrounding.ts`) so that:
 *  - the idle-session reaper does not tear down a session's backend process
 *    while one of its background tasks is still running (see
 *    `SessionManager.canAutomaticallyPauseSession`).
 *  - completion wakes the *user* the same way heartbeat/automation events do
 *    (see `SessionManager.setBackgroundTaskCallback`, wired in main.ts to
 *    `NotificationRouter.notify`).
 *  - completion wakes the *session itself* so it can actually resume, not
 *    just alert a human who happens to be looking (see
 *    `SessionManager.tryWakeSessionForBackgroundTask`, the consumer of
 *    {@link BackgroundTaskManager.hasPendingWake} /
 *    {@link BackgroundTaskManager.drainPendingWake}).
 *
 * Mirrors the `McpStatusManager.handleBackendEvent` pattern: callers
 * short-circuit `SessionManager.subscribeToBackendEvents` on a `true` return
 * so TurnAccumulator never sees these (not turn-related) events.
 */
import type {
  BackgroundWorkTask,
  BackgroundWorkTaskKind,
  BackgroundWorkWakeup,
  SessionBackgroundWork,
} from "../common/background-work";

export interface BackgroundTaskUpdate {
  sessionId: string;
  /**
   * "sdk-task": an SDK-reported background task (a backgrounded Bash command
   * or Agent subagent) — recorded via `handleBackendEvent`. "host-tool": a
   * host-owned MCP/self tool call that Marshal itself moved to the
   * background after `TOOL_BACKGROUND_DETACH_THRESHOLD_MS` (see
   * `tool-backgrounding.ts`) — recorded via `recordHostToolCompletion`. Both
   * share this same queue/drain/wake path so a session that ended its turn
   * waiting on either kind resumes identically, and completions landing
   * close together coalesce into one wake turn instead of two.
   */
  kind: "sdk-task" | "host-tool";
  taskId: string;
  toolCallId?: string;
  /** Set only for `kind: "host-tool"` — the MCP/self tool's name (e.g.
   *  "mcp__marshal__sleep"), so the wake prompt can name what finished. */
  toolName?: string;
  status: "completed" | "failed" | "stopped";
  description?: string;
  summary?: string;
  outputFile?: string;
}

/** How long a `background-task-auto-continuation-observed` mark stays valid
 *  for `consumeRecentAutoContinuation` — generous margin over the ~1-3s gaps
 *  observed live between the CLI's own auto-continuation turn starting and
 *  SessionManager's busy-retry getting a chance to check again (see
 *  manual-bg-wake-repro.test.ts), without leaving a stale mark from an
 *  unrelated earlier completion able to suppress a later, real wake. */
const AUTO_CONTINUATION_OBSERVED_WINDOW_MS = 60_000;

/** A one-shot wakeup is dropped from the visible set this long after its fire time if the runtime never reported it gone. */
const WAKEUP_EXPIRY_GRACE_MS = 2 * 60_000;
/** A fresh agent-initiated turn consumes any one-shot wakeup due within this window. */
const WAKEUP_FIRE_TOLERANCE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

interface ForegroundTaskInfo {
  kind: BackgroundWorkTaskKind;
  description: string;
  parentTaskId?: string;
}

interface SessionWork {
  tasks: Map<string, BackgroundWorkTask>;
  wakeups: Map<string, BackgroundWorkWakeup>;
}

export class BackgroundTaskManager {
  /** Tasks the runtime level signal still lists; drives hasRunning and the reaper guard. */
  private readonly runningBySession = new Map<string, Set<string>>();
  /** Tasks seen starting in the background; the completion-wake gate. Cleared only by a terminal event or a reset, never by the level signal, whose ordering against task_notification is unspecified. */
  private readonly startedBySession = new Map<string, Set<string>>();
  private readonly wakeupExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly foregroundBySession = new Map<string, Map<string, ForegroundTaskInfo>>();
  private readonly workBySession = new Map<string, SessionWork>();
  private readonly workSignatureBySession = new Map<string, string>();
  private workChangedCallback: ((sessionId: string) => void) | null = null;
  private readonly pendingWakesBySession = new Map<string, BackgroundTaskUpdate[]>();
  private readonly autoContinuationObservedAtBySession = new Map<string, number>();
  private callback: ((update: BackgroundTaskUpdate) => void) | null = null;

  /** Wired by main.ts to route completions through NotificationRouter. */
  setCallback(callback: (update: BackgroundTaskUpdate) => void): void {
    this.callback = callback;
  }

  /** Fired whenever the visible background-work set of a session changes. */
  setWorkChangedCallback(callback: (sessionId: string) => void): void {
    this.workChangedCallback = callback;
  }

  hasRunning(sessionId: string): boolean {
    return (this.runningBySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** True while the runtime still holds any task or pending wakeup for the session; the idle reaper treats that as "in use". */
  hasBackgroundWork(sessionId: string, now = Date.now()): boolean {
    if (this.hasRunning(sessionId)) return true;
    const work = this.getBackgroundWork(sessionId, now);
    return work !== undefined;
  }

  /** The visible set, or undefined when empty. One-shot wakeups past their fire time are dropped lazily. */
  getBackgroundWork(sessionId: string, now = Date.now()): SessionBackgroundWork | undefined {
    const work = this.workBySession.get(sessionId);
    const tasks = work ? [...work.tasks.values()] : [];
    const wakeups = work
      ? [...work.wakeups.values()].filter(
          (wakeup) =>
            wakeup.recurring ||
            wakeup.nextFireAt === undefined ||
            wakeup.nextFireAt + WAKEUP_EXPIRY_GRACE_MS > now,
        )
      : [];
    if (tasks.length === 0 && wakeups.length === 0) return undefined;
    return { tasks, wakeups };
  }

  /** The runtime began a turn by itself: any one-shot wakeup that was due has fired. */
  noteAgentTurnStarted(sessionId: string, now = Date.now()): void {
    const work = this.workBySession.get(sessionId);
    if (!work) return;
    for (const [id, wakeup] of work.wakeups) {
      if (
        !wakeup.recurring &&
        wakeup.nextFireAt !== undefined &&
        wakeup.nextFireAt <= now + WAKEUP_FIRE_TOLERANCE_MS
      ) {
        work.wakeups.delete(id);
      }
    }
    this.afterWorkMutation(sessionId);
  }

  /** True if this session has one or more completions not yet delivered
   *  into its own conversation via a wake turn (see `drainPendingWake`). */
  hasPendingWake(sessionId: string): boolean {
    return (this.pendingWakesBySession.get(sessionId)?.length ?? 0) > 0;
  }

  /** Take and clear all pending completions for a session, for the caller
   *  to fold into one wake turn. Draining discards on failure by design —
   *  a best-effort re-invocation, backstopped by the OS notification from
   *  `setCallback`, not a durable delivery guarantee. */
  drainPendingWake(sessionId: string): BackgroundTaskUpdate[] {
    const pending = this.pendingWakesBySession.get(sessionId) ?? [];
    this.pendingWakesBySession.delete(sessionId);
    return pending;
  }

  /** Drop tracked tasks for a session being torn down (delete, force-stop). */
  clear(sessionId: string): void {
    this.runningBySession.delete(sessionId);
    this.startedBySession.delete(sessionId);
    this.foregroundBySession.delete(sessionId);
    this.workBySession.delete(sessionId);
    this.pendingWakesBySession.delete(sessionId);
    this.autoContinuationObservedAtBySession.delete(sessionId);
    this.afterWorkMutation(sessionId);
  }

  /** The runtime process behind a session ended: nothing it ran or scheduled survives. Pending completions stay queued. */
  clearLiveWork(sessionId: string): void {
    this.runningBySession.delete(sessionId);
    this.startedBySession.delete(sessionId);
    this.foregroundBySession.delete(sessionId);
    this.workBySession.delete(sessionId);
    this.afterWorkMutation(sessionId);
  }

  private workFor(sessionId: string): SessionWork {
    let work = this.workBySession.get(sessionId);
    if (!work) {
      work = { tasks: new Map(), wakeups: new Map() };
      this.workBySession.set(sessionId, work);
    }
    return work;
  }

  private afterWorkMutation(sessionId: string): void {
    const work = this.workBySession.get(sessionId);
    if (work && work.tasks.size === 0 && work.wakeups.size === 0) {
      this.workBySession.delete(sessionId);
    }
    this.scheduleWakeupExpiry(sessionId);
    const snapshot = this.getBackgroundWork(sessionId);
    const signature = snapshot
      ? JSON.stringify([
          snapshot.tasks.map((task) => [task.id, task.kind, task.description, task.progress]),
          snapshot.wakeups.map((wakeup) => [wakeup.id, wakeup.nextFireAt, wakeup.recurring]),
        ])
      : "";
    if ((this.workSignatureBySession.get(sessionId) ?? "") === signature) return;
    if (signature) this.workSignatureBySession.set(sessionId, signature);
    else this.workSignatureBySession.delete(sessionId);
    this.workChangedCallback?.(sessionId);
  }

  private scheduleWakeupExpiry(sessionId: string): void {
    const existing = this.wakeupExpiryTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.wakeupExpiryTimers.delete(sessionId);
    const work = this.workBySession.get(sessionId);
    if (!work) return;
    let earliest: number | undefined;
    for (const wakeup of work.wakeups.values()) {
      if (wakeup.recurring || wakeup.nextFireAt === undefined) continue;
      const expiresAt = wakeup.nextFireAt + WAKEUP_EXPIRY_GRACE_MS;
      if (earliest === undefined || expiresAt < earliest) earliest = expiresAt;
    }
    if (earliest === undefined) return;
    const delay = Math.min(Math.max(earliest - Date.now() + 1, 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.wakeupExpiryTimers.delete(sessionId);
      this.afterWorkMutation(sessionId);
    }, delay);
    timer.unref?.();
    this.wakeupExpiryTimers.set(sessionId, timer);
  }

  private upsertTask(
    sessionId: string,
    task: Omit<BackgroundWorkTask, "startedAt"> & { startedAt?: number },
  ): void {
    const work = this.workFor(sessionId);
    const existing = work.tasks.get(task.id);
    work.tasks.set(task.id, {
      ...existing,
      ...task,
      description: task.description || existing?.description || "",
      startedAt: existing?.startedAt ?? task.startedAt ?? Date.now(),
    });
  }

  /** True, and consumes the mark, if the runtime's own auto-continuation for
   *  this session was observed within the last {@link
   *  AUTO_CONTINUATION_OBSERVED_WINDOW_MS}. Consuming (not just reading)
   *  keeps this one-shot per completion — a later, genuinely new completion
   *  must be marked again to suppress SessionManager's own wake for it. */
  consumeRecentAutoContinuation(sessionId: string): boolean {
    const at = this.autoContinuationObservedAtBySession.get(sessionId);
    if (at === undefined) return false;
    this.autoContinuationObservedAtBySession.delete(sessionId);
    return Date.now() - at < AUTO_CONTINUATION_OBSERVED_WINDOW_MS;
  }

  /**
   * Routes a `background-task-update` / `background-task-auto-continuation-
   * observed` backend event. Returns **true** if the event was handled here
   * (either type); the caller must short-circuit further routing on a true
   * return.
   */
  handleBackendEvent(event: BackendEvent, sessionId: string): boolean {
    if (event.type === "background-task-auto-continuation-observed") {
      this.autoContinuationObservedAtBySession.set(sessionId, Date.now());
      return true;
    }
    if (event.type === "background-work-update") {
      this.applyBackgroundWorkUpdate(event, sessionId);
      return true;
    }
    if (event.type !== "background-task-update") return false;

    if (event.status === "started" && event.isBackgrounded === false) {
      let foreground = this.foregroundBySession.get(sessionId);
      if (!foreground) {
        foreground = new Map();
        this.foregroundBySession.set(sessionId, foreground);
      }
      foreground.set(event.taskId, {
        kind: event.kind ?? "other",
        description: event.description ?? "",
        parentTaskId: event.parentTaskId,
      });
      return true;
    }

    if (event.status === "started" || event.status === "backgrounded") {
      const foreground = this.foregroundBySession.get(sessionId);
      const known = foreground?.get(event.taskId);
      foreground?.delete(event.taskId);
      this.markRunning(sessionId, event.taskId);
      this.upsertTask(sessionId, {
        id: event.taskId,
        kind: event.kind ?? known?.kind ?? "other",
        description: event.description ?? known?.description ?? "",
        parentTaskId: event.parentTaskId ?? known?.parentTaskId,
      });
      this.afterWorkMutation(sessionId);
      return true;
    }

    if (event.status === "progress") {
      const task = this.workBySession.get(sessionId)?.tasks.get(event.taskId);
      if (task && event.summary) {
        task.progress = event.summary;
        this.afterWorkMutation(sessionId);
      }
      return true;
    }

    this.foregroundBySession.get(sessionId)?.delete(event.taskId);
    const running = this.runningBySession.get(sessionId);
    running?.delete(event.taskId);
    if (running && running.size === 0) this.runningBySession.delete(sessionId);
    const started = this.startedBySession.get(sessionId);
    const wasTracked = started?.delete(event.taskId) ?? false;
    if (started && started.size === 0) this.startedBySession.delete(sessionId);
    this.workBySession.get(sessionId)?.tasks.delete(event.taskId);
    this.afterWorkMutation(sessionId);

    // Only notify for tasks we actually saw start in the background — a
    // completion for a foreground task never wakes the session.
    if (wasTracked) {
      const update: BackgroundTaskUpdate = {
        kind: "sdk-task",
        sessionId,
        taskId: event.taskId,
        toolCallId: event.toolCallId,
        status: event.status,
        description: event.description,
        summary: event.summary,
        outputFile: event.outputFile,
      };
      this.callback?.(update);
      const pending = this.pendingWakesBySession.get(sessionId) ?? [];
      pending.push(update);
      this.pendingWakesBySession.set(sessionId, pending);
    }
    return true;
  }

  private markRunning(sessionId: string, taskId: string): void {
    for (const map of [this.runningBySession, this.startedBySession]) {
      let tasks = map.get(sessionId);
      if (!tasks) {
        tasks = new Set();
        map.set(sessionId, tasks);
      }
      tasks.add(taskId);
    }
  }

  private applyBackgroundWorkUpdate(
    event: Extract<BackendEvent, { type: "background-work-update" }>,
    sessionId: string,
  ): void {
    if (event.reset) {
      this.clearLiveWork(sessionId);
      return;
    }
    if (event.tasks) {
      const work = this.workFor(sessionId);
      const previous = work.tasks;
      work.tasks = new Map();
      const live = new Set<string>();
      for (const task of event.tasks) {
        live.add(task.id);
        const before = previous.get(task.id);
        work.tasks.set(task.id, {
          ...task,
          startedAt: before?.startedAt ?? Date.now(),
          ...(before?.progress ? { progress: before.progress } : {}),
        });
      }
      const running = this.runningBySession.get(sessionId);
      if (running) {
        for (const id of running) if (!live.has(id)) running.delete(id);
        if (running.size === 0) this.runningBySession.delete(sessionId);
      }
      const foreground = this.foregroundBySession.get(sessionId);
      if (foreground) {
        for (const id of foreground.keys()) if (live.has(id)) foreground.delete(id);
      }
    }
    if (event.wakeups) {
      const work = this.workFor(sessionId);
      work.wakeups = new Map(event.wakeups.map((wakeup) => [wakeup.id, wakeup]));
    }
    this.afterWorkMutation(sessionId);
  }

  /**
   * Records a host-owned tool call (a Marshal self-tool or MCP tool) that
   * Marshal itself detached to the background — see `tool-backgrounding.ts`
   * and `SessionManager.completeBackgroundToolInvocation` — finishing,
   * success, error, or cancellation ("stopped", matching the SDK background-
   * task status vocabulary), and queues it for the next wake turn exactly
   * like an SDK background task. Only call this for a completion that was
   * actually detached (`RunningToolCallInfo.backgrounded === true` at
   * completion time); a tool that finishes within its own turn needs no
   * wake — its result already flows back into the turn still waiting on it.
   */
  recordHostToolCompletion(update: {
    sessionId: string;
    handle: string;
    toolName: string;
    status: "completed" | "failed" | "stopped";
    summary?: string;
  }): void {
    const full: BackgroundTaskUpdate = {
      kind: "host-tool",
      sessionId: update.sessionId,
      taskId: update.handle,
      toolName: update.toolName,
      status: update.status,
      summary: update.summary,
    };
    this.callback?.(full);
    const pending = this.pendingWakesBySession.get(update.sessionId) ?? [];
    pending.push(full);
    this.pendingWakesBySession.set(update.sessionId, pending);
  }
}
