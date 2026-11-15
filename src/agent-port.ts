import fs from "node:fs";
import path from "node:path";

import type { FileSessionStore, SessionRecord, TranscriptMessage } from "./session-store.js";

/** The slice of the Claude Agent SDK's `query` this port relies on; tests pass a fake. */
export type QueryFn = (params: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<
  Record<string, any>
>;

export interface AgentSummary {
  id: string;
  name: string;
  state: "running" | "idle" | "failed";
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  workspaceName?: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number };
}

export interface AgentLaunchRequest {
  task: string;
  idempotencyKey: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt?: string;
  attachments?: readonly string[];
  parentId?: string;
  labels?: Record<string, string>;
}

export interface AgentTranscript {
  agent: AgentSummary;
  messageCount: number;
  showing: number;
  messages: TranscriptMessage[];
  result?: string;
}

export interface AgentPortOptions {
  query: QueryFn;
  store: FileSessionStore;
  /** Working directory of every session, and the directory the backend files its native history under. */
  cwd: string;
  /** Environment of the backend process: credentials and config dir are the host's choice, never the agent's. */
  env: Record<string, string>;
  defaultModel: string;
  defaultReasoningEffort?: string;
  workspaceName?: string;
  /** Marshal's system prompt for a session, unless the launch replaces it. */
  systemPrompt: (session: SessionRecord) => string | undefined;
  /** MCP servers of one session; called per turn because an in-process server serves one connection. */
  mcpServers: (session: SessionRecord) => Record<string, unknown>;
  /** Tool allowlist handed to the backend; undefined leaves its defaults. */
  tools?: readonly string[];
  log?: (line: string) => void;
}

interface LiveAgent {
  id: string;
  queue: string[];
  abort?: AbortController;
  running: boolean;
  lastResult?: string;
  systemPrompt?: string;
  idle: Promise<void>;
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_EVENT_STRING = 4_000;
const MAX_TRANSCRIPT_LIMIT = 200;

/**
 * Marshal's agent port on top of a Claude Agent SDK `query`: a launch is a Marshal session whose turns
 * are SDK queries resumed by the backend's own session id. It is the headless twin of the desktop's
 * SessionManager-backed port, so `marshal.agent.*` behaves the same for an extension on either host.
 */
export class ClaudeAgentPort {
  private readonly live = new Map<string, LiveAgent>();
  private readonly launches = new Map<string, string>();

  constructor(private readonly options: AgentPortOptions) {}

  launch(request: AgentLaunchRequest): AgentSummary {
    const existing = this.launches.get(request.idempotencyKey);
    if (existing) return this.summary(existing);
    const session = this.options.store.create({
      title: request.name ?? request.task.slice(0, 80),
      runtime: "claude",
      model: request.model ?? this.options.defaultModel,
      reasoningEffort: request.reasoningEffort ?? this.options.defaultReasoningEffort,
      native: {
        kind: "claude",
        cwd: this.options.cwd,
        ...(this.options.env.CLAUDE_CONFIG_DIR ? { configDir: this.options.env.CLAUDE_CONFIG_DIR } : {}),
      },
      ...(request.parentId ? { parentId: request.parentId } : {}),
      ...(this.options.workspaceName ? { workspace: this.options.workspaceName } : {}),
      labels: request.labels,
    });
    const agent: LiveAgent = {
      id: session.id,
      queue: [],
      running: false,
      idle: Promise.resolve(),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    };
    this.live.set(session.id, agent);
    this.launches.set(request.idempotencyKey, session.id);
    this.start(agent, request.task, request.attachments ?? []);
    return this.summary(session.id);
  }

  send(agentId: string, message: string, deliveryMode: "queue" | "interrupt" = "queue"): AgentSummary {
    const agent = this.agent(agentId);
    if (!agent.running) {
      this.options.store.update(agentId, { state: "running" });
      this.start(agent, message, []);
    } else if (deliveryMode === "interrupt") {
      agent.queue.unshift(message);
      agent.abort?.abort();
    } else {
      agent.queue.push(message);
    }
    return this.summary(agentId);
  }

  transcript(agentId: string, limit = 20): AgentTranscript {
    const session = this.session(agentId);
    const bounded = Math.max(1, Math.min(limit, MAX_TRANSCRIPT_LIMIT));
    const messages = this.options.store.messages(agentId, bounded);
    const result = this.live.get(agentId)?.lastResult;
    return {
      agent: this.summary(agentId),
      messageCount: session.messageCount,
      showing: messages.length,
      messages,
      ...(result !== undefined && session.state === "idle" ? { result } : {}),
    };
  }

  cancel(agentId: string): AgentSummary {
    const agent = this.agent(agentId);
    agent.queue.length = 0;
    agent.abort?.abort();
    return this.summary(agentId);
  }

  async wait(agentId: string, timeoutMs = 300_000): Promise<{ state: "completed" | "timeout"; agent: AgentSummary; result?: string }> {
    const agent = this.agent(agentId);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([agent.idle.then(() => "completed" as const), timedOut]);
    clearTimeout(timer);
    return {
      state: outcome,
      agent: this.summary(agentId),
      ...(outcome === "completed" && agent.lastResult !== undefined ? { result: agent.lastResult } : {}),
    };
  }

  list(): AgentSummary[] {
    return [...this.live.keys()].map((id) => this.summary(id));
  }

  get(agentId: string): AgentSummary | null {
    return this.live.has(agentId) ? this.summary(agentId) : null;
  }

