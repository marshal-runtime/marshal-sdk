import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkManifest } from "../src/check.js";
import { createMarshalHost } from "../src/host.js";
import { brainConfiguration } from "../src/kit/brain.js";
import { withManifest } from "../src/onboarding-cli.js";
import {
  brainKitOptions,
  dependencyOrder,
  entryFromSpec,
  extractTgz,
  parseManifest,
  readManifest,
  resolveManifest,
  unmetRequirements,
  writeManifest,
  type ExtensionResolver,
  type ManifestOrg,
  type SdkManifest,
} from "../src/onboarding.js";

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

/** The fixture with more fields in its runtime-extension.json (dependencies, configuration). */
function declaring(packageRoot: string, fields: Record<string, unknown>): string {
  const file = path.join(packageRoot, "runtime-extension.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...fields }));
  return packageRoot;
}

/** npm-pack layout: everything under package/. */
function pack(packageRoot: string, out: string): Buffer {
  execFileSync("tar", ["-czf", out, "-C", path.dirname(packageRoot), "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The organization side as the org layer would answer it: the admitted set, and archives with the hash the
 * organization announced (`announce` overrides it to play a tampered download).
 */
function fakeResolver(packages: { id: string; version: string; archive?: Buffer; packageRoot?: string; announce?: string }[], admitted = packages) {
  const fetched: string[] = [];
  const orgs: ManifestOrg[] = [];
  const resolver: ExtensionResolver = {
    async admitted(org) {
      orgs.push(org);
      const latest = new Map<string, string>();
      for (const item of admitted) latest.set(item.id, item.version);
      return [...latest].map(([id, version]) => ({ id, version }));
    },
    async fetch({ org, id, version }) {
      orgs.push(org);
      const matching = packages.filter((item) => item.id === id && (!version || item.version === version));
      const item = matching.at(-1);
      if (!item) throw new Error(`${id}${version ? `@${version}` : ""} is not admitted`);
      fetched.push(`${id}@${item.version}`);
      if (item.packageRoot) return { id, version: item.version, packageRoot: item.packageRoot };
      return { id, version: item.version, archive: item.archive!, sha256: item.announce ?? sha256(item.archive!) };
    },
  };
  return { resolver, fetched, orgs };
}

const ORG = "https://org.example.com/.well-known/marshal";

test("a manifest lists extensions by folder, archive and organization id, and is written back as read", () => {
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
  assert.throws(() => parseManifest({ version: 1, extensions: [{ path: "a", id: "@x/y" }] }), /exactly one of path, archive, url or id/);
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
    defaults: false,
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
  writeManifest(file, { version: 1, defaults: false, extensions: [{ archive: "two.tgz", sha256: "0".repeat(64) }] });
  await assert.rejects(resolveManifest(file, { env: {} }), /sha256 is [0-9a-f]{64}, the manifest expects 0{64}/);
  writeManifest(file, { version: 1, defaults: false, extensions: [{ path: path.relative(root, first) }, { path: path.relative(root, first) }] });
  await assert.rejects(resolveManifest(file, { env: {} }), /@test\/one is listed twice/);
});

test("ids come from the organization through the resolver: pinned or current, hash and identity checked, unpacked once", async () => {
  const root = scratch();
  const v1 = pack(fixture(root, "@zyg/onboard", "1.0.0"), path.join(root, "v1.tgz"));
  const v2 = pack(fixture(root, "@zyg/onboard", "1.2.0"), path.join(root, "v2.tgz"));
  const impostor = pack(fixture(root, "@zyg/other", "1.0.0"), path.join(root, "other.tgz"));
  const { resolver, fetched, orgs } = fakeResolver([
    { id: "@zyg/onboard", version: "1.0.0", archive: v1 },
    { id: "@zyg/onboard", version: "1.2.0", archive: v2 },
    { id: "@zyg/swapped", version: "1.0.0", archive: impostor },
    { id: "@zyg/tampered", version: "1.0.0", archive: v1, announce: "f".repeat(64) },
    { id: "@zyg/folder", version: "3.0.0", packageRoot: fixture(root, "@zyg/folder", "3.0.0") },
  ], []);
  const file = path.join(root, "marshal-sdk.json");
  const cacheDir = path.join(root, "cache");
  const write = (extensions: SdkManifest["extensions"]) => writeManifest(file, { version: 1, org: { discovery: ORG }, defaults: false, extensions });

  write([{ id: "@zyg/onboard" }, { id: "@zyg/folder" }]);
  const latest = await resolveManifest(file, { env: {}, cacheDir, resolver });
  assert.deepEqual(latest.extensions.map((extension) => [extension.identity, extension.version, extension.source, extension.origin]), [
    ["@zyg/onboard", "1.2.0", "org", "listed"],
    ["@zyg/folder", "3.0.0", "org", "listed"],
  ]);
  assert.equal(orgs[0]!.discovery, ORG, "the resolver is told which organization");
  write([{ id: "@zyg/onboard", version: "1.0.0" }]);
  const pinned = await resolveManifest(file, { env: {}, cacheDir, resolver });
  assert.equal(pinned.extensions[0]!.version, "1.0.0");
  const unpacked = fs.statSync(pinned.extensions[0]!.packageRoot).mtimeMs;
  await resolveManifest(file, { env: {}, cacheDir, resolver });
  assert.equal(fs.statSync(pinned.extensions[0]!.packageRoot).mtimeMs, unpacked, "an archive already unpacked is reused");
  assert.ok(fetched.includes("@zyg/onboard@1.0.0"));

  write([{ id: "@zyg/swapped" }]);
  await assert.rejects(resolveManifest(file, { env: {}, cacheDir, resolver }), /holds @zyg\/other, not @zyg\/swapped/);
  write([{ id: "@zyg/tampered" }]);
  await assert.rejects(resolveManifest(file, { env: {}, cacheDir, resolver }), /the archive's sha256 is [0-9a-f]{64}, the organization announced f{64}/);
  write([{ id: "@zyg/onboard" }]);
  await assert.rejects(resolveManifest(file, { env: {}, cacheDir }), /needs the org layer \(src\/org\)/);
  writeManifest(file, { version: 1, defaults: false, extensions: [{ id: "@zyg/onboard" }] });
  await assert.rejects(resolveManifest(file, { env: {}, resolver }), /has no "org"/);
});

test("org with a profile loads the organization's admitted extensions, minus deny and outside allow; listed entries win", async () => {
  const root = scratch();
  const archives = Object.fromEntries(
    ["@zyg/a", "@zyg/b", "@zyg/c", "@zyg/d"].map((id) => [id, pack(fixture(root, id, "1.0.0"), path.join(root, `${id.slice(5)}.tgz`))]),
  );
  const { resolver } = fakeResolver(Object.entries(archives).map(([id, archive]) => ({ id, version: "1.0.0", archive })));
  const file = path.join(root, "marshal-sdk.json");
  const listedA = fixture(path.join(root, "local"), "@zyg/a", "9.0.0");
  writeManifest(file, {
    version: 1,
    org: { discovery: ORG, profile: { allow: ["@zyg/a", "@zyg/b", "@zyg/c"], deny: ["@zyg/c"] } },
    defaults: false,
    extensions: [{ path: path.relative(root, listedA) }],
  });
  assert.deepEqual(readManifest(file).org, { discovery: ORG, profile: { allow: ["@zyg/a", "@zyg/b", "@zyg/c"], deny: ["@zyg/c"] } });
  const resolved = await resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache"), resolver });
  assert.deepEqual(resolved.extensions.map((extension) => [extension.identity, extension.version, extension.origin]), [
    ["@zyg/a", "9.0.0", "listed"],
    ["@zyg/b", "1.0.0", "org-profile"],
  ]);

  writeManifest(file, { version: 1, org: { discovery: ORG }, defaults: false, extensions: [] });
  const everything = await resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache"), resolver });
  assert.deepEqual(everything.extensions.map((extension) => extension.identity), ["@zyg/a", "@zyg/b", "@zyg/c", "@zyg/d"], "no profile: everything admitted");
  assert.throws(() => parseManifest({ version: 1, org: { discovery: ORG, profile: { deny: ["c"] } }, extensions: [] }), /org\.profile\.deny is a list of identities/);
  assert.throws(() => parseManifest({ version: 1, org: {}, extensions: [] }), /org needs \{"discovery"/);
});

test("built-in defaults: the org extension with an org, the kit's Brain, Zyg's tools on a Zyg host; each can be opted out", async () => {
  const root = scratch();
  const orgArchive = pack(fixture(root, "@marshal/org", "0.1.0"), path.join(root, "org.tgz"));
  const brain = fixture(root, "@marshal/brain", "0.4.0");
  const zygTools = fixture(root, "@zyg/marshal-runtime-extension", "2.1.0");
  const { resolver } = fakeResolver([{ id: "@marshal/org", version: "0.1.0", archive: orgArchive }], []);
  const env = { MARSHAL_SDK_BRAIN_PACKAGE: brain, MARSHAL_SDK_ZYG_EXTENSION: zygTools };
  const file = path.join(root, "marshal-sdk.json");
  const resolve = (manifest: Omit<SdkManifest, "version">, environment: Record<string, string | undefined> = env) => {
    writeManifest(file, { version: 1, ...manifest });
    return resolveManifest(file, { env: environment, cacheDir: path.join(root, "cache"), resolver });
  };

  const zyg = await resolve({ profile: "zyg", org: { discovery: ORG }, extensions: [] });
  assert.deepEqual(zyg.defaultExtensions, ["@marshal/org", "@marshal/brain", "@zyg/marshal-runtime-extension"]);
  assert.deepEqual(zyg.extensions.map((extension) => [extension.identity, extension.origin]), [
    ["@marshal/org", "default"],
    ["@zyg/marshal-runtime-extension", "default"],
  ], "the Brain loads through the kit, not as a listed package");
  assert.deepEqual(zyg.kit, { parts: ["brain"], brain: { packageRoot: brain } });
  assert.deepEqual(zyg.extensions[0]!.configuration, { discovery: ORG }, "the org extension is told which organization to join");
  const orgPackage = zyg.extensions[0]!.packageRoot;
  const configured = await resolve({
    org: { discovery: ORG, profile: { deny: ["@zyg/x"] } },
    defaults: { brain: false },
    extensions: [{ path: orgPackage, configuration: { discovery: "https://other.example.com", label: "${env:ORG_LABEL}" } }],
  }, { ORG_LABEL: "team" });
  assert.deepEqual(configured.extensions.map((extension) => [extension.identity, extension.origin, extension.configuration]), [
    ["@marshal/org", "listed", { discovery: "https://other.example.com", profile: { deny: ["@zyg/x"] }, label: "team" }],
  ], "configuration the manifest gives @marshal/org wins over the org's discovery");

  // Marley: a Zyg host that opts out of Zyg's tools.
  const marley = await resolve({ profile: "zyg", org: { discovery: ORG }, defaults: { zygTools: false }, kit: ["sessions"], extensions: [] });
  assert.deepEqual(marley.defaultExtensions, ["@marshal/org", "@marshal/brain"]);
  assert.deepEqual(marley.kit, { parts: ["brain", "sessions"], brain: { packageRoot: brain } });

  const plain = await resolve({ extensions: [] });
  assert.deepEqual(plain.defaultExtensions, ["@marshal/brain"], "no org, not a Zyg host: only the Brain");
  const none = await resolve({ profile: "zyg", org: { discovery: ORG }, defaults: false, extensions: [] });
  assert.deepEqual([none.defaultExtensions, none.extensions, none.kit], [[], [], undefined]);

  const kitAsks = await resolve({ kit: ["memory"], extensions: [] });
  assert.deepEqual(kitAsks.defaultExtensions, [], "a kit that asks for the Brain loads it itself");
  const listed = await resolve({ profile: "zyg", defaults: { brain: false }, extensions: [{ path: path.relative(root, zygTools), configuration: { mode: "x" } }] });
  assert.deepEqual(listed.extensions.map((extension) => [extension.identity, extension.origin]), [["@zyg/marshal-runtime-extension", "listed"]], "a listed default is not loaded twice");

  await assert.rejects(resolve({ extensions: [] }, {}), /default @marshal\/brain is on because every host carries the kit's Brain, but no package was found: set MARSHAL_SDK_BRAIN_PACKAGE .* or opt out with "defaults": \{"brain": false\}/);
  await assert.rejects(resolve({ profile: "zyg", defaults: { brain: false }, extensions: [] }, {}), /opt out with "defaults": \{"zygTools": false\}/);
  const wrong = fixture(root, "@zyg/not-brain", "1.0.0");
  await assert.rejects(resolve({ extensions: [] }, { MARSHAL_SDK_BRAIN_PACKAGE: wrong }), /holds @zyg\/not-brain, not @marshal\/brain/);
  assert.throws(() => parseManifest({ version: 1, defaults: { brian: false }, extensions: [] }), /defaults is false or/);
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

test("one manifest gives a host its extensions, defaults, kit and model; the report marks defaults and refuses a missing package by name", async () => {
  const root = scratch();
  const packageRoot = fixture(root, "@test/onboard");
  const brain = fixture(root, "@marshal/brain", "0.4.0");
  const zygTools = fixture(root, "@zyg/marshal-runtime-extension", "2.1.0");
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, profile: "zyg", model: "claude-sonnet-5", reasoningEffort: "medium", extensions: [{ path: path.relative(root, packageRoot) }] });
  fs.mkdirSync(path.join(root, "ws"));
  const lines: string[] = [];
  const options = await withManifest(
    {
      workspacePath: path.join(root, "ws"),
      stateRoot: path.join(root, "state"),
      browser: false,
      env: { MARSHAL_SDK_BRAIN_PACKAGE: brain, MARSHAL_SDK_ZYG_EXTENSION: zygTools },
      log: (line) => lines.push(line),
    },
    { manifest: file },
  );
  assert.deepEqual(options.defaultExtensions, ["@marshal/brain", "@zyg/marshal-runtime-extension"]);
  assert.equal(options.model, "claude-sonnet-5");
  assert.equal(options.reasoningEffort, "medium");
  const host = await createMarshalHost({ ...options, query: (() => (async function* () {})()) as never });
  try {
    assert.deepEqual(
      host.extensions.map((extension) => [extension.identity, extension.status, extension.health, extension.skills]),
      [
        ["@marshal/brain", "enabled", "healthy", ["brief-check"]],
        ["@zyg/marshal-runtime-extension", "enabled", "healthy", ["brief-check"]],
        ["@test/onboard", "enabled", "healthy", ["brief-check"]],
      ],
    );
    assert.deepEqual(host.extensions.map((extension) => extension.fromDefaults), [true, true, false]);
    assert.ok(lines.some((line) => /^extension @marshal\/brain@0\.4\.0 \(default\) enabled, healthy/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^extension @zyg\/marshal-runtime-extension@2\.1\.0 \(default\) enabled, healthy/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^extension @test\/onboard@1\.0\.0 enabled, healthy: 0 capabilities, 1 skills$/.test(line)), lines.join("\n"));
    assert.ok(
      lines.includes(`manifest ${file}: @marshal/brain@0.4.0 (default), @zyg/marshal-runtime-extension@2.1.0 (default), @test/onboard@1.0.0`),
      lines.join("\n"),
    );
  } finally {
    await host.dispose();
  }
  const overridden = await withManifest(
    { workspacePath: root, stateRoot: root, env: { MARSHAL_SDK_BRAIN_PACKAGE: brain, MARSHAL_SDK_ZYG_EXTENSION: zygTools }, model: "claude-opus-5-5" },
    { manifest: file, model: "claude-opus-5-5" },
  );
  assert.equal(overridden.model, "claude-opus-5-5", "--model wins over the manifest");

  await assert.rejects(
    createMarshalHost({ workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state2"), browser: false, env: {}, extensions: [{ packageRoot: path.join(root, "gone") }] }),
    /gone: no runtime-extension\.json in .*gone \(is it a built extension package\?\)/,
  );
});

test("a url entry is downloaded once with the host's credentials, pinned by sha256 and cached by it", async () => {
  const root = scratch();
  const bytes = pack(fixture(root, "@test/remote", "0.2.0"), path.join(root, "remote.tgz"));
  const url = "gs://dev-bucket/marshal-extensions/@test/remote/0.2.0.tgz";
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, defaults: false, extensions: [{ url, sha256: sha256(bytes) }] });
  assert.deepEqual(readManifest(file).extensions, [{ url, sha256: sha256(bytes) }]);
  const fetched: string[] = [];
  const fetchUrl = async (asked: string) => {
    fetched.push(asked);
    return bytes;
  };
  const cacheDir = path.join(root, "cache");
  const first = await resolveManifest(file, { env: {}, cacheDir, fetchUrl });
  assert.deepEqual(first.extensions.map((extension) => [extension.identity, extension.version, extension.source]), [["@test/remote", "0.2.0", "url"]]);
  const second = await resolveManifest(file, { env: {}, cacheDir, fetchUrl });
  assert.equal(second.extensions[0]!.packageRoot, first.extensions[0]!.packageRoot);
  assert.deepEqual(fetched, [url], "the second start reads the cache");

  writeManifest(file, { version: 1, defaults: false, extensions: [{ url, sha256: "1".repeat(64) }] });
  await assert.rejects(resolveManifest(file, { env: {}, cacheDir, fetchUrl }), /sha256 is [0-9a-f]{64}, the manifest expects 1{64}/);
  await assert.rejects(
    resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache2"), fetchUrl: async () => Promise.reject(new Error("HTTP 403 from Cloud Storage")) }),
    /could not download it \(HTTP 403 from Cloud Storage\)/,
  );
  assert.throws(() => parseManifest({ version: 1, extensions: [{ url }] }, file), /sha256/);
  assert.throws(() => parseManifest({ version: 1, extensions: [{ url: "http://plain.example.com/x.tgz", sha256: sha256(bytes) }] }, file), /url is gs:\/\/bucket\/object or https:/);
  assert.throws(() => parseManifest({ version: 1, extensions: [{ url, path: "x", sha256: sha256(bytes) }] }, file), /exactly one/);
});

test("what extensions declare they need is checked before a host starts, and every gap is named at once", async () => {
  const root = scratch();
  const brain = fixture(root, "@marshal/brain", "0.4.0");
  const studio = declaring(fixture(root, "@test/studio", "0.2.0"), {
    dependencies: { extensions: [{ id: "@marshal/brain" }, { id: "@test/helper", version: "2.0.0" }] },
    configuration: { schema: { type: "object", properties: { apiKey: { type: "string" }, region: { type: "string" } }, required: ["apiKey", "region"] }, defaults: { region: "us" } },
  });
  const helper = fixture(root, "@test/helper", "1.0.0");
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, {
    version: 1,
    defaults: false,
    extensions: [{ path: path.relative(root, studio), configuration: { token: "${env:STUDIO_TOKEN}" } }, { path: path.relative(root, helper) }],
  });
  const failure = await resolveManifest(file, { env: {} }).then(
    () => assert.fail("resolved"),
    (error: Error) => error.message,
  );
  assert.match(failure, /cannot start a host:/);
  assert.match(failure, /environment variable STUDIO_TOKEN is not set/);
  assert.match(failure, /@test\/studio@0\.2\.0 needs the extension @marshal\/brain, which this host does not load\./);
  assert.match(failure, /@test\/studio@0\.2\.0 needs @test\/helper@2\.0\.0; this host loads 1\.0\.0\./);
  assert.match(failure, /needs the setting "apiKey" in its configuration/);
  assert.doesNotMatch(failure, /"region"/, "a default counts as given");

  // The kit's Brain satisfies the dependency; a configured key satisfies the setting.
  declaring(studio, { dependencies: { extensions: [{ id: "@marshal/brain" }] } });
  writeManifest(file, {
    version: 1,
    defaults: false,
    kit: ["brain"],
    extensions: [{ path: path.relative(root, studio), configuration: { apiKey: "${env:STUDIO_TOKEN}" } }],
  });
  const resolved = await resolveManifest(file, { env: { STUDIO_TOKEN: "t", MARSHAL_SDK_BRAIN_PACKAGE: brain } });
  assert.deepEqual(resolved.extensions.map((extension) => extension.identity), ["@test/studio"]);

  // The host checks the same, for extensions given to it directly, and loads dependencies first.
  assert.deepEqual(unmetRequirements([{ packageRoot: studio, configuration: { apiKey: "k" } }]), [
    "@test/studio@0.2.0 needs the extension @marshal/brain, which this host does not load.",
  ]);
  assert.deepEqual(dependencyOrder([{ packageRoot: studio }, { packageRoot: brain }]).map((subject) => subject.packageRoot), [brain, studio]);
  fs.mkdirSync(path.join(root, "ws"));
  await assert.rejects(
    createMarshalHost({ workspacePath: path.join(root, "ws"), stateRoot: path.join(root, "state"), browser: false, env: {}, extensions: [{ packageRoot: studio, configuration: { apiKey: "k" } }] }),
    /This host cannot start; its extensions need:\n  - @test\/studio@0\.2\.0 needs the extension @marshal\/brain/,
  );
});

test("a brain block names the Brain by index and the sign-in; the kit carries it, with no address in the file", async () => {
  const root = scratch();
  const brain = fixture(root, "@marshal/brain", "0.4.0");
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, defaults: false, kit: ["memory"], brain: { index: "zyg", auth: "service" }, extensions: [] });
  assert.deepEqual(readManifest(file).brain, { index: "zyg", auth: "service" });
  const resolved = await resolveManifest(file, { env: { MARSHAL_SDK_BRAIN_PACKAGE: brain } });
  const kit = resolved.kit as { parts: string[]; brain: { cloudUrl: string; callerMode: string } };
  assert.deepEqual(kit.parts, ["brain", "memory"]);
  assert.equal(kit.brain.callerMode, "delegated");
  assert.match(kit.brain.cloudUrl, /^https:\/\/zyg-agents-front-/);
  assert.equal(brainKitOptions({ auth: "person" }).callerMode, "desktop");
  assert.equal(brainKitOptions({ index: "team-x", url: "https://brain.example.com" }).cloudUrl, "https://brain.example.com");
  assert.throws(() => brainKitOptions({ index: "team-x" }, file), /no Brain named "team-x" \(known: zyg\); give its address as brain\.url/);
  assert.throws(() => parseManifest({ version: 1, brain: { auth: "robot" } }, file), /auth/);
});

test("the sample agent-sandbox manifest is valid and names no Brain address", () => {
  const file = path.join(import.meta.dirname, "..", "..", "examples", "zyg-agent-sandbox", "marshal-sdk.json");
  const sample = fs.existsSync(file) ? file : path.join(import.meta.dirname, "..", "examples", "zyg-agent-sandbox", "marshal-sdk.json");
  const manifest = readManifest(sample);
  assert.deepEqual(manifest.brain, { index: "zyg", auth: "service" });
  assert.match(manifest.extensions[0]!.url ?? "", /^gs:\/\/shop-builder-local-runs\/marshal-extensions\/@zyg\/page-studio\/\d+\.\d+\.\d+\.tgz$/);
  assert.equal(brainKitOptions(manifest.brain!, sample, {}).callerMode, "delegated");
  assert.equal(brainKitOptions(manifest.brain!, sample, { GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}' }).callerMode, "service-key");
});

test("check proves a manifest by starting its host: a report of what loaded and from where, or every problem", async () => {
  const root = scratch();
  const packageRoot = fixture(root, "@test/checked", "1.2.0");
  const file = path.join(root, "marshal-sdk.json");
  writeManifest(file, { version: 1, defaults: false, model: "claude-opus-5-5", extensions: [{ path: path.relative(root, packageRoot), configuration: { key: "${env:CHECK_KEY}" } }] });
  const report = await checkManifest({ manifest: file, env: { CHECK_KEY: "k" } });
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.deepEqual(report.extensions.map((extension) => [extension.identity, extension.version, extension.source]), [["@test/checked", "1.2.0", "path"]]);
  assert.equal(report.model, "claude-opus-5-5");
  const failed = await checkManifest({ manifest: file, env: {} });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.problems, [`${path.relative(root, packageRoot)} configuration: environment variable CHECK_KEY is not set.`]);
  assert.match((await checkManifest({ env: {} })).problems[0] ?? "", /No marshal-sdk\.json/);
});

test("auth service signs with a service account key when the host has one (E2B), else with the metadata server", () => {
  const root = scratch();
  const file = path.join(root, "marshal-sdk.json");
  const serviceKey = path.join(root, "sa.json");
  fs.writeFileSync(serviceKey, JSON.stringify({ type: "service_account", client_email: "e2b-production@zyg-ecom-prod.iam.gserviceaccount.com" }));
  const userCredentials = path.join(root, "adc.json");
  fs.writeFileSync(userCredentials, JSON.stringify({ type: "authorized_user" }));
  const service = { auth: "service" as const };
  assert.equal(brainKitOptions(service, file, {}).callerMode, "delegated", "Cloud Run, GKE, a GCE VM: the metadata server");
  assert.equal(brainKitOptions(service, file, { GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}' }).callerMode, "service-key", "E2B carries the key inline");
  assert.equal(brainKitOptions(service, file, { GOOGLE_APPLICATION_CREDENTIALS: serviceKey }).callerMode, "service-key");
  assert.equal(brainKitOptions(service, file, { GOOGLE_APPLICATION_CREDENTIALS: userCredentials }).callerMode, "delegated", "a person's ADC file is not a service key");
  assert.equal(brainKitOptions({ auth: "person" }, file, { GOOGLE_APPLICATION_CREDENTIALS_JSON: "{}" }).callerMode, "desktop");

  const declared = parseManifest({ version: 1, brain: { auth: "service", credentialsFile: "sa.json" } }, file).brain!;
  const options = brainKitOptions(declared, file, {});
  assert.deepEqual([options.callerMode, options.credentialsFile], ["service-key", serviceKey]);
  assert.throws(() => brainKitOptions({ auth: "service", credentialsFile: "adc.json" }, file, {}), /is not a service_account key file/);
  assert.throws(() => parseManifest({ version: 1, brain: { auth: "person", credentialsFile: "sa.json" } }, file), /credentialsFile/);

  const configuration = brainConfiguration({ brain: { ...options, callerEmail: "omer@zyg.com" }, workspaceName: "ws", memoryWrites: false });
  assert.equal(configuration.cloudCallerMode, "service-key");
  assert.equal(configuration.cloudCredentialsFile, serviceKey);
});
