import { OrgApiError } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import { InMemoryOrgCloudMoveStore } from "./org-cloud-move-store";
import { FakeOrgInbox } from "./org-inbox-fake";
import {
  InMemoryOrgMessageOutbox,
  MAX_MESSAGE_OUTBOX_ENTRIES,
  OrgMessageOutboxUnavailableError,
  type OrgMessageOutboxEntry,
} from "./org-message-outbox";
import { createSharedSessionSendPort, type OrgInboxClient, OrgRemoteSend } from "./org-remote-send";
import type { OrgFlags } from "./org-service";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  remoteMode: true,
};
const SESSION = "sess-1";
const HELD = {
  sessionId: SESSION,
  orgId: "org",
  runId: "r",
  host: "h",
  movedAt: 1,
  messageCount: 1,
};

function setup(options: { flags?: OrgFlags; held?: boolean; client?: OrgInboxClient } = {}) {
  const inbox = new FakeOrgInbox();
  const moves = new InMemoryOrgCloudMoveStore();
  if (options.held !== false) moves.save([{ ...HELD, state: "cloud" }]);
  const outbox = new InMemoryOrgMessageOutbox();
  let counter = 0;
  let clock = 1_700_000_000_000;
  const getClient = vi.fn<() => Promise<OrgInboxClient>>(
    async () => options.client ?? inbox.client(),
  );
  const send = new OrgRemoteSend({
    getFlags: () => options.flags ?? ON,
    getClient,
    getSignedInOrgId: () => "org",
    moves,
    outbox,
    now: () => (clock += 1000),
    newId: () => `id${(counter += 1)}`,
  });
  return { inbox, moves, outbox, send, getClient };
}

const offline = () => new OrgApiError(0, "unreachable", "offline");

