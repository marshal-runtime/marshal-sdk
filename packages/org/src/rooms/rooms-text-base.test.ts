import type { RoomTextSplice } from "@marshal/agent-runtime-org";
import { describe, expect, it } from "vitest";

import { rebaseSplice, rebaseTextEdit } from "./rooms-text-base";

function apply(text: string, splices: readonly RoomTextSplice[]): string {
  return splices.reduce(
    (value, splice) =>
      value.slice(0, splice.index) + splice.insert + value.slice(splice.index + splice.deleteCount),
    text,
  );
}

/** Others' splices from `base`, then the writer's whole value (built on `base`) moved onto the result. */
function merge(base: string, others: RoomTextSplice[], next: string): string {
  return apply(apply(base, others), rebaseTextEdit(base, next, others));
}

describe("rebaseTextEdit: a whole-value write moved onto text others changed since its base", () => {
  it("keeps an insertion before, after and at the writer's position", () => {
    expect(
      merge("Hello world", [{ index: 6, deleteCount: 0, insert: "big " }], "Hello world!"),
    ).toBe("Hello big world!");
    expect(
      merge("Hello world", [{ index: 0, deleteCount: 0, insert: ">> " }], "Hello, world"),
    ).toBe(">> Hello, world");
    expect(merge("Hello world", [{ index: 11, deleteCount: 0, insert: "X" }], "Hello world!")).toBe(
      "Hello world!X",
    );
  });

  it("deletes only characters the writer saw: text inserted inside its deletion stays", () => {
    expect(merge("Hello world", [{ index: 8, deleteCount: 0, insert: "-big-" }], "Hello ")).toBe(
      "Hello -big-",
    );
  });

  it("applies a replacement where its text moved to, after several others' edits", () => {
    const others = [
      { index: 0, deleteCount: 0, insert: "A: " },
      { index: 9, deleteCount: 5, insert: "there" },
    ];
    expect(merge("Hello world, again", others, "Hi world, again")).toBe("A: Hi there, again");
  });

  it("a splice keeps its exact position between equal letters (no re-diffing)", () => {
    // "ab" + "b" at 1 while someone inserted "X" at 2: "abbX", never "abXb".
    const others = [{ index: 2, deleteCount: 0, insert: "X" }];
    expect(apply("abX", rebaseSplice({ index: 1, deleteCount: 0, insert: "b" }, others))).toBe(
      "abbX",
    );
  });

  it("a keystroke against a screen that has not shown the other's letters lands after its own previous one", () => {
    // Dana's screen shows "Hello dworld" (her own "d"); since then Guy typed "H", "i" at the start.
    const since = [
      { index: 0, deleteCount: 0, insert: "H" },
      { index: 1, deleteCount: 0, insert: "i" },
    ];
    const current = apply("Hello dworld", since);
    expect(current).toBe("HiHello dworld");
    // Her next letter goes at index 7 of what she sees.
    const moved = rebaseSplice({ index: 7, deleteCount: 0, insert: "e" }, since);
    expect(apply(current, moved)).toBe("HiHello deworld");
    // Without moving it, index 7 against the current text splits her word: what the demo saw.
    expect(apply(current, [{ index: 7, deleteCount: 0, insert: "e" }])).toBe("HiHelloe dworld");
  });

  it("a deletion against an old value removes only the letters it meant, not ones typed since", () => {
    const since = [{ index: 0, deleteCount: 0, insert: ">> " }];
    // Backspace over "o" of "Hello" (index 4) on a screen without ">> ".
    expect(apply(">> Hello", rebaseSplice({ index: 4, deleteCount: 1, insert: "" }, since))).toBe(
      ">> Hell",
    );
  });

  it("is nothing when the value did not change, and the plain edit when nobody else typed", () => {
    expect(rebaseTextEdit("same", "same", [{ index: 0, deleteCount: 0, insert: "x" }])).toEqual([]);
    expect(merge("Hello world", [], "Hello, world")).toBe("Hello, world");
  });
});
