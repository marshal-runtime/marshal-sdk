import { describe, expect, it } from "vitest";

import { TEST_ONBOARDING_MANIFEST } from "../../../../common/org-onboarding-test-manifest";
import { parseOrgOnboardingManifest } from "./org-onboarding";
import { parseOrgAgentDefaults } from "./org-onboarding-agent-defaults";

describe("agentDefaults and tiers", () => {
  it("keeps valid model defaults and drops invalid ones", () => {
    expect(
      parseOrgAgentDefaults({
        main: { model: "claude-opus-5-5", effort: "medium" },
        subagents: { model: "claude-sonnet-5-5", effort: "turbo" },
      }),
    ).toEqual({ main: { model: "claude-opus-5-5", effort: "medium" } });
    expect(parseOrgAgentDefaults({ main: {} })).toBeUndefined();
    expect(parseOrgAgentDefaults("x")).toBeUndefined();
  });

  it("reads agentDefaults into the manifest and maps the legacy optional tier to available", () => {
    const parsed = parseOrgOnboardingManifest({
      ...TEST_ONBOARDING_MANIFEST,
      extensions: [
        { ...TEST_ONBOARDING_MANIFEST.extensions[0], id: "@a/legacy", tier: "optional" },
        { ...TEST_ONBOARDING_MANIFEST.extensions[0], id: "@a/new", tier: "available" },
      ],
      agentDefaults: { subagents: { model: "claude-sonnet-5-5", effort: "high" } },
    });
    expect(parsed?.extensions.map((entry) => entry.tier)).toEqual(["available", "available"]);
    expect(parsed?.agentDefaults).toEqual({
      subagents: { model: "claude-sonnet-5-5", effort: "high" },
    });
  });
});
