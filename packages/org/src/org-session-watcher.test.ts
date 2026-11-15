import { describe, expect, it, vi } from "vitest";

import type { OrgSessionChange } from "../../../common/marshal-ipc-contract";
import type { OrgFlags } from "./org-service";
import {
  MAX_WATCHED_SESSIONS,
  OrgSessionWatcher,
  WATCH_RESTART_MAX_MS,
  WATCH_RESTART_MIN_MS,
  type OrgWatchClient,
} from "./org-session-watcher";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  remoteMode: true,
};

type FeedEvent = { polled: boolean } | "fail" | null;

/** A client whose feed the test drives: `push` yields one event to every follower of the session. */
function feedClient(supported = true) {
  const queues = new Map<string, Array<(event: FeedEvent) => void>>();
  const aborted: string[] = [];
  const followSession = vi.fn<NonNullable<OrgWatchClient["followSession"]>>(
    async function* (sessionId, input) {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- the fake feed delivers one event at a time
        const event = await new Promise<FeedEvent>((resolve) => {
          queues.set(sessionId, [...(queues.get(sessionId) ?? []), resolve]);
          input.signal?.addEventListener(
            "abort",
            () => {
              if (!aborted.includes(sessionId)) aborted.push(sessionId);
              resolve(null);
            },
            { once: true },
          );
        });
        if (event === "fail") throw new Error("boom");
        if (!event || input.signal?.aborted) return;
        yield { version: "0123456789abcdef", kinds: ["run"], polled: event.polled };
      }
    },
  );
  const push = (sessionId: string, event: FeedEvent = { polled: false }) => {
    const waiting = queues.get(sessionId) ?? [];
    queues.set(sessionId, []);
    for (const resolve of waiting) resolve(event);
  };
  const client: OrgWatchClient = { followSession, supports: () => supported };
  return { client, followSession, push, aborted };
}

