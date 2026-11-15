import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  extractTgz,
  OrgArchiveError,
  sha256Hex,
  verifyArchiveBytes,
} from "./org-onboarding-archive";

function tarHeader(name: string, size: number, type: string, linkName = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124);
  header.write(type, 156);
  header.write(linkName, 157, 100);
  header.write("ustar\0", 257);
  header.fill(0x20, 148, 156);
  const sum = [...header].reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

function tgz(entries: { name: string; body?: string; type?: string; link?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    parts.push(tarHeader(entry.name, body.length, entry.type ?? "0", entry.link));
    if (body.length) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

describe("org onboarding archive", () => {
  const dirs: string[] = [];
  const fresh = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-onboarding-test-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("extracts regular files", async () => {
    const dir = await fresh();
    await extractTgz(
      tgz([
        { name: "package/", type: "5" },
        { name: "package/runtime-extension.json", body: "{}" },
      ]),
      dir,
    );
    expect(await readFile(path.join(dir, "package/runtime-extension.json"), "utf8")).toBe("{}");
  });

  it.each([
    ["symlink", { name: "a", type: "2", link: "/etc/passwd" }, "link-entry"],
    ["hard link", { name: "a", type: "1", link: "b" }, "link-entry"],
    ["absolute path", { name: "/etc/evil", body: "x" }, "unsafe-path"],
    ["parent path", { name: "../evil", body: "x" }, "unsafe-path"],
    ["nested parent path", { name: "a/../../evil", body: "x" }, "unsafe-path"],
    ["device", { name: "dev", type: "3" }, "unsupported-entry"],
  ])("rejects a %s", async (_label, entry, code) => {
    const dir = await fresh();
    await expect(extractTgz(tgz([entry]), dir)).rejects.toMatchObject({ code });
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects an archive that expands beyond the limit", async () => {
    const dir = await fresh();
    const big = tgz([{ name: "big", body: "a".repeat(5000) }]);
    await expect(extractTgz(big, dir, { maxBytes: 1000 })).rejects.toBeInstanceOf(OrgArchiveError);
  });

  it("rejects non-gzip data", async () => {
    await expect(extractTgz(Buffer.from("nope"), await fresh())).rejects.toMatchObject({
      code: "bad-archive",
    });
  });

  it("verifies size and sha256", () => {
    const bytes = Buffer.from("hello");
    const sha = sha256Hex(bytes);
    expect(() => verifyArchiveBytes(bytes, { sha256: sha, bytes: 5 })).not.toThrow();
    expect(() => verifyArchiveBytes(bytes, { sha256: sha, bytes: 6 })).toThrow(/size/);
    expect(() => verifyArchiveBytes(bytes, { sha256: "0".repeat(64), bytes: 5 })).toThrow(
      /checksum/,
    );
  });
});
