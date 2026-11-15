import type { OrgClient } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { OrgFlags } from "./org-service";
import type { FolderOrigin, LocalWorkspaceFolders } from "./org-workspace-links";
import { OrgWorkspaceLinks, readGitOrigin } from "./org-workspace-links";

type LinkClient = Pick<OrgClient, "supports" | "listWorkspaces">;
type OrgWorkspaceRecord = Awaited<ReturnType<OrgClient["listWorkspaces"]>>[number];

const ON: OrgFlags = { enabled: true, signIn: true, workspaces: true, remoteSessions: false };
const OFF: OrgFlags = { enabled: true, signIn: true, workspaces: false, remoteSessions: false };

const workspace = (id: `ws:${string}`, repositories: string[]): OrgWorkspaceRecord => ({
  id,
  displayName: id.replace("ws:", ""),
  repositories: repositories.map((repository) => ({ repository, defaultBranch: "main" })),
});

function setup(
  options: {
    flags?: OrgFlags;
    orgWorkspaces?: OrgWorkspaceRecord[];
    origins?: Record<string, string | undefined>;
    locals?: LocalWorkspaceFolders[];
    orgId?: string | undefined;
    listError?: boolean;
  } = {},
) {
  const origins = options.origins ?? {};
  const listWorkspaces = vi.fn<LinkClient["listWorkspaces"]>(async () => {
    if (options.listError) throw new Error("offline");
    return (
      options.orgWorkspaces ?? [
        workspace("ws:platform", ["acme/platform"]),
        workspace("ws:growth", ["Acme/Growth"]),
      ]
    );
  });
  const readOrigin = vi.fn<(folder: string) => Promise<FolderOrigin>>(async (folder) => {
    const repo = origins[folder];
    return repo ? { repo: repo.toLowerCase() } : {};
  });
  const service = new OrgWorkspaceLinks({
    getFlags: () => options.flags ?? ON,
    getClient: async () => ({ supports: () => true, listWorkspaces }),
    getSignedInOrgId: () => ("orgId" in options ? options.orgId : "acme"),
    listLocalWorkspaces: () =>
      options.locals ?? [
        { name: "Platform", folders: ["/work/platform"] },
        { name: "My platform copy", folders: ["/work/other-clone"] },
      ],
    readOrigin,
  });
  return { service, listWorkspaces, readOrigin };
}

describe("OrgWorkspaceLinks with org.workspaces off", () => {
  it("does no work and maps nothing", async () => {
    const { service, listWorkspaces, readOrigin } = setup({ flags: OFF });
    expect(service.resolve("Platform")).toBeUndefined();
    expect(await service.refreshAll()).toEqual({ success: false, error: "disabled" });
    expect((await service.resolveFresh("Platform")).mapped).toBe(false);
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(readOrigin).not.toHaveBeenCalled();
  });
});

