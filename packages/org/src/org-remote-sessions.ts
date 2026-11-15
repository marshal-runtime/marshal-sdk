import {
  OrgApiError,
  OrgFeatureUnavailableError,
  type OrgClient,
  type OrgSessionView,
  type OrgTranscriptMessage,
} from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import { ORG_SDK_RUNTIME } from "../host-deps";
import type {
  OrgRemoteNotificationSummary,
  OrgRemoteResult,
  OrgRemoteSessionDetail,
  OrgRemoteSessionError,
  OrgRemoteSessionSummary,
} from "./contract/org-types";
import { OrgNotSignedInError, type OrgFlags } from "./org-service";

const log = createLogger("OrgRemoteSessions");

const LIST_PAGE_LIMIT = 100;
const MAX_LIST_PAGES = 5;
const TRANSCRIPT_PAGE_LIMIT = 200;
const MAX_TRANSCRIPT_PAGES = 25;
const NOTIFICATION_PAGE_LIMIT = 100;
const WORKSPACE_NAMES_TTL_MS = 5 * 60_000;
const MAX_CACHED_TRANSCRIPTS = 8;

export type OrgRemoteSessionsClient = Pick<
  OrgClient,
  | "supports"
  | "listSessions"
  | "getSession"
  | "getTranscript"
  | "listWorkspaces"
  | "listNotifications"
  | "markNotificationRead"
>;

export interface OrgRemoteSessionsDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgRemoteSessionsClient | null>;
  /** The organization signed in to now; the in-memory caches are dropped when it changes. */
  getSignedInOrgId: () => string | undefined;
  now?: () => number;
}

/** Reads a session's transcript page by page, stopping after 25 pages of 200 (`truncated`). */
export async function readWholeTranscript(
  client: Pick<OrgClient, "getTranscript">,
  sessionId: string,
): Promise<{ messages: OrgTranscriptMessage[]; truncated: boolean }> {
  const messages: OrgTranscriptMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_TRANSCRIPT_PAGES) return { messages, truncated: true };
    // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
    const result = await client.getTranscript(sessionId, { limit: TRANSCRIPT_PAGE_LIMIT, cursor });
    messages.push(...result.messages);
    cursor = result.nextCursor;
    if (!cursor) return { messages, truncated: false };
  }
}

type TranscriptCacheEntry = {
  updatedAt: string;
  messageCount: number;
  messages: OrgTranscriptMessage[];
  truncated: boolean;
};

/** Maps a failed organization call to a short code the renderer shows; never carries the server's message. */
export function remoteSessionErrorCode(error: unknown): OrgRemoteSessionError {
  if (error instanceof OrgNotSignedInError) return "unauthorized";
  if (error instanceof OrgFeatureUnavailableError) return "unsupported";
  if (error instanceof OrgApiError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 403 || error.status === 404) return "not-shared";
    if (error.status === 503) return "unavailable";
  }
  return "unreachable";
}

const USER_PRINCIPAL = /^user:[^\s]{1,254}$/;

/** True when the owner turned live collaboration on; a server without live sessions sends no `live`. */
function isLive(view: OrgSessionView): boolean {
  return view.live?.enabled === true;
}

/** Who wrote a message (a person's own words, or their Marshal's reply), as the organization recorded it; absent on older servers. */
function authorOf(message: OrgTranscriptMessage): string | undefined {
  if (message.role === "system" || message.role === "tool" || message.author === undefined) {
    return undefined;
  }
  return USER_PRINCIPAL.test(message.author) ? message.author : undefined;
}

function summarize(
  view: OrgSessionView,
  workspaceNames: ReadonlyMap<string, string>,
): OrgRemoteSessionSummary {
  const { session } = view;
  const workspaceName = workspaceNames.get(session.workspaceId);
  return {
    ...(isLive(view) ? { live: true } : {}),
    id: session.id,
    title: session.title,
    owner: session.owner,
    workspaceId: session.workspaceId,
    ...(workspaceName ? { workspaceName } : {}),
    role: view.role,
    updatedAt: session.updatedAt,
    runtime: session.runtime,
    messageCount: session.transcript.messageCount,
  };
}

/**
 * Reads sessions other people shared with the signed-in user. Read-only and inert unless
 * `org.remoteSessions` is on. Remote content is held in bounded in-memory caches only: nothing is
 * written to disk and nothing enters the local sessions index.
 */
export class OrgRemoteSessions {
  private workspaceNames: {
    orgId: string | undefined;
    at: number;
    names: Map<string, string>;
  } | null = null;
  private transcripts = new Map<string, TranscriptCacheEntry>();
  private cacheOrgId: string | undefined;

