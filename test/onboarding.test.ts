import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMarshalHost } from "../src/host.js";
import { withManifest } from "../src/onboarding-cli.js";
import { entryFromSpec, extractTgz, parseManifest, readManifest, resolveManifest, writeManifest, type SdkManifest } from "../src/onboarding.js";

const SKILL = "---\nname: brief-check\ndescription: Check a brief.\n---\n\n# Brief check\n";

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-onboard-")));
}

/** A minimal extension package with one declared skill. */
function fixture(root: string, identity = "@test/onboard", version = "1.0.0"): string {
  const packageRoot = path.join(root, `${identity.replace("/", "__")}-${version}`, "package");
  const write = (relative: string, content: string) => {
    const target = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "runtime-extension.json",
    JSON.stringify({
      schemaVersion: 1,
      identity,
      version,
      entrypoint: "dist/index.cjs",
      moduleFormat: "commonjs-bundle-v1",
      contributes: { catalog: ["skill:skills/brief-check"] },
    }),
  );
  write("package.json", JSON.stringify({ name: identity, version, type: "commonjs", main: "dist/index.cjs" }));
  write("dist/index.cjs", "module.exports = { activate() { return {}; } };");
  write("skills/brief-check/SKILL.md", SKILL);
  return packageRoot;
}

/** npm-pack layout: everything under package/. */
function pack(packageRoot: string, out: string): Buffer {
  execFileSync("tar", ["-czf", out, "-C", path.dirname(packageRoot), "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The organization registry's routes (desktop format), on localhost, behind a bearer token. */
async function fakeRegistry(entries: { id: string; version: string; status: string; archive: Buffer; sha256?: string }[], token = "registry-token") {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/v1/onboarding/catalog") {
      const items = entries.map((entry) => ({
        id: entry.id,
        version: entry.version,
        tier: "available",
        title: entry.id,
        why: "test",
        status: entry.status,
        delivery: { kind: "archive", sha256: entry.sha256 ?? sha256(entry.archive), bytes: entry.archive.length },
      }));
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ version: 1, isAdmin: false, recommended: [], available: items.filter((item) => item.status === "approved"), pending: items.filter((item) => item.status === "pending") }),
      );
      return;
    }
    const match = /^\/v1\/onboarding\/extensions\/(@[^/]+\/[^/]+)\/([^/]+)\.tgz$/.exec(decodeURIComponent(request.url ?? ""));
    const entry = match && entries.find((candidate) => candidate.id === match[1] && candidate.version === match[2]);
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/gzip" }).end(entry.archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a manifest lists extensions by folder, archive and registry id, and is written back as read", () => {
  const root = scratch();
  const packageRoot = fixture(root);
  const archive = path.join(root, "onboard.tgz");
  pack(packageRoot, archive);
  assert.deepEqual(entryFromSpec(packageRoot, root), { path: path.relative(root, packageRoot) });
  assert.equal(entryFromSpec(archive, root).archive, "onboard.tgz");
  assert.equal(entryFromSpec(archive, root).sha256, sha256(fs.readFileSync(archive)));
  assert.deepEqual(entryFromSpec("@zyg/page-studio@0.2.0", root), { id: "@zyg/page-studio", version: "0.2.0" });
  assert.deepEqual(entryFromSpec("@zyg/page-studio", root), { id: "@zyg/page-studio" });
  assert.throws(() => entryFromSpec("nope/not-here", root), /no such folder or file/);
  assert.throws(() => entryFromSpec(root, root), /no runtime-extension\.json/);

  const manifest: SdkManifest = { version: 1, model: "claude-opus-5-5", kit: ["brain"], extensions: [{ path: "a" }, { id: "@x/y", version: "1.0.0", configuration: { token: "${env:Y_TOKEN}" } }] };
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, manifest);
  assert.deepEqual(readManifest(file), manifest);
  assert.throws(() => parseManifest({ version: 1, extensions: [{ path: "a", id: "@x/y" }] }), /exactly one of path, archive or id/);
  assert.throws(() => parseManifest({ version: 1, extensions: [{ id: "page-studio" }] }), /not an extension identity/);
  assert.throws(() => parseManifest({ version: 2, extensions: [] }), /"version": 1/);
});