describe("OrgRemoteSend send", () => {
  it("posts to the inbox as the desktop and reports where the message stands", async () => {
    const { inbox, send } = setup();
    const result = await send.send({ sessionId: SESSION, text: "run the tests" });
    expect(result).toMatchObject({
      success: true,
      message: { status: "queued", mine: true, text: "run the tests", position: 0 },
    });
    expect(inbox.posts).toEqual([
      { sessionId: SESSION, clientMsgId: "desktop-id1", source: "desktop" },
    ]);
    const second = await send.send({ sessionId: SESSION, text: "and lint" });
    expect(second).toMatchObject({ success: true, message: { position: 1 } });
  });

  it("makes no call at all with the flag off", async () => {
    const { send, getClient, outbox } = setup({ flags: { ...ON, remoteMode: false } });
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "disabled",
    });
    expect(await send.getInbox(SESSION)).toEqual({ success: false, error: "disabled" });
    expect(await send.runHeld({ sessionId: SESSION, clientMsgId: "x", messageId: "y" })).toEqual({
      success: false,
      error: "disabled",
    });
    await send.flushOutbox();
    expect(getClient).not.toHaveBeenCalled();
    expect(outbox.entries).toEqual([]);
  });

  it("refuses an empty message, an oversized one and a session the cloud does not hold", async () => {
    const { send, inbox } = setup();
    expect(await send.send({ sessionId: SESSION, text: "  \n" })).toEqual({
      success: false,
      error: "empty",
    });
    expect(await send.send({ sessionId: SESSION, text: "é".repeat(33 * 1024) })).toEqual({
      success: false,
      error: "too-large",
    });
    expect(await send.send({ sessionId: "other", text: "hi" })).toEqual({
      success: false,
      error: "not-in-cloud",
    });
    expect(inbox.posts).toEqual([]);
  });

  it("does not post to a session whose move is still pending", async () => {
    const { send, moves, inbox } = setup();
    moves.save([{ ...HELD, state: "pending" }]);
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toMatchObject({
      success: false,
      error: "not-in-cloud",
    });
    expect(inbox.posts).toEqual([]);
  });

  it("passes the cloud's refusals through and does not queue them", async () => {
    const { send, inbox, outbox } = setup();
    inbox.home = "desktop";
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "not-in-cloud",
    });
    inbox.home = "cloud";
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the posts must reach the queue in order
      expect(await send.send({ sessionId: SESSION, text: `m${i}` })).toMatchObject({
        success: true,
      });
    }
    expect(await send.send({ sessionId: SESSION, text: "one too many" })).toEqual({
      success: false,
      error: "queue-full",
    });
    expect(outbox.entries).toEqual([]);
  });

  it("keeps a message that could not reach the cloud and sends it once when back, under the same id", async () => {
    const { send, inbox, outbox } = setup();
    inbox.failWith.push(offline());
    const result = await send.send({ sessionId: SESSION, text: "while offline" });
    expect(result).toMatchObject({
      success: true,
      message: { status: "offline", clientMsgId: "desktop-id1" },
    });
    expect(outbox.entries).toHaveLength(1);
    expect(inbox.messages).toEqual([]);

    await send.flushOutbox();
    await send.flushOutbox();
    expect(outbox.entries).toEqual([]);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.posts.map((p) => p.clientMsgId)).toEqual(["desktop-id1"]);
  });

  it("keeps the order: a message written behind a waiting one waits too, and they post oldest first", async () => {
    const { send, inbox, outbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "first" });
    const second = await send.send({ sessionId: SESSION, text: "second" });
    expect(second).toMatchObject({ success: true, message: { status: "offline" } });
    expect(outbox.entries.map((e) => e.text)).toEqual(["first", "second"]);

    await send.flushOutbox();
    expect(inbox.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("stops a session at the first message that cannot go and retries later", async () => {
    const { send, inbox, outbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "first" });
    await send.send({ sessionId: SESSION, text: "second" });
    inbox.failWith.push(new OrgApiError(503, "unavailable", "down"));
    await send.flushOutbox();
    expect(inbox.messages).toEqual([]);
    expect(outbox.entries.map((e) => e.attempts)).toEqual([1, 0]);
    await send.flushOutbox();
    expect(inbox.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("marks a queued message that the cloud refuses for good as failed and lets the person take it back", async () => {
    const { send, inbox, outbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "too late" });
    inbox.home = "desktop";
    await send.flushOutbox();
    expect(outbox.entries).toMatchObject([{ state: "failed", error: "not-in-cloud" }]);

    const inboxView = await send.getInbox(SESSION);
    expect(inboxView).toMatchObject({
      success: true,
      messages: [{ status: "failed", error: "not-in-cloud", text: "too late" }],
    });
    await send.flushOutbox();
    expect(inbox.posts).toHaveLength(1);

    expect(await send.cancel({ sessionId: SESSION, clientMsgId: "desktop-id1" })).toEqual({
      success: true,
      text: "too late",
    });
    expect(outbox.entries).toEqual([]);
  });

  it("refuses to queue past the outbox limit", async () => {
    const { send, inbox, outbox } = setup();
    outbox.entries = Array.from({ length: MAX_MESSAGE_OUTBOX_ENTRIES }, (_, i) => ({
      sessionId: "elsewhere",
      orgId: "org",
      clientMsgId: `old-${i}`,
      text: "x",
      queuedAt: i,
      attempts: 0,
      state: "pending" as const,
    }));
    inbox.failWith.push(offline());
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "outbox-full",
    });
  });

  it("says messages are unsupported for a client that predates the inbox (the installed pack)", async () => {
    const { send, outbox } = setup({
      client: { ...new FakeOrgInbox().client(), supports: () => false },
    });
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "messages-unsupported",
    });
    expect(outbox.entries).toEqual([]);
  });
});

