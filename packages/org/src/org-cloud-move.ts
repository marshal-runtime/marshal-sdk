/* eslint-disable no-await-in-loop -- the handover wait and the envelope retries are bounded polls */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  OrgApiError,
  checkEnvelopeAgainstCheckpoint,
  collectEnvelope,
  isCloudHostId,
  isOrgWorkspaceId,
  type OrgClient,
  type OrgCloudRun,
  type OrgCloudRunStarted,
  parseOrgCloudRunRequest,
  parseOrgPlacementRequest,
} from "@marshal/agent-runtime-org";

import type { OrgReturnedMessage, OrgCloudMoveStatusResult, OrgCloudRunSummary, OrgCloudSessionSummary, OrgContinueCloudRequest, OrgContinueCloudResult, OrgContinueHereRequest, OrgContinueHereResult, CreateFromNativeStateError, OrgFolderCandidate, OrgMoveToCloudRequest, OrgMoveToCloudResult, OrgPlacementChoice, OrgPlacementPreviewRequest, OrgPlacementPreviewResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import type { RuntimeNativeSessionState } from "../host-deps";
import type { OrgCloudMoveEntry, OrgCloudMoveStore } from "./org-cloud-move-store";
import type { OrgCloudStrandedStore } from "./org-cloud-stranded-store";
import { classifyOrgFailure } from "./org-errors";
import {
  buildManifest,
  CLOUD_MOUNT_ID,
  closeInterruptedToolCalls,
  previewOf,
  CLOUD_MOUNT_PATH,
  repoRootSpellings,
  rewriteTranscriptPaths,
} from "./org-placement";
import type { OrgFlags } from "./org-service";
import type { OrgSessionSharing } from "./org-session-sharing";
import {
  buildWipBundle,
  isRefusal,
  MAX_BUNDLE_BYTES,
  parseRemoteRepo,
  planWip,
  STAGING_TIMEOUT_MS,
  WipError,
  type WipBundle,
  type WipPlan,
  type WipRefusal,
} from "./org-wip-bundle";

const log = createLogger("OrgCloudMove");

const MAX_RETURNED_MESSAGES = 20;
const MAX_RETURNED_TEXT_CHARS = 64 * 1024;

/**
 * The owner's unrun messages the cloud gives back on the lease answer (`returnedMessages`, runtime
 * inbox contract). The answer comes from a remote server, so the list is read defensively and capped.
 */
export function readReturnedMessages(view: unknown): OrgReturnedMessage[] {
  const raw: unknown =
    typeof view === "object" && view !== null ? Reflect.get(view, "returnedMessages") : undefined;
  if (!Array.isArray(raw)) return [];
  const messages: OrgReturnedMessage[] = [];
  for (const entry of raw.slice(0, MAX_RETURNED_MESSAGES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const text: unknown = Reflect.get(entry, "text");
    const clientMsgId: unknown = Reflect.get(entry, "clientMsgId");
    if (typeof text !== "string" || text.trim() === "") continue;
    messages.push({
      clientMsgId: typeof clientMsgId === "string" ? clientMsgId : "",
      text: text.slice(0, MAX_RETURNED_TEXT_CHARS),
    });
  }
  return messages;
}

const LEASE_TTL_SECONDS = 300;
const DEFAULT_HEARTBEAT_MS = (LEASE_TTL_SECONDS / 3) * 1000;
/** How long Continue here waits for sends already on their way before it takes the lease: a request times out after 15 s, and a send needs a post and possibly a cancel after connecting, so the bound is about twice that plus connect time. */
const SEND_SETTLE_MS = 40_000;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;
const STALE_RETRIES = 3;

export type CloudMoveClient = Pick<
  OrgClient,
  | "supports"
  | "whoami"
  | "getSession"
  | "getTranscript"
  | "getCloudCapabilities"
  | "getLease"
  | "acquireLease"
  | "heartbeatLease"
  | "releaseLease"
  | "requestLeaseHandover"
  | "putEnvelope"
  | "getEnvelopeInfo"
  | "getEnvelope"
  | "moveToCloud"
  | "getCloudRun"
  | "putMountBundle"
  | "getWorkspace"
>;

/** What the desktop alone knows about a session's files (flag `org.placement`). */
export interface CloudMovePlacementSessions {
  /** The session's working directory and how many child sessions are still running; null when the session is unknown here. */
  describe(sessionId: string): Promise<{ cwd: string; runningChildren: number } | null>;
  /** Resolves once the session has no running turn, or rejects on abort or after `maxMs`. */
  waitForIdle(sessionId: string, maxMs: number, signal: AbortSignal): Promise<void>;
}

type PlacementPlanned =
  | { kind: "plan"; plan: WipPlan; runningChildren: number; sessionCwd: string }
  | { kind: "none"; refusal: WipRefusal }
  | { kind: "error"; error: string };

const WAIT_FOR_TURN_MS = 10 * 60_000;

interface MoveTrack {
  published: boolean;
  refreshed: boolean;
  /** The move's own staging controller, so only it is released when the move ends. */
  staging?: AbortController;
}

const wipFailureCode = (error: unknown): string => {
  if (!(error instanceof WipError)) return "placement-failed";
  return (
    {
      cancelled: "placement-cancelled",
      "staging-timeout": "placement-staging-timeout",
      "bundle-too-large": "placement-too-large",
      "git-failed": "placement-failed",
    } as const
  )[error.code];
};

const sameRepo = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** What the cloud move needs from the session manager, kept free of any runtime specifics. */
export interface CloudMoveSessions {
  /** Refuses local sends, stops the running turn at a safe point and closes the backend session. */
  detach(sessionId: string): Promise<void>;
  /** Lifts or sets the refusal of local sends. */
  setLocked(sessionId: string, locked: boolean): void;
  exportNative(sessionId: string): Promise<RuntimeNativeSessionState | null>;
  importNative(sessionId: string, state: RuntimeNativeSessionState): Promise<boolean>;
}

/** What Continue here needs to rebuild a session this computer has no copy of. */
export interface CloudOnlyContinue {
  hasLocalSession(sessionId: string): boolean;
  /** Registered local workspaces linked to the organization workspace. */
  foldersFor(orgWorkspaceId: string): Promise<OrgFolderCandidate[]>;
  /** True when `folder` is an existing directory. */
  isFolder(folder: string): boolean;
  createFromNative(request: {
    sessionId: string;
    name: string;
    workspace: { repoPath: string } | { workspaceName: string };
    state: RuntimeNativeSessionState;
  }): Promise<{ success: true } | { success: false; error: CreateFromNativeStateError }>;
}

export interface OrgCloudMoveDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<CloudMoveClient | null>;
  getSignedInOrgId: () => string | undefined;
  sharing: Pick<OrgSessionSharing, "preview" | "share">;
  /**
   * Starts a cloud run with a Slack destination, which the client package's `moveToCloud` does not
   * carry. Only used when the person picked a channel.
   */
  startCloudRunWithDestination?: (
    sessionId: string,
    body: Record<string, unknown>,
  ) => Promise<OrgCloudRunStarted>;
  sessions: CloudMoveSessions;
  /** Set to offer Continue here for sessions with no local copy. */
  cloudOnly?: CloudOnlyContinue;
  /** Needed for `org.placement`; without it a move carries the conversation only. */
  placement?: CloudMovePlacementSessions;
  store: OrgCloudMoveStore;
  /** Remembers refused cloud-only continues across restarts; without it they are kept in memory only. */
  strandedStore?: OrgCloudStrandedStore;
  /** Messages written for the cloud that never reached it; handed back when the session is taken back. */
  remote?: {
    reclaim(sessionId: string): Promise<OrgReturnedMessage[]>;
    /** Stops sends and flushes for the session until the returned call; held for the whole of Continue here. */
    beginReturn(sessionId: string): () => void;
    /** Waits (bounded) for the sends of the session that are already on their way. */
    settleSends(sessionId: string, maxMs: number): Promise<void>;
  };
  /** This desktop's lease host id; stable while the app runs. */
  hostId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the lease is renewed while a slow upload runs. */
  heartbeatMs?: number;
  /** How long Continue here waits for the cloud to release after asking it to. */
  handoverTimeoutMs?: number;
  /** The time the re-plan and the bundle build each get after the turn stops. Default 30 s. */
  stagingTimeoutMs?: number;
  pollIntervalMs?: number;
  maxDecompressedBytes?: number;
}

function summarize(run: OrgCloudRun): OrgCloudRunSummary {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.link ? { link: run.link } : {}),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Prepared =
  | { success: false; error: string }
  | { success: true; client: CloudMoveClient; orgId: string };

/** Applies the stored locks to the session manager; run at boot before any session can send. */
export function restorePersistedCloudLocks(
  store: OrgCloudMoveStore,
  setLocked: (sessionId: string, locked: boolean) => void,
): void {
  for (const move of store.load()) setLocked(move.sessionId, true);
}

/**
 * Moves a shared session to the organization's cloud and brings it back. Inert unless
 * `org.cloudMove` is on: with the flag off no method touches the network or the disk.
 */
export class OrgCloudMove {
  private readonly moving = new Set<string>();
  /** Cloud-only sessions whose continue was refused after this desktop took the lease; the server now lists them as local. */
  private strandedCache: Map<string, { orgId: string; row: OrgCloudSessionSummary }> | undefined;
  private readonly staging = new Map<string, AbortController>();
  /** Previews keep their own controllers, so opening the dialog again never aborts a move that is running. */
  private readonly previewing = new Map<string, AbortController>();

  constructor(private readonly deps: OrgCloudMoveDeps) {}

  private get placementEnabled(): boolean {
    return this.enabled && this.deps.getFlags().placement === true && !!this.deps.placement;
  }

  /** Stops the staging of a move that is building its bundle (or waiting for the turn to end), and a preview that is planning. */
  cancelPlacementStaging(sessionId: string): { success: true } {
    this.staging.get(sessionId)?.abort();
    this.previewing.get(sessionId)?.abort();
    return { success: true };
  }

  private async planPlacement(
    client: CloudMoveClient,
    sessionId: string,
    orgWorkspaceId: string,
    choice: OrgPlacementChoice,
    signal?: AbortSignal,
  ): Promise<PlacementPlanned> {
    const placement = this.deps.placement;
    if (!placement) return { kind: "error", error: "placement-unavailable" };
    if (!isOrgWorkspaceId(orgWorkspaceId)) return { kind: "error", error: "invalid-workspace" };
    let allowed: string[];
    try {
      const workspace = await client.getWorkspace(orgWorkspaceId);
      allowed = workspace.repositories
        .map((entry) => parseRemoteRepo(entry.repository))
        .filter((entry): entry is string => entry !== undefined);
    } catch (error) {
      return { kind: "error", error: classifyOrgFailure(error).code };
    }
    const described = await placement.describe(sessionId);
    if (!described) return { kind: "error", error: "placement-unavailable" };
    try {
      const result = await planWip({
        cwd: described.cwd,
        trackedOnly: choice.trackedOnly === true,
        excludePaths: choice.excludePaths ?? [],
        repoAllowed: (repo) => allowed.some((entry) => sameRepo(entry, repo)),
        signal,
      });
      if (isRefusal(result)) return { kind: "none", refusal: result };
      return {
        kind: "plan",
        plan: result,
        runningChildren: described.runningChildren,
        sessionCwd: described.cwd,
      };
    } catch (error) {
      log.warn(`Placement plan failed: code=${wipFailureCode(error)}`);
      return { kind: "error", error: wipFailureCode(error) };
    }
  }

  async placementPreview(request: OrgPlacementPreviewRequest): Promise<OrgPlacementPreviewResult> {
    if (!this.placementEnabled) return { success: false, error: "disabled" };
    const prepared = await this.connect();
    if (!prepared.success) return prepared;
    const { client } = prepared;
    if (!client.supports("placement")) return { success: false, error: "placement-unsupported" };
    const shared = await this.deps.sharing.preview(request.sessionId);
    if (!shared.success) return { success: false, error: shared.error };
    const controller = this.beginStaging(request.sessionId, this.previewing);
    const planned = await this.planPlacement(
      client,
      request.sessionId,
      shared.orgWorkspaceId,
      { trackedOnly: request.trackedOnly, excludePaths: request.excludePaths },
      controller.signal,
    ).finally(() => this.releaseStaging(request.sessionId, controller, this.previewing));
    if (planned.kind === "error") return { success: false, error: planned.error };
    if (planned.kind === "none") {
      return {
        success: false,
        error: "no-git-work",
        reason: planned.refusal.code,
        message: planned.refusal.message,
      };
    }
    return { success: true, preview: previewOf(planned.plan, planned) };
  }

  /** Forgets the staging of a session only when it is still the caller's own, so a newer preview or move keeps its Cancel. */
  private releaseStaging(
    sessionId: string,
    controller: AbortController | undefined,
    owners: Map<string, AbortController> = this.staging,
  ): void {
    if (controller && owners.get(sessionId) === controller) owners.delete(sessionId);
  }

  private beginStaging(
    sessionId: string,
    owners: Map<string, AbortController> = this.staging,
  ): AbortController {
    owners.get(sessionId)?.abort();
    const controller = new AbortController();
    owners.set(sessionId, controller);
    return controller;
  }

  private get enabled(): boolean {
    return this.deps.getFlags().cloudMove === true;
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Locks every session that has a stored move, whatever the flag or sign-in state: a session the
   * cloud holds stays read-only until it is continued or explicitly released.
   */
  restoreLocks(): void {
    restorePersistedCloudLocks(this.deps.store, this.deps.sessions.setLocked);
  }

  /** Lifts the read-only lock without restoring anything; the cloud's work stays in the shared transcript. Needs no network. */
  async releaseLock(
    sessionId: string,
  ): Promise<{ success: true; returnedMessages?: OrgReturnedMessage[] }> {
    this.deps.store.save(this.deps.store.load().filter((m) => m.sessionId !== sessionId));
    this.deps.sessions.setLocked(sessionId, false);
    const returned = (await this.deps.remote?.reclaim(sessionId)) ?? [];
    return returned.length > 0 ? { success: true, returnedMessages: returned } : { success: true };
  }

  /** Sessions the cloud holds, read from the local store only: no network, so a list of rows costs one call. */
  listHeld(): { success: true; sessionIds: string[] } {
    return {
      success: true,
      sessionIds: this.deps.store.load().map((m) => m.sessionId),
    };
  }

  private async connect(): Promise<Prepared> {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    let client: CloudMoveClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return { success: false, error: "unreachable" };
    }
    if (!client) return { success: false, error: "not-signed-in" };
    if (
      !client.supports("sessions") ||
      !client.supports("leases") ||
      !client.supports("cloudRuns")
    ) {
      return { success: false, error: "cloud-unsupported" };
    }
    return { success: true, client, orgId };
  }

  private entryFor(sessionId: string, orgId: string) {
    return this.deps.store.load().find((m) => m.sessionId === sessionId && m.orgId === orgId);
  }

  private saveEntry(entry: OrgCloudMoveEntry): void {
    this.deps.store.save([
      ...this.deps.store
        .load()
        .filter((m) => !(m.sessionId === entry.sessionId && m.orgId === entry.orgId)),
      entry,
    ]);
  }

  private removeEntry(sessionId: string, orgId: string): void {
    this.deps.store.save(
      this.deps.store.load().filter((m) => !(m.sessionId === sessionId && m.orgId === orgId)),
    );
  }

  async getStatus(sessionId: string): Promise<OrgCloudMoveStatusResult> {
    // A stored lock is reported whatever the flag or sign-in state, so it can always be released.
    const held = this.deps.store.load().find((m) => m.sessionId === sessionId);
    const orgId = this.deps.getSignedInOrgId();
    if (held && (!this.enabled || !orgId || held.orgId !== orgId)) {
      return { success: true, placement: "cloud", releaseOnly: true };
    }
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!orgId) return { success: false, error: "not-signed-in" };
    const entry = this.entryFor(sessionId, orgId);
    if (!entry) return { success: true, placement: "local" };
    const moveId = String(entry.movedAt);
    const prepared = await this.connect();
    if (!prepared.success) return { success: true, placement: "cloud", moveId };
    try {
      const view = await prepared.client.getCloudRun(sessionId);
      if (entry.state === "pending" && !this.moving.has(sessionId)) {
        // A move that never finished (crash or lost answer): the cloud's run decides what it was.
        if (!view.run) {
          this.removeEntry(sessionId, orgId);
          this.deps.sessions.setLocked(sessionId, false);
          return { success: true, placement: "local" };
        }
        this.saveEntry({ ...entry, state: "cloud", runId: view.run.id });
      }
      return {
        success: true,
        placement: "cloud",
        moveId,
        ...(view.run ? { run: summarize(view.run) } : {}),
      };
    } catch (error) {
      log.warn(`Cloud run lookup failed: code=${classifyOrgFailure(error).code}`);
      return { success: true, placement: "cloud", moveId };
    }
  }

  async moveToCloud(request: OrgMoveToCloudRequest): Promise<OrgMoveToCloudResult> {
    const track: MoveTrack = { published: false, refreshed: false };
    const result = await this.runMove(request, track).finally(() =>
      this.releaseStaging(request.sessionId, track.staging),
    );
    if (result.success) return result;
    if (track.published) return { ...result, uploaded: true };
    return track.refreshed ? { ...result, orgCopyUpdated: true } : result;
  }

  /** Checks the native state against what the cloud accepts; shared by the early and the post-stop pass. */
  private async checkEnvelope(
    sessionId: string,
    caps: { formats: readonly string[]; maxEnvelopeBytes: number },
    placement?: { roots: readonly string[] },
  ): Promise<
    | { success: false; error: string }
    | { success: true; format: string; gzipped: Uint8Array; interruptedTool?: string }
  > {
    const native = await this.deps.sessions.exportNative(sessionId);
    if (!native) return { success: false, error: "no-native-state" };
    if (!caps.formats.includes(native.format))
      return { success: false, error: "unsupported-format" };
    let bytes = native.bytes;
    let interruptedTool: string | undefined;
    if (placement) {
      // The cloud resumes the transcript at its own path, and a call without a result cannot be resumed.
      if (native.format !== "claude-jsonl") {
        return { success: false, error: "placement-unsupported-format" };
      }
      bytes = rewriteTranscriptPaths(bytes, placement.roots, CLOUD_MOUNT_PATH);
      const closed = closeInterruptedToolCalls(bytes);
      if (closed) {
        bytes = closed.bytes;
        interruptedTool = closed.tool;
      }
    }
    const gzipped = new Uint8Array(gzipSync(bytes));
    if (gzipped.byteLength > caps.maxEnvelopeBytes) {
      return { success: false, error: "envelope-too-large" };
    }
    return {
      success: true,
      format: native.format,
      gzipped,
      ...(interruptedTool ? { interruptedTool } : {}),
    };
  }

  private startWithDestination(
    sessionId: string,
    runRequest: Record<string, unknown>,
    slackDestination: string,
  ): Promise<OrgCloudRunStarted> {
    const start = this.deps.startCloudRunWithDestination;
    if (!start) throw new OrgApiError(422, "invalid-destination", "no Slack destination support");
    return start(sessionId, { ...parseOrgCloudRunRequest(runRequest), slackDestination }).catch(
      (error: unknown) => {
        // A 400 is a refused destination only when the server says so: its own code, or an
        // invalid-request that names the destination field. Any other 400 stays invalid-request.
        if (
          error instanceof OrgApiError &&
          error.status === 400 &&
          (error.code === "invalid-destination" ||
            (error.code === "invalid-request" && /destination/i.test(error.message)))
        ) {
          throw new OrgApiError(422, "invalid-destination", "destination refused");
        }
        throw error;
      },
    );
  }

  private async runMove(
    request: OrgMoveToCloudRequest,
    track: MoveTrack,
  ): Promise<OrgMoveToCloudResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const prepared = await this.connect();
    if (!prepared.success) return prepared;
    const { client, orgId } = prepared;
    const { sessionId } = request;
    if (
      request.slackDestination !== undefined &&
      !/^[CG][A-Z0-9]{2,40}$/.test(request.slackDestination)
    ) {
      return { success: false, error: "invalid-destination" };
    }
    if (this.entryFor(sessionId, orgId)) return { success: false, error: "already-in-cloud" };

    // A cheap early refusal; the check that counts runs again once the turn has stopped.
    const early = await this.deps.sharing.preview(sessionId);
    if (!early.success) return { success: false, error: early.error };
    if (early.label === "restricted") return { success: false, error: "restricted-content" };

    let caps;
    try {
      caps = await client.getCloudCapabilities();
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }
    if (!caps.available) return { success: false, error: "cloud-unavailable" };

    const host = this.deps.hostId;
    // Files travel only when the caller asks for them; a request that says nothing about placement moves the conversation only.
    const choice = this.placementEnabled ? request.placement : undefined;
    const carryFiles = choice !== undefined && choice.mode !== "local-only";
    const staging = carryFiles ? this.beginStaging(sessionId) : undefined;
    track.staging = staging;
    let planned: Extract<PlacementPlanned, { kind: "plan" }> | undefined;
    try {
      if (choice && staging) {
        if (!client.supports("placement") || !caps.placement) {
          return { success: false, error: "placement-unsupported" };
        }
        const first = await this.planPlacement(
          client,
          sessionId,
          early.orgWorkspaceId,
          choice,
          staging.signal,
        );
        if (first.kind === "error") return { success: false, error: first.error };
        if (first.kind === "none" || first.runningChildren > 0 || first.plan.refusals.length > 0) {
          return { success: false, error: "placement-refused" };
        }
        planned = first;
        if (choice.when === "after-turn") {
          try {
            await this.deps.placement?.waitForIdle(sessionId, WAIT_FOR_TURN_MS, staging.signal);
          } catch {
            return { success: false, error: "placement-cancelled" };
          }
        }
      }
    } catch (error) {
      this.releaseStaging(sessionId, staging);
      throw error;
    }

    try {
      try {
        await client.acquireLease(sessionId, { host, ttlSeconds: LEASE_TTL_SECONDS });
      } catch (error) {
        if (classifyOrgFailure(error).code !== "not-found") throw error;
        // The organization cannot lease a session it does not know yet, so this is the earliest the
        // upload can happen. Everything checkable before the turn stops is checked first, the
        // publish is strict (nothing queued, restricted refused), and the post-stop pass redoes it.
        const precheck = await this.checkEnvelope(sessionId, caps);
        if (!precheck.success) return { success: false, error: precheck.error };
        const published = await this.deps.sharing.share(sessionId, { strict: true });
        if (!published.success) {
          if (published.uploaded) track.published = true;
          return { success: false, error: published.error };
        }
        track.published = true;
        await client.acquireLease(sessionId, { host, ttlSeconds: LEASE_TTL_SECONDS });
      }
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }

    this.moving.add(sessionId);
    const stopHeartbeat = this.startHeartbeat(client, sessionId, host);
    let keepLease = false;
    let moved = false;
    let pendingSaved = false;
    try {
      try {
        await this.deps.sessions.detach(sessionId);
      } catch {
        return { success: false, error: "session-busy" };
      }
      // The turn has stopped: what it read and how many messages it wrote are final now.
      const preview = await this.deps.sharing.preview(sessionId);
      if (!preview.success) return { success: false, error: preview.error };
      if (preview.label === "restricted") return { success: false, error: "restricted-content" };
      let finalPlan: WipPlan | undefined;
      let finalSessionCwd: string | undefined;
      let bundle: WipBundle | undefined;
      if (planned && choice && staging) {
        // The turn has stopped: what is on disk is final, so it is planned, scanned and bundled again. The re-plan has its own
        // staging timeout, as the bundle build does.
        const replanSignal = AbortSignal.any([
          staging.signal,
          AbortSignal.timeout(this.deps.stagingTimeoutMs ?? STAGING_TIMEOUT_MS),
        ]);
        const again = await this.planPlacement(
          client,
          sessionId,
          preview.orgWorkspaceId,
          choice,
          replanSignal,
        );
        if (again.kind === "error") {
          const timedOut = again.error === "placement-cancelled" && !staging.signal.aborted;
          return { success: false, error: timedOut ? "placement-staging-timeout" : again.error };
        }
        if (again.kind === "none" || again.runningChildren > 0 || again.plan.refusals.length > 0) {
          return { success: false, error: "placement-refused" };
        }
        finalPlan = again.plan;
        finalSessionCwd = again.sessionCwd;
        try {
          bundle = await buildWipBundle(finalPlan, {
            sessionId,
            maxBundleBytes: Math.min(
              caps.placement?.maxBundleBytes ?? MAX_BUNDLE_BYTES,
              MAX_BUNDLE_BYTES,
            ),
            signal: staging.signal,
            timeoutMs: this.deps.stagingTimeoutMs,
          });
        } catch (error) {
          log.warn(`Placement bundle failed: code=${wipFailureCode(error)}`);
          return { success: false, error: wipFailureCode(error) };
        }
      }
      const envelope = await this.checkEnvelope(
        sessionId,
        caps,
        finalPlan && finalSessionCwd
          ? { roots: repoRootSpellings(finalSessionCwd, finalPlan.repoRoot) }
          : undefined,
      );
      if (!envelope.success) return { success: false, error: envelope.error };
      const { gzipped } = envelope;
      const native = { format: envelope.format };
      // The turn is stopped and every check passed: refresh the upload (owner only; the share path
      // grants nobody and notifies nobody).
      const shared = await this.deps.sharing.share(sessionId, { strict: true });
      if (shared.success ? shared.state === "uploaded" : shared.uploaded) track.refreshed = true;
      if (!shared.success) return { success: false, error: shared.error };
      const digest = sha256(gzipped);

      // Written before the cloud is asked: a crash from here on still leaves the session read-only.
      this.saveEntry({
        sessionId,
        orgId,
        runId: "",
        host,
        movedAt: this.deps.now?.() ?? Date.now(),
        messageCount: preview.messageCount,
        state: "pending",
      });
      pendingSaved = true;
      await client.putEnvelope(sessionId, {
        host,
        format: native.format,
        messageCount: preview.messageCount,
        sha256: digest,
        bytes: gzipped.byteLength,
        body: gzipped,
      });
      await client.heartbeatLease(sessionId, host);
      if (finalPlan && bundle) {
        await client.putMountBundle(sessionId, CLOUD_MOUNT_ID, {
          host,
          sha256: bundle.sha256,
          bytes: bundle.bytes.byteLength,
          body: bundle.bytes,
        });
        await client.heartbeatLease(sessionId, host);
      }
      const manifest = finalPlan
        ? parseOrgPlacementRequest(
            buildManifest({
              sessionId,
              hostId: host,
              boundary: preview.orgWorkspaceId,
              now: new Date(this.deps.now?.() ?? Date.now()),
              plan: finalPlan,
              bundle,
              ...(envelope.interruptedTool ? { midTurn: { tool: envelope.interruptedTool } } : {}),
            }),
          )
        : undefined;
      const runRequest = {
        host,
        envelopeSha256: digest,
        ...(manifest ? { placement: manifest } : {}),
        ...(request.instruction ? { instruction: request.instruction } : {}),
      };
      const started = request.slackDestination
        ? await this.startWithDestination(sessionId, runRequest, request.slackDestination)
        : await client.moveToCloud(sessionId, runRequest);
      this.saveEntry({
        sessionId,
        orgId,
        runId: started.run.id,
        host,
        movedAt: this.deps.now?.() ?? Date.now(),
        messageCount: preview.messageCount,
        state: "cloud",
      });
      moved = true;
      return { success: true, run: summarize(started.run) };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Move to cloud failed: code=${failure.code} status=${failure.status ?? 0}`);
      // 503 changed nothing: the desktop keeps its lease and the session stays local.
      keepLease = error instanceof OrgApiError && error.status === 503;
      return { success: false, error: failure.code };
    } finally {
      stopHeartbeat();
      this.moving.delete(sessionId);
      if (!moved) {
        if (pendingSaved) this.removeEntry(sessionId, orgId);
        this.deps.sessions.setLocked(sessionId, false);
        if (!keepLease) {
          await client.releaseLease(sessionId, { host }).catch(() => undefined);
        }
      }
    }
  }

  /** Renews the lease on a timer while a slow step runs, so an upload past the ttl does not lose it. */
  private startHeartbeat(client: CloudMoveClient, sessionId: string, host: string): () => void {
    const timer = setInterval(() => {
      client.heartbeatLease(sessionId, host).catch((error: unknown) => {
        log.warn(`Lease heartbeat failed: code=${classifyOrgFailure(error).code}`);
      });
    }, this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async continueHere(request: OrgContinueHereRequest): Promise<OrgContinueHereResult> {
    // Filled once the lease is taken: the cloud gives its unrun messages back at that moment only,
    // so they are reported whether or not the restore that follows works.
    const returned: OrgReturnedMessage[] = [];
    // From here until the end the composer and the outbox flush treat the chat as no longer in the cloud, so no message is posted
    // while the lease is being taken back and the reclaim below finds everything that was written.
    const endReturn = this.deps.remote?.beginReturn(request.sessionId);
    try {
      await this.deps.remote?.settleSends(request.sessionId, SEND_SETTLE_MS);
      let result = await this.runContinueHere(request, returned);
      if (result.success) {
        // A post that timed out here may still have been stored: the cloud returns it and the outbox still holds it, under one id.
        const known = new Set(returned.map((m) => m.clientMsgId).filter((id) => id !== ""));
        try {
          const reclaimed = (await this.deps.remote?.reclaim(request.sessionId)) ?? [];
          returned.push(...reclaimed.filter((m) => !known.has(m.clientMsgId)));
        } catch (error) {
          // The cloud's own messages must still reach the composer; only the local outbox could not be read.
          log.warn(
            `Could not recover unsent messages: ${error instanceof Error ? error.name : "error"}`,
          );
          result = { ...result, unsentNotRecovered: true };
        }
      }
      return returned.length > 0 ? { ...result, returnedMessages: returned } : result;
    } finally {
      endReturn?.();
    }
  }

  private async runContinueHere(
    request: OrgContinueHereRequest,
    returned: OrgReturnedMessage[],
  ): Promise<OrgContinueHereResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const prepared = await this.connect();
    if (!prepared.success) return prepared;
    const { client, orgId } = prepared;
    const { sessionId } = request;
    if (this.moving.has(sessionId)) return { success: false, error: "lease-held" };
    const entry = this.entryFor(sessionId, orgId);
    if (!entry) return { success: false, error: "not-in-cloud" };
    const host = this.deps.hostId;
    let acquired = false;
    let stopHeartbeat: (() => void) | undefined;
    try {
      const caps = await client.getCloudCapabilities();
      const gate = await this.takeLeaseBack(
        client,
        sessionId,
        host,
        request.force === true,
        returned,
      );
      if (gate) return gate;
      acquired = true;
      stopHeartbeat = this.startHeartbeat(client, sessionId, host);

      const fetched = await this.fetchVerifiedState(client, sessionId, host, caps, request);
      if (!fetched.success) return fetched.result;
      const { envelope, verdict, bytes } = fetched;
      // Nothing may hold the native file open while it is replaced.
      try {
        await this.deps.sessions.detach(sessionId);
      } catch {
        // The stored entry stays, so the in-memory lock must too.
        this.deps.sessions.setLocked(sessionId, true);
        return { success: false, error: "session-busy" };
      }
      const restored = await this.deps.sessions.importNative(sessionId, {
        format: envelope.format,
        bytes,
      });
      if (!restored) return { success: false, error: "no-native-state" };
      this.removeEntry(sessionId, orgId);
      this.deps.sessions.setLocked(sessionId, false);
      stopHeartbeat();
      stopHeartbeat = undefined;
      await client
        .releaseLease(sessionId, { host, checkpoint: { messageCount: envelope.messageCount } })
        .catch(() => undefined);
      acquired = false;
      return verdict.status === "stale"
        ? { success: true, verdict: "stale-accepted", reason: verdict.reason }
        : {
            success: true,
            verdict: verdict.status,
            ...(verdict.reason ? { reason: verdict.reason } : {}),
          };
    } catch (error) {
      // The session stays locked and tracked, and the lease goes back below, so a retry starts clean.
      const failure = classifyOrgFailure(error);
      log.warn(`Continue here failed: code=${failure.code} status=${failure.status ?? 0}`);
      return { success: false, error: failure.code };
    } finally {
      stopHeartbeat?.();
      if (acquired) await client.releaseLease(sessionId, { host }).catch(() => undefined);
    }
  }

  /**
   * Continue here for a session the cloud holds that this computer has no copy of: takes the lease, checks and
   * downloads the cloud's state and rebuilds a local session with the same id. Needs `org.cloudGroup`.
   */
  async continueCloudSession(request: OrgContinueCloudRequest): Promise<OrgContinueCloudResult> {
    const returned: OrgReturnedMessage[] = [];
    const result = await this.runContinueCloudSession(request, returned);
    if (!result.success && (result.error === "not-found" || result.error === "forbidden")) {
      this.forgetStranded(request.sessionId);
    }
    return returned.length > 0 ? { ...result, returnedMessages: returned } : result;
  }

  private async runContinueCloudSession(
    request: OrgContinueCloudRequest,
    returned: OrgReturnedMessage[],
  ): Promise<OrgContinueCloudResult> {
    const cloudOnly = this.deps.cloudOnly;
    if (!this.enabled || this.deps.getFlags().cloudGroup !== true || !cloudOnly) {
      return { success: false, error: "disabled" };
    }
    const prepared = await this.connect();
    if (!prepared.success) return prepared;
    const { client } = prepared;
    const { sessionId } = request;
    if (this.moving.has(sessionId)) return { success: false, error: "lease-held" };
    if (cloudOnly.hasLocalSession(sessionId)) return { success: false, error: "already-local" };
    const host = this.deps.hostId;
    this.moving.add(sessionId);
    let acquired = false;
    let stopHeartbeat: (() => void) | undefined;
    try {
      const [{ session }, me, caps] = await Promise.all([
        client.getSession(sessionId),
        client.whoami(),
        client.getCloudCapabilities(),
      ]);
      if (session.owner !== me.principal) return { success: false, error: "forbidden" };
      if (session.runtime !== "claude") return { success: false, error: "unsupported-runtime" };
      const folders = await cloudOnly.foldersFor(session.workspaceId);
      let workspace: { repoPath: string } | { workspaceName: string };
      if (request.workspaceName !== undefined) {
        if (!folders.some((folder) => folder.name === request.workspaceName)) {
          return { success: false, error: "invalid-folder", folders };
        }
        workspace = { workspaceName: request.workspaceName };
      } else if (request.repoPath !== undefined) {
        if (!cloudOnly.isFolder(request.repoPath)) {
          return { success: false, error: "invalid-folder", folders };
        }
        workspace = { repoPath: request.repoPath };
      } else if (folders.length === 1 && folders[0]) {
        workspace = { workspaceName: folders[0].name };
      } else {
        return { success: false, error: "needs-folder", folders };
      }
      const gate = await this.takeLeaseBack(
        client,
        sessionId,
        host,
        request.force === true,
        returned,
      );
      if (gate) return gate;
      acquired = true;
      this.rememberStranded({
        id: sessionId,
        title: session.title,
        workspaceId: session.workspaceId,
        turnState: "idle",
        queued: 0,
        lastActivityAt: session.updatedAt,
      });
      stopHeartbeat = this.startHeartbeat(client, sessionId, host);
      const fetched = await this.fetchVerifiedState(client, sessionId, host, caps, request);
      if (!fetched.success) return fetched.result;
      const { envelope, verdict, bytes } = fetched;
      const created = await cloudOnly.createFromNative({
        sessionId,
        name: session.title,
        workspace,
        state: { format: envelope.format, bytes },
      });
      if (!created.success) return { success: false, error: created.error };
      stopHeartbeat();
      stopHeartbeat = undefined;
      await client
        .releaseLease(sessionId, { host, checkpoint: { messageCount: envelope.messageCount } })
        .catch(() => undefined);
      acquired = false;
      this.forgetStranded(sessionId);
      return verdict.status === "stale"
        ? { success: true, verdict: "stale-accepted", reason: verdict.reason }
        : {
            success: true,
            verdict: verdict.status,
            ...(verdict.reason ? { reason: verdict.reason } : {}),
          };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(
        `Continue here for a cloud session failed: code=${failure.code} status=${failure.status ?? 0}`,
      );
      return { success: false, error: failure.code };
    } finally {
      stopHeartbeat?.();
      this.moving.delete(sessionId);
      if (acquired) await client.releaseLease(sessionId, { host }).catch(() => undefined);
    }
  }

  private get stranded(): Map<string, { orgId: string; row: OrgCloudSessionSummary }> {
    this.strandedCache ??= new Map(
      (this.deps.strandedStore?.load() ?? []).map((entry) => [
        entry.sessionId,
        {
          orgId: entry.orgId,
          row: {
            id: entry.sessionId,
            title: entry.title,
            workspaceId: entry.workspaceId,
            turnState: "idle",
            queued: 0,
            lastActivityAt: entry.lastActivityAt,
          },
        },
      ]),
    );
    return this.strandedCache;
  }

  private persistStranded(): void {
    try {
      this.deps.strandedStore?.save(
        [...this.stranded.values()].map(({ orgId, row }) => ({
          sessionId: row.id,
          orgId,
          title: row.title,
          workspaceId: row.workspaceId,
          lastActivityAt: row.lastActivityAt,
        })),
      );
    } catch {
      log.error("Could not save the stranded cloud sessions");
    }
  }

  /** Cloud-only sessions that are waiting for a retry of Continue here after a refusal. */
  listStranded(): OrgCloudSessionSummary[] {
    const orgId = this.deps.getSignedInOrgId();
    return [...this.stranded.values()]
      .filter((kept) => orgId !== undefined && kept.orgId === orgId)
      .map((kept) => kept.row);
  }

  /**
   * Written as soon as the owner's acquire succeeds: it already moved the session's home to this desktop, so
   * the cloud list no longer shows it, and a crash or a poll before the attempt ends must not lose the row.
   */
  private rememberStranded(row: OrgCloudSessionSummary): void {
    const orgId = this.deps.getSignedInOrgId();
    if (orgId === undefined) return;
    this.stranded.set(row.id, { orgId, row });
    this.persistStranded();
  }

  /** Forgets a stranded session: it continued, or it now exists on this computer. */
  forgetStranded(sessionId: string): void {
    if (this.stranded.delete(sessionId)) this.persistStranded();
  }

  /** Checks the envelope against the cloud's checkpoint, downloads it and checks its hash; the caller holds the lease. */
  private async fetchVerifiedState(
    client: CloudMoveClient,
    sessionId: string,
    host: string,
    caps: Awaited<ReturnType<CloudMoveClient["getCloudCapabilities"]>>,
    accept: { acceptStale?: boolean; acceptUnverified?: boolean },
  ): Promise<
    | { success: false; result: OrgContinueHereResult }
    | {
        success: true;
        envelope: Awaited<ReturnType<CloudMoveClient["getEnvelopeInfo"]>>;
        verdict: { status: "fresh" | "stale" | "unverified"; reason?: string };
        bytes: Uint8Array;
      }
  > {
    let verdict: { status: "fresh" | "stale" | "unverified"; reason?: string } = {
      status: "stale",
      reason: "not checked",
    };
    let envelope = await client.getEnvelopeInfo(sessionId);
    for (let attempt = 0; attempt < STALE_RETRIES; attempt += 1) {
      const [view, transcript] = await Promise.all([
        client.getLease(sessionId),
        client.getTranscript(sessionId, { limit: 1 }),
      ]);
      verdict = checkEnvelopeAgainstCheckpoint({
        envelope,
        checkpoint: view.checkpoint,
        cloudHost: caps.cloudHost,
        transcriptMessageCount: transcript.total,
      });
      if (verdict.status !== "stale" || attempt === STALE_RETRIES - 1) break;
      await this.sleep(this.deps.pollIntervalMs ?? 1000);
      envelope = await client.getEnvelopeInfo(sessionId);
    }
    if (verdict.status === "stale" && accept.acceptStale !== true) {
      return {
        success: false,
        result: { success: false, error: "stale-state", reason: verdict.reason },
      };
    }
    if (verdict.status === "unverified" && accept.acceptUnverified !== true) {
      return {
        success: false,
        result: { success: false, error: "unverified-state", reason: verdict.reason },
      };
    }

    const download = await client.getEnvelope(sessionId, {
      host,
      maxBytes: caps.maxEnvelopeBytes,
    });
    const gzipped = await collectEnvelope(download.body, caps.maxEnvelopeBytes);
    if (sha256(gzipped) !== envelope.sha256)
      return { success: false, result: { success: false, error: "envelope-mismatch" } };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        gunzipSync(gzipped, {
          maxOutputLength: this.deps.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
        }),
      );
    } catch {
      return { success: false, result: { success: false, error: "envelope-invalid" } };
    }
    return { success: true, envelope, verdict, bytes };
  }

  /** Returns a failure result, or undefined once this desktop holds the lease. */
  private async takeLeaseBack(
    client: CloudMoveClient,
    sessionId: string,
    host: string,
    force: boolean,
    returned: OrgReturnedMessage[],
  ): Promise<OrgContinueHereResult | undefined> {
    let view = await client.getLease(sessionId);
    if (view.lease && !(view.lease.holder.host === host)) {
      if (force) {
        const me = (await client.whoami()).principal;
        const { session } = await client.getSession(sessionId);
        if (session.owner !== me) return { success: false, error: "forbidden" };
        const forced = await client.acquireLease(sessionId, {
          host,
          ttlSeconds: LEASE_TTL_SECONDS,
          force: true,
        });
        returned.push(...readReturnedMessages(forced));
        return undefined;
      }
      await client.requestLeaseHandover(sessionId, { host });
      const deadline = (this.deps.now?.() ?? Date.now()) + (this.deps.handoverTimeoutMs ?? 60_000);
      while (view.lease && view.lease.holder.host !== host) {
        if ((this.deps.now?.() ?? Date.now()) >= deadline) {
          const holder = view.lease.holder.host;
          return {
            success: false,
            error: isCloudHostId(holder, (await client.getCloudCapabilities()).cloudHost)
              ? "cloud-still-running"
              : "lease-held",
          };
        }
        await this.sleep(this.deps.pollIntervalMs ?? 2000);
        view = await client.getLease(sessionId);
      }
    }
    const taken = await client.acquireLease(sessionId, { host, ttlSeconds: LEASE_TTL_SECONDS });
    returned.push(...readReturnedMessages(taken));
    return undefined;
  }
}
