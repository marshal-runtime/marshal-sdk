import { describe, expect, it } from "vitest";

import {
  parseOrgCatalogEntry,
  parseOrgExtensionCatalog,
  parseOrgOnboardingManifest,
} from "./org-onboarding";

const sha = "a".repeat(64);
const valid = {
  version: 1,
  welcome: {
    title: "Set up",
    points: [
      { title: "A", body: "b" },
      { title: "", body: "bad" },
    ],
    starterPrompts: ["hi", 5],
  },
  extensions: [
    {
      id: "@acme/app",
      version: "1.0.0",
      tier: "recommended",
      title: "Jev",
      why: "fast",
      extra: "dropped",
      delivery: { kind: "archive", url: "/onboarding/x.tgz", sha256: sha.toUpperCase(), bytes: 10 },
      connect: [
        { capability: "app.connect", label: "Connect", statusCapability: "app.status" },
        { capability: "bad cap", label: "x" },
      ],
    },
    {
      id: "bad id!",
      version: "1.0.0",
      tier: "recommended",
      title: "t",
      why: "w",
      delivery: { kind: "bundled" },
    },
    {
      id: "@a/b",
      version: "1.0.0",
      tier: "weird",
      title: "t",
      why: "w",
      delivery: { kind: "bundled" },
    },
    {
      id: "@a/c",
      version: "1.0.0",
      tier: "available",
      title: "t",
      why: "w",
      delivery: { kind: "archive", url: "u", sha256: "short", bytes: 1 },
    },
    {
      id: "@a/d",
      version: "1.0.0",
      tier: "available",
      title: "t",
      why: "w",
      delivery: { kind: "unavailable" },
    },
  ],
  projects: { provider: "github", owner: "acme", preselect: ["app", 1], cloneRoot: "~/p" },
  dailySignIn: {
    kind: "google-gcloud",
    extension: "@acme/chat",
    capability: "x",
    defaultTime: "25:00",
  },
};

describe("parseOrgOnboardingManifest", () => {
  it("keeps valid entries, skips bad ones and drops unknown fields", () => {
    const manifest = parseOrgOnboardingManifest(valid);
    expect(manifest?.welcome.points).toEqual([{ title: "A", body: "b" }]);
    expect(manifest?.welcome.starterPrompts).toEqual(["hi"]);
    expect(manifest?.extensions.map((entry) => entry.id)).toEqual(["@acme/app"]);
    const first = manifest?.extensions[0];
    expect(first).not.toHaveProperty("extra");
    expect(first?.delivery).toEqual({
      kind: "archive",
      url: "/onboarding/x.tgz",
      sha256: sha,
      bytes: 10,
    });
    expect(first?.connect).toHaveLength(1);
    expect(manifest?.projects?.preselect).toEqual(["app"]);
    expect(manifest?.dailySignIn).toBeUndefined();
  });

  it("rejects wrong versions and shapes", () => {
    expect(parseOrgOnboardingManifest({ ...valid, version: 2 })).toBeUndefined();
    expect(parseOrgOnboardingManifest(null)).toBeUndefined();
    expect(parseOrgOnboardingManifest([])).toBeUndefined();
    expect(parseOrgOnboardingManifest({ version: 1 })).toBeUndefined();
  });

  it("requires the daily sign-in capability and extension", () => {
    const daily = {
      kind: "google-gcloud",
      extension: "@acme/chat",
      capability: "acme_signin",
      defaultTime: "08:30",
    };
    expect(parseOrgOnboardingManifest({ ...valid, dailySignIn: daily })?.dailySignIn).toEqual(
      daily,
    );
    const { capability: _omitted, ...withoutCapability } = daily;
    expect(
      parseOrgOnboardingManifest({ ...valid, dailySignIn: withoutCapability })?.dailySignIn,
    ).toBeUndefined();
    expect(
      parseOrgOnboardingManifest({ ...valid, dailySignIn: { ...daily, capability: "bad cap" } })
        ?.dailySignIn,
    ).toBeUndefined();
  });
});

describe("extension catalog", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: "@ann/tool",
    version: "1.0.0",
    tier: "available",
    title: "Tool",
    why: "Helps",
    status: "approved",
    origin: "published",
    publisher: "ann@o.test",
    approver: "omer@o.test",
    delivery: { kind: "archive", sha256: sha, bytes: 10 },
    ...over,
  });

  it("maps the legacy optional tier to available", () => {
    const manifest = parseOrgOnboardingManifest({
      ...valid,
      extensions: [{ ...valid.extensions[0], tier: "optional" }],
    });
    expect(manifest?.extensions[0]?.tier).toBe("available");
  });

  it("parses the catalog with publisher, approver and review state, and drops bad rows", () => {
    const catalog = parseOrgExtensionCatalog({
      version: 1,
      isAdmin: true,
      recommended: [],
      available: [entry(), entry({ id: "bad id" })],
      pending: [entry({ status: "pending", version: "1.1.0" }), entry({ status: "weird" })],
    });
    expect(catalog?.isAdmin).toBe(true);
    expect(catalog?.available).toHaveLength(1);
    expect(catalog?.available[0]).toMatchObject({
      origin: "published",
      publisher: "ann@o.test",
      approver: "omer@o.test",
    });
    expect(catalog?.pending.map((row) => row.status)).toEqual(["pending"]);
    expect(parseOrgExtensionCatalog({ version: 2 })).toBeUndefined();
    expect(parseOrgCatalogEntry(entry())?.id).toBe("@ann/tool");
  });

  it("keeps entries up to the server limits (256 title, 1024 why) instead of dropping them", () => {
    const catalog = parseOrgExtensionCatalog({
      version: 1,
      isAdmin: false,
      recommended: [],
      available: [],
      pending: [entry({ status: "pending", title: "t".repeat(256), why: "w".repeat(1024) })],
    });
    expect(catalog?.pending).toHaveLength(1);
    expect(catalog?.pending[0]?.why).toHaveLength(1024);
  });
});
