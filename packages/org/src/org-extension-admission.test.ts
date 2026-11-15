import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const writeFails = vi.hoisted(() => ({ value: false }));
vi.mock("../../../electron/platform-security", async () => {
  const { writeFileSync: write } = await import("node:fs");
  return {
    secureAtomicWriteFileSync: (target: string, data: string) => {
      if (writeFails.value) throw new Error("disk full");
      write(target, data);
    },
  };
});
vi.mock("../../../electron/safe-storage-file", () => ({ loadOrCreateKey: () => null }));

import {
  createOrgExtensionAdmission,
  createOrgTrustedExtensions,
  grandfatherCandidates,
} from "./org-extension-admission";

const GOOD = "a".repeat(64);
const OTHER = "b".repeat(64);
const getKey = () => Buffer.alloc(32, 7);
const file = () => path.join(mkdtempSync(path.join(tmpdir(), "org-trust-")), "t.json");

describe("org extension admission", () => {
  const make = (trustedFile = file()) => {
    const trusted = createOrgTrustedExtensions(trustedFile, { getKey });
    const admit = createOrgExtensionAdmission({
      isGuarded: (id) => id === "@marshal/vault",
      trusted,
      bundled: [{ identity: "@marshal/vault", integrity: { value: GOOD } }],
    });
    return { trusted, admit, trustedFile };
  };

  it("admits the bundled package and refuses a local package claiming the same identity", () => {
    const { admit } = make();
    expect(admit({ identity: "@marshal/vault", integrity: { value: GOOD } })).toBeUndefined();
    expect(admit({ identity: "@marshal/vault", integrity: { value: OTHER } })).toMatch(
      /neither bundled/,
    );
  });

  it("admits a package the org manifest vouched for, across a restart, for that identity only", () => {
    const { trusted, admit, trustedFile } = make();
    trusted.trust("@marshal/vault", OTHER);
    const again = createOrgExtensionAdmission({
      isGuarded: () => true,
      trusted: createOrgTrustedExtensions(trustedFile, { getKey }),
      bundled: [],
    });
    expect(again({ identity: "@marshal/vault", integrity: { value: OTHER } })).toBeUndefined();
    expect(
      again({ identity: "@zyg/marshal-runtime-extension", integrity: { value: OTHER } }),
    ).toMatch(/neither bundled/);
    expect(admit({ identity: "@marshal/vault", integrity: { value: OTHER } })).toBeUndefined();
    const envelope = JSON.parse(readFileSync(trustedFile, "utf8"));
    expect(JSON.parse(envelope.data)).toMatchObject({ trusted: { "@marshal/vault": [OTHER] } });
  });

  it("does not touch extensions that cannot use the org services", () => {
    const { admit } = make();
    expect(admit({ identity: "@random/tool", integrity: { value: OTHER } })).toBeUndefined();
  });

  it("rejects a malformed integrity and survives a corrupt trust file", () => {
    const { trusted, trustedFile } = make();
    expect(() => trusted.trust("@marshal/vault", "nope")).toThrow(/sha256/);
    const corrupt = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(corrupt.isTrusted("@marshal/vault", GOOD)).toBe(false);
  });
});

describe("grandfathering installed extensions", () => {
  const record = (identity: string, status: string, value: string) => ({
    identity,
    status,
    request: { integrity: { value } },
  });
  const guarded = (id: string) => id === "@marshal/vault" || id === "@marshal/brain";

  it("trusts installed and enabled allowlisted identities once, then never again", () => {
    const trustedFile = file();
    const trusted = createOrgTrustedExtensions(trustedFile, { getKey });
    const first = trusted.grandfather(
      grandfatherCandidates(
        [
          record("@marshal/vault", "enabled", GOOD),
          record("@marshal/brain", "disabled", OTHER),
          record("@random/tool", "enabled", OTHER),
        ],
        guarded,
      ),
    );
    expect(first).toEqual(["@marshal/vault"]);
    expect(trusted.isTrusted("@marshal/vault", GOOD)).toBe(true);
    expect(trusted.isTrusted("@marshal/brain", OTHER)).toBe(false);
    expect(trusted.grandfatheredIdentities()).toEqual(["@marshal/vault"]);

    const afterRestart = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(
      afterRestart.grandfather([{ identity: "@marshal/brain", integrity: OTHER }]),
    ).toBeUndefined();
    expect(afterRestart.isTrusted("@marshal/brain", OTHER)).toBe(false);
    expect(afterRestart.isTrusted("@marshal/vault", GOOD)).toBe(true);
  });

  it("marks the migration done even when nothing was installed", () => {
    const trusted = createOrgTrustedExtensions(file(), { getKey });
    expect(trusted.grandfather([])).toEqual([]);
    expect(trusted.grandfather([{ identity: "@marshal/vault", integrity: GOOD }])).toBeUndefined();
  });
});

