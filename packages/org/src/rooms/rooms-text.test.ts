import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RoomKindSchema, RoomTextEvent } from "@marshal/agent-runtime-org";
import {
  createInMemoryRoomsProvider,
  type InMemoryRoomsProvider,
} from "@marshal/agent-runtime-org/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { OrgRoomsManager, type RoomsCaller } from "./rooms-manager";

const SCHEMA: RoomKindSchema = {
  kind: "page",
  schemaVersion: 1,
  records: { section: { fields: { headline: "value", body: "text" } } },
};
const PERSON: RoomsCaller = {
  extension: "@test/shared-page",
  actor: { kind: "person" },
  declarations: [SCHEMA],
};
const DANA = "user:dana@example.com";
const GUY = "user:guy@example.com";
const KEY = "section:intro";

const managers: OrgRoomsManager[] = [];
const dirs: string[] = [];
const providers: InMemoryRoomsProvider[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

function desktop(
  provider: InMemoryRoomsProvider,
  person: `user:${string}`,
  options: { root?: string; online?: boolean } = {},
) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "rooms-text-"));
  if (!options.root) dirs.push(root);
  const network = new Network();
  network.online = options.online ?? true;
  const token = provider.issueToken(person);
  const manager = new OrgRoomsManager({
    endpoint: { orgId: "org-test", apiBase: provider.apiBase, socketUrl: provider.socketUrl },
    token: async () => token,
    person: async () => person,
    root,
    createSocket: network.connect,
    socket: { baseBackoffMs: 5, maxBackoffMs: 40, random: () => 0.5, retryMs: 20 },
  });
  managers.push(manager);
  manager.start();
  return { manager, network, token, root };
}

async function pair() {
  const provider = await createInMemoryRoomsProvider({ drainMs: 5 });
  providers.push(provider);
  const dana = desktop(provider, DANA);
  const guy = desktop(provider, GUY);
  const room = await dana.manager.create(PERSON, {
    kind: "page",
    workspaceId: "ws-1",
    title: "Page",
  });
  const response = await fetch(`${provider.apiBase}/v1/rooms/${room.id}/grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${dana.token}`, "content-type": "application/json" },
    body: JSON.stringify({ principal: GUY, role: "collaborator" }),
  });
  expect(response.ok).toBe(true);
  await guy.manager.open(room.id);
  await vi.waitFor(() => {
    expect(dana.manager.socket.isJoined(room.id)).toBe(true);
    expect(guy.manager.socket.isJoined(room.id)).toBe(true);
  });
  await dana.manager.write(PERSON, room.id, KEY, "set", { headline: "Intro", body: "Hello world" });
  await vi.waitFor(() => expect(guy.manager.textValue(room.id, KEY, "body")).toBe("Hello world"));
  return { provider, dana, guy, roomId: room.id };
}

/** Both desktops show the same text, equal to `expected`, and nothing of theirs is left to send. */
async function converged(
  roomId: string,
  desktops: { manager: OrgRoomsManager }[],
  expected: string,
  timeout = 5000,
) {
  await vi.waitFor(
    () => {
      for (const { manager } of desktops) {
        const value = manager.textValue(roomId, KEY, "body");
        // Long texts: compare a readable outline first, so a failure says where they differ.
        const outline = (text: string) => ({ length: text.length, tail: text.slice(-24) });
        expect(outline(value)).toEqual(outline(expected));
        expect(manager.replica.pending(roomId)).toHaveLength(0);
        expect(value).toBe(expected);
        expect(manager.get(roomId, KEY)?.fields.body).toBe(expected);
      }
    },
    { timeout },
  );
}

/** Who has typed in the body field, as that desktop knows it. */
const authors = (manager: OrgRoomsManager, roomId: string) =>
  manager.textHistory(roomId, KEY, "body").map((run) => run.author);

