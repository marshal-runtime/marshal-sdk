import type { WakeReason } from "../wake-reason.js";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { failureFields, OperationError, operationFields } from "../../operation-error.js";
import type { ServerConfig } from "../../config.js";
import type { ReadOnlyPg } from "../../directory.js";
import type { FetchFn, TokenSource } from "../../gcp.js";
import type { Logger } from "../../logger.js";
import { brainAccount, brainScopesFor, iamTokenMinter, STAGING_BRAIN_SCOPES, type MintedToken } from "../brain-tokens.js";
import { BrandLinks } from "../brand-link.js";
import { RUNTIME_FILE } from "../../tasks/runtime-features.js";
import { shellQuote, type Exec, type SshRunner } from "../ssh.js";
import type { SshTarget } from "../ssh-target.js";
import { SandboxBusyError, SandboxNotFoundError, SdkDaytonaClient, type DaytonaClient, type DaytonaSandboxInfo } from "./client.js";
import { BrandNotInEnvironmentError } from "../brand-environment.js";

/** Daytona's `recover` of a brand's sandbox in `error` failed; the sandbox is left as it is and the next ensure tries again. The cause is Daytona's error. */
export class SandboxRecoverFailedError extends Error {
  constructor(readonly sandboxId: string, cause: unknown) { super(`recover of sandbox ${sandboxId} failed`, { cause }); this.name = "SandboxRecoverFailedError"; }
}

/** The brand's sandbox is in `error` and Daytona says it cannot be recovered: the server keeps it (its disk holds the chats) and an operator decides. */
export class SandboxUnrecoverableError extends Error {
  constructor(readonly sandboxId: string) { super(`sandbox ${sandboxId} is in an unrecoverable error state`); this.name = "SandboxUnrecoverableError"; }
}
import { IdAccessError, ID_ACCESS_MISSING_ROLE, idAccessEnsurer, type IdAccessResult } from "./id-access.js";
import { brandAccount, idTokenMinter, metadataTokenMinter, type IdToken, type IdTokenKind } from "./credentials.js";
import { brainEnvOf, buildDaytonaZsConfig, isLocalDaytonaEnv } from "./zs-config.js";

export type { SshTarget } from "../ssh-target.js";

/** Tools of the VM bridge (`zs-data-tools.mjs`) that the server's own code relies on; one missing from a snapshot's runtime is reported at ensure. */
export const REQUIRED_BRIDGE_TOOLS = ["zs.routines.list", "zs.routines.set_override"] as const;
export const bridgeProbeCommand = (file: string = RUNTIME_FILE): string => `for t in ${REQUIRED_BRIDGE_TOOLS.map(shellQuote).join(" ")}; do grep -qF -- "$t" ${shellQuote(file)} 2>/dev/null || echo "$t"; done; true`;

export interface DaytonaProvider {
  /** Starts or creates the brand's sandbox, boots it (contract A), pins its host key, opens the brand link. */
  /** `reason` names the work that asks (logged on `daytona.ready` when this call starts or creates the sandbox). */
  ensure(brandId: string, reason: WakeReason): Promise<{ hostId: `dt:${string}`; target: SshTarget }>;
  /** Stops the sandbox (disk kept). */
  stop(brandId: string): Promise<void>;
  /** Pushes every credential the brand's VM gets today (Brain, BigQuery/Postgres token, Meta grant). */
  pushCredentials(brandId: string): Promise<void>;
  status(brandId: string): Promise<{ state: string; sandboxId: string | null; hostId: string | null; env?: string | null; snapshot?: string | null; upgrade?: UpgradeState }>;
  /** The brand ids of this environment's Marley sandboxes (a label scan), including brands the server no longer holds live. */
  sandboxBrands?(): Promise<string[]>;
  /**
   * A brand whose database row is gone: the repo's memory is copied to the bucket first (`SnapshotUpgrade.archiveDeletedBrand`); only then is the sandbox deleted.
   * A throw keeps the sandbox. "none" when the brand has no sandbox.
   */
  retireDeletedBrand?(brandId: string): Promise<"none" | { retired: true; object: string; memoryFiles: string[] }>;
}

export interface MetadataToken {
  token: string;
  email: string;
  /** Epoch seconds. */
  exp: number;
}

export interface DaytonaRuntimeSettings {
  /** `marley-brand-poc-<release>` (contract A item 1). */
  snapshot: string;
  /** Minutes without a lease or an `ensure` before the sandbox is stopped (DAYTONA_IDLE_STOP_MINUTES). */
  idleStopMinutes: number;
  /** The code layer pinned next to the snapshot (DAYTONA_CODE_LAYER); null: the snapshot's own code only. */
  codeLayer: CodeLayerPin | null;
}

/** The label on a sandbox that names the snapshot it was created from. A sandbox without it (made before the label) counts as made from another snapshot. */
export const SNAPSHOT_LABEL = "snapshot";
/** Set on a sandbox Daytona marks unrecoverable (value: ISO time): ensure skips it and makes a new one, and nothing here ever deletes it (its disk holds the chats since the last backup). */
export const UNSTARTABLE_LABEL = "zs_unstartable";
/**
 * Proof, kept on the sandbox in Daytona, that its repo holds the brand's history: set only after the repo was restored from the mirror (or found to contain
 * the mirror's head). Every ensure reads it back from Daytona and serves the brand on no sandbox without it (MLY-580).
 */
export const REPO_LABEL = "repo";
export const REPO_RESTORED = "restored";
/** Daytona states in which a sandbox has never run: its create was accepted but never reached `started`. Not `unknown`: the client also reports a missing state that way. */
const NEVER_RAN_STATES = new Set(["creating", "pending_build", "building_snapshot", "pulling_snapshot"]);
/**
 * Written by the server on a sandbox of a brand this environment does not run (`runsBrand` answered false, SB92) and removed when it answers true: the
 * release gate (`zs-daytona-brands-moved.mjs`) does not wait for those, since the server never wakes or moves them.
 */
export const RUNS_LABEL = "brand_runs";
export const RUNS_REFUSED = "refused";

/** An ensure found a sandbox without the repo proof whose repo does not hold the mirror's history, and could not replace it: the brand is not served on it. */
export class RepoNotProvenError extends Error {
  constructor(readonly sandboxId: string) { super(`sandbox ${sandboxId} does not hold the brand's repo history and was not replaced`); this.name = "RepoNotProvenError"; }
}

export type UpgradeTrigger = "ensure" | "idle" | "sweep";

/**
 * How one snapshot-upgrade attempt for a brand ended, as `status` reports it (`brand-runtime status`; the staging gate prints it when the turn's sandbox is
 * on the wrong snapshot). Only typed fields that are already in the logs: the refusal or hold reason, the step, and the fixed metadata of a failure
 * (`operationFields`), never an error's text.
 */
export interface UpgradeAttempt {
  at: string;
  trigger: UpgradeTrigger;
  outcome: "deferred" | "refused" | "failed" | "retired";
  /** The hold refusal (brand_busy, brand_held, run_due, ...), the repo-check refusal (repo_not_on_mirror, work_files, timeout, ...) or the failure (delete_failed, check_failed, sweep_failed); null when retired. */
  reason: string | null;
  sandboxId: string | null;
  from: string | null;
  to: string | null;
  mode?: UpgradeHoldMode;
  step?: string;
  detail?: string;
  elapsedMs?: number;
  operation?: string;
  exitCode?: number | null;
  errorClass?: string;
}

/** The provider's upgrade state of one brand: whether this process holds it live (the sweep sees only those), the last attempt of each trigger, and the sweep's clock and backoff. */
export interface UpgradeState {
  live: boolean;
  last: Partial<Record<UpgradeTrigger, UpgradeAttempt>>;
  staleSince: string | null;
  backoff: { until: string; failures: number } | null;
}

/**
 * What the server supplies so a sandbox made from a snapshot other than the brand's effective one can be replaced without losing work. Without it
 * the provider only labels new sandboxes and never retires one.
 */
/** The `name` of the error `mirrorCurrent` throws when a work, files or `.marshal/` folder holds files (or cannot be checked): logged with its own reason, not as a repo that is off the mirror. */
export const WORK_FILES_REFUSED = "WorkFilesRefused";
/** The `name` of the error when the sandbox exec is not root and `sudo -n` does not give root: logged as reason `not_root`. */
export const NOT_ROOT_REFUSED = "NotRootRefused";
export const UPGRADE_TIMED_OUT = "UpgradeTimedOut";
/**
 * The longest one command of a snapshot upgrade may run (capture, mirror push, the chat-files archive), in seconds; the upgrade's own deadline
 * (`upgradeTimeoutMs`, 300 s) still bounds the hold. At 60 s the archive of a copycat brand's chat files was cut off and the upgrade refused as
 * `carry_failed` four times in a row (staging BioVelvet Test, 2026-11-12), so the brand never left the old snapshot and the staging gate failed.
 */
export const UPGRADE_COMMAND_MAX_S = 240;
/** The `name` of the error when a chat's files cannot be archived whole (a link inside, over the bounds, a failed copy): logged as reason `carry_failed`; the old sandbox stays. */
export const CARRY_FAILED = "CarryOverRefused";

/**
 * Carry refusals that a retry cannot change: the same files are archived again and refused again. Each one kept the sandbox started (`staleIdleKeeps`) and was
 * retried every idle period and sweep: production Biovelvet, 2026-11-16, 46 `over_bounds` refusals in a day (2019 files, 1.7 GB), its sandbox never stopped.
 */
export const CARRY_BLOCKING_DETAILS: readonly string[] = ["over_bounds", "bad_chat_entry", "special_file"];

/** The fixed code and counts a refusal carries (`detail`, `carryFiles`, `carryKib`), so the log says why without the withheld message. */
function refusalDetail(error: unknown): { detail?: string; carryFiles?: number; carryKib?: number } {
  if (!(error instanceof Error)) return {};
  const { detail, carryFiles, carryKib } = error as Error & { detail?: unknown; carryFiles?: unknown; carryKib?: unknown };
  return { ...(typeof detail === "string" && /^[a-z0-9_:./-]{1,90}$/.test(detail) ? { detail } : {}), ...(Number.isSafeInteger(carryFiles) ? { carryFiles: carryFiles as number } : {}), ...(Number.isSafeInteger(carryKib) ? { carryKib: carryKib as number } : {}) };
}

/** The parts of a brand that keep it busy (the server's `busyFor`): a hold refused as `brand_busy` names them, comma-joined, as its `detail`. */
export const BRAND_BUSY_PARTS = ["runtime-maintenance", "turn", "tasks", "events", "meta-actions", "workspace-actions", "brain-token", "graph-watch"] as const;
export type BrandBusyPart = (typeof BRAND_BUSY_PARTS)[number];

/**
 * Where a file that refused a move sits, as a closed class with no folder name in it: the `scope` of a work-files refusal. The finer `chat:work/<dir>`
 * detail stays in the server log only, because below a chat's top folder a name is chosen by the chat or the brand.
 */
export const WORK_FILE_SCOPES = ["chat:work", "chat:files", "chat:state", "brand", "other"] as const;
export type WorkFileScope = (typeof WORK_FILE_SCOPES)[number];

/**
 * The `detail` an attempt keeps in the upgrade state, which `brand-runtime status` answers and the staging gate prints into an org-visible CI log: a value
 * from a closed set only (a work-files refusal's typed scope, a carry code, the busy parts of a hold), never a path or a name a chat or brand chose.
 */
function reportedRefusalDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { detail, scope } = error as Error & { detail?: unknown; scope?: unknown };
  if (error.name === WORK_FILES_REFUSED) return (WORK_FILE_SCOPES as readonly unknown[]).includes(scope) ? scope as WorkFileScope : undefined;
  return typeof detail === "string" && CARRY_DETAILS.includes(detail) ? detail : undefined;
}
function reportedHoldDetail(detail: string | undefined): string | undefined {
  return detail && detail.split(",").every((part) => (BRAND_BUSY_PARTS as readonly string[]).includes(part)) ? detail : undefined;
}
/** The routine state of a chat could not be captured into the server's store before the retire: the sandbox is kept and the next sweep tries again. */
export const CAPTURE_REFUSED = "RoutineCaptureRefused";
/** The `name` of the error `mirrorCurrent` throws when a sandbox's diverged repo history could not be archived; it carries `archiveStep`, `exitCode`, `vmHead` and `mirrorHead`. */
export const DIVERGED_ARCHIVE_FAILED = "DivergedArchiveFailed";

/** Runs a command inside the sandbox as root (Daytona's own exec, not ssh as the brand user): the chat folders are 0700 and owned by other users. */
import { CARRY_DETAILS, type SandboxFiles } from "./carry-over.js";
import { applyCodeLayer, CodeLayerNotApplied, CodeLayerTooLarge, onPin, strayLayer, type CodeLayerOutcome, type CodeLayerSandbox, type CodeLayerPin, type CodeLayerSource } from "./code-layer.js";
import { googleObjectStore, ObjectTooLarge, type ObjectStore } from "../../object-store.js";
export type { SandboxFiles } from "./carry-over.js";
export type RootRun = (command: string) => Promise<{ code: number | null; stdout: string }>;

/**
 * How the brand's hold is taken for an upgrade. "now" (an ensure or an idle stop): only when nothing of the brand runs. "quiet" (the sweep): no turn or task
 * running; background work (events, token pushes, the graph watch) is waited for briefly under the hold. "boundary" (the sweep, once a sandbox has been stale
 * past the deadline): the hold stops new work, running turns are waited for, tasks go back to their queue and background work no longer delays it.
 */
export type UpgradeHoldMode = "now" | "quiet" | "boundary";

/** A sandbox history that no longer contained the mirror's head, kept under `ref` in the server mirror and as `branch` on GitHub before the sandbox is replaced. */
export interface DivergedArchive { vmHead: string; mirrorHead: string | null; ref: string; branch: string }
export type RepoProof = { kind: "contains" | "no_mirror" } | { kind: "diverged"; vmHead: string; mirrorHead: string };

