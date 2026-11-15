export interface RuntimeSessionEventBase {
  id: string;
  timestamp: string;
  parentId: string | null;
}

export interface RuntimeSessionEventDataMap {
  "session.history_snapshot": {
    messages: import("../contract/host-types").ProviderSessionMessage[];
  };
  "user.message": { content: string };
  "session.context_checkpoint": {
    state: import("./runtime-conversation-state").RuntimeConversationState;
  };
  "assistant.message_delta": {
    messageId?: string;
    deltaContent: string;
  };
  "assistant.message": {
    messageId?: string;
    content: string;
    reasoningText?: string;
  };
  "assistant.reasoning_delta": {
    reasoningId?: string;
    deltaContent: string;
  };
  "assistant.usage": {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    cost?: number;
    duration?: number;
    ttftMs?: number;
    interTokenLatencyMs?: number;
    initiator?: string;
    apiCallId?: string;
    providerCallId?: string;
  };
  "tool.execution_start": {
    toolName: string;
    toolCallId: string;
    arguments?: unknown;
    mcpServerName?: string;
    mcpToolName?: string;
    shellToolInfo?: unknown;
  };
  "tool.execution_complete": {
    toolCallId: string;
    success: boolean;
    result?: unknown;
    error?: string | { message?: string };
  };
  "tool.execution_end": {
    toolCallId?: string;
    success?: boolean;
    result?: unknown;
    error?: unknown;
  };
  "session.idle": Record<string, never>;
  "session.compaction_complete": {
    success?: boolean;
    summaryContent?: string;
    /** Names the compaction when the runtime gives it an identity, so a repeated report is recognised. */
    compactionId?: string;
  };
  "session.error": {
    message?: string;
    errorType?: string;
    /** Epoch milliseconds when a usage limit (`errorType: "usage_limit"`) resets. */
    retryAt?: number;
  };
  "session.usage_info": {
    currentTokens: number;
    tokenLimit: number;
  };
  "session.model_change": {
    newModel?: string;
  };
  "session.metadata_updated": {
    newModel?: string;
  };
  "session.status": {
    status?: string | null;
    message?: string | null;
  };
  "session.mcp_servers_loaded": {
    servers?: Array<{
      name?: string;
      status?: string;
      error?: string;
      source?: string;
    }>;
  };
  "session.mcp_server_status_changed": {
    serverName?: string;
    status?: string;
    error?: string;
  };
  "mcp.oauth_required": {
    requestId?: string;
    serverName?: string;
    serverUrl?: string;
  };
  "mcp.oauth_completed": {
    requestId?: string;
  };
  abort: Record<string, never>;
  /**
   * A backgrounded task (a Bash command or Agent subagent run with
   * `run_in_background`) changing state. Emitted only for tasks that outlive
   * their originating turn — ordinary foreground tool calls keep using
   * `tool.execution_start` / `tool.execution_complete`.
   */
  "session.background_task": {
    taskId: string;
    toolCallId?: string;
    status: "started" | "backgrounded" | "progress" | "completed" | "failed" | "stopped";
    description?: string;
    summary?: string;
    /** False for a task registered in the foreground; true or absent = background. */
    isBackgrounded?: boolean;
    kind?: import("./background-work").BackgroundWorkTaskKind;
    parentTaskId?: string;
    /** Path to the task's full output (Claude's `output_file`), when the
     *  runtime reports one — set only on completion/failure/stop. */
    outputFile?: string;
  };
  /**
   * The runtime's own report of work still in flight after the current turn
   * (backgrounded shells, monitors, subagents, workflows, scheduled wakeups).
   * A present `tasks` / `wakeups` list REPLACES that half of the session's set;
   * an absent one leaves it unchanged. `reset` clears both (the runtime
   * process started or ended).
   */
  "session.background_work": {
    tasks?: Omit<import("./background-work").BackgroundWorkTask, "startedAt">[];
    wakeups?: import("./background-work").BackgroundWorkWakeup[];
    reset?: boolean;
  };
  /**
   * A subagent the runtime runs inside its own process (Claude's Task/Agent tool) changing state,
   * foreground or background. `taskId` is stable across updates; mirrors are keyed on it.
   */
  "session.runtime_subagent": {
    taskId: string;
    toolUseId?: string;
    /** Absent on an update that changes other fields only (a description or backgrounding patch). */
    status?: "running" | "completed" | "failed" | "stopped";
    /** True only on the runtime's task start, including a resumed task: the one event that may open a row. */
    restarted?: boolean;
    description?: string;
    summary?: string;
    agentType?: string;
    /** False for a foreground subagent that blocks the parent turn; true once it runs in the background. */
    background?: boolean;
    spawnDepth?: number;
    parentTaskId?: string;
    lastToolName?: string;
    usage?: import("../contract/host-types").RuntimeSubagentUsage;
  };
  /**
   * The runtime began a turn on its own initiative (a finished background task
   * or a scheduled wakeup), not in response to anything the host sent.
   */
  "session.agent_turn_started": Record<string, never>;
  "runtime.unknown": {
    runtimeType: string;
    payload: unknown;
  };
}

export type RuntimeSessionEventType = keyof RuntimeSessionEventDataMap;

export type RuntimeSessionEvent = {
  [K in RuntimeSessionEventType]: RuntimeSessionEventBase & {
    type: K;
    data: RuntimeSessionEventDataMap[K];
  };
}[RuntimeSessionEventType];

export type RuntimeAssistantMessageEvent = Extract<
  RuntimeSessionEvent,
  { type: "assistant.message" }
>;
