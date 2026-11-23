import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { ComposedOutcome, ComposedPart, SendOrigin } from "./marley/outbox/outbox.js";
import type { ConversationKey } from "./marley/store.js";

/** The service a sandbox extension provides (`provides.services[].id`, the runtime's package-qualified service key). One per host: `bind`. */
export const SANDBOX_SERVICE = "@marshal/agent-kit:sandbox";

/** The service a channel extension provides. A host has one per channel kind: `many`, picked by `kind`. */
export const CHANNEL_SERVICE = "@marshal/agent-kit:channel";

/** The version of the service contracts. */
export const SERVICE_VERSION = "1.0.0";

/**
 * The runtime's token for a service key: `createRuntimeServiceToken` (agent-runtime-composer) is `Symbol.for(key)`, so an extension bundle and its
 * host agree on the token without sharing a module.
 */
export const serviceToken = <T>(key: string): symbol & { readonly __service?: T } => Symbol.for(key);

/** A running place a session's Claude Code process can be started in, as its sandbox names it (a Daytona sandbox id, a host alias). */
export interface SandboxTarget {
  id: string;
  workDir: string;
}

/** Who the process works for: the sandbox scope (Marley's brand), the conversation when there is one, and the run it belongs to. */
export interface SandboxSession {
  scope: string;
  conversation?: ConversationKey;
  runId: string;
  /** A front turn of the conversation (Marley's `role.front`): its session may act with the conversation owner's authority. Unset: not front. */
  front?: boolean;
}

/** Where sessions run. The engine asks it for a target before a turn and starts Claude Code there through `spawn` (the Agent SDK's `spawnClaudeCodeProcess`). */
export interface Sandbox {
  readonly kind: string;
  ensure(scope: string, reason: string): Promise<SandboxTarget>;
  spawn(target: SandboxTarget, session: SandboxSession, options: SpawnOptions): SpawnedProcess;
  stop?(scope: string): Promise<void>;
}

/** A posted part: the outbox's outcome and, when it was posted, the message's id on the channel (a Slack ts, a GitHub comment's URL). */
export interface ChannelPosted {
  outcome: ComposedOutcome;
  id: string | null;
}

/**
 * How words reach a person: the outbox's send for one conversation (Marley's `ComposedSend`), bound per channel kind. `post` is the same send
 * with the posted message's id, for a host that records what it sent; `acknowledge` tells a person their message was taken (`messageId` is the
 * host's id of it, whose last `:` segment is the channel's own id; `text` its words, for a channel that picks the acknowledgement by them).
 */
export interface Channel {
  readonly kind: string;
  send(key: ConversationKey, part: ComposedPart, idempotencyKey: string, origin: SendOrigin): Promise<ComposedOutcome>;
  post?(key: ConversationKey, part: Pick<ComposedPart, "kind" | "text"> & Partial<Pick<ComposedPart, "lang" | "voiceName">>, idempotencyKey: string): Promise<ChannelPosted>;
  acknowledge?(key: ConversationKey, messageId: string, text?: string): Promise<void>;
}

/** The channel's own id of a host message id (`slack:<channel>:<ts>` → `<ts>`); an id without `:` is its own. */
export const channelMessageId = (messageId: string): string => messageId.slice(messageId.lastIndexOf(":") + 1);

/** The channels a host bound, by kind: the outbox's send for a conversation goes to the channel of its key's `channel`. */
export function channelSend(channels: readonly Channel[]): (key: ConversationKey, part: ComposedPart, idempotencyKey: string, origin: SendOrigin) => Promise<ComposedOutcome> {
  const byKind = new Map(channels.map((channel) => [channel.kind, channel]));
  return async (key, part, idempotencyKey, origin) => {
    const channel = byKind.get(key.channel);
    return channel ? channel.send(key, part, idempotencyKey, origin) : "refused";
  };
}
