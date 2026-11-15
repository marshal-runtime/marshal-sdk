import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUD_STRANDED_KNOWN_FIELDS,
  FileOrgCloudStrandedStore,
  MAX_STRANDED_SESSIONS,
  type OrgCloudStrandedEntry,
} from "./org-cloud-stranded-store";

const dirs: string[] = [];
function storeFile(contents?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-stranded-"));
  dirs.push(dir);
  const file = path.join(dir, "org-cloud-stranded.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { dir, file };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string): OrgCloudStrandedEntry => ({
  sessionId: id,
  orgId: "fake",
  title: "Fix the build",
  workspaceId: "ws:platform",
  lastActivityAt: "2026-11-04T10:00:00.000Z",
});
const corrupt = (dir: string) => fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));

describe("FileOrgCloudStrandedStore", () => {
  it("returns what was saved to a fresh instance, and removes the file when emptied", () => {
    const { file } = storeFile();
    new FileOrgCloudStrandedStore(file).save([entry("s1"), entry("s2")]);
    expect(new FileOrgCloudStrandedStore(file).load()).toEqual([entry("s1"), entry("s2")]);
    new FileOrgCloudStrandedStore(file).save([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes only the allowed fields", () => {
    const { file } = storeFile();
    new FileOrgCloudStrandedStore(file).save([entry("s1")]);
    const written: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const sessions: unknown = Reflect.get(Object(written), "sessions");
    expect(Object.keys(Object(Array.isArray(sessions) ? sessions[0] : {})).sort()).toEqual(
      [...CLOUD_STRANDED_KNOWN_FIELDS].sort(),
    );
  });

  it.each([
    ["not json", "{nope"],
    ["an unknown field", JSON.stringify({ version: 1, sessions: [{ ...entry("s1"), extra: 1 }] })],
    ["a newer version", JSON.stringify({ version: 2, sessions: [] })],
    [
      "too many rows",
      JSON.stringify({
        version: 1,
        sessions: Array.from({ length: MAX_STRANDED_SESSIONS + 1 }, (_, i) => entry(`s${i}`)),
      }),
    ],
  ])("keeps a file with %s as .corrupt and starts empty", (_label, contents) => {
    const { dir, file } = storeFile(contents);
    expect(new FileOrgCloudStrandedStore(file).load()).toEqual([]);
    expect(corrupt(dir)).toHaveLength(1);
  });

  it("keeps at most the newest rows when saving", () => {
    const { file } = storeFile();
    const many = Array.from({ length: MAX_STRANDED_SESSIONS + 5 }, (_, i) => entry(`s${i}`));
    new FileOrgCloudStrandedStore(file).save(many);
    const loaded = new FileOrgCloudStrandedStore(file).load();
    expect(loaded).toHaveLength(MAX_STRANDED_SESSIONS);
    expect(loaded.at(-1)?.sessionId).toBe(`s${MAX_STRANDED_SESSIONS + 4}`);
  });
});
