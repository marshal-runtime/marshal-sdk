import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { SpawnedProcess, SpawnOptions } from "@zygstinct/marshal-sdk-port/agent-sdk";
import { OperationError } from "../operation-error.js";
import type { ConversationKey } from "../store.js";
import { RECOVER_PRODUCT_MANIFEST } from "./product-store-script.js";
import { sshTargetArgs, targetKey, type SshTarget } from "./ssh-target.js";

/**
 * A turn slot names a run's own snapshot file (`.zs/turn.<slot>.json`) beside the chat's front turn: `w` + 10 for a background worker, `c` + 10 for the
 * outbox composer. The VM tells a composer run from its environment alone by the `c` (its gate refuses everything when that slot's snapshot cannot be read).
 */
export const TURN_SLOT = /^[wc][a-z0-9]{10}$/;
export const COMPOSER_TURN_SLOT = /^c[a-z0-9]{10}$/;

export const chatId = (key: ConversationKey): string => createHash("sha256").update(JSON.stringify([key.brandId.toLowerCase(), key.channel, key.conversationId])).digest("hex");
export const chatUser = (id: string): string => {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid chat id");
  return `c_${id.slice(0, 30)}`;
};

/** The brand's Unix user on a sandbox VM: `b_` plus the first 12 characters of the brand id without dashes. */
export const brandUser = (brandId: string): string => `b_${brandId.replaceAll("-", "").slice(0, 12)}`;
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

export function chatPaths(key: ConversationKey, root: string = DEFAULT_BRANDS_ROOT): BrandPaths {
  const home = `${path.posix.dirname(root)}/chats/${chatId(key)}`;
  return { home, work: `${home}/work`, repo: brandPaths(key.brandId, root).repo, configDir: `${home}/.claude`, projects: `${home}/.claude/projects` };
}

/** The folder name the SDK gives a working directory under `projects/`. */
export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

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

const SENSITIVE_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const PASS_EXACT = new Set(["DISABLE_AUTOUPDATER", "CLAUDE_CODE_ENTRYPOINT", "MCP_TOOL_TIMEOUT", "MCP_TIMEOUT", "MAX_THINKING_TOKENS", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]);
const PASS_PREFIX = ["CLAUDE_AGENT_SDK_", "DISABLE_", "CLAUDE_CODE_DISABLE_", "CLAUDE_CODE_SDK_"];

/** The environment the model's process gets on the VM: SDK plumbing only. Nothing that looks like a credential, nothing of the server's. */
export function remoteEnv(sdkEnv: Record<string, string | undefined>, fixed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sdkEnv)) {
    if (value === undefined || SENSITIVE_NAME.test(name)) continue;
    if (PASS_EXACT.has(name) || PASS_PREFIX.some((prefix) => name.startsWith(prefix))) out[name] = value;
  }
  return { ...out, ...fixed };
}

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

/** The google-antigravity version installed on the VM (image/antigravity/requirements.txt). */
export const ANTIGRAVITY_SDK_VERSION = "0.1.24";

/**
 * Settings google-antigravity, google-genai and the Google auth libraries read a credential, project or Vertex switch from. None may reach a VM
 * process: the bridge's endpoint carries its own base URL, and with one set the SDK reads no ambient project or credential.
 */
export const GOOGLE_CREDENTIAL_ENV = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_ENTERPRISE",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "CLOUDSDK_CORE_PROJECT",
  "GCLOUD_PROJECT",
  "GCE_METADATA_HOST",
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
  "VERTEX_ADC_FILE",
] as const;
const GOOGLE_ENV_NAMES = new Set<string>(GOOGLE_CREDENTIAL_ENV);

/** The Antigravity bridge's environment on the VM: remoteEnv's SDK plumbing and the fixed identity, minus every Google setting (also from `fixed`). */
export function antigravityEnv(sdkEnv: Record<string, string | undefined>, fixed: Record<string, string>): Record<string, string> {
  const env = remoteEnv(sdkEnv, fixed);
  for (const name of Object.keys(env)) if (GOOGLE_ENV_NAMES.has(name) || /^(GOOGLE|GCLOUD|CLOUDSDK|VERTEX|GEMINI)_/.test(name)) delete env[name];
  return env;
}

const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long an account that was just set up or answered a login counts as present without another look. */
const CHAT_RECENT_MS = 10_000;
const CHAT_PROBE_INTERVAL_MS = 60_000;
/** A multiplexed master to a Daytona sandbox stays up this long idle (a sandbox idle-stop closes it explicitly), so every run of an awake sandbox reuses one relay connection. VM masters keep `ControlPersist=120`. */
const SANDBOX_MASTER_PERSIST_S = 3 * 3600;
/** The relay's signed URL lives 4 h and Daytona closes the socket when it lapses (zs-ws-connect.ts): a master older than this is told to stop and the next run opens a fresh one before that happens. */
const SANDBOX_MASTER_MAX_AGE_MS = 3.5 * 3600_000;
/** A connection opened ahead of its session that nobody used is closed after this long (the turn that opened it normally takes it within seconds). */
const PRECONNECT_MAX_IDLE_MS = 120_000;
const MISSING_CHAT_ACCOUNT = /(?:Permission denied \(publickey\)|Invalid user\b)/i;

