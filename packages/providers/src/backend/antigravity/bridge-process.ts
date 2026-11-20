import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { createLogger } from "../../common/marshal-logger";
import type { RuntimeProcessHandle } from "../runtime-contract";

const log = createLogger("antigravity:bridge");

export const ANTIGRAVITY_BRIDGE_PROTOCOL = 1;

/** Events the bridge writes on stdout, one JSON object per line. */
export type BridgeEvent =
  | { ev: "ready"; protocol: number }
  | { ev: "opened"; session: string; conversationId: string }
  | { ev: "open_failed"; session: string; error: string }
  | { ev: "closed"; session: string }
  | { ev: "error"; session: string; error: string }
  | {
      ev: "chunk";
      session: string;
      turn: string;
      kind: "text" | "thought" | "tool_call";
      text?: string;
      callId?: string | null;
      toolName?: string;
      args?: Record<string, unknown>;
      serverName?: string | null;
    }
  | {
      ev: "tool_result";
      session: string;
      callId: string | null;
      toolName: string;
      result: unknown;
      error: string | null;
    }
  | { ev: "compaction"; session: string; summary?: string }
  | {
      ev: "turn_end";
      session: string;
      turn: string;
      cancelled?: boolean;
      usage?: BridgeUsage | null;
      stopReason?: string;
      structured?: unknown;
    }
  | { ev: "turn_error"; session: string; turn: string; error: string }
  | BridgeRequest;

export interface BridgeUsage {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
}

export type BridgeRequest =
  | {
      ev: "request";
      id: string;
      session: string;
      kind: "pre_tool";
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      serverName: string | null;
      canonicalPath: string | null;
      hostTool: boolean;
    }
  | {
      ev: "request";
      id: string;
      session: string;
      kind: "host_tool";
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
    };

export type PreToolReply = { allow: true; args?: Record<string, unknown> } | { allow: false; message: string };
export type HostToolReply = { text: string } | { error: string };

export interface BridgeSessionListener {
  onEvent(event: Exclude<BridgeEvent, BridgeRequest>): void;
  onRequest(request: BridgeRequest): Promise<PreToolReply | HostToolReply>;
  /** The bridge process is gone; the session can no longer run. */
  onExit(error: Error): void;
}

export interface AntigravityBridgeOptions {
  python: string;
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One Python bridge process (google-antigravity) shared by every session of a
 * runtime client. Commands go in on stdin, events come back on stdout.
 */
export class AntigravityBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Map<string, BridgeSessionListener>();
  private readonly opening = new Map<
    string,
    { resolve: (conversationId: string) => void; reject: (error: Error) => void }
  >();
  private readonly closing = new Map<string, () => void>();
  private readonly ready: Promise<void>;
  private exitError: Error | undefined;
  private stderrTail = "";

  constructor(options: AntigravityBridgeOptions) {
    this.child = spawn(options.python, ["-I", options.bridgePath], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        log.warn("bridge wrote a line that is not JSON", { length: line.length });
        return;
      }
      if (!isRecord(event) || typeof event["ev"] !== "string") return;
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the bridge's protocol (bridge.py) defines these shapes.
      const typed = event as BridgeEvent;
      if (typed.ev === "ready") {
        if (typed.protocol !== ANTIGRAVITY_BRIDGE_PROTOCOL) {
          failReady(new Error(`Antigravity bridge protocol ${typed.protocol} is not supported`));
        } else markReady();
        return;
      }
      this.dispatch(typed);
    });
    const onGone = (error: Error) => {
      if (this.exitError) return;
      this.exitError = error;
      failReady(error);
      for (const pending of this.opening.values()) pending.reject(error);
      this.opening.clear();
      for (const done of this.closing.values()) done();
      this.closing.clear();
      for (const listener of this.listeners.values()) listener.onExit(error);
      this.listeners.clear();
    };
    this.child.on("error", (error) => onGone(error));
    this.child.on("exit", (code, signal) => {
      const detail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
      onGone(
        new Error(
          `The Antigravity bridge exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  }

  get process(): RuntimeProcessHandle {
    const child = this.child;
    return {
      pid: child.pid,
      get exitCode() {
        return child.exitCode;
      },
      get killed() {
        return child.killed;
      },
      kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
    };
  }

  isClosed(): boolean {
    return this.exitError !== undefined;
  }

  async open(
    sessionId: string,
    config: Record<string, unknown>,
    listener: BridgeSessionListener,
  ): Promise<string> {
    await this.ready;
    this.listeners.set(sessionId, listener);
    const opened = new Promise<string>((resolve, reject) => {
      this.opening.set(sessionId, { resolve, reject });
    });
    this.write({ op: "open", session: sessionId, config });
    try {
      return await opened;
    } catch (error) {
      this.listeners.delete(sessionId);
      throw error;
    }
  }

  send(
    sessionId: string,
    turn: string,
    prompt: string,
    media: { path: string; description?: string }[],
  ): void {
    this.write({ op: "send", session: sessionId, turn, prompt, media });
  }

  cancel(sessionId: string): void {
    if (this.exitError) return;
    this.write({ op: "cancel", session: sessionId });
  }

  async close(sessionId: string): Promise<void> {
    if (this.exitError || !this.listeners.has(sessionId)) {
      this.listeners.delete(sessionId);
      return;
    }
    const closed = new Promise<void>((resolve) => this.closing.set(sessionId, resolve));
    this.write({ op: "close", session: sessionId });
    await closed;
    this.listeners.delete(sessionId);
  }

  async stop(): Promise<void> {
    if (this.exitError) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 15_000);
    await exited;
    clearTimeout(timer);
  }

  private write(command: Record<string, unknown>): void {
    if (this.exitError) throw this.exitError;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private dispatch(event: BridgeEvent): void {
    switch (event.ev) {
      case "opened":
        this.opening.get(event.session)?.resolve(event.conversationId);
        this.opening.delete(event.session);
        return;
      case "open_failed":
        this.opening.get(event.session)?.reject(new Error(event.error));
        this.opening.delete(event.session);
        return;
      case "closed":
        this.closing.get(event.session)?.();
        this.closing.delete(event.session);
        return;
      case "request": {
        const listener = this.listeners.get(event.session);
        const reply = listener
          ? listener.onRequest(event)
          : Promise.resolve<PreToolReply>({ allow: false, message: "The session is closed" });
        void reply
          .catch((error: unknown) =>
            event.kind === "pre_tool"
              ? { allow: false as const, message: error instanceof Error ? error.message : String(error) }
              : { error: error instanceof Error ? error.message : String(error) },
          )
          .then((result) => {
            if (!this.exitError) this.write({ op: "reply", id: event.id, result });
          });
        return;
      }
      case "ready":
        return;
      default:
        this.listeners.get(event.session)?.onEvent(event);
    }
  }
}