test("resolving: folders as they are, archives unpacked once by sha256, ${env:...} configuration expanded", async () => {
  const root = scratch();
  const first = fixture(root, "@test/one");
  const second = fixture(root, "@test/two");
  const archive = path.join(root, "two.tgz");
  const bytes = pack(second, archive);
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, {
    version: 1,
    extensions: [
      { path: path.relative(root, first), configuration: { apiKey: "${env:ONE_KEY}", nested: { list: ["${env:ONE_KEY}", "plain"] } } },
      { archive: "two.tgz", sha256: sha256(bytes) },
    ],
  });
  const resolved = await resolveManifest(file, { env: { ONE_KEY: "s3cret" }, cacheDir: path.join(root, "cache") });
  assert.deepEqual(resolved.extensions.map((extension) => [extension.identity, extension.source]), [["@test/one", "path"], ["@test/two", "archive"]]);
  assert.deepEqual(resolved.extensions[0]!.configuration, { apiKey: "s3cret", nested: { list: ["s3cret", "plain"] } });
  assert.ok(fs.existsSync(path.join(resolved.extensions[1]!.packageRoot, "skills/brief-check/SKILL.md")));
  assert.ok(resolved.extensions[1]!.packageRoot.startsWith(path.join(root, "cache")));

  await assert.rejects(resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache") }), /environment variable ONE_KEY is not set/);
  writeManifest(file, { version: 1, extensions: [{ archive: "two.tgz", sha256: "0".repeat(64) }] });
  await assert.rejects(resolveManifest(file, { env: {} }), /sha256 is [0-9a-f]{64}, the manifest expects 0{64}/);
  writeManifest(file, { version: 1, extensions: [{ path: path.relative(root, first) }, { path: path.relative(root, first) }] });
  await assert.rejects(resolveManifest(file, { env: {} }), /@test\/one is listed twice/);
});

test("the organization registry: latest approved by default, a pinned version, size and sha256 checked, token required", async () => {
  const root = scratch();
  const v1 = pack(fixture(root, "@zyg/onboard", "1.0.0"), path.join(root, "v1.tgz"));
  const v2 = pack(fixture(root, "@zyg/onboard", "1.2.0"), path.join(root, "v2.tgz"));
  const v3 = pack(fixture(root, "@zyg/onboard", "2.0.0"), path.join(root, "v3.tgz"));
  const impostor = pack(fixture(root, "@zyg/other", "1.0.0"), path.join(root, "other.tgz"));
  const registry = await fakeRegistry([
    { id: "@zyg/onboard", version: "1.0.0", status: "approved", archive: v1 },
    { id: "@zyg/onboard", version: "1.2.0", status: "approved", archive: v2 },
    { id: "@zyg/onboard", version: "2.0.0", status: "pending", archive: v3 },
    { id: "@zyg/swapped", version: "1.0.0", status: "approved", archive: impostor },
    { id: "@zyg/tampered", version: "1.0.0", status: "approved", archive: v1, sha256: "f".repeat(64) },
  ]);
  try {
    const file = path.join(root, "marshal-sdk.json");
    const cacheDir = path.join(root, "cache");
    const env = { ORG_TOKEN: "registry-token" };
    const write = (extensions: SdkManifest["extensions"]) => writeManifest(file, { version: 1, registry: { url: registry.url, tokenEnv: "ORG_TOKEN" }, extensions });

    write([{ id: "@zyg/onboard" }]);
    const latest = await resolveManifest(file, { env, cacheDir });
    assert.equal(latest.extensions[0]!.version, "1.2.0", "pending 2.0.0 is not installable");
    assert.equal(latest.extensions[0]!.source, "registry");
    write([{ id: "@zyg/onboard", version: "1.0.0" }]);
    assert.equal((await resolveManifest(file, { env, cacheDir })).extensions[0]!.version, "1.0.0");
    const downloads = registry.requests.filter((url) => url.endsWith(".tgz")).length;
    await resolveManifest(file, { env, cacheDir });
    assert.equal(registry.requests.filter((url) => url.endsWith(".tgz")).length, downloads, "a cached archive is not downloaded again");

    write([{ id: "@zyg/onboard", version: "2.0.0" }]);
    await assert.rejects(resolveManifest(file, { env, cacheDir }), /not in the registry's approved extensions \(approved versions: 1\.0\.0, 1\.2\.0\)/);
    write([{ id: "@zyg/swapped" }]);
    await assert.rejects(resolveManifest(file, { env, cacheDir }), /holds @zyg\/other, not @zyg\/swapped/);
    write([{ id: "@zyg/tampered" }]);
    await assert.rejects(resolveManifest(file, { env, cacheDir }), /does not match the size and sha256/);
    write([{ id: "@zyg/onboard" }]);
    await assert.rejects(resolveManifest(file, { env: {}, cacheDir }), /ORG_TOKEN is not set/);
    await assert.rejects(resolveManifest(file, { env: { ORG_TOKEN: "wrong" }, cacheDir: path.join(root, "cache2") }), /HTTP 401/);
    writeManifest(file, { version: 1, extensions: [{ id: "@zyg/onboard" }] });
    await assert.rejects(resolveManifest(file, { env }), /has no registry/);
    writeManifest(file, { version: 1, registry: { url: "http://registry.example.com" }, extensions: [{ id: "@zyg/onboard" }] });
    await assert.rejects(resolveManifest(file, { env }), /must use https/);
  } finally {
    await registry.close();
  }
});

test("a registry folder with the same layout works offline (an image's mirror)", async () => {
  const root = scratch();
  const archive = pack(fixture(root, "@zyg/onboard", "1.0.0"), path.join(root, "a.tgz"));
  const mirror = path.join(root, "mirror");
  fs.mkdirSync(path.join(mirror, "v1/onboarding/extensions/@zyg/onboard"), { recursive: true });
  fs.writeFileSync(path.join(mirror, "v1/onboarding/extensions/@zyg/onboard/1.0.0.tgz"), archive);
  fs.writeFileSync(
    path.join(mirror, "v1/onboarding/catalog"),
    JSON.stringify({ version: 1, isAdmin: false, recommended: [{ id: "@zyg/onboard", version: "1.0.0", status: "approved", delivery: { kind: "archive", sha256: sha256(archive), bytes: archive.length } }], available: [], pending: [] }),
  );
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, registry: { dir: "mirror" }, extensions: [{ id: "@zyg/onboard" }] });
  const resolved = await resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache") });
  assert.equal(resolved.extensions[0]!.identity, "@zyg/onboard");
});