  constructor(private readonly deps: OrgRemoteSessionsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private active(): boolean {
    return this.deps.getFlags().remoteSessions;
  }

  private syncCacheOrg(): void {
    const orgId = this.deps.getSignedInOrgId();
    if (orgId === this.cacheOrgId) return;
    this.cacheOrgId = orgId;
    this.transcripts.clear();
    this.workspaceNames = null;
  }

  private async client(): Promise<
    { client: OrgRemoteSessionsClient } | { error: OrgRemoteSessionError }
  > {
    const client = await this.deps.getClient();
    if (!client) return { error: "not-signed-in" };
    if (!client.supports("sessions")) return { error: "unsupported" };
    this.syncCacheOrg();
    return { client };
  }

  private async run<T>(
    work: (client: OrgRemoteSessionsClient) => Promise<T>,
  ): Promise<OrgRemoteResult<T extends object ? T : object>> {
    if (!this.active()) return { success: false, error: "disabled" };
    try {
      const resolved = await this.client();
      if ("error" in resolved) return { success: false, error: resolved.error };
      const value = await work(resolved.client);
      return { success: true, ...value } as OrgRemoteResult<T extends object ? T : object>;
    } catch (error) {
      const code = remoteSessionErrorCode(error);
      log.warn(`Remote sessions request failed: ${code}`);
      return { success: false, error: code };
    }
  }

  private async getWorkspaceNames(client: OrgRemoteSessionsClient): Promise<Map<string, string>> {
    const orgId = this.deps.getSignedInOrgId();
    const cached = this.workspaceNames;
    if (cached && cached.orgId === orgId && this.now() - cached.at < WORKSPACE_NAMES_TTL_MS) {
      return cached.names;
    }
    const names = new Map<string, string>();
    if (client.supports("workspaces")) {
      try {
        for (const workspace of await client.listWorkspaces()) {
          names.set(workspace.id, workspace.displayName);
        }
      } catch {
        // Workspace names are decoration; the id is shown when they cannot be loaded.
      }
    }
    this.workspaceNames = { orgId, at: this.now(), names };
    return names;
  }

  list(): Promise<OrgRemoteResult<{ sessions: OrgRemoteSessionSummary[] }>> {
    return this.run(async (client) => {
      const views: OrgSessionView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
        const result = await client.listSessions({ limit: LIST_PAGE_LIMIT, cursor });
        views.push(...result.sessions);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      const names = await this.getWorkspaceNames(client);
      const sessions = views
        // marshal-sdk runs list as SDK host sessions (the organization host, electron/sdk-hosts), not here.
        .filter((view) => view.role !== "owner" && view.session.runtime !== ORG_SDK_RUNTIME)
        .map((view) => summarize(view, names))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { sessions };
    });
  }

  get(sessionId: string): Promise<OrgRemoteResult<OrgRemoteSessionDetail>> {
    return this.run(async (client) => {
      const view = await client.getSession(sessionId);
      const names = await this.getWorkspaceNames(client);
      const session = summarize(view, names);
      const cached = this.transcripts.get(sessionId);
      if (
        cached &&
        cached.updatedAt === view.session.updatedAt &&
        cached.messageCount === view.session.transcript.messageCount
      ) {
        this.transcripts.delete(sessionId);
        this.transcripts.set(sessionId, cached);
        return this.detail(session, sessionId, cached);
      }
      const { messages, truncated } = await readWholeTranscript(client, sessionId);
      const entry: TranscriptCacheEntry = {
        updatedAt: view.session.updatedAt,
        messageCount: view.session.transcript.messageCount,
        messages,
        truncated,
      };
      this.transcripts.set(sessionId, entry);
      while (this.transcripts.size > MAX_CACHED_TRANSCRIPTS) {
        const oldest = this.transcripts.keys().next().value;
        if (oldest === undefined) break;
        this.transcripts.delete(oldest);
      }
      return this.detail(session, sessionId, entry);
    });
  }

  private detail(
    session: OrgRemoteSessionSummary,
    sessionId: string,
    entry: TranscriptCacheEntry,
  ): OrgRemoteSessionDetail {
    return {
      session,
      messages: entry.messages.map((message, index) => {
        const author = authorOf(message);
        return {
          id: `${sessionId}:${index}`,
          role: message.role,
          text: message.text,
          at: message.at,
          ...(author ? { author } : {}),
        };
      }),
      truncated: entry.truncated,
    };
  }

  listNotifications(): Promise<
    OrgRemoteResult<{ notifications: OrgRemoteNotificationSummary[]; unreadCount: number }>
  > {
    return this.run(async (client) => {
      if (!client.supports("notifications")) return { notifications: [], unreadCount: 0 };
      const page = await client.listNotifications({ unread: true, limit: NOTIFICATION_PAGE_LIMIT });
      const notifications = page.notifications.map((notification) => ({
        id: notification.id,
        kind: notification.kind,
        sessionId: notification.sessionId,
        from: notification.from,
        at: notification.at,
        read: notification.read,
      }));
      return { notifications, unreadCount: notifications.length };
    });
  }

  /** Marks the caller's unread notifications about one session as read. */
  markSessionRead(sessionId: string): Promise<OrgRemoteResult<object>> {
    return this.run(async (client) => {
      if (!client.supports("notifications")) return {};
      const page = await client.listNotifications({ unread: true, limit: NOTIFICATION_PAGE_LIMIT });
      for (const notification of page.notifications) {
        if (notification.sessionId === sessionId)
          // eslint-disable-next-line no-await-in-loop -- bounded by the page size
          await client.markNotificationRead(notification.id);
      }
      return {};
    });
  }
}
