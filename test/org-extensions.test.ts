import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { OrgCatalogEntry, OrgExtensionCatalog } from "@marshal/agent-runtime-org";

import { resolveManifest, writeManifest } from "../src/onboarding.js";
import { orgExtensionResolver } from "../src/org-extensions.js";

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-org-ext-")));
}

function packed(root: string, identity: string, version: string): Buffer {
  const packageRoot = path.join(root, `${identity.replace("/", "__")}-${version}`, "package");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "runtime-extension.json"), JSON.stringify({ schemaVersion: 1, identity, version, entrypoint: "dist/index.cjs", moduleFormat: "commonjs-bundle-v1", contributes: {} }));
  fs.writeFileSync(path.join(packageRoot, "dist/index.cjs"), "module.exports = { activate() { return {}; } };");
  const out = path.join(root, `${identity.replace("/", "__")}-${version}.tgz`);
  execFileSync("tar", ["-czf", out, "-C", path.dirname(packageRoot), "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.readFileSync(out);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function entry(id: string, version: string, archive: Buffer | undefined, extra: Partial<OrgCatalogEntry> = {}): OrgCatalogEntry {
  return {
    id,
    version,
    tier: "available",
    title: id,
    why: "test",
    status: "approved",
    delivery: archive ? { kind: "archive", url: `/v1/onboarding/extensions/${id}/${version}.tgz`, sha256: sha256(archive), bytes: archive.length } : { kind: "bundled" },
    ...extra,
  } as OrgCatalogEntry;
}

test("the org resolver: approved catalog entries, archives with the person's token from the API origin, bundled ones from the host", async () => {
  const root = scratch();
  const archives = new Map<string, Buffer>([
    ["@zyg/a/1.0.0", packed(root, "@zyg/a", "1.0.0")],
    ["@zyg/a/1.1.0", packed(root, "@zyg/a", "1.1.0")],
    ["@zyg/b/2.0.0", packed(root, "@zyg/b", "2.0.0")],
  ]);
  const tokens: string[] = [];
  const server = http.createServer((request, response) => {
    tokens.push(String(request.headers.authorization));
    const match = /^\/api\/v1\/onboarding\/extensions\/(@[^/]+\/[^/]+)\/([^/]+)\.tgz$/.exec(decodeURIComponent(request.url ?? ""));
    const bytes = match && archives.get(`${match[1]}/${match[2]}`);
    if (request.headers.authorization !== "Bearer person-token" || !bytes) response.writeHead(request.headers.authorization === "Bearer person-token" ? 404 : 401).end();
    else response.writeHead(200, { "content-type": "application/gzip" }).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const bundledRoot = path.join(root, "bundled-c");
  fs.mkdirSync(bundledRoot);
  fs.writeFileSync(path.join(bundledRoot, "runtime-extension.json"), JSON.stringify({ identity: "@zyg/c", version: "3.0.0" }));
  const catalog: OrgExtensionCatalog = {
    version: 1,
    isAdmin: false,
    recommended: [entry("@zyg/a", "1.1.0", archives.get("@zyg/a/1.1.0")), entry("@zyg/c", "3.0.0", undefined)],
    available: [
      entry("@zyg/a", "1.0.0", archives.get("@zyg/a/1.0.0")),
      entry("@zyg/b", "2.0.0", archives.get("@zyg/b/2.0.0")),
      entry("@zyg/mine", "0.1.0", archives.get("@zyg/b/2.0.0"), { status: "pending" }),
      entry("@zyg/elsewhere", "1.0.0", archives.get("@zyg/b/2.0.0"), { delivery: { kind: "archive", url: "https://evil.example.com/x.tgz", sha256: "0".repeat(64), bytes: 1 } }),
      entry("@zyg/tampered", "1.0.0", archives.get("@zyg/b/2.0.0"), { delivery: { kind: "archive", url: "/v1/onboarding/extensions/@zyg/b/2.0.0.tgz", sha256: "f".repeat(64), bytes: archives.get("@zyg/b/2.0.0")!.length } }),
    ],
    pending: [],
  };
  let catalogCalls = 0;
  const client = {
    discovery: { apiBase } as never,
    supports: (feature: string) => feature === "onboarding",
    getExtensionCatalog: async () => {
      catalogCalls += 1;
      return catalog;
    },
  };
  const resolver = orgExtensionResolver({ client, accessToken: async () => "person-token", bundled: (id) => (id === "@zyg/c" ? bundledRoot : undefined) });
  const org = { discovery: "https://org.example.com" };
  try {
    assert.deepEqual(await resolver.admitted(org), [
      { id: "@zyg/a", version: "1.1.0" },
      { id: "@zyg/c", version: "3.0.0" },
      { id: "@zyg/b", version: "2.0.0" },
      { id: "@zyg/elsewhere", version: "1.0.0" },
      { id: "@zyg/tampered", version: "1.0.0" },
    ], "the newest approved version of each; pending entries are not admitted");

    const latest = await resolver.fetch({ org, id: "@zyg/a" });
    assert.equal(latest.version, "1.1.0");
    assert.ok("archive" in latest && sha256(Buffer.from(latest.archive)) === sha256(archives.get("@zyg/a/1.1.0")!));
    assert.equal((await resolver.fetch({ org, id: "@zyg/a", version: "1.0.0" })).version, "1.0.0");
    assert.deepEqual(await resolver.fetch({ org, id: "@zyg/c" }), { id: "@zyg/c", version: "3.0.0", packageRoot: bundledRoot });
    assert.ok(tokens.every((token) => token === "Bearer person-token"));
    assert.equal(catalogCalls, 1, "the catalog is read once per resolver");

    await assert.rejects(resolver.fetch({ org, id: "@zyg/a", version: "9.0.0" }), /@zyg\/a@9\.0\.0 is not among the organization's approved extensions \(it admits 1\.1\.0, 1\.0\.0\)/);
    await assert.rejects(resolver.fetch({ org, id: "@zyg/mine" }), /not among the organization's approved extensions/);
    await assert.rejects(resolver.fetch({ org, id: "@zyg/elsewhere" }), /not on the organization's API origin/);
    await assert.rejects(resolver.fetch({ org, id: "@zyg/tampered" }), /does not match the size and sha256/);
    const noToken = orgExtensionResolver({ client, accessToken: async () => "wrong" });
    await assert.rejects(noToken.fetch({ org, id: "@zyg/b" }), /HTTP 401/);
    await assert.rejects(noToken.fetch({ org, id: "@zyg/c" }), /this host has no copy/);
    const unsupported = orgExtensionResolver({ client: { ...client, supports: () => false }, accessToken: async () => "person-token" });
    await assert.rejects(unsupported.admitted(org), /no "onboarding" feature/);

    // End to end: a manifest that names the org loads what its profile admits, unpacked and checked.
    const file = path.join(root, "marshal-sdk.json");
    writeManifest(file, {
      version: 1,
      org: { discovery: "https://org.example.com", profile: { allow: ["@zyg/a", "@zyg/b", "@zyg/c"], deny: ["@zyg/c"] } },
      defaults: false,
      extensions: [{ id: "@zyg/a", version: "1.0.0" }],
    });
    const resolved = await resolveManifest(file, { env: {}, cacheDir: path.join(root, "cache"), resolver });
    assert.deepEqual(resolved.extensions.map((extension) => [extension.identity, extension.version, extension.origin]), [
      ["@zyg/a", "1.0.0", "listed"],
      ["@zyg/b", "2.0.0", "org-profile"],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
