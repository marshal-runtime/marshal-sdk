// Extract of zygstinct apps/agent-server/src/sandbox/ssh.ts at 7110e58c8: only shellQuote, SshRunner:declare, Exec, brandPaths.
import { type ChildProcess } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@zygstinct/marshal-sdk-port/agent-sdk";
import type { ConversationKey } from "../store.js";
import { type SshTarget } from "./ssh-target.js";

export const DEFAULT_BRANDS_ROOT = "/srv/zygstinct/brands";

/** Where a brand lives on its VM. */
export interface BrandPaths {
  home: string;
  work: string;
  repo: string;
  configDir: string;
  /** `.claude/projects`: the SDK session transcripts. */
  projects: string;
}

export function brandPaths(brandId: string, root: string = DEFAULT_BRANDS_ROOT): BrandPaths {
  const home = `${root}/${brandId}`;
  return { home, work: `${home}/work`, repo: `${home}/repo`, configDir: `${home}/.claude`, projects: `${home}/.claude/projects` };
}

export interface SshConfig {
  keyFile: string;
  knownHostsFile: string;
  /** Directory for the multiplexed control sockets used by short helper commands. */
  controlDir: string;
  /** The login user that may run `zs-brand-ensure`. */
  runnerUser: string;
  /** The pinned Claude Code binary on the VM. */
  claudeBin: string;
  /** Parent of the brand homes on the VM. */
  brandsRoot?: string;
  connectTimeoutS: number;
  /** Overrides the brand user (tests and the spike run as a fixed user). */
  userFor?: (brandId: string) => string;
  /** Root-owned stdin launcher installed by the chat-isolation image. */
  sessionLauncher?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The raw bytes of stdout, for binary streams (tar). */
  raw: Buffer;
}

/** Runs one command on a brand's VM as the brand user. The SSH runner and the tests' local runner both fit. */
export interface Exec {
  /** Local harnesses bind VM filesystem targets to their private fixture root. */
  validatePaths?(targets: readonly string[]): void;
  run(ip: SshTarget, brandId: string, command: string, options?: { stdin?: string | Buffer; timeoutMs?: number; chat?: ConversationKey }): Promise<ExecResult>;
  /**
   * Grants (true, renewing a 30 minute grant) or revokes (false) the per-turn data grant of one chat. `readSeq` (data-grant.ts `nextGrantRead`) orders the
   * fresh reads that decided it: a value from an older read than the last one written is not written (`superseded`).
   */
  bindKeyGrant?(ip: SshTarget, brandId: string, id: string, allow: boolean | "owner_report", readSeq?: number, keepWithinMs?: number): Promise<KeyGrantWrite>;
  /** Marks the chat an eval conversation on its sandbox (`zs-chat-eval`): from then on every login of that chat has the brand repo read-only. Never undone; a failure must fail the turn. */
  bindEval?(ip: SshTarget, brandId: string, id: string): Promise<void>;
  /** Opens the multiplexed masters of the brand user and of the chat user ahead of the commands that need them (a sandbox target only). Never rejects. */
  warmConnections?(ip: SshTarget, brandId: string, chat?: ConversationKey): Promise<void>;
}

/** What one grant bind did: wrote the value, kept a deny already in place, or skipped a value whose read is older than the last one written. */
export type KeyGrantWrite = "written" | "kept" | "superseded";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Where the Antigravity bridge on the VM sends its model calls: the model proxy through the session's tunnel, keyed by the session's proxy key.
 * The shape of marshal-sdk's AntigravityProxyEndpoint (`assertProxyEndpoint` refuses any other field, so no key or credential can be added here).
 */
export interface AntigravityEndpoint {
  kind: "proxy";
  api: "vertex";
  baseUrl: string;
  httpHeaders: Record<string, string>;
}

/** marshal-sdk's AntigravityBridgeSpawnRequest: what the SDK asks a remote bridge's spawner to start. */
export interface AntigravityBridgeSpawnRequest {
  sessionId: string;
  /** The SDK's bridge.py. Never sent to the VM: only its sha256, which the launcher compares with the root-owned install it runs. */
  bridgeSource: string;
  sdkVersion: string;
  protocol: number;
  /** Empty for a proxy endpoint; scrubbed of every Google setting anyway. */
  env: Record<string, string>;
}

