import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { MAX_ROOM_TEXT_BYTES, RoomWriteError } from "@marshal/agent-runtime-org";
import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";
import { z } from "zod";

import type { OrgRoomsService } from "../org/rooms/org-rooms-service";
import { isBuiltinRoomKind } from "../org/rooms/rooms-conversation";
import { RoomFileError } from "../org/rooms/rooms-file-cache";
import type { OrgRoomsManager, RoomsCaller } from "../org/rooms/rooms-manager";
/** Base64 puts sit in memory three times over (string, bytes, temp file); larger files go by `path`. */
const MAX_INLINE_FILE_BYTES = 32 * 1024 * 1024;

export const ORG_ROOMS_CAPABILITY_PREFIX = "marshal.org.rooms.";
export const ORG_ROOMS_PERMISSION = Object.freeze({
  read: "marshal.org.rooms.read",
  write: "marshal.org.rooms.write",
});

const MAX_ID = 128;
const MAX_KEY = 200;
const roomId = z.string().min(1).max(MAX_ID);
const recordKey = z.string().min(3).max(MAX_KEY);
const fields = z.record(z.string().max(64), z.unknown());
const field = z.string().min(1).max(64);
const textIndex = z.number().int().min(0).max(MAX_ROOM_TEXT_BYTES);
const textValue = z.string().max(MAX_ROOM_TEXT_BYTES);
const textCursor = z.string().min(1).max(1024);
const textVersion = z.string().min(1).max(64);

const inputs = {
  identity: z.object({}).strict(),
  create: z
    .object({
      kind: z.string().min(1).max(64),
      workspaceId: z.string().min(1).max(MAX_ID),
      title: z.string().max(200),
    })
    .strict(),
  open: z.object({ roomId }).strict(),
  list: z
    .object({
      kind: z.string().max(200).optional(),
      workspaceId: z.string().max(MAX_ID).optional(),
    })
    .strict(),
  get: z.object({ roomId, key: recordKey }).strict(),
  query: z.object({ roomId, type: z.string().max(64).optional() }).strict(),
  set: z
    .object({
      roomId,
      key: recordKey,
      fields,
      ifSeq: z.number().int().min(0).optional(),
      textBase: z.record(field, textVersion).optional(),
    })
    .strict(),
  delete: z.object({ roomId, key: recordKey, ifSeq: z.number().int().min(0).optional() }).strict(),
  history: z
    .object({
      roomId,
      key: recordKey.optional(),
      afterSeq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  members: z.object({ roomId }).strict(),
  presence: z.object({ roomId, state: z.unknown().optional() }).strict(),
  wait: z
    .object({
      roomId,
      after: z.number().int().min(0),
      timeoutMs: z.number().int().min(0).max(25_000).optional(),
    })
    .strict(),
  between: z
    .object({ before: z.string().max(200).optional(), after: z.string().max(200).optional() })
    .strict(),
  "files.put": z.union([
    // Large files: a local path the host streams from disk (extensions only; they can read the disk anyway).
    z
      .object({
        roomId,
        path: z.string().min(1).max(4096),
        contentType: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        roomId,
        dataBase64: z.string().max(Math.ceil((MAX_INLINE_FILE_BYTES * 4) / 3) + 4),
        contentType: z.string().min(1).max(200),
      })
      .strict(),
  ]),
  "files.path": z.object({ roomId, ref: z.unknown() }).strict(),
  "text.read": z.object({ roomId, key: recordKey, field }).strict(),
  "text.splice": z
    .object({
      roomId,
      key: recordKey,
      field,
      index: textIndex,
      deleteCount: textIndex,
      insert: textValue,
      base: textVersion.optional(),
    })
    .strict(),
  "text.set": z
    .object({ roomId, key: recordKey, field, value: textValue, base: textVersion.optional() })
    .strict(),
  "text.cursor": z.object({ roomId, key: recordKey, field, index: textIndex }).strict(),
  "text.resolve": z.object({ roomId, key: recordKey, field, cursor: textCursor }).strict(),
  "text.history": z.object({ roomId, key: recordKey, field: field.optional() }).strict(),
} as const;

type Operation = keyof typeof inputs;

// The runtime kernel refuses to start the host when a listed capability lacks a strict top-level output schema.
const output = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    field: z.string().optional(),
    identity: z.looseObject({ orgId: z.string() }).optional(),
    room: z.looseObject({ id: z.string() }).optional(),
    rooms: z.array(z.looseObject({ id: z.string() })).optional(),
    record: z.looseObject({ key: z.string() }).nullable().optional(),
    records: z.array(z.looseObject({ key: z.string() })).optional(),
    changes: z.array(z.looseObject({ id: z.string() })).optional(),
    members: z.array(z.looseObject({ principal: z.string() })).optional(),
    presence: z.array(z.looseObject({ principal: z.string() })).optional(),
    events: z.array(z.looseObject({ n: z.number() })).optional(),
    cursor: z.number().optional(),
    missed: z.boolean().optional(),
    position: z.string().optional(),
    ref: z.looseObject({ sha256: z.string() }).optional(),
    path: z.string().optional(),
    text: z
      .looseObject({
        value: z.string(),
        version: z.string(),
        order: z.number(),
        index: z.number().optional(),
      })
      .optional(),
    textCursor: z.string().optional(),
    index: z.number().nullable().optional(),
    runs: z.array(z.looseObject({ record: z.string() })).optional(),
  })
  .strict();

