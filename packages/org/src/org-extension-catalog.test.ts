import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import { OrgExtensionCatalog, type OrgExtensionCatalogDeps } from "./org-extension-catalog";
import { sha256Hex } from "./org-onboarding-archive";

type Runtime = OrgExtensionCatalogDeps["runtime"];
type Listed = Awaited<ReturnType<Runtime["listExtensions"]>>;
const scope = { sessionId: "s", workspaceName: "w" };
const SHA = "c".repeat(64);
const entry = (over: Record<string, unknown> = {}) => ({
  id: "@me/tool",
  version: "1.0.0",
  tier: "available",
  title: "Tool",
  why: "Helps",
  status: "approved",
  delivery: { kind: "archive", sha256: SHA, bytes: 10 },
  ...over,
});
const catalogBody = (isAdmin: boolean) => ({
  version: 1,
  isAdmin,
  recommended: [],
  available: [entry({ origin: "published", publisher: "ann@o.test", approver: "omer@o.test" })],
  pending: [entry({ id: "@me/new", status: "pending" })],
});

function setup(over: Partial<OrgExtensionCatalogDeps> = {}, features = ["extensionCatalog"]) {
  const trustedRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "org-catalog-")));
  const record = { identity: "@me/tool", version: "1.0.0", integrity: { value: "i" } };
  const requestJson = vi.fn<OrgExtensionCatalogDeps["requestJson"]>(async () => catalogBody(true));
  const uploadBytes = vi.fn<OrgExtensionCatalogDeps["uploadBytes"]>(async () =>
    entry({ status: "pending", origin: "published", publisher: "me@o.test" }),
  );
  const install = vi.fn<OrgExtensionCatalogDeps["install"]>(async () => undefined);
  const deps: OrgExtensionCatalogDeps = {
    getOrg: async () => ({ orgName: "Acme", features, apiBase: "https://o/api" }),
    requestJson,
    uploadBytes,
    runtime: testDouble<Runtime>({
      listExtensions: async () => testDouble<Listed>({ ok: true, receipts: [], value: [record] }),
    }),
    trustedExtensionRoot: () => trustedRoot,
    isBundled: (identity) => identity === "@marshal/bundled",
    isOrgServiceIdentity: (identity) => identity === "@marshal/vault",
    install,
    ...over,
  };
  const writeCopy = (integrity: string) => {
    const dir = path.join(trustedRoot, ".local-extension-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "runtime-extension.json"),
      JSON.stringify({ identity: "@me/tool", version: "1.0.0", note: integrity }),
    );
    writeFileSync(path.join(dir, "package.json"), "{}");
    return dir;
  };
  return {
    service: new OrgExtensionCatalog(deps),
    requestJson,
    uploadBytes,
    install,
    writeCopy,
    record,
  };
}

