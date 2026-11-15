import {
  createInMemoryOrgProvider,
  orgProviderConformanceCases,
} from "@marshal/agent-runtime-org/testing";
import { describe, expect, it } from "vitest";

const MEMBER = "user:ada";
const OUTSIDER = "user:mallory";

function provider() {
  return createInMemoryOrgProvider({
    users: [{ principal: MEMBER, email: "ada@example.test", displayName: "Ada" }],
    workspaces: [
      {
        id: "ws:platform",
        displayName: "Platform",
        repositories: [{ repository: "acme/platform", defaultBranch: "main" }],
      },
    ],
  });
}

describe("in-memory org provider conformance", () => {
  const cases = orgProviderConformanceCases();

  it("ships conformance cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((conformanceCase) => conformanceCase.name))("%s", async (name) => {
    const conformanceCase = cases.find((candidate) => candidate.name === name)!;
    const org = provider();
    await expect(
      conformanceCase.run({
        fetch: org.fetch,
        orgUrl: org.orgUrl,
        accessTokenFor: (principal) => org.issueToken(principal),
        memberPrincipal: MEMBER,
        nonMemberPrincipal: OUTSIDER,
      }),
    ).resolves.toBeUndefined();
  });
});
