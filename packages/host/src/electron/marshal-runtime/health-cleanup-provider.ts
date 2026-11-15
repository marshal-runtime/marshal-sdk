import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";

import type { HealthCleanupProposalStore } from "../health-cleanup-proposals";
import { MARSHAL_RUNTIME_PERMISSION } from "./contracts";
import { invalidRuntimeRequest } from "./runtime-provider-error";

const PROVIDER_ID = "marshal.health-cleanup";
export const HEALTH_CLEANUP_PROPOSE_CAPABILITY = "health.cleanup.propose";
const MAX_REASON_LENGTH = 300;
const MAX_PATH_LENGTH = 1024;

const DESCRIPTOR: CapabilityDescriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: HEALTH_CLEANUP_PROPOSE_CAPABILITY,
  version: "1.0.0",
  title: "Propose a cleanup in the session Health tab",
  description:
    "Records a proposed cleanup (end an orphan process, or remove a worktree) for the calling " +
    "session's tree. Nothing is performed: the proposal appears in the side panel's Health tab " +
    "and only runs when the user clicks Approve, after the target is re-verified.",
  tags: ["marshal", "health", "cleanup"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "reason"],
    properties: {
      kind: { enum: ["end-orphan", "remove-worktree"] },
      pid: { type: "integer", minimum: 2 },
      path: { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH },
      reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LENGTH },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "proposalId", "message"],
    properties: {
      status: { enum: ["proposed"] },
      proposalId: { type: "string" },
      message: { type: "string" },
    },
  },
  permissions: [
    {
      permission: MARSHAL_RUNTIME_PERMISSION.healthCleanupPropose,
      reason: "Records a cleanup proposal for the user to approve; performs nothing.",
      risk: "low",
    },
  ],
};

export function createHealthCleanupProvider(store: HealthCleanupProposalStore): CapabilityProvider {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    list: () => [DESCRIPTOR],
    get: (name) => (name === HEALTH_CLEANUP_PROPOSE_CAPABILITY ? DESCRIPTOR : undefined),
    async invoke(name, input, context) {
      if (name !== HEALTH_CLEANUP_PROPOSE_CAPABILITY) {
        throw Object.assign(new Error(`Marshal health capability not found: ${name}.`), {
          code: "not_found",
        });
      }
      const sessionId = requesterSession(context);
      const value = parseInput(input);
      const proposal = store.add(sessionId, value);
      return {
        output: {
          status: "proposed",
          proposalId: proposal.id,
          message: "Proposal recorded. The user approves or dismisses it in the Health tab.",
        },
      };
    },
  };
}

function requesterSession(context: InvocationContext): string {
  const sessionId = context.scope?.sessionId?.trim();
  if (!sessionId) {
    throw Object.assign(new Error("health.cleanup.propose requires a session-scoped invocation."), {
      code: "permission_denied",
    });
  }
  return sessionId;
}

function parseInput(
  input: unknown,
):
  | { kind: "end-orphan"; pid: number; reason: string }
  | { kind: "remove-worktree"; path: string; reason: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRuntimeRequest(new TypeError("health.cleanup.propose input must be an object."));
  }
  const value = Object.fromEntries(Object.entries(input));
  for (const key of Object.keys(value)) {
    if (!["kind", "pid", "path", "reason"].includes(key)) {
      throw invalidRuntimeRequest(new TypeError(`Unsupported input key: ${key}.`));
    }
  }
  const reason = value.reason;
  if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_REASON_LENGTH) {
    throw invalidRuntimeRequest(new TypeError('"reason" must be a short non-empty string.'));
  }
  if (value.kind === "end-orphan") {
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 2) {
      throw invalidRuntimeRequest(new TypeError('"pid" must be an integer above 1.'));
    }
    return { kind: "end-orphan", pid: value.pid, reason };
  }
  if (value.kind === "remove-worktree") {
    if (
      typeof value.path !== "string" ||
      !value.path.trim() ||
      value.path.length > MAX_PATH_LENGTH
    ) {
      throw invalidRuntimeRequest(new TypeError('"path" must be a non-empty string.'));
    }
    return { kind: "remove-worktree", path: value.path, reason };
  }
  throw invalidRuntimeRequest(new TypeError('"kind" must be end-orphan or remove-worktree.'));
}
