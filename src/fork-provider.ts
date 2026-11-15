import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider, type InvocationContext } from "@marshal/runtime";

import { callerSessionId } from "./agent-provider.js";
import { MAX_FORKS_PER_CALL, type ForkTask, type SessionForks } from "./forks.js";

const PREFIX = "marshal.tool.";
const VERSION = "1.0.0";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const output = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const DELIVERY = {
  success: { type: "boolean" },
  accepted: { type: "boolean" },
  messageId: { type: "string" },
  deliveryState: { enum: ["queued", "started"] },
  response: { type: "string" },
  status: { enum: ["timeout"] },
  replacedMessageIds: { type: "array", items: { type: "string" } },
  error: { type: "string" },
};
const FORK = output(["groupId", "index", "total", "task"], {
  groupId: { type: "string" },
  index: { type: "integer" },
  total: { type: "integer" },
  task: { type: "string" },
});
const SUBAGENT = output(["id", "name", "state", "isBusy", "createdAt", "updatedAt", "usage"], {
  id: { type: "string" },
  name: { type: "string" },
  state: { enum: ["running", "idle", "failed"] },
  isBusy: { type: "boolean" },
  createdAt: { type: "string" },
  updatedAt: { type: "string" },
  model: { type: "string" },
  reasoningEffort: { type: "string" },
  fork: FORK,
  queuedMessageCount: { type: "integer" },
  lastError: { type: "string" },
  usage: output([], { costUsd: { type: "number" }, turns: { type: "integer" } }),
});

interface ToolSpec {
  title: string;
  description: string;
  risk: "low" | "medium" | "high";
  input: object;
  output: object;
}

/** The desktop's descriptions (electron/self-tools.ts), cut to what this host does. */
const TOOLS: Record<string, ToolSpec> = {
  forkSubagents: {
    title: "Fork into subagents",
    description:
      "Fork yourself into subagents that each take one part of the work. A fork is not briefed from a summary: it continues this exact conversation (everything you have read, decided and been told), with its task as its first message. A fork runs on your model and effort unless its task names others (your model keeps your prompt cache). Call it once with every task; each fork is its own session, sees its siblings and their tasks, works in your workspace, and its final message comes back to you when it goes idle. Give each fork a self-contained, non-overlapping task (own files or concerns), then continue only with work you kept, or end your turn and wait. Desktop-only fields (runtime, permissionMode) are accepted and ignored.",
    risk: "high",
    input: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FORKS_PER_CALL,
          items: {
            type: "object",
            required: ["task"],
            properties: {
              task: string(32_768),
              name: string(256),
              model: string(256),
              runtime: { type: "string" },
              reasoningEffort: { enum: EFFORTS },
            },
          },
        },
        permissionMode: { type: "string" },
        /** The session to fork when a host or extension calls this; a session forks itself. */
        sessionId: string(256),
      },
    },
    output: output(["success"], {
      success: { type: "boolean" },
      groupId: { type: "string" },
      forks: {
        type: "array",
        items: output(["sessionId", "name", "task"], { sessionId: { type: "string" }, name: { type: "string" }, task: { type: "string" } }),
      },
      mode: { enum: ["file-copy", "backend-fork"] },
      note: { type: "string" },
      error: { type: "string" },
    }),
  },
  listSubagents: {
    title: "List your subagents",
    description:
      "List subagent sessions launched or forked from this session, each with whether it is working, its fork group and queued messages. Use it to answer status questions without interrupting subagents. Returns every subagent on this host when the caller is not a session.",
    risk: "low",
    input: { type: "object", properties: {} },
    output: output(["success", "subagents"], { success: { type: "boolean" }, subagents: { type: "array", items: SUBAGENT } }),
  },
  messageSubagent: {
    title: "Message a subagent",
    description:
      "Send a message to one of your subagents. Defaults to queueing behind its current turn; use deliveryMode=interrupt when it must stop what it is doing now (a change of plan, an urgent correction). replaceQueued=true drops your earlier messages to it that have not started. waitForResponse returns its reply.",
    risk: "high",
    input: {
      type: "object",
      required: ["sessionId", "message"],
      properties: {
        sessionId: string(256),
        message: string(200_000),
        deliveryMode: { enum: ["wait-if-idle", "queue", "interrupt"] },
        replaceQueued: { type: "boolean" },
        waitForResponse: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      },
    },
    output: output(["success", "accepted", "messageId"], { ...DELIVERY, sessionId: { type: "string" } }),
  },
  messageForks: {
    title: "Message your forks",
    description:
      "Send one message to every fork you created, or to one fork group (groupId from forkSubagents): a correction, a new constraint, or a decision that affects all of them. deliveryMode 'queue' (default) waits for each fork's current turn; 'interrupt' stops it so the message lands now.",
    risk: "high",
    input: {
      type: "object",
      required: ["message"],
      properties: {
        message: string(200_000),
        groupId: string(256),
        deliveryMode: { enum: ["queue", "interrupt"] },
        replaceQueued: { type: "boolean" },
        /** The parent whose forks to message, when a host or extension calls this. */
        sessionId: string(256),
      },
    },
    output: output(["success", "results"], {
      success: { type: "boolean" },
      error: { type: "string" },
      results: { type: "array", items: output(["sessionId", "success"], { ...DELIVERY, sessionId: { type: "string" } }) },
    }),
  },
  listForkSiblings: {
    title: "List your fork siblings",
    description:
      "For a forked session: the other forks created by the same forkSubagents call, with each one's task, whether it is working, and its latest message. Use it to avoid overlapping a sibling's work or to pick up what one found.",
    risk: "low",
    input: { type: "object", properties: {} },
    output: output(["success"], {
      success: { type: "boolean" },
      error: { type: "string" },
      parentSessionId: { type: "string" },
      groupId: { type: "string" },
      you: output(["index", "total"], { index: { type: "integer" }, total: { type: "integer" } }),
      siblings: {
        type: "array",
        items: output(["index", "sessionId", "name", "task", "isBusy", "state"], {
          index: { type: "integer" },
          sessionId: { type: "string" },
          name: { type: "string" },
          task: { type: "string" },
          isBusy: { type: "boolean" },
          state: { enum: ["running", "idle", "failed"] },
          latestMessage: { type: "string" },
        }),
      },
    }),
  },
  messageParent: {
    title: "Message your parent",
    description:
      "From inside a subagent or fork: send the parent session an important milestone, a blocking question, or a final result now. Your final message already reaches it when you go idle, so do not use this as a heartbeat. Defaults to interrupt; use queue when it can wait.",
    risk: "medium",
    input: {
      type: "object",
      required: ["message"],
      properties: {
        message: string(200_000),
        deliveryMode: { enum: ["queue", "interrupt"] },
        waitForResponse: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      },
    },
    output: output(["success", "accepted", "messageId"], DELIVERY),
  },
};

