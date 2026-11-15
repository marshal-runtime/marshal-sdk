import type { OrgClient, OrgSessionView } from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import type {
  OrgCloudMovedStatus,
  OrgCloudSessionSummary,
  OrgCloudSessionsResult,
  OrgCloudTurnState,
} from "./contract/org-types";
import { remoteSessionErrorCode } from "./org-remote-sessions";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgCloudSessions");

/** The page the design asks for; the Cloud group never pages further. */
const CLOUD_LIST_LIMIT = 50;
const MAX_LINKS = 200;

export type OrgCloudSessionsClient = Pick<OrgClient, "supports" | "listSessions">;

export interface OrgCloudSessionsDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgCloudSessionsClient | null>;
  /** Ids of the sessions this computer moved to the cloud; they have a row in Threads already. */
  listMovedHere: () => ReadonlySet<string> | readonly string[];
  /** False when the URL was refused. */
  openExternal: (url: string) => boolean;
  /** True when this computer has the session in its own Threads, so it does not belong in the Cloud group. */
  hasLocalSession?: (sessionId: string) => boolean;
  /** Sessions whose Continue here was refused after the lease was taken: the server lists them as local, so they would vanish with their retry buttons. */
  listStranded?: () => readonly OrgCloudSessionSummary[];
  /** Called for a remembered session that now exists on this computer. */
  forgetStranded?: (sessionId: string) => void;
}

function summarize(view: OrgSessionView): OrgCloudSessionSummary {
  const { session } = view;
  return {
    id: session.id,
    title: session.title,
    workspaceId: session.workspaceId,
    turnState: (view.turnState ?? "idle") satisfies OrgCloudTurnState,
    queued: view.queued ?? 0,
    lastActivityAt: view.lastActivityAt ?? session.updatedAt,
    ...(view.runLink ? { runLink: view.runLink } : {}),
  };
}

/**
 * The sessions the organization's cloud holds for the signed-in user, for the Cloud sidebar group.
 * Inert unless `org.cloudGroup` is on: with it off, no client is built and no request is made.
 * Read-only; nothing is stored, and a run link is only ever opened if the last list served it.
 */
export class OrgCloudSessions {
  private served = new Set<string>();

  constructor(private readonly deps: OrgCloudSessionsDeps) {}

  async list(): Promise<OrgCloudSessionsResult> {
    if (this.deps.getFlags().cloudGroup !== true) return { success: false, error: "disabled" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (!client.supports("sessions") || !client.supports("cloudList")) {
        return { success: false, error: "unsupported" };
      }
      const page = await client.listSessions({
        placement: "cloud",
        owner: "me",
        limit: CLOUD_LIST_LIMIT,
      });
      const moved = new Set(this.deps.listMovedHere());
      const sessions: OrgCloudSessionSummary[] = [];
      const movedStatus: OrgCloudMovedStatus[] = [];
      for (const view of page.sessions) {
        if (view.role !== "owner" || view.placement !== "cloud") continue;
        if (moved.has(view.session.id)) {
          movedStatus.push({
            id: view.session.id,
            turnState: view.turnState ?? "idle",
            queued: view.queued ?? 0,
          });
        } else if (!this.deps.hasLocalSession?.(view.session.id)) sessions.push(summarize(view));
      }
      const listed = new Set(sessions.map((session) => session.id));
      for (const kept of this.deps.listStranded?.() ?? []) {
        if (this.deps.hasLocalSession?.(kept.id)) {
          this.deps.forgetStranded?.(kept.id);
          continue;
        }
        if (listed.has(kept.id)) continue;
        sessions.push({ ...kept, stranded: true });
      }
      sessions.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
      this.served = new Set(
        sessions
          .flatMap((session) => (session.runLink ? [session.runLink] : []))
          .slice(0, MAX_LINKS),
      );
      return { success: true, sessions, movedCount: movedStatus.length, moved: movedStatus };
    } catch (error) {
      const code = remoteSessionErrorCode(error);
      log.warn(`Cloud sessions request failed: ${code}`);
      return { success: false, error: code };
    }
  }

  /** Removes a stranded session from the list; the session itself stays on the server. */
  dismissStranded(sessionId: string): { success: boolean } {
    if (this.deps.getFlags().cloudGroup !== true || !this.deps.forgetStranded) {
      return { success: false };
    }
    this.deps.forgetStranded(sessionId);
    return { success: true };
  }

  /** Opens a run link the last list served, and nothing else. */
  openRunLink(url: string): { success: boolean } {
    if (this.deps.getFlags().cloudGroup !== true || !this.served.has(url))
      return { success: false };
    return { success: this.deps.openExternal(url) };
  }
}
