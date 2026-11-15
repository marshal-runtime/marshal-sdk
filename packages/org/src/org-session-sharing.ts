/* eslint-disable no-await-in-loop -- uploads run one at a time: a transcript is a replace followed by ordered appends */
import os from "node:os";

import {
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_PAGE_BYTES,
  MAX_TRANSCRIPT_PAGE_MESSAGES,
  utf8Length,
  type OrgClient,
  type OrgTranscriptMessage,
  type OrgSessionUpload,
} from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import { sanitizeSessionForOrg, type ShareableSession } from "./cloud-session-sanitizer";
import type {
  OrgSessionWorkspaceMappingResult,
  OrgSetSessionWorkspaceRequest,
  OrgShareRestrictedItem,
  OrgShareWorkspace,
  OrgShareWorkspacesResult,
  OrgWorkspaceMapping,
  OrgSessionSharePreviewResult,
  OrgSessionShareResult,
} from "./contract/org-types";
import { isOrgAnalysisSession } from "./org-audit-analysis";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";
import type { OrgSessionWorkspaceStore } from "./org-session-workspace-store";
import {
  MAX_OUTBOX_ENTRIES,
  type OrgShareOutboxEntry,
  type OrgShareOutboxStore,
} from "./org-share-outbox";
import { WORKSPACE_MAPPING_ERROR_CODES } from "./org-workspace-links";

const log = createLogger("OrgSessionSharing");

type SharingClient = Pick<
  OrgClient,
  "supports" | "whoami" | "putSession" | "putTranscript" | "discovery" | "listWorkspaces"
>;

/** Shared sessions (`org.liveSessions`): once a session is linked its transcript syncs by appends, never a replace. */
export interface SharingSharedSessions {
  ownerMayReplace(sessionId: string): Promise<boolean>;
  ownerShared(sessionId: string, sharedTitle?: string): Promise<void>;
}

const NO_WORKSPACE_MESSAGE =
  "This session has no workspace, so it can't be moved to the cloud. To share it, pick an organization workspace.";

/** `mappedOnly` ignores a workspace the person chose for the session: for callers that need the session's own files to belong to the workspace (Move to cloud). */
export interface SharingTargetOptions {
  mappedOnly?: boolean;
}

export interface OrgSessionSharingDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<SharingClient | null>;
  getSignedInOrgId: () => string | undefined;
  loadSession: (sessionId: string) => Promise<ShareableSession | null>;
  /** Re-derives the organization workspace from the workspace's git origin; sharing is refused unless it is mapped. */
  resolveOrgWorkspace: (workspaceName: string) => Promise<OrgWorkspaceMapping>;
  outbox: OrgShareOutboxStore;
  /** Where the organization workspace picked for an unmapped session is kept; absent, nothing can be picked. */
  workspaceChoices?: OrgSessionWorkspaceStore;
  sharedSessions?: SharingSharedSessions;
  homeDir?: () => string;
  now?: () => number;
}

