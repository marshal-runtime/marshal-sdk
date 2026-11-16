/**
 * Forks: a session splits its work into sessions that continue its exact conversation, each with its own task, and
 * report their final message back to it when they go idle. The desktop's fork tools under the same names
 * (electron/self-tools.ts: forkSubagents, listSubagents, messageSubagent, messageForks, listForkSiblings,
 * messageParent), on the same session-file code the desktop and zyg-agents share (@marshal/agent-runtime-claude).
 *
 * Two ways a fork starts, both keeping the parent's history and prompt cache:
 * - from inside the parent's running turn (the parent called forkSubagents): the parent's Claude session file is
 *   copied with the open fork call answered for the child, and the child resumes that copy;
 * - from outside it (the host, an extension, another session) while the parent is idle: the child's first turn
 *   resumes the parent's native session with `forkSession`, so the backend writes the copy itself.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  FORK_OTHER_CALL_RESULT,
  MARSHAL_FORK_WRAPPERS,
  forkCallResult,
  forkClaudeSessionFile,
  forkLaunchPrompt,
  type ForkCallWrapper,
} from "@marshal/agent-runtime-claude";

import type { ClaudeAgentPort, SessionOutcome } from "./agent-port.js";
import type { DeliveryMode, DeliveryResult, MessageSender } from "./session-messages.js";
import type { SessionStore, SessionRecord } from "./session-store.js";

export const MAX_FORKS_PER_CALL = 8;
const FORK_TOOL = "forkSubagents";
const FORK_CAPABILITY = `marshal.tool.${FORK_TOOL}`;
/** The SDK host's session tools: a capability run through runtime_exec, by name or inside a TypeScript module. */
const SDK_FORK_WRAPPERS: readonly ForkCallWrapper[] = [
  { tool: "runtime_exec", field: "target", match: "equals" },
  { tool: "runtime_exec", field: "source", match: "includes" },
  ...MARSHAL_FORK_WRAPPERS,
];
const SIBLING_NOTE =
  "You share one workspace with them: don't redo or revert their work. marshal.tool.listForkSiblings shows what each is doing.";
const CLOSING =
  "Your final message is delivered to the parent when you go idle, so end with what you did, the evidence, and anything left open. Use marshal.tool.messageParent only for a blocking question or a decision the parent must make now.";

export interface ForkTask {
  task: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ForkGroupResult {
  groupId: string;
  forks: { sessionId: string; name: string; task: string }[];
  /** How the forks started: a copy of the parent's file at its open fork call, a backend fork (of its last turn, or at the embedder's point), or fresh. */
  mode: "file-copy" | "backend-fork" | "fresh";
}

export interface ForksOptions {
  /** The Claude config dir the backend writes native sessions under. Default: CLAUDE_CONFIG_DIR of the backend env, else ~/.claude. */
  configDir?: string;
  log?: (line: string) => void;
  /** How long to wait for the parent's open fork call to reach its session file. Default 5 s (the shared helper's). */
  flushTimeoutMs?: number;
  /** See ForkPointOf. */
  forkPoint?: ForkPointOf;
  /**
   * Queue each fork's final message (or its error) into its parent as a `[Marshal notice]` when the fork goes idle. Default true. An embedder that
   * relays fork outcomes to the parent's conversation itself sets false, so the parent's process gets no turn it did not start.
   */
  reportToParent?: boolean;
}

/**
 * Where a parent whose Claude session file is not on this host (a remote session) is forked: `{forkAt}` resumes the parent's conversation up to that
 * message uuid under a new session (the backend fork, on the machine that holds the file), `{fresh: true}` starts the fork with its task alone (the
 * parent has no point to fork at yet). Undefined: the default, a copy of the parent's file at its open fork call while it runs, else a backend fork of
 * its whole conversation.
 */
export type ForkPointOf = (parent: SessionRecord) => { forkAt: string } | { fresh: true } | undefined;

/** The message a parent gets when one of its forks goes idle or fails, worded as the desktop words it. */
export function forkReport(fork: SessionRecord, outcome: SessionOutcome): string | undefined {
  if (outcome.state === "failed") {
    return `[Marshal notice] Subagent "${fork.title}" stopped on an error and is idle.\n\nError:\n${outcome.error}`;
  }
  if (outcome.reply === undefined) return undefined;
  return `[Marshal notice] Subagent "${fork.title}" is idle and ready for follow-up.\n\nIts final message:\n${outcome.reply}`;
}

export class SessionForks {
  private readonly stopReporting: () => void;

