import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_EXTRACTED_BYTES = 400 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 20_000;

export class OrgArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrgArchiveError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throws unless the archive has exactly the announced size and sha256. */
export function verifyArchiveBytes(
  bytes: Uint8Array,
  expected: { sha256: string; bytes: number },
): void {
  if (bytes.byteLength !== expected.bytes) {
    throw new OrgArchiveError("size-mismatch", "downloaded archive has an unexpected size");
  }
  if (sha256Hex(bytes) !== expected.sha256.toLowerCase()) {
    throw new OrgArchiveError("hash-mismatch", "downloaded archive does not match its checksum");
  }
}

function readString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(block: Buffer, start: number, length: number): number {
  const raw = readString(block, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) throw new OrgArchiveError("bad-archive", "invalid tar header");
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function safeRelativePath(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new OrgArchiveError("unsafe-path", "archive contains an absolute path");
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new OrgArchiveError("unsafe-path", "archive contains a parent directory path");
  }
  return parts.join("/");
}

/**
 * Extracts a .tgz into `destination` (an empty directory). Only regular files and directories are
 * allowed: symlinks, hard links, devices, absolute paths, `..` segments and oversized archives
 * are rejected before anything outside `destination` can be written.
 */
export async function extractTgz(
  archive: Uint8Array,
  destination: string,
  limits: { maxBytes?: number; maxEntries?: number } = {},
): Promise<{ files: number; bytes: number }> {
  const maxBytes = limits.maxBytes ?? MAX_EXTRACTED_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxBytes + 1024 * 1024 });
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    throw new OrgArchiveError(
      tooLarge ? "too-large" : "bad-archive",
      tooLarge ? "archive expands beyond the allowed size" : "archive is not a valid gzip file",
    );
  }
  const root = path.resolve(destination);
  let offset = 0;
  let entries = 0;
  let total = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    offset += 512;
    entries += 1;
    if (entries > maxEntries)
      throw new OrgArchiveError("too-large", "archive has too many entries");
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    const baseName = readString(header, 0, 100);
    const rawName = longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const dataEnd = offset + size;
    if (dataEnd > tar.length) throw new OrgArchiveError("bad-archive", "archive is truncated");
    const data = tar.subarray(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    longName = undefined;
    if (type === "x" || type === "g") continue;
    if (type === "1" || type === "2") {
      throw new OrgArchiveError("link-entry", "archive contains a link");
    }
    if (type !== "0" && type !== "5") {
      throw new OrgArchiveError("unsupported-entry", "archive contains an unsupported entry");
    }
    const relative = safeRelativePath(rawName);
    if (relative === "") continue;
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new OrgArchiveError("unsafe-path", "archive entry escapes the destination");
    }
    if (type === "5") {
      // eslint-disable-next-line no-await-in-loop -- entries are written in archive order
      await mkdir(target, { recursive: true });
      continue;
    }
    total += size;
    if (total > maxBytes) throw new OrgArchiveError("too-large", "archive expands too large");
    // eslint-disable-next-line no-await-in-loop -- entries are written in archive order
    await mkdir(path.dirname(target), { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- entries are written in archive order
    await writeFile(target, data, { mode: (readOctal(header, 100, 8) & 0o755) | 0o600 });
  }
  return { files: entries, bytes: total };
}
