import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { UserPrincipal } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";

import { OnboardingError } from "../src/onboarding.js";
import { OrgConnectError, connectOrg, personAccessToken, personOrgResolver } from "../src/org-connect.js";

const ADA: UserPrincipal = "user:ada@example.test";

function fakeOrg(features: Parameters<typeof createInMemoryOrgProvider>[0]["features"] = ["signIn", "workspaces", "sessions"]) {
  return createInMemoryOrgProvider({ users: [{ principal: ADA, email: "ada@example.test", displayName: "Ada" }], features });
}

test("the run joins as the person who started it: their token from a file (re-read on every call) or the environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-connect-"));
  const file = path.join(root, "token");
  fs.writeFileSync(file, "first-token\n");
  const fromFile = personAccessToken({}, { MARSHAL_ORG_TOKEN_FILE: file, MARSHAL_ORG_TOKEN: "ignored" });
  assert.equal(await fromFile(), "first-token");
  fs.writeFileSync(file, "refreshed-token");
  assert.equal(await fromFile(), "refreshed-token", "whoever refreshes the token only rewrites the file");
  assert.equal(await personAccessToken({}, { MARSHAL_ORG_TOKEN: "env-token" })(), "env-token");
  assert.equal(await personAccessToken({ token: "given" }, { MARSHAL_ORG_TOKEN_FILE: file })(), "given");

  assert.throws(() => personAccessToken({}, {}), (error: unknown) => error instanceof OrgConnectError && error.code === "org-token-missing");
  fs.writeFileSync(file, "  \n");
  await assert.rejects(fromFile(), (error: unknown) => error instanceof OrgConnectError && error.code === "org-token-empty" && !error.message.includes("token\n"));

  const provider = fakeOrg();
  fs.writeFileSync(file, provider.issueToken(ADA));
  const connection = await connectOrg({ orgUrl: provider.orgUrl, env: { MARSHAL_ORG_TOKEN_FILE: file }, fetch: provider.fetch });
  assert.equal((await connection.identity()).principal, ADA);
  assert.equal(connection.allowProductionOrg, false);
});

test("a production organization is refused before anything is sent, unless allowed", async () => {
  const sent: string[] = [];
  const fetch = (async (url: string) => {
    sent.push(String(url));
    throw new Error("unreachable");
  }) as never;
  await assert.rejects(
    connectOrg({ orgUrl: "https://org.zyg.com", token: "t", env: {}, fetch }),
    (error: unknown) => error instanceof OrgConnectError && error.code === "production-org-off" && /MARSHAL_ORG_ALLOW_PRODUCTION/.test(error.message),
  );
  assert.deepEqual(sent, []);
  // Allowed by the person: it goes ahead (and here fails only because nothing answers).
  await assert.rejects(connectOrg({ orgUrl: "https://org.zyg.com", token: "t", env: { MARSHAL_ORG_ALLOW_PRODUCTION: "1" }, fetch }), /failed|unreachable/);
  assert.equal(sent.length, 1);
  await assert.rejects(connectOrg({ token: "t", env: {} }), (error: unknown) => error instanceof OrgConnectError && error.code === "org-url-missing");
});

test("onboarding's resolver joins the manifest's org with the person's token and asks what it admits", async () => {
  const provider = fakeOrg(["signIn", "workspaces", "onboarding", "extensionCatalog"]);
  const token = provider.issueToken(ADA);
  const entry = (id: string, version: string, status: string) => ({ id, version, tier: "available", title: id, why: "test", status, delivery: { kind: "bundled" } });
  const seen: string[] = [];
  // The in-memory org has no catalog route; this one answers it the way the contract describes.
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/onboarding/catalog")) {
      seen.push(new Headers(init?.headers).get("authorization") === `Bearer ${token}` ? "person" : "someone else");
      return new Response(JSON.stringify({ version: 1, isAdmin: false, recommended: [entry("@zyg/pages", "1.2.0", "approved")], available: [entry("@zyg/pages", "1.1.0", "approved"), entry("@zyg/new", "0.1.0", "pending")], pending: [] }), { headers: { "content-type": "application/json" } });
    }
    return provider.fetch(url, init as never);
  }) as never;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "org-resolver-"));
  const resolver = personOrgResolver({ token, env: {}, fetch, bundled: (id) => (id === "@zyg/pages" ? root : undefined) });
  assert.deepEqual(await resolver.admitted({ discovery: provider.orgUrl }), [{ id: "@zyg/pages", version: "1.2.0" }]);
  assert.deepEqual(await resolver.fetch({ org: { discovery: provider.orgUrl }, id: "@zyg/pages", version: "1.1.0" }), { id: "@zyg/pages", version: "1.1.0", packageRoot: root });
  await assert.rejects(resolver.fetch({ org: { discovery: provider.orgUrl }, id: "@zyg/new" }), (error: unknown) => error instanceof OnboardingError && error.code === "org-not-admitted");
  assert.deepEqual(seen, ["person"], "one catalog read, with the person's own token");

  const noToken = personOrgResolver({ env: {} });
  await assert.rejects(noToken.admitted({ discovery: provider.orgUrl }), (error: unknown) => error instanceof OnboardingError && error.code === "org-token-missing");
  const production = personOrgResolver({ token: "t", env: {} });
  await assert.rejects(production.admitted({ discovery: "https://org.zyg.com" }), (error: unknown) => error instanceof OnboardingError && error.code === "production-org-off");
});