export interface SnapshotUpgrade {
  /** Takes the brand's hold when it is free and the brand is idle (nothing running); otherwise says why not. The caller releases it. */
  hold(brandId: string, mode?: UpgradeHoldMode): Promise<{ release(): void } | { refused: string; detail?: string }>;
  /**
   * Throws unless, after a mirror run, the brand's work is safe elsewhere: the sandbox's repo is clean on main and its head equals the server mirror's head,
   * or its history lacks the mirror's head and was archived (server mirror ref and a dated GitHub side branch; returned as `diverged`). A history that
   * could not be archived throws `DivergedArchiveFailed`.
   */
  mirrorCurrent(brandId: string, target: SshTarget, root: RootRun, progress?: { step: string }, files?: SandboxFiles): Promise<void | { diverged: DivergedArchive }>;
  /**
   * Whether the sandbox's repo holds the brand's history: `contains` when its main contains the server mirror's head, `no_mirror` when the server has none,
   * `diverged` (both heads) otherwise. Throws when it cannot tell.
   */
  repoProof(brandId: string, target: SshTarget): Promise<RepoProof>;
  /** The daily full backup of the brand's chat files from its running sandbox to the bucket; "fresh" when the stored one is under a day old. Optional. */
  backupChats?(brandId: string, root: RootRun, files: SandboxFiles): Promise<"none" | "fresh" | "base" | "delta" | "unchanged">;
  /** A deleted brand's repo goes to the bucket under `deleted-brands/<brand>/<stamp>/` (repo archive and a manifest of its memory files). Throws on any failure. */
  archiveDeletedBrand?(brandId: string, root: RootRun, files: SandboxFiles): Promise<{ object: string; memoryFiles: string[] }>;
  /** Before a sandbox Daytona cannot recover is set aside: queues the brand's stored chat-files backup as the next new sandbox's restore; returns the archives pending. Optional. */
  queueBackupRestore?(brandId: string): Promise<number>;
  /** Right after a sandbox is created: brings the repo back from the server mirror when there is one. Throws when the import is refused. */
  restore(brandId: string, target: SshTarget, sandbox?: { root: RootRun; files: SandboxFiles }): Promise<"restored" | "no_mirror">;
}

export interface DaytonaProviderOptions {
  client: DaytonaClient;
  ssh: SshRunner;
  links: BrandLinks;
  logger: Logger;
  /** `env` label of the sandboxes this server owns (prod, test, ...). */
  env: string;
  /** GCP project that holds the brand service accounts. */
  project: string;
  /** The server's known_hosts file (the one `SshConfig.knownHostsFile` names). */
  knownHostsFile: string;
  /** Private directory (0700) for the per-start relay secret files read by `zs-ws-connect`. */
  secretDir: string;
  /** Compiled `zs-ws-connect.js`. */
  proxyScript?: string;
  /** 0600 file holding the Daytona API key for the ProxyCommand (`--api-key-file`); never an argument or an environment variable. */
  apiKeyFile?: string;
  nodeBin?: string;
  settings(brandId: string): Promise<DaytonaRuntimeSettings>;
  /** Whether this environment runs the brand's sandbox (`brandRunsHere`); absent: every brand. `ensure` refuses another brand before any Daytona call. */
  runsBrand?(brandId: string): Promise<boolean>;
  /** How long a start refused because the sandbox is mid state change keeps waiting for it to settle (default 120 s). */
  startSettleMs?: number;
  /** Replaces a sandbox whose snapshot is not the effective one, when the brand is idle and its repo is safe on the server mirror; optional. */
  upgrade?: SnapshotUpgrade;
  /** Where the pinned code layer's object is read (the server's bucket access). Required when a setting pins a layer. */
  codeLayerSource?: CodeLayerSource;
  /** The `zs-config` document of the brand's sandbox (the provisioner's `buildZsConfig`, `dataPolicy.pg.host` 127.0.0.1 port 15432). */
  zsConfig(brandId: string): Promise<Record<string, unknown>>;
  /** Public keys of the agent servers the sandbox's sshd trusts (zs-config `sandboxSshKeys`, 1 to 4); used when `zsConfig` carries none. */
  sandboxSshKeys?: readonly string[];
  credentials: {
    mintBrain(brandId: string): Promise<MintedToken>;
    mintMetadata(brandId: string): Promise<MetadataToken>;
    /** The audience-bound ID token of the brand's own account that the VM's `zs-embed-token` / `zs-speech-token` timers would fetch from the metadata server. */
    mintIdToken(brandId: string, kind: IdTokenKind): Promise<IdToken>;
    /** Whether the brand has a Brain (its broker policy lists it): only then does it need the embeddings token. */
    brainServed(brandId: string): Promise<boolean>;
    /** Lets the brand's account call the proxies from a sandbox (the account's registry object; the invoker grants are the provisioner's); optional, idempotent. */
    ensureIdAccess?(brandId: string): Promise<IdAccessResult | void>;
    syncMetaGrant?(brandId: string, target: SshTarget): Promise<void>;
  };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?(): unknown };
  /** How long after construction the pinned code layer is pushed to the started sandboxes (`pushLayerToStarted`). Default 5 s. */
  layerPushDelayMs?: number;
  /** The longest a startup push keeps a brand's upgrade hold; the apply itself stays in the brand's chain. Default 120 s. */
  layerPushHoldMs?: number;
  /** Timer for the background credential refresh; defaults to `setTimeout`. */
  setRefreshTimer?: (fn: () => void, ms: number) => { unref?(): unknown };
  /** While a sandbox is live its credentials are pushed again this often, so a long turn never outlives a 60 minute token. Default 30 minutes. */
  backgroundRefreshMs?: number;
  /** How long `ensure` waits for `zs-init status` to report ready after `start --detach`, and how often it asks. Defaults 60 s and 2 s. */
  readyTimeoutMs?: number;
  /** The whole repo check of a snapshot upgrade (capture, mirror, work-folder scan) must finish within this, or the upgrade is refused and the brand's hold released. Default 300 s (a brand with hundreds of chats captures them, six at a time, for about two minutes). */
  upgradeTimeoutMs?: number;
  /** Running sandboxes made from another snapshot are looked for this often and upgraded when the brand has no turn or task running. Default 2 minutes. */
  upgradeSweepMs?: number;
  /** How long a brand is left alone after its chat-files backup was asked for (default 30 minutes). */
  chatBackupRetryMs?: number;
  /** A sandbox stale this long is upgraded at the next turn boundary even while background work runs (the "boundary" hold). Default 15 minutes. */
  upgradeDeadlineMs?: number;
  /** After a sweep attempt that held the brand and was refused or failed, the sweep leaves that brand alone this long (doubling per failure, at most eight times this). Default 30 minutes. */
  upgradeBackoffMs?: number;
  /**
   * How many idle periods a sandbox made from another snapshot is kept started after its retire was not done at the idle stop (MLY-580), so the sweep keeps
   * seeing it and retires it at a quiet moment or past its deadline. Each keep renews Daytona's activity (its own auto-stop would stop it otherwise). Default 6
   * (30 minutes at the 5-minute idle stop); after that the sandbox is stopped as before.
   */
  staleIdleKeeps?: number;
  /**
   * After an upgrade refused for a reason a retry cannot change (`CARRY_BLOCKING_DETAILS`: the chat files over the carry bounds, a link or special file in a chat
   * folder), no idle stop, sweep or dormant wake tries that brand's same snapshot move again for this long, and the idle stop stops the sandbox instead of keeping it
   * started. One ERROR (`daytona.snapshot_upgrade_blocked`) names the brand and the counts so an operator can act. Kept in memory: a restart costs one attempt. Default 24 hours.
   */
  upgradeBlockMs?: number;
  /**
   * Sandboxes of this environment the server does not hold live (a stopped one, or one a previous process left running) that are made from another snapshot:
   * each sweep wakes at most this many of them, started ones first, through `ensure`, whose own retire (under the brand's "now" hold, so only while the
   * brand is idle) moves them; one it cannot move becomes live and the sweep and the idle stop above take it from there. Default 1; 0 turns it off.
   */
  dormantPerSweep?: number;
  /** How long the lookup after a failed create may take before it gives up (the repo proof catches what is left). Default 30 s. */
  createLookupMs?: number;
  /** How long a sandbox may sit in a never-ran state before it counts as a failed create (default 5 minutes). */
  stuckCreateMs?: number;
  /** Older than this a sandbox is not taken for a failed create, however Daytona reports it (default 6 hours): one made before the repo proof existed has no restored label either. */
  stuckCreateMaxMs?: number;
  readyPollMs?: number;
  /** Credentials are pushed again when the last push is older than this. Default 40 minutes (tokens last 60). */
  credentialRefreshMs?: number;
  /** How long a confirmed sandbox is trusted without asking Daytona again (default 15 s). */
  warmVerifiedMs?: number;
}

interface Live {
  sandboxId: string;
  alias: string;
  target: SshTarget;
  lastPushAt: number;
  /** When `ensure` last confirmed this sandbox with Daytona (0: not confirmed, check next time). */
  verifiedAt: number;
  /** The speech token waits for the brand's first chat (the helper answered "pending"): the next `ensure` of the live sandbox tries it again. */
  speechPending: boolean;
  /** A retry of the pending speech token is running (not awaited by `ensure`). */
  speechPushing: boolean;
  idle: { unref?(): unknown } | null;
  idleToken: number;
  refreshToken: number;
  /** The code layer this sandbox was last seen on (null: none, or not asked yet). */
  codeLayer: string | null;
  /** With no pin: the layer the sandbox runs anyway (stale, retired like an old snapshot), null for none, undefined when not known (asked at the next cold ensure). */
  strayLayer: string | null | undefined;
  /** Idle periods this sandbox was kept started because it is stale and its retire was not done (`staleIdleKeeps`). */
  staleIdleKeeps?: number;
}

/** Exit status of `zs-id-token-install ... speech` when the brand's group does not exist yet. */
const SPEECH_PENDING_EXIT = 3;
const BOOT_DIR = "/var/lib/zs-boot";
const INIT = "/usr/local/sbin/zs-init";
const SBIN = "/usr/local/sbin";
/** Where the host's root-owned Brain policy lives (image/install/zs-brain-enroll). */
const BRAIN_POLICY_FILE = "/etc/zygstinct/brain-policy.json";

/** The python that prints the host's Brain policy state as JSON (no single quote in it: it runs inside `python3 -c '...'`). A policy file that does not parse fails the script. */
export const hostBrainPolicyScript = (file: string): string => ["import json, os", `p = ${JSON.stringify(file)}`, "d = {} if not os.path.lexists(p) else json.load(open(p))",
  "print(json.dumps({\"policy\": \"absent\" if not os.path.lexists(p) else (\"read_only\" if d.get(\"readOnly\") is True and d.get(\"applySchema\") is not True and not d.get(\"applySchemaBrands\") else \"writable\")}))"].join("\n");

/** A local-stack sandbox's Brain cannot be shown to be read-only (or absent): `writable_policy` is a host that holds a writable policy, `probe_failed` a probe that could not answer. */
export class LocalBrainRefusal extends Error {
  constructor(readonly reason: "writable_policy" | "probe_failed", message: string) {
    super(message);
    this.name = "LocalBrainRefusal";
  }
}
const DEFAULT_PROXY_SCRIPT = fileURLToPath(new URL("./zs-ws-connect.js", import.meta.url));

export interface InitStatus {
  ready: boolean;
  hostKeyPub: string;
  errors: string[];
}

/** The JSON `zs-init status` prints; the toolbox returns stdout and stderr together, so the last JSON line is taken. */
export function parseInitStatus(output: string): InitStatus {
  const line = output.split("\n").map((l) => l.trim()).reverse().find((l) => l.startsWith("{"));
  if (!line) throw new OperationError("daytona", null);
  let parsed: { ready?: unknown; hostKeyPub?: unknown; errors?: unknown };
  try { parsed = JSON.parse(line); } catch { throw new OperationError("daytona", null); }
  const fields = typeof parsed.hostKeyPub === "string" ? parsed.hostKeyPub.trim().split(/\s+/) : [];
  if (parsed.ready !== true || fields.length < 2 || !/^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa)$/.test(fields[0]!) || !/^[A-Za-z0-9+/=]+$/.test(fields[1]!)) {
    throw new OperationError("daytona", null);
  }
  return { ready: true, hostKeyPub: `${fields[0]} ${fields[1]}`, errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [] };
}

/** Runs `work` while holding `<file>.lock` (created exclusively; a lock older than 10 s is a crashed holder's and is taken over). */
function withFileLock<T>(lockFile: string, work: () => T): T {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 10_000) fs.rmSync(lockFile, { force: true }); } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error("known_hosts is locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return work(); } finally { fs.rmSync(lockFile, { force: true }); }
}

/** Replaces the alias's line in a known_hosts file with the sandbox's own host key. Locked against another server process and atomic, so a concurrent ssh never reads half a file. */
export function pinHostKey(file: string, alias: string, hostKeyPub: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(`${file}.lock`, () => {
    let kept: string[] = [];
    try { kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() && line.split(" ")[0] !== alias); } catch { /* first pin */ }
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${[...kept, `${alias} ${hostKeyPub}`].join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  });
}

export class DaytonaSandboxProvider implements DaytonaProvider {
  private readonly live = new Map<string, Live>();
  private readonly accessEnsured = new Set<string>();
  private readonly accessRunning = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly upgradeNoted = new Map<string, string>();
  private readonly busy = new Map<string, number>();
  /** When the sweep first saw a brand's running sandbox made from another snapshot. */
  private readonly staleSince = new Map<string, number>();
  /** After a sweep attempt that took the hold and was refused or failed (a slow or failing capture): no new attempt before this time, doubling up to 4 hours. */
  private readonly sweepBackoff = new Map<string, { until: number; failures: number }>();
  /** A snapshot move refused for a reason a retry cannot change (`CARRY_BLOCKING_DETAILS`): not tried again before `until` for the same from/to pair. */
  private readonly upgradeBlocked = new Map<string, { from: string | null; to: string; until: number }>();
  /** The last upgrade attempt of each trigger per brand (`status`); one per trigger, so a turn's deferral at ensure never hides why the idle stop or the sweep did not retire. */
  private readonly upgradeAttempts = new Map<string, Partial<Record<UpgradeTrigger, UpgradeAttempt>>>();
  /** Sandboxes this server deleted: Daytona keeps listing one (destroying) for a while, and an ensure must never start or boot it. */
  private readonly deleted = new Set<string>();
  private readonly backupAsked = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepStopped = false;
  private readonly now: () => number;

  constructor(private readonly options: DaytonaProviderOptions) {
    this.now = options.now ?? Date.now;
    if (options.upgrade) this.armSweep();
    if (options.codeLayerSource && options.upgrade) {
      const set = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      set(() => { void this.pushLayerToStarted(); }, options.layerPushDelayMs ?? 5_000).unref?.();
    }
  }

