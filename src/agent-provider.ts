import { randomUUID } from "node:crypto";

import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";
import {
  createRuntimeAgentProvider,
  MARSHAL_RUNTIME_AGENT_REASONING_EFFORTS,
  type MarshalRuntimeAgentPort,
  type MarshalRuntimeAgentSummary,
} from "@marshal/runtime/delegation";

import type { AgentSummary, ClaudeAgentPort } from "./agent-port.js";
import type { MessageSender } from "./session-messages.js";
import type { FileSessionStore } from "./session-store.js";

const VERSION = "1.0.0";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const agentId = string(256);
const output = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

/**
 * `marshal.agent.*` is the runtime's own provider (@marshal/runtime/delegation): the desktop's names, schemas,
 * permissions and errors, so an extension written against the desktop calls the same capabilities here. This host
 * registers its Claude Agent SDK sessions as the port. Desktop-only launch fields (worktrees, souls, runtime accounts,
 * allowedTools, repository agents) are accepted and ignored: a headless host has one backend and one checkout.
 */
export function createAgentProvider(
  port: ClaudeAgentPort,
  knownSession: (sessionId: string | undefined) => boolean,
): CapabilityProvider {
  return createRuntimeAgentProvider(sessionAgentPort(port, knownSession), {
    // The host itself (host.invoke, a schedule, the link) calls without a session and acts as the host.
    resolveScope: (context) => {
      const named = context.metadata?.marshalWorkspaceName;
      return {
        sessionId: callerSessionId(context) ?? `host:${port.hostId}`,
        workspaceName: typeof named === "string" && named.trim() ? named.trim() : "workspace",
      };
    },
  });
}

/**
 * The runtime's agent port over this host's sessions. Every agent on the host is visible to every caller (one
 * tenant per host); a launch from a known session records it as the parent.
 */
function sessionAgentPort(
  port: ClaudeAgentPort,
  knownSession: (sessionId: string | undefined) => boolean,
): MarshalRuntimeAgentPort {
  return {
    async launch(request) {
      if (request.sessionId) {
        return agentSummary(port.send(request.sessionId, request.task, "queue"));
      }
      return agentSummary(
        port.launch({
          task: request.task,
          idempotencyKey: request.idempotencyKey,
          ...(request.name ? { name: request.name } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
          ...(knownSession(request.scope.sessionId) ? { parentId: request.scope.sessionId } : {}),
        }),
      );
    },
    async list() {
      return port.list().map(agentSummary);
    },
    async get(_scope, id) {
      const agent = port.get(id);
      return agent ? agentSummary(agent) : null;
    },
    async send(_scope, id, message, deliveryMode) {
      return { agent: agentSummary(port.send(id, message, deliveryMode)), accepted: true };
    },
    async transcript(_scope, id, limit) {
      const transcript = port.transcript(id, limit);
      return {
        agent: agentSummary(transcript.agent),
        messageCount: transcript.messageCount,
        showing: transcript.showing,
        messages: transcript.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          ...(message.error ? { error: true } : {}),
        })),
        ...(transcript.result !== undefined ? { result: transcript.result } : {}),
      };
    },
    async wait(_scope, id, options) {
      const waited = await port.wait(id, options?.timeoutMs);
      return {
        state: waited.state,
        agent: agentSummary(waited.agent),
        ...(waited.result !== undefined ? { result: waited.result } : {}),
      };
    },
    async cancel(_scope, id) {
      return agentSummary(port.cancel(id));
    },
    async setModel(_scope, id, model, reasoningEffort) {
      return agentSummary(port.setModel(id, model, reasoningEffort));
    },
  };
}

/** The runtime's agent shape: a failed turn reads as idle, with the error message in its transcript. */
function agentSummary(agent: AgentSummary): MarshalRuntimeAgentSummary {
  const effort = MARSHAL_RUNTIME_AGENT_REASONING_EFFORTS.find((value) => value === agent.reasoningEffort);
  return {
    id: agent.id,
    name: agent.name,
    state: agent.state === "running" ? "running" : "idle",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    ...(agent.model ? { model: agent.model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(agent.workspaceName ? { workspaceName: agent.workspaceName } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    usage: {
      inputTokens: agent.usage.inputTokens,
      outputTokens: agent.usage.outputTokens,
      cachedInputTokens: agent.usage.cachedInputTokens,
      costUsd: agent.usage.costUsd,
      // The runtime's usage object is open; the SDK's own round-trip count rides along.
      ...(agent.usage.modelTurns ? { modelTurns: agent.usage.modelTurns } : {}),
    },
  };
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
