import os from "node:os";

import type {
  RoomEvent,
  RoomPresence,
  RoomRecord,
  RoomStatus,
  UserPrincipal,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import type { OrgSharedLiveView } from "./contract/org-types";
import type { SessionMessage } from "../host-deps";
import { createLogger } from "../host-deps";
import { orgMessageIdFor, scrubText, toOrgTranscriptMessage } from "./cloud-session-sanitizer";
import { isShareable, remoteMessageLocalId } from "./org-shared-sessions";
import { streamableReplyText } from "./org-shared-stream";

const log = createLogger("OrgSharedRooms");

/** How often the loop opens rooms for new links, closes them for dropped ones, and refreshes presence. */
const LOOP_MS = 1_000;
/** Fewest milliseconds between two updates of a reply being written. */
export const STREAM_THROTTLE_MS = 150;
/** Presence: at most one update per this, and one at least this often (the server forgets an entry after 15 s). */
const PRESENCE_MIN_MS = 500;
const PRESENCE_REFRESH_MS = 10_000;
/** The composer counts as in use this long after its last input. */
export const COMPOSING_HOLD_MS = 3_000;
const OPEN_BACKOFF_MS = 5_000;
const OPEN_MAX_BACKOFF_MS = 60_000;
/** A message whose text is larger than this skips the room; the transcript carries it. */
const MAX_ROOM_TEXT_BYTES = 48 * 1024;
const MAX_STEP_CHARS = 200;
const MAX_TASKS = 50;
/** How long the end of a turn waits for the session to report idle before writing its finished messages. */
const IDLE_SETTLE_MS = 250;
const IDLE_SETTLE_TRIES = 20;

/**
 * The contract's built-in conversation kind (`conversation-types.ts`, pack marshal-host-86): kind
 * `marshal/conversation`, room id `session:<org session id>`, records `message:<org message id>`.
 */
export const CONVERSATION = {
  kind: "marshal/conversation",
  roomPrefix: "session:",
  messageType: "message",
  /** A reply being written: its final org message id is known only when the runtime commits it. */
  streamPrefix: "t-",
} as const;

export function conversationRoomId(orgSessionId: string): string {
  return `${CONVERSATION.roomPrefix}${orgSessionId}`;
}

const messageFields = z.object({
  role: z.enum(["user", "assistant"]),
  author: z.string().startsWith("user:").max(256),
  text: z.string(),
  state: z.enum(["streaming", "final"]),
  /** The org message id of the user message that started the turn. */
  turn: z.string().max(160),
});
export type ConversationMessageFields = z.infer<typeof messageFields>;

const TASK_STATUSES = ["pending", "in-progress", "done", "blocked"] as const;
const presenceState = z.object({
  v: z.literal(1),
  /** The session is shown in a window on that desktop (false: only its agent is working there). */
  open: z.boolean().optional(),
  composing: z.boolean().optional(),
  agent: z
    .object({
      busy: z.boolean(),
      step: z.string().max(MAX_STEP_CHARS).optional(),
      tasks: z
        .array(z.object({ title: z.string().max(MAX_STEP_CHARS), status: z.enum(TASK_STATUSES) }))
        .max(MAX_TASKS)
        .optional(),
      filesChanged: z.number().int().min(0).max(1_000_000).optional(),
      subagentsRunning: z.number().int().min(0).max(10_000).optional(),
    })
    .optional(),
});
export type ConversationPresenceState = z.infer<typeof presenceState>;

/** What a desktop's agent is doing, from host state only: never text, tool input or output, or paths. */
export interface SharedAgentSummary {
  busy: boolean;
  todos?: readonly { title: string; status: string }[];
  filesChanged?: number;
  subagents?: number;
}

/** Who writes: the signed-in person, or the agent of one of this desktop's sessions; the host derives the actor. */
export type ConversationWriter = { kind: "person" } | { kind: "agent"; sessionId: string };

/** The rooms layer as the shared sessions use it: one conversation room per organization session. */
export interface ConversationRooms {
  /** Creates the session's room on first use (any writer may) or opens it; rejects when the session is not this person's to read. */
  open(input: { orgSessionId: string; workspaceId: string; title: string }): Promise<{
    roomId: string;
  }>;
  status(roomId: string): RoomStatus | undefined;
  get(roomId: string, key: string): RoomRecord | undefined;
  messages(roomId: string): RoomRecord[];
  /** `fields` undefined deletes the record. */
  write(
    roomId: string,
    key: string,
    fields: ConversationMessageFields | undefined,
    writer: ConversationWriter,
  ): Promise<void>;
  /** Adds to the end of an existing message's text (a streaming reply growing). */
  appendText(roomId: string, key: string, more: string, writer: ConversationWriter): Promise<void>;
  setPresence(roomId: string, state: ConversationPresenceState, writer: ConversationWriter): void;
  presence(roomId: string): RoomPresence[];
  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void;
}

/** A shared-session link as the room bridge sees it. */
export interface SharedLiveLink {
  localSessionId: string;
  orgSessionId: string;
  me: UserPrincipal;
}

type HostEvent = {
  type: string;
  origin?: string;
  delta?: string;
  message?: SessionMessage;
  retrying?: boolean;
};

export interface OrgSharedRoomsDeps {
  /** The rooms layer while `org.rooms` is on and the organization announces rooms; undefined otherwise. */
  rooms: () => ConversationRooms | undefined;
  /** Active links of the person signed in now. */
  links: () => SharedLiveLink[];
  /** The organization envelope of a session, for creating its room. */
  describe: (orgSessionId: string) => Promise<{ workspaceId: string; title: string } | undefined>;
  labelOf: (principal: string) => string;
  /** Looks up the names of people first seen in a room; resolves true when it learned any. */
  learnNames: (principals: readonly string[]) => Promise<boolean>;
  notePerson: (localSessionId: string, principal: string) => void;
  loadSession: (
    localSessionId: string,
  ) => { messages: readonly SessionMessage[]; repoPath?: string } | null;
  repoPath: (localSessionId: string) => string | undefined;
  isOpen: (localSessionId: string) => boolean;
  isBusy: (localSessionId: string) => boolean;
  agentSummary: (localSessionId: string) => SharedAgentSummary;
  appendRemote: (localSessionId: string, message: SessionMessage) => boolean;
  subscribe: (listener: (sessionId: string, event: HostEvent) => void) => () => void;
  /** The live view of a session changed; pushed to its open windows. */
  liveChanged: (localSessionId: string, view: OrgSharedLiveView) => void;
  homeDir?: () => string;
  now?: () => number;
}

interface StreamingView {
  author: string;
  turn: string;
  text: string;
}

interface OpenRoom {
  link: SharedLiveLink;
  roomId: string;
  unsubscribe: () => void;
  presence: RoomPresence[];
  streaming: Map<string, StreamingView>;
  lastPresence?: string;
  lastPresenceAt: number;
}

interface ReplyStream {
  /** Empty for a turn this desktop keeps to itself: nothing of its reply streams. */
  key: string;
  turn: string;
  committed: string;
  current: string;
  sent: string;
  lastSentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

function cleanLabel(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 0x1f || code === 0x7f ? " " : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A failure for the log: the error's class and, for a rooms refusal, its typed code and field. Never its message. */
function failureOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
  const field = "field" in error && typeof error.field === "string" ? ` field=${error.field}` : "";
  return `${error.name}${code}${field}`;
}

function fitsRoom(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_ROOM_TEXT_BYTES;
}

function taskStatus(status: string): (typeof TASK_STATUSES)[number] {
  if (status === "in_progress") return "in-progress";
  return status === "done" || status === "blocked" ? status : "pending";
}

/**
 * The agent strip of a presence state: the in-progress todo as the step, titles capped, counts only.
 * Todo titles are model-written, so they get the same secret and path scrub as the transcript.
 */
export function agentPresence(
  summary: SharedAgentSummary,
  roots: Parameters<typeof scrubText>[1],
): ConversationPresenceState["agent"] | undefined {
  if (!summary.busy) return undefined;
  const todos = summary.todos ?? [];
  const step = todos.find((todo) => todo.status === "in_progress");
  const label = (title: string) => scrubText(cleanLabel(title), roots).slice(0, MAX_STEP_CHARS);
  return {
    busy: true,
    ...(step ? { step: label(step.title) } : {}),
    ...(todos.length > 0
      ? {
          tasks: todos.slice(0, MAX_TASKS).map((todo) => ({
            title: label(todo.title),
            status: taskStatus(todo.status),
          })),
        }
      : {}),
    ...(summary.filesChanged ? { filesChanged: summary.filesChanged } : {}),
    ...(summary.subagents ? { subagentsRunning: summary.subagents } : {}),
  };
}

function agentFields(
  agent: NonNullable<ConversationPresenceState["agent"]>,
): Omit<OrgSharedLiveView["agents"][number], "principal" | "label" | "cloud"> {
  return {
    ...(agent.step ? { step: cleanLabel(agent.step).slice(0, MAX_STEP_CHARS) } : {}),
    ...(agent.tasks
      ? {
          tasks: agent.tasks.map((task) => ({
            text: cleanLabel(task.title).slice(0, MAX_STEP_CHARS),
            done: task.status === "done",
          })),
        }
      : {}),
    ...(agent.filesChanged !== undefined ? { filesChanged: agent.filesChanged } : {}),
    ...(agent.subagentsRunning !== undefined ? { subagents: agent.subagentsRunning } : {}),
  };
}

/**
 * Shared sessions over rooms: each active link also joins its session's conversation room. This
 * desktop's messages go to the room at commit, its Marshal's reply streams while it is written (only
 * what the finished message would share), and others' messages arrive at once. The phase-1
 * transcript stays the history; both paths name a message by its transcript id, so a desktop shows
 * it once whichever arrives first. Inert while rooms are off.
 */
export class OrgSharedRooms {
  private readonly open = new Map<string, OpenRoom>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, { at: number; delay: number }>();
  private readonly streams = new Map<string, ReplyStream>();
  private readonly composingUntil = new Map<string, number>();
  private loop: ReturnType<typeof setInterval> | undefined;
  private unsubscribeHost: (() => void) | null = null;
  private running = false;

  constructor(private readonly deps: OrgSharedRoomsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.unsubscribeHost) return;
    this.unsubscribeHost = this.deps.subscribe((sessionId, event) =>
      this.onHostEvent(sessionId, event),
    );
    this.loop = setInterval(() => void this.tick(), LOOP_MS);
    this.loop.unref?.();
  }

  stop(): void {
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    if (this.loop !== undefined) clearInterval(this.loop);
    this.loop = undefined;
    for (const localSessionId of [...this.open.keys()]) this.close(localSessionId);
    for (const stream of this.streams.values()) if (stream.timer) clearTimeout(stream.timer);
    this.streams.clear();
  }

  /** The session's room is joined and connected: the transcript poll can drop to its background rate. */
  isLive(localSessionId: string): boolean {
    const room = this.open.get(localSessionId);
    if (!room) return false;
    return this.deps.rooms()?.status(room.roomId) === "active";
  }

  /** The person typed in the composer (or sent or cleared it). */
  setComposing(localSessionId: string, composing: boolean): void {
    if (composing) this.composingUntil.set(localSessionId, this.now() + COMPOSING_HOLD_MS);
    else this.composingUntil.delete(localSessionId);
    this.publishPresence(localSessionId, true);
  }

  view(localSessionId: string): OrgSharedLiveView | undefined {
    const room = this.open.get(localSessionId);
    return room ? this.viewOf(room) : undefined;
  }

  /** One pass: open rooms for links, close the rest, refresh presence. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rooms = this.deps.rooms();
      const links = rooms ? this.deps.links() : [];
      const wanted = new Map(links.map((link) => [link.localSessionId, link]));
      for (const localSessionId of [...this.open.keys()]) {
        const link = wanted.get(localSessionId);
        if (!link || link.orgSessionId !== this.open.get(localSessionId)?.link.orgSessionId)
          this.close(localSessionId);
      }
      for (const link of wanted.values()) {
        // oxlint-disable-next-line no-await-in-loop -- rooms open one at a time; each is a single request
        if (!this.open.has(link.localSessionId)) await this.openFor(link);
        this.publishPresence(link.localSessionId, false);
      }
    } finally {
      this.running = false;
    }
  }

  private openFor(link: SharedLiveLink): Promise<void> {
    const pending = this.opening.get(link.localSessionId);
    if (pending) return pending;
    const retry = this.retryAt.get(link.localSessionId);
    if (retry && retry.at > this.now()) return Promise.resolve();
    const run = this.runOpen(link).finally(() => this.opening.delete(link.localSessionId));
    this.opening.set(link.localSessionId, run);
    return run;
  }

  private async runOpen(link: SharedLiveLink): Promise<void> {
    const rooms = this.deps.rooms();
    if (!rooms) return;
    let roomId: string;
    try {
      const envelope = await this.deps.describe(link.orgSessionId);
      if (!envelope) throw new Error("session-unknown");
      ({ roomId } = await rooms.open({ orgSessionId: link.orgSessionId, ...envelope }));
    } catch (error) {
      const delay = Math.min(
        (this.retryAt.get(link.localSessionId)?.delay ?? OPEN_BACKOFF_MS / 2) * 2,
        OPEN_MAX_BACKOFF_MS,
      );
      this.retryAt.set(link.localSessionId, { at: this.now() + delay, delay });
      log.info(`Conversation room not opened (${failureOf(error)}); phase-1 sync continues`);
      return;
    }
    this.retryAt.delete(link.localSessionId);
    if (this.deps.rooms() !== rooms || this.open.has(link.localSessionId)) return;
    const room: OpenRoom = {
      link,
      roomId,
      unsubscribe: () => undefined,
      presence: rooms.presence(roomId),
      streaming: new Map(),
      lastPresenceAt: 0,
    };
    this.open.set(link.localSessionId, room);
    room.unsubscribe = rooms.subscribe(roomId, (event) => this.onRoomEvent(room, event));
    this.catchUp(room, rooms);
    this.publishPresence(link.localSessionId, true);
    this.changed(room);
    this.learnNamesFor(room);
  }

  private close(localSessionId: string): void {
    const room = this.open.get(localSessionId);
    if (!room) return;
    room.unsubscribe();
    this.open.delete(localSessionId);
    const stream = this.streams.get(localSessionId);
    if (stream?.timer) clearTimeout(stream.timer);
    this.streams.delete(localSessionId);
    this.deps.liveChanged(localSessionId, { live: false, people: [], agents: [], streaming: [] });
  }

  // ── Incoming ─────────────────────────────────────────────────────────────

  /**
   * Finished messages the room holds that this desktop does not (it was offline, or opened the room
   * late). A reply already being written is shown from its next update: an old stream record may
   * belong to a desktop that quit mid-turn.
   */
  private catchUp(room: OpenRoom, rooms: ConversationRooms): void {
    const session = this.deps.loadSession(room.link.localSessionId);
    const known = new Set(session?.messages.map((message) => message.id));
    for (const record of rooms.messages(room.roomId)) {
      this.takeRecord(room, record, { known, catchUp: true });
    }
  }

  private onRoomEvent(room: OpenRoom, event: RoomEvent): void {
    const rooms = this.deps.rooms();
    if (!rooms || this.open.get(room.link.localSessionId) !== room) return;
    switch (event.kind) {
      case "records": {
        if (event.changes.length === 0) {
          // A reset: re-read what the room holds.
          room.streaming.clear();
          this.catchUp(room, rooms);
          this.changed(room);
          return;
        }
        let touched = false;
        for (const change of event.changes) {
          if (change.pending || change.type !== CONVERSATION.messageType) continue;
          if (change.author === room.link.me) continue;
          if (change.op === "delete") {
            touched = room.streaming.delete(change.record) || touched;
            continue;
          }
          const record = rooms.get(room.roomId, change.record);
          if (record) touched = this.takeRecord(room, record, {}) || touched;
        }
        if (touched) this.changed(room);
        return;
      }
      case "presence":
        room.presence = event.presence;
        this.changed(room);
        this.learnNamesFor(room);
        return;
      case "status":
        if (event.status === "revoked" || event.status === "gone") room.streaming.clear();
        this.changed(room);
        return;
      case "refused":
        log.info(`A conversation change was refused: code=${event.code}`);
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /** One message record from someone else: stored when finished, shown live while being written. True when the view changed. */
  private takeRecord(
    room: OpenRoom,
    record: RoomRecord,
    options: { known?: Set<string>; catchUp?: boolean },
  ): boolean {
    if (record.type !== CONVERSATION.messageType || record.updatedBy === room.link.me) return false;
    const parsed = messageFields.safeParse(record.fields);
    if (!parsed.success || parsed.data.author !== record.updatedBy) return false;
    const fields = parsed.data;
    if (fields.state === "streaming") {
      if (options.catchUp) return false;
      room.streaming.set(record.key, {
        author: fields.author,
        turn: fields.turn,
        text: fields.text,
      });
      return true;
    }
    let touched = false;
    if (fields.role === "assistant") {
      // The finished reply takes the place of its stream on the screen.
      for (const [key, stream] of room.streaming) {
        if (stream.author === fields.author && stream.turn === fields.turn) {
          room.streaming.delete(key);
          touched = true;
        }
      }
    }
    const orgMessageId = record.key.slice(CONVERSATION.messageType.length + 1);
    const localId = remoteMessageLocalId(room.link.orgSessionId, orgMessageId);
    if (options.known?.has(localId)) return touched;
    const message: SessionMessage = {
      id: localId,
      role: fields.role,
      content: fields.text,
      timestamp: new Date(this.now()).toISOString(),
      origin: "external",
      orgRemote: {
        author: fields.author,
        authorLabel: this.deps.labelOf(fields.author),
        fromAgent: fields.role === "assistant",
      },
    };
    if (this.deps.appendRemote(room.link.localSessionId, message)) {
      this.deps.notePerson(room.link.localSessionId, fields.author);
      touched = true;
    }
    return touched;
  }

  private viewOf(room: OpenRoom): OrgSharedLiveView {
    const people = new Map<string, OrgSharedLiveView["people"][number]>();
    const agents: OrgSharedLiveView["agents"] = [];
    for (const entry of room.presence) {
      if (entry.self) continue;
      const parsed = presenceState.safeParse(entry.state);
      const state: Partial<ConversationPresenceState> = parsed.success ? parsed.data : {};
      if (entry.actor.kind === "agent" && entry.actor.host === "cloud") {
        if (state.agent?.busy)
          agents.push({
            principal: entry.principal,
            label: `Team agent · asked by ${this.deps.labelOf(entry.actor.askedBy)}`,
            cloud: true,
            ...agentFields(state.agent),
          });
        continue;
      }
      if (entry.principal === room.link.me) continue;
      const label = this.deps.labelOf(entry.principal);
      const before = people.get(entry.principal);
      people.set(entry.principal, {
        principal: entry.principal,
        label,
        open: (before?.open ?? false) || state.open !== false,
        composing: (before?.composing ?? false) || state.composing === true,
      });
      if (state.agent?.busy)
        agents.push({
          principal: entry.principal,
          label: `${label}'s Marshal`,
          cloud: false,
          ...agentFields(state.agent),
        });
    }
    return {
      live: this.deps.rooms()?.status(room.roomId) === "active",
      people: [...people.values()],
      agents,
      streaming: [...room.streaming.entries()].map(([key, stream]) => ({
        key,
        author: stream.author,
        authorLabel: this.deps.labelOf(stream.author),
        text: stream.text,
      })),
    };
  }

  /** Names of the people present, so their messages arrive with names; the view is pushed again once known. */
  private learnNamesFor(room: OpenRoom): void {
    const principals = [
      ...new Set(
        room.presence
          .filter((entry) => !entry.self && entry.principal !== room.link.me)
          .map((entry) => entry.principal),
      ),
    ];
    if (principals.length === 0) return;
    void this.deps
      .learnNames(principals)
      .then((learned) => {
        if (learned && this.open.get(room.link.localSessionId) === room) this.changed(room);
      })
      .catch((error: unknown) => log.info(`Names not looked up (${failureOf(error)})`));
  }

  private changed(room: OpenRoom): void {
    this.deps.liveChanged(room.link.localSessionId, this.viewOf(room));
  }

  // ── Outgoing ─────────────────────────────────────────────────────────────

  private roots(localSessionId: string): { workspaceRoot?: string; homeDir: string } {
    return {
      workspaceRoot: this.deps.repoPath(localSessionId),
      homeDir: this.deps.homeDir?.() ?? os.homedir(),
    };
  }

  private onHostEvent(sessionId: string, event: HostEvent): void {
    const room = this.open.get(sessionId);
    if (!room || event.origin === "external") return;
    switch (event.type) {
      case "turn:message-committed": {
        const message = event.message;
        if (!message) return;
        if (message.role === "user") this.userCommitted(room, message);
        else if (message.role === "assistant") this.assistantCommitted(room, message);
        return;
      }
      case "turn:text-delta": {
        const stream = this.streams.get(sessionId);
        if (!stream || stream.stopped || !event.delta) return;
        stream.current += event.delta;
        this.scheduleStream(room, stream);
        return;
      }
      case "turn:error":
        // A failed turn that is not being retried ends like an idle one (sessions.ts treats it so).
        if (event.retrying === true) return;
        void this.turnEnded(room);
        this.publishPresence(sessionId, true);
        return;
      case "turn:idle":
        void this.turnEnded(room);
        this.publishPresence(sessionId, true);
        return;
      default:
    }
  }

  private write(
    room: OpenRoom,
    key: string,
    fields: ConversationMessageFields | undefined,
    writer: ConversationWriter,
  ): Promise<void> {
    const rooms = this.deps.rooms();
    if (!rooms) return Promise.resolve();
    return rooms.write(room.roomId, key, fields, writer).catch((error: unknown) => {
      log.info(`Conversation write failed (${failureOf(error)}); the transcript still carries it`);
    });
  }

  private userCommitted(room: OpenRoom, message: SessionMessage): void {
    const localSessionId = room.link.localSessionId;
    const previous = this.streams.get(localSessionId);
    if (!isShareable(message)) {
      // A turn this desktop keeps to itself (hidden control, goal continuation): nothing of its reply streams.
      if (previous) previous.stopped = true;
      else this.streams.set(localSessionId, this.emptyStream(true));
      return;
    }
    const converted = toOrgTranscriptMessage(message, this.roots(localSessionId));
    if (!converted) return;
    const orgMessageId = orgMessageIdFor(message.id);
    if (fitsRoom(converted.text))
      void this.write(
        room,
        `${CONVERSATION.messageType}:${orgMessageId}`,
        {
          role: "user",
          author: room.link.me,
          text: converted.text,
          state: "final",
          turn: orgMessageId,
        },
        { kind: "person" },
      );
    // A message sent while the reply to an earlier one is still being written joins that turn's stream.
    if (previous && !previous.stopped && previous.key) return;
    this.streams.set(localSessionId, {
      ...this.emptyStream(false),
      key: `${CONVERSATION.messageType}:${CONVERSATION.streamPrefix}${orgMessageId.slice(2)}`,
      turn: orgMessageId,
    });
  }

  private emptyStream(stopped: boolean): ReplyStream {
    return { key: "", turn: "", committed: "", current: "", sent: "", lastSentAt: 0, stopped };
  }

  private assistantCommitted(room: OpenRoom, message: SessionMessage): void {
    const stream = this.streams.get(room.link.localSessionId);
    if (!stream || stream.stopped) return;
    stream.committed += `${message.content}\n\n`;
    stream.current = "";
    this.scheduleStream(room, stream);
  }

  private scheduleStream(room: OpenRoom, stream: ReplyStream): void {
    if (stream.timer) return;
    const wait = Math.max(0, stream.lastSentAt + STREAM_THROTTLE_MS - this.now());
    stream.timer = setTimeout(() => {
      stream.timer = undefined;
      this.sendStream(room, stream);
    }, wait);
  }

  private sendStream(room: OpenRoom, stream: ReplyStream): void {
    if (stream.stopped || this.streams.get(room.link.localSessionId) !== stream) return;
    const text = streamableReplyText(
      stream.committed + stream.current,
      this.roots(room.link.localSessionId),
    );
    if (!text || text === stream.sent) return;
    if (!fitsRoom(text)) {
      // Too long to keep streaming; the finished reply comes through the transcript.
      stream.stopped = true;
      return;
    }
    const previous = stream.sent;
    stream.sent = text;
    stream.lastSentAt = this.now();
    const writer: ConversationWriter = { kind: "agent", sessionId: room.link.localSessionId };
    const rooms = this.deps.rooms();
    if (previous && text.startsWith(previous) && rooms) {
      // Growing text goes as an append: once text fields merge, that is a splice at the end, not a rewrite.
      void rooms
        .appendText(room.roomId, stream.key, text.slice(previous.length), writer)
        .catch((error: unknown) => {
          log.info(
            `Conversation append failed (${failureOf(error)}); the next send writes it whole`,
          );
          this.resend(stream, text);
        });
      return;
    }
    const roomsNow = this.deps.rooms();
    if (!roomsNow) return;
    void roomsNow
      .write(
        room.roomId,
        stream.key,
        { role: "assistant", author: room.link.me, text, state: "streaming", turn: stream.turn },
        writer,
      )
      .catch((error: unknown) => {
        log.info(`Conversation write failed (${failureOf(error)}); the next send writes it whole`);
        this.resend(stream, text);
      });
  }

  /**
   * A stream send failed: forget what was sent so the next delta's send is a whole write, not an
   * append onto a record that may not exist. No retry of its own, so a refusing room is not hammered.
   */
  private resend(stream: ReplyStream, failed: string): void {
    if (stream.sent.startsWith(failed)) stream.sent = "";
  }

  /**
   * The turn ended: each assistant message it committed goes final under its transcript id (the same
   * list and scrub phase 1 pushes now), then the stream record goes away.
   */
  private async turnEnded(room: OpenRoom): Promise<void> {
    const localSessionId = room.link.localSessionId;
    const stream = this.streams.get(localSessionId);
    this.streams.delete(localSessionId);
    if (stream?.timer) clearTimeout(stream.timer);
    if (!stream?.key) return;
    for (let tries = 0; this.deps.isBusy(localSessionId) && tries < IDLE_SETTLE_TRIES; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the session to report idle, one short sleep at a time
      await new Promise((resolve) => setTimeout(resolve, IDLE_SETTLE_MS));
    }
    if (this.open.get(localSessionId) !== room) return;
    const actor: ConversationWriter = { kind: "agent", sessionId: localSessionId };
    const session = this.deps.loadSession(localSessionId);
    if (session) {
      const start = session.messages.findIndex(
        (message) => orgMessageIdFor(message.id) === stream.turn,
      );
      const roots = this.roots(localSessionId);
      for (const message of session.messages.slice(start + 1)) {
        if (message.role !== "assistant" || !isShareable(message)) continue;
        const converted = toOrgTranscriptMessage(message, roots);
        if (!converted || !fitsRoom(converted.text)) continue;
        // oxlint-disable-next-line no-await-in-loop -- finals go in order, so the receiver stores them in order
        await this.write(
          room,
          `${CONVERSATION.messageType}:${orgMessageIdFor(message.id)}`,
          {
            role: "assistant",
            author: room.link.me,
            text: converted.text,
            state: "final",
            turn: stream.turn,
          },
          actor,
        );
      }
    }
    if (stream.sent) await this.write(room, stream.key, undefined, actor);
  }

  // ── Presence ─────────────────────────────────────────────────────────────

  private presenceFor(localSessionId: string): ConversationPresenceState | undefined {
    const open = this.deps.isOpen(localSessionId);
    const agent = agentPresence(this.deps.agentSummary(localSessionId), this.roots(localSessionId));
    if (!open && !agent) return undefined;
    const composing = (this.composingUntil.get(localSessionId) ?? 0) > this.now();
    if (!composing) this.composingUntil.delete(localSessionId);
    return { v: 1, open, ...(composing ? { composing } : {}), ...(agent ? { agent } : {}) };
  }

  /** Presence while the session is shown in a window or its agent works; otherwise the entry lapses on its own. */
  private publishPresence(localSessionId: string, soon: boolean): void {
    const room = this.open.get(localSessionId);
    const rooms = this.deps.rooms();
    if (!room || !rooms) return;
    const state = this.presenceFor(localSessionId);
    if (!state) {
      room.lastPresence = undefined;
      return;
    }
    const serialized = JSON.stringify(state);
    const now = this.now();
    const sinceLast = now - room.lastPresenceAt;
    if (serialized === room.lastPresence && sinceLast < PRESENCE_REFRESH_MS) return;
    if (sinceLast < PRESENCE_MIN_MS && !soon) return;
    room.lastPresence = serialized;
    room.lastPresenceAt = now;
    try {
      rooms.setPresence(room.roomId, state, { kind: "person" });
    } catch (error) {
      log.info(`Presence not sent (${failureOf(error)})`);
    }
  }
}