  constructor(
    private readonly port: ClaudeAgentPort,
    private readonly store: SessionStore,
    private readonly options: ForksOptions = {},
  ) {
    this.stopReporting = options.reportToParent === false ? () => undefined : port.onSettled((sessionId, outcome) => this.report(sessionId, outcome));
  }

  dispose(): void {
    this.stopReporting();
  }

  /** The id when it names a session of this host (the runtime's caller id may be the host's own scope). */
  known(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined && this.store.get(sessionId) ? sessionId : undefined;
  }

  /**
   * Forks `parentId` into one session per task. `calledByParent` is true when the parent itself made the call from
   * inside its running turn; the forks then continue from that call.
   */
  async fork(parentId: string, tasks: readonly ForkTask[], calledByParent: boolean): Promise<ForkGroupResult> {
    const parent = this.store.get(parentId);
    if (!parent) throw coded(`Session ${parentId} not found.`, "not-found");
    if (tasks.length === 0) throw coded("tasks must hold at least one task.", "invalid-request");
    if (tasks.length > MAX_FORKS_PER_CALL) throw coded(`At most ${MAX_FORKS_PER_CALL} forks per call.`, "invalid-request");
    for (const task of tasks) if (typeof task?.task !== "string" || !task.task.trim()) throw coded("Every task needs a task text.", "invalid-request");
    const parentNative = parent.native.sessionId;
    if (!parentNative) throw coded("The parent has no conversation yet: a session can be forked after its first turn has started.", "invalid-request");

    const groupId = randomUUID();
    const total = tasks.length;
    const planned = tasks.map((task, offset) => ({
      ...task,
      index: offset + 1,
      sessionId: randomUUID(),
      name: task.name?.trim() || forkName(task.task),
    }));
    const point = this.options.forkPoint?.(parent);
    const inTurn = point === undefined && calledByParent && this.port.isRunning(parentId);
    const configDir = this.options.configDir ?? this.port.backendEnv.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const natives = new Map<string, string>();
    const discards: (() => Promise<void>)[] = [];
    if (inTurn) {
      try {
        for (const fork of planned) {
          const nativeId = randomUUID();
          await forkClaudeSessionFile(
            configDir,
            parentNative,
            parent.native.cwd,
            {
              sessionId: nativeId,
              toolName: FORK_TOOL,
              capability: FORK_CAPABILITY,
              wrappers: SDK_FORK_WRAPPERS,
              result: forkCallResult({ index: fork.index, total, sessionId: fork.sessionId }),
              otherResult: FORK_OTHER_CALL_RESULT,
            },
            this.options.flushTimeoutMs,
          ).then((written) => discards.push(written.discard));
          natives.set(fork.sessionId, nativeId);
        }
      } catch (error) {
        await Promise.allSettled(discards.map((discard) => discard()));
        throw coded(`Could not fork the parent's conversation: ${error instanceof Error ? error.message : String(error)}`, "operation-failed");
      }
    }
    const systemPrompt = this.port.systemPromptOf(parentId);
    for (const fork of planned) {
      const siblings = planned.filter((other) => other !== fork).map((other) => ({ index: other.index, sessionId: other.sessionId, task: other.task }));
      this.port.launch({
        sessionId: fork.sessionId,
        task: forkLaunchPrompt({
          parentSessionId: parentId,
          index: fork.index,
          total,
          task: fork.task,
          siblings,
          siblingNote: SIBLING_NOTE,
          closing: CLOSING,
        }),
        idempotencyKey: `fork:${groupId}:${fork.index}`,
        name: fork.name,
        // The parent's model and effort keep the prompt cache; a fork may ask for others.
        model: fork.model ?? parent.model,
        ...((fork.reasoningEffort ?? parent.reasoningEffort) ? { reasoningEffort: fork.reasoningEffort ?? parent.reasoningEffort } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        parentId,
        from: { kind: "session", sessionId: parentId, name: parent.title },
        ...(inTurn
          ? { native: { sessionId: natives.get(fork.sessionId)! } }
          : point && "fresh" in point
            ? {}
            : { native: { forkOf: parentNative, ...(point ? { forkAt: point.forkAt } : {}) } }),
        fork: { groupId, index: fork.index, total, task: fork.task },
        labels: { ...parent.labels },
      });
    }
    this.options.log?.(`session ${parentId} forked into ${total} (group ${groupId}, ${inTurn ? "file copy" : point && "fresh" in point ? "fresh" : "backend fork"})`);
    return {
      groupId,
      forks: planned.map((fork) => ({ sessionId: fork.sessionId, name: fork.name, task: fork.task })),
      mode: inTurn ? "file-copy" : point && "fresh" in point ? "fresh" : "backend-fork",
    };
  }

  /** Every session launched or forked from `parentId` (all subagents when no parent is given), oldest first. */
  subagents(parentId?: string): SubagentSummary[] {
    const children = parentId ? this.store.list({ parentId }) : this.store.list().filter((session) => session.parentId);
    return children.map((session) => this.summary(session));
  }

  forkIds(parentId: string, groupId?: string): string[] {
    return this.store
      .list({ parentId })
      .filter((session) => session.fork && (groupId === undefined || session.fork.groupId === groupId))
      .map((session) => session.id);
  }

  siblings(forkId: string): { parentSessionId: string; groupId: string; you: { index: number; total: number }; siblings: SiblingSummary[] } | undefined {
    const self = this.store.get(forkId);
    if (!self?.fork || !self.parentId) return undefined;
    const siblings = this.store
      .list({ parentId: self.parentId })
      .filter((session) => session.id !== forkId && session.fork?.groupId === self.fork!.groupId)
      .map((session) => {
        const latest = this.store.messages(session.id, 1)[0];
        return {
          index: session.fork!.index,
          sessionId: session.id,
          name: session.title,
          task: session.fork!.task,
          isBusy: session.state === "running",
          state: session.state,
          ...(latest ? { latestMessage: latest.content.slice(0, 2000) } : {}),
        };
      });
    return { parentSessionId: self.parentId, groupId: self.fork.groupId, you: { index: self.fork.index, total: self.fork.total }, siblings };
  }

  /** Delivers to one of `caller`'s subagents (any child when the caller is not a session of this host). */
  async messageSubagent(
    caller: string | undefined,
    target: string,
    message: string,
    options: { deliveryMode?: DeliveryMode; replaceQueued?: boolean; waitForResponse?: boolean; timeoutMs?: number } = {},
  ): Promise<DeliveryResult & { sessionId: string }> {
    const session = this.store.get(target);
    const refused = (error: string) => ({ sessionId: target, success: false, accepted: false, messageId: "", error });
    if (!session) return refused("Session not found");
    if (!session.parentId) return refused("Not a subagent: use marshal.tool.messageSession for a top-level session.");
    if (caller && this.store.get(caller) && session.parentId !== caller) return refused("Not your subagent: use marshal.tool.messageSession.");
    const result = await this.port.deliver({
      messageId: randomUUID(),
      from: this.sender(caller),
      to: { sessionId: target },
      body: message,
      deliveryMode: options.deliveryMode ?? "queue",
      sentAt: new Date().toISOString(),
      ...(options.replaceQueued ? { replaceQueued: true } : {}),
      ...(options.waitForResponse ? { waitForResponse: true } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return { sessionId: target, ...result };
  }

  async messageParent(
    caller: string,
    message: string,
    options: { deliveryMode?: DeliveryMode; waitForResponse?: boolean; timeoutMs?: number } = {},
  ): Promise<DeliveryResult> {
    const self = this.store.get(caller);
    if (!self?.parentId) return { success: false, accepted: false, messageId: "", error: "This session has no parent." };
    return this.port.deliver({
      messageId: randomUUID(),
      from: this.sender(caller),
      to: { sessionId: self.parentId },
      body: message,
      // The desktop's default: a blocker or a final handoff should reach the parent now.
      deliveryMode: options.deliveryMode ?? "interrupt",
      sentAt: new Date().toISOString(),
      ...(options.waitForResponse ? { waitForResponse: true } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  sender(caller: string | undefined): MessageSender {
    const session = caller ? this.store.get(caller) : undefined;
    return session ? { kind: "session", sessionId: session.id, name: session.title } : { kind: "host", name: this.port.hostId };
  }

  private summary(session: SessionRecord): SubagentSummary {
    const queued = this.port.queuedCount(session.id);
    return {
      id: session.id,
      name: session.title,
      state: session.state,
      isBusy: session.state === "running",
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.fork ? { fork: session.fork } : {}),
      ...(queued > 0 ? { queuedMessageCount: queued } : {}),
      ...(session.lastError ? { lastError: session.lastError } : {}),
      usage: { costUsd: session.usage.costUsd, turns: session.usage.turns },
    };
  }

  private report(sessionId: string, outcome: SessionOutcome): void {
    const fork = this.store.get(sessionId);
    if (!fork?.fork || !fork.parentId || !this.store.get(fork.parentId)) return;
    const text = forkReport(fork, outcome);
    if (!text) return;
    try {
      this.port.send(fork.parentId, text, "queue", { kind: "session", sessionId: fork.id, name: fork.title });
    } catch (error) {
      this.options.log?.(`fork ${sessionId} could not report to ${fork.parentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface SiblingSummary {
  index: number;
  sessionId: string;
  name: string;
  task: string;
  isBusy: boolean;
  state: SessionRecord["state"];
  latestMessage?: string;
}

export interface SubagentSummary {
  id: string;
  name: string;
  state: SessionRecord["state"];
  isBusy: boolean;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  fork?: SessionRecord["fork"];
  queuedMessageCount?: number;
  lastError?: string;
  usage: { costUsd: number; turns: number };
}

/** What a session of this host reads about splitting work: forks, lanes and messages, under the desktop's names. */
export function forksPromptSection(
  call = "mcp__marshal__runtime_exec {targetType: 'operation', target: '<name>', input}",
): { id: string; text: string } {
  return {
    id: "sdk-forks",
    text: [
      "## Forks, lanes and messages on this host",
      "",
      `These are runtime capabilities: call them with ${call}.`,
      "- `marshal.tool.forkSubagents {tasks: [{task, name?, model?, reasoningEffort?}]}`: split independent work into forks that continue this conversation; each fork's final message comes back to you as a new message when it goes idle, so end your turn after forking unless you kept a part.",
      "- `marshal.tool.listSubagents`, `marshal.tool.messageSubagent {sessionId, message, deliveryMode?}`, `marshal.tool.messageForks {message, groupId?}`: follow and steer them; deliveryMode 'interrupt' stops a fork's turn and delivers now.",
      "- In a fork: `marshal.tool.listForkSiblings` to avoid overlap; `marshal.tool.messageParent {message}` only for a blocking question.",
      "- `marshal.tool.startLane {task}` starts a separate top-level session that does not report back; `marshal.tool.messageSession {sessionId, message}` reaches any session.",
    ].join("\n"),
  };
}

/** A fork's default name: its task's first line, cut at a word near 60 characters. */
function forkName(task: string): string {
  const line = task.trim().split("\n")[0]!.trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
