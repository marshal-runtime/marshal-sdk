import { roomTextSpliceFor, type RoomTextSplice } from "@marshal/agent-runtime-org";

/**
 * One caller's edit of a text field expressed against the value it started from (`base`), moved onto the current text:
 * `changes` are the splices that turned `base` into the current text, in order. The caller's deletions keep only
 * characters that were in `base` (anything inserted since stays), and its insertion lands where its position moved to.
 * Returns the splices to apply to the current text, in order (each against the text after the previous one).
 */
export function rebaseTextEdit(
  base: string,
  next: string,
  changes: readonly RoomTextSplice[],
): RoomTextSplice[] {
  const edit = roomTextSpliceFor(base, next);
  return edit ? rebaseSplice(edit, changes) : [];
}

/**
 * A splice made against an older value, moved through `changes` (the splices since that value, in order): its index
 * and deleted range follow the text they pointed at, deleting only characters that were there. The insertion point is
 * anchored to the character on its left, as a CRDT position is: what someone else inserted exactly there goes after
 * it, so two people typing at the same spot each keep their run of letters together.
 */
export function rebaseSplice(
  edit: RoomTextSplice,
  changes: readonly RoomTextSplice[],
): RoomTextSplice[] {
  if (edit.deleteCount === 0 && !edit.insert) return [];
  let insertAt = edit.index;
  let ranges: [start: number, end: number][] =
    edit.deleteCount > 0 ? [[edit.index, edit.index + edit.deleteCount]] : [];
  for (const change of changes) {
    const { index: at, deleteCount: removed } = change;
    const shift = change.insert.length - removed;
    // At or before a change it stays (left-anchored); inside a removed stretch it moves to after its replacement.
    insertAt =
      insertAt <= at
        ? insertAt
        : insertAt < at + removed
          ? at + change.insert.length
          : insertAt + shift;
    ranges = ranges.flatMap(([start, end]): [number, number][] => {
      const pieces: [number, number][] = [];
      if (start < at) pieces.push([start, Math.min(end, at)]);
      if (end > at + removed) pieces.push([Math.max(start, at + removed) + shift, end + shift]);
      return pieces.filter(([from, to]) => to > from);
    });
  }
  // Deletions last-first keep earlier indices valid; the insertion point is at or before every remaining deletion.
  const splices: RoomTextSplice[] = ranges
    .toSorted((left, right) => right[0] - left[0])
    .map(([start, end]) => ({ index: start, deleteCount: end - start, insert: "" }));
  if (edit.insert) splices.push({ index: insertAt, deleteCount: 0, insert: edit.insert });
  return splices;
}
