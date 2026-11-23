import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { ComposedOutcome, ComposedPart, SendOrigin } from "./marley/outbox/outbox.js";
import type { ConversationKey } from "./marley/store.js";

/** The service id a sandbox extension provides (`provides.services`) and the kit depends on. */
export const SANDBOX_SERVICE = "agent-kit.sandbox";

/** The service id a channel extension provides. */
export const CHANNEL_SERVICE = "agent-kit.channel";

/** The version of both service contracts. */
export const SERVICE_VERSION = "1.0.0";

/** A running place a session's Claude Code process can be started in, as its sandbox names it (a Daytona sandbox id, a host alias). */
export interface SandboxTarget {
  id: string;
  workDir: string;
}

/** Where sessions run. The engine asks it for a target before a turn and starts Claude Code there through `spawn` (the Agent SDK's `spawnClaudeCodeProcess`). */
export interface Sandbox {
  readonly kind: string;
  ensure(scope: string, reason: string): Promise<SandboxTarget>;
  spawn(target: SandboxTarget, options: SpawnOptions): SpawnedProcess;
  stop?(scope: string): Promise<void>;
}

/** How words reach a person: the outbox's send for one conversation (Marley's `ComposedSend`), bound per channel kind. */
export interface Channel {
  readonly kind: string;
  send(key: ConversationKey, part: ComposedPart, idempotencyKey: string, origin: SendOrigin): Promise<ComposedOutcome>;
}
