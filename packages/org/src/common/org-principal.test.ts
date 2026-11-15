import { describe, expect, it } from "vitest";

import { orgPrincipalLabel } from "./org-principal";

describe("orgPrincipalLabel", () => {
  it("shows a person without the user: prefix", () => {
    expect(orgPrincipalLabel("user:dana@zyg.com")).toBe("dana@zyg.com");
  });

  it("leaves other principals as they are", () => {
    expect(orgPrincipalLabel("dana@zyg.com")).toBe("dana@zyg.com");
    expect(orgPrincipalLabel("agent:helper")).toBe("agent:helper");
  });
});