describe("OrgWorkspaceLinks derived mapping", () => {
  it("maps two differently named workspaces on the same origin to the same organization workspace", async () => {
    const { service } = setup({
      origins: {
        "/work/platform": "acme/platform",
        "/work/other-clone": "ACME/Platform",
      },
    });
    const result = await service.refreshAll();
    expect(result).toEqual({
      success: true,
      mappings: {
        Platform: {
          mapped: true,
          orgWorkspaceId: "ws:platform",
          orgWorkspaceName: "platform",
          repo: "acme/platform",
        },
        "My platform copy": {
          mapped: true,
          orgWorkspaceId: "ws:platform",
          orgWorkspaceName: "platform",
          repo: "acme/platform",
        },
      },
    });
    expect(service.resolve("Platform")).toBe("ws:platform");
    expect(service.resolve("My platform copy")).toBe("ws:platform");
  });

  it("maps Omer's workspaces by their own origin: zygstinct never lands in ws:zyg and marshal maps to nothing", async () => {
    const { service } = setup({
      orgWorkspaces: [
        workspace("ws:zyg", ["zyg-edge/zyg", "zyg-edge/zyg-agents"]),
        workspace("ws:zygstinct", ["zyg-edge/zygstinct"]),
      ],
      locals: [
        { name: "zyg", folders: ["/Users/omer/zyg"] },
        { name: "zygstinct", folders: ["/Users/omer/zygstinct"] },
        { name: "zyg-agents", folders: ["/Users/omer/zyg-agents"] },
        { name: "marshal", folders: ["/Users/omer/marshal/marshal"] },
      ],
      origins: {
        "/Users/omer/zyg": "zyg-edge/zyg",
        "/Users/omer/zygstinct": "zyg-edge/zygstinct",
        "/Users/omer/zyg-agents": "zyg-edge/zyg-agents",
        "/Users/omer/marshal/marshal": "OmerMachluf/marshal",
      },
    });
    const result = await service.refreshAll();
    if (!result.success) throw new Error(result.error);
    expect(await service.workspacesMappedTo("ws:zyg")).toEqual(["zyg", "zyg-agents"]);
    expect(await service.workspacesMappedTo("ws:zygstinct")).toEqual(["zygstinct"]);
    expect(result.mappings.marshal).toMatchObject({
      mapped: false,
      reason: "repo-not-in-org",
      repo: "omermachluf/marshal",
    });
  });

  it("matches a manifest repository case-insensitively", async () => {
    const { service } = setup({ origins: { "/work/platform": "acme/growth" } });
    expect(await service.resolveFresh("Platform")).toMatchObject({
      mapped: true,
      orgWorkspaceId: "ws:growth",
    });
  });

  it("refuses a workspace with no git origin", async () => {
    const { service } = setup({ origins: {} });
    expect(await service.resolveFresh("Platform")).toMatchObject({
      mapped: false,
      reason: "no-origin",
      message: "This workspace has no git origin, so it can't be shared or moved to the cloud.",
    });
    expect(service.resolve("Platform")).toBeUndefined();
  });

  it("refuses a repository no organization workspace lists and names it", async () => {
    const { service } = setup({ origins: { "/work/platform": "zyg-edge/foo" } });
    expect(await service.resolveFresh("Platform")).toEqual({
      mapped: false,
      reason: "repo-not-in-org",
      message: "zyg-edge/foo isn't in any organization workspace; ask an admin to add it.",
      repo: "zyg-edge/foo",
    });
  });

  it("refuses a repository listed by two organization workspaces", async () => {
    const { service } = setup({
      orgWorkspaces: [workspace("ws:a", ["acme/platform"]), workspace("ws:b", ["acme/platform"])],
      origins: { "/work/platform": "acme/platform" },
    });
    expect(await service.resolveFresh("Platform")).toMatchObject({
      mapped: false,
      reason: "ambiguous",
      repo: "acme/platform",
    });
  });

  it("maps a multi-folder workspace only when every folder has the same origin", async () => {
    const locals = [{ name: "Multi", folders: ["/a", "/b"] }];
    const same = setup({ locals, origins: { "/a": "acme/platform", "/b": "acme/platform" } });
    expect(await same.service.resolveFresh("Multi")).toMatchObject({ mapped: true });

    const differ = setup({ locals, origins: { "/a": "acme/platform", "/b": "acme/growth" } });
    expect(await differ.service.resolveFresh("Multi")).toMatchObject({
      mapped: false,
      reason: "origin-mismatch",
    });

    const oneBare = setup({ locals, origins: { "/a": "acme/platform" } });
    expect(await oneBare.service.resolveFresh("Multi")).toMatchObject({
      mapped: false,
      reason: "origin-mismatch",
    });
  });

  it("re-reads the origin on every fresh resolve, so a changed origin takes effect", async () => {
    const origins: Record<string, string | undefined> = { "/work/platform": "acme/platform" };
    const { service } = setup({ origins });
    expect(await service.resolveFresh("Platform")).toMatchObject({ mapped: true });
    origins["/work/platform"] = undefined;
    expect(await service.resolveFresh("Platform")).toMatchObject({ reason: "no-origin" });
    expect(service.resolve("Platform")).toBeUndefined();
  });

  it("fills the cache for the synchronous resolve in the background", async () => {
    const { service } = setup({ origins: { "/work/platform": "acme/platform" } });
    expect(service.resolve("Platform")).toBeUndefined();
    await vi.waitFor(() => expect(service.resolve("Platform")).toBe("ws:platform"));
  });

  it("is not mapped when signed out, and drops everything on invalidate", async () => {
    const signedOut = setup({ orgId: undefined });
    expect(await signedOut.service.refreshAll()).toEqual({
      success: false,
      error: "not-signed-in",
    });
    expect((await signedOut.service.resolveFresh("Platform")).mapped).toBe(false);

    const { service } = setup({ origins: { "/work/platform": "acme/platform" } });
    await service.resolveFresh("Platform");
    service.invalidate();
    expect(service.resolve("Platform")).toBeUndefined();
  });

  it("reports the mapping as unavailable when the organization cannot be reached", async () => {
    const { service } = setup({ listError: true, origins: { "/work/platform": "acme/platform" } });
    expect(await service.resolveFresh("Platform")).toMatchObject({
      mapped: false,
      reason: "unavailable",
    });
  });

  it("derives the folders for Continue here from a cold cache, with no prior refresh", async () => {
    const { service } = setup({
      origins: { "/work/platform": "acme/platform", "/work/other-clone": "acme/platform" },
    });
    expect(await service.workspacesMappedTo("ws:platform")).toEqual([
      "Platform",
      "My platform copy",
    ]);
    expect(await service.workspacesMappedTo("ws:growth")).toEqual([]);
  });

  it("follows an origin change for Continue here instead of keeping the old mapping", async () => {
    const origins: Record<string, string | undefined> = {
      "/work/platform": "acme/platform",
      "/work/other-clone": "acme/growth",
    };
    const { service } = setup({ origins });
    expect(await service.workspacesMappedTo("ws:platform")).toEqual(["Platform"]);
    origins["/work/platform"] = "acme/growth";
    expect(await service.workspacesMappedTo("ws:platform")).toEqual([]);
    expect(await service.workspacesMappedTo("ws:growth")).toEqual(["Platform", "My platform copy"]);
  });

  it("answers resolve() right after a startup prime, with no extra fetch", async () => {
    const { service, listWorkspaces } = setup({ origins: { "/work/platform": "acme/platform" } });
    await service.refreshAll(false);
    expect(service.resolve("Platform")).toBe("ws:platform");
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("prime loads the saved sign-in through the client before mapping, then resolve() is answered", async () => {
    const order: string[] = [];
    let signedIn = false;
    const service = new OrgWorkspaceLinks({
      getFlags: () => ON,
      getClient: async () => {
        order.push("getClient");
        signedIn = true;
        return {
          supports: () => true,
          listWorkspaces: async () => [workspace("ws:platform", ["acme/platform"])],
        };
      },
      getSignedInOrgId: () => (signedIn ? "acme" : undefined),
      listLocalWorkspaces: () => [{ name: "Platform", folders: ["/work/platform"] }],
      readOrigin: async () => ({ repo: "acme/platform" }),
    });
    await service.prime();
    expect(order[0]).toBe("getClient");
    expect(service.resolve("Platform")).toBe("ws:platform");
  });

  it("prime and refreshQuietly swallow failures, and prime does nothing when the flag is off", async () => {
    const failing = new OrgWorkspaceLinks({
      getFlags: () => ON,
      getClient: async () => {
        throw new Error("boom");
      },
      getSignedInOrgId: () => "acme",
      listLocalWorkspaces: () => {
        throw new Error("boom");
      },
    });
    await expect(failing.prime()).resolves.toBeUndefined();
    await expect(failing.refreshQuietly()).resolves.toBeUndefined();

    const { service, listWorkspaces } = setup({ flags: OFF });
    await service.prime();
    expect(listWorkspaces).not.toHaveBeenCalled();
  });

  it("a non-forced refresh reuses the cached organization list", async () => {
    const { service, listWorkspaces } = setup({ origins: { "/work/platform": "acme/platform" } });
    await service.refreshAll();
    await service.refreshAll(false);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    await service.refreshAll();
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("is not mapped for a workspace that is not registered", async () => {
    const { service } = setup();
    expect((await service.resolveFresh("Nope")).mapped).toBe(false);
  });
});

describe("readGitOrigin", () => {
  it("returns no repo outside a git repository", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morg-origin-"));
    try {
      expect(await readGitOrigin(dir)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
