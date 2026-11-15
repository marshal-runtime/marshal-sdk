import { describe, expect, it } from "vitest";

import { grantableRoles, isGrantableRole } from "./org-roles";

describe("grantableRoles", () => {
  it("never includes owner and never exceeds the caller's role", () => {
    expect(grantableRoles("owner")).toEqual(["viewer", "collaborator", "driver"]);
    expect(grantableRoles("driver")).toEqual(["viewer", "collaborator", "driver"]);
    expect(grantableRoles("collaborator")).toEqual(["viewer", "collaborator"]);
  });

  it("is empty for a viewer", () => {
    expect(grantableRoles("viewer")).toEqual([]);
  });

  it("recognizes only grantable roles", () => {
    expect(isGrantableRole("driver")).toBe(true);
    expect(isGrantableRole("owner")).toBe(false);
    expect(isGrantableRole(undefined)).toBe(false);
  });
});
