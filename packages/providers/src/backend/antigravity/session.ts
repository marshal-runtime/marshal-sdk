import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  RuntimeContextMessage,
  RuntimeConversationState,
} from "../../common/runtime-conversation-state";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeSessionEvent,
  RuntimeSessionEventDataMap,
  RuntimeSessionEventType,
} from "../../common/runtime-events";
import { AUTH_REQUIRED_ERROR_CODE } from "../../common/foundation/auth/auth-errors";
import type { ReasoningEffort } from "../../contract/host-types";
import { cleanContextUserText, validateConversationState } from "../conversation-state";
import type {
  RuntimeAttachment,
  RuntimeClientSession,
  RuntimePermissionRequest,
  RuntimePermissionResult,
  RuntimeSendOptions,
  RuntimeSessionConfig,
  RuntimeTool,
} from "../runtime-contract";
import {
  AntigravityBridgeError,
  type AntigravityBridge,
  type BridgeEvent,
  type BridgeRequest,
  type BridgeUsage,
  type HostToolReply,
  type PreToolReply,
} from "./bridge-process";
import {
  ANTIGRAVITY_READ_TOOLS,
  ANTIGRAVITY_SHELL_TOOL,
  ANTIGRAVITY_URL_TOOLS,
  ANTIGRAVITY_WRITE_TOOLS,
} from "./constants";

/**
 * How long abort waits for the bridge to report the turn cancelled. The bridge ends a turn the harness won't stop
 * within ~10s; past this the bridge itself is stuck, so the turn ends here and the Agent restarts on the next turn.
 */
const ABORT_WAIT_MS = 15_000;

/** File types the SDK takes as media parts of a prompt (types.from_file). */
const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".pdf",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
]);

export interface AntigravitySessionLaunch {
  /** Bridge config for `open` (built by the client); the session adds model and resume per open. */
  baseConfig: Record<string, unknown>;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  resume: boolean;
}

