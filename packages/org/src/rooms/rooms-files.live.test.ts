import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RoomKindSchema } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { OrgRoomsManager, type RoomsCaller } from "./rooms-manager";

/**
 * Room files between two desktops through a real rooms service and its local file store:
 *   ROOMS_LIVE_URL=http://127.0.0.1:8790 ROOMS_LIVE_WORKSPACE=ws:platform \
 *     npx vitest run electron/org/rooms/rooms-files.live.test.ts
 * ROOMS_LIVE_FILE_MB sets the size (default 64). Skipped without ROOMS_LIVE_URL.
 */
const LIVE_URL = process.env.ROOMS_LIVE_URL;
const WORKSPACE = process.env.ROOMS_LIVE_WORKSPACE ?? "ws-bench";
const FILE_MB = Number(process.env.ROOMS_LIVE_FILE_MB ?? 64);
const SCHEMA: RoomKindSchema = {
  kind: "cut",
  schemaVersion: 1,
  records: { clip: { fields: { video: "file" } } },
};
const CALLER: RoomsCaller = {
  extension: "@bench/rooms",
  actor: { kind: "person" },
  declarations: [SCHEMA],
};

describe.skipIf(!LIVE_URL)("room files against the real local service", () => {
  it(
    "a multi-megabyte file put on one desktop is read on the other",
    { timeout: 180_000 },
    async () => {
      const apiBase = LIVE_URL ?? "";
      const socketUrl = `${apiBase.replace(/^http/, "ws")}/v1/rooms/socket`;
      const run = Date.now().toString(36);
      const people = [`user:dana-${run}@bench.test`, `user:guy-${run}@bench.test`] as const;
      const roots: string[] = [];
      const desktops = people.map((person) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-files-live-"));
        roots.push(root);
        const manager = new OrgRoomsManager({
          endpoint: { orgId: "org-live", apiBase, socketUrl },
          token: async () => `dev:${person.slice("user:".length)}`,
          person: async () => person,
          root,
          createSocket: (url) => new WebSocket(url),
        });
        manager.start();
        return { manager, root };
      });
      const [dana, guy] = desktops;
      if (!dana || !guy) throw new Error("two desktops expected");
      try {
        const room = await dana.manager.create(CALLER, {
          kind: "cut",
          workspaceId: WORKSPACE,
          title: "Files",
        });
        const grant = await fetch(`${apiBase}/v1/rooms/${room.id}/grants`, {
          method: "POST",
          headers: {
            authorization: `Bearer dev:${people[0].slice("user:".length)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ principal: people[1], role: "viewer" }),
        });
        expect(grant.ok).toBe(true);
        await guy.manager.open(room.id);

        const source = path.join(dana.root, "round.mp4");
        const block = new Uint8Array(1024 * 1024);
        const handle = fs.openSync(source, "w");
        for (let index = 0; index < FILE_MB; index += 1) {
          block.fill(index % 256);
          block[0] = index;
          fs.writeSync(handle, block);
        }
        fs.closeSync(handle);
        const expected = createHash("sha256").update(fs.readFileSync(source)).digest("hex");

        const putStart = performance.now();
        const ref = await dana.manager.putFile(room.id, source, "video/mp4");
        const putMs = performance.now() - putStart;
        expect(ref).toMatchObject({ sha256: expected, bytes: FILE_MB * 1024 * 1024 });
        await dana.manager.write(CALLER, room.id, "clip:one", "set", { video: ref });
        await vi.waitFor(() => expect(guy.manager.get(room.id, "clip:one")).toBeDefined(), {
          timeout: 10_000,
        });

        const getStart = performance.now();
        const local = await guy.manager.filePath(
          room.id,
          guy.manager.get(room.id, "clip:one")?.fields.video,
        );
        const getMs = performance.now() - getStart;
        expect(local.startsWith(guy.root)).toBe(true);
        expect(createHash("sha256").update(fs.readFileSync(local)).digest("hex")).toBe(expected);
        const againStart = performance.now();
        expect(await guy.manager.filePath(room.id, ref)).toBe(local);
        const cachedMs = performance.now() - againStart;
        process.stdout.write(
          `ROOMS_LIVE_FILES ${JSON.stringify({
            megabytes: FILE_MB,
            putMs: Math.round(putMs),
            getMs: Math.round(getMs),
            cachedMs: Number(cachedMs.toFixed(2)),
          })}\n`,
        );
      } finally {
        for (const { manager } of desktops) manager.stop();
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