  /**
   * Once, shortly after this process starts: every started sandbox of this environment on the effective snapshot is brought to the pinned code layer
   * now, with the checks a wake makes (this environment runs the brand, the sandbox is still started and on the snapshot). Only under the brand's
   * upgrade hold in "now" mode, taken inside the brand's chain after the eligibility checks: refused while the brand is held, busy (a turn, a task,
   * background work), onboarding live or the server stopping, so the layer never changes under running work; a refused brand is left to its next
   * ensure, which applies the pin before that work. The hold lasts at most `layerPushHoldMs` (120 s); the chain, which every ensure waits for, lasts
   * until the apply ends. A sandbox this push could not bring to the pin is logged (the typed outcome) and left alone: its next ensure applies
   * the layer again and fails with `CodeLayerNotApplied` while it cannot. One brand's failure never stops the others. A failed listing, hold or read
   * is a dependency fault (WARN, OB01). `shutdown` stops the push before its next brand but does not wait for an install in flight; the helper
   * installs atomically, so a cut client leaves the old or the new layer current, never a mix.
   */
  async pushLayerToStarted(): Promise<void> {
    const upgrade = this.options.upgrade;
    if (!this.options.codeLayerSource || !upgrade || this.sweepStopped) return;
    let found: DaytonaSandboxInfo[];
    try { found = await this.options.client.findByLabels({ app: "marley", env: this.options.env }); } catch (error) {
      this.options.logger.warn("daytona.code_layer_push_failed", { reason: "list_failed", ...failureFields(error) });
      return;
    }
    const counts = { applied: 0, current: 0, notApplied: 0, deferred: 0, skipped: 0, failed: 0 };
    for (const sandbox of found) {
      const brandId = sandbox.labels.brand;
      if (this.sweepStopped) return;
      if (typeof brandId !== "string" || !BRAND_ID_RE.test(brandId)) { counts.skipped += 1; continue; }
      try {
        // Eligibility inside the brand's chain (behind any ensure, stop or sweep of the brand), read again: the listing may be minutes old by now, and a
        // sandbox being destroyed is not `started`. The hold is taken last, so it covers only the apply, as retireIfStale does inside an ensure.
        await this.exclusive(brandId, async () => {
          if (this.options.runsBrand && !await this.options.runsBrand(brandId)) { counts.skipped += 1; return; }
          const [settings, current] = await Promise.all([this.options.settings(brandId), this.options.client.get(sandbox.id)]);
          if (!settings.codeLayer) { counts.skipped += 1; return; }
          if (current.state !== "started") { counts.skipped += 1; return; }
          if ((current.labels[SNAPSHOT_LABEL] ?? null) !== settings.snapshot) { counts.skipped += 1; return; }
          const taken = await upgrade.hold(brandId, "now");
          if ("refused" in taken) { counts.deferred += 1; this.options.logger.info("daytona.code_layer_push_deferred", { brandId, sandboxId: sandbox.id, reason: taken.refused, ...(taken.detail ? { detail: taken.detail } : {}) }); return; }
          let released = false;
          const release = (): void => { if (!released) { released = true; taken.release(); } };
          // A slow apply (download, a 360 s exec) does not keep the brand held: past the deadline the hold goes and the brand's queued work may start,
          // but every use of the sandbox ensures first and so waits in this chain until the apply ends.
          (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
            if (released) return;
            this.options.logger.warn("daytona.code_layer_push_hold_expired", { brandId, sandboxId: sandbox.id, holdMs: this.options.layerPushHoldMs ?? 120_000 });
            release();
          }, this.options.layerPushHoldMs ?? 120_000).unref?.();
          try {
            const outcome = await this.applyLayer(brandId, sandbox.id, settings.codeLayer, "startup");
            if (outcome.kind === "applied") counts.applied += 1; else if (outcome.kind === "current") counts.current += 1; else counts.notApplied += 1;
          } finally { release(); }
        });
      } catch (error) { counts.failed += 1; this.options.logger.warn("daytona.code_layer_push_failed", { brandId, sandboxId: sandbox.id, reason: "push_failed", ...failureFields(error) }); }
    }
    this.options.logger.info("daytona.code_layer_push_done", { listed: found.length, ...counts });
  }

  private armSweep(): void {
    if (this.sweepStopped) return;
    this.sweepTimer = setTimeout(() => { void this.sweepUpgrades().then(() => this.backupChatFiles()).finally(() => this.armSweep()); }, this.options.upgradeSweepMs ?? 120_000);
    this.sweepTimer.unref?.();
  }

  /**
   * The upgrade a release needs: an ensure always runs for some work of the brand (so its own check finds the brand busy) and a busy brand never idles out,
   * so every running sandbox made from another snapshot is looked at here, outside any work of the brand, and retired under a short hold; the new sandbox is
   * made at once. Past upgradeDeadlineMs the hold no longer waits for a quiet moment (see UpgradeHoldMode).
   */
  async sweepUpgrades(): Promise<void> {
    const upgrade = this.options.upgrade;
    if (!upgrade) return;
    for (const [brandId, live] of [...this.live]) {
      try { await this.sweepOne(brandId, live, upgrade); } catch (error) {
        this.options.logger.warn("daytona.snapshot_upgrade_failed", { brandId, sandboxId: live.sandboxId, reason: "sweep_failed", ...failureFields(error) });
        this.recordUpgrade(brandId, { trigger: "sweep", outcome: "failed", reason: "sweep_failed", sandboxId: live.sandboxId, from: null, to: null, ...operationFields(error) });
      }
    }
    await this.sweepDormant();
  }

  /**
   * The sandboxes of this environment that this process does not hold live and that are made from another snapshot (a brand nobody wrote to since the release,
   * or one a previous server process left running): at most `dormantPerSweep` per sweep, started ones first, are woken through `ensure`, whose retire moves
   * the sandbox when the brand is idle. Nobody waits for this: it runs in the sweep. A brand whose wake fails is left alone for the sweep's backoff.
   * A brand this environment does not run (`runsBrand` false) is never woken and never takes a wake (ensure would refuse it, and one refused brand per sweep
   * starved the brands that can move): its sandbox gets the `brand_runs=refused` label for the release gate, removed once the server runs the brand.
   */
  private async sweepDormant(): Promise<void> {
    const limit = this.options.dormantPerSweep ?? 1;
    if (limit <= 0 || this.sweepStopped) return;
    let found: DaytonaSandboxInfo[];
    try { found = await this.options.client.findByLabels({ app: "marley", env: this.options.env }); } catch (error) {
      this.options.logger.warn("daytona.snapshot_upgrade_failed", { reason: "dormant_list_failed", ...failureFields(error) });
      return;
    }
    const candidates = found
      // A sandbox set aside as unstartable is never a candidate: its brand runs on another sandbox, and waking it would take the sweep's slot every tick.
      .filter((sandbox) => !this.deleted.has(sandbox.id) && !/^destroy/.test(sandbox.state) && !(UNSTARTABLE_LABEL in sandbox.labels) && typeof sandbox.labels.brand === "string" && BRAND_ID_RE.test(sandbox.labels.brand))
      .filter((sandbox) => (this.sweepBackoff.get(sandbox.labels.brand!)?.until ?? 0) <= this.now())
      .sort((a, b) => Number(b.state === "started") - Number(a.state === "started"));
    let woken = 0;
    for (const sandbox of candidates) {
      if (this.sweepStopped) return;
      if (woken >= limit && !this.options.runsBrand) return;
      const brandId = sandbox.labels.brand!;
      // A live brand is the live sweep's (checked here, not when listing: a wake earlier in this loop makes a brand with two sandboxes live).
      if (this.live.has(brandId)) continue;
      try {
        const runs = !this.options.runsBrand || await this.options.runsBrand(brandId);
        if (runs === (sandbox.labels[RUNS_LABEL] === RUNS_REFUSED)) await this.markRuns(brandId, sandbox, runs);
        if (!runs || woken >= limit) continue;
        const settings = await this.options.settings(brandId);
        if ((sandbox.labels[SNAPSHOT_LABEL] ?? null) === settings.snapshot) continue;
        if (this.upgradeBlockedFor(brandId, sandbox.labels[SNAPSHOT_LABEL] ?? null, settings.snapshot)) continue;
        woken += 1;
        this.options.logger.info("daytona.snapshot_upgrade_dormant", { brandId, sandboxId: sandbox.id, state: sandbox.state, from: sandbox.labels[SNAPSHOT_LABEL] ?? null, to: settings.snapshot });
        await this.ensure(brandId, "snapshot_upgrade");
      } catch (error) {
        const failures = (this.sweepBackoff.get(brandId)?.failures ?? 0) + 1;
        this.sweepBackoff.set(brandId, { until: this.now() + Math.min((this.options.upgradeBackoffMs ?? 30 * 60_000) * 2 ** (failures - 1), 8 * (this.options.upgradeBackoffMs ?? 30 * 60_000)), failures });
        this.options.logger.warn("daytona.snapshot_upgrade_failed", { brandId, sandboxId: sandbox.id, reason: "dormant_wake_failed", ...failureFields(error) });
        this.recordUpgrade(brandId, { trigger: "sweep", outcome: "failed", reason: "dormant_wake_failed", sandboxId: sandbox.id, from: sandbox.labels[SNAPSHOT_LABEL] ?? null, to: null, ...operationFields(error) });
      }
    }
  }

  /** True while this brand's move from `from` to `to` is blocked; an expired block, or one for another snapshot pair, is dropped. */
  private upgradeBlockedFor(brandId: string, from: string | null, to: string): boolean {
    const block = this.upgradeBlocked.get(brandId);
    if (!block) return false;
    if (block.from === from && block.to === to && block.until > this.now()) return true;
    this.upgradeBlocked.delete(brandId);
    return false;
  }

  private recordUpgrade(brandId: string, attempt: Omit<UpgradeAttempt, "at">): void {
    this.upgradeAttempts.set(brandId, { ...this.upgradeAttempts.get(brandId), [attempt.trigger]: { at: new Date(this.now()).toISOString(), ...attempt } });
  }

  private upgradeState(brandId: string): UpgradeState {
    const since = this.staleSince.get(brandId);
    const backoff = this.sweepBackoff.get(brandId);
    return {
      live: this.live.has(brandId),
      last: { ...this.upgradeAttempts.get(brandId) },
      staleSince: since === undefined ? null : new Date(since).toISOString(),
      backoff: backoff ? { until: new Date(backoff.until).toISOString(), failures: backoff.failures } : null,
    };
  }

  /**
   * The daily chat-files backup: every live, started brand is asked at most every `chatBackupRetryMs` (30 minutes); the backup itself skips a brand whose stored base is under a day old,
   * so each brand is archived about once a day. A failure is logged and tried again at the next ask. The sandbox holds no credentials: the server pulls the archive through the root exec.
   */
  async backupChatFiles(): Promise<void> {
    const upgrade = this.options.upgrade;
    if (!upgrade?.backupChats) return;
    for (const [brandId, live] of [...this.live]) {
      if ((this.backupAsked.get(brandId) ?? 0) + (this.options.chatBackupRetryMs ?? 30 * 60_000) > this.now()) continue;
      this.backupAsked.set(brandId, this.now());
      try {
        const sandbox = await this.options.client.get(live.sandboxId);
        if (sandbox.state !== "started" || this.live.get(brandId) !== live || this.deleted.has(sandbox.id)) continue;
        await upgrade.backupChats(brandId, async (command) => {
          const result = await this.options.client.exec(sandbox.id, command, { timeoutS: 120 });
          return { code: result.exitCode, stdout: result.output };
        }, this.sandboxFiles(sandbox.id));
      } catch (error) { this.options.logger.warn("daytona.chat_files_backup_failed", { brandId, sandboxId: live.sandboxId, ...failureFields(error) }); }
    }
  }

  private async sweepOne(brandId: string, live: Live, upgrade: SnapshotUpgrade): Promise<void> {
    if (this.live.get(brandId) !== live) return;
    const [settings, sandbox] = await Promise.all([this.options.settings(brandId), this.options.client.get(live.sandboxId)]);
    if ((sandbox.labels[SNAPSHOT_LABEL] ?? null) === settings.snapshot && !live.strayLayer) {
      this.staleSince.delete(brandId);
      return;
    }
    if (sandbox.state !== "started") return;
    if ((this.sweepBackoff.get(brandId)?.until ?? 0) > this.now()) return;
    if (!live.strayLayer && this.upgradeBlockedFor(brandId, sandbox.labels[SNAPSHOT_LABEL] ?? null, settings.snapshot)) return;
    const since = this.staleSince.get(brandId) ?? this.now();
    this.staleSince.set(brandId, since);
    const mode: UpgradeHoldMode = this.now() - since >= (this.options.upgradeDeadlineMs ?? 15 * 60_000) ? "boundary" : "quiet";
    // Taken outside the brand's chain: work already running may still ask for the sandbox while the hold waits for it to finish.
    const taken = await upgrade.hold(brandId, mode).catch((error: unknown): { refused: string; detail?: string } => ({ refused: error instanceof Error ? error.name : "hold_failed" }));
    const fields = { brandId, sandboxId: sandbox.id, from: sandbox.labels[SNAPSHOT_LABEL] ?? null, to: settings.snapshot, trigger: "sweep", mode, staleMs: this.now() - since };
    if ("refused" in taken) {
      this.options.logger.info("daytona.snapshot_upgrade_deferred", { ...fields, reason: taken.refused, ...(taken.detail ? { detail: taken.detail } : {}) });
      const detail = reportedHoldDetail(taken.detail);
      this.recordUpgrade(brandId, { trigger: "sweep", outcome: "deferred", reason: taken.refused, sandboxId: sandbox.id, from: fields.from, to: fields.to, mode, ...(detail ? { detail } : {}) });
      return;
    }
    let released = false;
    const hold = { release: (): void => { if (!released) { released = true; taken.release(); } } };
    try {
      await this.exclusive(brandId, async () => {
        if (this.live.get(brandId) !== live) return;
        const current = await this.options.client.get(live.sandboxId);
        if (current.state !== "started") return;
        const retired = await this.retireIfStale(brandId, live, current, settings.snapshot, "sweep", hold);
        if (retired) { this.staleSince.delete(brandId); this.sweepBackoff.delete(brandId); await this.ensureAfterRetire(brandId, retired, "snapshot_upgrade"); }
        else {
          const failures = (this.sweepBackoff.get(brandId)?.failures ?? 0) + 1;
          const waitMs = Math.min((this.options.upgradeBackoffMs ?? 30 * 60_000) * 2 ** (failures - 1), 8 * (this.options.upgradeBackoffMs ?? 30 * 60_000));
          this.sweepBackoff.set(brandId, { until: this.now() + waitMs, failures });
        }
      });
    } finally { hold.release(); }
  }

  /** Brings one sandbox to the pin and logs the typed outcome: INFO when applied, ERROR when refused or failed. */
  private async applyLayer(brandId: string, sandboxId: string, pin: CodeLayerPin | null, trigger: "wake" | "startup" = "wake"): Promise<CodeLayerOutcome> {
    const source = this.options.codeLayerSource;
    if (pin && !source) throw new Error("a code layer is pinned but the provider has no code layer source");
    const { client } = this.options;
    const outcome = await applyCodeLayer(pin, this.layerSandbox(sandboxId), source ?? { download: async () => { throw new Error("unreachable: no pin"); } });
    const fields = { brandId, sandboxId, trigger, outcome: outcome.kind, ...(outcome.kind === "no_pin" ? {} : { layer: outcome.layer }) };
    if (outcome.kind === "applied") this.options.logger.info("daytona.code_layer_applied", { ...fields, previous: outcome.previous, pruned: outcome.pruned });
    else if (outcome.kind === "refused") this.options.logger.error("daytona.code_layer_apply_failed", { ...fields, refused: outcome.refused });
    else if (outcome.kind === "failed") this.options.logger.error("daytona.code_layer_apply_failed", { ...fields, failed: outcome.failed, ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}), ...(outcome.errno ? { errno: outcome.errno } : {}), ...(outcome.step ? { step: outcome.step } : {}), ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}) });
    return outcome;
  }

  private layerSandbox(sandboxId: string): CodeLayerSandbox {
    const { client } = this.options;
    return {
      exec: async (command, timeoutS) => { const result = await client.exec(sandboxId, command, { timeoutS }); return { exitCode: result.exitCode, output: result.output }; },
      upload: (remotePath, content, mode) => client.uploadFile(sandboxId, remotePath, content, mode),
    };
  }

  /** No pin: asks the sandbox whether it runs a layer anyway. A layer found is logged (WARN) and makes the sandbox stale; a failed ask is an ERROR and stays unknown (undefined). */
  private async findStrayLayer(brandId: string, sandboxId: string): Promise<string | null | undefined> {
    const answer = await strayLayer(this.layerSandbox(sandboxId));
    if ("layer" in answer) {
      if (answer.layer) this.options.logger.warn("daytona.code_layer_unpinned", { brandId, sandboxId, layer: answer.layer });
      return answer.layer;
    }
    this.options.logger.error("daytona.code_layer_status_failed", { brandId, sandboxId, trigger: "wake", ...answer });
    return undefined;
  }

  ensure(brandId: string, reason: WakeReason): Promise<{ hostId: `dt:${string}`; target: SshTarget }> {
    // Every remote command asks for the sandbox first. Two Daytona API calls (get, refresh activity) per command, queued one behind another per brand, were the
    // gap between the steps of a turn start. A sandbox confirmed a moment ago, with no start, stop or credential push in flight, is answered from memory;
    // a failed ssh command (`invalidateWarm`) or the window running out brings the full check back.
    const warm = this.confirmedRecently(brandId);
    if (warm && !this.busy.get(brandId)) return Promise.resolve(warm);
    // Calls that queued behind a check or a start take its answer instead of repeating the API calls.
    return this.exclusive(brandId, async () => {
      const recent = this.confirmedRecently(brandId);
      if (recent) return recent;
      if (this.options.runsBrand && !await this.options.runsBrand(brandId)) throw new BrandNotInEnvironmentError(brandId, this.options.env);
      return this.ensureOnce(brandId, reason);
    });
  }

  private confirmedRecently(brandId: string): { hostId: `dt:${string}`; target: SshTarget } | null {
    const live = this.live.get(brandId);
    if (!live || live.verifiedAt <= 0 || this.now() - live.verifiedAt >= (this.options.warmVerifiedMs ?? 15_000)) return null;
    return { hostId: `dt:${live.sandboxId}`, target: live.target };
  }

  /** The next `ensure` of this brand checks the sandbox with Daytona again (after an ssh failure). */
  invalidateWarm(brandId: string): void {
    const live = this.live.get(brandId);
    if (live) live.verifiedAt = 0;
  }

  stop(brandId: string): Promise<void> {
    return this.exclusive(brandId, () => this.stopOnce(brandId));
  }

  pushCredentials(brandId: string): Promise<void> {
    return this.exclusive(brandId, async () => {
      const live = this.live.get(brandId);
      if (!live) throw new OperationError("daytona", null);
      await this.push(brandId, live);
    });
  }

  async status(brandId: string): Promise<{ state: string; sandboxId: string | null; hostId: string | null; env?: string | null; snapshot?: string | null; recoverable?: boolean; upgrade: UpgradeState }> {
    const found = await this.find(brandId);
    // `env` and `snapshot` are the labels read back from Daytona, so the staging gate can prove which environment's sandbox ran the turn; `upgrade` says why a
    // sandbox on another snapshot was not replaced (this process's own record: a pod restart starts it empty).
    const upgrade = this.upgradeState(brandId);
    return found ? { state: found.state, sandboxId: found.id, hostId: `dt:${found.id}`, env: found.labels.env ?? null, snapshot: found.labels[SNAPSHOT_LABEL] ?? null, ...(found.recoverable === undefined ? {} : { recoverable: found.recoverable }), upgrade } : { state: "absent", sandboxId: null, hostId: null, upgrade };
  }

  /** The target of a running sandbox by host id: what the token pushers' locator answers for a `dt:` host. */
  targetFor(hostId: string): SshTarget {
    for (const live of this.live.values()) if (`dt:${live.sandboxId}` === hostId) return live.target;
    throw new OperationError("daytona", null);
  }

  /** Holds the sandbox open (no idle stop, link kept) for the duration of a turn; call the result when the turn ends. */
  lease(brandId: string): () => void {
    return this.options.links.lease(brandId);
  }

  async sandboxBrands(): Promise<string[]> {
    const found = await this.options.client.findByLabels({ app: "marley", env: this.options.env });
    return [...new Set(found.filter((sandbox) => !this.deleted.has(sandbox.id) && !/^destroy/.test(sandbox.state)).map((sandbox) => sandbox.labels.brand).filter((brand): brand is string => typeof brand === "string" && BRAND_ID_RE.test(brand)))];
  }

  /** Archives and deletes a deleted brand's sandbox. It goes through find(), so a sandbox set aside as `zs_unstartable` is never archived or deleted here (intended: nothing can read it, and its disk is kept for an operator). */
  async retireDeletedBrand(brandId: string): Promise<"none" | { retired: true; object: string; memoryFiles: string[] }> {
    const archive = this.options.upgrade?.archiveDeletedBrand;
    if (!archive) throw new Error("no archive for a deleted brand is configured");
    const sandbox = await this.find(brandId);
    if (!sandbox) return "none";
    if (sandbox.state !== "started") await this.wake(brandId, sandbox);
    const archived = await archive(brandId, async (command) => { const r = await this.options.client.exec(sandbox.id, command, { timeoutS: 120 }); return { code: r.exitCode, stdout: r.output }; }, this.sandboxFiles(sandbox.id));
    const live = this.live.get(brandId);
    if (live) await this.discard(brandId, live);
    else {
      this.deleted.add(sandbox.id);
      try { await this.options.client.delete(sandbox.id); } catch (error) { this.deleted.delete(sandbox.id); throw error; }
    }
    return { retired: true, ...archived };
  }

  async shutdown(): Promise<void> {
    this.sweepStopped = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.options.links.closeAll();
    for (const live of this.live.values()) { live.idleToken += 1; live.refreshToken += 1; }
    await Promise.all([...this.live.values()].map((live) => this.closeConnections(live.target)));
  }

  /** Ends the multiplexed SSH master(s) to a sandbox; a failure is logged and never blocks a stop. */
  private async closeConnections(target: SshTarget): Promise<void> {
    try { await this.options.ssh.closeConnections?.(target); } catch (error) { this.options.logger.warn("daytona.close_connections_failed", { errorClass: error instanceof Error ? error.name : "unknown" }); }
  }

  private exclusive<T>(brandId: string, work: () => Promise<T>): Promise<T> {
    this.busy.set(brandId, (this.busy.get(brandId) ?? 0) + 1);
    const run = (this.chains.get(brandId) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.chains.set(brandId, run);
    const done = (): void => { const left = (this.busy.get(brandId) ?? 1) - 1; if (left > 0) this.busy.set(brandId, left); else this.busy.delete(brandId); };
    run.then(done, done);
    return run;
  }

  private async find(brandId: string): Promise<DaytonaSandboxInfo | null> {
    const cached = this.live.get(brandId);
    // Only Daytona's own "no such sandbox" means it is gone: any other failed read (a 5xx, a timeout) treated as absence made a second sandbox for the brand.
    if (cached) {
      const held = await this.options.client.get(cached.sandboxId).catch((error: unknown) => { if (error instanceof SandboxNotFoundError) return null; throw error; });
      if (held) return held;
      // The held sandbox is gone: the brand's other sandboxes are listed before any create, so a create (and the cleanup after a failed one, which deletes
      // whatever the listing then finds) only ever happens for a brand that had none.
    }
    const found = (await this.options.client.findByLabels({ app: "marley", brand: brandId, env: this.options.env })).filter((sandbox) => !this.deleted.has(sandbox.id) && !/^destroy/.test(sandbox.state) && !(UNSTARTABLE_LABEL in sandbox.labels));
    // A brand left with more than one sandbox keeps using the running one, so a restart does not wake a second.
    return found.find((sandbox) => sandbox.state === "started") ?? found[0] ?? null;
  }

  /**
   * A sandbox in `error` met by ensure: recovered when Daytona can (true). One Daytona itself marks unrecoverable is labelled `zs_unstartable` and
   * kept, never deleted (its disk holds what the chats wrote since the last backup), and this ensure creates a new one on the pinned snapshot with the
   * brand repo restored from the mirror and the chat files from the brand's chat-files backup (base and deltas, queued here as an upgrade's carry is)
   * (false): a broken sandbox must not keep its brand (or the staging gate, which runs on one long-lived brand) down until someone acts by hand (owner's
   * order, 2026-11-12). The label keeps it out of find(), the failed-create cleanup and the dormant sweep. A recover that fails, for any reason, throws one
   * typed error carrying the cause and changes nothing: the next ensure tries again.
   */
  private async recoverOrDrop(brandId: string, sandbox: DaytonaSandboxInfo): Promise<boolean> {
    const { client } = this.options;
    if (sandbox.recoverable !== false) {
      const started = this.now();
      try {
        await client.recover(sandbox.id);
      } catch (error) {
        // Reported once, by the caller that logs the failed ensure (turn.runtime_unavailable): the typed class and the cause travel with the error.
        throw new SandboxRecoverFailedError(sandbox.id, error);
      }
      this.options.logger.info("daytona.recovered", { brandId, sandboxId: sandbox.id, ms: this.now() - started });
      return true;
    }
    // Queued before the label: a backup record that cannot be read fails this ensure with the sandbox untouched, and the next ensure tries again.
    const backupArchives = (await this.options.upgrade?.queueBackupRestore?.(brandId)) ?? 0;
    // setLabels replaces the whole set: every label the sandbox has is written back with this one.
    await client.setLabels(sandbox.id, { ...sandbox.labels, [UNSTARTABLE_LABEL]: new Date(this.now()).toISOString() });
    this.options.logger.error("daytona.sandbox_unstartable", { brandId, sandboxId: sandbox.id, state: sandbox.state, recoverable: sandbox.recoverable ?? null, backupArchives });
    return false;
  }

  /**
   * Brings a sandbox that is not running to `started` for the deleted-brand archive: one in `error` is recovered (Daytona refuses `start` of it); one
   * Daytona marks unrecoverable fails typed and is kept, never deleted here, because its disk holds the brand's chats.
   */
  private async wake(brandId: string, sandbox: DaytonaSandboxInfo): Promise<void> {
    if (sandbox.state !== "error") return this.startSettled(sandbox.id);
    if (sandbox.recoverable === false) throw new SandboxUnrecoverableError(sandbox.id);
    const started = this.now();
    await this.options.client.recover(sandbox.id);
    this.options.logger.info("daytona.recovered", { brandId, sandboxId: sandbox.id, ms: this.now() - started });
  }

  /** Starts a sandbox; one still stopping or starting (Daytona's 409) is waited for and started again, within `startSettleMs`. */
  private async startSettled(sandboxId: string): Promise<void> {
    const deadline = this.now() + (this.options.startSettleMs ?? 120_000);
    for (;;) {
      try { await this.options.client.start(sandboxId); return; } catch (error) {
        if (!(error instanceof SandboxBusyError) || this.now() >= deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.readyPollMs ?? 2000));
      if ((await this.options.client.get(sandboxId)).state === "started") return;
    }
  }

  private async ensureOnce(brandId: string, reason: WakeReason, upgraded = false): Promise<{ hostId: `dt:${string}`; target: SshTarget }> {
    const { client } = this.options;
    const settings = await this.options.settings(brandId);
    let sandbox = await this.find(brandId);
    // `ensure` runs only a brand this environment runs, so a sandbox still marked refused is counted by the release gate again.
    if (sandbox && sandbox.labels[RUNS_LABEL] === RUNS_REFUSED) await this.markRuns(brandId, sandbox, true);
    const cached = this.live.get(brandId);
    if (cached && sandbox && sandbox.id === cached.sandboxId && sandbox.state === "started" && (!this.options.upgrade || sandbox.labels[REPO_LABEL] === REPO_RESTORED)) {
      const retired = upgraded ? null : await this.retireIfStale(brandId, cached, sandbox, settings.snapshot, "ensure");
      if (retired) return this.ensureAfterRetire(brandId, retired, reason);
      await client.refreshActivity(sandbox.id);
      if (!this.options.links.isOpen(brandId)) this.options.links.open(brandId, cached.target);
      if (this.now() - cached.lastPushAt > (this.options.credentialRefreshMs ?? 40 * 60_000)) await this.push(brandId, cached);
      else if (cached.speechPending && !cached.speechPushing) {
        // Off ensure's critical path: minting (10 s) and the ssh push (30 s) must not add to a turn's start. The step swallows its failures; one push at a time.
        cached.speechPushing = true;
        void this.pushChatTokens(brandId, cached).finally(() => { cached.speechPushing = false; });
      }
      this.armIdle(brandId, cached, settings.idleStopMinutes);
      this.armRefresh(brandId, cached);
      cached.verifiedAt = this.now();
      return { hostId: `dt:${cached.sandboxId}`, target: cached.target };
    }
    // The layer this server last put on this same sandbox: its files survive a stop, so a wake of it needs no layer exec.
    let knownLayer = cached && sandbox && cached.sandboxId === sandbox.id ? cached.codeLayer : null;
    let knownStray = cached && sandbox && cached.sandboxId === sandbox.id ? cached.strayLayer : undefined;
    if (cached) { this.options.links.close(brandId); await this.closeConnections(cached.target); this.live.delete(brandId); }
    let created = false;
    let recovered = false;
    if (sandbox && this.isStuckCreate(sandbox, settings.snapshot)) {
      await this.discardStuckCreate(brandId, sandbox);
      sandbox = null; knownLayer = null; knownStray = undefined;
    }
    if (sandbox?.state === "error") {
      if (await this.recoverOrDrop(brandId, sandbox)) recovered = true;
      else { sandbox = null; knownLayer = null; knownStray = undefined; }
    }
    let restored = false;
    let live: Live | undefined;
    if (!sandbox) {
      created = true;
      const labels = { app: "marley", brand: brandId, env: this.options.env, [SNAPSHOT_LABEL]: settings.snapshot };
      try {
        sandbox = await client.create({ snapshot: settings.snapshot, labels, autoStopMinutes: Math.max(15, settings.idleStopMinutes * 3), user: "root" });
      } catch (error) {
        // Daytona can finish a create whose call failed on our side (a timeout): what it left would be found by the next ensure and served unrestored.
        await this.removeFailedCreate(brandId, error);
        throw error;
      }
    }
    // From the create to the repo proof, any failure deletes a sandbox this ensure created (MLY-580): kept, the next ensure finds it (not created), skips the
    // restore and serves the brand on an empty repo. That covers a refused code layer, a failed boot or push, a refused restore and a lost label write alike.
    // Whether the sandbox was already running when this ensure found it (a server restart, a turn on another server): `daytona.ready` then woke nothing.
    const alreadyStarted = !created && sandbox.state === "started";
    try {
      const alreadyRunning = alreadyStarted;
      if (!alreadyRunning && !recovered) await this.startSettled(sandbox.id);
      live = await this.boot(brandId, sandbox.id, alreadyRunning);
      await this.checkBridge(brandId, sandbox.id, settings.snapshot);
      // Before the sandbox is ready: a sandbox that cannot be brought to the pinned layer is not used (no turn runs on code the environment did not pin).
      // The pin is an env value, so it changes only with a new server process; a running sandbox gets it at that process's first ensure of the brand.
      if (settings.codeLayer && knownLayer === settings.codeLayer.sha256) live.codeLayer = knownLayer;
      // No pin: a sandbox this ensure created runs none; one this server already asked keeps its answer; any other is asked once (retireIfStale acts on a layer found).
      else if (!settings.codeLayer) live.strayLayer = created ? null : knownStray !== undefined ? knownStray : await this.findStrayLayer(brandId, sandbox.id);
      // A sandbox made from another snapshot: the pinned layer is built on the pinned snapshot, so applying it there is refused (base_key_mismatch) and failed
      // every turn of every brand not yet moved (production, 2026-11-12 12:26Z, release-20261112-9). It is served as it is, on its own snapshot's code as
      // before the pin, and the retire at the end of this ensure (or the sweep, at the brand's next quiet moment) moves it; the new sandbox gets the layer.
      // (A sandbox this ensure created carries the pinned snapshot label, so it never takes this branch.)
      else if ((sandbox.labels[SNAPSHOT_LABEL] ?? null) !== settings.snapshot) {
        this.options.logger.warn("daytona.code_layer_skipped_stale", { brandId, sandboxId: sandbox.id, from: sandbox.labels[SNAPSHOT_LABEL] ?? null, to: settings.snapshot, layer: settings.codeLayer.sha256 });
      }
      else {
        const layer = await this.applyLayer(brandId, sandbox.id, settings.codeLayer);
        if (!onPin(layer)) throw new CodeLayerNotApplied(layer as ConstructorParameters<typeof CodeLayerNotApplied>[0]);
        live.codeLayer = layer.kind === "no_pin" ? null : layer.layer;
      }
      this.live.set(brandId, live);
      await this.push(brandId, live, false);
      await this.options.ssh.ensureBrand(live.target, brandId);
      if (this.options.upgrade) {
        if (created) {
          await this.restoreRepo(brandId, live, sandbox.id);
          // Restored: the chat files' replay record is spent and the repo holds the mirror's head, so this sandbox is kept whatever follows. A lost label
          // write fails this ensure; the next one finds the sandbox unlabelled and its proof (main contains the mirror's head) writes the label.
          restored = true;
          await this.markRestored(sandbox);
        } else if (sandbox.labels[REPO_LABEL] !== REPO_RESTORED) {
          const replaced = await this.proveRepo(brandId, live, sandbox, settings.snapshot, reason);
          if (replaced) return replaced;
        }
      }
    } catch (error) {
      if (created && !restored) await this.discardCreated(brandId, sandbox.id, live, error);
      // Kept after its restore: its chats were set up before the voice policy and token existed, so the next turn sets each up again (as a completed create does).
      else if (created && live) this.options.ssh.forgetChats?.(live.target, brandId);
      throw error;
    }
    await this.pushIdTokens(brandId, live);
    // Chats restored above were set up before the voice policy and token existed: the next turn sets each up again with them.
    if (created) this.options.ssh.forgetChats?.(live.target, brandId);
    this.options.links.open(brandId, live.target);
    this.armIdle(brandId, live, settings.idleStopMinutes);
    this.armRefresh(brandId, live);
    this.options.logger.info("daytona.ready", { brandId, sandboxId: sandbox.id, reason, started: !alreadyStarted, created });
    const retired = upgraded ? null : await this.retireIfStale(brandId, live, sandbox, settings.snapshot, "ensure");
    if (retired) return this.ensureAfterRetire(brandId, retired, reason);
    live.verifiedAt = this.now();
    return { hostId: `dt:${sandbox.id}`, target: live.target };
  }

  /** The sandbox was just retired under the brand's hold: make the new one (its repo comes back from the mirror) before the hold ends. */
  private async ensureAfterRetire(brandId: string, hold: { release(): void }, reason: WakeReason): Promise<{ hostId: `dt:${string}`; target: SshTarget }> {
    try { return await this.ensureOnce(brandId, reason, true); } finally { hold.release(); }
  }

  /** A new sandbox gets its repo from the server mirror (when the server has one). A refused import fails the ensure, which deletes the sandbox so the next ensure tries again. */
  private async restoreRepo(brandId: string, live: Live, sandboxId: string): Promise<void> {
    try {
      const result = await this.options.upgrade!.restore(brandId, live.target, { root: async (command) => { const r = await this.options.client.exec(sandboxId, command, { timeoutS: 120 }); return { code: r.exitCode, stdout: r.output }; }, files: this.sandboxFiles(sandboxId) });
      this.options.logger.info("daytona.repo_restore", { brandId, sandboxId, result });
    } catch (error) {
      this.options.logger.warn("daytona.repo_restore_failed", { brandId, sandboxId, ...failureFields(error) });
      throw error;
    }
  }

  /** Writes (runs false) or removes (runs true) the `brand_runs=refused` label in Daytona, keeping the sandbox's other labels. */
  private async markRuns(brandId: string, sandbox: DaytonaSandboxInfo, runs: boolean): Promise<void> {
    const { [RUNS_LABEL]: _old, ...rest } = sandbox.labels;
    const labels = runs ? rest : { ...rest, [RUNS_LABEL]: RUNS_REFUSED };
    await this.options.client.setLabels(sandbox.id, labels);
    sandbox.labels = labels;
    this.options.logger.info(runs ? "daytona.brand_runs_here" : "daytona.brand_not_run_here", { brandId, sandboxId: sandbox.id, state: sandbox.state });
  }

  /** Writes the repo proof onto the sandbox in Daytona, keeping its other labels. */
  private async markRestored(sandbox: DaytonaSandboxInfo): Promise<void> {
    await this.options.client.setLabels(sandbox.id, { ...sandbox.labels, [REPO_LABEL]: REPO_RESTORED });
    sandbox.labels = { ...sandbox.labels, [REPO_LABEL]: REPO_RESTORED };
  }

  /** Deletes a sandbox this ensure created and could not bring to a proven repo; the next ensure creates another. */
  private async discardCreated(brandId: string, sandboxId: string, live: Live | undefined, cause: unknown): Promise<void> {
    this.options.logger.warn("daytona.created_sandbox_discarded", { brandId, sandboxId, ...failureFields(cause) });
    if (live) { await this.discard(brandId, live); return; }
    this.deleted.add(sandboxId);
    try { fs.rmSync(path.join(this.options.secretDir, `dt-${sandboxId}.secret`), { force: true }); } catch { /* best effort */ }
    try { await this.options.client.delete(sandboxId); } catch (error) { this.options.logger.warn("daytona.delete_failed", { brandId, sandboxId, ...failureFields(error) }); }
  }

  /**
   * A sandbox this environment's create left behind that never ran: the pinned snapshot, no repo-restored label (so no chat files whose replay record is
   * spent), a state in which it has never started, for longer than `stuckCreateMs` since Daytona made it. Production BioVelvet, 2026-11-12 19:01Z: the create
   * timed out, the cleanup's delete failed, and every later start was refused as busy until someone deleted the sandbox by hand. A started, stopped, starting,
   * stopping, error or archived sandbox, or one whose age Daytona does not say, is never matched.
   */
  private isStuckCreate(sandbox: DaytonaSandboxInfo, snapshot: string): boolean {
    if (!NEVER_RAN_STATES.has(sandbox.state) || sandbox.labels[REPO_LABEL] === REPO_RESTORED || (sandbox.labels[SNAPSHOT_LABEL] ?? null) !== snapshot) return false;
    if (sandbox.createdAt === undefined) return false;
    const age = this.now() - Date.parse(sandbox.createdAt);
    return age > (this.options.stuckCreateMs ?? 5 * 60_000) && age <= (this.options.stuckCreateMaxMs ?? 6 * 3_600_000);
  }

  /** Deletes a stuck create; if Daytona refuses, sets it aside with the unstartable label (find() then skips it for good). If that is refused too the ensure fails, creating nothing. */
  private async discardStuckCreate(brandId: string, sandbox: DaytonaSandboxInfo): Promise<void> {
    // As recoverOrDrop does, before anything is removed: the replacement restores the brand's chat files from its backup. A record that cannot be read fails this ensure with the sandbox untouched.
    const backupArchives = (await this.options.upgrade?.queueBackupRestore?.(brandId)) ?? 0;
    const fields = { brandId, sandboxId: sandbox.id, state: sandbox.state, createdAt: sandbox.createdAt ?? null, backupArchives };
    this.deleted.add(sandbox.id);
    try {
      await this.options.client.delete(sandbox.id);
      this.options.logger.warn("daytona.stuck_create_deleted", fields);
      return;
    } catch (error) {
      // Gone since the listing (Daytona's own cleanup): the discard is done.
      const gone = await this.options.client.get(sandbox.id).then(() => false, (lookup: unknown) => lookup instanceof SandboxNotFoundError);
      if (gone) { this.options.logger.warn("daytona.stuck_create_deleted", fields); return; }
      this.deleted.delete(sandbox.id);
      this.options.logger.warn("daytona.stuck_create_delete_failed", { ...fields, ...failureFields(error) });
    }
    await this.options.client.setLabels(sandbox.id, { ...sandbox.labels, [UNSTARTABLE_LABEL]: new Date(this.now()).toISOString() });
    this.options.logger.warn("daytona.stuck_create_set_aside", fields);
  }

  /**
   * A create that failed on our side may still have been completed by Daytona (2026-11-12 staging: the SDK timed out after 60 s and Daytona made the sandbox).
   * The brand had no sandbox before the create, so any it has now is what the failed create left: each is deleted, so the next ensure creates and restores one.
   * The lookup is bounded; a failed lookup or delete is logged, and the repo proof catches what is left at the next ensure.
   */
  private async removeFailedCreate(brandId: string, cause: unknown): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let left: DaytonaSandboxInfo[];
    try {
      left = await Promise.race([
        this.options.client.findByLabels({ app: "marley", brand: brandId, env: this.options.env }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("the lookup after a failed create did not finish in time"), { name: UPGRADE_TIMED_OUT })), this.options.createLookupMs ?? 30_000); }),
      ]);
    } catch (error) {
      this.options.logger.warn("daytona.failed_create_lookup_failed", { brandId, ...failureFields(error) });
      return;
    } finally { if (timer) clearTimeout(timer); }
    // A sandbox set aside as unstartable (recoverOrDrop) is never deleted: its disk holds the chats written after the last backup.
    const found = left.filter((sandbox) => !this.deleted.has(sandbox.id) && !/^destroy/.test(sandbox.state) && !(UNSTARTABLE_LABEL in sandbox.labels));
    this.options.logger.warn("daytona.create_failed", { brandId, left: found.map((sandbox) => sandbox.id), ...failureFields(cause) });
    for (const sandbox of found) {
      this.deleted.add(sandbox.id);
      try { await this.options.client.delete(sandbox.id); } catch (error) { this.deleted.delete(sandbox.id); this.options.logger.warn("daytona.delete_failed", { brandId, sandboxId: sandbox.id, ...failureFields(error) }); }
    }
  }

  /**
   * A sandbox found without the repo proof (left by a create or an ensure that failed, or made before the proof existed). A repo that contains the mirror's
   * head, or a brand the server has no mirror of, gets the proof and is served: that is how existing sandboxes are labelled, with no replacement. Otherwise
   * the brand is not served on it: the sandbox goes through the retire, which keeps its history (server mirror ref and GitHub side branch, ERROR
   * `daytona.repo_diverged`), carries chat files, deletes it, and the replacement is restored from the mirror. A refused retire (the history could not be kept,
   * for one) keeps the sandbox and throws, so no turn runs on it. Returns the replacement's ensure, or null when the sandbox was proven.
   */
  private async proveRepo(brandId: string, live: Live, sandbox: DaytonaSandboxInfo, effective: string, reason: WakeReason): Promise<{ hostId: `dt:${string}`; target: SshTarget } | null> {
    const proof = await this.options.upgrade!.repoProof(brandId, live.target);
    if (proof.kind !== "diverged") {
      await this.markRestored(sandbox);
      this.options.logger.info("daytona.repo_proven", { brandId, sandboxId: sandbox.id, proof: proof.kind });
      return null;
    }
    // The ensure is the turn's own start, so the brand's "now" hold would always be refused here: the brand's chain keeps other ensures out.
    const retired = await this.retireIfStale(brandId, live, sandbox, effective, "ensure", { release: () => undefined }, true);
    if (!retired) throw new RepoNotProvenError(sandbox.id);
    return this.ensureOnce(brandId, reason, true);
  }

  private sandboxFiles(sandboxId: string): SandboxFiles {
    const client = this.options.client;
    return { download: (remotePath) => client.downloadFile(sandboxId, remotePath), upload: (remotePath, content, mode) => client.uploadFile(sandboxId, remotePath, content, mode) };
  }

  /** Forgets and deletes a sandbox this server is done with. */
  private async discard(brandId: string, live: Live): Promise<void> {
    live.idleToken += 1; live.refreshToken += 1;
    this.options.links.close(brandId);
    await this.closeConnections(live.target);
    this.live.delete(brandId);
    try { fs.rmSync(path.join(this.options.secretDir, `dt-${live.sandboxId}.secret`), { force: true }); } catch { /* best effort */ }
    this.deleted.add(live.sandboxId);
    try { await this.options.client.delete(live.sandboxId); } catch (error) { this.options.logger.warn("daytona.delete_failed", { brandId, sandboxId: live.sandboxId, ...failureFields(error) }); }
  }

  /**
   * A sandbox made from a snapshot other than the effective one (or from none that was recorded) is deleted, but only when the brand is idle, under the
   * brand's hold, and its repo is clean and equal to the server mirror: the next create then rebuilds it from the new snapshot with the repo imported from the
   * mirror. A repo whose history lacks the mirror's head (MLY-580) is deleted too, but only after `mirrorCurrent` archived that history, with one WARN
   * (`daytona.repo_diverged`); `force` retires a sandbox an ensure could not prove restored, whatever its snapshot. Anything short of that keeps the sandbox,
   * and says why (once per reason). Returns the hold, still taken, when the sandbox was deleted.
   */
  private async retireIfStale(brandId: string, live: Live, sandbox: DaytonaSandboxInfo, effective: string, trigger: "ensure" | "idle" | "sweep", held?: { release(): void }, force = false): Promise<{ release(): void } | null> {
    const upgrade = this.options.upgrade;
    const from = sandbox.labels[SNAPSHOT_LABEL] ?? null;
    if (!upgrade || (!force && from === effective && !live.strayLayer)) return null;
    const fields = { brandId, sandboxId: sandbox.id, from, to: effective, trigger, ...(live.strayLayer ? { strayLayer: live.strayLayer } : {}) };
    if (!force && !live.strayLayer && this.upgradeBlockedFor(brandId, from, effective)) {
      this.recordUpgrade(brandId, { trigger, outcome: "deferred", reason: "blocked", sandboxId: sandbox.id, from, to: effective });
      return null;
    }
    const note = (level: "info" | "warn", event: string, outcome: "deferred" | "refused" | "failed", reason: string, extra: Record<string, unknown> = {}, recorded: Partial<UpgradeAttempt> = {}): void => {
      // A reason is logged once per brand at `ensure` (a turn is always running there, so it would repeat on every message); every idle attempt is logged, because idle is where a retire is expected to work.
      if (trigger !== "ensure" || this.upgradeNoted.get(brandId) !== `${event}:${reason}`) this.options.logger[level](event, { ...fields, reason, ...extra });
      this.upgradeNoted.set(brandId, `${event}:${reason}`);
      this.recordUpgrade(brandId, { trigger, outcome, reason, sandboxId: sandbox.id, from, to: effective, ...recorded });
    };
    const hold = held ?? await upgrade.hold(brandId, "now").catch((error: unknown): { refused: string; detail?: string } => ({ refused: error instanceof Error ? error.name : "hold_failed" }));
    if ("refused" in hold) { const reported = reportedHoldDetail(hold.detail); note("info", "daytona.snapshot_upgrade_deferred", "deferred", hold.refused, hold.detail ? { detail: hold.detail } : {}, { mode: "now", ...(reported ? { detail: reported } : {}) }); return null; }
    const progress = { step: "start" };
    const startedAt = this.now();
    try {
      // Capture, mirror and the work-folder scan each call out to a host with no deadline of their own; a hang there must not hold the brand silent.
      // Each command gets UPGRADE_COMMAND_MAX_S, never more than the upgrade's own deadline below.
      const commandS = Math.max(1, Math.min(UPGRADE_COMMAND_MAX_S, Math.floor((this.options.upgradeTimeoutMs ?? 300_000) / 1000)));
      const work = upgrade.mirrorCurrent(brandId, live.target, async (command) => {
        const result = await this.options.client.exec(sandbox.id, command, { timeoutS: commandS });
        return { code: result.exitCode, stdout: result.output };
      }, progress, this.sandboxFiles(sandbox.id));
      work.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const done = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("the snapshot upgrade's repo check did not finish in time"), { name: UPGRADE_TIMED_OUT })), this.options.upgradeTimeoutMs ?? 300_000); })]);
        // The sandbox's repo no longer held the mirror's history: it was kept (mirror ref, GitHub side branch) and the sandbox is replaced from the mirror.
        if (done?.diverged) this.options.logger.warn("daytona.repo_diverged", { ...fields, vmHead: done.diverged.vmHead, mirrorHead: done.diverged.mirrorHead, archiveRef: done.diverged.ref, archiveBranch: done.diverged.branch });
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      const cause = error instanceof Error && error.name === CAPTURE_REFUSED && error.cause !== undefined ? error.cause : error;
      const detail = reportedRefusalDetail(error);
      const elapsedMs = this.now() - startedAt;
      if (error instanceof Error && error.name === DIVERGED_ARCHIVE_FAILED) {
        const kept = error as Error & { archiveStep?: unknown; exitCode?: unknown; vmHead?: unknown; mirrorHead?: unknown };
        this.options.logger.error("daytona.repo_diverged_archive_failed", { ...fields, vmHead: kept.vmHead ?? null, mirrorHead: kept.mirrorHead ?? null, archiveStep: kept.archiveStep ?? null, exitCode: kept.exitCode ?? null });
      }
      const carry = error instanceof Error && error.name === CARRY_FAILED ? refusalDetail(error) : {};
      if (!force && !live.strayLayer && carry.detail !== undefined && CARRY_BLOCKING_DETAILS.includes(carry.detail)) {
        const until = this.now() + (this.options.upgradeBlockMs ?? 24 * 60 * 60_000);
        this.upgradeBlocked.set(brandId, { from, to: effective, until });
        this.options.logger.error("daytona.snapshot_upgrade_blocked", { ...fields, detail: carry.detail, carryFiles: carry.carryFiles ?? null, carryKib: carry.carryKib ?? null, until: new Date(until).toISOString() });
      }
      note("warn", "daytona.snapshot_upgrade_refused", "refused", error instanceof Error && error.name === WORK_FILES_REFUSED ? "work_files" : error instanceof Error && error.name === NOT_ROOT_REFUSED ? "not_root" : error instanceof Error && error.name === CAPTURE_REFUSED ? "capture_failed" : error instanceof Error && error.name === CARRY_FAILED ? "carry_failed" : error instanceof Error && error.name === UPGRADE_TIMED_OUT ? "timeout" : progress.step === "capture_routine_files" ? "capture_failed" : "repo_not_on_mirror", { ...failureFields(cause), ...refusalDetail(error), step: progress.step, elapsedMs }, { step: progress.step, elapsedMs, ...(detail ? { detail } : {}), ...operationFields(cause) });
      hold.release();
      return null;
    }
    try {
      this.deleted.add(sandbox.id);
      await this.options.client.delete(sandbox.id);
    } catch (error) {
      this.deleted.delete(sandbox.id);
      note("warn", "daytona.snapshot_upgrade_failed", "failed", "delete_failed", failureFields(error), operationFields(error));
      hold.release();
      return null;
    }
    try {
      this.upgradeNoted.delete(brandId);
      live.idleToken += 1; live.refreshToken += 1;
      this.options.links.close(brandId);
      await this.closeConnections(live.target);
      this.live.delete(brandId);
      try { fs.rmSync(path.join(this.options.secretDir, `dt-${sandbox.id}.secret`), { force: true }); } catch { /* best effort */ }
      this.options.logger.info("daytona.snapshot_upgrade", fields);
      this.recordUpgrade(brandId, { trigger, outcome: "retired", reason: null, sandboxId: sandbox.id, from, to: effective });
    } catch (error) {
      hold.release();
      throw error;
    }
    return hold;
  }

  /**
   * Contract A. A sandbox that was already running (this server restarted while it kept running) is asked for `zs-init status` first: if it is ready,
   * `start` is not run again, and a new relay secret is uploaded only when this server has lost the local secret file (the relay rereads the secret on
   * every connection). Otherwise: upload the boot files (new relay secret), run `zs-init start --detach` (plain `start` is the supervisor and never returns),
   * read `zs-init status`. Either way the host key is pinned again.
   */
  private async boot(brandId: string, sandboxId: string, alreadyRunning: boolean): Promise<Live> {
    const { client } = this.options;
    const alias = `dt-${sandboxId}`;
    const secretFile = path.join(this.options.secretDir, `${alias}.secret`);
    // Before anything is uploaded or started: a local sandbox that already holds a writable Brain policy is refused with the fix, not left to fail in the installer.
    // (A policy that only appears later, such as one a snapshot ships, is refused by `push`, which is the only way a token reaches the broker.)
    if (isLocalDaytonaEnv(this.options.env ?? null)) await this.refuseWritableLocalBrain(brandId, sandboxId);
    let init = alreadyRunning ? await this.readyStatus(sandboxId) : null;
    // The sandbox's relay secret and this server's copy must change together. The local file is removed before a new secret is uploaded and written as soon as
    // the upload returns, never only at the end of a boot: a boot that uploaded and then failed (2026-11-10, OKOA: `start --detach` timed out, the status poll
    // failed) used to keep the old local file, so every later ensure saw "ready, secret file present", uploaded nothing, and the relay refused every ssh for hours.
    // An upload with an unknown outcome leaves no local file, so the next ensure uploads a fresh one.
    const replaceSecret = async (): Promise<void> => {
      fs.mkdirSync(this.options.secretDir, { recursive: true, mode: 0o700 });
      fs.rmSync(secretFile, { force: true });
      const secret = randomBytes(32).toString("hex");
      await client.uploadFile(sandboxId, `${BOOT_DIR}/relay-secret`, Buffer.from(secret), "0600");
      fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    };
    if (init) {
      if (!fs.existsSync(secretFile)) await replaceSecret();
    } else {
      const identity = { brandId, serviceAccount: brandAccount(brandId, this.options.project), project: this.options.project };
      await replaceSecret();
      const config = await this.configForSandbox(brandId, sandboxId, await this.options.zsConfig(brandId));
      const withKeys = config.sandboxSshKeys || !this.options.sandboxSshKeys?.length ? config : { ...config, sandboxSshKeys: [...this.options.sandboxSshKeys] };
      await client.uploadFile(sandboxId, `${BOOT_DIR}/zs-config.json`, Buffer.from(JSON.stringify(withKeys)), "0600");
      await client.uploadFile(sandboxId, `${BOOT_DIR}/identity.json`, Buffer.from(JSON.stringify(identity)), "0600");
      try {
        const started = await client.exec(sandboxId, `${INIT} start --detach`, { timeoutS: 120 });
        if (started.exitCode !== 0) throw new OperationError("daytona", started.exitCode);
      } catch (error) {
        if (!(error instanceof Error) || !/command execution timeout/i.test(error.message)) throw error;
        this.options.logger.warn("daytona.boot_start_timeout", { brandId, sandboxId });
      }
      init = await this.awaitReady(sandboxId);
    }
    pinHostKey(this.options.knownHostsFile, alias, init.hostKeyPub);
    const target: SshTarget = { alias, proxyCommand: [this.options.nodeBin ?? process.execPath, this.options.proxyScript ?? DEFAULT_PROXY_SCRIPT, "--sandbox", sandboxId, "--secret-file", secretFile, ...(this.options.apiKeyFile ? ["--api-key-file", this.options.apiKeyFile] : [])] };
    return { sandboxId, alias, target, lastPushAt: 0, verifiedAt: 0, speechPending: false, speechPushing: false, idle: null, idleToken: 0, refreshToken: 0, codeLayer: null, strayLayer: undefined };
  }

  /**
   * A snapshot's `zs-config-apply` refuses any key it does not know and the sandbox then never becomes ready (2026-11-09: OKOA, on a snapshot from before
   * `footagePolicy`, was down for hours when the server started sending it). So a key an older installer lacks is left out, with a warning, and the brand boots;
   * the key arrives with the next snapshot upgrade. A probe that cannot answer keeps the key out too: a missing policy is a smaller failure than no boot.
   */
  private async configForSandbox(brandId: string, sandboxId: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const withoutBrain = await this.withoutUnsafeLocalBrain(brandId, sandboxId, config);
    if (!("footagePolicy" in withoutBrain)) return withoutBrain;
    let supported = false;
    try {
      const probe = await this.options.client.exec(sandboxId, `grep -q footagePolicy ${SBIN}/zs-config-apply`, { timeoutS: 15 });
      supported = probe.exitCode === 0;
    } catch (error) {
      this.options.logger.warn("daytona.footage_policy_probe_failed", { brandId, sandboxId, ...failureFields(error) });
    }
    if (supported) return withoutBrain;
    const { footagePolicy: _unsupported, ...rest } = withoutBrain;
    this.options.logger.warn("daytona.footage_policy_withheld", { brandId, sandboxId, reason: "the sandbox's zs-config-apply predates footagePolicy; upgrade its snapshot" });
    return rest;
  }

  /**
   * Whether the sandbox's `zs-config-apply` knows the read-only Brain policy, from its own typed `--capabilities` answer (exit 0 and `brainPolicyReadOnly: true`), and with
   * `staging` also the read-only staging pair a fresh local sandbox gets (`brainPolicyReadOnlyStaging: true`; an older `zs-brain-enroll` refuses the pair and fails the boot).
   * An installer that predates the flag refuses it in argparse (exit 2) before it reads or applies anything: that is "not supported". Any other outcome (a throw, another
   * exit code, an answer that is not that JSON) cannot say, and is refused (`LocalBrainRefusal`), never read as either answer.
   */
  private async localBrainSupported(sandboxId: string, staging = false): Promise<boolean> {
    let result: { exitCode: number; output: string };
    try { result = await this.options.client.exec(sandboxId, `${SBIN}/zs-config-apply --capabilities`, { timeoutS: 30 }); }
    catch (error) { throw new LocalBrainRefusal("probe_failed", `could not ask the sandbox's zs-config-apply for its capabilities: ${error instanceof Error ? error.message : "failed"}`); }
    if (result.exitCode === 2) return false;
    if (result.exitCode !== 0) throw new LocalBrainRefusal("probe_failed", `zs-config-apply --capabilities exited ${result.exitCode}`);
    let answer: { brainPolicyReadOnly?: unknown; brainPolicyReadOnlyStaging?: unknown };
    try { answer = JSON.parse(result.output.trim().split("\n").at(-1) ?? "") as typeof answer; }
    catch { throw new LocalBrainRefusal("probe_failed", "zs-config-apply --capabilities did not answer JSON"); }
    if (answer === null || typeof answer !== "object") throw new LocalBrainRefusal("probe_failed", "zs-config-apply --capabilities did not answer JSON");
    return answer.brainPolicyReadOnly === true && (!staging || answer.brainPolicyReadOnlyStaging === true);
  }

  /** The sandbox's root Brain policy as the host holds it: no file, a read-only one, or a writable one (a file without `readOnly: true`). A file that cannot be read is refused. */
  private async hostBrainPolicy(sandboxId: string): Promise<"absent" | "read_only" | "writable"> {
    let result: { exitCode: number; output: string };
    try { result = await this.options.client.exec(sandboxId, `python3 -I -c '${hostBrainPolicyScript(BRAIN_POLICY_FILE)}'`, { timeoutS: 30 }); }
    catch (error) { throw new LocalBrainRefusal("probe_failed", `could not read the sandbox's brain policy: ${error instanceof Error ? error.message : "failed"}`); }
    if (result.exitCode !== 0) throw new LocalBrainRefusal("probe_failed", `reading the sandbox's brain policy exited ${result.exitCode}`);
    try {
      const policy = (JSON.parse(result.output.trim().split("\n").at(-1) ?? "") as { policy?: unknown }).policy;
      if (policy === "absent" || policy === "read_only" || policy === "writable") return policy;
    } catch { /* falls through to the refusal below */ }
    throw new LocalBrainRefusal("probe_failed", "the sandbox's brain policy probe did not answer a policy state");
  }

  /**
   * A local-stack sandbox is never served while its host holds a WRITABLE Brain policy (one a server before the read-only policy booted it with, or a snapshot that ships one):
   * its broker would write the brand's real Brain. The sandbox is not changed here (nothing converts a host between modes, SB93); it is refused, with the fix.
   */
  private async refuseWritableLocalBrain(brandId: string, sandboxId: string): Promise<"absent" | "read_only"> {
    const policy = await this.hostBrainPolicy(sandboxId);
    if (policy === "writable") {
      this.options.logger.error("daytona.local_brain_writable", { brandId, sandboxId, env: this.options.env, fix: "delete this stack's env=local sandbox so it boots with the read-only Brain policy (or none)" });
      throw new LocalBrainRefusal("writable_policy", `local sandbox ${sandboxId} holds a writable Brain policy; delete it so it boots read-only`);
    }
    return policy;
  }

  /**
   * The opposite choice to the footage key: a local-stack sandbox's Brain must be read-only, and an installer that predates `readOnly` would ignore the key and
   * write a WRITABLE policy. So when the sandbox's `zs-config-apply` is shown not to know it, the Brain is left out altogether (no Brain, never a writable one).
   */
  private async withoutUnsafeLocalBrain(brandId: string, sandboxId: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const brain = config.brainPolicy as { readOnly?: unknown; env?: unknown } | undefined;
    if (!brain || !isLocalDaytonaEnv(this.options.env ?? null)) return config;
    const staging = brain.env === "staging";
    if (await this.localBrainSupported(sandboxId, staging)) return config;
    const { brainPolicy: _unsafe, ...rest } = config;
    this.options.logger.warn("daytona.local_brain_withheld", { brandId, sandboxId, reason: staging
      ? "the sandbox's installer predates the read-only staging Brain policy of a fresh local sandbox; it runs without a Brain until its snapshot is upgraded"
      : "the sandbox's zs-config-apply predates a read-only Brain policy; the local sandbox runs without a Brain until its snapshot is upgraded" });
    return rest;
  }

  /** After `start --detach`: `zs-init status` until it reports ready (it exits 1 until then, and a supervisor left from before a stop can report a moment late), within `readyTimeoutMs`. */
  private async awaitReady(sandboxId: string): Promise<InitStatus> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 60_000);
    let last: OperationError = new OperationError("daytona", null);
    for (;;) {
      const status = await this.options.client.exec(sandboxId, `${INIT} status`, { timeoutS: 30 });
      try {
        if (status.exitCode !== 0) throw new OperationError("daytona", status.exitCode);
        return parseInitStatus(status.output);
      } catch (error) {
        last = error instanceof OperationError ? error : new OperationError("daytona", null);
      }
      if (Date.now() >= deadline) throw last;
      await new Promise((resolve) => setTimeout(resolve, this.options.readyPollMs ?? 2000));
    }
  }

  /**
   * A snapshot is built by hand from one release and never follows later ones, so its tool bridge can lack a tool the server advertises (a routine setting
   * then cannot be saved, with no error anywhere). Read-only: names every required tool missing from the installed runtime and logs an ERROR with the
   * snapshot; the brand keeps running. A probe that cannot answer logs a warning.
   */
  private async checkBridge(brandId: string, sandboxId: string, snapshot: string): Promise<void> {
    try {
      const probe = await this.options.client.exec(sandboxId, bridgeProbeCommand(), { timeoutS: 15 });
      const missing = probe.output.split("\n").map((line) => line.trim()).filter(Boolean);
      if (probe.exitCode === 0 && missing.length === 0) return;
      this.options.logger.error("daytona.snapshot_bridge_stale", { brandId, sandboxId, snapshot, exitCode: probe.exitCode, missing: missing.slice(0, 20), fix: "publish a snapshot from the current production release (image/oci/publish-snapshot.sh) and point DAYTONA_SNAPSHOT at it" });
    } catch (error) {
      this.options.logger.warn("daytona.bridge_probe_failed", { brandId, sandboxId, snapshot, ...failureFields(error) });
    }
  }

  /** `zs-init status` of a running sandbox, or null when it is not (yet) ready or cannot be asked. */
  private async readyStatus(sandboxId: string): Promise<InitStatus | null> {
    try {
      const status = await this.options.client.exec(sandboxId, `${INIT} status`, { timeoutS: 30 });
      return status.exitCode === 0 ? parseInitStatus(status.output) : null;
    } catch {
      return null;
    }
  }

  private pushStep(brandId: string) {
    return async (name: "brain_token" | "metadata_token" | "embed_token" | "speech_token" | "vision_token", account: string, work: () => Promise<void>, optional = false): Promise<void> => {
      try {
        await work();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const denied = /HTTP 403/.test(message);
        // Fixed fields only: the account, the step and the missing role. A token or an upstream body never reaches a log.
        this.options.logger.warn("daytona.credential_push_failed", { brandId, step: name, account, reason: denied ? "iam_denied" : "failed", ...failureFields(error), ...(denied ? { missingRole: "roles/iam.serviceAccountTokenCreator", onAccount: account, grantee: "the agent server's service account" } : {}) });
        if (error instanceof LocalBrainRefusal) throw error;
        if (optional) return;
        throw new Error(denied ? `cannot mint a token for ${account}: the agent server lacks roles/iam.serviceAccountTokenCreator on it` : `${name} push to the Daytona sandbox failed`);
      }
    };
  }

  /**
   * Every credential of the sandbox. `idTokens` is false only on the first boot push, which runs before `zs-brand-ensure` made the brand's group
   * (the speech token is owned by that group): `ensureOnce` then calls `pushIdTokens` right after the brand exists.
   */
  private async push(brandId: string, live: Live, idTokens = true): Promise<void> {
    const { ssh, credentials } = this.options;
    const step = this.pushStep(brandId);
    // A brand the Brain does not serve (no succeeded brain job, not listed; in staging, any brand BRAIN_TOKEN_BRANDS does not name) has no brain
    // policy in its zs-config, so there is no token to mint. An unreadable answer still pushes, as before.
    const brainServed = await credentials.brainServed(brandId).catch(() => true);
    if (brainServed) await step("brain_token", `zs-brain-${brandId.slice(0, 8)}@${this.options.project}.iam.gserviceaccount.com`, async () => {
      // The token is database-wide: a staging server pushes it only to a host whose root policy says staging, so a sandbox on a snapshot older
      // than the namespace (whose broker would write production's zs/ memory stores) never gets it (MLY-412).
      if (brainEnvOf(this.options.env) === "staging") {
        const hostEnv = await ssh.brainHostEnv(live.target, brandId);
        if (hostEnv !== "staging") {
          this.options.logger.error("daytona.brain_env_mismatch", { brandId, expected: "staging", hostEnv });
          throw new Error("the sandbox's brain policy is not staging");
        }
      }
      // A local sandbox gets the token only when its root policy is read-only; with no policy (the Brain was withheld at boot) there is nothing to push a token to.
      if (isLocalDaytonaEnv(this.options.env)) {
        if (await this.refuseWritableLocalBrain(brandId, live.sandboxId) === "absent") { this.options.logger.warn("daytona.local_brain_withheld", { brandId, sandboxId: live.sandboxId, reason: "this local sandbox holds no Brain policy: no brain token pushed" }); return; }
      }
      await ssh.installBrainToken(live.target, brandId, await credentials.mintBrain(brandId));
    });
    await step("metadata_token", brandAccount(brandId, this.options.project), async () => ssh.installMetadataToken(live.target, brandId, await credentials.mintMetadata(brandId)));
    if (idTokens) await this.pushIdTokens(brandId, live);
    await this.syncMetaGrant(brandId, live.target);
    live.lastPushAt = this.now();
  }

  private async syncMetaGrant(brandId: string, target: SshTarget): Promise<void> {
    try { await this.options.credentials.syncMetaGrant?.(brandId, target); }
    catch { this.options.logger.warn("daytona.meta_grant_sync_failed", { brandId, reason: "sync_failed" }); }
  }

  /**
   * The audience-bound ID tokens the VM's `zs-embed-token` and `zs-speech-token` timers make from the metadata server, minted for the brand's own
   * account and installed by the root helper `zs-id-token-install`. They only add semantic Brain search (the embeddings proxy) and voice (the speech
   * proxy). A sandbox on an older image has no helper and a proxy may not know the brand yet: that is logged and never fails the push, so search
   * stays keyword-only and voice off until a later push succeeds.
   */
  private async pushIdTokens(brandId: string, live: Live): Promise<void> {
    const { ssh, credentials } = this.options;
    const step = this.pushStep(brandId);
    const account = brandAccount(brandId, this.options.project);
    const served = await credentials.brainServed(brandId).catch(() => false);
    void this.ensureIdAccess(brandId);
    if (served) await step("embed_token", account, async () => ssh.installIdToken(live.target, brandId, "embed", await credentials.mintIdToken(brandId, "embed")), true);
    await this.pushChatTokens(brandId, live);
  }

  /**
   * Once per process and brand (and again after a failure): the registry object the proxies need before they accept the brand's token
   * (`id-access.ts`). Started without awaiting, so its listing and writes never add to `ensure`; the proxies refuse the brand until it lands and the next push finds the tokens already in place. Optional like the token pushes: a denied step logs the exact missing role.
   */
  private async ensureIdAccess(brandId: string): Promise<void> {
    const { credentials, logger } = this.options;
    if (!credentials.ensureIdAccess || this.accessEnsured.has(brandId) || this.accessRunning.has(brandId)) return;
    this.accessRunning.add(brandId);
    try {
      const result = await credentials.ensureIdAccess(brandId);
      this.accessEnsured.add(brandId);
      if (result?.registryBrandMismatch) logger.warn("daytona.id_access_registry_brand_mismatch", { brandId });
    } catch (error) {
      const step = error instanceof IdAccessError ? error.step : "unknown";
      logger.warn("daytona.id_access_failed", { brandId, step, reason: error instanceof IdAccessError && error.status === 403 ? "iam_denied" : "failed", ...failureFields(error), ...(error instanceof IdAccessError && error.status === 403 ? { missingRole: ID_ACCESS_MISSING_ROLE[error.step], grantee: "the agent server's service account" } : {}) });
    } finally {
      this.accessRunning.delete(brandId);
    }
  }

  /**
   * The speech token's group `g_<brand12>` is made by `zs-chat-ensure` with the brand's first chat, so before it the helper writes nothing and exits
   * `SPEECH_PENDING_EXIT`. That is a state, not a failure: an INFO line, and the next `ensure` of the live sandbox asks again (a VM's timer does the same
   * every 30 minutes).
   */
  private async pushChatTokens(brandId: string, live: Live): Promise<void> {
    const wasPending = live.speechPending;
    const speech = await this.pushGroupToken(brandId, live, "speech");
    const vision = await this.pushGroupToken(brandId, live, "vision");
    live.speechPending = speech || vision;
    // A token that was waiting for the brand's group has landed: chats set up meanwhile have voice off in their settings until set up again.
    if (wasPending && !live.speechPending) this.options.ssh.forgetChats?.(live.target, brandId);
  }

  /** `speech` and `vision` tokens are chat-readable files owned by the brand group; both wait for it. True while this one is still pending. */
  private async pushGroupToken(brandId: string, live: Live, kind: "speech" | "vision"): Promise<boolean> {
    const { ssh, credentials } = this.options;
    const operation = `${kind}_token` as const;
    let pending = false;
    await this.pushStep(brandId)(operation, brandAccount(brandId, this.options.project), async () => {
      try {
        await ssh.installIdToken(live.target, brandId, kind, await credentials.mintIdToken(brandId, kind));
      } catch (error) {
        if (!(error instanceof OperationError) || error.operation !== operation || error.exitCode !== SPEECH_PENDING_EXIT) throw error;
        pending = true;
        this.options.logger.info(`daytona.${kind}_token_pending`, { brandId });
      }
    }, true);
    return pending;
  }

  private armIdle(brandId: string, live: Live, minutes: number): void {
    live.idleToken += 1;
    const token = live.idleToken;
    const set = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const fire = (): void => {
      if (live.idleToken !== token || this.live.get(brandId) !== live) return;
      if (this.options.links.leases(brandId) > 0) { this.logIdleBlocked(brandId); this.armIdle(brandId, live, minutes); return; }
      void this.exclusive(brandId, () => this.idleStopOnce(brandId, live, token)).catch((error) => this.options.logger.warn("daytona.idle_stop_failed", { brandId, errorClass: error instanceof Error ? error.name : "unknown" }));
    };
    live.idle = set(fire, Math.max(1, minutes) * 60_000);
    live.idle.unref?.();
  }

  /** An idle timer that finds a lease held does nothing and re-arms: say how many and who (oldest first), so a lease that is never released is visible. */
  private logIdleBlocked(brandId: string): void {
    this.options.logger.info("daytona.idle_blocked_by_lease", { brandId, leases: this.options.links.leases(brandId), holders: this.options.links.holders(brandId) });
  }

  /** The idle stop: a sandbox made from another snapshot is deleted instead of stopped when that is safe (see `retireIfStale`), so the next ensure builds it anew. */
  private async idleStopOnce(brandId: string, live: Live, token: number): Promise<void> {
    // Only the sandbox this timer was armed for, and only while nothing has used it since: an ensure after the timer fired re-armed the idle clock, and a lease taken
    // while this waited behind another call means a turn is using the sandbox. Either way it is neither stopped nor retired.
    if (this.live.get(brandId) !== live || live.idleToken !== token) return;
    if (this.options.links.leases(brandId) > 0) { this.logIdleBlocked(brandId); this.armIdle(brandId, live, (await this.options.settings(brandId)).idleStopMinutes); return; }
    if (this.options.upgrade) {
      try {
        const [settings, sandbox] = await Promise.all([this.options.settings(brandId), this.options.client.get(live.sandboxId)]);
        const retired = await this.retireIfStale(brandId, live, sandbox, settings.snapshot, "idle");
        if (retired) { retired.release(); return; }
        // A stale sandbox whose retire was not done stays started (and so live, where the sweep sees it) for a bounded number of idle periods; stopped, nothing
        // would look at it again until the brand's next message, which then runs on the old snapshot.
        // A blocked move (`upgradeBlocked`) would be refused again: that sandbox is stopped like any other, not kept started for the sweep.
        const from = sandbox.labels[SNAPSHOT_LABEL] ?? null;
        const stale = (from !== settings.snapshot && !this.upgradeBlockedFor(brandId, from, settings.snapshot)) || !!live.strayLayer;
        const keeps = live.staleIdleKeeps ?? 0;
        if (stale && sandbox.state === "started" && keeps < (this.options.staleIdleKeeps ?? 6)) {
          await this.options.client.refreshActivity(sandbox.id);
          live.staleIdleKeeps = keeps + 1;
          this.options.logger.info("daytona.idle_stop_kept_stale", { brandId, sandboxId: sandbox.id, keeps: keeps + 1 });
          this.armIdle(brandId, live, settings.idleStopMinutes);
          return;
        }
      } catch (error) {
        this.options.logger.warn("daytona.snapshot_upgrade_failed", { brandId, sandboxId: live.sandboxId, reason: "check_failed", ...failureFields(error) });
        this.recordUpgrade(brandId, { trigger: "idle", outcome: "failed", reason: "check_failed", sandboxId: live.sandboxId, from: null, to: null, ...operationFields(error) });
      }
    }
    await this.stopOnce(brandId);
  }

  /** While the sandbox is live, pushes every credential again each `backgroundRefreshMs`; a failure is logged (fixed fields, no token) and tried again next time. */
  private armRefresh(brandId: string, live: Live): void {
    live.refreshToken += 1;
    const token = live.refreshToken;
    const set = this.options.setRefreshTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const fire = (): void => {
      if (live.refreshToken !== token || this.live.get(brandId) !== live) return;
      void this.exclusive(brandId, async () => {
        if (live.refreshToken !== token || this.live.get(brandId) !== live) return;
        try {
          await this.push(brandId, live);
        } catch (error) {
          this.options.logger.warn("daytona.background_refresh_failed", { brandId, sandboxId: live.sandboxId, errorClass: error instanceof Error ? error.name : "unknown" });
        }
      }).finally(() => { if (live.refreshToken === token && this.live.get(brandId) === live) this.armRefresh(brandId, live); });
    };
    set(fire, this.options.backgroundRefreshMs ?? 30 * 60_000).unref?.();
  }

  private async stopOnce(brandId: string): Promise<void> {
    const live = this.live.get(brandId);
    if (live) { live.idleToken += 1; live.refreshToken += 1; }
    this.options.links.close(brandId);
    if (live) await this.closeConnections(live.target);
    const sandbox = live ? { id: live.sandboxId } : await this.find(brandId);
    this.live.delete(brandId);
    if (!sandbox) return;
    try { fs.rmSync(path.join(this.options.secretDir, `dt-${sandbox.id}.secret`), { force: true }); } catch { /* best effort */ }
    await this.options.client.stop(sandbox.id);
    this.options.logger.info("daytona.stopped", { brandId, sandboxId: sandbox.id });
  }
}

