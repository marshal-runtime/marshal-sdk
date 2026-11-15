/**
 * Asking a person through a Marshal collaboration room (a `PersonRoute`, src/decisions.ts).
 *
 * A session's question goes into the conversation room of its org session (`session:<org session id>`, runtime
 * packages/agent-runtime-org/src/rooms): an `assistant` message written for the session's owner, so everyone the
 * session is shared with sees it in their Marshal. The first answer wins, from either of two places:
 *
 * - a reply in the room: a final `user` message whose `replyTo` is the question's record key;
 * - the org inbox: the next instruction someone posts to that session from their Marshal. The org bridge
 *   (src/org-bridge.ts) offers each claimed message to `takeInboxAnswer` before it runs it.
 *
 * The answer reaches the asking session through `DecisionDesk.answer`, as a message from that person. Writes go through
 * the runtime's rooms API (`RoomsApi.open`), which a host binds and which derives the writer from its own sign-in; this
 * module only needs the part of a room below, so a test passes a fake room.
 */
import type { UserPrincipal } from "@marshal/agent-runtime-org";

import type { AnswerResult, DecisionEntry, InboundAnswer, PersonRoute } from "./decisions.js";
import { orgSessionIdOf } from "./org-publish.js";

/** The room id prefix of a conversation room (runtime rooms/conversation-types.ts CONVERSATION_ROOM_PREFIX). */
export const CONVERSATION_ROOM_PREFIX = "session:";
const MESSAGE_ID = /^[A-Za-z0-9._:~-]{1,128}$/;
const MAX_ROOM_TEXT = 16_000;

/** A record as the runtime's `Room.query` returns it; `updatedBy` is who the server says wrote it. */
export interface ConversationRoomRecord {
  key: string;
  fields: Record<string, unknown>;
  updatedBy?: string;
  pending?: boolean;
}

/** The part of the runtime's `Room` (rooms/api.ts) this route uses. */
export interface ConversationRoomLike {
  readonly id: string;
  query(filter: { type: string }): ConversationRoomRecord[];
  set(key: string, fields: Record<string, unknown>): Promise<void>;
  subscribe(listener: (event: { kind: string }) => void): () => void;
}

export interface ConversationRoomRouteOptions {
  /** Route id. Default `room`. */
  id?: string;
  /**
   * Opens (creating when needed) a conversation room by id: on a host with the runtime's rooms service bound, the
   * room from `RoomsApi.open(roomId)`; undefined when the session is not shared in the organization.
   */
  openRoom(roomId: string): Promise<ConversationRoomLike | undefined>;
  /** The session owner: a question is the agent's message, and the agent's messages belong to the owner. */
  owner: UserPrincipal;
  /** The org session of a local session. Default `msdk-<id>`, as the org bridge publishes it. */
  orgSessionIdOf?: (sessionId: string) => string;
  /** A person's display name for the answer's sender line. */
  nameOf?: (principal: string) => string | undefined;
}

interface Asked {
  entry: DecisionEntry;
  room: ConversationRoomLike;
  key: string;
}

export function conversationRoomId(orgSessionId: string): string {
  return `${CONVERSATION_ROOM_PREFIX}${orgSessionId}`;
}

/** The question as the room shows it, with numbered options a person can answer by number. */
export function questionText(entry: DecisionEntry): string {
  const options = (entry.options ?? []).map(
    (option, index) => `${index + 1}. ${option.title}${index === entry.recommendedIndex ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`,
  );
  const how = options.length ? "Reply with a number or your own answer." : "Reply with your answer.";
  const text = [`Question from ${entry.sessionTitle ?? "the session"}: ${entry.text}`, ...options, how].join("\n");
  return text.length <= MAX_ROOM_TEXT ? text : `${text.slice(0, MAX_ROOM_TEXT - 1)}…`;
}

/** A reply as an answer: a number or an option's title picks that option, anything else is the answer's text. */
export function parseAnswer(entry: DecisionEntry, reply: string): { choice?: number; text?: string } {
  const text = reply.trim();
  const options = entry.options ?? [];
  const number = /^(\d{1,2})[.)]?$/.exec(text);
  if (number) {
    const index = Number(number[1]) - 1;
    if (index >= 0 && index < options.length) return { choice: index };
  }
  const titled = options.findIndex((option) => option.title.trim().toLowerCase() === text.toLowerCase());
  return titled >= 0 ? { choice: titled } : { text };
}

