export type BackgroundWorkTaskKind = "shell" | "monitor" | "agent" | "workflow" | "other";

export interface BackgroundWorkTask {
  id: string;
  kind: BackgroundWorkTaskKind;
  description: string;
  startedAt: number;
  parentTaskId?: string;
  /** Latest one-line progress the runtime reported for the task. */
  progress?: string;
}

export interface BackgroundWorkWakeup {
  id: string;
  recurring: boolean;
  nextFireAt?: number;
  prompt?: string;
}

/** Live, never-persisted record of work a runtime still has in flight after its turn ended. */
export interface SessionBackgroundWork {
  tasks: BackgroundWorkTask[];
  wakeups: BackgroundWorkWakeup[];
}

export function hasBackgroundWork(work: SessionBackgroundWork | undefined): boolean {
  return work !== undefined && (work.tasks.length > 0 || work.wakeups.length > 0);
}

const KIND_LABELS: Record<BackgroundWorkTaskKind, string> = {
  shell: "Shell",
  monitor: "Monitor",
  agent: "Agent",
  workflow: "Workflow",
  other: "Task",
};

const KIND_COUNT_LABELS: Record<BackgroundWorkTaskKind, string> = {
  shell: "shell",
  monitor: "monitor",
  agent: "agent",
  workflow: "workflow",
  other: "task",
};

export function backgroundTaskKindLabel(kind: BackgroundWorkTaskKind): string {
  return KIND_LABELS[kind];
}

const DATE_SHOWN_BEYOND_MS = 12 * 60 * 60_000;

export function formatWakeTime(
  nextFireAt: number | undefined,
  now = Date.now(),
): string | undefined {
  if (nextFireAt === undefined) return undefined;
  const at = new Date(nextFireAt);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (Math.abs(nextFireAt - now) <= DATE_SHOWN_BEYOND_MS) return time;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function describeBackgroundTask(task: BackgroundWorkTask): string {
  const label = KIND_LABELS[task.kind];
  const text = [task.description, task.progress].filter(Boolean).join(" — ");
  return text ? `${label}: ${text}` : label;
}

export function describeBackgroundWakeup(wakeup: BackgroundWorkWakeup): string {
  const time = formatWakeTime(wakeup.nextFireAt);
  const base = wakeup.recurring ? "Recurring wakeup" : "Wakeup";
  return time ? `${base} at ${time}` : base;
}

/** One line per task and wakeup, for tooltips. */
export function describeBackgroundWorkLines(work: SessionBackgroundWork): string[] {
  return [
    ...work.tasks.map((task) => describeBackgroundTask(task)),
    ...work.wakeups.map((wakeup) => describeBackgroundWakeup(wakeup)),
  ];
}

/** Compact count summary, e.g. "1 shell, 2 agents, 1 wakeup at 12:21". */
export function summarizeBackgroundWork(work: SessionBackgroundWork): string {
  const counts = new Map<BackgroundWorkTaskKind, number>();
  for (const task of work.tasks) counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1);
  const parts = [...counts].map(
    ([kind, count]) => `${count} ${KIND_COUNT_LABELS[kind]}${count === 1 ? "" : "s"}`,
  );
  if (work.wakeups.length > 0) {
    const times = work.wakeups
      .map((wakeup) => wakeup.nextFireAt)
      .filter((at): at is number => at !== undefined);
    const next = times.length > 0 ? formatWakeTime(Math.min(...times)) : undefined;
    const noun = `wakeup${work.wakeups.length === 1 ? "" : "s"}`;
    parts.push(
      `${work.wakeups.length} ${noun}${next ? ` ${work.wakeups.length === 1 ? "at" : "from"} ${next}` : ""}`,
    );
  }
  return parts.join(", ");
}