describe("room text: two desktops typing into one field (in-memory rooms service)", () => {
  it("concurrent typing in the same field keeps both people's characters on both desktops", async () => {
    const { dana, guy, roomId } = await pair();
    const heard: RoomTextEvent[] = [];
    guy.manager.subscribeText(roomId, KEY, "body", (event) => heard.push(event));
    // Interleaved keystrokes, none awaited: Dana types after "Hello", Guy at the end.
    const typing: Promise<unknown>[] = [];
    for (const [index, letter] of ", dear".split("").entries()) {
      typing.push(
        dana.manager.textSplice(PERSON, roomId, KEY, "body", {
          index: 5 + index,
          deleteCount: 0,
          insert: letter,
        }),
      );
      typing.push(
        guy.manager.textSplice(PERSON, roomId, KEY, "body", {
          index: 11 + index,
          deleteCount: 0,
          insert: "!?!?!?"[index] ?? "",
        }),
      );
    }
    await Promise.all(typing);
    await converged(roomId, [dana, guy], "Hello, dear world!?!?!?");
    expect(heard.some((event) => event.origin === "local")).toBe(true);
    // Guy's screen hears Dana's letters as splices at her position (batched keystrokes), not as a whole new value.
    const remote = heard
      .filter((event) => event.origin === "remote")
      .flatMap((event) => event.splices);
    expect(remote.some((splice) => splice.index === 5 && splice.insert.startsWith(","))).toBe(true);
    expect(
      remote.every((splice) => splice.deleteCount === 0 && splice.insert.length <= ", dear".length),
    ).toBe(true);
    const runs = guy.manager.textHistory(roomId, KEY, "body");
    expect(runs.map((run) => run.author).sort()).toEqual(expect.arrayContaining([DANA, GUY]));
  });

  it("a full-value write of a text field becomes an edit: a concurrent edit by the other person survives", async () => {
    const { dana, guy, roomId } = await pair();
    guy.network.down();
    await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
    await guy.manager.textSplice(PERSON, roomId, KEY, "body", { value: "Hello brave world" });
    await dana.manager.write(PERSON, roomId, KEY, "set", { body: "Hello world, again" });
    guy.network.online = true;
    await converged(roomId, [dana, guy], "Hello brave world, again");
  });

  describe("whole-value writes built on a value that has not shown a remote insertion yet", () => {
    /** Guy's insertion reaches Dana's desktop; Dana's screen then sends a whole value built on what it showed before. */
    async function staleWrite(
      guyEdit: { index: number; deleteCount: number; insert: string },
      after: string,
      write: (
        writer: { manager: OrgRoomsManager },
        room: string,
        base: string,
        next: string,
      ) => Promise<unknown>,
      next: string,
    ) {
      const { dana, guy, roomId } = await pair();
      const shown = dana.manager.textRead(roomId, KEY, "body");
      expect(shown.value).toBe("Hello world");
      await guy.manager.textSplice(PERSON, roomId, KEY, "body", guyEdit);
      await vi.waitFor(() => expect(dana.manager.textValue(roomId, KEY, "body")).toBe(after));
      await write(dana, roomId, shown.version, next);
      return { dana, guy, roomId };
    }

    it("text.set with the base keeps an insertion at a different position", async () => {
      const { dana, guy, roomId } = await staleWrite(
        { index: 6, deleteCount: 0, insert: "big " },
        "Hello big world",
        (writer, room, base, value) =>
          writer.manager.textSplice(PERSON, room, KEY, "body", { value, base }),
        "Hello world!",
      );
      await converged(roomId, [dana, guy], "Hello big world!");
      expect(authors(guy.manager, roomId)).toEqual(expect.arrayContaining([DANA, GUY]));
    });

    it("text.set with the base keeps an insertion at the same position", async () => {
      const { dana, guy, roomId } = await staleWrite(
        { index: 11, deleteCount: 0, insert: "?" },
        "Hello world?",
        (writer, room, base, value) =>
          writer.manager.textSplice(PERSON, room, KEY, "body", { value, base }),
        "Hello world!",
      );
      // Left-anchored: her "!" stays right after "world", Guy's "?" follows it.
      await converged(roomId, [dana, guy], "Hello world!?");
      expect(authors(guy.manager, roomId)).toEqual(expect.arrayContaining([DANA, GUY]));
    });

    it("room set with a string and textBase keeps the insertion too", async () => {
      const { dana, guy, roomId } = await staleWrite(
        { index: 0, deleteCount: 0, insert: "Guy: " },
        "Guy: Hello world",
        (writer, room, base, body) =>
          writer.manager.write(PERSON, room, KEY, "set", { body }, { textBase: { body: base } }),
        "Hello, world",
      );
      await converged(roomId, [dana, guy], "Guy: Hello, world");
      expect(authors(guy.manager, roomId)).toEqual(expect.arrayContaining([DANA, GUY]));
    });

    it("with no base, the host finds the value the write was built on and keeps the insertion", async () => {
      const { dana, guy, roomId } = await pair();
      // Dana types, Guy's insertion arrives, and Dana's next keystroke is a whole value built on her own last one.
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", { value: "Hello, world" });
      await vi.waitFor(() =>
        expect(guy.manager.textValue(roomId, KEY, "body")).toBe("Hello, world"),
      );
      await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 7,
        deleteCount: 0,
        insert: "big ",
      });
      await vi.waitFor(() =>
        expect(dana.manager.textValue(roomId, KEY, "body")).toBe("Hello, big world"),
      );
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", { value: "Hello, world!" });
      await converged(roomId, [dana, guy], "Hello, big world!");
      // A write built on the current value is the plain edit: deleting what is shown deletes it.
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", { value: "Hello, world!" });
      await converged(roomId, [dana, guy], "Hello, world!");
    });

    it("both people send whole values at once, each from the value they saw: every edit is kept", async () => {
      const { dana, guy, roomId } = await pair();
      const danaBase = dana.manager.textRead(roomId, KEY, "body").version;
      const guyBase = guy.manager.textRead(roomId, KEY, "body").version;
      await Promise.all([
        dana.manager.textSplice(PERSON, roomId, KEY, "body", {
          value: "Hello, world",
          base: danaBase,
        }),
        guy.manager.textSplice(PERSON, roomId, KEY, "body", {
          value: "Hello world!",
          base: guyBase,
        }),
      ]);
      await converged(roomId, [dana, guy], "Hello, world!");
      // The next keystrokes, each built on the value that person's screen showed one remote change ago.
      const danaShown = dana.manager.textRead(roomId, KEY, "body");
      const guyShown = guy.manager.textRead(roomId, KEY, "body");
      await Promise.all([
        dana.manager.textSplice(PERSON, roomId, KEY, "body", {
          value: `${danaShown.value} (Dana)`,
          base: danaShown.version,
        }),
        guy.manager.textSplice(PERSON, roomId, KEY, "body", {
          value: `Guy: ${guyShown.value}`,
          base: guyShown.version,
        }),
      ]);
      await converged(roomId, [dana, guy], "Guy: Hello, world! (Dana)");
      expect(authors(guy.manager, roomId)).toEqual(expect.arrayContaining([DANA, GUY]));
    });
  });

  describe("per-key splices from a screen that paints the other's typing late", () => {
    /** A textarea: paints remote changes `paintMs` after they arrive; its own answers at once. */
    function screen(manager: OrgRoomsManager, roomId: string, withBase: boolean, paintMs = 40) {
      let shown = manager.textRead(roomId, KEY, "body");
      let stale = 0;
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
        /** One keystroke at `caret(shown value)`; answers where it landed in the (now shown) answer value. */
        async key(letter: string, caret: (value: string) => number): Promise<number | undefined> {
          const { value, version } = shown;
          if (manager.textRead(roomId, KEY, "body").version !== version) stale += 1;
          const answer = await manager.textSplice(PERSON, roomId, KEY, "body", {
            index: caret(value),
            deleteCount: 0,
            insert: letter,
            ...(withBase ? { base: version } : {}),
          });
          shown = answer;
          return answer.index;
        },
        stale: () => stale,
        close() {
          unsubscribe();
          for (const timer of timers) clearTimeout(timer);
        },
      };
    }

    it("two people typing at once, letter by letter, each read in order on both desktops", async () => {
      const { dana, guy, roomId } = await pair();
      const danaScreen = screen(dana.manager, roomId, true);
      const guyScreen = screen(guy.manager, roomId, true);
      // Guy types at the start, so every letter of his shifts where Dana types (after "Hello ").
      const guyWords = "Guy says: ";
      const danaWords = "my dear ";
      await Array.from({ length: Math.max(guyWords.length, danaWords.length) }, (_, n) => n).reduce(
        (previous, n) =>
          previous.then(async () => {
            const guyLetter = guyWords[n];
            const danaLetter = danaWords[n];
            await Promise.all([
              guyLetter ? guyScreen.key(guyLetter, () => n) : undefined,
              danaLetter
                ? danaScreen.key(danaLetter, (value) => value.indexOf("Hello ") + 6 + n)
                : undefined,
            ]);
            await new Promise((resolve) => setTimeout(resolve, 10));
          }),
        Promise.resolve(),
      );
      await converged(roomId, [dana, guy], "Guy says: Hello my dear world");
      // The point of the test: keystrokes were typed on a screen that had not shown the other's latest letters.
      expect(danaScreen.stale() + guyScreen.stale()).toBeGreaterThan(0);
      danaScreen.close();
      guyScreen.close();
    });

    it("two people typing at the same spot each keep their run together (left-anchored)", async () => {
      const { dana, guy, roomId } = await pair();
      // These screens show only their own answers (which include whatever had arrived), never a late paint.
      const danaScreen = screen(dana.manager, roomId, true, 60_000);
      const guyScreen = screen(guy.manager, roomId, true, 60_000);
      const danaRun = "-dana";
      const guyRun = "+guy+";
      // Both start right after "Hello"; each next letter goes after where their previous one landed.
      const carets = { dana: 5, guy: 5 };
      await Array.from({ length: danaRun.length }, (_, n) => n).reduce(
        (previous, n) =>
          previous.then(async () => {
            const [danaAt, guyAt] = await Promise.all([
              danaScreen.key(danaRun[n] ?? "", () => carets.dana),
              guyScreen.key(guyRun[n] ?? "", () => carets.guy),
            ]);
            carets.dana = (danaAt ?? carets.dana) + 1;
            carets.guy = (guyAt ?? carets.guy) + 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }),
        Promise.resolve(),
      );
      danaScreen.close();
      guyScreen.close();
      const final = await vi.waitFor(() => {
        const value = dana.manager.textValue(roomId, KEY, "body");
        expect(guy.manager.textValue(roomId, KEY, "body")).toBe(value);
        expect(dana.manager.replica.pending(roomId)).toHaveLength(0);
        expect(guy.manager.replica.pending(roomId)).toHaveLength(0);
        return value;
      });
      expect([`Hello${danaRun}${guyRun} world`, `Hello${guyRun}${danaRun} world`]).toContain(final);
    });

    it("screens that take values from room events (late, on their own path) keep same-spot runs whole by order", async () => {
      const { dana, guy, roomId } = await pair();
      /** A screen fed by splice answers and by room-event values delivered 0-20 ms late; it shows the newest by order. */
      function eventScreen(manager: OrgRoomsManager) {
        let shown = manager.textRead(roomId, KEY, "body");
        let caret = shown.value.length;
        let ignored = 0;
        // A remote value moves the caret by its edit; an insertion exactly at the caret stays after it (left-anchored).
        const show = (next: { value: string; version: string; order: number }) => {
          if (next.order <= shown.order) {
            ignored += 1;
            return;
          }
          const before = shown.value;
          let start = 0;
          while (
            start < Math.min(before.length, next.value.length) &&
            before[start] === next.value[start]
          )
            start += 1;
          if (start < caret) caret += next.value.length - before.length;
          shown = next;
        };
        const unsubscribe = manager.subscribe(roomId, (event) => {
          if (event.kind !== "records") return;
          for (const change of event.changes) {
            const values: unknown = Reflect.get(change, "values");
            const body: unknown =
              values && typeof values === "object" ? Reflect.get(values, "body") : undefined;
            if (!body || typeof body !== "object") continue;
            const reading = {
              value: String(Reflect.get(body, "value")),
              version: String(Reflect.get(body, "version")),
              order: Number(Reflect.get(body, "order")),
            };
            setTimeout(() => show(reading), Math.floor(Math.random() * 20));
          }
        });
        return {
          async key(letter: string) {
            const answer = await manager.textSplice(PERSON, roomId, KEY, "body", {
              index: caret,
              deleteCount: 0,
              insert: letter,
              base: shown.version,
            });
            if (answer.order > shown.order) {
              shown = answer;
              caret = (answer.index ?? caret) + 1;
            }
          },
          ignored: () => ignored,
          close: unsubscribe,
        };
      }
      const danaScreen = eventScreen(dana.manager);
      const guyScreen = eventScreen(guy.manager);
      const type = (box: ReturnType<typeof eventScreen>, run: string) =>
        run.split("").reduce<Promise<void>>(
          (previous, letter) =>
            previous.then(async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, 6 + Math.floor(Math.random() * 75)),
              );
              await box.key(letter);
            }),
          Promise.resolve(),
        );
      await Promise.all([type(danaScreen, "ABCDEFGH"), type(guyScreen, "12345678")]);
      const final = await vi.waitFor(() => {
        const value = dana.manager.textValue(roomId, KEY, "body");
        expect(guy.manager.textValue(roomId, KEY, "body")).toBe(value);
        expect(dana.manager.replica.pending(roomId)).toHaveLength(0);
        expect(guy.manager.replica.pending(roomId)).toHaveLength(0);
        return value;
      });
      danaScreen.close();
      guyScreen.close();
      expect(["Hello worldABCDEFGH12345678", "Hello world12345678ABCDEFGH"]).toContain(final);
    });

    it("two screens each typing 8 letters at the end with 6-80 ms jitter keep both runs whole", async () => {
      const { dana, guy, roomId } = await pair();
      const danaScreen = screen(dana.manager, roomId, true, 60_000);
      const guyScreen = screen(guy.manager, roomId, true, 60_000);
      const end = "Hello world".length;
      const jitter = () => 6 + Math.floor(Math.random() * 75);
      /** One person typing `run` after their own previous letter, starting at the end of the text. */
      const type = (box: ReturnType<typeof screen>, run: string) =>
        run.split("").reduce<Promise<number>>(
          (previous, letter) =>
            previous.then(async (caret) => {
              await new Promise((resolve) => setTimeout(resolve, jitter()));
              return ((await box.key(letter, () => caret)) ?? caret) + 1;
            }),
          Promise.resolve(end),
        );
      await Promise.all([type(danaScreen, " Love it"), type(guyScreen, " Try it!")]);
      danaScreen.close();
      guyScreen.close();
      const final = await vi.waitFor(() => {
        const value = dana.manager.textValue(roomId, KEY, "body");
        expect(guy.manager.textValue(roomId, KEY, "body")).toBe(value);
        expect(dana.manager.replica.pending(roomId)).toHaveLength(0);
        expect(guy.manager.replica.pending(roomId)).toHaveLength(0);
        return value;
      });
      expect(["Hello world Love it Try it!", "Hello world Try it! Love it"]).toContain(final);
    });

    it("answers a keystroke before its batch is sent; the first of a burst goes out at once", async () => {
      const { dana, roomId } = await pair();
      await vi.waitFor(() => expect(dana.manager.replica.pending(roomId)).toHaveLength(0));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const first = await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 0,
        deleteCount: 0,
        insert: "a",
      });
      // Sent at once: in the outbox when the answer arrives.
      expect(dana.manager.replica.outbox(roomId)).toHaveLength(1);
      const second = await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 1,
        deleteCount: 0,
        insert: "b",
        base: first.version,
      });
      expect(second).toMatchObject({ value: "abHello world", index: 1 });
      // Answered before its batch went out: the second letter follows within the batch time.
      expect(dana.manager.replica.outbox(roomId).length).toBeLessThanOrEqual(1);
      await vi.waitFor(() => expect(dana.manager.replica.pending(roomId)).toHaveLength(0));
    });

    it("a remote text change reaches screens with the field's value, version and order", async () => {
      const { dana, guy, roomId } = await pair();
      guy.manager.textRead(roomId, KEY, "body");
      const values: unknown[] = [];
      guy.manager.subscribe(roomId, (event) => {
        if (event.kind !== "records") return;
        for (const change of event.changes)
          if (!change.pending && "values" in change) values.push(change.values);
      });
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 11,
        deleteCount: 0,
        insert: "!",
      });
      await vi.waitFor(() =>
        expect(values.at(-1)).toEqual({ body: guy.manager.textRead(roomId, KEY, "body") }),
      );
    });

    it("a splice against a version behind this desktop's own unsent edits moves past them too", async () => {
      const { dana, guy, roomId } = await pair();
      dana.network.down();
      await vi.waitFor(() => expect(dana.manager.socket.connected).toBe(false));
      const seen = dana.manager.textRead(roomId, KEY, "body");
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 0,
        deleteCount: 0,
        insert: "A",
      });
      // Index 5 of "Hello world" (after "Hello"), sent with the version from before the "A".
      const answer = await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 5,
        deleteCount: 0,
        insert: "B",
        base: seen.version,
      });
      expect(answer).toMatchObject({ value: "AHelloB world", index: 6 });
      dana.network.online = true;
      await converged(roomId, [dana, guy], "AHelloB world");
    });

    it("without a base the index is taken against the current text, as before", async () => {
      const { dana, guy, roomId } = await pair();
      await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 0,
        deleteCount: 0,
        insert: ">> ",
      });
      await vi.waitFor(() =>
        expect(dana.manager.textValue(roomId, KEY, "body")).toBe(">> Hello world"),
      );
      // Meant "after Hello" on a screen that still showed "Hello world".
      await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 5,
        deleteCount: 0,
        insert: "!",
      });
      await converged(roomId, [dana, guy], ">> He!llo world");
    });
  });

  it("one desktop types offline and rejoins: both converge with every character", async () => {
    const { dana, guy, roomId } = await pair();
    guy.network.down();
    await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
    // Letter by letter, each typed where "Hello" is now.
    await "Guy: ".split("").reduce<Promise<unknown>>(
      (previous, letter) =>
        previous.then(() =>
          guy.manager.textSplice(PERSON, roomId, KEY, "body", {
            index: guy.manager.textValue(roomId, KEY, "body").indexOf("Hello"),
            deleteCount: 0,
            insert: letter,
          }),
        ),
      Promise.resolve(),
    );
    await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: "Hello world".length,
      deleteCount: 0,
      insert: " (Dana)",
    });
    await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: 0,
      deleteCount: 1,
      insert: "h",
    });
    expect(guy.manager.textValue(roomId, KEY, "body")).toBe("Guy: Hello world");
    guy.network.online = true;
    await converged(roomId, [dana, guy], "Guy: hello world (Dana)");
  });

  it("pending typing survives a restart while offline and merges after it", async () => {
    const { provider, dana, guy, roomId } = await pair();
    guy.network.down();
    await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
    await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: 0,
      deleteCount: 0,
      insert: ">> ",
    });
    guy.manager.stop();
    managers.splice(managers.indexOf(guy.manager), 1);
    await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: 11,
      deleteCount: 0,
      insert: ".",
    });

    const restarted = desktop(provider, GUY, { root: guy.root, online: false });
    expect(restarted.manager.textValue(roomId, KEY, "body")).toBe(">> Hello world");
    expect(restarted.manager.get(roomId, KEY)?.fields.body).toBe(">> Hello world");
    restarted.network.online = true;
    await converged(roomId, [dana, restarted], ">> Hello world.");
  });

  it("a new epoch loses no typing: edits above durable are resent and both desktops converge", async () => {
    const { provider, dana, guy, roomId } = await pair();
    provider.holdDurable(true);
    await dana.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: 0,
      deleteCount: 0,
      insert: "Hi. ",
    });
    await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
      index: 11,
      deleteCount: 0,
      insert: "!",
    });
    await vi.waitFor(() =>
      expect(guy.manager.textValue(roomId, KEY, "body")).toBe("Hi. Hello world!"),
    );
    const epoch = dana.manager.replica.getRoom(roomId)?.epoch;
    await provider.loseBusState();
    provider.holdDurable(false);
    await converged(roomId, [dana, guy], "Hi. Hello world!");
    await vi.waitFor(() => expect(dana.manager.replica.outbox(roomId)).toHaveLength(0));
    expect(dana.manager.replica.getRoom(roomId)?.epoch).not.toBe(epoch);
  });

  it(
    "compacts a long-edited field, and an offline desktop's older-generation typing is rebased onto it",
    { timeout: 60_000 },
    async () => {
      const { dana, guy, roomId } = await pair();
      guy.network.down();
      await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
      await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 5,
        deleteCount: 0,
        insert: " there",
      });
      const refused: string[] = [];
      dana.manager.subscribe(roomId, (event) => {
        if (event.kind === "refused") refused.push(event.code);
      });
      // Reverse typing leaves one Yjs item per letter; 4500 of them pass the compaction rule whatever the (random) client ids encode to.
      await Promise.all(
        Array.from({ length: 4500 }, () =>
          dana.manager.textSplice(PERSON, roomId, KEY, "body", {
            index: 0,
            deleteCount: 0,
            insert: "x",
          }),
        ),
      );
      const prefix = "x".repeat(4500);
      await vi.waitFor(
        () =>
          expect({
            gen: dana.manager.replica.confirmed(roomId, KEY)?.texts?.body?.gen,
            refused,
            pending: dana.manager.replica.pending(roomId).length,
            state: dana.manager.replica.confirmed(roomId, KEY)?.texts?.body?.state.length,
          }).toEqual(expect.objectContaining({ gen: 1, refused: [], pending: 0 })),
        { timeout: 30_000 },
      );
      expect(dana.manager.textValue(roomId, KEY, "body")).toBe(`${prefix}Hello world`);
      guy.network.online = true;
      await converged(roomId, [dana, guy], `${prefix}Hello there world`, 20_000);
      expect(guy.manager.replica.confirmed(roomId, KEY)?.texts?.body?.gen).toBe(1);
    },
  );

  it(
    "typing left on an older generation by a restart is rebased when the desktop comes back",
    { timeout: 60_000 },
    async () => {
      const { provider, dana, guy, roomId } = await pair();
      guy.network.down();
      await vi.waitFor(() => expect(guy.manager.socket.connected).toBe(false));
      await guy.manager.textSplice(PERSON, roomId, KEY, "body", {
        index: 11,
        deleteCount: 0,
        insert: "!",
      });
      guy.manager.stop();
      managers.splice(managers.indexOf(guy.manager), 1);
      await Promise.all(
        Array.from({ length: 4500 }, () =>
          dana.manager.textSplice(PERSON, roomId, KEY, "body", {
            index: 0,
            deleteCount: 0,
            insert: "y",
          }),
        ),
      );
      await vi.waitFor(
        () => expect(dana.manager.replica.confirmed(roomId, KEY)?.texts?.body?.gen).toBe(1),
        { timeout: 30_000 },
      );
      const restarted = desktop(provider, GUY, { root: guy.root });
      await converged(roomId, [dana, restarted], `${"y".repeat(4500)}Hello world!`, 20_000);
    },
  );
});