function setup(
  options: {
    flags?: () => OrgFlags;
    client?: () => OrgWatchClient | null;
    identity?: () => string;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const feed = feedClient();
  const notify = vi.fn<(change: OrgSessionChange) => void>();
  const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(
    options.sleep ??
      ((_ms, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve()))),
  );
  const watcher = new OrgSessionWatcher({
    getFlags: options.flags ?? (() => ON),
    getClient: async () => (options.client ? options.client() : feed.client),
    getIdentityKey: options.identity ?? (() => "org-1"),
    notify,
    sleep,
  });
  return { watcher, notify, feed, sleep };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("OrgSessionWatcher", () => {
  it("says a real change event is live and changed, a timed one only that the feed is not live", async () => {
    const { watcher, notify, feed } = setup();
    expect(await watcher.watch("s1")).toEqual({ success: true, live: false });
    await tick();
    feed.push("s1");
    await tick();
    feed.push("s1", { polled: true });
    await tick();
    feed.push("s1", { polled: true });
    await tick();
    expect(notify.mock.calls.map(([change]) => change)).toEqual([
      { sessionId: "s1", live: true, changed: true },
      { sessionId: "s1", live: false, changed: false },
    ]);
    watcher.stopAll();
  });

  it("answers a second view with the feed's real state, and follows the session once", async () => {
    const { watcher, feed } = setup();
    await watcher.watch("s1");
    await tick();
    feed.push("s1");
    await tick();
    expect(await watcher.watch("s1")).toEqual({ success: true, live: true });
    expect(feed.followSession).toHaveBeenCalledTimes(1);
    watcher.unwatch("s1");
    expect(feed.aborted).toEqual([]);
    watcher.unwatch("s1");
    await tick();
    expect(feed.aborted).toEqual(["s1"]);
  });

  it("is inert while org.remoteMode is off", async () => {
    const { watcher, feed } = setup({ flags: () => ({ ...ON, remoteMode: false }) });
    expect(await watcher.watch("s1")).toEqual({ success: false, error: "disabled" });
    expect(feed.followSession).not.toHaveBeenCalled();
  });

  it("reports a signed-out user, a runtime client that cannot follow, and a server without the feed", async () => {
    expect(await setup({ client: () => null }).watcher.watch("s1")).toEqual({
      success: false,
      error: "not-signed-in",
    });
    expect(await setup({ client: () => ({}) }).watcher.watch("s1")).toEqual({
      success: false,
      error: "unsupported",
    });
    const noFeed = feedClient(false);
    const { watcher } = setup({ client: () => noFeed.client });
    expect(await watcher.watch("s1")).toEqual({ success: false, error: "unsupported" });
    expect(noFeed.followSession).not.toHaveBeenCalled();
  });

  it("caps the sessions followed at once and ignores unwatching an unknown one", async () => {
    const { watcher } = setup();
    const results = await Promise.all(
      Array.from({ length: MAX_WATCHED_SESSIONS }, (_, index) => watcher.watch(`s${index}`)),
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(await watcher.watch("extra")).toEqual({ success: false, error: "too-many" });
    watcher.unwatch("never-watched");
    watcher.stopAll();
  });

  describe("stopAll", () => {
    it("aborts every stream and forgets the holders, so the same session can be followed afresh", async () => {
      const { watcher, feed } = setup();
      await watcher.watch("s1");
      await watcher.watch("s1");
      await watcher.watch("s2");
      await tick();
      watcher.stopAll();
      await tick();
      expect(feed.aborted.sort()).toEqual(["s1", "s2"]);
      feed.push("s1");
      await tick();
      expect(await watcher.watch("s1")).toEqual({ success: true, live: false });
      expect(feed.followSession).toHaveBeenCalledTimes(3);
      watcher.stopAll();
    });
  });

  describe("onOrgChanged", () => {
    it("leaves the streams alone for a change that is neither the sign-in nor the flag", async () => {
      const { watcher, feed, notify } = setup();
      await watcher.watch("s1");
      await tick();
      feed.push("s1");
      await tick();
      await watcher.onOrgChanged();
      await watcher.onOrgChanged();
      await tick();
      expect(feed.aborted).toEqual([]);
      expect(feed.followSession).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      watcher.stopAll();
    });

    it("restarts the held sessions with the new client when the organization changes, and tells the renderer the feed is not live meanwhile", async () => {
      let org = "org-1";
      const first = feedClient();
      const second = feedClient();
      let current = first.client;
      const { watcher, notify } = setup({ identity: () => org, client: () => current });
      await watcher.watch("s1");
      await tick();
      first.push("s1");
      await tick();
      org = "org-2";
      current = second.client;
      await watcher.onOrgChanged();
      await tick();
      expect(first.aborted).toEqual(["s1"]);
      expect(second.followSession).toHaveBeenCalledWith("s1", expect.anything());
      expect(notify).toHaveBeenLastCalledWith({ sessionId: "s1", live: false, changed: false });
      second.push("s1");
      await tick();
      expect(notify).toHaveBeenLastCalledWith({ sessionId: "s1", live: true, changed: true });
      watcher.stopAll();
    });

    it("drops the held sessions when the user signs out or the flag goes off", async () => {
      let flags = ON;
      let org = "org-1";
      const { watcher, feed } = setup({ flags: () => flags, identity: () => org });
      await watcher.watch("s1");
      await tick();
      org = "";
      await watcher.onOrgChanged();
      await tick();
      expect(feed.aborted).toEqual(["s1"]);
      org = "org-1";
      flags = { ...ON, remoteMode: false };
      await watcher.onOrgChanged();
      expect(await watcher.watch("s1")).toEqual({ success: false, error: "disabled" });
    });
  });

  describe("a stream that fails", () => {
    it("is started again after a growing pause, and says the feed is not live meanwhile", async () => {
      const pauses: number[] = [];
      const { watcher, feed, notify } = setup({
        sleep: async (ms) => {
          pauses.push(ms);
          await tick();
        },
      });
      await watcher.watch("s1");
      await tick();
      feed.push("s1");
      await tick();
      feed.push("s1", "fail");
      await tick();
      await tick();
      expect(pauses[0]).toBe(WATCH_RESTART_MIN_MS);
      expect(feed.followSession.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(notify).toHaveBeenCalledWith({ sessionId: "s1", live: false, changed: false });
      watcher.stopAll();
      expect(WATCH_RESTART_MAX_MS).toBeGreaterThan(WATCH_RESTART_MIN_MS);
    });
  });
});
