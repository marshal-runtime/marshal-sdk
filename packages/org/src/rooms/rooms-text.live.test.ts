import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RoomKindSchema } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { OrgRoomsManager, type RoomsCaller } from "./rooms-manager";

/**
 * Two desktops typing into one text field through a real rooms service:
 *   ROOMS_LIVE_URL=http://127.0.0.1:8790 ROOMS_LIVE_WORKSPACE=ws:platform \
 *     npx vitest run electron/org/rooms/rooms-text.live.test.ts
 * Skipped without ROOMS_LIVE_URL. Dev-token identity (`dev:<email>`), as the latency and files live tests.
 */
const LIVE_URL = process.env.ROOMS_LIVE_URL;
const WORKSPACE = process.env.ROOMS_LIVE_WORKSPACE ?? "ws-bench";
const SCHEMA: RoomKindSchema = {
  kind: "notes",
  schemaVersion: 1,
  records: { note: { fields: { title: "value", body: "text" } } },
};
const CALLER: RoomsCaller = {
  extension: "@bench/rooms",
  actor: { kind: "person" },
  declarations: [SCHEMA],
};
const KEY = "note:one";

/** A desktop's network: a switch that drops its sockets and points new ones at a dead port. */
class Network {
  online = true;
  private readonly live = new Set<WebSocket>();
  connect = (url: string): WebSocket => {
    const socket = new WebSocket(this.online ? url : url.replace(/:\d+\//, ":1/"));
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
    socket.on("error", () => undefined);
    return socket;
  };
  down(): void {
    this.online = false;
    for (const socket of this.live) socket.terminate();
  }
}

const apiBase = LIVE_URL ?? "";
const token = (person: string) => `dev:${person.slice("user:".length)}`;
const body = (manager: OrgRoomsManager, roomId: string) => manager.textValue(roomId, KEY, "body");

/** Two desktops (fresh people) in one new room whose note body reads "Hello world" on both. */
async function twoDesktops(options: { shippedSocketTimings?: boolean } = {}) {
  const socketUrl = `${apiBase.replace(/^http/, "ws")}/v1/rooms/socket`;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const people = [`user:dana-${run}@bench.test`, `user:guy-${run}@bench.test`] as const;
  const roots: string[] = [];
  const desktops = people.map((person) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-text-live-"));
    roots.push(root);
    const network = new Network();
    const manager = new OrgRoomsManager({
      endpoint: { orgId: "org-live", apiBase, socketUrl },
      token: async () => token(person),
      person: async () => person,
      root,
      createSocket: network.connect,
      ...(options.shippedSocketTimings
        ? {}
        : { socket: { baseBackoffMs: 20, maxBackoffMs: 200, retryMs: 50 } }),
    });
    manager.start();
    return { manager, network };
  });
  const cleanup = () => {
    for (const { manager } of desktops) manager.stop();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  };
  const [dana, guy] = desktops;
  if (!dana || !guy) throw new Error("two desktops expected");
  try {
    const room = await dana.manager.create(CALLER, {
      kind: "notes",
      workspaceId: WORKSPACE,
      title: "Text",
    });
    const grant = await fetch(`${apiBase}/v1/rooms/${room.id}/grants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token(people[0])}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: people[1], role: "collaborator" }),
    });
    expect(grant.ok).toBe(true);
    await guy.manager.open(room.id);
    await vi.waitFor(() => {
      expect(dana.manager.socket.isJoined(room.id)).toBe(true);
      expect(guy.manager.socket.isJoined(room.id)).toBe(true);
    });
    await dana.manager.write(CALLER, room.id, KEY, "set", { title: "Brief", body: "Hello world" });
    await vi.waitFor(() => expect(body(guy.manager, room.id)).toBe("Hello world"), {
      timeout: 10_000,
    });
    return { dana, guy, desktops, people, room, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The service's own records (its reducer) hold `final` for the note body. */
async function onServer(roomId: string, person: string, final: string) {
  await vi.waitFor(
    async () => {
      const response = await fetch(`${apiBase}/v1/rooms/${roomId}/records`, {
        headers: { authorization: `Bearer ${token(person)}` },
      });
      expect(response.ok).toBe(true);
      expect(JSON.stringify(await response.json())).toContain(JSON.stringify(final));
    },
    { timeout: 10_000 },
  );
}

/**
 * A plain textarea on one desktop: it paints remote changes `paintMs` after they arrive, and every keystroke sends the
 * whole value built on what it shows (with that value's version as the base, or with none).
 */
function textarea(manager: OrgRoomsManager, roomId: string, withBase: boolean, paintMs = 40) {
  let shown = manager.textRead(roomId, KEY, "body");
  let staleWrites = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const unsubscribe = manager.subscribeText(roomId, KEY, "body", (event) => {
    if (event.origin === "local") return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      shown = manager.textRead(roomId, KEY, "body");
    }, paintMs);
    timers.add(timer);
  });
  return {
    /** Types `letter` at `at(shown value)`. */
    async type(letter: string, at: (value: string) => number) {
      const { value, version } = shown;
      if (manager.textRead(roomId, KEY, "body").version !== version) staleWrites += 1;
      const index = at(value);
      shown = await manager.textSplice(CALLER, roomId, KEY, "body", {
        value: value.slice(0, index) + letter + value.slice(index),
        ...(withBase ? { base: version } : {}),
      });
    },
    /** One keystroke as a splice at `at(shown value)` (with the shown version as base, or none). */
    async key(letter: string, at: (value: string) => number) {
      const { value, version } = shown;
      if (manager.textRead(roomId, KEY, "body").version !== version) staleWrites += 1;
      shown = await manager.textSplice(CALLER, roomId, KEY, "body", {
        index: at(value),
        deleteCount: 0,
        insert: letter,
        ...(withBase ? { base: version } : {}),
      });
    },
    staleWrites: () => staleWrites,
    close() {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!LIVE_URL)("room text against the real local service", () => {
  it(
    "two desktops typing at once, one offline then rejoining, converge on both and on the server",
    { timeout: 120_000 },
    async () => {
      const { dana, guy, desktops, people, room, cleanup } = await twoDesktops();
      try {
        // Both type at once, letters interleaved: Dana after "Hello", Guy at the end.
        const started = performance.now();
        await Promise.all(
          ", dear".split("").flatMap((letter, index) => [
            dana.manager.textSplice(CALLER, room.id, KEY, "body", {
              index: 5 + index,
              deleteCount: 0,
              insert: letter,
            }),
            guy.manager.textSplice(CALLER, room.id, KEY, "body", {
              index: 11 + index,
              deleteCount: 0,
              insert: "!?!?!?"[index] ?? "",
            }),
          ]),
        );
        const together = "Hello, dear world!?!?!?";
        await vi.waitFor(
          () => {
            expect(body(dana.manager, room.id)).toBe(together);
            expect(body(guy.manager, room.id)).toBe(together);
          },
          { timeout: 10_000 },
        );
        const concurrentMs = performance.now() - started;

        // Guy goes offline and types; Dana keeps typing; Guy rejoins.
        guy.network.down();
        await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
        await guy.manager.textSplice(CALLER, room.id, KEY, "body", {
          index: 0,
          deleteCount: 0,
          insert: "Guy: ",
        });
        await dana.manager.textSplice(CALLER, room.id, KEY, "body", {
          index: 0,
          deleteCount: 1,
          insert: "h",
        });
        await dana.manager.textSplice(CALLER, room.id, KEY, "body", {
          index: together.length,
          deleteCount: 0,
          insert: " (Dana)",
        });
        const rejoined = performance.now();
        guy.network.online = true;
        const final = "Guy: hello, dear world!?!?!? (Dana)";
        await vi.waitFor(
          () => {
            for (const desktop of desktops) {
              expect(desktop.manager.replica.pending(room.id)).toHaveLength(0);
              expect(body(desktop.manager, room.id)).toBe(final);
              expect(desktop.manager.get(room.id, KEY)?.fields.body).toBe(final);
            }
          },
          { timeout: 20_000 },
        );
        const rejoinMs = performance.now() - rejoined;

        await onServer(room.id, people[1], final);
        process.stdout.write(
          `ROOMS_LIVE_TEXT ${JSON.stringify({
            concurrentMs: Math.round(concurrentMs),
            rejoinMs: Math.round(rejoinMs),
            history: guy.manager
              .textHistory(room.id, KEY, "body")
              .map((entry) => [entry.author, entry.changes]),
          })}\n`,
        );
      } finally {
        cleanup();
      }
    },
  );

  it(
    "two plain textareas sending whole values, each painting the other's typing 40 ms late, lose nothing",
    { timeout: 120_000 },
    async () => {
      const { dana, guy, people, room, cleanup } = await twoDesktops();
      /** One round of typing by both, each through a textarea that sends whole values (with or without a base). */
      const phase = async (withBase: boolean) => {
        const before = body(dana.manager, room.id);
        const danaBox = textarea(dana.manager, room.id, withBase);
        const guyBox = textarea(guy.manager, room.id, withBase);
        // Dana types after a word (then after her own letters), Guy at the very end, 15 ms between keystrokes.
        const danaWord = withBase ? ", dear" : " there";
        const guyWord = withBase ? "!?!?!?" : " (ok)";
        const anchor = withBase ? "Hello" : "dear";
        const danaAt = (value: string, typed: number) =>
          value.indexOf(anchor) + anchor.length + typed;
        const started = performance.now();
        await Array.from(
          { length: Math.max(danaWord.length, guyWord.length) },
          (_, typed) => typed,
        ).reduce(
          (previous, typed) =>
            previous.then(async () => {
              const danaLetter = danaWord[typed];
              const guyLetter = guyWord[typed];
              await Promise.all([
                danaLetter ? danaBox.type(danaLetter, (value) => danaAt(value, typed)) : undefined,
                guyLetter ? guyBox.type(guyLetter, (value) => value.length) : undefined,
              ]);
              await pause(15);
            }),
          Promise.resolve(),
        );
        const expected = before.replace(anchor, `${anchor}${danaWord}`) + guyWord;
        await vi.waitFor(
          () => {
            expect(body(dana.manager, room.id)).toBe(expected);
            expect(body(guy.manager, room.id)).toBe(expected);
            expect(dana.manager.replica.pending(room.id)).toHaveLength(0);
            expect(guy.manager.replica.pending(room.id)).toHaveLength(0);
          },
          { timeout: 10_000 },
        );
        await onServer(room.id, people[1], expected);
        danaBox.close();
        guyBox.close();
        return {
          convergedMs: Math.round(performance.now() - started),
          keystrokes: danaWord.length + guyWord.length,
          staleWrites: danaBox.staleWrites() + guyBox.staleWrites(),
          final: expected,
        };
      };
      try {
        const withBase = await phase(true);
        const noBase = await phase(false);
        process.stdout.write(`ROOMS_LIVE_TEXT_SETVALUE ${JSON.stringify({ withBase, noBase })}\n`);
      } finally {
        cleanup();
      }
    },
  );

  it(
    "two people typing letter by letter with splices, each painting the other 40 ms late, each read in order",
    { timeout: 120_000 },
    async () => {
      /** Guy types at the start (shifting where Dana types), Dana after "Hello "; 10 ms between keystrokes. */
      const phase = async (withBase: boolean) => {
        const { dana, guy, people, room, cleanup } = await twoDesktops();
        try {
          const danaBox = textarea(dana.manager, room.id, withBase);
          const guyBox = textarea(guy.manager, room.id, withBase);
          const guyWords = "Guy says: ";
          const danaWords = "Everyone, my dear ";
          const started = performance.now();
          await Array.from(
            { length: Math.max(guyWords.length, danaWords.length) },
            (_, typed) => typed,
          ).reduce(
            (previous, typed) =>
              previous.then(async () => {
                const guyLetter = guyWords[typed];
                const danaLetter = danaWords[typed];
                await Promise.all([
                  guyLetter ? guyBox.key(guyLetter, () => typed) : undefined,
                  danaLetter
                    ? danaBox.key(danaLetter, (value) => value.indexOf("Hello ") + 6 + typed)
                    : undefined,
                ]);
                await pause(10);
              }),
            Promise.resolve(),
          );
          let final = "";
          await vi.waitFor(
            () => {
              final = body(dana.manager, room.id);
              expect(body(guy.manager, room.id)).toBe(final);
              expect(dana.manager.replica.pending(room.id)).toHaveLength(0);
              expect(guy.manager.replica.pending(room.id)).toHaveLength(0);
            },
            { timeout: 10_000 },
          );
          await onServer(room.id, people[1], final);
          danaBox.close();
          guyBox.close();
          return {
            convergedMs: Math.round(performance.now() - started),
            keystrokes: guyWords.length + danaWords.length,
            staleKeystrokes: danaBox.staleWrites() + guyBox.staleWrites(),
            final,
            inOrder: final === `${guyWords}Hello ${danaWords}world`,
          };
        } finally {
          cleanup();
        }
      };
      const withBase = await phase(true);
      // Control: the same typing without a base, as before this fix (not asserted; it shows the problem).
      const noBase = await phase(false);
      process.stdout.write(`ROOMS_LIVE_TEXT_SPLICE ${JSON.stringify({ withBase, noBase })}\n`);
      expect(withBase.inOrder).toBe(true);
    },
  );

  it(
    "keystroke to the other desktop, alone and in a burst, and rejoin after 8 s offline",
    { timeout: 120_000 },
    async () => {
      // The reconnect backoff and resend timings a desktop ships with, not the fast test ones.
      const { dana, guy, people, room, cleanup } = await twoDesktops({
        shippedSocketTimings: true,
      });
      try {
        guy.manager.textRead(room.id, KEY, "body");
        const arrivals: { value: string; at: number }[] = [];
        const unsubscribe = guy.manager.subscribeText(room.id, KEY, "body", (event) => {
          if (event.origin === "remote")
            arrivals.push({ value: event.value, at: performance.now() });
        });
        /** Ms from Dana's keystroke call until Guy's live text holds `expected`. */
        const until = async (expected: string, since: number) => {
          await vi.waitFor(
            () => expect(arrivals.some((entry) => entry.value === expected)).toBe(true),
            {
              timeout: 5000,
              interval: 1,
            },
          );
          return (arrivals.find((entry) => entry.value === expected)?.at ?? since) - since;
        };
        const p50 = (values: number[]) =>
          values.toSorted((l, r) => l - r)[Math.floor(values.length / 2)] ?? 0;
        const typeOne = async (letter: string) => {
          const value = body(dana.manager, room.id);
          const started = performance.now();
          const answer = await dana.manager.textSplice(CALLER, room.id, KEY, "body", {
            index: value.length,
            deleteCount: 0,
            insert: letter,
            base: dana.manager.textRead(room.id, KEY, "body").version,
          });
          return { answerMs: performance.now() - started, started, expected: answer.value };
        };
        // Alone: one keystroke after a quiet 150 ms, 15 times.
        const alone = await Array.from({ length: 15 }, (_, n) => n).reduce<
          Promise<{ answer: number[]; arrive: number[] }>
        >(
          (previous, n) =>
            previous.then(async (acc) => {
              await pause(150);
              const key = await typeOne(String.fromCharCode(97 + n));
              acc.answer.push(key.answerMs);
              acc.arrive.push(await until(key.expected, key.started));
              return acc;
            }),
          Promise.resolve({ answer: [], arrive: [] }),
        );
        // A burst: 15 keystrokes 30 ms apart (the second and later ones wait for their 16 ms batch).
        await pause(150);
        const burst = await Array.from({ length: 15 }, (_, n) => n).reduce<
          Promise<{ started: number; expected: string }[]>
        >(
          (previous, n) =>
            previous.then(async (acc) => {
              const key = await typeOne(String.fromCharCode(65 + n));
              acc.push(key);
              await pause(30);
              return acc;
            }),
          Promise.resolve([]),
        );
        const burstArrive = await Promise.all(burst.map((key) => until(key.expected, key.started)));
        unsubscribe();

        // Guy offline 8 s while Dana types; time from his network coming back to his text showing hers.
        guy.network.down();
        await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
        await pause(8000);
        const offlineKey = await typeOne("!");
        const back = performance.now();
        guy.network.online = true;
        await vi.waitFor(() => expect(body(guy.manager, room.id)).toBe(offlineKey.expected), {
          timeout: 20_000,
          interval: 5,
        });
        const rejoinMs = performance.now() - back;
        await onServer(room.id, people[1], offlineKey.expected);
        const result = {
          aloneAnswerP50: Math.round(p50(alone.answer)),
          aloneArriveP50: Math.round(p50(alone.arrive)),
          burstArriveP50: Math.round(p50(burstArrive)),
          burstArriveMax: Math.round(Math.max(...burstArrive)),
          rejoinAfter8sOfflineMs: Math.round(rejoinMs),
        };
        process.stdout.write(`ROOMS_LIVE_TEXT_LATENCY ${JSON.stringify(result)}\n`);
        expect(result.rejoinAfter8sOfflineMs).toBeLessThan(5000);
      } finally {
        cleanup();
      }
    },
  );

  it(
    "two screens fed by splice answers and room-event values (delivered 0-20 ms late) type runs at one spot",
    { timeout: 120_000 },
    async () => {
      type Reading = { value: string; version: string; order: number };
      /** A screen showing the newest reading by order (or, as the control, whatever arrives last). */
      function eventScreen(manager: OrgRoomsManager, roomId: string, byOrder: boolean) {
        let shown: Reading = manager.textRead(roomId, KEY, "body");
        let caret = shown.value.length;
        const sentAt = new Map<string, number>();
        const arrivals: number[] = [];
        const show = (next: Reading) => {
          if (byOrder && next.order <= shown.order) return;
          let start = 0;
          while (
            start < Math.min(shown.value.length, next.value.length) &&
            shown.value[start] === next.value[start]
          )
            start += 1;
          if (start < caret) caret += next.value.length - shown.value.length;
          shown = next;
        };
        const unsubscribe = manager.subscribe(roomId, (event) => {
          if (event.kind !== "records") return;
          for (const change of event.changes) {
            const values: unknown = Reflect.get(change, "values");
            const carried: unknown =
              values && typeof values === "object" ? Reflect.get(values, "body") : undefined;
            if (!carried || typeof carried !== "object") continue;
            const reading: Reading = {
              value: String(Reflect.get(carried, "value")),
              version: String(Reflect.get(carried, "version")),
              order: Number(Reflect.get(carried, "order")),
            };
            const received = performance.now();
            for (const [letter, at] of sentAt)
              if (reading.value.includes(letter)) {
                arrivals.push(received - at);
                sentAt.delete(letter);
              }
            setTimeout(() => show(reading), Math.floor(Math.random() * 20));
          }
        });
        return {
          async key(letter: string) {
            const answer = await manager.textSplice(CALLER, roomId, KEY, "body", {
              index: caret,
              deleteCount: 0,
              insert: letter,
              base: shown.version,
            });
            if (!byOrder || answer.order > shown.order) {
              shown = answer;
              caret = (answer.index ?? caret) + 1;
            }
          },
          /** Expect `letter` (typed by the other person) to arrive here; record when. */
          expect: (letter: string, at: number) => sentAt.set(letter, at),
          arrivals,
          close: unsubscribe,
        };
      }
      const phase = async (byOrder: boolean, runs: number) => {
        const results: { whole: boolean; final: string }[] = [];
        const arrivals: number[] = [];
        for (let run = 0; run < runs; run += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one room per run, one after another
          const { dana, guy, people, room, cleanup } = await twoDesktops();
          try {
            const danaScreen = eventScreen(dana.manager, room.id, byOrder);
            const guyScreen = eventScreen(guy.manager, room.id, byOrder);
            const type = (
              box: ReturnType<typeof eventScreen>,
              other: ReturnType<typeof eventScreen>,
              letters: string,
            ) =>
              letters.split("").reduce<Promise<void>>(
                (previous, letter) =>
                  previous.then(async () => {
                    await pause(6 + Math.floor(Math.random() * 75));
                    other.expect(letter, performance.now());
                    await box.key(letter);
                  }),
                Promise.resolve(),
              );
            // oxlint-disable-next-line no-await-in-loop -- one room per run, one after another
            await Promise.all([
              type(danaScreen, guyScreen, "ABCDFGIJ"),
              type(guyScreen, danaScreen, "12345678"),
            ]);
            let final = "";
            // oxlint-disable-next-line no-await-in-loop -- one room per run, one after another
            await vi.waitFor(
              () => {
                final = body(dana.manager, room.id);
                expect(body(guy.manager, room.id)).toBe(final);
                expect(dana.manager.replica.pending(room.id)).toHaveLength(0);
                expect(guy.manager.replica.pending(room.id)).toHaveLength(0);
              },
              { timeout: 10_000 },
            );
            // oxlint-disable-next-line no-await-in-loop -- one room per run, one after another
            await onServer(room.id, people[1], final);
            danaScreen.close();
            guyScreen.close();
            arrivals.push(...danaScreen.arrivals, ...guyScreen.arrivals);
            results.push({
              whole: ["Hello worldABCDFGIJ12345678", "Hello world12345678ABCDFGIJ"].includes(final),
              final,
            });
          } finally {
            cleanup();
          }
        }
        const sorted = arrivals.toSorted((left, right) => left - right);
        return {
          runs,
          whole: results.filter((result) => result.whole).length,
          brokenExample: results.find((result) => !result.whole)?.final,
          keystrokeToOtherDesktopP50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
          keystrokeToOtherDesktopP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        };
      };
      const byOrder = await phase(true, 10);
      const lastArrives = await phase(false, 10);
      process.stdout.write(`ROOMS_LIVE_TEXT_EVENTS ${JSON.stringify({ byOrder, lastArrives })}\n`);
      expect(byOrder.whole).toBe(byOrder.runs);
    },
  );
});
