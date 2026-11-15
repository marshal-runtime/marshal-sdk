import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RoomKindSchema } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { OrgRoomsManager, type RoomsCaller } from "./rooms-manager";

/**
 * Two desktops against a real rooms service (the service lane's `pnpm rooms:dev`, dev-token identity):
 *   ROOMS_LIVE_URL=http://127.0.0.1:8790 ROOMS_LIVE_WORKSPACE=ws:platform \
 *     npx vitest run electron/org/rooms/rooms-latency.live.test.ts
 * Measures one replica's write to the other replica's records event. Skipped without ROOMS_LIVE_URL.
 */
const LIVE_URL = process.env.ROOMS_LIVE_URL;
const SAMPLES = Number(process.env.ROOMS_LIVE_SAMPLES ?? 200);
/** A workspace the service lists (`--workspaces`); rooms in any other are refused. */
const WORKSPACE = process.env.ROOMS_LIVE_WORKSPACE ?? "ws-bench";
const SCHEMA: RoomKindSchema = {
  kind: "page",
  schemaVersion: 1,
  records: { section: { fields: { headline: "value" } } },
};
const CALLER: RoomsCaller = {
  extension: "@bench/rooms",
  actor: { kind: "person" },
  declarations: [SCHEMA],
};

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

describe.skipIf(!LIVE_URL)("rooms against the real local service", () => {
  it(
    "write on one desktop to records event on the other: p50 / p95 / p99",
    { timeout: 120_000 },
    async () => {
      const apiBase = LIVE_URL ?? "";
      const socketUrl = `${apiBase.replace(/^http/, "ws")}/v1/rooms/socket`;
      const run = Date.now().toString(36);
      const people = [`user:dana-${run}@bench.test`, `user:guy-${run}@bench.test`] as const;
      const roots: string[] = [];
      const desktops = people.map((person) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-live-"));
        roots.push(root);
        const manager = new OrgRoomsManager({
          endpoint: { orgId: "org-live", apiBase, socketUrl },
          token: async () => `dev:${person.slice("user:".length)}`,
          person: async () => person,
          root,
          createSocket: (url) => new WebSocket(url),
        });
        manager.start();
        return manager;
      });
      const [dana, guy] = desktops;
      if (!dana || !guy) throw new Error("two desktops expected");
      try {
        const room = await dana.create(CALLER, {
          kind: "page",
          workspaceId: WORKSPACE,
          title: "Latency",
        });
        const grant = await fetch(`${apiBase}/v1/rooms/${room.id}/grants`, {
          method: "POST",
          headers: {
            authorization: `Bearer dev:${people[0].slice("user:".length)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ principal: people[1], role: "collaborator" }),
        });
        expect(grant.ok).toBe(true);
        await guy.open(room.id);
        await vi.waitFor(
          () => expect(dana.socket.isJoined(room.id) && guy.socket.isJoined(room.id)).toBe(true),
          { timeout: 10_000 },
        );

        const sent = new Map<string, number>();
        const latencies: number[] = [];
        guy.subscribe(room.id, (event) => {
          if (event.kind !== "records") return;
          for (const change of event.changes) {
            const headline = change.set?.headline;
            const at = typeof headline === "string" ? sent.get(headline) : undefined;
            if (at !== undefined) latencies.push(performance.now() - at);
          }
        });
        for (let index = 0; index < SAMPLES; index += 1) {
          const headline = `h-${index}`;
          sent.set(headline, performance.now());
          // One write at a time, as a person types: each sample is one write's own trip.
          // eslint-disable-next-line no-await-in-loop -- sequential samples by design
          await dana.write(CALLER, room.id, `section:s${index % 20}`, "set", { headline });
          // eslint-disable-next-line no-await-in-loop -- wait for this sample's arrival before the next write
          await vi.waitFor(() => expect(latencies.length).toBe(index + 1), {
            timeout: 5000,
            interval: 1,
          });
        }
        const sorted = [...latencies].sort((left, right) => left - right);
        const report = {
          samples: sorted.length,
          p50: Number(percentile(sorted, 50).toFixed(2)),
          p95: Number(percentile(sorted, 95).toFixed(2)),
          p99: Number(percentile(sorted, 99).toFixed(2)),
          max: Number((sorted.at(-1) ?? Number.NaN).toFixed(2)),
        };
        process.stdout.write(`ROOMS_LIVE_LATENCY ${JSON.stringify(report)}\n`);
        await vi.waitFor(() => expect(dana.replica.outbox(room.id)).toHaveLength(0), {
          timeout: 10_000,
        });
        expect(guy.query(room.id, { type: "section" })).toEqual(
          dana.query(room.id, { type: "section" }),
        );
      } finally {
        for (const manager of desktops) manager.stop();
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
