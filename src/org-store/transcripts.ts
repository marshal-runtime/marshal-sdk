import { randomUUID } from "node:crypto";

import type { ObjectStore } from "../object-store.js";
import type { BackendTranscriptStore } from "../session-store.js";

type Entry = { type: string; uuid?: string; [k: string]: unknown };
type Key = { projectKey: string; sessionId: string; subpath?: string };

const MAX_COMPOSE = 32;
const MEMBER_FILE = ".jsonl";

export interface OrgTranscriptOptions {
  objects: ObjectStore;
  /** The directory a Marshal session's objects live in (`sdk/v1/<ws>/<impl>/<partition>/<day>/<root>`), or undefined while it has none. */
  locate(sessionId: string): string | undefined;
  /**
   * Whether the machine that will run the next turn already holds this native session's transcript. True makes `load` answer null,
   * which the Agent SDK takes as "nothing to restore" and skips reading the whole transcript and building a temporary config folder.
   * A warm machine therefore resumes with no cloud read. Absent: every resume loads.
   */
  isCurrent?(nativeSessionId: string): boolean | Promise<boolean>;
  /** Finds the directory of the Marshal session that holds a native session another Marshal session started (a fork's source). */
  lookup?(nativeSessionId: string): Promise<string | undefined>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The Claude Agent SDK's `sessionStore` on GCS (or any `ObjectStore`), straight, with no database. The SDK mirrors transcript batches here
 * while a turn runs: each batch is one create-only object under `native/_batches/`, so no object is ever written twice and nothing is
 * shared between writers. `compose` (the host calls it after a session goes idle, off the turn) folds the batches into one
 * `native/<member>.jsonl` with server-side compose. `load` reads the composed file plus any batches after it.
 *
 * A store is bound to one Marshal session (`bind`), because the SDK's keys name the native session and the objects live in the Marshal
 * session's directory.
 */
export class OrgTranscriptStore implements BackendTranscriptStore {
  private counter = 0;

  constructor(private readonly options: OrgTranscriptOptions) {}

  append(): Promise<never> {
    return Promise.reject(new Error("OrgTranscriptStore is used through bind(marshalSessionId)."));
  }

  load(): Promise<never> {
    return Promise.reject(new Error("OrgTranscriptStore is used through bind(marshalSessionId)."));
  }

  bind(marshalSessionId: string): BackendTranscriptStore {
    return new BoundTranscripts(this, this.options, marshalSessionId);
  }

  /** Folds every member's batches of one Marshal session into its composed file. Safe to repeat and to interrupt. */
  async compose(marshalSessionId: string): Promise<void> {
    const dir = this.options.locate(marshalSessionId);
    if (!dir) return;
    const objects = this.options.objects;
    const batches = await objects.list(`${dir}/native/_batches/`);
    const members = new Set(batches.map((name) => name.slice(`${dir}/native/_batches/`.length).split("/")[0]!));
    for (const encoded of members) {
      const member = decodeURIComponent(encoded);
      const composed = `${dir}/native/${member}${MEMBER_FILE}`;
      for (;;) {
        const pending = (await objects.list(`${dir}/native/_batches/${encoded}/`)).sort();
        if (pending.length === 0) break;
        const chunk = pending.slice(0, MAX_COMPOSE - 1);
        const existing = (await objects.listInfo(composed)).find((info) => info.name === composed);
        await objects.compose(existing ? [composed, ...chunk] : chunk, composed, { ifGenerationMatch: existing ? existing.generation : 0, contentType: "application/x-ndjson" });
        for (const name of chunk) await objects.delete(name);
      }
    }
  }

  nextBatchName(): string {
    this.counter = (this.counter + 1) % 1_000_000;
    return `${Date.now().toString().padStart(15, "0")}-${this.counter.toString().padStart(6, "0")}-${randomUUID()}.jsonl`;
  }
}

class BoundTranscripts implements BackendTranscriptStore {
  constructor(
    private readonly owner: OrgTranscriptStore,
    private readonly options: OrgTranscriptOptions,
    private readonly marshalSessionId: string,
  ) {}

  private dir(): string {
    const dir = this.options.locate(this.marshalSessionId);
    if (!dir) throw new Error(`Session ${this.marshalSessionId} has no org store directory (its labels do not satisfy the implementation's partition).`);
    return dir;
  }

  private member(key: { sessionId: string; subpath?: string }): string {
    return key.subpath ? `${key.sessionId}/${key.subpath}` : key.sessionId;
  }

  async append(key: Key, entries: Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const member = encodeURIComponent(this.member(key));
    const object = `${this.dir()}/native/_batches/${member}/${this.owner.nextBatchName()}`;
    await this.options.objects.put(object, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { contentType: "application/x-ndjson", ifGenerationMatch: 0 });
  }

  async load(key: Key): Promise<Entry[] | null> {
    if (await this.options.isCurrent?.(key.sessionId)) return null;
    const member = this.member(key);
    let dir = this.dir();
    let found = await this.read(dir, member);
    if (!found && this.options.lookup) {
      const elsewhere = await this.options.lookup(key.sessionId);
      if (elsewhere) {
        dir = elsewhere;
        found = await this.read(dir, member);
      }
    }
    return found;
  }

  private async read(dir: string, member: string): Promise<Entry[] | null> {
    const objects = this.options.objects;
    const parts: string[] = [];
    const composed = await objects.get(`${dir}/native/${member}${MEMBER_FILE}`);
    if (composed) parts.push(Buffer.from(composed).toString("utf8"));
    const batches = (await objects.list(`${dir}/native/_batches/${encodeURIComponent(member)}/`)).sort();
    for (const name of batches) {
      const bytes = await objects.get(name);
      if (bytes) parts.push(Buffer.from(bytes).toString("utf8"));
    }
    if (parts.length === 0) return null;
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const line of parts.join("").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as Entry;
      if (entry.uuid) {
        if (seen.has(entry.uuid)) continue;
        seen.add(entry.uuid);
      }
      entries.push(entry);
    }
    return entries;
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const dir = this.dir();
    const subkeys = new Set<string>();
    const composedPrefix = `${dir}/native/${key.sessionId}/`;
    for (const name of await this.options.objects.list(composedPrefix)) if (name.endsWith(MEMBER_FILE)) subkeys.add(name.slice(composedPrefix.length, -MEMBER_FILE.length));
    const batchPrefix = `${dir}/native/_batches/${encodeURIComponent(`${key.sessionId}/`)}`;
    for (const name of await this.options.objects.list(batchPrefix)) subkeys.add(decodeURIComponent(name.slice(`${dir}/native/_batches/`.length).split("/")[0]!).slice(key.sessionId.length + 1));
    return [...subkeys].sort();
  }

  async delete(key: Key): Promise<void> {
    const dir = this.dir();
    const objects = this.options.objects;
    const member = this.member(key);
    for (const name of await objects.list(`${dir}/native/_batches/${encodeURIComponent(member)}/`)) await objects.delete(name);
    await objects.delete(`${dir}/native/${member}${MEMBER_FILE}`);
    if (key.subpath === undefined) {
      for (const name of await objects.list(`${dir}/native/${key.sessionId}/`)) await objects.delete(name);
      for (const name of await objects.list(`${dir}/native/_batches/${encodeURIComponent(`${key.sessionId}/`)}`)) await objects.delete(name);
    }
  }
}
