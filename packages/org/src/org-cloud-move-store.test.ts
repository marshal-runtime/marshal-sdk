import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileOrgCloudMoveStore } from "./org-cloud-move-store";

const dirs: string[] = [];
function storeFile(contents?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-moves-"));
  dirs.push(dir);
  const file = path.join(dir, "org-cloud-moves.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { dir, file };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const corrupt = (dir: string) => fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));

describe("FileOrgCloudMoveStore with a bad file", () => {
  it("keeps a newer-schema file as .corrupt and still locks the sessions it names", () => {
    const { dir, file } = storeFile(
      JSON.stringify({
        version: 2,
        moves: [{ sessionId: "s1", futureField: 1 }, { sessionId: "s2" }],
      }),
    );
    const store = new FileOrgCloudMoveStore(file);
    expect(store.load().map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
    expect(corrupt(dir)).toHaveLength(1);
    expect(store.unreadableNotice).toBe(false);
    expect(new FileOrgCloudMoveStore(file).load().map((entry) => entry.state)).toEqual([
      "cloud",
      "cloud",
    ]);
  });

  it("keeps an unparseable file, locks nothing and asks for a one-time notice", () => {
    const { dir, file } = storeFile("{not json");
    const store = new FileOrgCloudMoveStore(file);
    expect(store.load()).toEqual([]);
    expect(corrupt(dir)).toHaveLength(1);
    expect(store.unreadableNotice).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("returns nothing and no notice when there is no file", () => {
    const { file } = storeFile();
    const store = new FileOrgCloudMoveStore(file);
    expect(store.load()).toEqual([]);
    expect(store.unreadableNotice).toBe(false);
  });
});