interface ActiveTurn {
  id: string;
  cancelled: boolean;
  text: string[];
  reasoning: string[];
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function event<K extends RuntimeSessionEventType>(
  type: K,
  data: RuntimeSessionEventDataMap[K],
): Extract<RuntimeSessionEvent, { type: K }> {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic event construction is checked by RuntimeSessionEventDataMap[K].
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as Extract<RuntimeSessionEvent, { type: K }>;
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Marshal's reasoning effort as the Gemini thinking level. */
export function antigravityThinkingLevel(effort: ReasoningEffort | undefined): string | undefined {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

function permissionRequest(
  request: Extract<BridgeRequest, { kind: "pre_tool" }>,
): RuntimePermissionRequest | null {
  const common = {
    toolCallId: request.callId,
    toolName: request.toolName,
    arguments: request.args,
  };
  if (request.hostTool) {
    return { kind: "custom-tool", ...common, toolArgs: request.args };
  }
  if (request.serverName) {
    return {
      kind: "mcp",
      ...common,
      serverName: request.serverName,
      toolArgs: request.args,
    };
  }
  if (request.toolName === ANTIGRAVITY_SHELL_TOOL) {
    const command = stringArg(request.args, "CommandLine", "command_line", "command");
    return {
      kind: "shell",
      ...common,
      command,
      fullCommandText: command,
      cwd: stringArg(request.args, "Cwd", "working_dir", "cwd") || null,
    };
  }
  const filePath =
    request.canonicalPath ??
    stringArg(
      request.args,
      "TargetFile",
      "AbsolutePath",
      "path",
      "file_path",
      "DirectoryPath",
      "directory_path",
    );
  if (ANTIGRAVITY_WRITE_TOOLS.has(request.toolName)) {
    return { kind: "write", ...common, path: filePath, diff: null };
  }
  if (ANTIGRAVITY_READ_TOOLS.has(request.toolName)) {
    return { kind: "read", ...common, path: filePath };
  }
  if (ANTIGRAVITY_URL_TOOLS.has(request.toolName)) {
    return { kind: "url", ...common, url: stringArg(request.args, "Url", "url", "query", "Query") };
  }
  // generate_image, run_workflow, finish, skill_lookup: no host gate, like Claude's own internal tools.
  return null;
}

function sessionErrorData(error: unknown): { message: string; errorType?: string } {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof AntigravityBridgeError && error.code === "auth"
    ? { message, errorType: AUTH_REQUIRED_ERROR_CODE }
    : { message };
}

function deniedHookReason(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["permissionDecision"] !== "deny") return null;
  const reason = record["permissionDecisionReason"];
  return typeof reason === "string" && reason ? reason : "Denied by host policy";
}

function permissionDenial(result: RuntimePermissionResult): string | null {
  switch (result.kind) {
    case "approve-once":
      return null;
    case "reject":
      return result.feedback ?? "The user denied this tool call";
    default:
      return "This tool call is unavailable without user approval";
  }
}

/**
 * One Antigravity conversation. The Python SDK's `Agent` lives in the bridge;
 * this session owns turns, Marshal's tool gate and the event stream.
 */
export class AntigravityRuntimeSession implements RuntimeClientSession {
  readonly sessionId: string;
  private readonly handlers = new Set<(event: RuntimeSessionEvent) => void>();
  private readonly emittedEvents: RuntimeSessionEvent[] = [];
  private readonly tools: Map<string, RuntimeTool>;
  private readonly startedCalls = new Set<string>();
  private readonly completedCalls = new Set<string>();
  private conversationState: RuntimeConversationState;
  private activeTurn: ActiveTurn | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private modelId: string;
  private reasoningEffort: ReasoningEffort | undefined;
  private openModel: string | undefined;
  private openEffort: ReasoningEffort | undefined;
  private opened = false;
  private resume: boolean;

  constructor(
    private readonly bridge: AntigravityBridge,
    readonly conversationId: string,
    private readonly config: RuntimeSessionConfig,
    private readonly launch: AntigravitySessionLaunch,
    private readonly onClosed?: () => void,
  ) {
    this.sessionId = conversationId;
    this.tools = new Map((config.tools ?? []).map((tool) => [tool.name, tool]));
    this.modelId = launch.modelId;
    this.reasoningEffort = launch.reasoningEffort;
    this.resume = launch.resume;
    this.conversationState = structuredClone(
      config.conversationState ?? { version: 1, sourceRuntimeId: "antigravity", messages: [] },
    );
    this.conversationState.sourceRuntimeId = "antigravity";
  }

  /** Starts (or resumes) the Agent in the bridge with the current model. */
  async open(): Promise<void> {
    const thinkingLevel = antigravityThinkingLevel(this.reasoningEffort);
    await this.bridge.open(
      this.sessionId,
      {
        ...this.launch.baseConfig,
        conversationId: this.conversationId,
        resume: this.resume,
        model: this.modelId,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      },
      {
        onEvent: (bridgeEvent) => this.onBridgeEvent(bridgeEvent),
        onRequest: (request) => this.onBridgeRequest(request),
        onExit: (error) => this.onBridgeExit(error),
      },
    );
    this.opened = true;
    // Every later open continues the same conversation.
    this.resume = true;
    this.openModel = this.modelId;
    this.openEffort = this.reasoningEffort;
  }

  isClosed(): boolean {
    return this.closed;
  }

  on(handler: (event: RuntimeSessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async send(options: RuntimeSendOptions): Promise<string> {
    this.assertOpen();
    const turnId = randomUUID();
    const run = this.queue.then(() => this.runTurn(turnId, options));
    this.queue = run.catch(() => undefined);
    void run.catch((error: unknown) => {
      if (this.closed) return;
      this.emit(event("session.error", sessionErrorData(error)));
    });
    return turnId;
  }

  async sendAndWait(
    options: RuntimeSendOptions,
    timeout?: number,
  ): Promise<RuntimeAssistantMessageEvent | undefined> {
    this.assertOpen();
    const turnId = randomUUID();
    const run = this.queue.then(() => this.runTurn(turnId, options));
    this.queue = run.catch(() => undefined);
    if (timeout !== undefined && timeout > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Antigravity turn timed out after ${timeout}ms`)),
          timeout,
        );
      });
      try {
        await Promise.race([run, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await run;
    }
    return this.emittedEvents.reduce<RuntimeAssistantMessageEvent | undefined>(
      (found, runtimeEvent) => (runtimeEvent.type === "assistant.message" ? runtimeEvent : found),
      undefined,
    );
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  async disconnect(): Promise<void> {
    await this.close();
  }

  async abort(): Promise<void> {
    this.assertOpen();
    const turn = this.activeTurn;
    if (turn) {
      turn.cancelled = true;
      this.bridge.cancel(this.sessionId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        turn.completion.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ABORT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!settled) {
        // The bridge never answered: drop its Agent so the next turn starts a fresh one on this conversation.
        this.opened = false;
        await this.bridge.close(this.sessionId).catch(() => undefined);
        turn.resolve();
      }
    }
    this.emit(event("abort", {}));
    await this.config.hooks?.onSessionEnd?.({ reason: "abort" }, { sessionId: this.sessionId });
  }

  async setModel(model: string, options?: { reasoningEffort?: ReasoningEffort }): Promise<void> {
    this.assertOpen();
    this.modelId = model;
    if (options && "reasoningEffort" in options) this.reasoningEffort = options.reasoningEffort;
    this.emit(event("session.model_change", { newModel: model }));
  }

  async getMessages(): Promise<RuntimeSessionEvent[]> {
    return [...this.emittedEvents];
  }

  async exportConversationState(options?: {
    allowCompaction?: boolean;
  }): Promise<RuntimeConversationState> {
    this.assertOpen();
    if (options?.allowCompaction && this.activeTurn) {
      throw new Error(
        "Wait for the current Antigravity response to finish before transferring this chat",
      );
    }
    return validateConversationState(structuredClone(this.conversationState));
  }

  private async reopenForModelChange(): Promise<void> {
    if (this.modelId === this.openModel && this.reasoningEffort === this.openEffort) return;
    // The SDK fixes the model when the Agent starts: restart it on the same conversation.
    await this.bridge.close(this.sessionId);
    this.opened = false;
    await this.open();
  }

  private async runTurn(turnId: string, options: RuntimeSendOptions): Promise<void> {
    this.assertOpen();
    if (!this.opened) await this.open();
    await this.reopenForModelChange();
    const submitted = await this.config.hooks?.onUserPromptSubmitted?.(
      { prompt: options.prompt, ...(options.origin === "system" ? { source: "system" } : {}) },
      { sessionId: this.sessionId },
    );
    const modified =
      typeof submitted === "object" && submitted !== null
        ? (submitted as Record<string, unknown>)["modifiedPrompt"]
        : undefined;
    const prompt = typeof modified === "string" && modified ? modified : options.prompt;
    const { text, media } = this.withAttachments(prompt, options.attachments);
    const request: RuntimeContextMessage = {
      role: "user",
      content:
        cleanContextUserText(options.prompt) +
        (options.attachments?.length
          ? `\n\nOriginal attachment references: ${JSON.stringify(options.attachments)}`
          : ""),
    };
    this.conversationState.messages.push(request);

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const turn: ActiveTurn = {
      id: turnId,
      cancelled: false,
      text: [],
      reasoning: [],
      completion,
      resolve,
      reject,
    };
    this.activeTurn = turn;
    try {
      this.bridge.send(this.sessionId, turnId, text, media);
      await completion;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  private withAttachments(
    prompt: string,
    attachments: RuntimeAttachment[] | undefined,
  ): { text: string; media: { path: string; description?: string }[] } {
    if (!attachments?.length) return { text: prompt, media: [] };
    const cwd = this.config.cwd ?? this.config.workingDirectory ?? process.cwd();
    const media: { path: string; description?: string }[] = [];
    const references: string[] = [];
    for (const attachment of attachments) {
      const absolute = path.resolve(cwd, attachment.path);
      if (
        attachment.type === "file" &&
        MEDIA_EXTENSIONS.has(path.extname(absolute).toLowerCase())
      ) {
        media.push({
          path: absolute,
          ...(attachment.displayName ? { description: attachment.displayName } : {}),
        });
      } else {
        references.push(`- ${attachment.type}: ${absolute}`);
      }
    }
    return {
      text: references.length
        ? `${prompt}\n\nAttached ${references.length === 1 ? "path" : "paths"} (read with your file tools):\n${references.join("\n")}`
        : prompt,
      media,
    };
  }

  private onBridgeEvent(bridgeEvent: Exclude<BridgeEvent, BridgeRequest>): void {
    const turn = this.activeTurn;
    switch (bridgeEvent.ev) {
      case "chunk": {
        if (!turn || turn.cancelled || bridgeEvent.turn !== turn.id) return;
        if (bridgeEvent.kind === "text" && bridgeEvent.text) {
          turn.text.push(bridgeEvent.text);
          this.emit(
            event("assistant.message_delta", {
              messageId: turn.id,
              deltaContent: bridgeEvent.text,
            }),
          );
        } else if (bridgeEvent.kind === "thought" && bridgeEvent.text) {
          turn.reasoning.push(bridgeEvent.text);
          this.emit(
            event("assistant.reasoning_delta", {
              reasoningId: turn.id,
              deltaContent: bridgeEvent.text,
            }),
          );
        }
        // tool_call chunks are reported from the pre-tool gate, which carries the call id the result uses.
        return;
      }
      case "tool_result": {
        const callId = bridgeEvent.callId ?? "";
        this.completeTool(
          callId,
          bridgeEvent.error ? undefined : bridgeEvent.result,
          bridgeEvent.error ?? undefined,
        );
        const hookInput = {
          toolName: bridgeEvent.toolName,
          toolCallId: callId,
          cwd: this.config.cwd ?? this.config.workingDirectory,
        };
        if (bridgeEvent.error) {
          void this.callHook(() =>
            this.config.hooks?.onPostToolUseFailure?.(
              { ...hookInput, error: bridgeEvent.error },
              { sessionId: this.sessionId },
            ),
          );
        } else {
          void this.callHook(() =>
            this.config.hooks?.onPostToolUse?.(
              { ...hookInput, toolResult: bridgeEvent.result },
              { sessionId: this.sessionId },
            ),
          );
        }
        return;
      }
      case "compaction":
        this.conversationState.summary = bridgeEvent.summary || this.conversationState.summary;
        this.emit(
          event("session.compaction_complete", {
            success: true,
            ...(bridgeEvent.summary ? { summaryContent: bridgeEvent.summary } : {}),
          }),
        );
        void this.callHook(() =>
          this.config.hooks?.onContextCompacted?.({}, { sessionId: this.sessionId }),
        );
        return;
      case "turn_end": {
        if (!turn || bridgeEvent.turn !== turn.id) return;
        this.finishTurn(turn, bridgeEvent);
        return;
      }
      case "turn_error": {
        if (!turn || bridgeEvent.turn !== turn.id) return;
        void this.callHook(() =>
          this.config.hooks?.onErrorOccurred?.(
            { error: bridgeEvent.error, errorContext: "turn", recoverable: true },
            { sessionId: this.sessionId },
          ),
        );
        turn.reject(new AntigravityBridgeError(bridgeEvent.error, bridgeEvent.code));
        return;
      }
      case "error":
        this.emit(event("session.error", { message: bridgeEvent.error }));
        return;
      default:
        return;
    }
  }

  private finishTurn(turn: ActiveTurn, end: Extract<BridgeEvent, { ev: "turn_end" }>): void {
    const content = turn.text.join("");
    if (content) this.conversationState.messages.push({ role: "assistant", content });
    if (end.usage) this.emit(this.usageEvent(end.usage));
    if (turn.cancelled || end.cancelled) {
      turn.resolve();
      return;
    }
    if (content || end.structured !== undefined) {
      this.emit(
        event("assistant.message", {
          messageId: turn.id,
          content:
            content ||
            (end.structured !== undefined && end.structured !== null
              ? JSON.stringify(end.structured)
              : ""),
          ...(turn.reasoning.length ? { reasoningText: turn.reasoning.join("") } : {}),
          ...(end.structured !== undefined && end.structured !== null
            ? { structuredOutput: end.structured }
            : {}),
        }),
      );
    }
    this.emitContextCheckpoint();
    this.emit(event("session.idle", {}));
    turn.resolve();
  }

  private usageEvent(usage: BridgeUsage): RuntimeSessionEvent {
    const cached = usage.cachedInputTokens ?? 0;
    return event("assistant.usage", {
      model: this.modelId,
      inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cached),
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: cached,
      reasoningTokens: usage.reasoningTokens ?? 0,
    });
  }

  private emitContextCheckpoint(): void {
    this.emit(
      event("session.context_checkpoint", {
        state: validateConversationState(structuredClone(this.conversationState)),
      }),
    );
  }

  private async onBridgeRequest(request: BridgeRequest): Promise<PreToolReply | HostToolReply> {
    if (request.kind === "host_tool") return this.runHostTool(request);
    return this.decideToolCall(request);
  }

  private async decideToolCall(
    request: Extract<BridgeRequest, { kind: "pre_tool" }>,
  ): Promise<PreToolReply> {
    const deny = (message: string): PreToolReply => {
      this.startTool(request);
      this.completeTool(request.callId, undefined, message);
      return { allow: false, message };
    };
    if (this.closed || this.activeTurn?.cancelled) return deny("The turn was cancelled");
    if (request.hostTool && !this.tools.has(request.toolName)) {
      return deny(`Host tool "${request.toolName}" is unavailable.`);
    }
    const preResult = await this.callHook(() =>
      this.config.hooks?.onPreToolUse?.(
        {
          toolName: request.toolName,
          toolArgs: request.args,
          cwd: this.config.cwd ?? this.config.workingDirectory,
          toolCallId: request.callId,
          ...(request.serverName ? { serverName: request.serverName } : {}),
        },
        { sessionId: this.sessionId },
      ),
    );
    const hookDenial = deniedHookReason(preResult);
    if (hookDenial) return deny(hookDenial);
    const permission = permissionRequest(request);
    if (permission) {
      const handler = this.config.onPermissionRequest;
      let result: RuntimePermissionResult = { kind: "user-not-available" };
      if (handler) {
        try {
          result = await handler(permission, { sessionId: this.sessionId });
        } catch {
          result = { kind: "user-not-available" };
        }
      }
      const denial = permissionDenial(result);
      if (denial) return deny(denial);
    }
    if (this.closed || this.activeTurn?.cancelled) return deny("The turn was cancelled");
    this.startTool(request);
    return { allow: true };
  }

  private async runHostTool(
    request: Extract<BridgeRequest, { kind: "host_tool" }>,
  ): Promise<HostToolReply> {
    const tool = this.tools.get(request.toolName);
    if (!tool) return { error: `Host tool "${request.toolName}" is unavailable.` };
    try {
      const text = await tool.handler(request.args, {
        sessionId: this.sessionId,
        toolCallId: request.callId,
        toolName: request.toolName,
        arguments: request.args,
      });
      return { text };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private startTool(request: Extract<BridgeRequest, { kind: "pre_tool" }>): void {
    if (this.startedCalls.has(request.callId)) return;
    this.startedCalls.add(request.callId);
    this.conversationState.messages.push({
      role: "tool",
      content: JSON.stringify({ tool: request.toolName, arguments: request.args }),
    });
    this.emit(
      event("tool.execution_start", {
        toolName: request.serverName
          ? `${request.serverName}-${request.toolName}`
          : request.toolName,
        toolCallId: request.callId,
        arguments: request.args,
        ...(request.serverName
          ? { mcpServerName: request.serverName, mcpToolName: request.toolName }
          : {}),
      }),
    );
  }

  private completeTool(callId: string, result: unknown, error?: string): void {
    if (!callId || this.completedCalls.has(callId)) return;
    this.completedCalls.add(callId);
    this.emit(
      event("tool.execution_complete", {
        toolCallId: callId,
        success: !error,
        ...(error ? { error } : { result }),
      }),
    );
  }

  private async callHook(call: () => unknown): Promise<unknown> {
    try {
      return await call();
    } catch {
      return undefined;
    }
  }

  private onBridgeExit(error: Error): void {
    const turn = this.activeTurn;
    this.closed = true;
    if (turn) turn.reject(error);
    this.emit(event("session.error", { message: error.message }));
    this.onClosed?.();
  }

  private emit(runtimeEvent: RuntimeSessionEvent): void {
    this.emittedEvents.push(runtimeEvent);
    this.handlers.forEach((handler) => handler(runtimeEvent));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Antigravity session ${this.sessionId} is closed`);
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const turn = this.activeTurn;
      if (turn) {
        turn.cancelled = true;
        this.bridge.cancel(this.sessionId);
      }
      await this.bridge.close(this.sessionId);
      turn?.resolve();
    } finally {
      this.handlers.clear();
      this.onClosed?.();
    }
  }
}
