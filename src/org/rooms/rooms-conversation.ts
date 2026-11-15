// Lifted from OmerMachluf/marshal electron/org/rooms/rooms-conversation.ts at c75500b1b (copied, not imported); adapted for the SDK (no Electron, local logger, node:fs).
import {
  CONVERSATION_ROOM_PREFIX,
  MAX_ROOM_TEXT_BYTES,
  ROOM_CONVERSATION_KIND,
  ROOM_CONVERSATION_SCHEMA_VERSION,
  RoomWriteError,
  checkConversationWrite,
  conversationRoomId,
  parseConversationPresenceState,
  type RoomActor,
  type RoomEvent,
  type RoomKindSchema,
  type RoomPresence,
  type RoomRecord,
  type RoomSummary,
  type ConversationPresenceState,
  type RoomTextEvent,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import type { OrgRoomsManager, RoomsCaller } from "./rooms-manager.js";

export {
  CONVERSATION_ROOM_PREFIX,
  ROOM_CONVERSATION_KIND,
  ROOM_CONVERSATION_SCHEMA_VERSION,
  conversationRoomId,
};

/** Built-in kinds belong to the host: no extension may read or write them, whatever it declares. */
export function isBuiltinRoomKind(kind: string): boolean {
  return kind === ROOM_CONVERSATION_KIND;
}

/**
 * The host's own declaration of the conversation kind. `message` is a contract built-in type (its fields are
 * checked against BUILT_IN_ROOM_SCHEMAS whatever this says); `text` is a mergeable text field.
 */
export const CONVERSATION_SCHEMA: RoomKindSchema = {
  kind: ROOM_CONVERSATION_KIND,
  schemaVersion: ROOM_CONVERSATION_SCHEMA_VERSION,
  records: {
    message: {
      fields: {
        role: "value",
        author: "value",
        text: "text",
        state: "value",
        turn: "value",
        replyTo: "value",
        at: "value",
        truncated: "value",
      },
    },
  },
};

/** `message:<org message id>` fields, checked before a write leaves the desktop. */
export const conversationMessageFields = z
  .object({
    role: z.enum(["user", "assistant"]),
    author: z.string().regex(/^user:.+$/),
    text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= MAX_ROOM_TEXT_BYTES),
    state: z.enum(["streaming", "final"]),
    turn: z.string().min(1).max(128),
    replyTo: z.string().min(1).max(200).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ConversationMessageFields = z.infer<typeof conversationMessageFields>;

/** Who writes: the signed-in person, or the agent of one of this desktop's sessions. */
export type ConversationWriter = { kind: "person" } | { kind: "agent"; sessionId: string };

export interface ConversationRoomDeps {
  manager: OrgRoomsManager;
  /** The full actor for a writer (runtime and model of the agent's session come from the host). */
  actorOf: (writer: ConversationWriter) => RoomActor;
}

const MESSAGE_ID = /^[A-Za-z0-9._:~-]{1,128}$/;

function messageKey(messageId: string): `message:${string}` {
  if (!MESSAGE_ID.test(messageId)) throw new RoomWriteError("invalid-key");
  const allowed = checkConversationWrite({ type: "message" });
  if (!allowed.ok) throw new RoomWriteError(allowed.code);
  return `message:${messageId}`;
}

const TEXT_FIELD = "text";

/**
 * A shared session's conversation room (`session:<org session id>`), for host code only. Membership is the
 * session's grants; this desktop writes messages with the actor the host derives, never one passed in.
 */
export class ConversationRoom {
  readonly id: string;

  constructor(
    private readonly deps: ConversationRoomDeps,
    readonly orgSessionId: string,
  ) {
    this.id = conversationRoomId(orgSessionId);
  }

  private caller(writer: ConversationWriter): RoomsCaller {
    return { actor: this.deps.actorOf(writer), declarations: [], builtin: CONVERSATION_SCHEMA };
  }

  /**
   * Opens the room, creating it when this person may (collaborator and up in the session); a viewer, or a
   * room that already exists, just joins. `workspaceId` and `title` are the org session's.
   */
  async open(input: { workspaceId: string; title: string }): Promise<RoomSummary> {
    return this.deps.manager.openOrCreateBuiltin({
      id: this.id,
      kind: ROOM_CONVERSATION_KIND,
      schemaVersion: ROOM_CONVERSATION_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      title: input.title,
    });
  }

  /** The room as this desktop knows it (role, status: active, offline, revoked, gone), or undefined before open. */
  status(): RoomSummary | undefined {
    return this.deps.manager.roomSummary(this.id);
  }

  messages(): RoomRecord[] {
    return this.deps.manager.query(this.id, { type: "message" });
  }

  message(messageId: string): RoomRecord | undefined {
    return this.deps.manager.get(this.id, messageKey(messageId));
  }

  /**
   * Writes a whole message record (create, or replace its fields). `text` is merged as the smallest edit from the
   * current text, so a concurrent edit by someone else is kept.
   */
  async writeMessage(
    writer: ConversationWriter,
    messageId: string,
    fields: ConversationMessageFields,
  ): Promise<void> {
    const checked = conversationMessageFields.safeParse(fields);
    if (!checked.success) {
      const field = checked.error.issues[0]?.path[0];
      throw new RoomWriteError("invalid-value", typeof field === "string" ? { field } : {});
    }
    await this.deps.manager.write(
      this.caller(writer),
      this.id,
      messageKey(messageId),
      "set",
      checked.data,
    );
  }

  /** Changes some fields of an existing message (for example `state: "final"`). */
  async updateMessage(
    writer: ConversationWriter,
    messageId: string,
    fields: Partial<ConversationMessageFields>,
  ): Promise<void> {
    const checked = conversationMessageFields.partial().safeParse(fields);
    if (!checked.success) {
      const field = checked.error.issues[0]?.path[0];
      throw new RoomWriteError("invalid-value", typeof field === "string" ? { field } : {});
    }
    await this.deps.manager.write(
      this.caller(writer),
      this.id,
      messageKey(messageId),
      "set",
      checked.data,
    );
  }

  /** Appends to a message's text (a streaming reply): one text edit at the end, a few bytes on the wire. */
  async appendText(writer: ConversationWriter, messageId: string, more: string): Promise<void> {
    const key = messageKey(messageId);
    if (!this.deps.manager.get(this.id, key))
      throw new RoomWriteError("gone", { message: "no such message" });
    if (!more) return;
    const end = this.deps.manager.textValue(this.id, key, TEXT_FIELD).length;
    await this.deps.manager.textSplice(this.caller(writer), this.id, key, TEXT_FIELD, {
      index: end,
      deleteCount: 0,
      insert: more,
    });
  }

  /** A message's text as splices: this desktop's edits at once, others' as they merge (keeps a reader's caret). */
  subscribeText(messageId: string, listener: (event: RoomTextEvent) => void): () => void {
    return this.deps.manager.subscribeText(this.id, messageKey(messageId), TEXT_FIELD, listener);
  }

  async deleteMessage(writer: ConversationWriter, messageId: string): Promise<void> {
    await this.deps.manager.write(
      this.caller(writer),
      this.id,
      messageKey(messageId),
      "delete",
      undefined,
    );
  }

  /**
   * This desktop's presence slot: `{v: 1, open?, composing?, agent?, selection?}`. Anything that does not parse as a
   * ConversationPresenceState is refused `invalid-value`; unknown keys are dropped.
   */
  setPresence(writer: ConversationWriter, state: ConversationPresenceState): void {
    const parsed = parseConversationPresenceState(state);
    if (!parsed)
      throw new RoomWriteError("invalid-value", { message: "not a conversation presence state" });
    this.deps.manager.setPresence(this.id, parsed, this.deps.actorOf(writer));
  }

  presence(): RoomPresence[] {
    return this.deps.manager.presenceOf(this.id);
  }

  /** Every room event: records (the changes themselves), presence, status, refused. */
  subscribe(listener: (event: RoomEvent) => void): () => void {
    return this.deps.manager.subscribe(this.id, listener);
  }
}