/** Splits a transcript into pages that respect the contract's message and byte caps. */
export function paginateTranscript(
  messages: readonly OrgTranscriptMessage[],
): OrgTranscriptMessage[][] {
  const pages: OrgTranscriptMessage[][] = [];
  let page: OrgTranscriptMessage[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = utf8Length(message.text);
    if (
      page.length > 0 &&
      (page.length >= MAX_TRANSCRIPT_PAGE_MESSAGES || bytes + size > MAX_TRANSCRIPT_PAGE_BYTES)
    ) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(message);
    bytes += size;
  }
  if (page.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

function transcriptBytes(messages: readonly OrgTranscriptMessage[]): number {
  return messages.reduce((total, message) => total + utf8Length(message.text), 0);
}

/**
 * Shares a local session with the organization: sanitize, upload the envelope and transcript, and keep a
 * retry outbox so a failed or offline upload is not lost. Inert unless `org.sessionSharing` is on:
 * with the flag off no method touches the network or the disk.
 */
export class OrgSessionSharing {
  private flushing: Promise<void> | null = null;

  constructor(private readonly deps: OrgSessionSharingDeps) {}

  private get enabled(): boolean {
    return this.deps.getFlags().sessionSharing === true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async preview(
    sessionId: string,
    options: SharingTargetOptions = {},
  ): Promise<OrgSessionSharePreviewResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const prepared = await this.prepare(sessionId, options);
    if (!prepared.success) return prepared;
    const { orgId, upload, messages, restrictedItems } = prepared;
    const queued = (await this.deps.outbox.load()).some(
      (entry) => entry.sessionId === upload.id && entry.orgId === orgId,
    );
    return {
      success: true,
      title: upload.title,
      orgWorkspaceId: upload.workspaceId,
      messageCount: messages.length,
      label: upload.labels === "restricted" ? "restricted" : "team",
      restrictedItems,
      queued,
    };
  }

  /**
   * `strict` is for a caller whose own step needs the upload to have landed (Move to cloud): a
   * restricted snapshot is refused and a transient failure is returned instead of queued for a retry.
   */
  async share(
    sessionId: string,
    options: { strict?: boolean } & SharingTargetOptions = {},
  ): Promise<OrgSessionShareResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const prepared = await this.prepare(sessionId, options);
    if (!prepared.success) return prepared;
    const { orgId, upload, messages, client } = prepared;
    if (options.strict && upload.labels === "restricted") {
      return { success: false, error: "restricted-content" };
    }
    let recordReached = false;
    try {
      await this.deliver(client, upload, messages, () => {
        recordReached = true;
      });
      await this.removeFromOutbox(upload.id, orgId);
      return { success: true, state: "uploaded", messageCount: messages.length };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(
        `Share upload failed: code=${failure.code} status=${failure.status ?? 0} transient=${failure.transient}`,
      );
      if (!failure.transient || options.strict) {
        return {
          success: false,
          error: failure.code,
          ...(recordReached ? { uploaded: true } : {}),
        };
      }
      await this.enqueue({
        sessionId: upload.id,
        orgId,
        queuedAt: this.now(),
        attempts: 1,
        upload,
        messages,
      });
      return { success: true, state: "queued", messageCount: messages.length };
    }
  }

  /** Stores the envelope of a session already shared again (its title changed); the transcript is left alone. */
  async updateEnvelope(sessionId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const prepared = await this.prepare(sessionId, {});
    if (!prepared.success) return false;
    try {
      await prepared.client.putSession(prepared.upload);
      return true;
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Envelope update failed: code=${failure.code} status=${failure.status ?? 0}`);
      return false;
    }
  }

  /** Retries every queued share for the organization signed in to. Safe to call often; one pass runs at a time. */
  flushOutbox(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return;
    const entries = await this.deps.outbox.load();
    if (!entries.some((entry) => entry.orgId === orgId)) return;
    let client: SharingClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return;
    }
    if (!client?.supports("sessions")) return;
    for (const entry of entries.filter((candidate) => candidate.orgId === orgId)) {
      try {
        await this.deliver(client, entry.upload, entry.messages);
        await this.removeFromOutbox(entry.sessionId, orgId);
      } catch (error) {
        const failure = classifyOrgFailure(error);
        log.warn(`Queued share retry failed: code=${failure.code} transient=${failure.transient}`);
        if (failure.transient) {
          await this.enqueue({ ...entry, attempts: entry.attempts + 1 });
          if (failure.code === "not-signed-in" || failure.code === "unreachable") return;
        } else {
          await this.removeFromOutbox(entry.sessionId, orgId);
        }
      }
    }
  }

  /**
   * The mapping that decides whether this session's workspace may be shared, and, when it is not
   * mapped, the organization workspace picked for the session. Read-only, nothing is uploaded.
   */
  async workspaceMapping(sessionId: string): Promise<OrgSessionWorkspaceMappingResult> {
    if (!this.deps.getFlags().workspaces) return { success: false, error: "disabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const session = await this.deps.loadSession(sessionId);
    if (!session) return { success: false, error: "session-not-found" };
    const mapping = await this.ownMapping(session);
    if (mapping.mapped || !this.canChoose(mapping)) return { success: true, mapping };
    const choice = this.storedChoice(sessionId, orgId);
    if (!choice) return { success: true, mapping, canChoose: true };
    const served = await this.servedWorkspaces();
    const chosen = served.success
      ? served.workspaces.find((workspace) => workspace.id === choice)
      : undefined;
    return { success: true, mapping, canChoose: true, ...(chosen ? { chosen } : {}) };
  }

  /** The organization workspaces an unmapped session can be shared into: every served one without a data boundary. */
  async shareWorkspaces(): Promise<OrgShareWorkspacesResult> {
    if (!this.enabled || !this.deps.workspaceChoices) return { success: false, error: "disabled" };
    if (!this.deps.getSignedInOrgId()) return { success: false, error: "not-signed-in" };
    return this.servedWorkspaces();
  }

  /** Records the organization workspace for a session whose own workspace maps to none; a mapped session keeps its mapping. */
  async chooseWorkspace(
    request: OrgSetSessionWorkspaceRequest,
  ): Promise<OrgSessionWorkspaceMappingResult> {
    const store = this.deps.workspaceChoices;
    if (!this.enabled || !store || !this.deps.getFlags().workspaces) {
      return { success: false, error: "disabled" };
    }
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const session = await this.deps.loadSession(request.sessionId);
    if (!session) return { success: false, error: "session-not-found" };
    const mapping = await this.ownMapping(session);
    if (mapping.mapped) return { success: false, error: "workspace-mapped" };
    if (!this.canChoose(mapping)) {
      return { success: false, error: WORKSPACE_MAPPING_ERROR_CODES[mapping.reason] };
    }
    const served = await this.servedWorkspaces();
    if (!served.success) return served;
    const chosen = served.workspaces.find((workspace) => workspace.id === request.orgWorkspaceId);
    if (!chosen) return { success: false, error: "workspace-not-served" };
    const others = store
      .load()
      .filter((entry) => !(entry.sessionId === request.sessionId && entry.orgId === orgId));
    store.save([
      ...others,
      {
        sessionId: request.sessionId,
        orgId,
        orgWorkspaceId: chosen.id,
        chosenAt: this.now(),
      },
    ]);
    return { success: true, mapping, canChoose: true, chosen };
  }

  private async ownMapping(session: ShareableSession): Promise<OrgWorkspaceMapping> {
    if (!session.workspaceName) {
      return { mapped: false, reason: "no-workspace", message: NO_WORKSPACE_MESSAGE };
    }
    return this.deps.resolveOrgWorkspace(session.workspaceName);
  }

  /** Picking a workspace fixes every unmapped case except an organization that cannot be reached now. */
  private canChoose(mapping: OrgWorkspaceMapping): boolean {
    return (
      !mapping.mapped &&
      mapping.reason !== "unavailable" &&
      !!this.deps.workspaceChoices &&
      this.enabled
    );
  }

  private storedChoice(sessionId: string, orgId: string): string | undefined {
    return this.deps.workspaceChoices
      ?.load()
      .find((entry) => entry.sessionId === sessionId && entry.orgId === orgId)?.orgWorkspaceId;
  }

  private async servedWorkspaces(): Promise<OrgShareWorkspacesResult> {
    let client: SharingClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return { success: false, error: "unreachable" };
    }
    if (!client) return { success: false, error: "not-signed-in" };
    if (!client.supports("workspaces")) return { success: false, error: "workspaces-unsupported" };
    try {
      const workspaces: OrgShareWorkspace[] = (await client.listWorkspaces())
        // A bounded workspace grants only to readers the desktop cannot see, and a session can never leave it.
        .filter((workspace) => workspace.dataBoundary === undefined)
        .map((workspace) => ({ id: workspace.id, displayName: workspace.displayName }));
      return { success: true, workspaces };
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }
  }

  private async prepare(
    sessionId: string,
    options: SharingTargetOptions,
  ): Promise<
    | { success: false; error: string }
    | {
        success: true;
        orgId: string;
        client: SharingClient;
        upload: OrgSessionUpload;
        messages: OrgTranscriptMessage[];
        restrictedItems: OrgShareRestrictedItem[];
      }
  > {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const session = await this.deps.loadSession(sessionId);
    if (!session) return { success: false, error: "session-not-found" };
    if (isOrgAnalysisSession(session)) return { success: false, error: "not-shareable" };
    const mapping = await this.ownMapping(session);
    const choice =
      !mapping.mapped && !options.mappedOnly && this.canChoose(mapping)
        ? this.storedChoice(sessionId, orgId)
        : undefined;
    const orgWorkspaceId = mapping.mapped ? mapping.orgWorkspaceId : choice;
    if (!orgWorkspaceId) {
      return {
        success: false,
        error: mapping.mapped
          ? "workspace-not-linked"
          : WORKSPACE_MAPPING_ERROR_CODES[mapping.reason],
      };
    }

    let client: SharingClient | null;
    try {
      client = await this.deps.getClient();
    } catch {
      return { success: false, error: "unreachable" };
    }
    if (!client) return { success: false, error: "not-signed-in" };
    if (!client.supports("sessions")) return { success: false, error: "sessions-unsupported" };
    if (!mapping.mapped) {
      // The organization may have stopped serving the picked workspace since it was chosen.
      const served = await this.servedWorkspaces();
      if (!served.success) return served;
      if (!served.workspaces.some((workspace) => workspace.id === orgWorkspaceId)) {
        return { success: false, error: "workspace-not-served" };
      }
    }

    let owner;
    try {
      owner = (await client.whoami()).principal;
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }
    const sanitized = sanitizeSessionForOrg(session, {
      owner,
      workspaceId: orgWorkspaceId,
      homeDir: this.deps.homeDir?.() ?? os.homedir(),
      withIds: this.sharedFor(client) !== undefined,
    });
    if (!sanitized.success) return { success: false, error: sanitized.error };
    const { upload, messages, restrictedItems } = sanitized.session;
    if (transcriptBytes(messages) > MAX_TRANSCRIPT_BYTES) {
      return { success: false, error: "transcript-too-large" };
    }
    return { success: true, orgId, client, upload, messages, restrictedItems };
  }

  private sharedFor(client: SharingClient): SharingSharedSessions | undefined {
    return this.deps.getFlags().liveSessions === true && client.supports("sharedTranscript")
      ? this.deps.sharedSessions
      : undefined;
  }

  /**
   * Uploads a shared session. Once it is linked as a shared session, or others already wrote in it, the
   * transcript is never replaced again: the envelope is stored and the shared-session sync appends.
   */
  private async deliver(
    client: SharingClient,
    upload: OrgSessionUpload,
    messages: readonly OrgTranscriptMessage[],
    onSessionPut?: () => void,
  ): Promise<void> {
    const shared = this.sharedFor(client);
    if (shared && !(await shared.ownerMayReplace(upload.id))) {
      await client.putSession(upload);
      onSessionPut?.();
      await shared.ownerShared(upload.id, upload.title);
      return;
    }
    try {
      await this.upload(client, upload, messages, onSessionPut);
    } catch (error) {
      if (!shared || classifyOrgFailure(error).code !== "conflict") throw error;
    }
    await shared?.ownerShared(upload.id, upload.title);
  }

  /** The envelope first, then the transcript as one replace followed by appends, so a retry always starts clean. */
  private async upload(
    client: SharingClient,
    upload: OrgSessionUpload,
    messages: readonly OrgTranscriptMessage[],
    onSessionPut?: () => void,
  ): Promise<void> {
    await client.putSession(upload);
    onSessionPut?.();
    let count = 0;
    for (const [index, page] of paginateTranscript(messages).entries()) {
      const ref = await client.putTranscript(
        upload.id,
        index === 0
          ? { mode: "replace", messages: page }
          : { mode: "append", messages: page, expectedCount: count },
      );
      count = ref.messageCount;
    }
  }

  private async enqueue(entry: OrgShareOutboxEntry): Promise<void> {
    const entries = (await this.deps.outbox.load()).filter(
      (existing) => !(existing.sessionId === entry.sessionId && existing.orgId === entry.orgId),
    );
    entries.push(entry);
    await this.deps.outbox.save(entries.slice(-MAX_OUTBOX_ENTRIES));
  }

  private async removeFromOutbox(sessionId: string, orgId: string): Promise<void> {
    const entries = await this.deps.outbox.load();
    const remaining = entries.filter(
      (entry) => !(entry.sessionId === sessionId && entry.orgId === orgId),
    );
    if (remaining.length !== entries.length) await this.deps.outbox.save(remaining);
  }
}