describe("OrgRemoteSend inbox", () => {
  it("lists each message with who wrote it and where it stands, and the executor", async () => {
    const { send, inbox } = setup();
    inbox.executor = { state: "starting", estimatedStartSeconds: 40 };
    await send.send({ sessionId: SESSION, text: "mine" });
    inbox.addFrom("user:bob", "bob's idea");
    const view = await send.getInbox(SESSION);
    expect(view).toMatchObject({
      success: true,
      executor: { state: "starting", estimatedStartSeconds: 40 },
      messages: [
        { text: "mine", mine: true, status: "queued", source: "desktop" },
        { text: "bob's idea", mine: false, authorLabel: "bob", status: "held" },
      ],
    });
  });

  it("shows waiting messages with an offline notice when the cloud cannot be reached", async () => {
    const { send, inbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "waiting" });
    inbox.failWith.push(offline());
    const view = await send.getInbox(SESSION);
    expect(view).toMatchObject({
      success: true,
      offline: true,
      messages: [{ status: "offline", text: "waiting" }],
    });
  });

  it("does not list a waiting message twice once the cloud has it", async () => {
    const { send, inbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "once" });
    await send.flushOutbox();
    const view = await send.getInbox(SESSION);
    expect(view.success && view.messages.map((m) => m.text)).toEqual(["once"]);
  });

  it("pages past one list of messages", async () => {
    const { send, inbox } = setup();
    for (let i = 0; i < 130; i += 1) inbox.addFrom("user:bob", `m${i}`);
    const view = await send.getInbox(SESSION);
    expect(view.success && view.messages).toHaveLength(50);
    expect(view.success && view.messages.at(-1)?.text).toBe("m129");
  });
});

describe("OrgRemoteSend held and queued messages", () => {
  it("runs a held message as the owner's own, idempotently", async () => {
    const { send, inbox } = setup();
    const held = inbox.addFrom("user:bob", "bob's idea");
    const ref = { sessionId: SESSION, clientMsgId: "other-1", messageId: held.id };
    expect(await send.runHeld(ref)).toEqual({ success: true });
    expect(inbox.messages.map((m) => [m.status, m.author])).toEqual([
      ["cancelled", "user:bob"],
      ["queued", "user:alice"],
    ]);
    expect(await send.runHeld(ref)).toMatchObject({ success: false, error: "conflict" });
  });

  it("cancels a queued message and hands its text back, and refuses one already running", async () => {
    const { send, inbox } = setup();
    const posted = await send.send({ sessionId: SESSION, text: "undo me" });
    const id = posted.success ? posted.message.id : undefined;
    const ref = { sessionId: SESSION, clientMsgId: "desktop-id1", messageId: id };
    expect(await send.cancel(ref)).toEqual({ success: true, text: "undo me" });
    const running = await send.send({ sessionId: SESSION, text: "too late" });
    inbox.messages.at(-1)!.status = "claimed";
    expect(
      await send.cancel({
        sessionId: SESSION,
        clientMsgId: "desktop-id2",
        messageId: running.success ? running.message.id : undefined,
      }),
    ).toEqual({ success: false, error: "conflict" });
  });
});

describe("OrgRemoteSend reclaim", () => {
  it("hands back and clears every message of the session still in the outbox, oldest first", async () => {
    const { send, inbox, outbox } = setup();
    inbox.failWith.push(offline());
    await send.send({ sessionId: SESSION, text: "first" });
    await send.send({ sessionId: SESSION, text: "second" });
    outbox.entries.push({
      sessionId: "elsewhere",
      orgId: "org",
      clientMsgId: "e",
      text: "keep",
      queuedAt: 1,
      attempts: 0,
      state: "pending",
    });
    expect(await send.reclaim(SESSION)).toEqual([
      { clientMsgId: "desktop-id1", text: "first" },
      { clientMsgId: "desktop-id2", text: "second" },
    ]);
    expect(outbox.entries.map((e) => e.text)).toEqual(["keep"]);
    expect(await send.reclaim(SESSION)).toEqual([]);
  });

  it("works with the flag off, so a message is never stranded", async () => {
    const { send, outbox } = setup({ flags: { ...ON, remoteMode: false } });
    outbox.entries.push({
      sessionId: SESSION,
      orgId: "org",
      clientMsgId: "c",
      text: "stranded",
      queuedAt: 1,
      attempts: 0,
      state: "pending",
    });
    expect(await send.reclaim(SESSION)).toEqual([{ clientMsgId: "c", text: "stranded" }]);
  });
});

/** An outbox whose reads and writes take a moment, so two overlapping changes would lose one. */
class SlowOutbox extends InMemoryOrgMessageOutbox {
  override async load(): Promise<OrgMessageOutboxEntry[]> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return super.load();
  }
  override async save(entries: OrgMessageOutboxEntry[]): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await super.save(entries);
  }
}