export interface DaytonaProviderDeps {
  config: ServerConfig;
  logger: Logger;
  pg: ReadOnlyPg;
  tokens: TokenSource;
  secrets: { get(name: string): Promise<string | null> };
  /** The SSH runner (the same object the router's `exec` is); the Daytona path needs its token-install and target-aware methods. */
  exec: Exec;
  syncMetaGrant?(brandId: string, target: SshTarget): Promise<void>;
  /** Tests inject a fake Daytona. */
  client?: DaytonaClient;
  /** Tests inject the bucket the pinned code layer is read from; otherwise the server's own Cloud Storage access. */
  codeLayerSource?: CodeLayerSource;
  /** The server's side of replacing a sandbox whose snapshot is not the effective one (`snapshot-upgrade.ts`); optional. */
  upgrade?: SnapshotUpgrade;
  /** Whether this environment runs the brand's sandbox (`brandRunsHere`); absent: every brand. */
  runsBrand?(brandId: string): Promise<boolean>;
}

export const DAYTONA_API_KEY_SECRET = "zs-daytona-api-key";
const BRAND_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Daytona client that reads the API key (secret `zs-daytona-api-key`) on first use, so building the provider needs no key. */
function lazyClient(deps: DaytonaProviderDeps, keyFile: string): DaytonaClient {
  let inner: Promise<DaytonaClient> | null = null;
  const get = (): Promise<DaytonaClient> => {
    inner ??= (async () => {
      const fromEnv = process.env.DAYTONA_API_KEY?.trim();
      // Read once, then removed: every ssh the server spawns inherits process.env, and the Claude session's ssh must never carry the key.
      delete process.env.DAYTONA_API_KEY;
      const key = fromEnv || (await deps.secrets.get(DAYTONA_API_KEY_SECRET))?.trim();
      if (!key) throw new Error(`secret ${DAYTONA_API_KEY_SECRET} is missing`);
      // The zs-ws-connect ProxyCommand reads the key from this 0600 file: not from the environment every child process inherits.
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
      return new SdkDaytonaClient({ apiKey: key, ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}) });
    })();
    inner.catch(() => { inner = null; });
    return inner;
  };
  return {
    findByLabels: async (labels) => (await get()).findByLabels(labels),
    get: async (id) => (await get()).get(id),
    create: async (input) => (await get()).create(input),
    start: async (id) => (await get()).start(id),
    recover: async (id) => (await get()).recover(id),
    stop: async (id) => (await get()).stop(id),
    delete: async (id) => (await get()).delete(id),
    setLabels: async (id, labels) => (await get()).setLabels(id, labels),
    uploadFile: async (id, remotePath, content, mode) => (await get()).uploadFile(id, remotePath, content, mode),
    downloadFile: async (id, remotePath) => (await get()).downloadFile(id, remotePath),
    exec: async (id, command, options) => (await get()).exec(id, command, options),
    signedPreviewUrl: async (id, port, seconds) => (await get()).signedPreviewUrl(id, port, seconds),
    expireSignedPreviewUrl: async (id, port, token) => (await get()).expireSignedPreviewUrl(id, port, token),
    refreshActivity: async (id) => (await get()).refreshActivity(id),
  };
}