/** A multiplexed master to a Daytona sandbox stays up this long idle (a sandbox idle-stop closes it explicitly), so every run of an awake sandbox reuses one relay connection. VM masters keep `ControlPersist=120`. */
const SANDBOX_MASTER_PERSIST_S = 3 * 3600;

/**
 * A session's ssh connection opened ahead of the session (`SshRunner.preconnect`). The chat launcher on the VM reads one stdin frame before it
 * does anything, so the connection and its launcher process only wait; the frame (environment, command, arguments) is written when the SDK asks
 * for the process (`spawner`). `take` hands the live child over once; `cancel` closes it when no session took it.
 */
export interface PreparedConnection {
  take(): (ChildProcess & SpawnedProcess) | null;
  cancel(): void;
  /** Settles when the ssh process has ended, whoever ended it. */
  readonly exited: Promise<void>;
}

export declare class SshRunner {
  private readonly ensured;
  private readonly chatEnsures;
  private readonly chatChecks;
  private readonly recoveries;
  private readonly keyGrants;
  /** One master open per sandbox target and user at a time: a command for that user waits for it instead of opening a second connection beside it. */
private readonly opens;
  private readonly masters;
  /** The clock of the master age check; tests move it. */
clock: () => number;
  private readonly keyGrantTails;
  /** Chats this process already marked as eval on a target (the mark is monotone, so a marked chat is never marked again) and the marks in flight. */
private readonly evalMarks;
  private readonly evalMarking;
  /** Per chat: the read order (`readSeq`) of the last grant value written. */
private readonly keyGrantReads;
  /** When each chat's installed value was written (this process's clock). */
private readonly keyGrantAt;
  private readonly config;
  constructor(config: SshConfig);
  paths(brandId: string, chat?: ConversationKey): BrandPaths;
  /** Runs a command as the brand's user, after making sure the user exists. */
run(ip: SshTarget, brandId: string, command: string, options?: { stdin?: string | Buffer; timeoutMs?: number; chat?: ConversationKey }): Promise<ExecResult>;
  user(brandId: string, chat?: string): string;
  /**
   * Forget that this brand's chats on this host were set up, so the next turn runs `zs-chat-ensure` again. A chat's tool settings (voice among them) are
   * written when it is set up, from the root-owned policies present then; a new sandbox restores its chats before the voice policy and token are pushed,
   * so those chats must be set up again once they are (found live 2026-11-10: every brief after an upgrade answered speech_not_enabled).
   */
forgetChats(ip: SshTarget, brandId: string): void;
  ensureChat(ip: SshTarget, brandId: string, id: string): Promise<void>;
  private ensureChatOnce;
  /**
   * Makes the chat's owner key grant (root-owned `chat-identities/<user>.keys.json`, read by zs-owner-grant.mjs) what this turn allows: `allow` only when
   * the caller derived from a fresh directory read that the turn is a direct chat of an active owner. An allow is sent every turn (it renews a
   * 30 minute grant); a deny already in place is not sent again. A failure is thrown and the value stays unknown: a turn must not run with a grant
   * that may be stale. Binds of one chat run one after the other, and newest read wins: a bind whose `readSeq` is older than the last value written
   * (a worker's read that a front turn's newer read overtook, MLY-543) writes nothing and answers `superseded`. A bind without `readSeq` always writes.
   * With `keepWithinMs`, a value equal to the one installed for this chat (by any writer of this process) and written less than that long ago is
   * `kept` without a write: a worker checks before every executing call (tasks/worker-grant.ts) and pays the SSH write only when the installed
   * value differs from its fresh read (another writer's deny, a re-enabled member) or is due for renewal.
   */
bindKeyGrant(ip: SshTarget, brandId: string, id: string, allow: boolean | "owner_report", readSeq?: number, keepWithinMs?: number): Promise<KeyGrantWrite>;
  /**
   * Marks the chat as an eval conversation on its sandbox through the fixed root helper `zs-chat-eval` (MLY-511): the root-owned, never removed
   * `chat-identities/<user>.eval` that `zs-landlock-login` reads at every login of the chat, the front turn's and its background workers', and answers
   * with a Landlock ruleset under which the brand repo cannot be created in, written, renamed in or out of, or deleted from (read stays). The helper
   * refuses on an image that cannot enforce it (no container-class login wrapper, an older snapshot), and so does this: a failure is thrown, never
   * swallowed, so an eval turn never runs with a writable brand repo. Called before the turn's first model-selected command and before any worker.
   * Single-flight per chat; a success is remembered for the process (the mark cannot be lifted, so there is nothing to renew).
   */
bindEval(ip: SshTarget, brandId: string, id: string): Promise<void>;
  /**
   * Installs the short-lived token of one brand's own brain service account on a VM through the fixed root helper `zs-brain-token`.
   * The token travels on stdin only: never in an argument, a log line or an error (the helper's output and ours carry fixed metadata).
   */
installBrainToken(ip: SshTarget, brandId: string, token: { accessToken: string; expireTime: string }): Promise<void>;
  /**
   * Installs the short-lived token of the brand's own service account (BigQuery, Cloud SQL) for a Daytona sandbox's metadata shim through the
   * fixed root helper `zs-metadata-token-install`. `{token, email, exp}` (exp in epoch seconds) travels on stdin only.
   */
installMetadataToken(ip: SshTarget, brandId: string, token: { token: string; email: string; exp: number }): Promise<void>;
  /**
   * Installs an audience-bound ID token of the brand's own account (`embed` for the embeddings proxy, `speech` for the speech proxy, `vision` for the embeddings service's vision route) on a Daytona
   * sandbox through the fixed root helper `zs-id-token-install`, which places it where the VM's timers do. The token travels on stdin only.
   */
installIdToken(ip: SshTarget, brandId: string, kind: "embed" | "speech" | "vision", token: { token: string }): Promise<void>;
  /**
   * When the token the VM holds for this brand expires (epoch ms), or null when it holds none: a rebooted VM has an empty /run, so the
   * pushing side asks instead of assuming. Empty stdin makes `zs-brain-token` answer read-only; the answer never carries the token.
   */
brainTokenExpiry(ip: SshTarget, brandId: string): Promise<number | null>;
  /**
   * The Brain environment of the host's root-owned broker policy, from the same read-only `zs-brain-token` status. A helper older than the env
   * label answers without it, which means production (its broker has no staging namespace); any other value is refused.
   */
brainHostEnv(ip: SshTarget, brandId: string): Promise<"production" | "staging">;
  /** ssh options shared by every connection. `multiplex` shares one connection between short helper commands. */
baseArgs(user: string, ip: SshTarget, multiplex: boolean): string[];
  private settled;
  /** Runs a command on the VM and collects its output. */
exec(ip: SshTarget, user: string, command: string, options?: { stdin?: string | Buffer; timeoutMs?: number; multiplex?: boolean }): Promise<ExecResult>;
  /**
   * Opens the master connection of the brand user and of the chat user of a sandbox target at the same time, so the two handshakes (about 3 s
   * each over the relay) overlap each other and the turn's other work instead of following one another. A user that already has a master
   * is left alone, a chat user is opened only when its account is known to exist, and the chat user's login also serves as the chat probe.
   * Best effort and never rejecting: a failed open leaves nothing behind (no entry in `masters`, so the next warm-up retries), and the next command for that user opens its own master as before.
   */
warmConnections(ip: SshTarget, brandId: string, chat?: ConversationKey): Promise<void>;
  private openMaster;
  private ageMaster;
  private signalMaster;
  /**
   * Lets one chat's multiplexed master to a sandbox end once its running sessions finish. A capture logs in as every chat of the brand in turn; each login
   * otherwise keeps its own relay connection for `SANDBOX_MASTER_PERSIST_S`, and a few hundred of them took the sandbox down. VM targets are untouched.
   */
closeChat(target: SshTarget, brandId: string, chat: ConversationKey): Promise<void>;
  /** Closes every multiplexed master this runner opened to a sandbox target (its idle stop or the server's shutdown); VM targets are untouched. */
closeConnections(target: SshTarget): Promise<void>;
  private execOnce;
  /** Runs one fixed provisioning command as the root-helper login (`zs-runner`); the gate on the VM accepts only known helpers. */
runAsRunner(ip: SshTarget, command: string, options: { stdin?: string; timeoutMs: number }): Promise<ExecResult>;
  private recoverProductManifest;
  private runRecovery;
  ensureBrand(ip: SshTarget, brandId: string): Promise<void>;
  /**
   * The `spawnClaudeCodeProcess` for one session: opens SSH to the brand's VM as the brand user, forwards the VM's
   * loopback port to the model proxy on this server, and starts the pinned Claude Code binary in the brand's work dir.
   */
spawner(input: {
    ip: SshTarget;
    brandId: string;
    chat?: ConversationKey;
    /** Port on the VM's loopback that reaches the proxy. */
    remotePort: number;
    /** The proxy's port on this server. */
    proxyPort: number;
    /** The per-session dummy API key; the proxy maps it to the session. */
    dummyKey: string;
    cwd?: string;
    configDir?: string;
    home?: string;
    /** A background worker's turn slot (`w` + 10 hex digits): its process reads its own snapshot file (zs-data-tools.mjs readTurn). */
    turnSlot?: string;
    /** A connection from `preconnect` for this same chat and ports: used instead of opening one when it is still alive. */
    prepared?: PreparedConnection | null;
  }): (options: SpawnOptions) => SpawnedProcess;
  /**
   * How the Marshal host reaches this chat's own runtime MCP server on the VM (marshal-sdk `remoteRuntime`, docs/remote-sessions.md): an ssh to
   * the chat's launcher, whose first stdin line is a `runtime` frame (identity env and the private cwd; no command: the launcher starts the VM's
   * pinned runtime server itself, chat-exec.py, VM feature `remote_runtime@1`), then the MCP stream both ways. A small sh writes the frame before
   * it hands its stdin to ssh, so the SDK's child is one process with plain stdio. With `tunnel` the ssh also forwards a VM loopback port to the
   * model proxy, as the session's own spawner does, so runtime tools that reach the server (browser.*: /zs/decide and /zs/browser/step) reach it under the session's key; the
   * port must be its own (the session's ssh holds the session's). The frame travels in the child's environment, never its argv, since it carries
   * that key.
   */
runtimeConnection(input: { ip: SshTarget; brandId: string; chat: ConversationKey; cwd?: string; turnSlot?: string; tunnel?: { remotePort: number; proxyPort: number; dummyKey: string } }): { command: string; args: string[]; env: Record<string, string> };
  /**
   * The Antigravity bridge (google-antigravity, Gemini on Vertex) of one chat session, run ON the brand VM as the chat user through the chat
   * launcher's `antigravity` frame (chat-exec.py pins the interpreter and the bridge; the frame names no command), over the same reverse tunnel a
   * Claude Code session uses. The VM gets no Google credential: the bridge's model endpoint is `endpoint` (a loopback base URL into the model proxy
   * and the session's proxy key as a header), and every Google credential setting is removed from the environment here and again by the launcher.
   * The proxy session must be opened with provider `vertex` (ModelProxy.open). A chat session only: the launcher refuses any other principal.
   */
antigravitySpawner(input: {
    ip: SshTarget;
    brandId: string;
    chat: ConversationKey;
    remotePort: number;
    proxyPort: number;
    /** The `vertex` proxy session's key. Sent to the bridge as a request header only, never in its environment. */
    dummyKey: string;
    cwd?: string;
    turnSlot?: string;
    prepared?: PreparedConnection | null;
  }): {
    endpoint: AntigravityEndpoint;
    /** marshal-sdk's AntigravityRemoteBridge.spawnBridge. */
    spawnBridge: (request: AntigravityBridgeSpawnRequest, signal?: AbortSignal) => ChildProcess;
    workspaceDir: string;
    homeDir: string;
  };
  private launcherCommand;
  private openSessionConnection;
  /**
   * Opens the ssh connection of a chat session now, before the session exists, so its handshake (about 3 s through a Daytona relay) overlaps the
   * rest of the turn's setup instead of following it. Only for a chat session on a Daytona sandbox (a VM's handshake costs nothing worth hiding), and
   * only once the chat's user exists (`ensureChat`). The remote launcher blocks reading its stdin frame, so nothing of the model's runs before the
   * frame is written; the bindings and the staged snapshot still precede it. Returns null when there is nothing to open.
   */
preconnect(input: { ip: SshTarget; brandId: string; chat: ConversationKey; remotePort: number; proxyPort: number }): PreparedConnection | null;
  /** Receives the ssh and Claude Code stderr of spawned sessions (set by the owner for logging). */
onStderr?: (brandId: string, text: string) => void;
}
