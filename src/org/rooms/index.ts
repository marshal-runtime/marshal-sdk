/**
 * The rooms client of an SDK host: the socket, the replica and the HTTP routes of the organization's rooms service,
 * lifted from the desktop (electron/org/rooms at c75500b1b, files beside this one) and behind the runtime pack's
 * `RoomsApi` / `Room` interfaces (@marshal/agent-runtime-org rooms/api.d.ts).
 *
 * Where the address and token come from, as the desktop does it (electron/main.ts `OrgRoomsService`, org-service
 * `getRoomsEndpoint`): the organization's discovery document carries `rooms: {apiBase, socketUrl}` when it lists the
 * `rooms` feature (`OrgClient.discovery.rooms`, `client.supports("rooms")`). The bearer token is the signed-in person's
 * own org access token, the same one the OrgClient uses (R18: the run acts as the person who started it): the HTTP routes
 * take it as `Authorization: Bearer`, and the socket sends it in its `hello` frame, fresh for every connection.
 * There is no separate rooms token exchange. A host passes both in (`endpoints`, `accessToken`); `roomsEndpoints()`
 * reads them from a discovery document.
 *
 * Who writes: the host names the person (`principal`, `user:<email>`) and the `actor` (default: an agent of this
 * host); an extension never chooses either. A room of a declared extension kind is written under that extension's
 * declaration (`kinds`, from `contributes.rooms`); the built-in conversation kind (`marshal/conversation`) is the host's.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import {
  RoomWriteError,
  type OrgDiscoveryDocument,
  type Room,
  type RoomActor,
  type RoomApiChange,
  type RoomEvent,
  type RoomFileRef,
  type RoomKindSchema,
  type RoomMember,
  type RoomPresence,
  type RoomRecord,
  type RoomRole,
  type RoomsApi,
  type RoomStatus,
  type RoomSummary,
  type RoomTextHandle,
  type RoomTextRun,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";

import { setRoomsLog, type RoomsLogSink } from "./log.js";
import { CONVERSATION_SCHEMA, isBuiltinRoomKind } from "./rooms-conversation.js";
import { OrgRoomsManager, type FetchLike, type RoomsCaller, type RoomsEndpoint } from "./rooms-manager.js";
import { fullRoomKind } from "./rooms-schema.js";
import type { RoomsSocketFactory } from "./rooms-socket.js";
import { createNodeRoomsSocket } from "./rooms-ws.js";

export { CONVERSATION_SCHEMA, ConversationRoom, isBuiltinRoomKind } from "./rooms-conversation.js";
export { OrgRoomsManager, type RoomsCaller, type RoomsEndpoint } from "./rooms-manager.js";
export { createNodeRoomsSocket } from "./rooms-ws.js";
export type { RoomsLogSink } from "./log.js";

export interface OrgRoomsOptions {
  endpoints: { apiBase: string; socketUrl: string };
  /** The organization's id (discovery `orgId`); names this connection's replica folder. */
  orgId?: string;
  /** The signed-in person's org access token (a fresh one per call). */
  accessToken: () => Promise<string>;
  /** The person every change is authored as. */
  principal: UserPrincipal;
  name?: string;
  /** Who actually acts. Default: an agent of this host (`{kind: "agent", host: "desktop", session: "sdk", runtime: "claude"}`). */
  actor?: RoomActor;
  /** Identifies this host among the person's clients (presence). */
  clientId?: string;
  /** Where the replica and the file cache live. */
  dir: string;
  /** Room kinds this host's extensions declare (`contributes.rooms`), with their extension identity. */
  kinds?: (RoomKindSchema & { identity: string })[];
  log?: RoomsLogSink;
  /** Tests: a socket factory, fetch, and socket tuning. */
  createSocket?: RoomsSocketFactory;
  fetch?: FetchLike;
  socket?: { baseBackoffMs?: number; maxBackoffMs?: number; random?: () => number; retryMs?: number };
}

/** The `rooms` addresses of a discovery document, when the organization serves rooms. */
export function roomsEndpoints(discovery: OrgDiscoveryDocument): { apiBase: string; socketUrl: string } | undefined {
  return discovery.features.includes("rooms") ? discovery.rooms : undefined;
}

export interface OrgRoomsConnection extends RoomsApi {
  readonly manager: OrgRoomsManager;
  /** Creates (or, on a retry, returns) the room with this id; `kind` is the full kind (`<identity>/<short>` or a built-in). */
  createRoom(input: { id: string; kind: string; schemaVersion: number; workspaceId: string; title: string }): Promise<Room>;
  /** Owner only. */
  grant(roomId: string, principal: UserPrincipal, role: Exclude<RoomRole, "owner">): Promise<void>;
  close(): void;
}