/** The user name `zs-brand-ensure` prints in its JSON report, or null when the output is not that report. */
function parseEnsureReport(stdout: string): string | null {
  try {
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { user?: unknown };
    return typeof report.user === "string" ? report.user : null;
  } catch {
    return null;
  }
}

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

/**
 * A sandbox without a GCE metadata server (a Daytona one) serves the machine token from a loopback shim whose address is in /etc/zygstinct/metadata-host.
 * A chat user's login shell has no GCE_METADATA_HOST (only the chat's own tools get it from zs-chat-ensure), so a recipe the server starts over ssh
 * (store watch, owner reports, ahead) asked 169.254.169.254, got "fetch failed" and reported "watch failed". Only a loopback host:port is taken from the file.
 */
const SANDBOX_METADATA_HOST_PREFIX = `h=$(sed -n '/^127\\.0\\.0\\.1:[0-9]\\{2,5\\}$/p' /etc/zygstinct/metadata-host 2>/dev/null); [ -n "$h" ] && export GCE_METADATA_HOST="$h"; `;

export class SshRunner {
  private readonly ensured = new Set<string>();
  private readonly chatEnsures = new Map<string, Promise<void>>();
  private readonly chatChecks = new Map<string, { at: number; error?: Error }>();
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly keyGrants = new Map<string, "allow" | "allow-report" | "deny">();
  /** One master open per sandbox target and user at a time: a command for that user waits for it instead of opening a second connection beside it. */
  private readonly opens = new Map<string, Promise<void>>();
  private readonly masters = new Map<string, { target: Exclude<SshTarget, string>; user: string; born: number }>();
  /** The clock of the master age check; tests move it. */
  clock: () => number = Date.now;
  private readonly keyGrantTails = new Map<string, Promise<unknown>>();
  /** Chats this process already marked as eval on a target (the mark is monotone, so a marked chat is never marked again) and the marks in flight. */
  private readonly evalMarks = new Set<string>();
  private readonly evalMarking = new Map<string, Promise<void>>();
  /** Per chat: the read order (`readSeq`) of the last grant value written. */
  private readonly keyGrantReads = new Map<string, number>();
  /** When each chat's installed value was written (this process's clock). */
  private readonly keyGrantAt = new Map<string, number>();

  constructor(private readonly config: SshConfig) {}

  paths(brandId: string, chat?: ConversationKey): BrandPaths {
    return chat ? chatPaths(chat, this.config.brandsRoot) : brandPaths(brandId, this.config.brandsRoot);
  }

  /** Runs a command as the brand's user, after making sure the user exists. */
  async run(ip: SshTarget, brandId: string, command: string, options: { stdin?: string | Buffer; timeoutMs?: number; chat?: ConversationKey } = {}): Promise<ExecResult> {
    const chat = options.chat ? chatId(options.chat) : undefined;
    if (chat) await this.ensureChat(ip, brandId, chat);
    else await this.ensureBrand(ip, brandId);
    const result = await this.exec(ip, this.user(brandId, chat), typeof ip === "string" ? command : `${SANDBOX_METADATA_HOST_PREFIX}${command}`, options);
    if (chat && result.code === 255 && MISSING_CHAT_ACCOUNT.test(result.stderr)) this.chatChecks.delete(`${targetKey(ip)}|${brandId}|${chat}`);
    return result;
  }

  user(brandId: string, chat?: string): string {
    return this.config.userFor?.(brandId) ?? (chat ? chatUser(chat) : brandUser(brandId));
  }

  /**
   * Forget that this brand's chats on this host were set up, so the next turn runs `zs-chat-ensure` again. A chat's tool settings (voice among them) are
   * written when it is set up, from the root-owned policies present then; a new sandbox restores its chats before the voice policy and token are pushed,
   * so those chats must be set up again once they are (found live 2026-11-10: every brief after an upgrade answered speech_not_enabled).
   */
  forgetChats(ip: SshTarget, brandId: string): void {
    const prefix = `${targetKey(ip)}|${brandId}|`;
    for (const key of [...this.ensured]) if (key.startsWith(prefix)) this.ensured.delete(key);
    for (const key of [...this.chatChecks.keys()]) if (key.startsWith(prefix)) this.chatChecks.delete(key);
  }

