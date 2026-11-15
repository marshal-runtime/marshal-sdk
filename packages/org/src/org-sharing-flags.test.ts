import { describe, expect, it } from "vitest";

import { resolveOrgFlags } from "./org-wiring";

const base = { autoApprove: { global: false, perServer: {} } };

describe("resolveOrgFlags for session sharing and mentions", () => {
  it("is off unless the whole chain org.enabled, org.signIn and org.workspaces is on", () => {
    expect(
      resolveOrgFlags({ ...base, experiments: { orgSessionSharing: true } }),
    ).not.toHaveProperty("sessionSharing");
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { orgEnabled: true, orgSignIn: true, orgSessionSharing: true },
      }).sessionSharing,
    ).toBeUndefined();
  });

  it("turns sharing on with the chain, and mentions only on top of sharing", () => {
    const chain = { orgEnabled: true, orgSignIn: true, orgWorkspaces: true };
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgSessionSharing: true } }),
    ).toMatchObject({ sessionSharing: true });
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgMentions: true } }).mentions,
    ).toBeUndefined();
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { ...chain, orgSessionSharing: true, orgMentions: true },
      }),
    ).toMatchObject({ sessionSharing: true, mentions: true });
  });

  it("turns cloud move on only on top of sharing and the full chain", () => {
    const chain = { orgEnabled: true, orgSignIn: true, orgWorkspaces: true };
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgCloudMove: true } }).cloudMove,
    ).toBeUndefined();
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { orgSessionSharing: true, orgCloudMove: true },
      }).cloudMove,
    ).toBeUndefined();
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { ...chain, orgSessionSharing: true, orgCloudMove: true },
      }),
    ).toMatchObject({ cloudMove: true });
  });

  it("turns placement on only on top of cloud move, and defaults it off", () => {
    const chain = {
      orgEnabled: true,
      orgSignIn: true,
      orgWorkspaces: true,
      orgSessionSharing: true,
    };
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgCloudMove: true } }),
    ).not.toHaveProperty("placement");
    expect(
      resolveOrgFlags({ ...base, experiments: { ...chain, orgPlacement: true } }),
    ).not.toHaveProperty("placement");
    expect(
      resolveOrgFlags({
        ...base,
        experiments: { ...chain, orgCloudMove: true, orgPlacement: true },
      }),
    ).toMatchObject({ cloudMove: true, placement: true });
  });
});
