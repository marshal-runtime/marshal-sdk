import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { collectEnvelope, type OrgClient } from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import { MAX_NATIVE_STATE_BYTES } from "../host-deps";
import type { RuntimeNativeSessionState } from "../host-deps";
import type {
  CreateFromNativeStateError,
  OrgForkSessionError,
  OrgForkSessionRequest,
  OrgForkSessionResult,
} from "./contract/org-types";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgFork");

const DEFAULT_MAX_DECOMPRESSED_BYTES = MAX_NATIVE_STATE_BYTES;
const FORK_ID_PREFIX = "fk-";

export type ForkClient = Pick<
  OrgClient,
  "supports" | "getCloudCapabilities" | "forkSession" | "getForkEnvelope"
>;

/** What a fork needs from the session manager. */
export interface ForkSessions {
  /** Starts a new local session from native state, or says why it could not. */
  createFromNative(request: {
    name: string;
    state: RuntimeNativeSessionState;
  }): Promise<
    { success: true; sessionId: string } | { success: false; error: CreateFromNativeStateError }
  >;
}

export interface OrgForkDeps {
  getFlags: () => OrgFlags;
  getSignedInOrgId: () => string | undefined;
  getClient: () => Promise<ForkClient | null>;
  sessions: ForkSessions;
  /** Shows the new session in the app: making it active in main does not move the renderer. */
  openSession: (sessionId: string) => void;
  maxDecompressedBytes?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const KNOWN_ERRORS: Record<string, OrgForkSessionError> = {
  "no-checkpoint": "no-checkpoint",
  "no-envelope": "envelope-missing",
  forbidden: "forbidden",
  "not-found": "not-found",
  unauthorized: "unauthorized",
  unreachable: "unreachable",
  timeout: "unreachable",
  "feature-unavailable": "unsupported",
  "not-signed-in": "not-signed-in",
};

const LOCAL_ERRORS: Record<CreateFromNativeStateError, OrgForkSessionError> = {
  "unsupported-format": "unsupported-runtime",
  "runtime-unavailable": "runtime-unavailable",
  "state-too-large": "state-too-large",
  "invalid-state": "envelope-invalid",
  "workspace-unavailable": "start-failed",
  "already-local": "start-failed",
  "start-failed": "start-failed",
};

/** Local failures a retry would repeat; the next fork gets a new retry key and so the session's current state. */
const FINAL_LOCAL_ERRORS: ReadonlySet<OrgForkSessionError> = new Set([
  "unsupported-runtime",
  "state-too-large",
  "envelope-invalid",
]);

function failureCode(error: unknown): OrgForkSessionError {
  const { code, transient } = classifyOrgFailure(error);
  return KNOWN_ERRORS[code] ?? (transient ? "unreachable" : "unavailable");
}

/**
 * Fork a session from the organization into a new private local session: the organization copies
 * the session up to its last completed checkpoint, this computer downloads that copy's state and
 * starts a session from it. The conversation comes along, the code does not.
 */
export class OrgFork {
  /** One retry key per source while a fork is unfinished, so a repeated click or a retry after a failure gets the fork already made. */
  private readonly pending = new Map<string, string>();
  /** Forks being made right now; a second click on the same source waits for the first. */
  private readonly running = new Map<string, Promise<OrgForkSessionResult>>();

  constructor(private readonly deps: OrgForkDeps) {}

  private get enabled(): boolean {
    return this.deps.getFlags().fork === true;
  }

  fork(request: OrgForkSessionRequest): Promise<OrgForkSessionResult> {
    const key = `${this.deps.getSignedInOrgId() ?? ""}\0${request.sessionId}`;
    const running = this.running.get(key);
    if (running) return running;
    const started = this.runFork(request, key).finally(() => this.running.delete(key));
    this.running.set(key, started);
    return started;
  }

  private async runFork(
    request: OrgForkSessionRequest,
    key: string,
  ): Promise<OrgForkSessionResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!this.deps.getSignedInOrgId()) return { success: false, error: "not-signed-in" };
    let client: ForkClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return { success: false, error: "unreachable" };
    }
    if (!client) return { success: false, error: "not-signed-in" };
    if (!client.supports("forks")) return { success: false, error: "unsupported" };

    const clientForkId = this.pending.get(key) ?? `${FORK_ID_PREFIX}${randomUUID()}`;
    this.pending.set(key, clientForkId);
    try {
      const caps = await client.getCloudCapabilities();
      const forked = await client.forkSession(request.sessionId, { clientForkId });
      if (!forked.envelope) return { success: false, error: "envelope-missing" };
      const download = await client.getForkEnvelope(forked.session.id, {
        maxBytes: caps.maxEnvelopeBytes,
      });
      const gzipped = await collectEnvelope(download.body, caps.maxEnvelopeBytes);
      if (sha256(gzipped) !== forked.envelope.sha256) {
        return { success: false, error: "envelope-mismatch" };
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(
          gunzipSync(gzipped, {
            maxOutputLength: this.deps.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
          }),
        );
      } catch {
        this.pending.delete(key);
        return { success: false, error: "envelope-invalid" };
      }
      const created = await this.deps.sessions.createFromNative({
        name: forked.session.title,
        state: { format: forked.envelope.format, bytes },
      });
      if (!created.success) {
        const error = LOCAL_ERRORS[created.error];
        log.warn(`Fork could not start a local session: code=${created.error}`);
        if (FINAL_LOCAL_ERRORS.has(error)) this.pending.delete(key);
        return { success: false, error };
      }
      this.pending.delete(key);
      try {
        this.deps.openSession(created.sessionId);
      } catch {
        log.warn("Fork could not switch the app to the new session: code=open-session-failed");
      }
      return {
        success: true,
        sessionId: created.sessionId,
        forkedFrom: {
          sessionId: forked.forkedFrom.sessionId,
          messageCount: forked.forkedFrom.messageCount,
          at: forked.forkedFrom.at,
        },
        codeNotIncluded: true,
      };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Fork failed: code=${failure.code} status=${failure.status ?? 0}`);
      if (failure.code === "no-checkpoint" || failure.code === "forbidden")
        this.pending.delete(key);
      return { success: false, error: failureCode(error) };
    }
  }
}
