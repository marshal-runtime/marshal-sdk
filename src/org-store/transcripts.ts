import { randomUUID } from "node:crypto";

import { PreconditionFailedError, type ObjectStore } from "../object-store.js";
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
  /** Per Marshal session: batches the SDK handed over that have not reached the store yet, uploaded in the background in order. */
  private readonly queues = new Map<string, { items: Array<{ object: string; body: string }>; running: Promise<void> | null }>();

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

  /**
   * The Agent SDK awaits `append` before it hands a turn's result over, so a store that writes to the cloud inside `append` puts a cloud round trip
   * (and its retries) into every turn. Here `append` only queues the batch; it is uploaded right after, off the turn, in order.
   */
  enqueue(marshalSessionId: string, object: string, body: string): void {
    const queue = this.queues.get(marshalSessionId) ?? { items: [], running: null };
    this.queues.set(marshalSessionId, queue);
    queue.items.push({ object, body });
    if (!queue.running) queue.running = this.upload(marshalSessionId, queue);
  }

  private async upload(marshalSessionId: string, queue: { items: Array<{ object: string; body: string }>; running: Promise<void> | null }): Promise<void> {
    await Promise.resolve();
    try {
      while (queue.items.length > 0) {
        const item = queue.items[0]!;
        try {
          await this.options.objects.put(item.object, item.body, { contentType: "application/x-ndjson", ifGenerationMatch: 0 });
        } catch (error) {
          if (error instanceof PreconditionFailedError) {
            queue.items.shift(); // the object is already there (a retry whose first answer was lost)
            continue;
          }
          this.options.log?.("org-store.batch_upload_failed", { sessionId: marshalSessionId, error: error instanceof Error ? error.message : String(error) });
          return; // kept in order at the head; the next drain (compose, close) tries again
        }
        queue.items.shift();
      }
    } finally {
      queue.running = null;
    }
  }

  /** Waits until every batch queued so far for the session is in the store; a batch that failed is tried once more. */
  async drain(marshalSessionId: string): Promise<void> {
    const queue = this.queues.get(marshalSessionId);
    if (!queue) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!queue.running && queue.items.length > 0) queue.running = this.upload(marshalSessionId, queue);
      await queue.running;
      if (queue.items.length === 0) break;
    }
    if (queue.items.length === 0) this.queues.delete(marshalSessionId);
  }

  async drainAll(): Promise<void> {
    await Promise.all([...this.queues.keys()].map((id) => this.drain(id)));
  }

  /** Folds every member's batches of one Marshal session into its composed file. Safe to repeat and to interrupt. */
  async compose(marshalSessionId: string): Promise<void> {
    await this.drain(marshalSessionId);
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
    this.owner.enqueue(this.marshalSessionId, object, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  async load(key: Key): Promise<Entry[] | null> {
    if (await this.options.isCurrent?.(key.sessionId)) return null;
    await this.owner.drain(this.marshalSessionId);
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
