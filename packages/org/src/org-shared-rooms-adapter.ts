import type { RoomStatus } from "@marshal/agent-runtime-org";

import type { ConversationRooms } from "./org-shared-rooms";
import type { ConversationRoom } from "./rooms/rooms-conversation";

/** The desktop rooms service as the shared sessions use it: a session's conversation room, or undefined while rooms are off. */
export interface ConversationSource {
  conversation(orgSessionId: string): ConversationRoom | undefined;
}

const MESSAGE_PREFIX = "message:";

function messageIdOf(key: string): string {
  if (!key.startsWith(MESSAGE_PREFIX)) throw new Error("not-a-message-key");
  return key.slice(MESSAGE_PREFIX.length);
}

const adapters = new WeakMap<object, ConversationRooms>();

/**
 * The conversation rooms of the desktop rooms service, or undefined while rooms are off (no running
 * manager). One adapter per running manager, so a restarted manager reads as a new rooms layer and the
 * bridge reopens its rooms.
 */
export function conversationRoomsOf(
  source: ConversationSource,
  manager: object | undefined,
): ConversationRooms | undefined {
  if (!manager) return undefined;
  const existing = adapters.get(manager);
  if (existing) return existing;
  const adapter = adapt(source);
  adapters.set(manager, adapter);
  return adapter;
}

function adapt(source: ConversationSource): ConversationRooms {
  // Rooms this desktop opened, by room id; the bridge addresses every later call by that id.
  const opened = new Map<string, ConversationRoom>();
  const roomOf = (roomId: string): ConversationRoom => {
    const room = opened.get(roomId);
    if (!room) throw new Error("room-not-open");
    return room;
  };
  return {
    open: async ({ orgSessionId, workspaceId, title }) => {
      const room = source.conversation(orgSessionId);
      if (!room) throw new Error("rooms-off");
      await room.open({ workspaceId, title });
      opened.set(room.id, room);
      return { roomId: room.id };
    },
    status: (roomId): RoomStatus | undefined => opened.get(roomId)?.status()?.status,
    get: (roomId, key) => opened.get(roomId)?.message(messageIdOf(key)),
    messages: (roomId) => opened.get(roomId)?.messages() ?? [],
    write: (roomId, key, fields, writer) =>
      fields
        ? roomOf(roomId).writeMessage(writer, messageIdOf(key), fields)
        : roomOf(roomId).deleteMessage(writer, messageIdOf(key)),
    appendText: (roomId, key, more, writer) =>
      roomOf(roomId).appendText(writer, messageIdOf(key), more),
    setPresence: (roomId, state, writer) => roomOf(roomId).setPresence(writer, state),
    presence: (roomId) => opened.get(roomId)?.presence() ?? [],
    subscribe: (roomId, listener) => roomOf(roomId).subscribe(listener),
  };
}
