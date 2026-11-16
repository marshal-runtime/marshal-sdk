// The runtime every Marshal host runs: the desktop's MarshalRuntimeHost (packages/host, the desktop's
// electron/marshal-runtime shared byte for byte), composed here for a host without the desktop app. The SDK's own
// capability providers, permission brokers and scheduler plug in through the host's options, as the desktop's do.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PermissionBroker } from "@marshal/runtime";

type PermissionDecision = Awaited<ReturnType<PermissionBroker["decide"]>>;

/** dist/host-runtime.js, the bundle of packages/host (build.mjs). */
const HOST_RUNTIME_MODULE = new URL("../host-runtime.js", import.meta.url).href;
/** The SDK package root: the shared host resolves its pinned runtime packs from here. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The desktop host's metadata key for the workspace a call works in (marshal-runtime/host.ts). */
export const WORKSPACE_METADATA_KEY = "marshalWorkspaceName";

export interface SharedRuntimeOptions {
  /** Host-private root: the shared host keeps its runtime state in `<root>/state`. */
  root: string;
  /** The workspace every call works in unless the resolver names another. */
  workspacePath: string;
  workspaceName: string;
  resolveWorkspace?: (context: { sessionId?: string; metadata?: Record<string, unknown> }) => unknown;
  privateRoot: string;
  worktreeRoot: string;
  /** Where local extension packages are copied before they are installed. */
  extensionRoot: string;
  serviceContainer: unknown;
  compositionRegistry?: unknown;
  broker: PermissionBroker;
  principal: { id: string; kind: "agent"; claims?: Record<string, unknown> };
  harnessId: string;
  providerSources: readonly unknown[];
  builtins: Record<string, unknown>;
  nodeExecutable?: string;
  trustedTypeScript?: boolean;
  version: string;
  /** The extension identities a session may see (agent profile); undefined: all installed. */
  sessionExtensionScope?: (sessionId: string) => readonly string[] | undefined;
  diagnostics?: (type: string, details?: Record<string, unknown>) => void;
}

export interface SharedRuntime {
  readonly kernel: any;
  readonly core: any;
  readonly resources: any;
  readonly lifecycle: any;
  readonly serviceContainer: any;
  readonly stateRoot: string;
  /** Copies a local extension package into the host's extension root and installs it, with its configuration. */
  installLocalExtension(packageRoot: string, configuration?: unknown): Promise<{ identity: string }>;
  dispose(): Promise<void>;
}

/** The call context the shared host needs on every call: the session and the workspace by name. */
export function sharedCallContext(sessionId: string, workspaceName: string, workspacePath: string) {
  return { sessionId, workspacePath, metadata: { [WORKSPACE_METADATA_KEY]: workspaceName } };
}

export async function createSharedRuntime(options: SharedRuntimeOptions): Promise<SharedRuntime> {
  const shared = (await import(HOST_RUNTIME_MODULE)) as {
    configureHostPlatform(platform: { paths: { userData: string; temp: string }; version: string }): void;
    MarshalRuntimeHost: new (options: Record<string, unknown>) => any;
  };
  for (const dir of [options.root, options.worktreeRoot, options.extensionRoot, options.privateRoot]) fs.mkdirSync(dir, { recursive: true });
  shared.configureHostPlatform({
    paths: { userData: path.join(options.root, "user-data"), temp: os.tmpdir() },
    version: options.version,
  });
  const resolveScope = async (scope: { sessionId: string; workspaceName: string }) => {
    const resolved = options.resolveWorkspace?.({ sessionId: scope.sessionId, metadata: { [WORKSPACE_METADATA_KEY]: scope.workspaceName } }) as
      | { workspacePath?: string }
      | undefined;
    return { ...scope, workspacePath: resolved?.workspacePath ?? options.workspacePath };
  };
  const host = new shared.MarshalRuntimeHost({
    location: { isPackaged: false, appPath: PACKAGE_ROOT, resourcesPath: PACKAGE_ROOT },
    hostWorkspacePath: options.root,
    protectedLifecycleResultRoot: options.privateRoot,
    worktreeRoot: options.worktreeRoot,
    trustedExtensionRoot: options.extensionRoot,
    authority: {
      resolveScope,
      // Every capability call is decided by the host's brokers (applicationAuthority below); this is not reached.
      async authorize(): Promise<PermissionDecision> {
        return { decision: "allow" } as PermissionDecision;
      },
    },
    // The SDK's brokers see the whole check (capability, input, principal), which the desktop gives its application
    // authority; their decision is final.
    applicationAuthority: {
      resolve: () => undefined,
      decide: (check: Parameters<PermissionBroker["decide"]>[0]) => options.broker.decide(check),
    },
    catalog: {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [{ name: options.workspaceName, path: options.workspacePath }],
      getSessionContext: async () => null,
    },
    serviceContainer: options.serviceContainer,
    ...(options.sessionExtensionScope ? { sessionExtensionScope: options.sessionExtensionScope } : {}),
    ...(options.compositionRegistry ? { compositionRegistry: options.compositionRegistry } : {}),
    additionalProviderSources: options.providerSources,
    ...(options.nodeExecutable ? { nodeExecutable: options.nodeExecutable } : {}),
    ...(options.trustedTypeScript ? { trustedTypeScript: true } : {}),
    principal: options.principal,
    harnessId: options.harnessId,
    builtins: options.builtins,
    ...(options.diagnostics ? { diagnostics: { onEvent: (event: { type: string; details?: Record<string, unknown> }) => options.diagnostics!(event.type, event.details) } } : {}),
  });
  try {
    await host.start();
  } catch (error) {
    await host.dispose().catch(() => undefined);
    throw error;
  }
  const bindings = host.getRuntimeBindings?.();
  if (!bindings) {
    await host.dispose().catch(() => undefined);
    throw new Error("The shared Marshal runtime host has no getRuntimeBindings(): packages/host predates the SDK host options.");
  }
  return {
    // Search goes through the host's own search(), which applies a session's extension scope; the rest is the kernel's.
    kernel: new Proxy(bindings.kernel, {
      get: (target, property) =>
        property === "search"
          ? (request: unknown, context: unknown) => host.search(request, context)
          : typeof target[property] === "function"
            ? target[property].bind(target)
            : target[property],
    }),
    core: bindings.core,
    resources: bindings.resources,
    lifecycle: bindings.lifecycle,
    serviceContainer: options.serviceContainer,
    stateRoot: bindings.stateRoot,
    installLocalExtension: async (packageRoot, configuration) => {
      const install = () =>
        host.installLocalExtension(packageRoot, undefined, configuration && typeof configuration === "object" ? { configuration } : undefined);
      try {
        return await install();
      } catch (error) {
        // The runtime's extension registry persists under its root (by default in the workspace), so a second host on
        // the same workspace (page-edit reopening a run, a check after a proof) finds it installed: replace it, so the
        // package and configuration this host was given are the ones that run.
        if ((error as { code?: unknown })?.code !== "ALREADY_INSTALLED") throw error;
        const identity = (JSON.parse(fs.readFileSync(path.join(packageRoot, "runtime-extension.json"), "utf8")) as { identity?: unknown }).identity;
        if (typeof identity !== "string") throw error;
        await host.removeExtension(identity);
        return install();
      }
    },
    dispose: () => host.dispose(),
  };
}
