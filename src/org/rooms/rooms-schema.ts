// Lifted from OmerMachluf/marshal electron/org/rooms/rooms-schema.ts at c75500b1b (copied, not imported); adapted for the SDK (no Electron, local logger, node:fs).
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  ROOM_FIELD_TYPES,
  type RoomFieldType,
  type RoomKindSchema,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import { isBuiltinRoomKind } from "./rooms-conversation.js";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const fieldType = z.custom<RoomFieldType>(
  (value) => typeof value === "string" && (ROOM_FIELD_TYPES as readonly string[]).includes(value),
);
const kindSchema = z.object({
  kind: z.string().regex(NAME),
  schemaVersion: z.number().int().min(1),
  records: z.record(
    z.string().regex(NAME),
    z.object({ fields: z.record(z.string().regex(NAME), fieldType) }),
  ),
});
const manifestSchema = z.object({
  contributes: z.object({ rooms: z.array(z.unknown()) }),
});

/**
 * `contributes.rooms` of an extension manifest. Each malformed entry is dropped, never trusted: an
 * extension with no valid declaration can read rooms but never write one.
 */
export function readRoomContributions(manifest: unknown): RoomKindSchema[] {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) return [];
  return parsed.data.contributes.rooms.flatMap((entry) => {
    const kind = kindSchema.safeParse(entry);
    return kind.success ? [kind.data] : [];
  });
}

/** The full kind of a room an extension declares: `<extension identity>/<short kind>`. */
export function fullRoomKind(extensionIdentity: string, shortKind: string): string {
  return `${extensionIdentity}/${shortKind}`;
}

/** The declaration of a room's full kind among an extension's declarations, if it is that extension's. */
export function declarationFor(
  extensionIdentity: string | undefined,
  declarations: readonly RoomKindSchema[],
  roomKind: string,
): RoomKindSchema | undefined {
  if (!extensionIdentity || isBuiltinRoomKind(roomKind)) return undefined;
  return declarations.find(
    (declaration) => fullRoomKind(extensionIdentity, declaration.kind) === roomKind,
  );
}

/** `contributes.rooms` of the extension installed at `packageRoot` (its verified package directory). */
export async function readPackageRoomContributions(packageRoot: string): Promise<RoomKindSchema[]> {
  try {
    const text = await readFile(path.join(packageRoot, "runtime-extension.json"), "utf8");
    return readRoomContributions(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}
