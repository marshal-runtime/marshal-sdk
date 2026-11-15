import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../electron/platform-security", async () => {
  const { writeFileSync: write } = await import("node:fs");
  return { secureAtomicWriteFileSync: (target: string, data: string) => write(target, data) };
});
vi.mock("../../../electron/safe-storage-file", () => ({ loadOrCreateKey: () => null }));

import { testDouble } from "../../../electron/testing/harness";
import type { OrgOnboardingManifest } from "./common/org-onboarding";
import { createOrgExtensionAdmission, createOrgTrustedExtensions } from "./org-extension-admission";
import { OrgOnboarding, type OrgOnboardingDeps } from "./org-onboarding";
import { sha256Hex } from "./org-onboarding-archive";

type Runtime = OrgOnboardingDeps["runtime"];
type RuntimeRecord = (Awaited<ReturnType<Runtime["listExtensions"]>> & {
  ok: true;
})["value"][number];
const scope = { sessionId: "s", workspaceName: "w" };
const INTEGRITY = "e".repeat(64);
const GUARDED = "@marshal/vault";

function tarFile(name: string, body: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  const data = Buffer.from(body);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}
const archive = gzipSync(tarFile("runtime-extension.json", "{}"));

function world(identity: string, origin: "org" | "published" | undefined) {
  const manifest: OrgOnboardingManifest = {
    version: 1,
    welcome: { title: "t", points: [], starterPrompts: [] },
    extensions: [
      {
        id: identity,
        version: "1.0.0",
        tier: "available",
        title: "X",
        why: "w",
        ...(origin ? { origin } : {}),
        delivery: { kind: "archive", sha256: sha256Hex(archive), bytes: archive.length },
      },
    ],
  };
  const trusted = createOrgTrustedExtensions(
    path.join(mkdtempSync(path.join(tmpdir(), "pub-")), "t.json"),
    {
      getKey: () => Buffer.alloc(32, 7),
    },
  );
  const guarded = (id: string) => id === GUARDED;
  const admit = createOrgExtensionAdmission({ isGuarded: guarded, trusted, bundled: [] });
  const ok = <T>(value: T) => ({ ok: true as const, receipts: [], value });
  const runtime = {
    listExtensions: vi.fn<Runtime["listExtensions"]>(async () => ok([])),
    installLocalExtension: vi.fn<Runtime["installLocalExtension"]>(async () =>
      ok(testDouble<RuntimeRecord>({ identity, status: "enabled" })),
    ),
    enableExtension: vi.fn<Runtime["enableExtension"]>(),
    removeExtension: vi.fn<Runtime["removeExtension"]>(),
    configureExtension: vi.fn<Runtime["configureExtension"]>(),
    invoke: vi.fn<Runtime["invoke"]>(),
  };
  const downloadArchive = vi.fn<OrgOnboardingDeps["downloadArchive"]>(
    async () => new Uint8Array(archive),
  );
  const service = new OrgOnboarding({
    getFlag: () => true,
    getOrg: async () => ({ features: ["onboarding"], apiBase: "https://o/api" }),
    requestJson: async () => manifest,
    downloadArchive,
    runtime: testDouble<Runtime>(runtime),
    trust: (id, integrity) => trusted.trust(id, integrity),
    isOrgServiceIdentity: guarded,
    computeIntegrity: () => INTEGRITY,
  });
  return { service, admit, trusted, runtime, downloadArchive };
}

describe("published extensions and org-service admission", () => {
  it("refuses a published extension that claims an allowlisted identity before it is even downloaded", async () => {
    const { service, runtime, downloadArchive, trusted, admit } = world(GUARDED, "published");
    const result = await service.install(scope, [GUARDED]);
    expect(result).toMatchObject({ results: [{ id: GUARDED, ok: false }] });
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(runtime.installLocalExtension).not.toHaveBeenCalled();
    expect(trusted.isTrusted(GUARDED, INTEGRITY)).toBe(false);
    expect(admit({ identity: GUARDED, integrity: { value: INTEGRITY } })).toMatch(
      /neither bundled/,
    );
  });

  it("never records trust for a published archive, so the host admission still refuses its identity if it got that far", async () => {
    const { service, trusted, admit } = world("@ann/tool", "published");
    await service.install(scope, ["@ann/tool"]);
    expect(trusted.isTrusted("@ann/tool", INTEGRITY)).toBe(false);
    expect(admit({ identity: GUARDED, integrity: { value: INTEGRITY } })).toMatch(
      /neither bundled/,
    );
  });

  it("still vouches for an org-owned archive, so the org's own allowlisted extensions keep loading", async () => {
    const { service, trusted, admit } = world(GUARDED, "org");
    await service.install(scope, [GUARDED]);
    expect(trusted.isTrusted(GUARDED, INTEGRITY)).toBe(true);
    expect(admit({ identity: GUARDED, integrity: { value: INTEGRITY } })).toBeUndefined();
  });

  it("fails closed: an entry with no origin label gets no trust and cannot claim an allowlisted identity", async () => {
    const plain = world("@ann/tool", undefined);
    await plain.service.install(scope, ["@ann/tool"]);
    expect(plain.trusted.isTrusted("@ann/tool", INTEGRITY)).toBe(false);
    const claiming = world(GUARDED, undefined);
    const result = await claiming.service.install(scope, [GUARDED]);
    expect(result).toMatchObject({ results: [{ id: GUARDED, ok: false }] });
    expect(claiming.downloadArchive).not.toHaveBeenCalled();
    expect(claiming.trusted.isTrusted(GUARDED, INTEGRITY)).toBe(false);
  });
});