test("archives with links or paths leaving the folder are refused", () => {
  const root = scratch();
  const source = path.join(root, "src");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(root, "outside.txt"), "x");
  fs.symlinkSync("../outside.txt", path.join(source, "link"));
  execFileSync("tar", ["-czf", path.join(root, "link.tgz"), "-C", source, "link"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  assert.throws(() => extractTgz(fs.readFileSync(path.join(root, "link.tgz")), path.join(root, "out1")), /holds a link or special file/);
  execFileSync("tar", ["-czf", path.join(root, "dots.tgz"), "-C", source, "-s", ",^,../,", "link"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  assert.throws(() => extractTgz(fs.readFileSync(path.join(root, "dots.tgz")), path.join(root, "out2")), /link or special file|escapes the folder/);
  assert.equal(fs.existsSync(path.join(root, "link")), false);
});

test("one manifest gives a host its extensions, kit and model; the host reports each and refuses a missing one by name", async () => {
  const root = scratch();
  const packageRoot = fixture(root, "@test/onboard");
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, model: "claude-sonnet-5", reasoningEffort: "medium", extensions: [{ path: path.relative(root, packageRoot) }] });
  fs.mkdirSync(path.join(root, "ws"));
  const lines: string[] = [];
  const options = await withManifest(
    { workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state"), browser: false, env: {}, log: (line) => lines.push(line) },
    { manifest: file },
  );
  assert.equal(options.model, "claude-sonnet-5");
  assert.equal(options.reasoningEffort, "medium");
  const host = await createMarshalHost({ ...options, query: (() => (async function* () {})()) as never });
  try {
    assert.deepEqual(
      host.extensions.map((extension) => [extension.identity, extension.status, extension.health, extension.skills]),
      [["@test/onboard", "enabled", "healthy", ["brief-check"]]],
    );
    assert.ok(lines.some((line) => /^extension @test\/onboard@1\.0\.0 enabled, healthy: 0 capabilities, 1 skills$/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => line.startsWith(`manifest ${file}: @test/onboard@1.0.0`)));
  } finally {
    await host.dispose();
  }
  const overridden = await withManifest({ workspacePath: root, stateRoot: root, env: {}, model: "claude-opus-5-5" }, { manifest: file, model: "claude-opus-5-5" });
  assert.equal(overridden.model, "claude-opus-5-5", "--model wins over the manifest");

  await assert.rejects(
    createMarshalHost({ workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state2"), browser: false, env: {}, extensions: [{ packageRoot: path.join(root, "gone") }] }),
    /gone: no runtime-extension\.json in .*gone \(is it a built extension package\?\)/,
  );
});
