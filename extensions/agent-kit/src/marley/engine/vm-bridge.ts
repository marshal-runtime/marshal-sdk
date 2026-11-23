import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";

import type { AntigravityBridgeSpawnRequest } from "@zygstinct/marshal-sdk-port/host";

import type { SshRunner } from "../sandbox/ssh.js";
import type { VmAntigravityBridge } from "./marshal-engine.js";

type VmSpawner = ReturnType<SshRunner["antigravitySpawner"]>;

/**
 * The Antigravity bridge of one chat turn or routine run on its brand VM (ClaudeTurnRunner.openSession): the `vertex` proxy session, opened on the
 * first bridge, and every bridge child (the ssh process carrying the VM's bridge.py and its reverse tunnel) spawned for it. `close` ends both. The SDK
 * disconnects a routed session only when its turn failed, its key changed or the host is disposed, so a successful turn would otherwise leave its
 * bridge, its harness on the VM and its ssh tunnel running until the server restarts; the next turn makes a new key and so a new bridge anyway (N6).
 */
export function vmAntigravity<Opened extends { dummyKey: string; close(): void }>(input: {
  target: string;
  /** Opens the turn's `vertex` proxy session (once). */
  open: () => Opened;
  /** The VM spawner for that session's key (SshRunner.antigravitySpawner). */
  spawner: (opened: Opened) => VmSpawner;
  onSpawn?: (request: AntigravityBridgeSpawnRequest) => void;
}): { bridge: () => VmAntigravityBridge; opened: () => Opened | null; close: () => void } {
  let opened: Opened | null = null;
  const children = new Set<ChildProcess>();
  return {
    bridge: () => {
      opened ??= input.open();
      const spawner = input.spawner(opened);
      return {
        target: input.target,
        endpoint: spawner.endpoint,
        workspaceDir: spawner.workspaceDir,
        homeDir: spawner.homeDir,
        spawnBridge: (request) => {
          input.onSpawn?.(request);
          const child = spawner.spawnBridge(request);
          children.add(child);
          child.once("exit", () => children.delete(child));
          if (!child.stdin || !child.stdout || !child.stderr) {
            stop(child);
            throw new Error("the Antigravity bridge's ssh process has no stdio pipes");
          }
          return child as ChildProcessWithoutNullStreams;
        },
      };
    },
    opened: () => opened,
    close: () => {
      opened?.close();
      for (const child of children) stop(child);
      children.clear();
    },
  };
}

/** SIGTERM to a bridge child still running; one that already exited (or cannot be signalled) is left alone. */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone between the check and the signal.
  }
}