describe("OrgExtensionCatalog", () => {
  it("reads the catalog with its provenance and admin flag", async () => {
    const { service, requestJson } = setup();
    const result = await service.get();
    expect(requestJson).toHaveBeenCalledWith("GET", "/v1/onboarding/catalog");
    expect(result).toMatchObject({ success: true, orgName: "Acme" });
    if (!result.success) throw new Error("unreachable");
    expect(result.catalog.isAdmin).toBe(true);
    expect(result.catalog.available[0]).toMatchObject({
      publisher: "ann@o.test",
      approver: "omer@o.test",
    });
    expect(result.catalog.pending[0]?.status).toBe("pending");
  });

  it("marks installed entries by identity: current, update, newer and local build", async () => {
    const records = [
      { identity: "@me/same", version: "1.0.0", integrity: { value: "a" } },
      { identity: "@me/old", version: "0.9.0", integrity: { value: "b" } },
      { identity: "@me/ahead", version: "1.10.0", integrity: { value: "c" } },
      { identity: "@marshal/vault", version: "1.0.0", integrity: { value: "local" } },
    ];
    const { service, requestJson } = setup({
      runtime: testDouble<Runtime>({
        listExtensions: async () => testDouble<Listed>({ ok: true, receipts: [], value: records }),
      }),
      isTrusted: (identity, integrity) => identity === "@marshal/vault" && integrity === "org",
    });
    requestJson.mockResolvedValueOnce({
      version: 1,
      isAdmin: false,
      recommended: [
        entry({ id: "@me/same", origin: "org" }),
        entry({ id: "@me/old", origin: "org" }),
        entry({ id: "@me/ahead", version: "1.9.0", origin: "org" }),
        entry({ id: "@marshal/vault", origin: "org" }),
        entry({ id: "@me/missing", origin: "org" }),
      ],
      available: [],
      pending: [],
    });
    const result = await service.get(scope);
    if (!result.success) throw new Error("unreachable");
    expect(result.installed).toEqual({
      "@me/same": { version: "1.0.0", state: "current" },
      "@me/old": { version: "0.9.0", state: "update" },
      "@me/ahead": { version: "1.10.0", state: "newer" },
      "@marshal/vault": { version: "1.0.0", state: "local-build" },
    });
  });

  it("marks a pending entry that is installed, keeping an approved entry's state first", async () => {
    const records = [
      { identity: "@me/new", version: "0.1.0", integrity: { value: "a" } },
      { identity: "@me/both", version: "1.0.0", integrity: { value: "b" } },
    ];
    const { service, requestJson } = setup({
      runtime: testDouble<Runtime>({
        listExtensions: async () => testDouble<Listed>({ ok: true, receipts: [], value: records }),
      }),
    });
    requestJson.mockResolvedValueOnce({
      version: 1,
      isAdmin: true,
      recommended: [],
      available: [entry({ id: "@me/both", version: "1.0.0" })],
      pending: [
        entry({ id: "@me/new", version: "0.2.0", status: "pending" }),
        entry({ id: "@me/both", version: "2.0.0", status: "pending" }),
      ],
    });
    const result = await service.get(scope);
    if (!result.success) throw new Error("unreachable");
    expect(result.installed).toEqual({
      "@me/new": { version: "0.1.0", state: "update" },
      "@me/both": { version: "1.0.0", state: "current" },
    });
  });

  it("leaves install state out when no scope is given", async () => {
    const { service } = setup();
    const result = await service.get();
    expect(result.success && result.installed).toBeFalsy();
  });

  it("reports the server's 404 when the org does not serve the catalog", async () => {
    const { service, requestJson } = setup();
    requestJson.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "not-found" }));
    expect(await service.get()).toEqual({ success: false, error: "not-found" });
  });

  it("sends tier, pin and removal as PUT and surfaces the server's error code", async () => {
    const { service, requestJson } = setup();
    await service.update({ id: "@me/tool", tier: "recommended" });
    await service.update({ id: "@me/tool", version: "1.2.0" });
    await service.update({ id: "@me/tool", remove: true, tier: "available" });
    expect(requestJson.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      ["PUT", "/v1/onboarding/catalog/%40me%2Ftool", { tier: "recommended" }],
      ["PUT", "/v1/onboarding/catalog/%40me%2Ftool", { version: "1.2.0" }],
      ["PUT", "/v1/onboarding/catalog/%40me%2Ftool", { remove: true }],
    ]);
    requestJson.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "admin-only" }));
    expect(await service.update({ id: "@me/tool", remove: true })).toEqual({
      success: false,
      error: "admin-only",
    });
    expect(await service.update({ id: "bad", remove: true })).toEqual({
      success: false,
      error: "invalid-id",
    });
  });

  it("approves and rejects through the review route", async () => {
    const { service, requestJson } = setup();
    requestJson.mockResolvedValueOnce(entry({ status: "approved" }));
    const result = await service.review({ id: "@me/new", version: "1.0.0", decision: "approve" });
    expect(requestJson).toHaveBeenCalledWith(
      "POST",
      "/v1/onboarding/catalog/%40me%2Fnew/1.0.0/review",
      { decision: "approve" },
    );
    expect(result).toMatchObject({ success: true, entry: { status: "approved" } });
  });

  it("packs the installed copy and uploads it with its sha256 and metadata", async () => {
    const { service, uploadBytes, writeCopy, record } = setup();
    const dir = writeCopy("x");
    const integrity = (
      await import("@marshal/runtime/extensions")
    ).computeRuntimeExtensionIntegrity(dir).value;
    record.integrity.value = integrity;
    const result = await service.publish({
      scope,
      identity: "@me/tool",
      title: "My tool",
      why: "Does things",
    });
    expect(result).toMatchObject({ success: true, entry: { status: "pending" } });
    const [route, headers, bytes] = uploadBytes.mock.calls[0];
    expect(route).toBe("/v1/onboarding/catalog/publish");
    expect(headers).toMatchObject({
      "x-marshal-extension-id": "@me/tool",
      "x-marshal-extension-version": "1.0.0",
      "x-marshal-extension-title": encodeURIComponent("My tool"),
    });
    expect(headers["x-marshal-archive-sha256"]).toBe(sha256Hex(bytes));
  });

  it("previews the file list and size, and refuses to publish a copy that holds a secret", async () => {
    const { service, uploadBytes, writeCopy, record } = setup();
    const dir = writeCopy("x");
    const { computeRuntimeExtensionIntegrity } = await import("@marshal/runtime/extensions");
    writeFileSync(path.join(dir, ".env"), "TOKEN=1");
    record.integrity.value = computeRuntimeExtensionIntegrity(dir).value;
    const preview = await service.publishPreview({ scope, identity: "@me/tool" });
    expect(preview).toMatchObject({ success: true, version: "1.0.0", skipped: [] });
    if (!preview.success) throw new Error("unreachable");
    expect(preview.files.map((file) => file.path)).toEqual([
      "package.json",
      "runtime-extension.json",
    ]);
    expect(preview.totalBytes).toBe(preview.files.reduce((sum, file) => sum + file.bytes, 0));

    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist/a.js"), "-----BEGIN PRIVATE KEY-----");
    record.integrity.value = computeRuntimeExtensionIntegrity(dir).value;
    const refused = await service.publish({ scope, identity: "@me/tool", title: "t", why: "w" });
    expect(refused).toMatchObject({ success: false, error: "sensitive-content" });
    expect(JSON.stringify(refused)).not.toContain("BEGIN");
    expect(uploadBytes).not.toHaveBeenCalled();
  });

  it("will not publish a bundled extension, an org-service identity, or one that is not installed", async () => {
    const { service, uploadBytes } = setup();
    const base = { scope, title: "t", why: "w" };
    expect(await service.publish({ ...base, identity: "@marshal/bundled" })).toEqual({
      success: false,
      error: "bundled-extension",
    });
    expect(await service.publish({ ...base, identity: "@marshal/vault" })).toEqual({
      success: false,
      error: "org-service-extension",
    });
    expect(await service.publish({ ...base, identity: "@me/other" })).toEqual({
      success: false,
      error: "not-installed",
    });
    expect(uploadBytes).not.toHaveBeenCalled();
  });

  it("lists only installed extensions that may be published", async () => {
    const { service } = setup({
      runtime: testDouble<Runtime>({
        listExtensions: async () =>
          testDouble<Listed>({
            ok: true,
            receipts: [],
            value: [
              { identity: "@me/tool", version: "1.0.0" },
              { identity: "@marshal/vault", version: "1.0.0" },
              { identity: "@marshal/bundled", version: "1.0.0" },
            ],
          }),
      }),
    });
    expect(await service.publishable(scope)).toEqual({
      success: true,
      extensions: [{ identity: "@me/tool", version: "1.0.0" }],
    });
  });

  it("installs a catalog entry through the shared install path", async () => {
    const { service, install } = setup();
    const result = await service.installEntry(scope, "@me/tool", "1.0.0");
    expect(result).toEqual({ success: true, results: [{ id: "@me/tool", ok: true }] });
    expect(install).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ id: "@me/tool", origin: "published" }),
      "https://o/api",
    );
  });
});
