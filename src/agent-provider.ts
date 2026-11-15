import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import type { ClaudeAgentPort } from "./agent-port.js";

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
  wait: output(["state", "agent"], { state: { enum: ["completed", "timeout"] }, agent: AGENT, result: { type: "string" } }),
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
      const caller = (context as { sessionId?: string }).sessionId;
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

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} must be a non-empty string.`), { code: "invalid-request" });
  }
  return value;
}
