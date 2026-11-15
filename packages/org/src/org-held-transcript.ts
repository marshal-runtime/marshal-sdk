import type { OrgClient, OrgTranscriptMessage } from "@marshal/agent-runtime-org";

import { createLogger } from "../host-deps";
import type { OrgHeldTranscriptResult } from "./contract/org-types";
import type { OrgCloudMoveStore } from "./org-cloud-move-store";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgHeldTranscript");

const MAX_SHOWN = 200;
const MAX_CACHED = 4;

export type OrgTranscriptClient = Pick<OrgClient, "supports" | "getSession" | "getTranscript">;

export interface OrgHeldTranscriptDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgTranscriptClient | null>;
  getSignedInOrgId: () => string | undefined;
  /** Where the cloud-held sessions are recorded; only those can be read here. */
  moves: Pick<OrgCloudMoveStore, "load">;
}

/** Pages one poll may read; a longer catch-up goes on in the next poll from where this one stopped. */
const MAX_PAGES_PER_READ = 25;
const PAGE_LIMIT = 200;

/** Reads on from `entry`'s cursor, keeping only messages from `keepFrom`; stops at the last page or after `MAX_PAGES_PER_READ`. */
async function advance(
  client: Pick<OrgTranscriptClient, "getTranscript">,
  sessionId: string,
  entry: CacheEntry,
): Promise<
  Pick<CacheEntry, "cursor" | "start" | "settled" | "settledCount" | "page" | "complete">
> {
  let { cursor, start, settled, settledCount } = entry;
  for (let pages = 0; pages < MAX_PAGES_PER_READ; pages += 1) {
    // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
    const result = await client.getTranscript(sessionId, { limit: PAGE_LIMIT, cursor });
    const kept = result.messages.slice(Math.max(0, entry.keepFrom - start));
    if (!result.nextCursor)
      return { cursor, start, settled, settledCount, page: kept, complete: true };
    settled = [...settled, ...kept].slice(-MAX_SHOWN);
    settledCount += kept.length;
    start += result.messages.length;
    cursor = result.nextCursor;
  }
  return { cursor, start, settled, settledCount, page: [], complete: false };
}

/**
 * What has been read of a session's transcript, from the move point on. `cursor` is the cursor that
 * fetched the page at global index `start`; `settled` holds the kept messages before that page and
 * `page` the kept messages of it, so a changed session is read on from `cursor`, not from the top.
 */
type CacheEntry = {
  orgId: string;
  moveKey: string;
  keepFrom: number;
  cursor: string | undefined;
  start: number;
  /** The newest `MAX_SHOWN` kept messages before the page, and how many kept messages came before it. */
  settled: OrgTranscriptMessage[];
  settledCount: number;
  page: OrgTranscriptMessage[];
  /** The page at `cursor` is the last one the cloud has. */
  complete: boolean;
  updatedAt: string;
  messageCount: number;
};

/**
 * Reads what the organization's cloud has written to a session it holds, since the move, so the
 * chat can show the cloud's turns and tool steps. Inert unless `org.remoteMode` is on; read-only;
 * held in a small in-memory cache that is checked against the session's message count, so a poll
 * of an unchanged session costs one small request. The reader keeps only messages from the move
 * point on and the cursor of the last page it read, so a changed session is read on from that page.
 * Cursors are opaque, so the first read pages from the start of a long history (25 pages a poll,
 * `truncated` until it has caught up).
 */
export class OrgHeldTranscript {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: OrgHeldTranscriptDeps) {}

  async get(sessionId: string): Promise<OrgHeldTranscriptResult> {
    if (this.deps.getFlags().remoteMode !== true) return { success: false, error: "disabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const held = this.deps.moves
      .load()
      .find((m) => m.sessionId === sessionId && m.orgId === orgId && m.state === "cloud");
    if (!held) return { success: false, error: "not-in-cloud" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (!client.supports("sessions")) return { success: false, error: "unsupported" };
      const view = await client.getSession(sessionId);
      const messageCount = view.session.transcript.messageCount;
      const { updatedAt } = view.session;
      const moveKey = `${held.runId}:${held.movedAt}`;
      const previous = this.cache.get(sessionId);
      this.cache.delete(sessionId);
      const usable =
        previous &&
        previous.orgId === orgId &&
        previous.moveKey === moveKey &&
        previous.keepFrom === held.messageCount &&
        messageCount >= previous.start
          ? previous
          : undefined;
      let entry: CacheEntry;
      if (
        usable?.complete &&
        usable.updatedAt === updatedAt &&
        usable.messageCount === messageCount
      ) {
        entry = usable;
      } else if (!usable && messageCount <= held.messageCount) {
        return { success: true, messages: [], total: 0, truncated: false };
      } else {
        const base: CacheEntry = usable ?? {
          orgId,
          moveKey,
          keepFrom: held.messageCount,
          cursor: undefined,
          start: 0,
          settled: [],
          settledCount: 0,
          page: [],
          complete: false,
          updatedAt,
          messageCount,
        };
        entry = { ...base, ...(await advance(client, sessionId, base)), updatedAt, messageCount };
      }
      this.cache.set(sessionId, entry);
      while (this.cache.size > MAX_CACHED) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      const messages = [...entry.settled, ...entry.page].slice(-MAX_SHOWN);
      const first = entry.settledCount + entry.page.length - messages.length;
      return {
        success: true,
        messages: messages.map((message, index) => ({
          id: `${sessionId}:${held.messageCount + first + index}`,
          role: message.role,
          text: message.text,
          at: message.at,
        })),
        total: entry.settledCount + entry.page.length,
        truncated: !entry.complete,
      };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Held transcript read failed: code=${failure.code} status=${failure.status ?? 0}`);
      return { success: false, error: failure.transient ? "unreachable" : failure.code };
    }
  }
}