export class ConversationRoomRoute implements PersonRoute {
  readonly id: string;
  private sink?: (answer: InboundAnswer) => Promise<AnswerResult>;
  private readonly asked = new Map<string, Asked>();
  private readonly rooms = new Map<string, { room: ConversationRoomLike; unsubscribe: () => void }>();
  private readonly seen = new Set<string>();

  constructor(private readonly options: ConversationRoomRouteOptions) {
    this.id = options.id ?? "room";
  }

  async deliver(entry: DecisionEntry): Promise<{ delivered: boolean; ref?: string; error?: string }> {
    if (entry.kind !== "question") return { delivered: false, error: "The room carries questions only." };
    if (!entry.sessionId) return { delivered: false, error: "The question has no session, so it has no room." };
    const roomId = conversationRoomId((this.options.orgSessionIdOf ?? orgSessionIdOf)(entry.sessionId));
    const room = await this.room(roomId);
    if (!room) return { delivered: false, error: `The session is not shared in the organization (no room ${roomId}).` };
    const recordId = `ask.${entry.id}`;
    if (!MESSAGE_ID.test(recordId)) return { delivered: false, error: "The question id cannot name a room record." };
    const key = `message:${recordId}`;
    await room.set(key, {
      role: "assistant",
      author: this.options.owner,
      text: questionText(entry),
      state: "final",
      turn: recordId,
      at: entry.createdAt,
    });
    this.asked.set(entry.id, { entry, room, key });
    return { delivered: true, ref: `${room.id}/${key}` };
  }

  start(sink: (answer: InboundAnswer) => Promise<AnswerResult>): void {
    this.sink = sink;
    for (const { room } of this.rooms.values()) void this.scan(room);
  }

  stop(): void {
    this.sink = undefined;
    for (const { unsubscribe } of this.rooms.values()) unsubscribe();
    this.rooms.clear();
  }

  /** Questions asked here that nobody answered yet, oldest first. */
  open(sessionId?: string): DecisionEntry[] {
    return [...this.asked.values()]
      .map((asked) => asked.entry)
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * An instruction someone posted to the session through the org: the answer to the oldest open question this route
   * asked in that session, or undefined (run it as an ordinary message) when there is none.
   */
  async takeInboxAnswer(sessionId: string, message: { author: string; text: string }): Promise<AnswerResult | undefined> {
    if (!this.sink) return undefined;
    for (const entry of this.open(sessionId)) {
      const result = await this.answer(entry, message.text, message.author);
      // One already answered on another route is skipped; the message may answer the next one.
      if (result.accepted || !/already answered|No question/.test(result.error ?? "")) return result;
    }
    return undefined;
  }

  private async room(roomId: string): Promise<ConversationRoomLike | undefined> {
    const known = this.rooms.get(roomId);
    if (known) return known.room;
    const room = await this.options.openRoom(roomId);
    if (!room) return undefined;
    const unsubscribe = room.subscribe((event) => {
      if (event.kind === "records") void this.scan(room);
    });
    this.rooms.set(roomId, { room, unsubscribe });
    return room;
  }

  /** Finds final replies to this route's questions in a room and hands the first of each to the desk. */
  private async scan(room: ConversationRoomLike): Promise<void> {
    if (!this.sink) return;
    for (const record of room.query({ type: "message" })) {
      const fields = record.fields;
      if (record.pending || this.seen.has(record.key) || fields.role !== "user" || fields.state !== "final") continue;
      const asked = [...this.asked.values()].find((candidate) => candidate.room === room && candidate.key === fields.replyTo);
      if (!asked || typeof fields.text !== "string" || !fields.text.trim()) continue;
      this.seen.add(record.key);
      await this.answer(asked.entry, fields.text, record.updatedBy ?? String(fields.author ?? ""));
    }
  }

  private async answer(entry: DecisionEntry, reply: string, author: string): Promise<AnswerResult> {
    const sink = this.sink;
    if (!sink) return { accepted: false, error: "The route is stopped." };
    const name = this.options.nameOf?.(author) ?? (author.replace(/^user:/, "") || undefined);
    const result = await sink({
      questionId: entry.id,
      ...parseAnswer(entry, reply),
      by: { ...(author ? { personId: author } : {}), ...(name ? { name } : {}) },
      route: this.id,
    });
    // Answered, here or on another route: either way this route stops waiting for it.
    if (result.accepted || /already answered|No question/.test(result.error ?? "")) this.asked.delete(entry.id);
    return result;
  }
}