const sshOf = (exec: Exec): SshRunner => {
  const ssh = exec as Partial<SshRunner>;
  if (typeof ssh.baseArgs !== "function" || typeof ssh.installBrainToken !== "function" || typeof ssh.installMetadataToken !== "function" || typeof ssh.installIdToken !== "function" || typeof ssh.ensureBrand !== "function") throw new Error("Daytona sandboxes need the SSH runner as exec");
  return exec as SshRunner;
};

/**
 * Builds the provider from the server's own pieces. Synchronous and free of I/O: the API key, CA and zs-config are all read on the first `ensure`.
 * Settings are the deployed DAYTONA_SNAPSHOT and DAYTONA_IDLE_STOP_MINUTES for every brand; the zs-config comes from `buildDaytonaZsConfig`.
 */
/**
 * The brain token of a brand's sandbox, minted for the brand's own `zs-brain-<8 hex>` account. A staging server mints with `spanner.data` only,
 * so no broker it talks to, however old, can change the schema of a production database (MLY-412); a local sandbox (read-only Brain) mints the same data-only token, so its credential never carries DDL; an unknown label mints nothing.
 */
export function daytonaBrainMinter(tokens: TokenSource, project: string, daytonaEnv: string | null, fetchFn: FetchFn = fetch): (brandId: string) => Promise<MintedToken> {
  return async (brandId) => iamTokenMinter(tokens, fetchFn, isLocalDaytonaEnv(daytonaEnv) ? STAGING_BRAIN_SCOPES : brainScopesFor(brainEnvOf(daytonaEnv)))(brainAccount(brandId, project));
}

