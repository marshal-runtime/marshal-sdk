import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../electron/testing/harness";
import { createStatusReadGrant, type StatusReadGrantDeps } from "./org-status-read";

const scope = { sessionId: "s", workspaceName: "w" };

function setup(
  permissions: { permission: string; risk?: "low" | "medium" | "high" | "critical" }[],
  owner: string | null = "@a/ext",
  names: string[] = ["a.status"],
) {
  const allowTool = vi.fn<StatusReadGrantDeps["allowTool"]>();
  const search = vi.fn<StatusReadGrantDeps["search"]>(async () =>
    testDouble<Awaited<ReturnType<StatusReadGrantDeps["search"]>>>({
      ok: true,
      receipts: [],
      value: {
        matches: names.map((name) => ({
          capability: { name, provider: { id: "p" }, permissions },
        })),
      },
    }),
  );
  const grant = createStatusReadGrant({ search, ownerOfProvider: async () => owner, allowTool });
  return { grant, allowTool };
}

describe("createStatusReadGrant", () => {
  it("allows a low-risk invoke permission under the capability's own tool name", async () => {
    const { grant, allowTool } = setup([
      { permission: "marshal.tool.invoke:a.status", risk: "low" },
    ]);
    expect(await grant(scope, ["@a/ext"], "a.status")).toBe(true);
    expect(allowTool).toHaveBeenCalledWith("s", "a.status");
  });

  it("qualifies a declared permission with the owning extension", async () => {
    const { grant, allowTool } = setup([{ permission: "a.status.read", risk: "low" }]);
    expect(await grant(scope, ["@a/ext"], "a.status")).toBe(true);
    expect(allowTool).toHaveBeenCalledWith("s", "runtime-extension:@a/ext:a.status.read");
  });

  it("accepts an undeclared risk only for a .read permission", async () => {
    expect(await setup([{ permission: "x.read" }]).grant(scope, ["@a/ext"], "a.status")).toBe(true);
    expect(await setup([{ permission: "x.write" }]).grant(scope, ["@a/ext"], "a.status")).toBe(
      false,
    );
  });

  it("refuses medium or higher risk, a foreign owner, and several matches", async () => {
    const medium = setup([{ permission: "marshal.tool.invoke:a.status", risk: "medium" }]);
    expect(await medium.grant(scope, ["@a/ext"], "a.status")).toBe(false);
    const other = setup([{ permission: "marshal.tool.invoke:a.status", risk: "low" }], "@b/ext");
    expect(await other.grant(scope, ["@a/ext"], "a.status")).toBe(false);
    const missing = setup([{ permission: "marshal.tool.invoke:a.status", risk: "low" }], null);
    expect(await missing.grant(scope, ["@a/ext"], "a.status")).toBe(false);
    const two = setup([{ permission: "marshal.tool.invoke:a.status", risk: "low" }], "@a/ext", [
      "a.status",
      "a.status",
    ]);
    expect(await two.grant(scope, ["@a/ext"], "a.status")).toBe(false);
    for (const { allowTool } of [medium, other, missing, two]) {
      expect(allowTool).not.toHaveBeenCalled();
    }
  });

  it("refuses an invoke permission that names another capability", async () => {
    const { grant, allowTool } = setup([
      { permission: "marshal.tool.invoke:a.other", risk: "low" },
    ]);
    expect(await grant(scope, ["@a/ext"], "a.status")).toBe(false);
    expect(allowTool).not.toHaveBeenCalled();
  });
});
