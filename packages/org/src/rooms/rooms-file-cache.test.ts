import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { RoomFileCache, RoomFileError } from "./rooms-file-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-files-"));
  dirs.push(dir);
  return dir;
}

function refOf(data: Uint8Array, contentType = "application/octet-stream") {
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
    contentType,
  };
}

/** A cache whose clock the test moves, so use order is exact. */
function cacheWith(capBytes: number) {
  let clock = Date.parse("2026-11-13T08:00:00Z");
  const cache = new RoomFileCache(path.join(tempDir(), "files"), capBytes, () => clock);
  return {
    cache,
    tick: () => {
      clock += 60_000;
    },
  };
}

const bytes = (fill: number, length: number) => new Uint8Array(length).fill(fill);
const leftovers = (cache: RoomFileCache) =>
  fs.readdirSync(cache.directory).filter((name) => name.endsWith(".tmp"));

describe("RoomFileCache", () => {
  it("evicts the least recently used files past the cap, and a lookup counts as use", async () => {
    const { cache, tick } = cacheWith(300);
    const a = bytes(1, 100);
    const b = bytes(2, 100);
    const c = bytes(3, 100);
    await cache.putBytes(refOf(a), a);
    tick();
    await cache.putBytes(refOf(b), b);
    tick();
    await cache.putBytes(refOf(c), c);
    tick();
    expect(cache.lookup(refOf(a).sha256)).toBeDefined();
    tick();

    const d = bytes(4, 100);
    await cache.putBytes(refOf(d), d);

    expect(cache.lookup(refOf(b).sha256)).toBeUndefined();
    for (const kept of [a, c, d]) expect(cache.lookup(refOf(kept).sha256)).toBeDefined();
  });

  it("never evicts the file just added, even when it alone is over the cap", async () => {
    const { cache, tick } = cacheWith(150);
    const small = bytes(1, 100);
    await cache.putBytes(refOf(small), small);
    tick();
    const big = bytes(2, 200);
    const stored = await cache.putBytes(refOf(big), big);
    expect(fs.existsSync(stored)).toBe(true);
    expect(cache.lookup(refOf(small).sha256)).toBeUndefined();
  });

  it("refuses content whose hash does not match, and keeps nothing of it", async () => {
    const { cache } = cacheWith(1_000_000);
    const data = bytes(7, 1000);
    const wrong = { ...refOf(data), sha256: "0".repeat(64) };
    await expect(cache.putBytes(wrong, data)).rejects.toMatchObject({ code: "mismatch" });
    expect(cache.lookup(wrong.sha256)).toBeUndefined();
    expect(leftovers(cache)).toEqual([]);
  });

  it("refuses short and long content, stopping a long download before it ends", async () => {
    const { cache } = cacheWith(1_000_000);
    const data = bytes(9, 1000);
    const ref = refOf(data);
    await expect(cache.putBytes(ref, data.subarray(0, 999))).rejects.toBeInstanceOf(RoomFileError);

    let pulled = 0;
    const endless = Readable.from(
      (function* () {
        for (;;) {
          pulled += 1;
          yield bytes(9, 400);
        }
      })(),
    );
    await expect(cache.putStream(ref, endless)).rejects.toMatchObject({ code: "mismatch" });
    expect(pulled).toBeLessThan(10);
    expect(cache.lookup(ref.sha256)).toBeUndefined();
    expect(leftovers(cache)).toEqual([]);
  });

  it("drops a cached copy of the wrong size on lookup", async () => {
    const { cache } = cacheWith(1_000_000);
    const data = bytes(5, 1000);
    const ref = refOf(data);
    const stored = await cache.putBytes(ref, data);
    fs.truncateSync(stored, 10);
    expect(cache.lookup(ref.sha256, ref.bytes)).toBeUndefined();
    expect(fs.existsSync(stored)).toBe(false);
  });

  it("copies a local file in by streaming, deduplicated by content", async () => {
    const { cache } = cacheWith(10_000_000);
    const source = path.join(tempDir(), "clip.bin");
    const data = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);
    fs.writeFileSync(source, data);
    const first = await cache.putFile(source, "video/mp4");
    const second = await cache.putFile(source, "video/mp4");
    expect(first).toEqual(refOf(data, "video/mp4"));
    expect(second).toEqual(first);
    expect(fs.readdirSync(cache.directory)).toEqual([first.sha256]);
  });
});
