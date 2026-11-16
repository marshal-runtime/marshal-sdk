import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CloudCache } from "../src/cache";
import { fakeBucket } from "./fake-gcs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "viewer-cache-"));
const put = (cache: CloudCache, run: string, rel: string, size: number, ageMs: number) => {
  const file = cache.write("host", run, rel, Buffer.alloc(size, 1));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
};

test("evict deletes the least recently used files first until the cache is under its cap, and never the files in use", () => {
  const dir = tmp();
  const cache = new CloudCache(dir, 250);
  const oldest = put(cache, "r1", "a.bin", 100, 3000);
  const middle = put(cache, "r1", "b.bin", 100, 2000);
  const newest = put(cache, "r2", "c.bin", 100, 1000);
  const result = cache.evict();
  assert.deepEqual(result, { removed: 1, freed: 100 });
  assert.deepEqual([fs.existsSync(oldest), fs.existsSync(middle), fs.existsSync(newest)], [false, true, true]);
  // The file being opened is protected even when it is the oldest.
  const open = put(cache, "r3", "d.bin", 100, 9000);
  cache.evict(new Set([open]));
  assert.equal(fs.existsSync(open), true);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(cache.stats().bytes <= 250 || fs.existsSync(open), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reading a file through the cache counts as using it", async () => {
  const { gcs, dir } = fakeBucket();
  fs.mkdirSync(path.join(gcs, "b", "run"), { recursive: true });
  fs.writeFileSync(path.join(gcs, "b", "run", "x.bin"), Buffer.alloc(40, 2));
  const cache = new CloudCache(path.join(dir, "cache"), 1000);
  const first = await cache.fetchAll("host", "run", [{ uri: "gs://b/run/x.bin", rel: "x.bin", bytes: 40 }]);
  assert.deepEqual([first.transfer.downloaded, first.transfer.cached], [40, 0]);
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(first.files[0]!, old, old);
  const second = await cache.fetchAll("host", "run", [{ uri: "gs://b/run/x.bin", rel: "x.bin", bytes: 40 }]);
  assert.deepEqual([second.transfer.downloaded, second.transfer.cached], [0, 40]);
  assert.ok(Date.now() - fs.statSync(first.files[0]!).mtimeMs < 60_000);
  // A file whose size changed is fetched again.
  fs.writeFileSync(first.files[0]!, "short");
  const third = await cache.fetchAll("host", "run", [{ uri: "gs://b/run/x.bin", rel: "x.bin", bytes: 40 }]);
  assert.equal(third.transfer.downloaded, 40);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a restricted run's folder is wiped on sign-out, other runs stay", () => {
  const dir = tmp();
  const cache = new CloudCache(dir);
  put(cache, "open-run", "p.json", 10, 0);
  put(cache, "secret-run", "p.json", 10, 0);
  cache.markRestricted("host", "secret-run");
  assert.equal(cache.clearRestricted(), 1);
  assert.equal(fs.existsSync(cache.fileOf("host", "secret-run", "p.json")), false);
  assert.equal(fs.existsSync(cache.fileOf("host", "open-run", "p.json")), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("paths from a manifest cannot leave the cache folder", () => {
  const cache = new CloudCache("/tmp/c");
  assert.equal(cache.fileOf("h", "r", "../../etc/passwd").startsWith(cache.runDir("h", "r")), true);
});