/** The server's object store as a code layer source: its typed over-limit answer becomes the layer's `too_large`, any other failure `fetch_failed`. */
export function codeLayerSourceOf(store: Pick<ObjectStore, "download">): CodeLayerSource {
  return {
    download: async (uri, maxBytes) => {
      try { return await store.download(uri, maxBytes); } catch (error) { if (error instanceof ObjectTooLarge) throw new CodeLayerTooLarge(); throw error; }
    },
  };
}

/** Whether this environment serves the brand a Brain (its sandbox's broker gets a policy); also asked by server work that writes the brand's Brain. */
export function brainServedFor(config: Pick<ServerConfig, "daytona" | "brainTokenBrands">, pg: Pick<ReadOnlyPg, "query">): (brandId: string) => Promise<boolean> {
  return async (brandId) => {
    // A staging Brain is opt-in per brand: only BRAIN_TOKEN_BRANDS (kept equal to staging_brain_brands, the IAM list), never a seeded brain job (MLY-412).
    if (brainEnvOf(config.daytona.env) === "staging") return brandId in config.brainTokenBrands;
    const brain = await pg.query<{ one: number }>("SELECT 1 AS one FROM provisioning_jobs WHERE brand_id = $1 AND kind = 'brain' AND status = 'succeeded' LIMIT 1", [brandId]);
    if (brain === null) throw new Error("provisioning_jobs could not be read");
    return brain.length > 0 || brandId in config.brainTokenBrands;
  };
}