const DESCRIPTIONS: Record<Operation, [title: string, description: string, write: boolean]> = {
  identity: [
    "Who the call acts as in rooms",
    "The organization, the signed-in person, the actor the host stamps on this call's changes, and serverOffsetMs (server clock minus this desktop's, from ping/pong) for measuring how long others' changes took to arrive: local receive time + offset - change.at.",
    false,
  ],
  create: [
    "Create a room",
    "Create a room of a kind the calling extension declares in contributes.rooms (`kind` is the short name). The caller becomes its owner.",
    true,
  ],
  open: [
    "Open a room",
    "Join a room live (and keep it in the local replica) and return its summary.",
    false,
  ],
  list: [
    "List rooms",
    "Rooms the person can read, from the organization and the local replica.",
    false,
  ],
  get: [
    "Read a record",
    "One record of an open room (`record: null` when it does not exist).",
    false,
  ],
  query: ["Read records", "Every record of an open room, or of one record type.", false],
  set: [
    "Set record fields",
    "Set fields of a record (`<type>:<id>`). Shown at once from the local replica, then ordered by the organization. With ifSeq the call waits and fails with `conflict` when the record moved past it. A string for a text field is a whole-value write like text.set; pass textBase[field] (the version you started from) to keep others' typing exactly.",
    true,
  ],
  delete: ["Delete a record", "Delete a record of an open room.", true],
  history: [
    "Room history",
    "Ordered changes of a room, oldest first, with author and actor; this desktop's unordered changes last.",
    false,
  ],
  members: ["Room members", "The people who can read the room and their roles.", false],
  presence: [
    "Room presence",
    "Who is in the room now; with `state`, also sets this desktop's presence state (at most 30 updates a second are sent).",
    false,
  ],
  wait: [
    "Wait for room events",
    "Room events after `after` (an event number from a previous call; 0 for the start), waiting up to timeoutMs (at most 25 s) for the first. `missed: true` means older events were dropped: read the room again. A change to a text field this desktop has open carries `values: {field: {value, version, order}}`: the value right after that change. Ignore one whose `order` is not above the last text answer or value you applied (answers and events can arrive in either order).",
    false,
  ],
  between: [
    "Order position",
    "A position string that sorts between `before` and `after`, for ordered lists in fields of type position.",
    false,
  ],
  "files.put": [
    "Add a room file",
    "Store a room file and return the reference to put in a field of type file. Pass `path` (an absolute local file, streamed, up to 5 GB) or `dataBase64` (up to 32 MB).",
    true,
  ],
  "files.path": [
    "Room file path",
    "A local path of a room file (downloaded once, then cached).",
    false,
  ],
  "text.read": [
    "Read a text field",
    "The current value of a record's text field (mergeable text): ordered text with this desktop's own unsent edits on top, and its `version` (pass it as `base` to text.set).",
    false,
  ],
  "text.splice": [
    "Edit a text field",
    "A local edit of a text field at `index` (UTF-16 code units): remove `deleteCount`, insert `insert`. Pass `base`, the `version` of the value the index refers to (what your screen showed, from text.read or the last text answer): the host moves index and deleteCount onto the current text, past others' typing your screen had not shown yet (anchored to the character on the left, so two people typing at one spot keep their runs together). Without base the index is taken against the current text, so unseen typing by others shifts it (letters can land out of order). Merges with everyone else's typing; never overwrites. Returns the new value, version and `order` (see wait), and `index`: where in that value the edit was applied (moved from yours when others typed before it). Answers as soon as the edit is applied locally; the keystroke is sent at once after a quiet spell, else with its 16 ms batch.",
    true,
  ],
  "text.set": [
    "Set a text field's value",
    "For a plain textarea: the field's new full value. Pass `base`, the `version` of the value you edited (from text.read or the last text answer): only your edit, base to value, is applied onto the current text, so others' typing since is kept. Without base the host uses the recent value yours is the smallest edit from (a remote insertion your screen had not painted yet is kept); with a base too old to remember and no recent match, it is the smallest edit from the current value, which can overwrite others' unseen typing. Returns the new value and version.",
    true,
  ],
  "text.cursor": [
    "Text cursor",
    "A cursor for `index` that stays attached to the same character while others edit (for carets and selections in presence).",
    false,
  ],
  "text.resolve": [
    "Resolve a text cursor",
    "The current index of a cursor from text.cursor (`index: null` when it no longer resolves, after a compaction).",
    false,
  ],
  "text.history": [
    "Text history",
    "Who typed what in a record's text fields: one person's consecutive changes to one field grouped into runs.",
    false,
  ],
};