function pendingEntry(clientMsgId: string, text: string, queuedAt: number): OrgMessageOutboxEntry {
  return {
    sessionId: SESSION,
    orgId: "org",
    clientMsgId,
    text,
    queuedAt,
    attempts: 0,
    state: "pending",
  };
}

/** A client whose posts wait until `release` is called, so a test can act while a post is in flight. */
function gatedClient(inbox: FakeOrgInbox, outcome: "ok" | "offline" = "ok") {
  const real = inbox.client();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let started: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client: OrgInboxClient = {
    ...real,
    postMessage: async (...args) => {
      started();
      await gate;
      if (outcome === "offline") throw offline();
      return real.postMessage(...args);
    },
  };
  return { client, release: open, inFlight };
}

describe("OrgRemoteSend outbox changes", () => {
  it("keeps every message when sends overlap on a slow outbox", async () => {
    const { inbox, moves } = setup();
    inbox.failWith.push(offline(), offline(), offline());
    const slow = new SlowOutbox();
    const racing = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => inbox.client(),
      getSignedInOrgId: () => "org",
      moves,
      outbox: slow,
    });
    const results = await Promise.all([
      racing.send({ sessionId: SESSION, text: "a" }),
      racing.send({ sessionId: SESSION, text: "b" }),
      racing.send({ sessionId: SESSION, text: "c" }),
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(slow.entries.map((e) => e.text).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a message written during a flush and removes only the one that posted", async () => {
    const { inbox, outbox, moves } = setup();
    outbox.entries = [pendingEntry("desktop-old", "old", 1)];
    const gated = gatedClient(inbox);
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => gated.client,
      getSignedInOrgId: () => "org",
      moves,
      outbox,
      newId: () => "new",
    });
    const flush = send.flushOutbox();
    await gated.inFlight;
    const written = await send.send({ sessionId: SESSION, text: "written meanwhile" });
    expect(written).toMatchObject({ success: true, message: { status: "offline" } });
    gated.release();
    await flush;
    expect(outbox.entries.map((e) => e.clientMsgId)).toEqual(["desktop-new"]);
    expect(inbox.messages.map((m) => m.clientMsgId)).toEqual(["desktop-old"]);
  });

  it("does not re-add a message taken back during the flush's post, and cancels it on the server when the post lands", async () => {
    const { inbox, outbox, moves } = setup();
    outbox.entries = [pendingEntry("desktop-old", "old", 1)];
    const gated = gatedClient(inbox);
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => gated.client,
      getSignedInOrgId: () => "org",
      moves,
      outbox,
    });
    const flush = send.flushOutbox();
    await gated.inFlight;
    expect(await send.cancel({ sessionId: SESSION, clientMsgId: "desktop-old" })).toEqual({
      success: true,
      text: "old",
    });
    gated.release();
    await flush;
    expect(outbox.entries).toEqual([]);
    expect(inbox.messages).toMatchObject([{ clientMsgId: "desktop-old", status: "cancelled" }]);
  });

  it("does not re-add a message reclaimed during the flush's post, and cancels it on the server when the post lands", async () => {
    const { inbox, outbox, moves } = setup();
    outbox.entries = [pendingEntry("desktop-old", "old", 1)];
    const gated = gatedClient(inbox);
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => gated.client,
      getSignedInOrgId: () => "org",
      moves,
      outbox,
    });
    const flush = send.flushOutbox();
    await gated.inFlight;
    expect(await send.reclaim(SESSION)).toEqual([{ clientMsgId: "desktop-old", text: "old" }]);
    gated.release();
    await flush;
    expect(outbox.entries).toEqual([]);
    expect(inbox.messages).toMatchObject([{ status: "cancelled" }]);
  });

  it("does not re-add a reclaimed message when its post fails", async () => {
    const { inbox, outbox, moves } = setup();
    outbox.entries = [pendingEntry("desktop-old", "old", 1)];
    const gated = gatedClient(inbox, "offline");
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => gated.client,
      getSignedInOrgId: () => "org",
      moves,
      outbox,
    });
    const flush = send.flushOutbox();
    await gated.inFlight;
    await send.reclaim(SESSION);
    gated.release();
    await flush;
    expect(outbox.entries).toEqual([]);
    expect(inbox.messages).toEqual([]);
  });

  it("does not post for a session the cloud no longer holds, and leaves the text for reclaim", async () => {
    const { send, inbox, outbox, moves } = setup();
    outbox.entries = [pendingEntry("desktop-old", "old", 1)];
    moves.save([]);
    await send.flushOutbox();
    expect(inbox.posts).toEqual([]);
    expect(outbox.entries).toMatchObject([{ state: "failed", error: "not-in-cloud" }]);
    expect(await send.reclaim(SESSION)).toEqual([{ clientMsgId: "desktop-old", text: "old" }]);
  });

  it("says the message was not saved when the outbox cannot be written, and keeps nothing", async () => {
    const { inbox, moves } = setup();
    inbox.failWith.push(offline());
    const unwritable = new InMemoryOrgMessageOutbox();
    unwritable.save = async () => {
      throw new OrgMessageOutboxUnavailableError();
    };
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => inbox.client(),
      getSignedInOrgId: () => "org",
      moves,
      outbox: unwritable,
    });
    expect(await send.send({ sessionId: SESSION, text: "while offline" })).toEqual({
      success: false,
      error: "outbox-unavailable",
    });
    expect(unwritable.entries).toEqual([]);
  });
});

