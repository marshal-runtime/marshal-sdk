import { randomUUID } from "node:crypto";

import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import type { ClaudeAgentPort } from "./agent-port.js";
import type { MessageSender } from "./session-messages.js";
import type { FileSessionStore } from "./session-store.js";

const PREFIX = "marshal.agent.";
const VERSION = "1.0.0";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const agentId = string(256);

/**
 * Field names and shapes follow the desktop's provider (electron/marshal-runtime/agent-provider.ts), so an
 * extension written against the desktop calls the same capabilities here. Desktop-only launch fields
 * (worktrees, souls, runtime accounts) are accepted and ignored: a headless host has one backend and one checkout.
 */
const AGENT = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "state", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    state: { enum: ["running", "idle", "failed"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    model: { type: "string" },
    reasoningEffort: { type: "string" },
    workspaceName: { type: "string" },
    sessionId: { type: "string" },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputTokens: { type: "number" },
        outputTokens: { type: "number" },
        cachedInputTokens: { type: "number" },
        costUsd: { type: "number" },
        modelTurns: { type: "number" },
      },
    },
  },
} as const;
const MESSAGE = {
  type: "object",
  additionalProperties: false,
  required: ["id", "role", "content", "timestamp"],
  properties: {
    id: { type: "string" },
    role: { enum: ["user", "assistant", "system"] },
    content: { type: "string" },
    timestamp: { type: "string" },
    error: { type: "boolean" },
  },
} as const;
const output = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const OUTPUTS: Record<string, object> = {
  launch: output(["agent"], { agent: AGENT }),
  send: output(["agent", "accepted"], { agent: AGENT, accepted: { type: "boolean" } }),
  transcript: output(["agent", "messageCount", "showing", "messages"], {
    agent: AGENT,
    messageCount: { type: "integer" },
    showing: { type: "integer" },
    messages: { type: "array", items: MESSAGE },
    result: { type: "string" },
  }),
  wait: output(["state", "agent"], {
    state: { enum: ["completed", "timeout"] },
    agent: AGENT,
    result: { type: "string" },
    structuredOutput: {},
  }),
  cancel: output(["agent"], { agent: AGENT }),
  list: output(["agents"], { agents: { type: "array", items: AGENT } }),
  get: output(["found"], { found: { type: "boolean" }, agent: AGENT }),
};

const OPERATIONS: Record<string, { title: string; description: string; risk: "low" | "medium" | "high"; input: object }> = {
  launch: {
    title: "Launch an ordinary Marshal child agent",
    description:
      "Start a Marshal session on this host with a task. Returns at once with the agent; read it with marshal.agent.transcript or marshal.agent.wait.",
    risk: "high",
    input: {
      type: "object",
      required: ["task", "idempotencyKey"],
      properties: {
        task: string(32_768),
        idempotencyKey: string(256),
        name: string(256),
        model: string(256),
        reasoningEffort: { enum: EFFORTS },
        systemPrompt: string(200_000),
        attachments: { type: "array", maxItems: 20, items: string(4096) },
      },
    },
  },
  send: {
    title: "Send a message to a launched agent",
    description: "Queue a message for the agent's next turn, or interrupt its running turn with it.",
    risk: "high",
    input: {
      type: "object",
      required: ["agentId", "message"],
      properties: { agentId, message: string(200_000), deliveryMode: { enum: ["queue", "interrupt"] } },
    },
  },
  transcript: {
    title: "Read a launched agent's transcript",
    description: "The agent's state, how many messages it has, its latest messages and its last result.",
    risk: "low",
    input: {
      type: "object",
      required: ["agentId"],
      properties: { agentId, limit: { type: "integer", minimum: 1, maximum: 200 } },
    },
  },
  wait: {
    title: "Wait for a launched agent to finish its work",
    description: "Resolves when the agent is idle with nothing queued, or at the timeout.",
    risk: "low",
    input: {
      type: "object",
      required: ["agentId"],
      properties: { agentId, timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 } },
    },
  },
  cancel: {
    title: "Cancel a launched agent",
    description: "Stops the agent's running turn and drops what was queued for it.",
    risk: "high",
    input: { type: "object", required: ["agentId"], properties: { agentId } },
  },
  list: {
    title: "List the agents launched on this host",
    description: "Every agent of this run with its state.",
    risk: "low",
    input: { type: "object", properties: {} },
  },
  get: {
    title: "Read one launched agent",
    description: "The agent's summary; found is false when this host does not know it.",
    risk: "low",
    input: { type: "object", required: ["agentId"], properties: { agentId } },
  },
};