  /** Stops every session; resolves when their backends have exited. */
  async dispose(): Promise<void> {
    for (const agent of this.live.values()) {
      agent.queue.length = 0;
      agent.abort?.abort();
    }
    await Promise.allSettled([...this.live.values()].map((agent) => agent.idle));
  }

  private start(agent: LiveAgent, message: string, attachments: readonly string[]): void {
    agent.running = true;
    agent.idle = this.drain(agent, message, attachments).catch((error: unknown) => {
      this.options.log?.(`agent ${agent.id} stopped: ${errorText(error)}`);
    });
  }

  /** Runs the given message and then every queued one; the session reads as running until the queue is empty. */
  private async drain(agent: LiveAgent, first: string, attachments: readonly string[]): Promise<void> {
    let message: string | undefined = first;
    let files = attachments;
    try {
      while (message !== undefined) {
        await this.turn(agent, message, files);
        files = [];
        message = agent.queue.shift();
      }
      this.options.store.update(agent.id, { state: "idle" });
    } catch (error) {
      this.options.store.update(agent.id, { state: "failed", lastError: errorText(error) });
      throw error;
    } finally {
      agent.running = false;
    }
  }

  private async turn(agent: LiveAgent, message: string, attachments: readonly string[]): Promise<void> {
    const store = this.options.store;
    const session = this.session(agent.id);
    store.appendMessage(agent.id, { role: "user", content: message });
    const abort = new AbortController();
    agent.abort = abort;
    const systemPrompt = agent.systemPrompt ?? this.options.systemPrompt(session);
    const options: Record<string, unknown> = {
      model: session.model,
      ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
      cwd: this.options.cwd,
      env: this.options.env,
      abortController: abort,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      mcpServers: this.options.mcpServers(session),
      systemPrompt: systemPrompt ?? { type: "preset", preset: "claude_code" },
      ...(this.options.tools ? { tools: [...this.options.tools] } : {}),
      ...(session.native.sessionId ? { resume: session.native.sessionId } : {}),
      stderr: (data: string) => this.options.log?.(`agent ${agent.id} stderr: ${data.trimEnd().slice(0, 500)}`),
    };
    let lastText = "";
    let final: string | undefined;
    let failed: string | undefined;
    try {
      for await (const event of this.options.query({ prompt: promptOf(message, attachments), options })) {
        store.appendEvent(agent.id, slim(event));
        if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
          store.update(agent.id, { native: { ...this.session(agent.id).native, sessionId: event.session_id } });
        } else if (event.type === "assistant" && !event.parent_tool_use_id) {
          const text = textOf(event.message?.content);
          if (text) lastText = text;
        } else if (event.type === "result") {
          final = typeof event.result === "string" && event.result ? event.result : lastText;
          if (event.is_error) failed = final || String(event.subtype ?? "error");
          store.addUsage(agent.id, {
            inputTokens: num(event.usage?.input_tokens),
            outputTokens: num(event.usage?.output_tokens),
            cacheReadTokens: num(event.usage?.cache_read_input_tokens),
            cacheWriteTokens: num(event.usage?.cache_creation_input_tokens),
            costUsd: num(event.total_cost_usd),
            turns: 1,
          });
        }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
        return;
      }
      store.appendMessage(agent.id, { role: "assistant", content: errorText(error), error: true });
      throw error;
    } finally {
      agent.abort = undefined;
    }
    if (abort.signal.aborted) {
      store.appendMessage(agent.id, { role: "system", content: "Turn cancelled." });
      return;
    }
    const content = failed ?? final ?? lastText;
    agent.lastResult = content;
    store.appendMessage(agent.id, {
      role: "assistant",
      content,
      ...(failed !== undefined ? { error: true } : {}),
    });
  }

  private summary(agentId: string): AgentSummary {
    const session = this.session(agentId);
    return {
      id: session.id,
      name: session.title,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.workspace ? { workspaceName: session.workspace } : {}),
      ...(session.native.sessionId ? { sessionId: session.native.sessionId } : {}),
      usage: {
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        cachedInputTokens: session.usage.cacheReadTokens,
        costUsd: session.usage.costUsd,
      },
    };
  }

  private agent(agentId: string): LiveAgent {
    const agent = this.live.get(agentId);
    if (!agent) throw Object.assign(new Error(`No agent ${agentId} on this host.`), { code: "not-found" });
    return agent;
  }

  private session(agentId: string): SessionRecord {
    const session = this.options.store.get(agentId);
    if (!session) throw Object.assign(new Error(`No agent ${agentId} on this host.`), { code: "not-found" });
    return session;
  }
}

/** A plain string, or one user message with the pictures as image blocks ahead of the text. */
function promptOf(message: string, attachments: readonly string[]): unknown {
  if (attachments.length === 0) return message;
  const content: unknown[] = [];
  const unreadable: string[] = [];
  for (const file of attachments) {
    const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mediaType) {
      unreadable.push(file);
      continue;
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: fs.readFileSync(file).toString("base64") },
    });
  }
  const note = unreadable.length ? `\n\nAttached files (open them yourself): ${unreadable.join(", ")}` : "";
  content.push({ type: "text", text: `${message}${note}` });
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
  })();
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A backend event without picture bytes or very long strings, so events.jsonl stays readable. */
function slim(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_EVENT_STRING ? `${value.slice(0, MAX_EVENT_STRING)}… [${value.length} chars]` : value;
  }
  if (value === null || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => slim(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.type === "base64" && typeof record.data === "string") {
    return { ...record, data: `[${record.data.length} base64 chars]` };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, slim(item, depth + 1)]));
}