describe("OrgRemoteSend sends in flight during Continue here", () => {
  function sender(inbox: FakeOrgInbox, client: OrgInboxClient) {
    const { moves, outbox } = setup();
    const send = new OrgRemoteSend({
      getFlags: () => ON,
      getClient: async () => client,
      getSignedInOrgId: () => "org",
      moves,
      outbox,
      newId: () => "new",
    });
    return { send, outbox, inbox };
  }

  it("cancels a post that lands after the return began, and keeps the text in the composer", async () => {
    const inbox = new FakeOrgInbox();
    const gated = gatedClient(inbox);
    const { send, outbox } = sender(inbox, gated.client);
    const sending = send.send({ sessionId: SESSION, text: "slow one" });
    await gated.inFlight;
    const end = send.beginReturn(SESSION);
    gated.release();
    expect(await sending).toEqual({ success: false, error: "not-in-cloud" });
    expect(inbox.messages.map((m) => m.status)).toEqual(["cancelled"]);
    expect(outbox.entries).toEqual([]);
    end();
  });

  it("keeps the text when the cancel's answer was lost, since the server may have cancelled it", async () => {
    const inbox = new FakeOrgInbox();
    const gated = gatedClient(inbox);
    const client: OrgInboxClient = {
      ...gated.client,
      cancelMessage: async () => {
        throw offline();
      },
    };
    const { send, outbox } = sender(inbox, client);
    const sending = send.send({ sessionId: SESSION, text: "slow one" });
    await gated.inFlight;
    const end = send.beginReturn(SESSION);
    gated.release();
    expect(await sending).toEqual({ success: false, error: "not-in-cloud" });
    expect(outbox.entries).toEqual([]);
    end();
  });

  it("treats a post as sent when the cancel finds it already run or returned (409)", async () => {
    const inbox = new FakeOrgInbox();
    const gated = gatedClient(inbox);
    const client: OrgInboxClient = {
      ...gated.client,
      cancelMessage: async () => {
        throw new OrgApiError(409, "conflict", "already claimed");
      },
    };
    const { send } = sender(inbox, client);
    const sending = send.send({ sessionId: SESSION, text: "slow one" });
    await gated.inFlight;
    const end = send.beginReturn(SESSION);
    gated.release();
    expect(await sending).toMatchObject({ success: true });
    end();
  });

  it("does not keep a message in the outbox whose post failed after the return began", async () => {
    const inbox = new FakeOrgInbox();
    const gated = gatedClient(inbox, "offline");
    const { send, outbox } = sender(inbox, gated.client);
    const sending = send.send({ sessionId: SESSION, text: "slow and offline" });
    await gated.inFlight;
    const end = send.beginReturn(SESSION);
    gated.release();
    expect(await sending).toEqual({ success: false, error: "not-in-cloud" });
    expect(outbox.entries).toEqual([]);
    end();
  });

  it("lets Continue here wait for a send in flight", async () => {
    const inbox = new FakeOrgInbox();
    const gated = gatedClient(inbox);
    const { send } = sender(inbox, gated.client);
    const sending = send.send({ sessionId: SESSION, text: "slow one" });
    await gated.inFlight;
    let settled = false;
    const waiting = send.settleSends(SESSION, 60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gated.release();
    await waiting;
    await sending;
    expect(settled).toBe(true);
  });

  it("answers at once when nothing is in flight, and gives up on one that never ends", async () => {
    const inbox = new FakeOrgInbox();
    const never = gatedClient(inbox);
    const { send } = sender(inbox, never.client);
    await expect(send.settleSends(SESSION, 60_000)).resolves.toBeUndefined();
    void send.send({ sessionId: SESSION, text: "never ends" });
    await never.inFlight;
    const started = Date.now();
    await send.settleSends(SESSION, 20);
    expect(Date.now() - started).toBeLessThan(2000);
    never.release();
  });

  it("keeps the session marked until every Continue here that began has ended", async () => {
    const { send, inbox, moves } = setup();
    const first = send.beginReturn(SESSION);
    const second = send.beginReturn(SESSION);
    first();
    first();
    expect(await send.send({ sessionId: SESSION, text: "still returning" })).toEqual({
      success: false,
      error: "not-in-cloud",
    });
    second();
    expect(await send.send({ sessionId: SESSION, text: "back to normal" })).toMatchObject({
      success: true,
    });
    expect(inbox.posts).toHaveLength(1);
    expect(moves.load()).toHaveLength(1);
  });
});

describe("OrgRemoteSend on a live shared session", () => {
  function shared(role: "viewer" | "collaborator" | "driver" = "collaborator") {
    const ctx = setup({ held: false });
    ctx.inbox.home = "desktop";
    ctx.inbox.liveFeature = true;
    ctx.inbox.live = true;
    ctx.inbox.role = role;
    return ctx;
  }

  it.each(["collaborator", "driver"] as const)(
    "posts a %s's message to a session someone else shared live, queued for the owner's Marshal",
    async (role) => {
      const { inbox, send } = shared(role);
      const result = await send.send({ sessionId: SESSION, text: "add a test" });
      expect(result).toMatchObject({
        success: true,
        message: { status: "queued", mine: true, text: "add a test" },
      });
      expect(inbox.posts).toEqual([
        { sessionId: SESSION, clientMsgId: "desktop-id1", source: "desktop" },
      ]);
    },
  );

  it("says why it cannot send: a viewer, live switched off, an organization without live sessions", async () => {
    const viewer = shared("viewer");
    expect(await viewer.send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "viewer",
    });
    const off = shared();
    off.inbox.live = false;
    expect(await off.send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "not-live",
    });
    const old = shared();
    old.inbox.liveFeature = false;
    expect(await old.send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "live-unsupported",
    });
    for (const ctx of [viewer, off, old]) expect(ctx.inbox.posts).toEqual([]);
  });

  it("keeps a cloud-held session on today's path: no read of the session view", async () => {
    const { inbox, send } = setup();
    inbox.liveFeature = true;
    await send.send({ sessionId: SESSION, text: "run" });
    expect(inbox.sessionReads).toBe(0);
  });

  it("keeps an own session that is neither cloud-held nor shared refused as before", async () => {
    const { inbox, send } = shared();
    inbox.role = "owner";
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "not-in-cloud",
    });
  });

  it("keeps a message for a live session that could not be posted and sends it when the organization is back", async () => {
    const { inbox, send, outbox } = shared();
    await send.send({ sessionId: SESSION, text: "first" });
    // The connection is gone: the view read and the post both fail, and the last known live state decides.
    inbox.failWith.push(offline(), offline());
    const second = await send.send({ sessionId: SESSION, text: "second" });
    expect(second).toMatchObject({ success: true, message: { status: "offline" } });
    expect(outbox.entries).toHaveLength(1);
    await send.flushOutbox();
    expect(outbox.entries).toEqual([]);
    expect(inbox.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("fails a waiting message for good once its session is no longer live, so it can be taken back", async () => {
    const { inbox, send, outbox } = shared();
    await send.send({ sessionId: SESSION, text: "first" });
    inbox.failWith.push(offline(), offline());
    await send.send({ sessionId: SESSION, text: "second" });
    inbox.live = false;
    await send.flushOutbox();
    expect(outbox.entries).toMatchObject([{ state: "failed", error: "not-live" }]);
  });

  it("refuses at once, without keeping or retrying it, when this person spent today's turns on the live session", async () => {
    const { inbox, send, outbox } = shared();
    inbox.budgetSpent = true;
    expect(await send.send({ sessionId: SESSION, text: "one more" })).toEqual({
      success: false,
      error: "turn-budget-spent",
    });
    expect(inbox.posts).toHaveLength(1);
    expect(outbox.entries).toEqual([]);
  });

  it("fails a waiting message for good when the budget is spent by the time it is sent, instead of retrying it", async () => {
    const { inbox, send, outbox } = shared();
    await send.send({ sessionId: SESSION, text: "first" });
    inbox.failWith.push(offline(), offline());
    await send.send({ sessionId: SESSION, text: "second" });
    inbox.budgetSpent = true;
    await send.flushOutbox();
    expect(outbox.entries).toMatchObject([
      { state: "failed", error: "turn-budget-spent", attempts: 0 },
    ]);
    const posts = inbox.posts.length;
    await send.flushOutbox();
    expect(inbox.posts).toHaveLength(posts);
  });

  it("refuses with unreachable when it cannot tell whether the session is live and never asked before", async () => {
    const { inbox, send, outbox } = shared();
    inbox.failWith.push(offline());
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "unreachable",
    });
    expect(outbox.entries).toEqual([]);
  });

  it("asks nothing about live sessions while remote mode is off", async () => {
    const { send, getClient } = setup({ held: false, flags: { ...ON, remoteMode: false } });
    expect(await send.send({ sessionId: SESSION, text: "hi" })).toEqual({
      success: false,
      error: "disabled",
    });
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("createSharedSessionSendPort", () => {
  it("posts an agent's message to a live shared session like the person's own", async () => {
    const { inbox, send } = setup({ held: false });
    inbox.home = "desktop";
    inbox.liveFeature = true;
    inbox.live = true;
    inbox.role = "collaborator";
    const port = createSharedSessionSendPort(send);
    const result = await port.send({ sessionId: SESSION, text: "summarize the diff" });
    expect(result).toMatchObject({ success: true, status: "queued" });
    expect(inbox.messages.map((m) => m.text)).toEqual(["summarize the diff"]);
  });

  it("returns typed refusals an agent can act on for a viewer and a session that is not live", async () => {
    const viewer = setup({ held: false });
    viewer.inbox.home = "desktop";
    viewer.inbox.liveFeature = true;
    viewer.inbox.role = "viewer";
    const asViewer = await createSharedSessionSendPort(viewer.send).send({
      sessionId: SESSION,
      text: "hi",
    });
    expect(asViewer).toMatchObject({ success: false, error: "viewer" });
    viewer.inbox.role = "collaborator";
    const notLive = await createSharedSessionSendPort(viewer.send).send({
      sessionId: SESSION,
      text: "hi",
    });
    expect(notLive).toMatchObject({
      success: false,
      error: "not-live",
      message: expect.stringMatching(/live collaboration/),
    });
  });

  it("tells an agent the daily turn budget is spent, by its typed code", async () => {
    const ctx = setup({ held: false });
    ctx.inbox.home = "desktop";
    ctx.inbox.liveFeature = true;
    ctx.inbox.live = true;
    ctx.inbox.role = "collaborator";
    ctx.inbox.budgetSpent = true;
    expect(
      await createSharedSessionSendPort(ctx.send).send({ sessionId: SESSION, text: "hi" }),
    ).toEqual({
      success: false,
      error: "turn-budget-spent",
      message: expect.stringMatching(/daily limit/),
    });
  });
});

describe("OrgRemoteSend inbox executor", () => {
  it("passes the executor's host kind through when the organization reports it", async () => {
    const { inbox, send } = setup();
    inbox.executor = { state: "hot", hostKind: "desktop" };
    expect(await send.getInbox(SESSION)).toMatchObject({
      success: true,
      executor: { state: "hot", hostKind: "desktop" },
    });
  });
});