describe("trusting local builds", () => {
  const make = (allow: boolean) => {
    const trustedFile = file();
    let changed = 0;
    const trusted = createOrgTrustedExtensions(trustedFile, {
      getKey,
      onChanged: () => (changed += 1),
    });
    const admit = createOrgExtensionAdmission({
      isGuarded: (id) => id === "@marshal/vault",
      trusted,
      allowLocalBuilds: () => allow,
      bundled: [],
    });
    return { trusted, admit, trustedFile, changes: () => changed };
  };

  it("refuses a local build by default", () => {
    const { admit, trusted } = make(false);
    expect(admit({ identity: "@marshal/vault", integrity: { value: OTHER } })).toMatch(/neither/);
    expect(trusted.locallyTrustedIdentities()).toEqual([]);
  });

  it("with the setting on, admits and records the build so Settings can warn about it", () => {
    const { admit, trusted, trustedFile, changes } = make(true);
    expect(admit({ identity: "@marshal/vault", integrity: { value: OTHER } })).toBeUndefined();
    expect(admit({ identity: "@marshal/vault", integrity: { value: OTHER } })).toBeUndefined();
    expect(admit({ identity: "@random/tool", integrity: { value: OTHER } })).toBeUndefined();
    expect(trusted.locallyTrustedIdentities()).toEqual(["@marshal/vault"]);
    expect(changes()).toBe(1);
    const afterRestart = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(afterRestart.locallyTrustedIdentities()).toEqual(["@marshal/vault"]);
    expect(afterRestart.isTrusted("@marshal/vault", OTHER, { includeLocal: true })).toBe(true);
    expect(afterRestart.isTrusted("@marshal/vault", OTHER)).toBe(false);
  });
});

describe("local builds only count while the escape is on", () => {
  it("stops loading a locally trusted build once the escape is turned off", () => {
    const trusted = createOrgTrustedExtensions(file(), { getKey });
    let allow = true;
    const admit = createOrgExtensionAdmission({
      isGuarded: () => true,
      trusted,
      allowLocalBuilds: () => allow,
      bundled: [],
    });
    expect(admit({ identity: "@marshal/brain", integrity: { value: OTHER } })).toBeUndefined();
    expect(trusted.locallyTrustedIdentities()).toEqual(["@marshal/brain"]);
    allow = false;
    expect(admit({ identity: "@marshal/brain", integrity: { value: OTHER } })).toMatch(/neither/);
    allow = true;
    expect(admit({ identity: "@marshal/brain", integrity: { value: OTHER } })).toBeUndefined();
  });
});

describe("protected trust store", () => {
  const tamper = (trustedFile: string, edit: (envelope: { data: string; mac: string }) => void) => {
    const envelope = JSON.parse(readFileSync(trustedFile, "utf8"));
    edit(envelope);
    writeFileSync(trustedFile, JSON.stringify(envelope));
  };

  it("locks on a planted hash and never re-grandfathers", () => {
    const trustedFile = file();
    const first = createOrgTrustedExtensions(trustedFile, { getKey });
    first.grandfather([{ identity: "@marshal/vault", integrity: GOOD }]);
    tamper(trustedFile, (envelope) => {
      const data = JSON.parse(envelope.data);
      data.trusted["@marshal/vault"].push(OTHER);
      envelope.data = JSON.stringify(data);
    });
    const locked = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(locked.isTrusted("@marshal/vault", OTHER)).toBe(false);
    expect(locked.isTrusted("@marshal/vault", GOOD)).toBe(false);
    expect(locked.isLocked()).toBe(true);
    expect(locked.grandfather([{ identity: "@marshal/brain", integrity: OTHER }])).toBeUndefined();
    locked.trust("@marshal/brain", OTHER);
    expect(locked.isTrusted("@marshal/brain", OTHER)).toBe(false);
    const admit = createOrgExtensionAdmission({
      isGuarded: () => true,
      trusted: locked,
      allowLocalBuilds: () => true,
      bundled: [{ identity: "@marshal/vault", integrity: { value: GOOD } }],
    });
    expect(admit({ identity: "@marshal/vault", integrity: { value: GOOD } })).toBeUndefined();
    expect(admit({ identity: "@marshal/brain", integrity: { value: OTHER } })).toMatch(/neither/);
  });

  it("locks on a plaintext file written without the key, and on garbage", () => {
    const planted = file();
    writeFileSync(planted, JSON.stringify({ trusted: { "@marshal/vault": [OTHER] } }));
    const a = createOrgTrustedExtensions(planted, { getKey });
    expect(a.isTrusted("@marshal/vault", OTHER)).toBe(false);
    expect(a.isLocked()).toBe(true);
    const garbage = file();
    writeFileSync(garbage, "not json");
    expect(createOrgTrustedExtensions(garbage, { getKey }).isLocked()).toBe(true);
  });

  it("locks when the key changes and when no key is available", () => {
    const trustedFile = file();
    createOrgTrustedExtensions(trustedFile, { getKey }).trust("@marshal/vault", GOOD);
    const otherKey = createOrgTrustedExtensions(trustedFile, { getKey: () => Buffer.alloc(32, 9) });
    expect(otherKey.isTrusted("@marshal/vault", GOOD)).toBe(false);
    expect(otherKey.isLocked()).toBe(true);
    const noKey = createOrgTrustedExtensions(file(), { getKey: () => null });
    expect(noKey.isLocked()).toBe(true);
    expect(noKey.grandfather([{ identity: "@marshal/vault", integrity: GOOD }])).toBeUndefined();
  });

  it("does not read the file or the key until first use", () => {
    let calls = 0;
    createOrgTrustedExtensions(file(), { getKey: () => ((calls += 1), null) });
    expect(calls).toBe(0);
  });

  it("a failed write during grandfathering throws and leaves the migration to retry", () => {
    const trustedFile = file();
    writeFails.value = true;
    const store = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(() => store.grandfather([{ identity: "@marshal/vault", integrity: GOOD }])).toThrow(
      /disk full/,
    );
    writeFails.value = false;
    const retry = createOrgTrustedExtensions(trustedFile, { getKey });
    expect(retry.grandfather([{ identity: "@marshal/vault", integrity: GOOD }])).toEqual([
      "@marshal/vault",
    ]);
  });
});
