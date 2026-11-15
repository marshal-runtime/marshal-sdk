import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../common/marshal-default-settings";
import { createOrgService, resolveOrgFlags, resolveOrgUrl } from "./org-wiring";

vi.mock("./org-token-store", () => ({
  SafeStorageOrgTokenStore: class {
    load = async () => null;
    save = async () => undefined;
    clear = async () => undefined;
  },
}));

describe("resolveOrgFlags", () => {
  it("turns the collaboration flags on for default settings, and keeps audit, fork and placement off", () => {
    expect(resolveOrgFlags(DEFAULT_SETTINGS)).toEqual({
      enabled: true,
      signIn: true,
      workspaces: true,
      remoteSessions: true,
      sessionSharing: true,
      mentions: true,
      cloudMove: true,
      remoteMode: true,
      cloudGroup: true,
      onboarding: true,
    });
  });

  it("is fully off for empty settings", () => {
    expect(resolveOrgFlags({ autoApprove: { global: false, perServer: {} } })).toEqual({
      enabled: false,
      signIn: false,
      workspaces: false,
      remoteSessions: false,
    });
  });

  it("needs org.enabled for every other org flag", () => {
    const settings = {
      autoApprove: { global: false, perServer: {} },
      experiments: { orgSignIn: true, orgWorkspaces: true },
    };
    expect(resolveOrgFlags(settings)).toEqual({
      enabled: false,
      signIn: false,
      workspaces: false,
      remoteSessions: false,
    });
  });

  it("needs org.signIn for org.workspaces", () => {
    const base = { autoApprove: { global: false, perServer: {} } };
    expect(
      resolveOrgFlags({ ...base, experiments: { orgEnabled: true, orgWorkspaces: true } }),
    ).toEqual({
      enabled: true,
      signIn: false,
      workspaces: false,
      remoteSessions: false,
    });
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { orgEnabled: true, orgSignIn: true, orgWorkspaces: true },
      }),
    ).toEqual({
      enabled: true,
      signIn: true,
      workspaces: true,
      remoteSessions: false,
      onboarding: true,
    });
  });
});

describe("resolveOrgFlags: org.cloudGroup", () => {
  const base = { autoApprove: { global: false, perServer: {} } };
  const chain = {
    orgEnabled: true,
    orgSignIn: true,
    orgWorkspaces: true,
    orgSessionSharing: true,
    orgCloudMove: true,
    orgRemoteSessions: true,
  };

  it("is off unless the flag and everything it needs are on", () => {
    expect(resolveOrgFlags({ ...base, experiments: chain }).cloudGroup).toBeUndefined();
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgCloudGroup: true } }).cloudGroup,
    ).toBe(true);
    for (const missing of [
      "orgEnabled",
      "orgSignIn",
      "orgWorkspaces",
      "orgSessionSharing",
      "orgCloudMove",
      "orgRemoteSessions",
    ]) {
      expect(
        resolveOrgFlags({
          ...base,
          experiments: { ...chain, orgCloudGroup: true, [missing]: false },
        }).cloudGroup,
      ).toBeUndefined();
    }
  });

  it("leaves every other flag as it was", () => {
    const without = resolveOrgFlags({ ...base, experiments: chain });
    const { cloudGroup: _cloudGroup, ...withFlag } = resolveOrgFlags({
      ...base,
      experiments: { ...chain, orgCloudGroup: true },
    });
    expect(withFlag).toEqual(without);
  });
});

