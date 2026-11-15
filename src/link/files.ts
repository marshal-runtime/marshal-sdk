// Read-only file access under named roots (a run's workspace, its output folder). Every path is resolved
// through realpath and must stay inside its root, so neither `..` nor a symlink reaches outside.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 500;
const BINARY_SNIFF_BYTES = 8192;

export class FileAccessError extends Error {
  constructor(
    readonly code: "unknown-root" | "outside-root" | "not-found" | "not-a-directory" | "not-a-file",
    message: string,
  ) {
    super(message);
  }
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
  modifiedAt: string;
}

export interface FileContent {
  root: string;
  path: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
  truncated: boolean;
  modifiedAt: string;
}

export class FileRoots {
  private readonly roots = new Map<string, string>();

  constructor(roots: Record<string, string>) {
    for (const [name, dir] of Object.entries(roots)) {
      try {
        this.roots.set(name, fs.realpathSync(dir));
      } catch {
        // A root that does not exist (yet) is left out rather than failing the server.
      }
    }
  }

  names(): string[] {
    return [...this.roots.keys()];
  }

  private resolve(root: string, relative: string): { base: string; full: string; relative: string } {
    const base = this.roots.get(root);
    if (!base) throw new FileAccessError("unknown-root", `No file root named ${root}.`);
    const clean = path.posix.normalize(`/${String(relative ?? "").replace(/\\/g, "/")}`).slice(1);
    let full: string;
    try {
      full = fs.realpathSync(path.join(base, clean));
    } catch {
      throw new FileAccessError("not-found", `${root}/${clean} does not exist.`);
    }
    if (full !== base && !full.startsWith(`${base}${path.sep}`)) {
      throw new FileAccessError("outside-root", `${root}/${clean} leads outside its root.`);
    }
    return { base, full, relative: path.relative(base, full).split(path.sep).join("/") };
  }

  list(root: string, relative = ""): { root: string; path: string; entries: FileEntry[]; truncated: boolean } {
    const { full, relative: clean } = this.resolve(root, relative);
    if (!fs.statSync(full).isDirectory()) throw new FileAccessError("not-a-directory", `${root}/${clean} is not a folder.`);
    const names = fs.readdirSync(full);
    const entries: FileEntry[] = [];
    for (const name of names.slice(0, MAX_ENTRIES)) {
      try {
        const stat = fs.lstatSync(path.join(full, name));
        entries.push({
          name,
          type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch {
        // Gone between readdir and stat.
      }
    }
    entries.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1));
    return { root, path: clean, entries, truncated: names.length > MAX_ENTRIES };
  }

  read(root: string, relative: string, maxBytes = DEFAULT_MAX_FILE_BYTES): FileContent {
    const { full, relative: clean } = this.resolve(root, relative);
    const stat = fs.statSync(full);
    if (!stat.isFile()) throw new FileAccessError("not-a-file", `${root}/${clean} is not a file.`);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(full, "r");
    try {
      fs.readSync(handle, buffer, 0, length, 0);
    } finally {
      fs.closeSync(handle);
    }
    const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
    return {
      root,
      path: clean,
      size: stat.size,
      encoding: binary ? "base64" : "utf8",
      content: buffer.toString(binary ? "base64" : "utf8"),
      truncated: stat.size > length,
      modifiedAt: stat.mtime.toISOString(),
    };
  }
}
