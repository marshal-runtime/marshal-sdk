import {
  isRoomRecordKey,
  type RoomActor,
  type RoomEvent,
  type RoomPresence,
  type RoomRecord,
  type RoomStatus,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrgSharedLiveView, SessionMessage } from "../../../common/marshal-ipc-contract";
import { orgMessageIdFor } from "./cloud-session-sanitizer";
import {
  CONVERSATION,
  OrgSharedRooms,
  STREAM_THROTTLE_MS,
  agentPresence,
  conversationRoomId,
  type ConversationRooms,
  type ConversationWriter,
  type SharedAgentSummary,
} from "./org-shared-rooms";

const ADA: UserPrincipal = "user:ada@example.com";
const BEN: UserPrincipal = "user:ben@example.com";
const ORG_SESSION = "sess-1";

/** The actor the host derives for a writer (the rooms service does this from the session). */
function actorOf(writer: ConversationWriter): RoomActor {
  return writer.kind === "person"
    ? { kind: "person" }
    : { kind: "agent", host: "desktop", session: writer.sessionId, runtime: "claude" };
}

/** One conversation room shared by fake desktops: writes apply at once and reach every other subscriber. */
class FakeRoom {
  readonly records = new Map<string, RoomRecord>();
  readonly presence = new Map<string, RoomPresence>();
  readonly writes: {
    author: UserPrincipal;
    key: string;
    fields?: Record<string, unknown>;
    writer: ConversationWriter;
  }[] = [];
  readonly appends: { key: string; more: string }[] = [];
  status: RoomStatus = "active";
  private readonly listeners = new Map<UserPrincipal, Set<(event: RoomEvent) => void>>();
  private seq = 0;

  emitTo(except: UserPrincipal | undefined, event: RoomEvent): void {
    for (const [who, set] of this.listeners)
      if (who !== except) for (const listener of set) listener(event);
  }

  private apply(
    me: UserPrincipal,
    key: RoomRecord["key"],
    fields: Record<string, unknown> | undefined,
    writer: ConversationWriter,
  ): void {
    const actor = actorOf(writer);
    this.seq += 1;
    const type = key.slice(0, key.indexOf(":"));
    if (fields)
      this.records.set(key, {
        key,
        type,
        fields,
        seq: this.seq,
        updatedBy: me,
        pending: false,
      });
    else this.records.delete(key);
    this.emitTo(me, {
      kind: "records",
      changes: [
        {
          seq: this.seq,
          epoch: "e1",
          pending: false,
          id: `c${this.seq}`,
          author: me,
          actor,
          at: new Date().toISOString(),
          record: key,
          type,
          op: fields ? "set" : "delete",
          ...(fields ? { set: fields } : {}),
        },
      ],
    });
  }

  rooms(
    me: UserPrincipal,
    options: { refuseOpen?: boolean; failWrites?: { left: number } } = {},
  ): ConversationRooms {
    return {
      open: async ({ orgSessionId }) => {
        if (options.refuseOpen) throw new Error("not a member");
        return { roomId: conversationRoomId(orgSessionId) };
      },
      status: () => this.status,
      get: (_roomId, key) => this.records.get(key),
      messages: () => [...this.records.values()],
      appendText: async (_roomId, key, more, writer) => {
        const current = this.records.get(key)?.fields;
        if (!isRoomRecordKey(key) || !current || typeof current.text !== "string")
          throw new Error("no such message");
        this.appends.push({ key, more });
        this.apply(me, key, { ...current, text: current.text + more }, writer);
      },
      write: async (_roomId, key, fields, writer) => {
        if (!isRoomRecordKey(key)) throw new Error(`not a record key: ${key}`);
        if (options.failWrites && options.failWrites.left > 0) {
          options.failWrites.left -= 1;
          throw new Error("refused");
        }
        this.writes.push({ author: me, key, ...(fields ? { fields } : {}), writer });
        this.apply(me, key, fields, writer);
      },
      setPresence: (_roomId, state, writer) => {
        this.presence.set(me, {
          principal: me,
          client: me,
          actor: actorOf(writer),
          state,
          at: new Date().toISOString(),
          self: false,
        });
        this.emitTo(me, { kind: "presence", presence: [...this.presence.values()] });
      },
      presence: () => [...this.presence.values()],
      subscribe: (_roomId, listener) => {
        const set = this.listeners.get(me) ?? new Set();
        set.add(listener);
        this.listeners.set(me, set);
        return () => set.delete(listener);
      },
    };
  }
}