  async ensureChat(ip: SshTarget, brandId: string, id: string): Promise<void> {
    if (this.config.userFor) return;
    if (!BRAND_ID.test(brandId) || !/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid chat identity");
    const key = `${targetKey(ip)}|${brandId}|${id}`;
    const pending = this.chatEnsures.get(key);
    if (pending) return pending;
    const work = this.ensureChatOnce(ip, brandId, id, key).finally(() => this.chatEnsures.delete(key));
    this.chatEnsures.set(key, work);
    return work;
  }

  private async ensureChatOnce(ip: SshTarget, brandId: string, id: string, key: string): Promise<void> {
    if (this.ensured.has(key)) {
      // The account was set up or answered a login a moment ago: nothing to wait for. A caller that only needs the account to exist (the root bindings run as the runner) must not sit behind the chat user's own connection handshake.
      const recent = this.chatChecks.get(key);
      if (recent && !recent.error && Date.now() - recent.at < CHAT_RECENT_MS) return;
      // A master being opened for this chat user is that probe: wait for it, then see whether it answered.
      if (typeof ip !== "string") await this.settled(this.opens.get(`${ip.alias}|${this.user(brandId, id)}`), 15_000);
      const checked = this.chatChecks.get(key);
      if (checked && Date.now() - checked.at < CHAT_PROBE_INTERVAL_MS) {
        if (checked.error) throw checked.error;
        return;
      }
      let login: ExecResult;
      try { login = await this.exec(ip, this.user(brandId, id), "true", { timeoutMs: 15_000 }); } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.chatChecks.set(key, { at: Date.now(), error: failure });
        throw failure;
      }
      if (login.code === 0) { this.chatChecks.set(key, { at: Date.now() }); return; }
      if (login.code !== 255 || !MISSING_CHAT_ACCOUNT.test(login.stderr)) {
        const error = new OperationError("ssh", login.code);
        this.chatChecks.set(key, { at: Date.now(), error });
        throw error;
      }
      // A rebuilt boot disk can lose passwd while keeping the IP and data. Retry setup, never the caller's command.
      this.ensured.delete(key);
      const brandKey = `${targetKey(ip)}|${brandId}`;
      this.ensured.delete(brandKey);
      this.recoveries.delete(brandKey);
    }
    await this.recoverProductManifest(ip, brandId);
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-chat-ensure ${brandId} ${id}`, { timeoutMs: 60_000 });
    if (result.code !== 0) throw new OperationError("brand_ensure", result.code);
    let report: { user?: unknown; chatId?: unknown; brandId?: unknown; home?: unknown; isolationVersion?: unknown; toolsExecution?: unknown };
    try { report = JSON.parse(result.stdout.trim().split("\n").pop() ?? ""); } catch { throw new Error("chat isolation image required"); }
    const home = `${path.posix.dirname(this.config.brandsRoot ?? DEFAULT_BRANDS_ROOT)}/chats/${id}`;
    if (report.user !== chatUser(id) || report.chatId !== id || report.brandId !== brandId || report.home !== home || report.isolationVersion !== 1 || report.toolsExecution !== "sandbox-v1") throw new Error("chat isolation image required");
    this.ensured.add(key);
    this.chatChecks.set(key, { at: Date.now() });
  }

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
  async bindKeyGrant(ip: SshTarget, brandId: string, id: string, allow: boolean | "owner_report", readSeq?: number, keepWithinMs?: number): Promise<KeyGrantWrite> {
    if (this.config.userFor) return "kept";
    if (!BRAND_ID.test(brandId) || !/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid key grant");
    await this.ensureChat(ip, brandId, id);
    const key = `${targetKey(ip)}|${brandId}|${id}`;
    const wanted = allow === "owner_report" ? "allow-report" : allow ? "allow" : "deny";
    const run = async (): Promise<KeyGrantWrite> => {
      const last = this.keyGrantReads.get(key);
      if (readSeq !== undefined && last !== undefined && readSeq < last) return "superseded";
      const installed = this.keyGrants.get(key);
      const young = keepWithinMs !== undefined && this.clock() - (this.keyGrantAt.get(key) ?? Number.NEGATIVE_INFINITY) < keepWithinMs;
      if (installed === wanted && (wanted === "deny" || young)) {
        if (readSeq !== undefined) this.keyGrantReads.set(key, Math.max(readSeq, last ?? readSeq));
        return "kept";
      }
      this.keyGrants.delete(key);
      const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-brand-key-grant ${brandId} ${id} ${wanted}`, { timeoutMs: 30_000 });
      if (result.code !== 0) throw new OperationError("key_grant", result.code);
      this.keyGrants.set(key, wanted);
      this.keyGrantAt.set(key, this.clock());
      if (readSeq !== undefined) this.keyGrantReads.set(key, Math.max(readSeq, last ?? readSeq));
      return "written";
    };
    const turn = (this.keyGrantTails.get(key) ?? Promise.resolve()).then(run, run);
    this.keyGrantTails.set(key, turn.catch(() => undefined));
    return turn;
  }

  /**
   * Marks the chat as an eval conversation on its sandbox through the fixed root helper `zs-chat-eval` (MLY-511): the root-owned, never removed
   * `chat-identities/<user>.eval` that `zs-landlock-login` reads at every login of the chat, the front turn's and its background workers', and answers
   * with a Landlock ruleset under which the brand repo cannot be created in, written, renamed in or out of, or deleted from (read stays). The helper
   * refuses on an image that cannot enforce it (no container-class login wrapper, an older snapshot), and so does this: a failure is thrown, never
   * swallowed, so an eval turn never runs with a writable brand repo. Called before the turn's first model-selected command and before any worker.
   * Single-flight per chat; a success is remembered for the process (the mark cannot be lifted, so there is nothing to renew).
   */
  async bindEval(ip: SshTarget, brandId: string, id: string): Promise<void> {
    if (this.config.userFor) return;
    if (!BRAND_ID.test(brandId) || !/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid eval mark");
    const key = `${targetKey(ip)}|${brandId}|${id}`;
    if (this.evalMarks.has(key)) return;
    const pending = this.evalMarking.get(key);
    if (pending) return pending;
    const run = (async (): Promise<void> => {
      await this.ensureChat(ip, brandId, id);
      const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-chat-eval ${brandId} ${id}`, { timeoutMs: 30_000 });
      if (result.code !== 0) throw new OperationError("chat_eval", result.code);
      this.evalMarks.add(key);
    })().finally(() => this.evalMarking.delete(key));
    this.evalMarking.set(key, run);
    return run;
  }

  /**
   * Installs the short-lived token of one brand's own brain service account on a VM through the fixed root helper `zs-brain-token`.
   * The token travels on stdin only: never in an argument, a log line or an error (the helper's output and ours carry fixed metadata).
   */
  async installBrainToken(ip: SshTarget, brandId: string, token: { accessToken: string; expireTime: string }): Promise<void> {
    if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid brain token target");
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-brain-token ${brandId}`, { stdin: JSON.stringify({ accessToken: token.accessToken, expireTime: token.expireTime }), timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError("brain_token", result.code);
  }

  /**
   * Installs the short-lived token of the brand's own service account (BigQuery, Cloud SQL) for a Daytona sandbox's metadata shim through the
   * fixed root helper `zs-metadata-token-install`. `{token, email, exp}` (exp in epoch seconds) travels on stdin only.
   */
  async installMetadataToken(ip: SshTarget, brandId: string, token: { token: string; email: string; exp: number }): Promise<void> {
    if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid metadata token target");
    if (!Number.isSafeInteger(token.exp)) throw new Error("invalid metadata token expiry");
    const result = await this.exec(ip, this.config.runnerUser, "sudo /usr/local/sbin/zs-metadata-token-install", { stdin: JSON.stringify({ token: token.token, email: token.email, exp: token.exp }), timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError("metadata_token", result.code);
  }

  /**
   * Installs an audience-bound ID token of the brand's own account (`embed` for the embeddings proxy, `speech` for the speech proxy, `vision` for the embeddings service's vision route) on a Daytona
   * sandbox through the fixed root helper `zs-id-token-install`, which places it where the VM's timers do. The token travels on stdin only.
   */
  async installIdToken(ip: SshTarget, brandId: string, kind: "embed" | "speech" | "vision", token: { token: string }): Promise<void> {
    if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid id token target");
    if (kind !== "embed" && kind !== "speech" && kind !== "vision") throw new Error("invalid id token kind");
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-id-token-install ${brandId} ${kind}`, { stdin: JSON.stringify({ idToken: token.token }), timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError(`${kind}_token`, result.code);
  }

  /**
   * When the token the VM holds for this brand expires (epoch ms), or null when it holds none: a rebooted VM has an empty /run, so the
   * pushing side asks instead of assuming. Empty stdin makes `zs-brain-token` answer read-only; the answer never carries the token.
   */
  async brainTokenExpiry(ip: SshTarget, brandId: string): Promise<number | null> {
    if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid brain token target");
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-brain-token ${brandId}`, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError("brain_token", result.code);
    try {
      const answer = JSON.parse(result.stdout) as { present?: unknown; expiresAt?: unknown };
      return answer.present === true && typeof answer.expiresAt === "number" && Number.isFinite(answer.expiresAt) ? answer.expiresAt : null;
    } catch {
      throw new OperationError("brain_token", result.code);
    }
  }

  /**
   * The Brain environment of the host's root-owned broker policy, from the same read-only `zs-brain-token` status. A helper older than the env
   * label answers without it, which means production (its broker has no staging namespace); any other value is refused.
   */
  async brainHostEnv(ip: SshTarget, brandId: string): Promise<"production" | "staging"> {
    if (!BRAND_ID.test(brandId) || brandId !== brandId.toLowerCase()) throw new Error("invalid brain token target");
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-brain-token ${brandId}`, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError("brain_token", result.code);
    let env: unknown;
    try { env = (JSON.parse(result.stdout) as { env?: unknown }).env; } catch { throw new OperationError("brain_token", result.code); }
    if (env === undefined || env === "production") return "production";
    if (env === "staging") return "staging";
    throw new OperationError("brain_token", result.code);
  }

  /** ssh options shared by every connection. `multiplex` shares one connection between short helper commands. */
  baseArgs(user: string, ip: SshTarget, multiplex: boolean): string[] {
    const args = [
      "-i", this.config.keyFile,
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      ...sshTargetArgs(ip),
      "-o", `UserKnownHostsFile=${this.config.knownHostsFile}`,
      "-o", `ConnectTimeout=${this.config.connectTimeoutS}`,
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=4",
      "-o", "LogLevel=ERROR",
    ];
    if (multiplex) {
      args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${path.join(this.config.controlDir, "%C")}`, "-o", `ControlPersist=${typeof ip === "string" ? 120 : SANDBOX_MASTER_PERSIST_S}`);
    }
    args.push(`${user}@${typeof ip === "string" ? ip : ip.alias}`);
    return args;
  }

  /** Waits for an in-flight master open (which never rejects), but no longer than `ms` when given: a caller's own bound also covers the wait behind a stalled open. */
  private async settled(open: Promise<void> | undefined, ms: number | undefined): Promise<void> {
    if (!open) return;
    if (ms === undefined) { await open; return; }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([open, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]); } finally { clearTimeout(timer); }
  }

  /** Runs a command on the VM and collects its output. */
  async exec(ip: SshTarget, user: string, command: string, options: { stdin?: string | Buffer; timeoutMs?: number; multiplex?: boolean } = {}): Promise<ExecResult> {
    if (typeof ip !== "string" && (options.multiplex ?? true)) {
      await this.settled(this.opens.get(`${ip.alias}|${user}`), options.timeoutMs);
      await this.ageMaster(ip, user);
    }
    return this.execOnce(ip, user, command, options);
  }

  /**
   * Opens the master connection of the brand user and of the chat user of a sandbox target at the same time, so the two handshakes (about 3 s
   * each over the relay) overlap each other and the turn's other work instead of following one another. A user that already has a master
   * is left alone, a chat user is opened only when its account is known to exist, and the chat user's login also serves as the chat probe.
   * Best effort and never rejecting: a failed open leaves nothing behind (no entry in `masters`, so the next warm-up retries), and the next command for that user opens its own master as before.
   */
  async warmConnections(ip: SshTarget, brandId: string, chat?: ConversationKey): Promise<void> {
    if (typeof ip === "string" || this.config.userFor || !BRAND_ID.test(brandId)) return;
    const jobs: Promise<void>[] = [];
    if (this.ensured.has(`${targetKey(ip)}|${brandId}`)) jobs.push(this.openMaster(ip, this.user(brandId)));
    const id = chat ? chatId(chat) : null;
    const chatKey = id ? `${targetKey(ip)}|${brandId}|${id}` : null;
    if (id && chatKey) {
      // A chat that does not exist yet is set up now, beside the rest of the turn's routing, and its connection opened right after: the account setup and the 3 s handshake
      // are the first things a new conversation waits for. The turn runs the same setup (and shares this call) whatever happens here.
      const open = (): Promise<void> => this.openMaster(ip, this.user(brandId, id), (code) => { if (code === 0) this.chatChecks.set(chatKey, { at: Date.now() }); });
      jobs.push(this.ensured.has(chatKey) ? open() : this.ensureChat(ip, brandId, id).then(open, () => undefined));
    }
    await Promise.all(jobs);
  }

  private openMaster(target: Exclude<SshTarget, string>, user: string, done?: (code: number | null) => void): Promise<void> {
    const key = `${target.alias}|${user}`;
    if (this.masters.has(key)) return this.opens.get(key) ?? Promise.resolve();
    const open = this.ageMaster(target, user)
      .then(async () => {
        const entry = this.masters.get(key);
        const forget = (): void => { if (this.masters.get(key) === entry) this.masters.delete(key); };
        try {
          const result = await this.execOnce(target, user, "true", { timeoutMs: 20_000 });
          if (result.code !== 0) forget();
          done?.(result.code);
        } catch { forget(); }
      })
      .catch(() => undefined)
      .finally(() => { if (this.opens.get(key) === open) this.opens.delete(key); });
    this.opens.set(key, open);
    return open;
  }

  /** Tells the master of a sandbox target that has been up past `SANDBOX_MASTER_MAX_AGE_MS` (its relay URL is about to lapse) to stop taking runs, and starts counting the next one. */
  private async ageMaster(target: Exclude<SshTarget, string>, user: string): Promise<void> {
    const key = `${target.alias}|${user}`;
    const known = this.masters.get(key);
    if (known && this.clock() - known.born > SANDBOX_MASTER_MAX_AGE_MS) {
      this.masters.delete(key);
      await this.signalMaster(known.target, known.user, "stop");
    }
    if (!this.masters.has(key)) this.masters.set(key, { target, user, born: this.clock() });
  }

  /**
   * Asks one multiplexed master to `stop` (no new runs; it exits when its running ones finish, so a long run across the age limit is not cut) or `exit`
   * (now, for an idle stop or shutdown). Best effort, 5 s bound; a master that is not there is not an error.
   */
  private signalMaster(target: Exclude<SshTarget, string>, user: string, verb: "stop" | "exit"): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn("ssh", ["-O", verb, ...this.baseArgs(user, target, true)], { stdio: "ignore" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const done = (): void => { clearTimeout(timer); resolve(); };
      child.on("error", done);
      child.on("close", done);
    });
  }

  /**
   * Lets one chat's multiplexed master to a sandbox end once its running sessions finish. A capture logs in as every chat of the brand in turn; each login
   * otherwise keeps its own relay connection for `SANDBOX_MASTER_PERSIST_S`, and a few hundred of them took the sandbox down. VM targets are untouched.
   */
  async closeChat(target: SshTarget, brandId: string, chat: ConversationKey): Promise<void> {
    if (typeof target === "string") return;
    const user = this.user(brandId, chatId(chat));
    if (!this.masters.delete(`${target.alias}|${user}`)) return;
    await this.signalMaster(target, user, "stop");
  }

  /** Closes every multiplexed master this runner opened to a sandbox target (its idle stop or the server's shutdown); VM targets are untouched. */
  async closeConnections(target: SshTarget): Promise<void> {
    if (typeof target === "string") return;
    const mine = [...this.masters.entries()].filter(([, master]) => master.target.alias === target.alias);
    for (const [key] of mine) this.masters.delete(key);
    await Promise.all(mine.map(([, master]) => this.signalMaster(master.target, master.user, "exit")));
  }

  private execOnce(ip: SshTarget, user: string, command: string, options: { stdin?: string | Buffer; timeoutMs?: number; multiplex?: boolean } = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", ["-T", ...this.baseArgs(user, ip, options.multiplex ?? true), command], { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : null;
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const raw = Buffer.concat(out);
        resolve({ code, stdout: raw.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), raw });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    });
  }

  /** Runs one fixed provisioning command as the root-helper login (`zs-runner`); the gate on the VM accepts only known helpers. */
  runAsRunner(ip: SshTarget, command: string, options: { stdin?: string; timeoutMs: number }): Promise<ExecResult> {
    return this.exec(ip, this.config.runnerUser, command, options);
  }

  /** Creates the brand's user and home on the VM once per process (the only sudo rule of the login user). */
  /**
   * Before the root chat setup, which refuses an unsafe `memory/products/.zs-generated.json` and so would fail every chat of the brand: the
   * maintenance identity (never a chat identity) replaces an unusable ownership manifest with a trusted empty one. It adopts and deletes no
   * note and leaves the root refusal as it is. Best effort: a refusal here (the folder belongs to someone else) is left to the root setup to
   * report. One recovery at a time per host and brand: concurrent first chats share the pending run, a finished run is not repeated, and a failed or refused one is tried again by the next chat. Across servers and runner instances the script takes the maintenance-owned brand lock that the product writer also takes, holds it across its read and its rename, and drops its write if the manifest changed after it read it (exit 12) or an older lock-less writer is running; either way the next chat retries.
   */
  private recoverProductManifest(ip: SshTarget, brandId: string): Promise<void> {
    const key = `${targetKey(ip)}|${brandId}`;
    const running = this.recoveries.get(key);
    if (running) return running;
    const run = this.runRecovery(ip, brandId).then(
      (finished) => {
        if (!finished) this.recoveries.delete(key);
      },
      (error) => {
        this.recoveries.delete(key);
        throw error;
      },
    );
    this.recoveries.set(key, run);
    return run;
  }

  /** True when the recovery finished (exit 0); any other outcome leaves the next call to try again. */
  private async runRecovery(ip: SshTarget, brandId: string): Promise<boolean> {
    await this.ensureBrand(ip, brandId);
    const repo = brandPaths(brandId, this.config.brandsRoot).repo;
    const result = await this.exec(ip, this.user(brandId), `python3 -I -c ${shellQuote(RECOVER_PRODUCT_MANIFEST)} ${shellQuote(repo)}`, { timeoutMs: 15_000 });
    if (result.code === 255) throw new OperationError("brand_ensure", result.code);
    return result.code === 0;
  }

  async ensureBrand(ip: SshTarget, brandId: string): Promise<void> {
    if (this.config.userFor) return;
    if (!BRAND_ID.test(brandId)) throw new Error(`invalid brand id '${brandId.slice(0, 40)}'`);
    const key = `${targetKey(ip)}|${brandId}`;
    if (this.ensured.has(key)) return;
    // The runner login only accepts this exact command line, so the (validated) id is not quoted.
    const result = await this.exec(ip, this.config.runnerUser, `sudo /usr/local/sbin/zs-brand-ensure ${brandId}`, { timeoutMs: 30_000 });
    if (result.code !== 0) throw new OperationError("brand_ensure", result.code);
    const reported = parseEnsureReport(result.stdout);
    if (reported && reported !== brandUser(brandId)) throw new Error(`zs-brand-ensure ${brandId} reported user ${reported}, expected ${brandUser(brandId)}`);
    this.ensured.add(key);
  }

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
  }): (options: SpawnOptions) => SpawnedProcess {
    const { brandId } = input;
    return (options) => {
      const paths = this.paths(brandId, input.chat);
      const cwd = input.cwd ?? options.cwd ?? paths.work;
      const configDir = input.configDir ?? paths.configDir;
      const home = input.home ?? paths.home;
      const env = remoteEnv(options.env, {
        HOME: home,
        ZS_BRAND_ID: brandId,
        ZS_REPO_DIR: paths.repo,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${input.remotePort}`,
        ANTHROPIC_API_KEY: input.dummyKey,
        ...(input.turnSlot && TURN_SLOT.test(input.turnSlot) ? { ZS_TURN_SLOT: input.turnSlot } : {}),
        ...(input.chat ? { ZS_CHAT_ID: chatId(input.chat), ZS_VM_USER: this.user(brandId, chatId(input.chat)), ZS_CONVERSATION_ID: input.chat.conversationId, ZS_CHANNEL: input.chat.channel, ZS_SHARED_REPO: paths.repo } : {}),
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
      const runsScript = /(^|\/)(node|bun)$/.test(options.command);
      const args = runsScript ? options.args.slice(1) : options.args;
      const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`);
      const remote = input.chat ? this.launcherCommand() : [
        `mkdir -p ${shellQuote(cwd)} ${shellQuote(configDir)}`,
        `cd ${shellQuote(cwd)}`,
        `exec env -i ${assignments.join(" ")} ${shellQuote(this.config.claudeBin)} ${args.map(shellQuote).join(" ")}`,
      ].join(" && ");
      const child = (input.chat ? input.prepared?.take() : null) ?? this.openSessionConnection(input, remote);
      if (input.chat) child.stdin!.write(JSON.stringify({ env, cwd, command: this.config.claudeBin, args }) + "\n");
      options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      return child;
    };
  }

  /**
   * How the Marshal host reaches this chat's own runtime MCP server on the VM (marshal-sdk `remoteRuntime`, docs/remote-sessions.md): an ssh to
   * the chat's launcher, whose first stdin line is a `runtime` frame (identity env and the private cwd; no command: the launcher starts the VM's
   * pinned runtime server itself, chat-exec.py, VM feature `remote_runtime@1`), then the MCP stream both ways. A small sh writes the frame before
   * it hands its stdin to ssh, so the SDK's child is one process with plain stdio. With `tunnel` the ssh also forwards a VM loopback port to the
   * model proxy, as the session's own spawner does, so runtime tools that reach the server (browser.*: /zs/decide and /zs/browser/step) reach it under the session's key; the
   * port must be its own (the session's ssh holds the session's). The frame travels in the child's environment, never its argv, since it carries
   * that key.
   */
  runtimeConnection(input: { ip: SshTarget; brandId: string; chat: ConversationKey; cwd?: string; turnSlot?: string; tunnel?: { remotePort: number; proxyPort: number; dummyKey: string } }): { command: string; args: string[]; env: Record<string, string> } {
    const paths = this.paths(input.brandId, input.chat);
    const chat = chatId(input.chat);
    const env: Record<string, string> = {
      HOME: paths.home,
      ZS_BRAND_ID: input.brandId,
      ZS_REPO_DIR: paths.repo,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ...(input.turnSlot && TURN_SLOT.test(input.turnSlot) ? { ZS_TURN_SLOT: input.turnSlot } : {}),
      ZS_CHAT_ID: chat,
      ZS_VM_USER: this.user(input.brandId, chat),
      ZS_CONVERSATION_ID: input.chat.conversationId,
      ZS_CHANNEL: input.chat.channel,
      ZS_SHARED_REPO: paths.repo,
      ...(input.tunnel ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${input.tunnel.remotePort}`, ANTHROPIC_API_KEY: input.tunnel.dummyKey } : {}),
    };
    const frame = JSON.stringify({ kind: "runtime", env, cwd: input.cwd ?? paths.work });
    const forward = input.tunnel ? ["-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${input.tunnel.remotePort}:127.0.0.1:${input.tunnel.proxyPort}`] : [];
    const ssh = ["ssh", "-T", ...forward, ...this.baseArgs(this.user(input.brandId, chat), input.ip, false), this.launcherCommand()];
    // The MCP client gives the child only the environment it is handed: the usual login names, plus the frame.
    const base = Object.fromEntries(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
    return { command: "/bin/sh", args: ["-c", `{ printf '%s\\n' "$ZS_RUNTIME_FRAME"; exec cat; } | exec "$@"`, "zs-runtime", ...ssh], env: { ...base, ZS_RUNTIME_FRAME: frame } };
  }

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
  } {
    if (!Number.isInteger(input.remotePort) || input.remotePort < 1024 || input.remotePort > 65535) throw new Error("invalid tunnel port");
    const endpoint: AntigravityEndpoint = { kind: "proxy", api: "vertex", baseUrl: `http://127.0.0.1:${input.remotePort}/vertex`, httpHeaders: { "x-zs-session-key": input.dummyKey } };
    const paths = this.paths(input.brandId, input.chat);
    const workspaceDir = input.cwd ?? paths.work;
    return {
      endpoint,
      workspaceDir,
      // Conversations and harness data stay in the chat's own home (per-chat UID, not the brand repo).
      homeDir: path.posix.join(paths.home, ".antigravity"),
      spawnBridge: (request, signal) => {
        if (request.sdkVersion !== ANTIGRAVITY_SDK_VERSION) throw new Error(`the brand VM has google-antigravity ${ANTIGRAVITY_SDK_VERSION}, not ${String(request.sdkVersion).slice(0, 20)}`);
        if (typeof request.bridgeSource !== "string" || !request.bridgeSource) throw new Error("the antigravity bridge source is missing");
        const bridgeSha256 = createHash("sha256").update(request.bridgeSource, "utf8").digest("hex");
        const chat = chatId(input.chat);
        const env = antigravityEnv(request.env ?? {}, {
          HOME: paths.home,
          ZS_BRAND_ID: input.brandId,
          ZS_REPO_DIR: paths.repo,
          PATH: "/usr/local/bin:/usr/bin:/bin",
          ...(input.turnSlot && TURN_SLOT.test(input.turnSlot) ? { ZS_TURN_SLOT: input.turnSlot } : {}),
          ZS_CHAT_ID: chat,
          ZS_VM_USER: this.user(input.brandId, chat),
          ZS_CONVERSATION_ID: input.chat.conversationId,
          ZS_CHANNEL: input.chat.channel,
          ZS_SHARED_REPO: paths.repo,
        });
        const child = input.prepared?.take() ?? this.openSessionConnection(input, this.launcherCommand());
        child.stdin!.write(JSON.stringify({ kind: "antigravity", bridgeSha256, env, cwd: workspaceDir }) + "\n");
        signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        return child;
      },
    };
  }

  private launcherCommand(): string {
    return `exec /usr/bin/python3 -I ${shellQuote(this.config.sessionLauncher ?? "/usr/local/lib/zygstinct/chat-exec.py")}`;
  }

  /** The ssh process of one session: the reverse tunnel to the model proxy and the remote command. Its stderr goes to `onStderr`. */
  private openSessionConnection(input: { ip: SshTarget; brandId: string; chat?: ConversationKey; remotePort: number; proxyPort: number }, remote: string): ChildProcess & SpawnedProcess {
    const child = spawn(
      "ssh",
      ["-T", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${input.remotePort}:127.0.0.1:${input.proxyPort}`, ...this.baseArgs(this.user(input.brandId, input.chat ? chatId(input.chat) : undefined), input.ip, false), remote],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk: Buffer) => this.onStderr?.(input.brandId, chunk.toString("utf8")));
    return child as ChildProcess & SpawnedProcess;
  }

  /**
   * Opens the ssh connection of a chat session now, before the session exists, so its handshake (about 3 s through a Daytona relay) overlaps the
   * rest of the turn's setup instead of following it. Only for a chat session on a Daytona sandbox (a VM's handshake costs nothing worth hiding), and
   * only once the chat's user exists (`ensureChat`). The remote launcher blocks reading its stdin frame, so nothing of the model's runs before the
   * frame is written; the bindings and the staged snapshot still precede it. Returns null when there is nothing to open.
   */
  preconnect(input: { ip: SshTarget; brandId: string; chat: ConversationKey; remotePort: number; proxyPort: number }): PreparedConnection | null {
    if (typeof input.ip === "string" || this.config.userFor) return null;
    const child = this.openSessionConnection(input, this.launcherCommand());
    let open = true;
    const close = (): void => { if (open) { open = false; child.kill("SIGTERM"); } };
    const timer = setTimeout(close, PRECONNECT_MAX_IDLE_MS);
    timer.unref?.();
    const exited = new Promise<void>((resolve) => child.once("exit", () => { clearTimeout(timer); resolve(); }));
    return {
      exited,
      take: () => {
        if (!open) return null;
        open = false;
        clearTimeout(timer);
        return child.exitCode === null && child.signalCode === null && child.stdin?.writable ? child : null;
      },
      cancel: () => { clearTimeout(timer); close(); },
    };
  }

  /** Receives the ssh and Claude Code stderr of spawned sessions (set by the owner for logging). */
  onStderr?: (brandId: string, text: string) => void;
}