function descriptor(operation: Operation): CapabilityDescriptor {
  const [title, description, write] = DESCRIPTIONS[operation];
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: `${ORG_ROOMS_CAPABILITY_PREFIX}${operation}`,
    version: "1.0.0",
    title,
    description,
    tags: ["org", "rooms"],
    inputSchema: z.toJSONSchema(inputs[operation]),
    outputSchema: z.toJSONSchema(output),
    permissions: [
      {
        permission: write ? ORG_ROOMS_PERMISSION.write : ORG_ROOMS_PERMISSION.read,
        risk: write ? "medium" : "low",
      },
    ],
  };
}

const OPERATIONS = Object.keys(inputs).filter((key): key is Operation => key in inputs);
const DESCRIPTORS: readonly CapabilityDescriptor[] = OPERATIONS.map(descriptor);

function operationOf(name: string): Operation | undefined {
  if (!name.startsWith(ORG_ROOMS_CAPABILITY_PREFIX)) return undefined;
  const operation = name.slice(ORG_ROOMS_CAPABILITY_PREFIX.length);
  return OPERATIONS.find((candidate) => candidate === operation);
}

type Result = z.infer<typeof output>;

/** An extension reads only rooms of kinds it declares; host callers (agent tools) read any room the person can. */
function readable(caller: RoomsCaller, kind: string | undefined): boolean {
  if (!caller.extension) return true;
  // Built-in kinds (conversation rooms) are the host's: no extension reads them.
  if (kind !== undefined && isBuiltinRoomKind(kind)) return false;
  return (
    kind !== undefined &&
    caller.declarations.some((declaration) => `${caller.extension}/${declaration.kind}` === kind)
  );
}