describe("resolveOrgFlags: org.fork", () => {
  const base = { autoApprove: { global: false, perServer: {} } };
  const chain = { orgEnabled: true, orgSignIn: true, orgRemoteSessions: true };

  it("is off unless the flag and everything it needs are on", () => {
    expect(resolveOrgFlags({ ...base, experiments: chain }).fork).toBeUndefined();
    expect(resolveOrgFlags({ ...base, experiments: { ...chain, orgFork: true } }).fork).toBe(true);
    for (const missing of ["orgEnabled", "orgSignIn", "orgRemoteSessions"]) {
      expect(
        resolveOrgFlags({ ...base, experiments: { ...chain, orgFork: true, [missing]: false } })
          .fork,
      ).toBeUndefined();
    }
  });

  it("leaves every other flag as it was", () => {
    const without = resolveOrgFlags({ ...base, experiments: chain });
    const { fork: _fork, ...withFlag } = resolveOrgFlags({
      ...base,
      experiments: { ...chain, orgFork: true },
    });
    expect(withFlag).toEqual(without);
  });
});

describe("resolveOrgFlags: org.liveSessions", () => {
  const base = { autoApprove: { global: false, perServer: {} } };
  const chain = {
    orgEnabled: true,
    orgSignIn: true,
    orgWorkspaces: true,
    orgRemoteSessions: true,
    orgSessionSharing: true,
    orgMentions: true,
  };

  it("is off unless the flag and everything it needs are on", () => {
    expect(resolveOrgFlags({ ...base, experiments: chain }).liveSessions).toBeUndefined();
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgLiveSessions: true } }).liveSessions,
    ).toBe(true);
    for (const missing of [
      "orgEnabled",
      "orgSignIn",
      "orgWorkspaces",
      "orgRemoteSessions",
      "orgSessionSharing",
      "orgMentions",
    ]) {
      expect(
        resolveOrgFlags({
          ...base,
          experiments: { ...chain, orgLiveSessions: true, [missing]: false },
        }).liveSessions,
      ).toBeUndefined();
    }
  });

  it("leaves every other flag as it was", () => {
    const without = resolveOrgFlags({ ...base, experiments: chain });
    const { liveSessions: _liveSessions, ...withFlag } = resolveOrgFlags({
      ...base,
      experiments: { ...chain, orgLiveSessions: true },
    });
    expect(withFlag).toEqual(without);
  });
});

describe("resolveOrgUrl", () => {
  const base = { autoApprove: { global: false, perServer: {} } };

  it("prefers the admin policy URL and marks it managed", () => {
    expect(
      resolveOrgUrl({ ...base, orgUrl: "https://user.example.com" }, "https://admin.example.com"),
    ).toEqual({
      url: "https://admin.example.com",
      managed: true,
    });
  });

  it("falls back to a valid user setting and ignores an invalid one", () => {
    expect(resolveOrgUrl({ ...base, orgUrl: "https://user.example.com/x" }, undefined)).toEqual({
      url: "https://user.example.com",
      managed: false,
    });
    expect(resolveOrgUrl({ ...base, orgUrl: "http://user.example.com" }, undefined)).toEqual({
      managed: false,
    });
  });
});

describe("createOrgService change subscriptions", () => {
  it("re-evaluates the session when settings or the admin policy change", () => {
    const settings = Object.assign(new EventEmitter(), {
      get: () => DEFAULT_SETTINGS,
      update: () => undefined,
    });
    const policy = Object.assign(new EventEmitter(), { get: () => ({}) });
    const service = createOrgService({
      settingsManager: settings,
      tenantPolicyProvider: policy,
      openExternal: () => undefined,
    });
    const changed = vi.fn<() => void>();
    service.on("changed", changed);
    policy.emit("policyChanged");
    settings.emit("changed");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("needs org.enabled and org.signIn for org.remoteSessions", () => {
    const base = { autoApprove: { global: false, perServer: {} } };
    expect(
      resolveOrgFlags({ ...base, experiments: { orgEnabled: true, orgRemoteSessions: true } })
        .remoteSessions,
    ).toBe(false);
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { orgEnabled: true, orgSignIn: true, orgRemoteSessions: true },
      }).remoteSessions,
    ).toBe(true);
    expect(
      resolveOrgFlags({ ...base, experiments: { orgEnabled: true, orgSignIn: true } })
        .remoteSessions,
    ).toBe(false);
  });
});
