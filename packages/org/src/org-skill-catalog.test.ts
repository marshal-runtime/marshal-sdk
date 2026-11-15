import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrgSkillEntry } from "./common/org-skills";
import { OrgSkillCatalog, orgSkillsKey, type OrgSkillCatalogDeps } from "./org-skill-catalog";
import { packSkillDirectory } from "./org-skill-pack";
import { readOrgSkillStamp } from "./org-skill-stamp";

const API = "https://org.example.com";
const ORG = { orgId: "acme", orgUrl: API, orgName: "Acme", features: ["orgSkills"], apiBase: API };

let tmp: string;
let root: string;
let personal: string;

function writeSkill(dir: string, name: string, body: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does ${name}\n---\n\n${body}\n`,
  );
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

async function served(
  name: string,
  version: string,
  body: string,
  overrides: Partial<OrgSkillEntry> = {},
): Promise<{ entry: OrgSkillEntry; bytes: Buffer }> {
  const source = path.join(tmp, "published", `${name}-${version}`);
  writeSkill(source, name, body, { "scripts/run.sh": "echo hi\n" });
  const packed = await packSkillDirectory(source, { homeDir: "/nonexistent-home" });
  return {
    bytes: packed.bytes,
    entry: {
      name,
      version,
      tier: "available",
      description: `Does ${name}`,
      delivery: {
        kind: "archive",
        sha256: packed.sha256,
        bytes: packed.bytes.length,
        url: `${API}/v1/onboarding/skills/${name}/${version}.tgz`,
      },
      files: packed.files,
      status: "approved",
      publisher: "dana@example.com",
      publishedAt: "2026-11-12T10:00:00.000Z",
      ...overrides,
    },
  };
}

function harness(overrides: Partial<OrgSkillCatalogDeps> = {}) {
  const state = {
    catalog: { version: 1, isAdmin: false, recommended: [], available: [], pending: [] } as {
      version: 1;
      isAdmin: boolean;
      recommended: OrgSkillEntry[];
      available: OrgSkillEntry[];
      pending: OrgSkillEntry[];
    },
    archives: new Map<string, Buffer>(),
    publishable: [] as ReturnType<OrgSkillCatalogDeps["publishableSkills"]>,
  };
  const deps: OrgSkillCatalogDeps = {
    getOrg: async () => ORG,
    requestJson: vi.fn<OrgSkillCatalogDeps["requestJson"]>(async (method, route) => {
      if (method === "GET" && route === "/v1/onboarding/skills") return state.catalog;
      return {};
    }),
    uploadBytes: vi.fn<OrgSkillCatalogDeps["uploadBytes"]>(async () => ({})),
    downloadArchive: vi.fn<OrgSkillCatalogDeps["downloadArchive"]>(async (url) => {
      const bytes = state.archives.get(url);
      if (!bytes) throw Object.assign(new Error("missing"), { code: "not-found" });
      return bytes;
    }),
    root,
    personalSkills: () => ({}),
    publishableSkills: () => state.publishable,
    onChanged: vi.fn<() => void>(),
    homeDir: "/Users/someone-else",
    ...overrides,
  };
  const serve = (item: { entry: OrgSkillEntry; bytes: Buffer }) =>
    state.archives.set(item.entry.delivery.url, item.bytes);
  return { catalog: new OrgSkillCatalog(deps), deps, state, serve };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "org-skill-catalog-"));
  root = path.join(tmp, "org-skills");
  personal = path.join(tmp, "marshal-skills");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("OrgSkillCatalog install", () => {
  it("installs an approved skill into the organization folder with a stamp", async () => {
    const { catalog, state, serve, deps } = harness();
    const deploy = await served("deploy-checklist", "1.0.0", "Run the checks.");
    state.catalog.available = [deploy.entry];
    serve(deploy);

    const result = await catalog.install("deploy-checklist");

    expect(result.success).toBe(true);
    const dir = path.join(root, "acme", "deploy-checklist");
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("Run the checks.");
    expect(readFileSync(path.join(dir, "scripts/run.sh"), "utf8")).toBe("echo hi\n");
    expect(readOrgSkillStamp(dir)).toEqual({
      name: "deploy-checklist",
      version: "1.0.0",
      sha256: deploy.entry.delivery.sha256,
      org: "acme",
    });
    expect(deps.onChanged).toHaveBeenCalledTimes(1);
  });

  it("does not install an unapproved skill for a member", async () => {
    const { catalog, state, serve, deps } = harness();
    const pending = await served("draft-skill", "0.1.0", "Draft.", { status: "pending" });
    state.catalog.pending = [pending.entry];
    serve(pending);

    const result = await catalog.install("draft-skill");

    expect(result).toEqual({ success: false, error: "not-available" });
    expect(deps.downloadArchive).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "acme", "draft-skill"))).toBe(false);
  });

  it("never writes into the person's own skill folder, even for a skill of the same name", async () => {
    writeSkill(path.join(personal, "deploy-checklist"), "deploy-checklist", "My own steps.");
    const { catalog, state, serve } = harness({
      personalSkills: () => ({ "deploy-checklist": "local" }),
    });
    const deploy = await served("deploy-checklist", "1.0.0", "The org's steps.");
    state.catalog.available = [deploy.entry];
    serve(deploy);

    await catalog.install("deploy-checklist");
    const listed = await catalog.get();

    expect(readFileSync(path.join(personal, "deploy-checklist", "SKILL.md"), "utf8")).toContain(
      "My own steps.",
    );
    expect(listed.success && listed.installed["deploy-checklist"]).toEqual({
      version: "1.0.0",
      state: "current",
      hiddenBy: "local",
    });
  });

  it("refuses an archive that does not match its checksum and keeps nothing", async () => {
    const { catalog, state, serve } = harness();
    const deploy = await served("deploy-checklist", "1.0.0", "Run the checks.");
    state.catalog.available = [
      { ...deploy.entry, delivery: { ...deploy.entry.delivery, sha256: "0".repeat(64) } },
    ];
    serve({ ...deploy, entry: state.catalog.available[0] });

    const result = await catalog.install("deploy-checklist");

    expect(result).toMatchObject({ success: false, error: "hash-mismatch" });
    expect(existsSync(path.join(root, "acme", "deploy-checklist"))).toBe(false);
  });

  it("says the organization does not serve skills when discovery lacks the feature", async () => {
    const { catalog } = harness({ getOrg: async () => ({ ...ORG, features: [] }) });
    expect(await catalog.get()).toEqual({ success: false, error: "not-supported" });
  });
});

describe("OrgSkillCatalog sync", () => {
  it("removes the local copy when the organization removes the skill", async () => {
    const { catalog, state, serve, deps } = harness();
    const deploy = await served("deploy-checklist", "1.0.0", "Run the checks.");
    state.catalog.available = [deploy.entry];
    serve(deploy);
    await catalog.install("deploy-checklist");

    state.catalog.available = [];
    const outcome = await catalog.sync();

    expect(outcome).toEqual({ updated: [], removed: ["deploy-checklist"] });
    expect(existsSync(path.join(root, "acme", "deploy-checklist"))).toBe(false);
    expect(deps.onChanged).toHaveBeenCalledTimes(2);
  });

  it("replaces the local copy with a newer approved version", async () => {
    const { catalog, state, serve } = harness();
    const first = await served("deploy-checklist", "1.0.0", "Version one.");
    state.catalog.available = [first.entry];
    serve(first);
    await catalog.install("deploy-checklist");

    const second = await served("deploy-checklist", "1.1.0", "Version two.");
    state.catalog.available = [second.entry];
    serve(second);
    const outcome = await catalog.sync();

    const dir = path.join(root, "acme", "deploy-checklist");
    expect(outcome.updated).toEqual(["deploy-checklist"]);
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toContain("Version two.");
    expect(readOrgSkillStamp(dir)?.version).toBe("1.1.0");
  });

  it("changes nothing when the catalog cannot be read", async () => {
    const { catalog, state, serve, deps } = harness();
    const deploy = await served("deploy-checklist", "1.0.0", "Run the checks.");
    state.catalog.available = [deploy.entry];
    serve(deploy);
    await catalog.install("deploy-checklist");
    vi.mocked(deps.requestJson).mockRejectedValue(
      Object.assign(new Error("offline"), { code: "network" }),
    );

    expect(await catalog.sync()).toEqual({ updated: [], removed: [] });
    expect(existsSync(path.join(root, "acme", "deploy-checklist", "SKILL.md"))).toBe(true);
  });

  it("removes an installed skill while signed out, from the last recorded organization", async () => {
    let signedIn = true;
    const { catalog, state, serve } = harness({
      getOrg: async () => (signedIn ? ORG : undefined),
    });
    const deploy = await served("deploy-checklist", "1.0.0", "Run the checks.");
    state.catalog.available = [deploy.entry];
    serve(deploy);
    await catalog.install("deploy-checklist");
    signedIn = false;

    expect(await catalog.remove("deploy-checklist")).toEqual({ success: true });
    expect(existsSync(path.join(root, "acme", "deploy-checklist"))).toBe(false);
  });

  it("leaves another organization's skills alone", async () => {
    const other = path.join(root, "other-org", "deploy-checklist");
    writeSkill(other, "deploy-checklist", "Theirs.");
    writeFileSync(
      path.join(other, ".org-skill.json"),
      JSON.stringify({ name: "deploy-checklist", version: "1.0.0", sha256: "x", org: "other-org" }),
    );
    const { catalog } = harness();

    await catalog.sync();

    expect(existsSync(path.join(other, "SKILL.md"))).toBe(true);
  });
});

describe("OrgSkillCatalog publish", () => {
  it("blocks publishing a skill with a secret in one of its files", async () => {
    const dir = path.join(personal, "deploy-checklist");
    writeSkill(dir, "deploy-checklist", "Run the checks.", {
      "references/env.md": 'api_key: "abcd1234abcd1234abcd1234"\n',
    });
    const { catalog, state, deps } = harness();
    state.publishable = [{ name: "deploy-checklist", description: "", scope: "local", dir }];

    const preview = await catalog.publishPreview("deploy-checklist");
    const result = await catalog.publish({ name: "deploy-checklist", version: "1.0.0" });

    expect(preview).toMatchObject({ success: false, error: "sensitive-content" });
    expect(result).toMatchObject({
      success: false,
      error: "sensitive-content",
      detail: expect.stringContaining("references/env.md"),
    });
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });

  it("blocks publishing a skill that names the person's home folder", async () => {
    const dir = path.join(personal, "deploy-checklist");
    writeSkill(dir, "deploy-checklist", "Open /Users/someone-else/notes.txt first.");
    const { catalog, state, deps } = harness();
    state.publishable = [{ name: "deploy-checklist", description: "", scope: "local", dir }];

    const result = await catalog.publish({ name: "deploy-checklist", version: "1.0.0" });

    expect(result).toMatchObject({ success: false, error: "sensitive-content" });
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });

  it("refuses a binary file", async () => {
    const dir = path.join(personal, "deploy-checklist");
    writeSkill(dir, "deploy-checklist", "Run the checks.");
    writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const { catalog, state, deps } = harness();
    state.publishable = [{ name: "deploy-checklist", description: "", scope: "local", dir }];

    const result = await catalog.publish({ name: "deploy-checklist", version: "1.0.0" });

    expect(result).toMatchObject({ success: false, error: "not-text" });
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });

  it("uploads the packed skill with its name, version and checksum, leaving dotfiles out", async () => {
    const dir = path.join(personal, "deploy-checklist");
    writeSkill(dir, "deploy-checklist", "Run the checks.", { ".env": "TOKEN=1\n" });
    const { catalog, state, deps } = harness();
    state.publishable = [{ name: "deploy-checklist", description: "", scope: "local", dir }];

    const preview = await catalog.publishPreview("deploy-checklist");
    const result = await catalog.publish({ name: "deploy-checklist", version: "1.0.0" });

    expect(preview).toMatchObject({
      success: true,
      files: [{ path: "SKILL.md" }],
      skipped: [".env"],
    });
    expect(result.success).toBe(true);
    const [route, headers] = vi.mocked(deps.uploadBytes).mock.calls[0];
    expect(route).toBe("/v1/onboarding/skills/publish");
    expect(headers).toMatchObject({
      "x-marshal-skill-name": "deploy-checklist",
      "x-marshal-skill-version": "1.0.0",
      "x-marshal-archive-sha256": expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("publishes only the person's own skills", async () => {
    const { catalog, deps } = harness();
    expect(await catalog.publish({ name: "pptx", version: "1.0.0" })).toEqual({
      success: false,
      error: "not-publishable",
    });
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });
});

describe("OrgSkillCatalog review", () => {
  it("shows every file of a pending version, SKILL.md first, with the approved version for comparison", async () => {
    const { catalog, state, serve } = harness();
    const current = await served("deploy-checklist", "1.0.0", "Version one.");
    const next = await served("deploy-checklist", "1.1.0", "Version two.", { status: "pending" });
    state.catalog.available = [current.entry];
    state.catalog.pending = [next.entry];
    serve(current);
    serve(next);

    const result = await catalog.reviewFiles("deploy-checklist", "1.1.0");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(result.files[0].text).toContain("Version two.");
    expect(result.previous?.version).toBe("1.0.0");
    expect(result.previous?.files[0].text).toContain("Version one.");
  });

  it("sends the decision to the review route", async () => {
    const { catalog, deps } = harness();
    await catalog.review({
      name: "deploy-checklist",
      version: "1.1.0",
      decision: "reject",
      reason: "too broad",
    });
    expect(deps.requestJson).toHaveBeenCalledWith(
      "POST",
      "/v1/onboarding/skills/deploy-checklist/1.1.0/review",
      { decision: "reject", reason: "too broad" },
    );
  });
});

describe("orgSkillsKey", () => {
  it("uses the org id, else the host of the org URL", () => {
    expect(orgSkillsKey({ orgId: "Acme Corp", orgUrl: API })).toBe("acme-corp");
    expect(orgSkillsKey({ orgUrl: "https://org.example.com:8443/x" })).toBe("org.example.com-8443");
  });
});
