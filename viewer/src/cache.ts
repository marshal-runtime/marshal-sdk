// The local cache for cloud artifacts: ~/.marshal/cloud-cache/<host>/<run>/<path in the run>. Versions and content-addressed
// pictures never change, so a file that is here is valid forever; only manifests are re-read. A size cap is kept by evicting the
// least recently used files; a restricted run's folder carries a marker and is wiped on sign-out.
import fs from "fs";
import os from "os";
import path from "path";

import { gcsDownload, pool } from "./gcs";

export const DEFAULT_CAP_BYTES = 2 * 1024 ** 3;
const RESTRICTED = ".restricted";

export const defaultCacheRoot = () => process.env.MARSHAL_SDK_CLOUD_CACHE || path.join(os.homedir(), ".marshal", "cloud-cache");

const segment = (value: string) => value.replace(/^gs:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "_";

export interface Transfer {
  /** Bytes fetched from the bucket by this call. */
  downloaded: number;
  /** Bytes served from files already here. */
  cached: number;
  files: number;
}

export class CloudCache {
  readonly dir: string;
  constructor(
    dir: string,
    readonly capBytes: number = DEFAULT_CAP_BYTES,
  ) {
    this.dir = dir;
  }

  /** The folder a run's files live in. */
  runDir(host: string, run: string): string {
    return path.join(this.dir, segment(host), segment(run));
  }

  fileOf(host: string, run: string, rel: string): string {
    const clean = rel.split("/").filter((part) => part && part !== "." && part !== "..");
    return path.join(this.runDir(host, run), ...clean);
  }

  /** Marks a run's folder so sign-out wipes it. */
  markRestricted(host: string, run: string): void {
    fs.mkdirSync(this.runDir(host, run), { recursive: true });
    fs.writeFileSync(path.join(this.runDir(host, run), RESTRICTED), "");
  }

  /**
   * Makes the files present locally: those already here are touched (so they count as recently used), the rest are
   * downloaded four at a time. `bytes` of a file, when known, must match for it to count as present.
   */
  async fetchAll(host: string, run: string, items: { uri: string; rel: string; bytes?: number }[]): Promise<{ files: string[]; transfer: Transfer }> {
    const transfer: Transfer = { downloaded: 0, cached: 0, files: items.length };
    const files = await pool(items, 4, async (item) => {
      const file = this.fileOf(host, run, item.rel);
      try {
        const size = fs.statSync(file).size;
        if (item.bytes === undefined || item.bytes === size) {
          const at = new Date();
          fs.utimesSync(file, at, at);
          transfer.cached += size;
          return file;
        }
      } catch {
        // not here yet
      }
      // Read the size before adding: `+= await` would read the running total first and lose concurrent downloads.
      const size = await gcsDownload(item.uri, file);
      transfer.downloaded += size;
      return file;
    });
    return { files, transfer };
  }

  /** Writes bytes into the cache (a manifest re-read, a materialized folder). */
  write(host: string, run: string, rel: string, data: Buffer | string): string {
    const file = this.fileOf(host, run, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  }

  private files(): { file: string; size: number; at: number }[] {
    const out: { file: string; size: number; at: number }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name !== RESTRICTED) {
          const stat = fs.statSync(full);
          out.push({ file: full, size: stat.size, at: stat.mtimeMs });
        }
      }
    };
    walk(this.dir);
    return out;
  }

  stats(): { bytes: number; files: number; capBytes: number } {
    const all = this.files();
    return { bytes: all.reduce((sum, item) => sum + item.size, 0), files: all.length, capBytes: this.capBytes };
  }

  /** Deletes least recently used files until the cache is under its cap; files in `keep` are never deleted. */
  evict(keep: ReadonlySet<string> = new Set()): { removed: number; freed: number } {
    const all = this.files();
    let total = all.reduce((sum, item) => sum + item.size, 0);
    let removed = 0;
    let freed = 0;
    for (const item of all.sort((left, right) => left.at - right.at)) {
      if (total <= this.capBytes) break;
      if (keep.has(item.file)) continue;
      fs.rmSync(item.file, { force: true });
      total -= item.size;
      freed += item.size;
      removed += 1;
    }
    this.prune();
    return { removed, freed };
  }

  /** Wipes every run folder marked restricted (what sign-out does). */
  clearRestricted(): number {
    let cleared = 0;
    for (const host of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      const hostDir = path.join(this.dir, host);
      if (!fs.statSync(hostDir).isDirectory()) continue;
      for (const run of fs.readdirSync(hostDir)) {
        const runDir = path.join(hostDir, run);
        if (fs.existsSync(path.join(runDir, RESTRICTED))) {
          fs.rmSync(runDir, { recursive: true, force: true });
          cleared += 1;
        }
      }
    }
    return cleared;
  }

  /** Everything: the cache is only a copy. */
  clear(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private prune(): void {
    const walk = (dir: string): boolean => {
      let empty = true;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && walk(full)) fs.rmdirSync(full);
        else empty = false;
      }
      return empty;
    };
    if (fs.existsSync(this.dir)) for (const host of fs.readdirSync(this.dir)) if (fs.statSync(path.join(this.dir, host)).isDirectory() && walk(path.join(this.dir, host))) fs.rmdirSync(path.join(this.dir, host));
  }
}