export function createDaytonaProvider(deps: DaytonaProviderDeps): DaytonaProvider & Pick<DaytonaSandboxProvider, "lease" | "targetFor" | "shutdown"> {
  const { config, pg } = deps;
  const project = config.project;
  const ssh = sshOf(deps.exec);
  // The service passes the environment `runtimeEnvironment` resolved (DAYTONA_ENV checked against SUBSCRIPTION); never guess one here.
  const env = config.daytona.env;
  if (!env) throw new Error("DAYTONA_ENV is required for the Daytona provider");
  // Every brand runs the snapshot this server was deployed with (DAYTONA_SNAPSHOT): there is no per-brand override, so no brand can be left on an older image.
  const settings = async (brandId: string): Promise<DaytonaRuntimeSettings> => {
    if (!BRAND_ID_RE.test(brandId)) throw new Error("invalid brand id");
    if (!config.daytona.cloudSqlPrivateIp) throw new Error("DAYTONA_CLOUD_SQL_IP is not set");
    const snapshot = config.daytona.defaultSnapshot;
    if (!snapshot) throw new Error("no Daytona snapshot: set DAYTONA_SNAPSHOT");
    return { snapshot, idleStopMinutes: config.daytona.defaultIdleStopMinutes, codeLayer: config.daytona.codeLayer };
  };
  const brainServed = brainServedFor(config, pg);
  const zsConfig = async (brandId: string): Promise<Record<string, unknown>> => {
    const served = await brainServed(brandId);
    const caPem = config.daytona.pgCaSecret ? ((await deps.secrets.get(config.daytona.pgCaSecret)) ?? null) : null;
    return buildDaytonaZsConfig({ brandId, project, daytona: config.daytona, pg: config.pg, caPem, brainServed: served, footageBucket: config.footageBucket });
  };
  const apiKeyFile = path.join(config.stateDir, "ssh", "relay", "daytona-api-key");
  const links = new BrandLinks({
    sshArgs: (target, brandId) => ssh.baseArgs(ssh.user(brandId), target, false),
    forward: { remotePort: 15432, get targetHost(): string { if (!config.daytona.cloudSqlPrivateIp) throw new Error("DAYTONA_CLOUD_SQL_IP is not set"); return config.daytona.cloudSqlPrivateIp; }, targetPort: 5432 },
    logger: deps.logger,
  });
  return new DaytonaSandboxProvider({
    client: deps.client ?? lazyClient(deps, apiKeyFile), apiKeyFile, ssh, links, logger: deps.logger, env, project,
    knownHostsFile: path.join(config.stateDir, "ssh", "known_hosts"), secretDir: path.join(config.stateDir, "ssh", "relay"),
    settings, zsConfig, sandboxSshKeys: config.daytona.sandboxSshKeys,
    upgradeSweepMs: config.daytona.upgradeSweepSeconds * 1000, upgradeDeadlineMs: config.daytona.upgradeDeadlineSeconds * 1000,
    ...(deps.upgrade ? { upgrade: deps.upgrade } : {}),
    ...(config.daytona.codeLayer ? { codeLayerSource: deps.codeLayerSource ?? codeLayerSourceOf(googleObjectStore(deps.tokens)) } : {}), ...(deps.runsBrand ? { runsBrand: deps.runsBrand } : {}),
    credentials: {
      mintBrain: daytonaBrainMinter(deps.tokens, project, config.daytona.env),
      mintMetadata: metadataTokenMinter(deps.tokens, project),
      mintIdToken: idTokenMinter(deps.tokens, project),
      ensureIdAccess: idAccessEnsurer(deps.tokens, project),
      brainServed,
      ...(deps.syncMetaGrant ? { syncMetaGrant: deps.syncMetaGrant } : {}),
    },
  });
}
