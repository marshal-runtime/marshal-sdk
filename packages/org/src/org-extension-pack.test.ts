import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { packExtensionDirectory, previewExtensionPack } from "./org-extension-pack";
import { extractTgz, sha256Hex } from "./org-onboarding-archive";

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "org-pack-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

describe("packExtensionDirectory", () => {
  it("packs into the C2 archive format: it extracts back to the same files and the sha256 matches the bytes", async () => {
    const longName = `dist/${"d".repeat(120)}.js`;
    const root = folder({
      "runtime-extension.json": '{"identity":"@me/tool","version":"1.0.0"}',
      "package.json": "{}",
      "dist/index.cjs": "module.exports = 1;",
      [longName]: "long",
      "node_modules/skip/index.js": "no",
    });
    const packed = await packExtensionDirectory(root);
    expect(packed.sha256).toBe(sha256Hex(packed.bytes));
    const out = mkdtempSync(path.join(tmpdir(), "org-unpack-"));
    await extractTgz(packed.bytes, out);
    expect(readFileSync(path.join(out, "runtime-extension.json"), "utf8")).toContain("@me/tool");
    expect(readFileSync(path.join(out, longName), "utf8")).toBe("long");
    expect(() => readFileSync(path.join(out, "node_modules/skip/index.js"))).toThrow(/ENOENT/);
  });

  it("is reproducible", async () => {
    const root = folder({ "runtime-extension.json": "{}", "a.js": "1", "b/c.js": "2" });
    expect((await packExtensionDirectory(root)).sha256).toBe(
      (await packExtensionDirectory(root)).sha256,
    );
  });

  it("refuses symbolic links, a missing manifest and an oversized extension", async () => {
    const linked = folder({ "runtime-extension.json": "{}", "dist/a.js": "1" });
    symlinkSync("/etc/passwd", path.join(linked, "dist/passwd"));
    await expect(packExtensionDirectory(linked)).rejects.toMatchObject({ code: "link-entry" });
    await expect(packExtensionDirectory(folder({ "a.js": "1" }))).rejects.toMatchObject({
      code: "no-manifest",
    });
    const big = folder({ "runtime-extension.json": "{}", "dist/.keep": "" });
    for (const name of ["a", "b", "c", "d"]) {
      writeFileSync(path.join(big, "dist", name), randomBytes(8 * 1024 * 1024));
    }
    await expect(packExtensionDirectory(big)).rejects.toMatchObject({ code: "too-large" });
  });

  describe("what gets published", () => {
    const manifest = JSON.stringify({
      identity: "@me/tool",
      version: "1.0.0",
      entrypoint: "build/main.cjs",
      icon: "assets/icon.png",
    });
    const files = {
      "runtime-extension.json": manifest,
      "package.json": "{}",
      "README.md": "hi",
      LICENSE: "MIT",
      "build/main.cjs": "module.exports = {};",
      "assets/icon.png": "png",
      "dist/x.js": "1",
      "src/private.ts": "export const secret = 1;",
      ".env": "TOKEN=1",
      ".npmrc": "//registry/:_authToken=abc",
      ".git/config": "[core]",
      "dist/x.js.map": "{}",
      "dist/.hidden": "no",
      "creds.pem": "no",
      "node_modules/dep/index.js": "no",
      "notes/todo.txt": "no",
    };

    it("takes an allowlist: manifest, package.json, README/LICENSE, the entrypoint folder, dist and declared assets", async () => {
      const plan = await previewExtensionPack(folder(files), { homeDir: "/nobody" });
      expect(plan.files.map((file) => file.relative)).toEqual([
        "LICENSE",
        "README.md",
        "assets/icon.png",
        "build/main.cjs",
        "dist/x.js",
        "package.json",
        "runtime-extension.json",
      ]);
      expect(plan.skipped).toEqual(["dist/.hidden", "dist/x.js.map"]);
      expect(plan.totalBytes).toBe(plan.files.reduce((sum, file) => sum + file.bytes, 0));
    });

    it("leaves dotfiles, keys and undeclared files out of the archive itself", async () => {
      const packed = await packExtensionDirectory(folder(files), { homeDir: "/nobody" });
      const out = mkdtempSync(path.join(tmpdir(), "org-unpack-"));
      await extractTgz(packed.bytes, out);
      for (const gone of [
        ".env",
        ".npmrc",
        ".git/config",
        "creds.pem",
        "src/private.ts",
        "node_modules/dep/index.js",
      ]) {
        expect(() => readFileSync(path.join(out, gone))).toThrow(/ENOENT/);
      }
    });

    it("includes a node_modules folder only when the manifest declares it", async () => {
      const declared = folder({
        "runtime-extension.json": JSON.stringify({
          entrypoint: "dist/a.js",
          vendor: "node_modules/dep",
        }),
        "dist/a.js": "1",
        "node_modules/dep/index.js": "dep",
        "node_modules/other/index.js": "no",
      });
      const plan = await previewExtensionPack(declared, { homeDir: "/nobody" });
      expect(plan.files.map((file) => file.relative)).toContain("node_modules/dep/index.js");
    });

    it("leaves out a file over the per-file cap", async () => {
      const root = folder({ "runtime-extension.json": "{}", "dist/small.js": "1" });
      writeFileSync(path.join(root, "dist/huge.bin"), randomBytes(11 * 1024 * 1024));
      const plan = await previewExtensionPack(root, { homeDir: "/nobody" });
      expect(plan.skipped).toEqual(["dist/huge.bin"]);
    });

    it("refuses a file that holds the user's home path or looks like a secret", async () => {
      const home = "/Users/zed-the-tester";
      await expect(
        previewExtensionPack(
          folder({ "runtime-extension.json": "{}", "dist/a.js": `// ${home}/project/x` }),
          { homeDir: home },
        ),
      ).rejects.toMatchObject({ code: "sensitive-content" });
      const leaks = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "AKIAABCDEFGHIJKLMNOP",
        `ghp_${"a".repeat(36)}`,
        `const token = "${"x".repeat(24)}";`,
      ];
      await Promise.all(
        leaks.map((leak) =>
          expect(
            previewExtensionPack(folder({ "runtime-extension.json": "{}", "dist/a.js": leak }), {
              homeDir: "/nobody",
            }),
          ).rejects.toMatchObject({ code: "sensitive-content" }),
        ),
      );
    });
  });
});