type Listener = (
  sessionId: string,
  event: {
    type: string;
    origin?: string;
    delta?: string;
    message?: SessionMessage;
    retrying?: boolean;
  },
) => void;

/** One desktop: its local session, its host events and the bridge under test. */
function desktop(
  room: FakeRoom,
  me: UserPrincipal,
  options: {
    roomsOn?: () => boolean;
    refuseOpen?: boolean;
    failWrites?: { left: number };
    learnNames?: (principals: readonly string[]) => Promise<boolean>;
  } = {},
) {
  const localSessionId = me === ADA ? ORG_SESSION : "local-ben";
  const messages: SessionMessage[] = [];
  const listeners = new Set<Listener>();
  const views: OrgSharedLiveView[] = [];
  const state = { busy: false, open: true, summary: { busy: false } as SharedAgentSummary };
  const rooms = room.rooms(me, options);
  const bridge = new OrgSharedRooms({
    rooms: () => ((options.roomsOn?.() ?? true) ? rooms : undefined),
    links: () => [{ localSessionId, orgSessionId: ORG_SESSION, me }],
    describe: async () => ({ workspaceId: "ws-1", title: "Shared" }),
    labelOf: (principal) => (principal === ADA ? "Ada" : principal === BEN ? "Ben" : principal),
    learnNames: options.learnNames ?? (async () => false),
    notePerson: () => undefined,
    loadSession: () => ({ messages }),
    repoPath: () => "/Users/ada/work/app",
    isOpen: () => state.open,
    isBusy: () => state.busy,
    agentSummary: () => state.summary,
    appendRemote: (_sessionId, message) => {
      if (messages.some((existing) => existing.id === message.id)) return false;
      messages.push(message);
      return true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    liveChanged: (_sessionId, view) => views.push(view),
    homeDir: () => "/Users/ada",
  });
  const emit = (event: Parameters<Listener>[1]) => {
    for (const listener of listeners) listener(localSessionId, event);
  };
  return {
    bridge,
    messages,
    views,
    state,
    localSessionId,
    lastView: () => views.at(-1),
    commit(message: SessionMessage) {
      messages.push(message);
      emit({ type: "turn:message-committed", message });
    },
    delta(text: string) {
      emit({ type: "turn:text-delta", delta: text });
    },
    idle() {
      emit({ type: "turn:idle" });
    },
    emit,
  };
}

function userMessage(
  id: string,
  content: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  return { id, role: "user", content, timestamp: "2026-11-13T08:00:00.000Z", ...extra };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OrgSharedRooms", () => {
  it("sends a user message to the room at commit, scrubbed, and the other desktop stores it once", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    const ben = desktop(room, BEN);
    ada.bridge.start();
    ben.bridge.start();
    await ada.bridge.tick();
    await ben.bridge.tick();

    ada.commit(userMessage("u1", "Look at /Users/ada/work/app/src/a.ts please"));
    await settle();

    const key = `message:${orgMessageIdFor("u1")}`;
    expect(room.records.get(key)?.fields).toEqual({
      role: "user",
      author: ADA,
      text: "Look at ./src/a.ts please",
      state: "final",
      turn: orgMessageIdFor("u1"),
    });
    expect(room.writes.find((write) => write.key === key)?.writer).toEqual({ kind: "person" });
    const stored = ben.messages.filter((message) => message.orgRemote);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: `org-shared:${ORG_SESSION}:m:${orgMessageIdFor("u1")}`,
      role: "user",
      content: "Look at ./src/a.ts please",
      origin: "external",
      orgRemote: { author: ADA, authorLabel: "Ada", fromAgent: false },
    });
    // The same message arriving again (the transcript, or a replay) is not stored twice.
    await ben.bridge.tick();
    expect(ben.messages.filter((message) => message.orgRemote)).toHaveLength(1);
  });

  it("streams the reply while it is written, then replaces it with the finished message", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    const ben = desktop(room, BEN);
    ada.bridge.start();
    ben.bridge.start();
    await ada.bridge.tick();
    await ben.bridge.tick();

    ada.commit(userMessage("u1", "Explain"));
    ada.state.busy = true;
    ada.delta("The answer is ");
    ada.delta("forty-tw");
    await settle(STREAM_THROTTLE_MS);

    const streamKey = `message:${CONVERSATION.streamPrefix}${orgMessageIdFor("u1").slice(2)}`;
    expect(room.records.get(streamKey)?.fields).toMatchObject({
      role: "assistant",
      state: "streaming",
      text: "The answer is",
    });
    expect(room.writes.find((write) => write.key === streamKey)?.writer).toEqual({
      kind: "agent",
      sessionId: ORG_SESSION,
    });
    expect(ben.lastView()?.streaming).toEqual([
      { key: streamKey, author: ADA, authorLabel: "Ada", text: "The answer is" },
    ]);

    ada.delta("o, and here is why.");
    await settle(STREAM_THROTTLE_MS);
    expect(ben.lastView()?.streaming[0]?.text).toBe("The answer is forty-two, and here is");
    expect(room.appends).toEqual([{ key: streamKey, more: " forty-two, and here is" }]);

    ada.commit({
      id: "a1",
      role: "assistant",
      content: "The answer is forty-two, and here is why.",
      timestamp: "2026-11-13T08:00:01.000Z",
    });
    ada.state.busy = false;
    ada.idle();
    await settle(STREAM_THROTTLE_MS);

    expect(room.records.has(streamKey)).toBe(false);
    expect(ben.lastView()?.streaming).toEqual([]);
    expect(ben.messages.at(-1)).toMatchObject({
      id: `org-shared:${ORG_SESSION}:m:${orgMessageIdFor("a1")}`,
      role: "assistant",
      content: "The answer is forty-two, and here is why.",
      orgRemote: { author: ADA, fromAgent: true },
    });
  });

  it("streams nothing for a turn kept local (goal continuation), and sends no message for it", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    ada.bridge.start();
    await ada.bridge.tick();
    ada.commit(userMessage("g1", "continue the goal", { goalContinuation: true }));
    ada.state.busy = true;
    ada.delta("Working on step two now ");
    await settle(STREAM_THROTTLE_MS * 2);
    ada.commit({
      id: "a2",
      role: "assistant",
      content: "done",
      timestamp: "2026-11-13T08:00:02.000Z",
    });
    ada.state.busy = false;
    ada.idle();
    await settle(STREAM_THROTTLE_MS);
    expect(room.writes.filter((write) => write.key.startsWith("message:"))).toEqual([]);
  });

  it("publishes presence from host state only and shows the other person's strip and composing", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    const ben = desktop(room, BEN);
    ada.bridge.start();
    ben.bridge.start();
    ada.state.busy = true;
    ada.state.summary = {
      busy: true,
      todos: [
        { title: "Read the code", status: "done" },
        { title: "Write the fix", status: "in_progress" },
      ],
      filesChanged: 3,
      subagents: 1,
    };
    await ada.bridge.tick();
    await ben.bridge.tick();
    ada.bridge.setComposing(ada.localSessionId, true);

    expect(room.presence.get(ADA)?.state).toEqual({
      v: 1,
      open: true,
      composing: true,
      agent: {
        busy: true,
        step: "Write the fix",
        tasks: [
          { title: "Read the code", status: "done" },
          { title: "Write the fix", status: "in-progress" },
        ],
        filesChanged: 3,
        subagentsRunning: 1,
      },
    });
    expect(ben.lastView()).toMatchObject({
      live: true,
      people: [{ principal: ADA, label: "Ada", open: true, composing: true }],
      agents: [
        {
          principal: ADA,
          label: "Ada's Marshal",
          cloud: false,
          step: "Write the fix",
          tasks: [
            { text: "Read the code", done: true },
            { text: "Write the fix", done: false },
          ],
          filesChanged: 3,
          subagents: 1,
        },
      ],
    });
  });

  it("puts no presence out while the session is neither open nor working", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    ada.state.open = false;
    ada.bridge.start();
    await ada.bridge.tick();
    expect(room.presence.size).toBe(0);
    expect(agentPresence({ busy: false, filesChanged: 4 }, {})).toBeUndefined();
  });

  it("scrubs secrets and machine paths out of the todo titles it shows others", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const agent = agentPresence(
      {
        busy: true,
        todos: [
          { title: `Use ${token} for the push`, status: "done" },
          {
            title: "Fix /Users/ada/work/app/src/a.ts and /Users/ada/notes.md",
            status: "in_progress",
          },
        ],
      },
      { workspaceRoot: "/Users/ada/work/app", homeDir: "/Users/ada" },
    );
    const shown = JSON.stringify(agent);
    expect(shown).not.toContain(token);
    expect(shown).not.toContain("/Users/ada");
    expect(agent?.step).toBe("Fix ./src/a.ts and ~/notes.md");
  });

  it("writes the stream whole again after a refused write instead of appending to nothing", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const failWrites = { left: 0 };
    const ada = desktop(room, ADA, { failWrites });
    ada.bridge.start();
    await ada.bridge.tick();
    ada.commit(userMessage("u1", "Explain"));
    failWrites.left = 1;
    ada.delta("The first line\n");
    await settle(STREAM_THROTTLE_MS);
    const streamKey = `message:${CONVERSATION.streamPrefix}${orgMessageIdFor("u1").slice(2)}`;
    expect(room.records.has(streamKey)).toBe(false);

    ada.delta("The second line\n");
    await settle(STREAM_THROTTLE_MS);
    expect(room.appends).toEqual([]);
    expect(room.records.get(streamKey)?.fields).toMatchObject({
      text: "The first line\nThe second line",
    });
  });

  it("closes the stream when a turn fails without a retry", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    ada.bridge.start();
    await ada.bridge.tick();
    ada.commit(userMessage("u1", "Explain"));
    ada.delta("The answer is coming\n");
    await settle(STREAM_THROTTLE_MS);
    const streamKey = `message:${CONVERSATION.streamPrefix}${orgMessageIdFor("u1").slice(2)}`;
    expect(room.records.has(streamKey)).toBe(true);

    ada.emit({ type: "turn:error", retrying: true });
    await settle(STREAM_THROTTLE_MS);
    expect(room.records.has(streamKey)).toBe(true);

    ada.emit({ type: "turn:error" });
    await settle(STREAM_THROTTLE_MS);
    expect(room.records.has(streamKey)).toBe(false);
  });

  it("looks up the names of people as soon as they appear in the room", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const asked: string[][] = [];
    const ada = desktop(room, ADA, {
      learnNames: async (principals) => {
        asked.push([...principals]);
        return true;
      },
    });
    const ben = desktop(room, BEN);
    ada.bridge.start();
    ben.bridge.start();
    await ada.bridge.tick();
    await ben.bridge.tick();
    await settle();

    expect(asked.flat()).toContain(BEN);
    expect(asked.flat()).not.toContain(ADA);
  });

  it("stores what was written while it was away when it joins the room again", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const ada = desktop(room, ADA);
    ada.bridge.start();
    await ada.bridge.tick();
    ada.commit(userMessage("u1", "first"));
    ada.commit(userMessage("u2", "second"));
    await settle();

    const ben = desktop(room, BEN);
    // Ben's copy already has the first one from the transcript.
    ben.messages.push({
      id: `org-shared:${ORG_SESSION}:m:${orgMessageIdFor("u1")}`,
      role: "user",
      content: "first",
      timestamp: "t",
      origin: "external",
    });
    ben.bridge.start();
    await ben.bridge.tick();
    expect(ben.messages.map((message) => message.content)).toEqual(["first", "second"]);
  });

  it("does nothing while rooms are off, and closes the live view when they go off", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    let on = false;
    const ada = desktop(room, ADA, { roomsOn: () => on });
    ada.bridge.start();
    await ada.bridge.tick();
    ada.commit(userMessage("u1", "hello"));
    await settle();
    expect(room.writes).toEqual([]);
    expect(ada.bridge.isLive(ada.localSessionId)).toBe(false);

    on = true;
    await ada.bridge.tick();
    expect(ada.bridge.isLive(ada.localSessionId)).toBe(true);
    on = false;
    await ada.bridge.tick();
    expect(ada.bridge.isLive(ada.localSessionId)).toBe(false);
    expect(ada.lastView()).toEqual({ live: false, people: [], agents: [], streaming: [] });
  });

  it("keeps working on the transcript alone when the room refuses it, and clears streams on revoke", async () => {
    vi.useFakeTimers();
    const room = new FakeRoom();
    const refused = desktop(room, BEN, { refuseOpen: true });
    refused.bridge.start();
    await refused.bridge.tick();
    expect(refused.bridge.isLive(refused.localSessionId)).toBe(false);

    const ada = desktop(room, ADA);
    ada.bridge.start();
    await ada.bridge.tick();
    const viewer = desktop(room, BEN);
    viewer.bridge.start();
    await viewer.bridge.tick();
    ada.commit(userMessage("u1", "go"));
    ada.state.busy = true;
    ada.delta("partial reply text ");
    await settle(STREAM_THROTTLE_MS);
    expect(viewer.lastView()?.streaming).toHaveLength(1);
    room.status = "revoked";
    room.emitTo(ADA, { kind: "status", status: "revoked" });
    expect(viewer.lastView()).toMatchObject({ live: false, streaming: [] });
  });
});