async function run(
  service: OrgRoomsService,
  manager: OrgRoomsManager,
  operation: Operation,
  value: unknown,
  context: InvocationContext,
): Promise<Result> {
  const who = await service.callerFor(context);
  if (!who.ok) return { ok: false, error: who.code };
  const caller = who.caller;
  const roomKind = (id: string) => manager.roomSummary(id)?.kind;
  const guardRead = (id: string): Result | undefined =>
    readable(caller, roomKind(id))
      ? undefined
      : { ok: false, error: roomKind(id) ? "unknown-type" : "not-open" };

  switch (operation) {
    case "identity": {
      inputs.identity.parse(value);
      const identity = await service.identity();
      if (!identity) return { ok: false, error: "rooms-unavailable" };
      const serverOffsetMs = manager.socket.serverOffsetMs;
      return {
        ok: true,
        identity: {
          ...identity,
          actor: caller.actor,
          ...(serverOffsetMs !== undefined ? { serverOffsetMs } : {}),
        },
      };
    }
    case "create": {
      const input = inputs.create.parse(value);
      return { ok: true, room: await manager.create(caller, input) };
    }
    case "open": {
      const input = inputs.open.parse(value);
      const room = await manager.open(input.roomId);
      if (!readable(caller, room.kind)) return { ok: false, error: "unknown-type" };
      return { ok: true, room };
    }
    case "list": {
      const input = inputs.list.parse(value);
      const rooms = await manager.list({
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      });
      return { ok: true, rooms: rooms.filter((room) => readable(caller, room.kind)) };
    }
    case "get": {
      const input = inputs.get.parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          record: manager.get(input.roomId, input.key) ?? null,
        }
      );
    }
    case "query": {
      const input = inputs.query.parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          records: manager.query(input.roomId, input.type ? { type: input.type } : {}),
        }
      );
    }
    case "set": {
      const input = inputs.set.parse(value);
      await manager.write(caller, input.roomId, input.key, "set", input.fields, {
        ...(input.ifSeq !== undefined ? { ifSeq: input.ifSeq } : {}),
        ...(input.textBase ? { textBase: input.textBase } : {}),
      });
      return { ok: true, record: manager.get(input.roomId, input.key) ?? null };
    }
    case "delete": {
      const input = inputs.delete.parse(value);
      await manager.write(
        caller,
        input.roomId,
        input.key,
        "delete",
        undefined,
        input.ifSeq !== undefined ? { ifSeq: input.ifSeq } : {},
      );
      return { ok: true };
    }
    case "history": {
      const input = inputs.history.parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          changes: manager.history(input.roomId, {
            ...(input.key ? { key: input.key } : {}),
            ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
            ...(input.limit ? { limit: input.limit } : {}),
          }),
        }
      );
    }
    case "members": {
      const input = inputs.members.parse(value);
      return guardRead(input.roomId) ?? { ok: true, members: await manager.members(input.roomId) };
    }
    case "presence": {
      const input = inputs.presence.parse(value);
      const refused = guardRead(input.roomId);
      if (refused) return refused;
      if ("state" in input) manager.setPresence(input.roomId, input.state, caller.actor);
      return { ok: true, presence: manager.presenceOf(input.roomId) };
    }
    case "wait": {
      const input = inputs.wait.parse(value);
      const refused = guardRead(input.roomId);
      if (refused) return refused;
      const waited = await service.wait(
        input.roomId,
        input.after,
        input.timeoutMs ?? 20_000,
        context.signal instanceof AbortSignal ? context.signal : undefined,
      );
      return {
        ok: true,
        events: waited.events.map((entry) => ({ n: entry.n, ...entry.event })),
        cursor: waited.cursor,
        missed: waited.missed,
      };
    }
    case "between": {
      const input = inputs.between.parse(value);
      return { ok: true, position: manager.between(input.before, input.after) };
    }
    case "files.put": {
      const input = inputs["files.put"].parse(value);
      const refused = guardRead(input.roomId);
      if (refused) return refused;
      if ("path" in input) {
        if (!caller.extension) return { ok: false, error: "forbidden" };
        if (!path.isAbsolute(input.path)) return { ok: false, error: "invalid-input" };
        return {
          ok: true,
          ref: await manager.putFile(input.roomId, input.path, input.contentType),
        };
      }
      const bytes = Buffer.from(input.dataBase64, "base64");
      if (bytes.byteLength > MAX_INLINE_FILE_BYTES) return { ok: false, error: "too-large" };
      const directory = await mkdtemp(path.join(tmpdir(), "marshal-room-file-"));
      try {
        const file = path.join(directory, randomUUID());
        await writeFile(file, bytes);
        return { ok: true, ref: await manager.putFile(input.roomId, file, input.contentType) };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    case "files.path": {
      const input = inputs["files.path"].parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          path: await manager.filePath(input.roomId, input.ref),
        }
      );
    }
    case "text.read": {
      const input = inputs["text.read"].parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          text: manager.textRead(input.roomId, input.key, input.field),
        }
      );
    }
    case "text.splice": {
      const input = inputs["text.splice"].parse(value);
      const refused = guardRead(input.roomId);
      if (refused) return refused;
      return {
        ok: true,
        text: await manager.textSplice(caller, input.roomId, input.key, input.field, {
          index: input.index,
          deleteCount: input.deleteCount,
          insert: input.insert,
          ...(input.base ? { base: input.base } : {}),
        }),
      };
    }
    case "text.set": {
      const input = inputs["text.set"].parse(value);
      const refused = guardRead(input.roomId);
      if (refused) return refused;
      return {
        ok: true,
        text: await manager.textSplice(caller, input.roomId, input.key, input.field, {
          value: input.value,
          ...(input.base ? { base: input.base } : {}),
        }),
      };
    }
    case "text.cursor": {
      const input = inputs["text.cursor"].parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          textCursor: manager.textCursor(input.roomId, input.key, input.field, input.index),
        }
      );
    }
    case "text.resolve": {
      const input = inputs["text.resolve"].parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          index: manager.textResolve(input.roomId, input.key, input.field, input.cursor),
        }
      );
    }
    case "text.history": {
      const input = inputs["text.history"].parse(value);
      return (
        guardRead(input.roomId) ?? {
          ok: true,
          runs: manager.textHistory(input.roomId, input.key, input.field),
        }
      );
    }
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/**
 * Rooms for extensions (`marshal.org.rooms.*`): lists nothing unless `org.rooms` is on and the
 * organization announces rooms. The caller's extension identity and actor come from the host's own
 * invocation context (see OrgRoomsService.callerFor), never from input.
 */
export function createOrgRoomsProvider(service: OrgRoomsService): CapabilityProvider {
  return {
    id: "marshal.org-rooms-host",
    version: "1.0.0",
    list: () => (service.manager ? [...DESCRIPTORS] : []),
    get: (name) => (service.manager ? DESCRIPTORS.find((entry) => entry.name === name) : undefined),
    invoke: async (name, value, context) => {
      const operation = operationOf(name);
      if (!operation) throw new Error(`Unknown capability ${name}`);
      const manager = service.manager;
      if (!manager) return { output: { ok: false, error: "rooms-unavailable" } };
      try {
        return { output: await run(service, manager, operation, value, context) };
      } catch (error) {
        if (error instanceof RoomWriteError) {
          return {
            output: {
              ok: false,
              error: error.code,
              ...(error.field ? { field: error.field } : {}),
            },
          };
        }
        if (error instanceof RoomFileError) return { output: { ok: false, error: error.code } };
        if (error instanceof z.ZodError) return { output: { ok: false, error: "invalid-input" } };
        throw error;
      }
    },
  };
}
