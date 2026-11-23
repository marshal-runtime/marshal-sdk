import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { Sandbox, SandboxSession, SandboxTarget } from "../contracts.js";
import { PortAllocator } from "../marley/claude.js";
import type { ModelProxy } from "../marley/proxy.js";
import type { DaytonaProvider } from "../marley/sandbox/daytona/provider.js";
import type { SshTarget } from "../marley/sandbox/ssh-target.js";
import type { SshRunner } from "../marley/sandbox/ssh.js";
import { WAKE_REASONS, type WakeReason } from "../marley/sandbox/wake-reason.js";
import type { ConversationKey } from "../marley/store.js";

/** The sandbox kind this binding serves. */
export const DAYTONA_KIND = "daytona";

/**
 * The host service the Daytona extension needs: Marley's own provider, ssh runner and model proxy, built by the host from its config, database
 * and secrets (`createDaytonaProvider`, `new SshRunner`, `new ModelProxy`). They hold the host's credentials, so they stay on the host side.
 */
export const DAYTONA_HOST_SERVICE = "@marshal/agent-kit:daytona-host";

export interface DaytonaHost {
  provider: Pick<DaytonaProvider, "ensure" | "stop">;
  ssh: Pick<SshRunner, "paths" | "spawner">;
  proxy: Pick<ModelProxy, "port" | "open">;
  /** The tunnel ports on the sandbox; one allocator per ssh runner (Marley's `ClaudeRunner.ports`). */
  ports?: PortAllocator;
}

/** The model proxy has no port: the host started no proxy, so no session can reach a model (Marley's PoolNotConfiguredError). */
export class ProxyNotStartedError extends Error {
  constructor() {
    super("the model proxy is not started");
    this.name = "ProxyNotStartedError";
  }
}

/** A target this sandbox did not hand out (or handed out before it was stopped). */
export class UnknownTargetError extends Error {
  constructor(id: string) {
    super(`no Daytona target ${id}`);
    this.name = "UnknownTargetError";
  }
}

// Marley's keyString (store.ts at 7110e58c8), copied: importing store.ts would bundle its sqlite and schema modules into the extension.
const keyString = (key: ConversationKey): string => `${key.brandId}|${key.channel}|${key.conversationId}`;

const isWakeReason = (reason: string): reason is WakeReason => (WAKE_REASONS as readonly string[]).includes(reason);

/**
 * The Daytona binding of the kit's `Sandbox`: Marley's `DaytonaProvider.ensure` starts the scope's (brand's) sandbox; `spawn` is the glue of
 * Marley's `ClaudeRunner.openSession` (claude.ts at 7110e58c8): a proxy session under a dummy key, a tunnel port, and `SshRunner.spawner`, with
 * the proxy session closed and the port released when the process exits.
 */
export function createDaytonaSandbox(host: DaytonaHost): Sandbox {
  const ports = host.ports ?? new PortAllocator();
  const targets = new Map<string, { scope: string; ip: SshTarget }>();
  return {
    kind: DAYTONA_KIND,
    async ensure(scope: string, reason: string): Promise<SandboxTarget> {
      const { hostId, target } = await host.provider.ensure(scope, isWakeReason(reason) ? reason : "turn");
      targets.set(hostId, { scope, ip: target });
      return { id: hostId, workDir: host.ssh.paths(scope).work };
    },
    spawn(target: SandboxTarget, session: SandboxSession, options: SpawnOptions): SpawnedProcess {
      const held = targets.get(target.id);
      if (!held || held.scope !== session.scope) throw new UnknownTargetError(target.id);
      const proxyPort = host.proxy.port();
      if (proxyPort === null) throw new ProxyNotStartedError();
      const chat = session.conversation;
      const opened = host.proxy.open(session.scope, session.runId, { front: Boolean(chat && session.front), chat: chat ? keyString(chat) : null });
      let port: ReturnType<PortAllocator["take"]>;
      try {
        port = ports.take();
      } catch (error) {
        opened.close();
        throw error;
      }
      const finish = (): void => {
        opened.close();
        port.release();
      };
      try {
        const paths = host.ssh.paths(session.scope, chat);
        const child = host.ssh.spawner({ ip: held.ip, brandId: session.scope, ...(chat ? { chat } : {}), remotePort: port.port, proxyPort, dummyKey: opened.dummyKey, cwd: paths.work })(options);
        child.once("exit", finish);
        return child;
      } catch (error) {
        finish();
        throw error;
      }
    },
    async stop(scope: string): Promise<void> {
      await host.provider.stop(scope);
      for (const [id, held] of targets) if (held.scope === scope) targets.delete(id);
    },
  };
}
