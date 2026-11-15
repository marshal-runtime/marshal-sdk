import { RoomWriteError } from "@marshal/agent-runtime-org";
import { z } from "zod";

import { wrapUntrusted } from "../../host-deps";
import type { OrgRoomsManager } from "./rooms-manager";

const MAX_RECORDS = 200;
const MAX_HISTORY = 200;
const JOIN_WAIT_MS = 3000;

export const listRoomsInput = z
  .object({
    kind: z.string().max(200).optional(),
    workspaceId: z.string().max(200).optional(),
  })
  .strict();

export const readRoomInput = z
  .object({
    roomId: z.string().min(1).max(128),
    type: z.string().max(64).optional(),
    key: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(MAX_RECORDS).optional(),
  })
  .strict();

export const roomHistoryInput = z
  .object({
    roomId: z.string().min(1).max(128),
    key: z.string().max(200).optional(),
    afterSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_HISTORY).optional(),
  })
  .strict();

export type RoomsAgentResult =
  | { success: true; [key: string]: unknown }
  | { success: false; error: string };

/**
 * What the agent tools read. Room titles, fields and change sets are written by other members of
 * the organization, so they reach the model only inside an `org_room` external-content envelope;
 * ids, counts and positions stay outside it.
 */
export class RoomsAgentTools {
  constructor(private readonly manager: () => OrgRoomsManager | undefined) {}

  private running(): OrgRoomsManager | { success: false; error: string } {
    return this.manager() ?? { success: false, error: "rooms-unavailable" };
  }

  async listRooms(value: unknown): Promise<RoomsAgentResult> {
    const input = listRoomsInput.safeParse(value ?? {});
    if (!input.success) return { success: false, error: "invalid-input" };
    const manager = this.running();
    if (!("replica" in manager)) return manager;
    const rooms = await manager.list({
      ...(input.data.kind ? { kind: input.data.kind } : {}),
      ...(input.data.workspaceId ? { workspaceId: input.data.workspaceId } : {}),
    });
    return {
      success: true,
      count: rooms.length,
      rooms: wrapUntrusted(
        "org_room",
        JSON.stringify(
          rooms.map((room) => ({
            id: room.id,
            kind: room.kind,
            workspaceId: room.workspaceId,
            title: room.title,
            owner: room.owner,
            role: room.role,
            status: room.status,
            updatedAt: room.updatedAt,
          })),
        ),
      ),
    };
  }

  async readRoom(value: unknown): Promise<RoomsAgentResult> {
    const input = readRoomInput.safeParse(value);
    if (!input.success) return { success: false, error: "invalid-input" };
    const manager = this.running();
    if (!("replica" in manager)) return manager;
    const opened = await this.ensureOpen(manager, input.data.roomId);
    if (opened) return opened;
    const summary = manager.roomSummary(input.data.roomId);
    const all = input.data.key
      ? [manager.get(input.data.roomId, input.data.key)].filter((record) => record !== undefined)
      : manager.query(input.data.roomId, input.data.type ? { type: input.data.type } : {});
    const limit = input.data.limit ?? MAX_RECORDS;
    const records = all.slice(0, limit);
    return {
      success: true,
      roomId: input.data.roomId,
      kind: summary?.kind,
      role: summary?.role,
      status: summary?.status,
      count: all.length,
      truncated: all.length > records.length,
      room: wrapUntrusted(
        "org_room",
        JSON.stringify({
          title: summary?.title,
          records,
          presence: manager.presenceOf(input.data.roomId),
        }),
      ),
    };
  }

  async roomHistory(value: unknown): Promise<RoomsAgentResult> {
    const input = roomHistoryInput.safeParse(value);
    if (!input.success) return { success: false, error: "invalid-input" };
    const manager = this.running();
    if (!("replica" in manager)) return manager;
    const opened = await this.ensureOpen(manager, input.data.roomId);
    if (opened) return opened;
    const limit = input.data.limit ?? 50;
    const changes = manager.history(input.data.roomId, {
      ...(input.data.key ? { key: input.data.key } : {}),
      ...(input.data.afterSeq !== undefined ? { afterSeq: input.data.afterSeq } : {}),
      limit,
    });
    const lastSeq = changes.reduce(
      (max, change) => (change.seq !== null && change.seq > max ? change.seq : max),
      0,
    );
    return {
      success: true,
      roomId: input.data.roomId,
      count: changes.length,
      nextAfterSeq: lastSeq,
      changes: wrapUntrusted("org_room", JSON.stringify(changes)),
    };
  }

  private async ensureOpen(
    manager: OrgRoomsManager,
    roomId: string,
  ): Promise<{ success: false; error: string } | undefined> {
    if (manager.roomSummary(roomId)) return undefined;
    try {
      await manager.open(roomId);
    } catch (error) {
      return {
        success: false,
        error: error instanceof RoomWriteError ? error.code : "room-unavailable",
      };
    }
    // A first read waits briefly for the catch-up so it does not answer from an empty replica.
    const deadline = Date.now() + JOIN_WAIT_MS;
    while (!manager.socket.isJoined(roomId) && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- polls the join state for at most JOIN_WAIT_MS
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  }
}