export function connectOrgRooms(options: OrgRoomsOptions): OrgRoomsConnection {
  if (options.log) setRoomsLog(options.log);
  const root = path.resolve(options.dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const endpoint: RoomsEndpoint = { orgId: options.orgId ?? "org", ...options.endpoints };
  const manager = new OrgRoomsManager({
    endpoint,
    token: options.accessToken,
    person: async () => options.principal,
    root,
    createSocket: options.createSocket ?? createNodeRoomsSocket,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.socket ? { socket: options.socket } : {}),
    ...(options.clientId ? { clientId: options.clientId } : {}),
  });
  const actor: RoomActor = options.actor ?? { kind: "agent", host: "desktop", session: "sdk", runtime: "claude" };
  manager.start();

  /** The caller for a room: the declaring extension's, or the host's own for a built-in kind. */
  const callerFor = (roomId: string): RoomsCaller => {
    const kind = manager.roomSummary(roomId)?.kind;
    if (kind === undefined) throw new RoomWriteError("gone", { message: "open the room first" });
    if (isBuiltinRoomKind(kind)) return { actor, declarations: [], builtin: CONVERSATION_SCHEMA };
    const owner = (options.kinds ?? []).find((declared) => fullRoomKind(declared.identity, declared.kind) === kind);
    if (!owner) return { actor, declarations: [] };
    return { extension: owner.identity, actor, declarations: (options.kinds ?? []).filter((declared) => declared.identity === owner.identity) };
  };

  const roomOf = (roomId: string): Room => ({
    id: roomId,
    get role(): RoomRole {
      return manager.roomSummary(roomId)?.role ?? "viewer";
    },
    get status(): RoomStatus {
      return manager.roomSummary(roomId)?.status ?? "gone";
    },
    members: (): Promise<RoomMember[]> => manager.members(roomId),
    get: (key: string): RoomRecord | undefined => manager.get(roomId, key),
    query: (filter: { type: string }): RoomRecord[] => manager.query(roomId, filter),
    set: (key: string, fields: Record<string, unknown>, setOptions?: { ifSeq?: number }) =>
      manager.write(callerFor(roomId), roomId, key, "set", fields, setOptions?.ifSeq !== undefined ? { ifSeq: setOptions.ifSeq } : {}),
    delete: (key: string) => manager.write(callerFor(roomId), roomId, key, "delete", undefined),
    between: (before?: string, after?: string) => manager.between(before, after),
    history: async (key?: string): Promise<RoomApiChange[]> => manager.history(roomId, key ? { key } : {}),
    textHistory: async (key: string, field?: string): Promise<RoomTextRun[]> => manager.textHistory(roomId, key, field),
    text: (key: string, field: string): RoomTextHandle => ({
      record: key,
      field,
      value: () => manager.textValue(roomId, key, field),
      splice: async (index, deleteCount, insert) => {
        await manager.textSplice(callerFor(roomId), roomId, key, field, { index, deleteCount, insert });
      },
      setValue: async (next) => {
        await manager.textSplice(callerFor(roomId), roomId, key, field, { value: next });
      },
      subscribe: (listener) => manager.subscribeText(roomId, key, field, listener),
      cursor: (index) => manager.textCursor(roomId, key, field, index),
      resolve: (cursor) => manager.textResolve(roomId, key, field, cursor),
    }),
    files: {
      put: (file: string, contentType: string): Promise<RoomFileRef> => manager.putFile(roomId, file, contentType),
      path: (ref: RoomFileRef): Promise<string> => manager.filePath(roomId, ref),
    },
    presence: {
      set: (state: unknown) => manager.setPresence(roomId, state, actor),
      all: (): RoomPresence[] => manager.presenceOf(roomId),
    },
    subscribe: (listener: (event: RoomEvent) => void) => manager.subscribe(roomId, listener),
  });

  return {
    manager,
    async create(input) {
      const declared = (options.kinds ?? []).find((candidate) => candidate.kind === input.kind);
      if (!declared) throw new RoomWriteError("unknown-type", { message: `room kind ${input.kind} is not declared` });
      const summary = await manager.create(
        { extension: declared.identity, actor, declarations: (options.kinds ?? []).filter((item) => item.identity === declared.identity) },
        input,
      );
      return roomOf(summary.id);
    },
    async createRoom(input) {
      const summary = await manager.openOrCreateBuiltin(input);
      return roomOf(summary.id);
    },
    async open(roomId) {
      await manager.open(roomId);
      return roomOf(roomId);
    },
    list: (filter): Promise<RoomSummary[]> => manager.list(filter),
    grant: (roomId, principal, role) => manager.grant(roomId, principal, role),
    close: () => manager.stop(),
  };
}