/** Forks under the desktop's self-tool names, as `marshal.tool.*` capabilities every session and the host can call. */
export function createForkToolsProvider(forks: SessionForks): CapabilityProvider {
  const descriptors = Object.entries(TOOLS).map(([operation, spec]) => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${PREFIX}${operation}`,
    version: VERSION,
    title: spec.title,
    description: spec.description,
    tags: ["marshal", "session", "fork", "subagent"],
    inputSchema: spec.input,
    outputSchema: spec.output,
    permissions: [{ permission: `${PREFIX}${operation}`, risk: spec.risk }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marshal.fork-tools",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context: InvocationContext) => {
      const input = (value ?? {}) as Record<string, any>;
      const caller = forks.known(callerSessionId(context));
      switch (name.slice(PREFIX.length)) {
        case "forkSubagents": {
          const parent = caller ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
          if (!parent) return { output: { success: false, error: "No calling session: pass sessionId to fork a session from the host." } };
          try {
            const tasks: ForkTask[] = (Array.isArray(input.tasks) ? input.tasks : []).map((task: Record<string, unknown>) => ({
              task: String(task?.task ?? ""),
              ...(typeof task?.name === "string" ? { name: task.name } : {}),
              ...(typeof task?.model === "string" ? { model: task.model } : {}),
              ...(typeof task?.reasoningEffort === "string" ? { reasoningEffort: task.reasoningEffort } : {}),
            }));
            const group = await forks.fork(parent, tasks, caller === parent);
            return {
              output: {
                success: true,
                ...group,
                note: "Each fork continues this conversation with its own task and is working now. Its final message reaches you when it goes idle. For status, read marshal.tool.listSubagents rather than messaging them; to pass a correction to all of them, use marshal.tool.messageForks with this groupId. Do not redo their parts.",
              },
            };
          } catch (error) {
            return { output: { success: false, error: error instanceof Error ? error.message : String(error) } };
          }
        }
        case "listSubagents":
          return { output: { success: true, subagents: forks.subagents(caller) } };
        case "messageSubagent":
          return {
            output: await forks.messageSubagent(caller, text(input.sessionId, "sessionId"), text(input.message, "message"), {
              deliveryMode: input.deliveryMode === "interrupt" ? "interrupt" : "queue",
              ...(input.replaceQueued ? { replaceQueued: true } : {}),
              ...(input.waitForResponse ? { waitForResponse: true } : {}),
              ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
            }),
          };
        case "messageForks": {
          const parent = caller ?? (typeof input.sessionId === "string" ? input.sessionId : undefined);
          if (!parent) return { output: { success: false, results: [], error: "No calling session: pass sessionId (the parent) from the host." } };
          const targets = forks.forkIds(parent, typeof input.groupId === "string" ? input.groupId : undefined);
          if (targets.length === 0) return { output: { success: false, results: [], error: "No forks match" } };
          const message = text(input.message, "message");
          const results = await Promise.all(
            targets.map((target) =>
              forks.messageSubagent(parent, target, message, {
                deliveryMode: input.deliveryMode === "interrupt" ? "interrupt" : "queue",
                ...(input.replaceQueued ? { replaceQueued: true } : {}),
              }),
            ),
          );
          return { output: { success: results.every((result) => result.success), results } };
        }
        case "listForkSiblings": {
          const siblings = caller ? forks.siblings(caller) : undefined;
          return { output: siblings ? { success: true, ...siblings } : { success: false, error: "This session is not a fork" } };
        }
        case "messageParent":
          if (!caller) return { output: { success: false, accepted: false, messageId: "", error: "No calling session" } };
          return {
            output: await forks.messageParent(caller, text(input.message, "message"), {
              ...(input.deliveryMode === "queue" ? { deliveryMode: "queue" as const } : {}),
              ...(input.waitForResponse ? { waitForResponse: true } : {}),
              ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
            }),
          };
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
