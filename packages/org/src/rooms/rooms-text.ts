import {
  BUILT_IN_ROOM_SCHEMAS,
  RoomTextReplica,
  createRoomTextReset,
  isRoomTextReset,
  mergeRoomTextState,
  rebaseRoomTextUpdates,
  roomTextNeedsCompaction,
  roomTextSpliceFor,
  type RoomActor,
  type RoomChange,
  type RoomKindSchema,
  type RoomRecordKey,
  type RoomTextSplice,
  type RoomTextState,
  type RoomTextUpdate,
} from "@marshal/agent-runtime-org";

import { createLogger } from "../../host-deps";
import type { OutboxEntry, RoomsReplica } from "./rooms-replica";
import { rebaseSplice, rebaseTextEdit } from "./rooms-text-base";

const log = createLogger("OrgRoomsText");
const HISTORY_PAGE = 1000;
/** Versions a field remembers for whole-value writes made against an older value, and the bytes they may hold. */
const MAX_VERSIONS = 200;
const MAX_VERSION_BYTES = 4 * 1024 * 1024;
/** Version tokens of this process: a token from before a restart never resolves to a wrong value. */
const VERSION_PREFIX = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.`;
let versionCounter = 0;
/**
 * How far back a whole-value write with no base looks for the value its writer started from: a screen paints a remote
 * change some milliseconds after it arrives here, so its next keystroke can be built on a value a few versions old.
 * Short, so a person who deliberately deletes a remote insertion they can see is not mistaken for one who never saw it.
 */
const GUESS_WINDOW_MS = 1000;

/**
 * A field's value as handed to a caller: `version` is the token to pass back as a base, `order` grows with every value
 * any field takes in this process, so of two readings of one field the higher order is the newer (answers and room
 * events reach a screen by different paths and can arrive in either order).
 */
export type TextReading = {
  value: string;
  version: string;
  order: number;
};

/** One value a field had: the token callers get with it, and the splices that led to it from the previous one. */
interface TextVersion {
  id: string;
  order: number;
  value: string;
  splices: readonly RoomTextSplice[];
  at: number;
  /** A value this desktop's own edit made (or the first one read): a writer here had seen at least this much. */
  local: boolean;
}

/** UTF-16 units a whole-value write would change if `from` were what its writer started from. */
function editSize(from: string, next: string): number {
  const edit = roomTextSpliceFor(from, next);
  return edit ? edit.deleteCount + edit.insert.length : 0;
}

/** The `text` fields of a record type: built-in types use the contract's schema, as `checkRoomWrite` does. */
export function textFieldsOf(schema: RoomKindSchema | undefined, type: string): Set<string> {
  const builtIn: Record<string, { fields: Record<string, string> }> = BUILT_IN_ROOM_SCHEMAS;
  const fields = builtIn[type]?.fields ?? schema?.records[type]?.fields ?? {};
  return new Set(
    Object.entries(fields).flatMap(([name, fieldType]) => (fieldType === "text" ? [name] : [])),
  );
}

/** A text change this layer wants sent on its own: a rebased edit or a compaction. */
export interface TextSend {
  room: string;
  record: RoomRecordKey;
  type: string;
  field: string;
  update: RoomTextUpdate;
  ifSeq?: number;
  actor: RoomActor;
  author: `user:${string}`;
}

interface LiveText {
  room: string;
  replica: RoomTextReplica;
  /** The ordered state last seen (without this desktop's unordered edits). */
  confirmed: Pick<RoomTextState, "gen" | "state"> | undefined;
  /** Recent values, oldest first; the last is the current one. */
  versions: TextVersion[];
  versionBytes: number;
}

const EMPTY_STATE = createRoomTextReset("");

/**
 * Live `text` fields on this desktop. Each open field is a RoomTextReplica built from the replica's ordered state plus
 * this desktop's unordered edits (the outbox), so pending typing survives a restart and a new epoch. Remote updates of
 * the field's generation merge in place (subscribers get exact splices); anything else (a compaction reset, a new
 * epoch, a refusal) rebuilds from the replica, rebasing this desktop's edits made against an older generation.
 */
export class RoomTexts {
  private readonly live = new Map<string, LiveText>();

  constructor(
    private readonly replica: RoomsReplica,
    private readonly send: (sends: readonly TextSend[]) => void,
  ) {}

  private static id(room: string, record: string, field: string): string {
    return `${room}\n${record}\n${field}`;
  }

  private confirmedOf(
    room: string,
    record: string,
    field: string,
  ): Pick<RoomTextState, "gen" | "state"> | undefined {
    const text = this.replica.confirmed(room, record)?.texts?.[field];
    return text ? { gen: text.gen, state: text.state } : undefined;
  }

  /** This desktop's unordered edits of one field, oldest first. */
  private ownEdits(
    room: string,
    record: string,
    field: string,
  ): { entry: OutboxEntry; update: { gen: number; update: string } }[] {
    return this.replica.pending(room).flatMap((entry) => {
      const update = entry.record === record ? entry.text?.[field] : undefined;
      return update && !isRoomTextReset(update) ? [{ entry, update }] : [];
    });
  }

  private hasPendingReset(room: string, record: string, field: string): boolean {
    return this.replica.pending(room).some((entry) => {
      const update = entry.record === record ? entry.text?.[field] : undefined;
      return update !== undefined && isRoomTextReset(update);
    });
  }

  /** The live replica of one field, built on first use (rebasing edits a restart left on an older generation). */
  get(room: string, record: RoomRecordKey, field: string): RoomTextReplica {
    const id = RoomTexts.id(room, record, field);
    const existing = this.live.get(id);
    if (existing) return existing.replica;
    const live: LiveText = {
      room,
      replica: new RoomTextReplica({ record, field }),
      confirmed: undefined,
      versions: [],
      versionBytes: 0,
    };
    this.live.set(id, live);
    this.resync(live);
    this.remember(live, live.replica.value(), [], true);
    live.replica.subscribe((event) =>
      this.remember(live, event.value, event.splices, event.origin === "local"),
    );
    return live.replica;
  }

  private remember(
    live: LiveText,
    value: string,
    splices: readonly RoomTextSplice[],
    local: boolean,
  ): void {
    versionCounter += 1;
    live.versions.push({
      id: `${VERSION_PREFIX}${versionCounter}`,
      order: versionCounter,
      value,
      splices,
      at: Date.now(),
      local,
    });
    live.versionBytes += value.length * 2;
    while (
      live.versions.length > 1 &&
      (live.versions.length > MAX_VERSIONS || live.versionBytes > MAX_VERSION_BYTES)
    ) {
      const dropped = live.versions.shift();
      live.versionBytes -= (dropped?.value.length ?? 0) * 2;
    }
  }

  /** Like read, but only for a field already open as live text (undefined otherwise; never opens one). */
  peek(room: string, record: RoomRecordKey, field: string): TextReading | undefined {
    const current = this.live.get(RoomTexts.id(room, record, field))?.versions.at(-1);
    return current && { value: current.value, version: current.id, order: current.order };
  }

  /** The current value of a field and its version token (what a caller passes back as the base of a whole-value write). */
  read(room: string, record: RoomRecordKey, field: string): TextReading {
    this.get(room, record, field);
    const live = this.live.get(RoomTexts.id(room, record, field));
    const current = live?.versions.at(-1);
    if (!current) throw new Error("live text has no version");
    return { value: current.value, version: current.id, order: current.order };
  }

  /**
   * A whole new value written against an older one: the splices that apply only the writer's own edit (base to next)
   * onto the current text, keeping whatever others typed since. Undefined when `base` is not a version this field still
   * remembers (unknown, too old, or from before a restart); the caller then falls back to the plain smallest edit.
   */
  editFromBase(
    room: string,
    record: RoomRecordKey,
    field: string,
    base: string,
    next: string,
  ): RoomTextSplice[] | undefined {
    const since = this.since(room, record, field, base);
    return since && rebaseTextEdit(since.value, next, since.changes);
  }

  /**
   * A splice whose index and deleteCount refer to the value `base` (what the caller's screen showed), moved onto the
   * current text: through others' changes and this desktop's own edits since. Undefined when `base` is not a version
   * this field still remembers; throws a RangeError when the splice does not fit the base value.
   */
  spliceFromBase(
    room: string,
    record: RoomRecordKey,
    field: string,
    base: string,
    splice: RoomTextSplice,
  ): RoomTextSplice[] | undefined {
    const since = this.since(room, record, field, base);
    if (!since) return undefined;
    if (splice.index + splice.deleteCount > since.value.length)
      throw new RangeError("splice outside the base value");
    return rebaseSplice(splice, since.changes);
  }

  /** The value a version token stands for and the splices from it to the current text, if this field remembers it. */
  private since(
    room: string,
    record: RoomRecordKey,
    field: string,
    base: string,
  ): { value: string; changes: RoomTextSplice[] } | undefined {
    this.get(room, record, field);
    const versions = this.live.get(RoomTexts.id(room, record, field))?.versions ?? [];
    const at = versions.findIndex((version) => version.id === base);
    const from = versions[at];
    if (!from) return undefined;
    return {
      value: from.value,
      changes: versions.slice(at + 1).flatMap((version) => version.splices),
    };
  }

  /**
   * The base of a whole-value write that named none: of the values this field had in the last GUESS_WINDOW_MS, no
   * older than this desktop's own last edit of it (its writer built on that), and the current one, the one `next` is
   * the smallest edit from, newest on a tie. A writer that had not painted a remote insertion yet started from the
   * value before it; one that had, from the value after it. Undefined when that is the current value (the plain
   * smallest edit is then the same thing).
   */
  guessBase(room: string, record: RoomRecordKey, field: string, next: string): string | undefined {
    this.get(room, record, field);
    const versions = this.live.get(RoomTexts.id(room, record, field))?.versions ?? [];
    const current = versions.at(-1);
    if (!current) return undefined;
    const since = Date.now() - GUESS_WINDOW_MS;
    let best = current;
    let bestSize = editSize(current.value, next);
    for (
      let index = versions.length - 2;
      index >= 0 && bestSize > 0 && !current.local;
      index -= 1
    ) {
      const version = versions[index];
      if (!version || version.at < since) break;
      const size = editSize(version.value, next);
      if (size < bestSize) {
        best = version;
        bestSize = size;
      }
      if (version.local) break;
    }
    return best === current ? undefined : best.id;
  }

  /**
   * Opens a live text for every field with unsent edits of mine, so edits a compaction or a new epoch left on an older
   * generation are rebased now, before their acknowledgement takes them out of the outbox.
   */
  private adoptPending(room: string): void {
    for (const entry of this.replica.pending(room))
      for (const field of Object.keys(entry.text ?? {})) this.get(room, entry.record, field);
  }

  /** Ordered changes arrived (others', or acknowledgements of this desktop's own). */
  onChanges(room: string, changes: readonly RoomChange[], own: boolean): void {
    if (changes.some((change) => Object.values(change.text ?? {}).some(isRoomTextReset)))
      this.adoptPending(room);
    const touched = new Map<string, { live: LiveText; updates: RoomTextUpdate[] }>();
    const acked = new Map<string, RoomChange>();
    for (const change of changes) {
      for (const [field, update] of Object.entries(change.text ?? {})) {
        const id = RoomTexts.id(room, change.record, field);
        const live = this.live.get(id);
        if (live) {
          const entry = touched.get(id) ?? { live, updates: [] };
          entry.updates.push(update);
          touched.set(id, entry);
        }
        if (own) acked.set(`${change.record}\n${field}`, change);
      }
    }
    for (const { live, updates } of touched.values()) {
      const confirmed = this.confirmedOf(room, live.replica.record, live.replica.field);
      const inPlace =
        confirmed?.gen === live.replica.gen &&
        updates.every((update) => !isRoomTextReset(update) && update.gen === live.replica.gen);
      if (!inPlace) {
        this.resync(live);
        continue;
      }
      // Own edits are in the live text already.
      if (!own) for (const update of updates) live.replica.receive(update);
      live.confirmed = confirmed;
    }
    const compactions = [...acked].flatMap(([key, change]) => {
      const compaction = this.compaction(room, change, key.slice(key.indexOf("\n") + 1));
      return compaction ? [compaction] : [];
    });
    if (compactions.length) this.send(compactions);
  }

  /**
   * After this desktop's own text change is ordered: when the field's state has grown past the compaction rule, a reset
   * of the same text at the next generation, sent with `ifSeq` so it lands only if nobody changed the record since.
   */
  private compaction(room: string, change: RoomChange, field: string): TextSend | undefined {
    const record = this.replica.confirmed(room, change.record);
    const text = record?.texts?.[field];
    const value = record?.fields[field];
    if (!record || !text || typeof value !== "string") return undefined;
    if (!roomTextNeedsCompaction(text, value)) return undefined;
    if (this.ownEdits(room, change.record, field).length) return undefined;
    if (this.hasPendingReset(room, change.record, field)) return undefined;
    return {
      room,
      record: change.record,
      type: change.type,
      field,
      update: { gen: text.gen + 1, reset: createRoomTextReset(value) },
      ifSeq: record.updatedSeq,
      actor: change.actor,
      author: change.author,
    };
  }

  /** One of this desktop's changes was refused: its record's fields go back to the replica's view. */
  onRefused(room: string, record: string): void {
    for (const live of [...this.live.values()])
      if (live.room === room && live.replica.record === record) this.resync(live);
  }

  /** A new epoch: every live field of the room is rebuilt from the durable state plus the outbox. */
  onReset(room: string): void {
    for (const live of [...this.live.values()]) if (live.room === room) this.resync(live);
    this.adoptPending(room);
  }

  /**
   * The ordered state a generation ended with: its reset (or nothing, for generation 0) plus every update of it in the
   * record's history, merged with what this desktop last saw of it. Edits made against that generation replay on it.
   */
  private generationState(live: LiveText, gen: number): string | undefined {
    const { record, field } = live.replica;
    const updates: string[] = [];
    let after = 0;
    for (;;) {
      const page = this.replica.history(live.room, {
        key: record,
        afterSeq: after,
        limit: HISTORY_PAGE,
      });
      for (const change of page) {
        const update = change.text?.[field];
        if (update?.gen !== gen) continue;
        updates.push(isRoomTextReset(update) ? update.reset : update.update);
      }
      const last = page.at(-1);
      if (page.length < HISTORY_PAGE || !last) break;
      after = last.seq;
    }
    const seen = live.confirmed?.gen === gen ? live.confirmed.state : undefined;
    return mergeRoomTextState(seen, updates)?.state ?? seen;
  }

  private resync(live: LiveText): void {
    const { record, field } = live.replica;
    const confirmed = this.confirmedOf(live.room, record, field);
    const gen = confirmed?.gen ?? 0;
    const own = this.ownEdits(live.room, record, field);
    const local = own.filter(({ update }) => update.gen === gen).map(({ update }) => update.update);
    const stale = own.filter(({ update }) => update.gen < gen);
    const first = stale[0];
    if (first && confirmed) {
      // A compaction landed over edits of mine that every replica will ignore (older generation): replay them on it.
      // Edits of a generation older than the first one left are dropped (two compactions while offline).
      const group = stale.filter(({ update }) => update.gen === first.update.gen);
      const rebased = rebaseRoomTextUpdates({
        previous: this.generationState(live, first.update.gen),
        reset: confirmed.state,
        updates: group.map(({ update }) => update.update),
      });
      if (group.length < stale.length)
        log.warn(
          "Room text edits two generations behind were dropped:",
          stale.length - group.length,
        );
      for (const { entry } of stale) this.replica.reject(live.room, entry.id);
      const last = group.at(-1)?.entry ?? first.entry;
      if (rebased) {
        local.push(rebased);
        this.send([
          {
            room: live.room,
            record,
            type: last.type,
            field,
            update: { gen, update: rebased },
            actor: last.actor,
            author: last.author,
          },
        ]);
      }
    }
    live.replica.rebuild({ gen, state: confirmed?.state ?? EMPTY_STATE }, local);
    live.confirmed = confirmed;
  }

  close(): void {
    for (const live of this.live.values()) live.replica.destroy();
    this.live.clear();
  }
}
