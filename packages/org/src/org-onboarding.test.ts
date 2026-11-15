import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import type { OrgOnboardingManifest } from "./common/org-onboarding";
import { OrgOnboarding, interpretConnected, type OrgOnboardingDeps } from "./org-onboarding";
import { sha256Hex } from "./org-onboarding-archive";

type Runtime = OrgOnboardingDeps["runtime"];

const scope = { sessionId: "s", workspaceName: "w" };

function tarFile(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const data = Buffer.from(body);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

const archive = gzipSync(tarFile("package/runtime-extension.json", "{}"));
const manifest: OrgOnboardingManifest = {
  version: 1,
  welcome: { title: "t", points: [], starterPrompts: [] },
  dailySignIn: {
    kind: "google-gcloud",
    extension: "@a/arch",
    capability: "a_signin",
    defaultTime: "08:30",
  },
  extensions: [
    {
      id: "@a/arch",
      version: "1.0.0",
      tier: "recommended",
      origin: "org",
      title: "A",
      why: "w",
      delivery: {
        kind: "archive",
        sha256: sha256Hex(archive),
        bytes: archive.length,
      },
      connect: [{ capability: "a.connect", label: "Connect", statusCapability: "a.status" }],
    },
    {
      id: "@a/bundled",
      version: "1.0.0",
      tier: "recommended",
      title: "B",
      why: "w",
      delivery: { kind: "bundled" },
    },
  ],
};

function setup(over: Partial<OrgOnboardingDeps> = {}, features = ["onboarding"]) {
  const installed = new Map<string, "enabled" | "disabled">([["@a/bundled", "disabled"]]);
  const ok = <T>(value: T) => ({ ok: true as const, receipts: [], value });
  type ExtensionRecord = (Awaited<ReturnType<Runtime["listExtensions"]>> & {
    ok: true;
  })["value"][number];
  const record = (identity: string, status: "enabled" | "disabled") =>
    testDouble<ExtensionRecord>({ identity, status });
  const runtime = {
    listExtensions: vi.fn<Runtime["listExtensions"]>(async () =>
      ok([...installed].map(([identity, status]) => record(identity, status))),
    ),
    installLocalExtension: vi.fn<Runtime["installLocalExtension"]>(async () => {
      installed.set("@a/arch", "disabled");
      return ok(record("@a/arch", "disabled"));
    }),
    enableExtension: vi.fn<Runtime["enableExtension"]>(async (request) => {
      installed.set(request.identity, "enabled");
      return ok(record(request.identity, "enabled"));
    }),
    updateExtension: vi.fn<Runtime["updateExtension"]>(async (request) =>
      ok(record(request.identity, "enabled")),
    ),
    removeExtension: vi.fn<Runtime["removeExtension"]>(),
    configureExtension: vi.fn<Runtime["configureExtension"]>(async (request) =>
      ok(record(request.identity, "enabled")),
    ),
    invoke: vi.fn<Runtime["invoke"]>(async () =>
      testDouble<Awaited<ReturnType<Runtime["invoke"]>>>(ok({ output: { connected: true } })),
    ),
  };
  const downloadArchive = vi.fn<OrgOnboardingDeps["downloadArchive"]>(
    async () => new Uint8Array(archive),
  );
  const service = new OrgOnboarding({
    getFlag: () => true,
    getOrg: async () => ({
      orgId: "acme",
      orgUrl: "https://o",
      features,
      apiBase: "https://o/api",
    }),
    requestJson: async () => manifest,
    downloadArchive,
    runtime: testDouble<Runtime>(runtime),
    ...over,
  });
  return { service, runtime, downloadArchive };
}

describe("OrgOnboarding", () => {
  it("uses the server manifest when the org lists onboarding", async () => {
    expect((await setup().service.getManifest()).success).toBe(true);
  });

  it("asks the org API for /v1/onboarding, like every other org route", async () => {
    const requestJson = vi.fn<OrgOnboardingDeps["requestJson"]>(async () => manifest);
    await setup({ requestJson }).service.getManifest();
    expect(requestJson).toHaveBeenCalledWith("/v1/onboarding");
  });

  it("is not offered when the org does not list onboarding", async () => {
    const { service } = setup({}, []);
    expect(await service.getManifest()).toEqual({ success: false, error: "no-onboarding" });
    expect(await service.install(scope, ["@a/arch"])).toMatchObject({ results: [{ ok: false }] });
  });

  it("is inert with the flag off", async () => {
    const { service } = setup({ getFlag: () => false });
    expect(await service.getManifest()).toEqual({ success: false, error: "disabled" });
  });

  it("downloads, verifies, installs and enables an archive; enables a bundled extension", async () => {
    const { service, runtime, downloadArchive } = setup();
    const result = await service.install(scope, ["@a/arch", "@a/bundled"]);
    expect(result).toEqual({
      success: true,
      results: [
        { id: "@a/arch", ok: true },
        { id: "@a/bundled", ok: true },
      ],
    });
    expect(downloadArchive).toHaveBeenCalledWith(
      "https://o/api/v1/onboarding/extensions/@a/arch/1.0.0.tgz",
      archive.length,
    );
    expect(runtime.installLocalExtension).toHaveBeenCalledOnce();
    expect(runtime.enableExtension).toHaveBeenCalledTimes(2);
  });

  it("skips an archive already installed at the same or a newer version, and updates an older one", async () => {
    const installedAt = (version: string) =>
      testDouble<Awaited<ReturnType<Runtime["listExtensions"]>>>({
        ok: true,
        receipts: [],
        value: [{ identity: "@a/arch", status: "enabled", version }],
      });
    const skipped = await Promise.all(
      ["1.0.0", "1.2.0"].map(async (version) => {
        const fixture = setup();
        fixture.runtime.listExtensions.mockResolvedValue(installedAt(version));
        return { fixture, result: await fixture.service.install(scope, ["@a/arch"]) };
      }),
    );
    for (const { fixture, result } of skipped) {
      expect(result).toMatchObject({ results: [{ ok: true }] });
      expect(fixture.downloadArchive).not.toHaveBeenCalled();
      expect(fixture.runtime.installLocalExtension).not.toHaveBeenCalled();
    }
    const { service, runtime } = setup();
    runtime.listExtensions.mockResolvedValue(installedAt("0.9.0"));
    expect(await service.install(scope, ["@a/arch"])).toMatchObject({ results: [{ ok: true }] });
    expect(runtime.updateExtension).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "@a/arch" }),
    );
    expect(runtime.installLocalExtension).not.toHaveBeenCalled();
  });

  it("installs archive extensions before bundled ones that may depend on them", async () => {
    const { service } = setup();
    const result = await service.install(scope, ["@a/bundled", "@a/arch"]);
    expect(result).toMatchObject({ results: [{ id: "@a/arch" }, { id: "@a/bundled" }] });
  });

  it("installs from a canonical path even when the temp root is reached through a symlink", async () => {
    const real = realpathSync(mkdtempSync(path.join(os.tmpdir(), "onboard-real-")));
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), "onboard-link-")), "tmp");
    symlinkSync(real, link);
    mkdirSync(real, { recursive: true });
    const { service, runtime } = setup({ tempRoot: () => link });
    await service.install(scope, ["@a/arch"]);
    const request = runtime.installLocalExtension.mock.calls[0]?.[0];
    expect(request?.packageRoot.startsWith(real)).toBe(true);
  });

  it("refuses an archive hosted outside the org API origin and never downloads it", async () => {
    const hosted = {
      ...manifest,
      extensions: [
        {
          ...manifest.extensions[0],
          delivery: {
            kind: "archive",
            url: "https://evil.example/a.tgz",
            sha256: sha256Hex(archive),
            bytes: archive.length,
          },
        },
      ],
    };
    const { service, downloadArchive } = setup({ requestJson: async () => hosted });
    expect(await service.install(scope, ["@a/arch"])).toMatchObject({
      results: [{ ok: false, error: "archive host not trusted" }],
    });
    expect(downloadArchive).not.toHaveBeenCalled();
  });

  it("allows the manifest's daily capability in the vault configuration before scheduling", async () => {
    const { service, runtime } = setup();
    runtime.listExtensions.mockResolvedValue(
      testDouble<Awaited<ReturnType<Runtime["listExtensions"]>>>({
        ok: true,
        receipts: [],
        value: [
          { identity: "@marshal/vault", status: "enabled", configuration: { headless: true } },
        ],
      }),
    );
    await service.runVaultCapability(scope, "googleSignin.schedule", { time: "08:30" });
    expect(runtime.configureExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: "@marshal/vault",
        configuration: { headless: true, allowedDailyCapabilities: ["a_signin"] },
      }),
    );
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "googleSignin.schedule" }),
    );
  });

  it("trusts the package integrity only after the archive checks out, and before installing", async () => {
    const order: string[] = [];
    const trust = vi.fn<NonNullable<OrgOnboardingDeps["trust"]>>(() => {
      order.push("trust");
    });
    const { service, runtime } = setup({ trust, computeIntegrity: () => "f".repeat(64) });
    runtime.installLocalExtension.mockImplementationOnce(async () => {
      order.push("install");
      return {
        ok: true as const,
        receipts: [],
        value: testDouble<never>({ identity: "@a/arch", status: "enabled" }),
      };
    });
    await service.install(scope, ["@a/arch"]);
    expect(trust).toHaveBeenCalledWith("@a/arch", "f".repeat(64));
    expect(order).toEqual(["trust", "install"]);

    const bad = setup({
      trust,
      computeIntegrity: () => "f".repeat(64),
      downloadArchive: async () => new Uint8Array(archive.length),
    });
    trust.mockClear();
    await bad.service.install(scope, ["@a/arch"]);
    expect(trust).not.toHaveBeenCalled();
  });

  it("refuses an archive whose checksum does not match", async () => {
    const { service, runtime } = setup({
      downloadArchive: async () => new Uint8Array(archive.length),
    });
    const result = await service.install(scope, ["@a/arch"]);
    expect(result).toMatchObject({
      results: [{ ok: false, error: expect.stringContaining("checksum") }],
    });
    expect(runtime.installLocalExtension).not.toHaveBeenCalled();
  });

  it("reports installed and connected from status capabilities", async () => {
    const { service } = setup();
    await service.install(scope, ["@a/arch"]);
    const status = await service.status(scope);
    expect(status).toEqual({
      success: true,
      extensions: [
        { id: "@a/arch", installed: true, connected: [true] },
        { id: "@a/bundled", installed: false, connected: [] },
      ],
    });
  });

  it("asks for a status read grant before the forbidden poll, and still polls when refused", async () => {
    const allowStatusRead = vi.fn<NonNullable<OrgOnboardingDeps["allowStatusRead"]>>(
      async () => false,
    );
    const { service, runtime } = setup({ allowStatusRead });
    await service.install(scope, ["@a/arch"]);
    await service.status(scope);
    expect(allowStatusRead).toHaveBeenCalledWith(
      { sessionId: "s", workspaceName: "w" },
      ["@a/arch", "@a/bundled"],
      "a.status",
    );
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "a.status", approvalPolicy: "forbid" }),
    );
  });

  it("sends the connect action's statusInput to the status read", async () => {
    const withInput: OrgOnboardingManifest = {
      ...manifest,
      extensions: [
        {
          ...manifest.extensions[0],
          connect: [
            {
              capability: "a.connect",
              label: "Connect",
              statusCapability: "a.status",
              statusInput: { provider: "x" },
            },
          ],
        },
        manifest.extensions[1],
      ],
    };
    const { service, runtime } = setup({ requestJson: async () => withInput });
    await service.install(scope, ["@a/arch"]);
    await service.status(scope);
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "a.status", input: { provider: "x" } }),
    );
  });

  it("only runs the listed connect capability and the vault allowlist", async () => {
    const { service, runtime } = setup();
    expect(await service.connect(scope, "@a/arch", 0)).toMatchObject({ success: true });
    expect(runtime.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "a.connect" }),
    );
    expect(await service.connect(scope, "@a/arch", 5)).toMatchObject({ success: false });
    expect(await service.runVaultCapability(scope, "shell.exec", {})).toMatchObject({
      success: false,
    });
    expect(await service.runVaultCapability(scope, "vault.status", undefined)).toMatchObject({
      success: true,
    });
    expect(await service.runVaultCapability(scope, "googleSignin.run", {})).toMatchObject({
      success: true,
    });
    expect(await service.runVaultCapability(scope, "a_signin", {})).toMatchObject({
      success: true,
    });
  });

  it.each([
    [
      "vault",
      "vault.status",
      {
        disabled: false,
        storage: "ready",
        purposes: [{ purpose: "google-daily-signin", hasSecret: true }],
      },
    ],
    [
      "coder",
      "coder.status",
      { cli: { installed: true }, signedIn: true, workspaces: [], notes: [] },
    ],
    ["github-core", "github.accounts.list", { accounts: [{ login: "octo" }] }],
    ["zyg", "zyg_connection_status", { status: "connected", message: "Connected" }],
    ["jev", "jev.status", { state: "connected", model: "gpt-5-mini" }],
    ["agentic-browser (jev.status)", "jev.status", { state: "connected" }],
  ])("reads %s as connected through the poll", async (_name, capability, payload) => {
    const withStatus: OrgOnboardingManifest = {
      ...manifest,
      extensions: [
        {
          ...manifest.extensions[0],
          connect: [
            {
              capability: "a.connect",
              label: "Connect",
              statusCapability: capability,
              statusInput: { provider: "slack" },
            },
          ],
        },
        manifest.extensions[1],
      ],
    };
    const { service, runtime } = setup({ requestJson: async () => withStatus });
    runtime.invoke.mockImplementation(async () =>
      testDouble<Awaited<ReturnType<Runtime["invoke"]>>>({
        ok: true,
        receipts: [],
        value: { output: payload },
      }),
    );
    await service.install(scope, ["@a/arch"]);
    const status = await service.status(scope);
    expect(status).toMatchObject({
      extensions: [{ id: "@a/arch", installed: true, connected: [true] }, {}],
    });
  });

  it.each([
    null,
    undefined,
    "x",
    3,
    [],
    {},
    { status: 7 },
    { accounts: "none" },
    { purposes: [null, 1] },
  ])("reads a malformed status payload %j as not connected without throwing", async (payload) => {
    const { service, runtime } = setup();
    runtime.invoke.mockImplementation(async () =>
      testDouble<Awaited<ReturnType<Runtime["invoke"]>>>({
        ok: true,
        receipts: [],
        value: { output: payload },
      }),
    );
    await service.install(scope, ["@a/arch"]);
    const status = await service.status(scope);
    expect(status).toMatchObject({
      extensions: [{ id: "@a/arch", installed: true, connected: [false] }, {}],
    });
  });

  it("interprets status outputs", () => {
    expect(interpretConnected({ connected: false })).toBe(false);
    expect(interpretConnected({ state: "connected" })).toBe(true);
    expect(interpretConnected("x")).toBe(false);
    expect(interpretConnected({ status: "setup-required" })).toBe(false);
    expect(interpretConnected({ status: "connected" })).toBe(true);
    expect(interpretConnected({ signedIn: false })).toBe(false);
    expect(interpretConnected({ accounts: [] })).toBe(false);
    expect(interpretConnected({ accounts: [{ login: "a" }] })).toBe(true);
    expect(interpretConnected({ purposes: [{ purpose: "p", hasSecret: false }] })).toBe(false);
    expect(interpretConnected({ purposes: [{ purpose: "p", hasSecret: true }] })).toBe(true);
  });
});
