// Lifted from OmerMachluf/marshal electron/org/rooms/rooms-file-cache.ts at c75500b1b (copied, not imported); adapted for the SDK (no Electron, local logger, node:fs).
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { RoomFileRef } from "@marshal/agent-runtime-org";
import { z } from "zod";


export const ROOM_FILE_CACHE_CAP_BYTES = 5 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const fileRefSchema = z.object({
  sha256: z.string().regex(SHA256_PATTERN),
  bytes: z.number().int().min(0),
  contentType: z.string().min(1).max(256),
});

export function parseRoomFileRef(value: unknown): RoomFileRef | undefined {
  const parsed = fileRefSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export type RoomFileErrorCode =
  | "too-large"
  | "not-a-file"
  | "mismatch"
  | "upload-failed"
  | "unavailable";

/** A room file operation that failed; `code` is what callers branch on. */
export class RoomFileError extends Error {
  constructor(
    readonly code: RoomFileErrorCode,
    message?: string,
  ) {
    super(message ?? `room file: ${code}`);
    this.name = "RoomFileError";
  }
}

/** Counts and hashes what passes through; with `limit`, fails with `mismatch` past that many bytes. */
class Measure extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;
  constructor(private readonly limit?: number) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    if (this.limit !== undefined && this.bytes > this.limit) {
      done(new RoomFileError("mismatch", "more bytes than the reference announces"));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }
}

/**
 * Room file contents by SHA-256 under one directory (`~/.marshal/org-rooms/files`), shared by every room
 * and organization. Use is recorded in the file's modification time; past the cap the least recently
 * used files go first. Content enters only after its size and SHA-256 match the reference.
 */
export class RoomFileCache {
  constructor(
    readonly directory: string,
    private readonly capBytes: number = ROOM_FILE_CACHE_CAP_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  private ensureDir(): void {
    if (!fs.existsSync(this.directory)) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private tempIn(): string {
    return path.join(this.directory, `incoming.${process.pid}.${randomUUID()}.tmp`);
  }

  pathOf(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new TypeError("sha256 must be lowercase hex");
    return path.join(this.directory, sha256);
  }

  /**
   * The cached path, marked as used; undefined when not cached. With `bytes`, a cached file of another
   * size (cut short by a crash or a full disk) is removed and reported as not cached.
   */
  lookup(sha256: string, bytes?: number): string | undefined {
    const file = this.pathOf(sha256);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return undefined;
    }
    if (bytes !== undefined && size !== bytes) {
      fs.rmSync(file, { force: true });
      return undefined;
    }
    const at = new Date(this.now());
    fs.utimesSync(file, at, at);
    return file;
  }

  /** Copies a local file into the cache, hashing it as it streams, and returns its reference. */
  async putFile(source: string, contentType: string): Promise<RoomFileRef> {
    this.ensureDir();
    const temp = this.tempIn();
    const measure = new Measure();
    try {
      await pipeline(
        fs.createReadStream(source),
        measure,
        fs.createWriteStream(temp, { mode: 0o600 }),
      );
      const sha256 = measure.hash.digest("hex");
      if (!this.lookup(sha256, measure.bytes)) fs.renameSync(temp, this.pathOf(sha256));
      this.lookup(sha256);
      this.evict(sha256);
      return { sha256, bytes: measure.bytes, contentType };
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  /**
   * Streams downloaded content into the cache. It enters only when its size and SHA-256 match `ref`;
   * anything else is discarded with `mismatch`, and more bytes than announced stop the download early.
   */
  async putStream(ref: RoomFileRef, body: AsyncIterable<Uint8Array>): Promise<string> {
    this.ensureDir();
    const target = this.pathOf(ref.sha256);
    const temp = this.tempIn();
    const measure = new Measure(ref.bytes);
    try {
      await pipeline(Readable.from(body), measure, fs.createWriteStream(temp, { mode: 0o600 }));
      if (measure.bytes !== ref.bytes || measure.hash.digest("hex") !== ref.sha256)
        throw new RoomFileError("mismatch", "downloaded file does not match its reference");
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    this.lookup(ref.sha256);
    this.evict(ref.sha256);
    return target;
  }

  /** Stores bytes already in memory, under the same checks as `putStream`. */
  async putBytes(ref: RoomFileRef, data: Uint8Array): Promise<string> {
    return this.putStream(ref, Readable.from([data]));
  }

  /** Deletes the least recently used files until the total is under the cap; `keep` is never removed. */
  evict(keep?: string): void {
    if (!fs.existsSync(this.directory)) return;
    const entries = fs
      .readdirSync(this.directory)
      .filter((name) => SHA256_PATTERN.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(this.directory, name));
        return { name, size: stat.size, used: stat.mtimeMs };
      })
      .sort((a, b) => a.used - b.used);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.capBytes) break;
      if (entry.name === keep) continue;
      fs.rmSync(path.join(this.directory, entry.name), { force: true });
      total -= entry.size;
    }
  }
}
