import { createLogger } from "../host-deps";
import type { OrgSessionChange, OrgSessionWatchResult } from "./contract/org-types";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgSessionWatcher");

/** Most sessions followed at once; the server allows 8 streams per person. */
export const MAX_WATCHED_SESSIONS = 4;
/** How often the runtime's own fallback reports a timed event when the stream is refused, in milliseconds. */
export const WATCH_FALLBACK_POLL_MS = 15_000;
/** First wait before a followed session's stream is started again after it failed, in milliseconds. */
export const WATCH_RESTART_MIN_MS = 5_000;
/** Longest wait between such restarts, in milliseconds. */
export const WATCH_RESTART_MAX_MS = 60_000;

type FollowEvent = { version: string | null; kinds: string[]; polled: boolean };

/** The part of the runtime client the watcher uses; a client from an older runtime pack has no `followSession`. */
export type OrgWatchClient = Partial<{
  supports(feature: string): boolean;
  followSession(
    sessionId: string,
    input: { signal?: AbortSignal; pollMs?: number },
  ): AsyncIterable<FollowEvent>;
}>;

export interface OrgSessionWatcherDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgWatchClient | null>;
  /** The part of the sign-in state that decides which stream is right: the signed-in organization, empty when signed out. */
  getIdentityKey: () => string;
  /** Tells the renderer how a followed session's feed is doing; `changed` is true only for a real change ping. */
  notify: (change: OrgSessionChange) => void;
  /** Waits before a failed stream is started again; ends early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Watch = { controller: AbortController; holders: number; live: boolean };

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

function canFollow(client: OrgWatchClient): boolean {
  return typeof client.followSession === "function" && client.supports?.("sessionWatch") === true;
}

/**
 * Follows the change feed of sessions the renderer is showing and tells it when one changes, so the
 * renderer fetches then instead of on a short timer. Inert unless `org.remoteMode` is on and the server
 * offers `sessionWatch` to a runtime client that can follow a session. The renderer keeps its own
 * polling and learns from `live` (the stream's real state, kept here) when it may slow it down. Content
 * never passes through here: an event only means "fetch again".
 */
export class OrgSessionWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private key: string;

  constructor(private readonly deps: OrgSessionWatcherDeps) {
    this.sleep = deps.sleep ?? sleepUnlessAborted;
    this.key = this.currentKey();
  }

  async watch(sessionId: string): Promise<OrgSessionWatchResult> {
    if (this.deps.getFlags().remoteMode !== true) return { success: false, error: "disabled" };
    const existing = this.watches.get(sessionId);
    if (existing) {
      existing.holders += 1;
      return { success: true, live: existing.live };
    }
    if (this.watches.size >= MAX_WATCHED_SESSIONS) return { success: false, error: "too-many" };
    const client = await this.deps.getClient();
    if (!client) return { success: false, error: "not-signed-in" };
    if (!canFollow(client)) return { success: false, error: "unsupported" };
    const raced = this.watches.get(sessionId);
    if (raced) {
      raced.holders += 1;
      return { success: true, live: raced.live };
    }
    const entry: Watch = { controller: new AbortController(), holders: 1, live: false };
    this.watches.set(sessionId, entry);
    void this.run(client, sessionId, entry);
    return { success: true, live: false };
  }

  unwatch(sessionId: string): void {
    const entry = this.watches.get(sessionId);
    if (!entry) return;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    entry.controller.abort();
    this.watches.delete(sessionId);
  }

  /** Ends every stream and forgets who held them: for when the renderer that asked is gone (window closed, page reloaded or crashed). */
  stopAll(): void {
    for (const entry of this.watches.values()) entry.controller.abort();
    this.watches.clear();
  }

  /**
   * Call when the org service reports a change. Only a different signed-in organization or `org.remoteMode`
   * restarts the streams of the sessions still held, with the client that now applies; any other change
   * (a token refresh, an unrelated setting) leaves them running.
   */
  async onOrgChanged(): Promise<void> {
    const key = this.currentKey();
    if (key === this.key) return;
    this.key = key;
    const entries = [...this.watches.entries()];
    for (const [sessionId, entry] of entries) {
      entry.controller.abort();
      this.setLive(sessionId, entry, false, false);
    }
    const flagOn = this.deps.getFlags().remoteMode === true;
    const client = flagOn ? await this.deps.getClient().catch(() => null) : null;
    for (const [sessionId, entry] of entries) {
      if (this.watches.get(sessionId) !== entry) continue;
      if (!client || !canFollow(client)) {
        this.watches.delete(sessionId);
        continue;
      }
      entry.controller = new AbortController();
      void this.run(client, sessionId, entry);
    }
  }

  private currentKey(): string {
    return `${this.deps.getIdentityKey()}|${this.deps.getFlags().remoteMode === true}`;
  }

  private setLive(sessionId: string, entry: Watch, live: boolean, changed: boolean): void {
    const was = entry.live;
    entry.live = live;
    if (changed || was !== live) this.deps.notify({ sessionId, live, changed });
  }

  private async run(client: OrgWatchClient, sessionId: string, entry: Watch): Promise<void> {
    const { signal } = entry.controller;
    let wait = WATCH_RESTART_MIN_MS;
    while (!signal.aborted && this.watches.get(sessionId) === entry) {
      // eslint-disable-next-line no-await-in-loop -- one stream at a time per session, restarted after a pause
      if (await this.follow(client, sessionId, entry)) wait = WATCH_RESTART_MIN_MS;
      if (signal.aborted) break;
      this.setLive(sessionId, entry, false, false);
      // eslint-disable-next-line no-await-in-loop -- see above
      await this.sleep(wait, signal);
      wait = Math.min(wait * 2, WATCH_RESTART_MAX_MS);
    }
  }

  /** Runs one stream until it ends; true when it delivered at least one event. */
  private async follow(client: OrgWatchClient, sessionId: string, entry: Watch): Promise<boolean> {
    const { signal } = entry.controller;
    let delivered = false;
    try {
      for await (const event of client.followSession!(sessionId, {
        signal,
        pollMs: WATCH_FALLBACK_POLL_MS,
      })) {
        if (signal.aborted) break;
        delivered = true;
        this.setLive(sessionId, entry, !event.polled, !event.polled);
      }
    } catch (error) {
      log.warn(`Session watch failed: ${error instanceof Error ? error.name : "error"}`);
    }
    return delivered;
  }
}