export function createAgentProvider(
  port: ClaudeAgentPort,
  knownSession: (sessionId: string | undefined) => boolean,
): CapabilityProvider {
  const descriptors = Object.entries(OPERATIONS).map(([operation, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${PREFIX}${operation}`,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "agent", "session"],
    inputSchema: spec.input,
    outputSchema: OUTPUTS[operation],
    permissions: [{ permission: `${PREFIX}${operation}`, risk: spec.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marshal.agent-orchestration",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as Record<string, any>;
      const caller = callerSessionId(context);
      switch (name.slice(PREFIX.length)) {
        case "launch":
          return {
            output: {
              agent: port.launch({
                task: text(input.task, "task"),
                idempotencyKey: text(input.idempotencyKey, "idempotencyKey"),
                ...(typeof input.name === "string" ? { name: input.name } : {}),
                ...(typeof input.model === "string" ? { model: input.model } : {}),
                ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
                ...(typeof input.systemPrompt === "string" ? { systemPrompt: input.systemPrompt } : {}),
                ...(Array.isArray(input.attachments) ? { attachments: input.attachments as string[] } : {}),
                ...(knownSession(caller) ? { parentId: caller } : {}),
              }),
            },
          };
        case "send":
          return {
            output: {
              agent: port.send(
                text(input.agentId, "agentId"),
                text(input.message, "message"),
                input.deliveryMode === "interrupt" ? "interrupt" : "queue",
              ),
              accepted: true,
            },
          };
        case "transcript":
          return { output: port.transcript(text(input.agentId, "agentId"), input.limit) };
        case "wait":
          return { output: await port.wait(text(input.agentId, "agentId"), input.timeoutMs) };
        case "cancel":
          return { output: { agent: port.cancel(text(input.agentId, "agentId")) } };
        case "list":
          return { output: { agents: port.list() } };
        case "get": {
          const agent = port.get(text(input.agentId, "agentId"));
          return { output: agent ? { found: true, agent } : { found: false } };
        }
        default:
          throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
      }
    },
  } as unknown as CapabilityProvider;
}

/** The calling session: the runtime puts the tool adapter's trusted session id in the invocation scope. */
export function callerSessionId(context: InvocationContext): string | undefined {
  const value = context as { scope?: { sessionId?: unknown }; sessionId?: unknown };
  const id = value.scope?.sessionId ?? value.sessionId;
  return typeof id === "string" && id ? id : undefined;
}

const TOOL_PREFIX = "marshal.tool.";
const SESSION_TOOLS: Record<string, { title: string; description: string; risk: "low" | "medium" | "high"; input: object }> = {
  startLane: {
    title: "Start a lane",
    description:
      "Start a new top-level session (a lane) for a task. Unlike marshal.agent.launch it has no parent and starts with only the brief you write; it does not report back on its own. It knows your session ID; you and it talk with marshal.tool.messageSession. Desktop-only fields (workspaceName, worktrees, runtime, permissionMode) are accepted and ignored: this host has one checkout and one backend.",
    risk: "high",
    input: {
      type: "object",
      required: ["task"],
      properties: {
        task: string(32_768),
        name: string(256),
        model: string(256),
        reasoningEffort: { enum: EFFORTS },
        idempotencyKey: string(256),
        workspaceName: { type: "string" },
        createWorktree: { type: "boolean" },
        branchName: { type: "string" },
        baseRef: { type: "string" },
        runtime: { type: "string" },
        permissionMode: { type: "string" },
      },
    },
  },
  messageSession: {
    title: "Message another session",
    description:
      "Send a message to any other session by id: a lane, a child, the session that launched you, any session found with marshal.tool.searchSessions. The target sees who sent it. deliveryMode 'queue' (default) waits for its current turn to end; 'interrupt' stops its running turn and delivers this now. waitForResponse returns the target's reply. host addresses a session on another connected host (omit it for this host).",
    risk: "high",
    input: {
      type: "object",
      required: ["sessionId", "message"],
      properties: {
        sessionId: agentId,
        host: string(256),
        message: string(200_000),
        deliveryMode: { enum: ["queue", "interrupt"] },
        replaceQueued: { type: "boolean" },
        waitForResponse: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      },
    },
  },
  searchSessions: {
    title: "Search sessions",
    description:
      "Find sessions in this host's store (every run stored here) by words in their title, labels and transcript, best first. Filters: since/until (ISO), workspace, includeSubagents (default true). With the kit's sessions part, sessions.search also covers the team's shared sessions.",
    risk: "low",
    input: {
      type: "object",
      required: ["query"],
      properties: {
        query: string(2000),
        limit: { type: "integer", minimum: 1, maximum: 50 },
        since: { type: "string", maxLength: 40 },
        until: { type: "string", maxLength: 40 },
        workspace: { type: "string", maxLength: 200 },
        includeSubagents: { type: "boolean" },
        scope: { enum: ["local", "cloud", "all"] },
      },
    },
  },
  getSessionTranscript: {
    title: "Read a session's transcript",
    description: "The latest messages of a session on this host (default 30), each with its sender when someone else sent it.",
    risk: "low",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: agentId, lastN: { type: "integer", minimum: 1, maximum: 200 } },
    },
  },
};

const SENDER = output(["kind"], {
  kind: { enum: ["session", "person", "host"] },
  sessionId: { type: "string" },
  name: { type: "string" },
  host: { type: "string" },
  personId: { type: "string" },
});
const SESSION_TOOL_OUTPUTS: Record<string, object> = {
  startLane: output(["success", "sessionId", "name", "host", "note"], {
    success: { type: "boolean" },
    sessionId: { type: "string" },
    name: { type: "string" },
    workspaceName: { type: "string" },
    host: { type: "string" },
    note: { type: "string" },
  }),
  messageSession: output(["success", "accepted", "messageId"], {
    success: { type: "boolean" },
    accepted: { type: "boolean" },
    messageId: { type: "string" },
    deliveryState: { enum: ["queued", "started"] },
    response: { type: "string" },
    status: { enum: ["timeout"] },
    replacedMessageIds: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  }),
  searchSessions: output(["success", "results"], {
    success: { type: "boolean" },
    results: {
      type: "array",
      items: output(["sessionId", "name", "label", "snippet", "score", "state", "createdAt", "updatedAt", "host", "runId"], {
        sessionId: { type: "string" },
        name: { type: "string" },
        label: { type: "string" },
        snippet: { type: "string" },
        score: { type: "number" },
        state: { enum: ["running", "idle", "failed"] },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
        host: { type: "string" },
        runId: { type: "string" },
        workspace: { type: "string" },
        parentId: { type: "string" },
        launchedBy: { type: "string" },
      }),
    },
  }),
  getSessionTranscript: output([], {
    success: { type: "boolean" },
    error: { type: "string" },
    name: { type: "string" },
    createdAt: { type: "string" },
    messageCount: { type: "integer" },
    showing: { type: "integer" },
    messages: {
      type: "array",
      items: output(["role", "content"], {
        role: { enum: ["user", "assistant", "system"] },
        content: { type: "string" },
        from: SENDER,
      }),
    },
  }),
};

/**
 * Sessions talking to sessions, under the desktop's self-tool names (electron/self-tools.ts: startLane, messageSession,
 * searchSessions, getSessionTranscript), so an agent prompted for the desktop calls the same names here.
 */
export function createSessionToolsProvider(port: ClaudeAgentPort, store: FileSessionStore): CapabilityProvider {
  const descriptors = Object.entries(SESSION_TOOLS).map(([operation, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${TOOL_PREFIX}${operation}`,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "session", "lane"],
    inputSchema: spec.input,
    outputSchema: SESSION_TOOL_OUTPUTS[operation],
    permissions: [{ permission: `${TOOL_PREFIX}${operation}`, risk: spec.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const senderOf = (caller: string | undefined): MessageSender => {
    const session = caller ? store.get(caller) : undefined;
    return session ? { kind: "session", sessionId: session.id, name: session.title } : { kind: "host", name: port.hostId };
  };
  return {
    id: "marshal.session-tools",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as Record<string, any>;
      const caller = callerSessionId(context);
      switch (name.slice(TOOL_PREFIX.length)) {
        case "startLane": {
          const task = text(input.task, "task");
          const launcher = caller ? store.get(caller) : undefined;
          const intro = launcher
            ? `You are a new Marshal session (a lane) started by session "${launcher.title}" (${launcher.id}). You are not its subagent: nothing you do reports back to it automatically. Send it your results, a blocking question or a milestone it must act on with marshal.tool.messageSession {sessionId: "${launcher.id}"}.\n\n`
            : "";
          const lane = port.launch({
            task: `${intro}${task}`,
            idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : randomUUID(),
            name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : quickTitle(task),
            ...(typeof input.model === "string" ? { model: input.model } : {}),
            ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
            ...(launcher ? { launchedBy: launcher.id, from: senderOf(launcher.id) } : {}),
          });
          return {
            output: {
              success: true,
              sessionId: lane.id,
              name: lane.name,
              ...(lane.workspaceName ? { workspaceName: lane.workspaceName } : {}),
              host: port.hostId,
              note: "The lane is working now as its own session. It will not report back by itself; it knows your session ID and messages you when it needs to. Steer it with marshal.tool.messageSession.",
            },
          };
        }
        case "messageSession": {
          const from = senderOf(caller);
          const result = await port.deliver({
            messageId: randomUUID(),
            from,
            to: { sessionId: text(input.sessionId, "sessionId"), ...(typeof input.host === "string" ? { host: input.host } : {}) },
            body: text(input.message, "message"),
            deliveryMode: input.deliveryMode === "interrupt" ? "interrupt" : "queue",
            sentAt: new Date().toISOString(),
            ...(input.replaceQueued ? { replaceQueued: true } : {}),
            ...(input.waitForResponse ? { waitForResponse: true } : {}),
            ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          });
          return { output: result };
        }
        case "searchSessions": {
          const limit = Math.max(1, Math.min(typeof input.limit === "number" ? input.limit : 10, 50));
          const since = typeof input.since === "string" ? input.since : undefined;
          const until = typeof input.until === "string" ? input.until : undefined;
          const workspace = typeof input.workspace === "string" ? input.workspace.toLowerCase() : undefined;
          const results = store
            .search(text(input.query, "query"), 500)
            .filter(({ session }) => session.id !== caller)
            .filter(({ session }) => input.includeSubagents !== false || !session.parentId)
            .filter(({ session }) => !since || session.updatedAt >= since)
            .filter(({ session }) => !until || session.createdAt <= until)
            .filter(({ session }) => !workspace || (session.workspace ?? "").toLowerCase().includes(workspace))
            .slice(0, limit)
            .map(({ session, snippet, score }) => ({
              sessionId: session.id,
              name: session.title,
              label: "mine",
              snippet,
              score,
              state: session.state,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              host: session.host.id,
              runId: session.runId,
              ...(session.workspace ? { workspace: session.workspace } : {}),
              ...(session.parentId ? { parentId: session.parentId } : {}),
              ...(session.launchedBy ? { launchedBy: session.launchedBy } : {}),
            }));
          return { output: { success: true, results } };
        }
        case "getSessionTranscript": {
          const sessionId = text(input.sessionId, "sessionId");
          const session = store.get(sessionId);
          if (!session) return { output: { success: false, error: "Session not found" } };
          const all = store.messages(sessionId);
          const lastN = typeof input.lastN === "number" && input.lastN > 0 ? input.lastN : 30;
          const messages = all.slice(-lastN).map((message) => ({
            role: message.role,
            content: message.content.slice(0, 2000),
            ...(message.from ? { from: message.from } : {}),
          }));
          return {
            output: { name: session.title, createdAt: session.createdAt, messageCount: all.length, showing: messages.length, messages },
          };
        }
        default:
          throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not-found" });
      }
    },
  } as unknown as CapabilityProvider;
}

/** The desktop's quick title: the task's first line, cut at a word near 60 characters. */
function quickTitle(task: string): string {
  const line = task.trim().split("\n")[0]!.trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} must be a non-empty string.`), { code: "invalid-request" });
  }
  return value;
}
