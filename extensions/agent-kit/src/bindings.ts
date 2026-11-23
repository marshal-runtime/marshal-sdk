import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { channelSend, CHANNEL_SERVICE, SANDBOX_SERVICE, serviceToken, type Channel, type Sandbox, type SandboxSession } from "./contracts.js";

/** The part of the runtime's service container the kit reads its bindings from (agent-runtime-composer `RuntimeServiceAccessor`). */
export interface KitServices {
  tryGet<T>(token: symbol): T | undefined;
  getAll<T>(token: symbol): readonly T[];
}

/** No sandbox extension is installed and enabled in this host. */
export class NoSandboxError extends Error {
  constructor() {
    super(`no ${SANDBOX_SERVICE} is bound: install a sandbox extension (e.g. @marshal/agent-kit-daytona)`);
    this.name = "NoSandboxError";
  }
}

/** What a host's engine takes from the kit's extensions: the bound sandbox (if any), the bound channels, and the outbox's send over them. */
export function kitBindings(services: KitServices) {
  const channels = services.getAll<Channel>(serviceToken(CHANNEL_SERVICE));
  return {
    sandbox: services.tryGet<Sandbox>(serviceToken(SANDBOX_SERVICE)) ?? null,
    channels,
    send: channelSend(channels),
  };
}

/**
 * The Agent SDK options of one session in the bound sandbox: the sandbox is ensured for the session's scope first (the SDK's spawn hook is
 * synchronous), then every process the SDK starts goes through `Sandbox.spawn` in that target's work directory.
 */
export async function sandboxSessionOptions(services: KitServices, session: SandboxSession, reason: string): Promise<Pick<Options, "cwd" | "spawnClaudeCodeProcess">> {
  const { sandbox } = kitBindings(services);
  if (!sandbox) throw new NoSandboxError();
  const target = await sandbox.ensure(session.scope, reason);
  return { cwd: target.workDir, spawnClaudeCodeProcess: (options) => sandbox.spawn(target, session, options) };
}
