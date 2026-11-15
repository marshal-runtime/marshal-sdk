import type { FetchLike } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";
import { describe, expect, it, vi } from "vitest";

import { secureStorageAllowed } from "../../../electron/secure-storage-policy";
import {
  createOrgBrokerFetchService,
  createOrgIdentityService,
  DEFAULT_ORG_BROKER_SESSION_EXTENSIONS,
  ORG_BROKER_FETCH_SERVICE,
  ORG_IDENTITY_SERVICE,
  orgBrokerSessionAllowed,
} from "./org-broker-session";
import { OrgNotSignedInError, OrgService, type OrgFlags } from "./org-service";
import type { OrgStoredSession, OrgTokenStore } from "./org-token-store";

const ON: OrgFlags = { enabled: true, signIn: true, workspaces: true, remoteSessions: false };
const ADA = "user:ada";

const logged: string[] = [];
vi.mock("../../../common/marshal-logger", () => {
  const sink =
    () =>
    (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  return {
    createLogger: () => ({ debug: sink(), info: sink(), warn: sink(), error: sink() }),
  };
});

async function setup(signedIn = true, brokerResponse?: () => Response) {
  const org = createInMemoryOrgProvider({
    users: [{ principal: ADA, email: "Ada@Example.test", displayName: "Ada" }],
    workspaces: [],
    features: ["signIn", "workspaces"],
  });
  let current: OrgStoredSession | null = null;
  const store: OrgTokenStore = {
    load: async () => current,
    save: async (session) => {
      current = session;
    },
    clear: async () => {
      current = null;
    },
  };
  let nowMs = Date.now();
  const brokerCalls: { url: string; headers: Record<string, string>; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    if (new URL(input).pathname.includes("/v1/broker/")) {
      brokerCalls.push({
        url: input,
        headers: Object.fromEntries(new Headers(init?.headers)),
        init: init ?? {},
      });
      return (
        brokerResponse?.() ??
        new Response('{"ok":true}', {
          status: 200,
          headers: { "set-cookie": "a=b", "x-test": "1" },
        })
      );
    }
    return org.fetch(input, init);
  };
  const service = new OrgService({
    getFlags: () => ON,
    getOrgUrl: () => ({ url: org.orgUrl, managed: false }),
    persistOrgUrl: () => undefined,
    tokenStore: store,
    openExternal: (url) => {
      void (async () => {
        const redirect = await org.fetch(url);
        await fetch(redirect.headers.get("location")!);
      })();
    },
    fetch: fetchImpl,
    now: () => nowMs,
  });
  if (signedIn) await service.signIn();
  const discovery = await fetchImpl(`${org.orgUrl}/.well-known/marshal-org.json`).then((r) =>
    r.json(),
  );
  return {
    org,
    service,
    brokerCalls,
    identity: createOrgIdentityService(service),
    broker: createOrgBrokerFetchService(service),
    apiBase: String(discovery.apiBase),
    tokenPosts: () =>
      org.requests.filter((r) => r.method === "POST" && r.url.endsWith("/idp/token")).length,
    peek: () => current,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("org identity and broker fetch services", () => {
  it("registers under the two symbols and not under the old token-returning one", () => {
    expect(ORG_IDENTITY_SERVICE).toBe(Symbol.for("@marshal/org:identity"));
    expect(ORG_BROKER_FETCH_SERVICE).toBe(Symbol.for("@marshal/org:broker-fetch"));
  });

  it("identity has the lowercased email and org, and no credential anywhere", async () => {
    const { identity, peek, service } = await setup();
    const result = await identity();
    expect(result).toMatchObject({ email: "ada@example.test" });
    expect(Object.keys(result!).sort()).toEqual(["email", "orgDisplayName", "orgId"]);
    const tokens = peek()!.tokens;
    const everything = JSON.stringify([result, await service.getStatus()]);
    expect(everything).not.toContain(tokens.accessToken);
    expect(everything).not.toContain(tokens.refreshToken ?? "no-refresh");
  });

  it("identity is undefined when signed out", async () => {
    const { identity } = await setup(false);
    await expect(identity()).resolves.toBeUndefined();
  });

  it("makes the call itself with the bearer and returns only status, headers and body", async () => {
    const { broker, brokerCalls, apiBase, peek } = await setup();
    const result = await broker("/v1/broker/datadog/api/v1/query?q=up", {
      headers: { accept: "application/json", authorization: "Bearer attacker" },
    });
    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-test": "1" },
      body: '{"ok":true}',
    });
    expect(brokerCalls).toHaveLength(1);
    expect(brokerCalls[0].url.startsWith(apiBase.replace(/\/+$/, ""))).toBe(true);
    expect(brokerCalls[0].headers.authorization).toBe(`Bearer ${peek()!.tokens.accessToken}`);
    expect(JSON.stringify(result)).not.toContain(peek()!.tokens.accessToken);
  });

  it.each([
    "/v1/org/sessions",
    "/v1/broker",
    "v1/broker/x",
    "https://evil.example/v1/broker/x",
    "//evil.example/v1/broker/x",
    "/v1/broker/../org/sessions",
    "/v1/broker/%2e%2e/org",
    "/v1/broker/a\\..\\b",
    "/v1/broker//x",
    "/v1/broker/x#frag",
    "",
  ])("refuses the path %j without any network call", async (path) => {
    const { broker, brokerCalls } = await setup();
    await expect(broker(path)).rejects.toMatchObject({
      code: expect.stringMatching(/path-not-allowed/),
    });
    expect(brokerCalls).toHaveLength(0);
  });

  it("refuses non GET/POST methods and oversized request bodies", async () => {
    const { broker, brokerCalls } = await setup();
    await expect(broker("/v1/broker/x", { method: "DELETE" })).rejects.toMatchObject({
      code: "method-not-allowed",
    });
    await expect(
      broker("/v1/broker/x", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: "request-too-large" });
    expect(brokerCalls).toHaveLength(0);
  });

  it("caps the response size", async () => {
    const { broker } = await setup(true, () => new Response("x".repeat(8 * 1024 * 1024 + 1)));
    await expect(broker("/v1/broker/x")).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("does not follow redirects off the broker", async () => {
    const { broker } = await setup(
      true,
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    const result = await broker("/v1/broker/x");
    expect(result.status).toBe(302);
  });

  it("refreshes before expiry and shares one refresh between concurrent callers", async () => {
    const { broker, brokerCalls, advance, tokenPosts, peek } = await setup();
    const baseline = tokenPosts();
    const before = peek()!.tokens.accessToken;
    advance(2 * 3_600_000);
    await Promise.all([broker("/v1/broker/a"), broker("/v1/broker/b"), broker("/v1/broker/c")]);
    expect(tokenPosts()).toBe(baseline + 1);
    const after = peek()!.tokens.accessToken;
    expect(after).not.toBe(before);
    expect(brokerCalls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${after}`,
      `Bearer ${after}`,
      `Bearer ${after}`,
    ]);
  });

  it("throws a typed error, not a token, when signed out", async () => {
    const { broker, brokerCalls } = await setup(false);
    await expect(broker("/v1/broker/x")).rejects.toBeInstanceOf(OrgNotSignedInError);
    expect(brokerCalls).toHaveLength(0);
  });

  it("never writes the token to the logs", async () => {
    logged.length = 0;
    const { broker, service, peek } = await setup();
    await broker("/v1/broker/x");
    vi.spyOn(service, "getAccessToken").mockRejectedValueOnce(
      new Error(`bad ${peek()!.tokens.accessToken}`),
    );
    await broker("/v1/broker/x").catch(() => undefined);
    const secrets = [peek()!.tokens.accessToken, peek()!.tokens.refreshToken ?? "no-refresh"];
    for (const line of logged) for (const secret of secrets) expect(line).not.toContain(secret);
  });
});

describe("org broker allowlist", () => {
  it("admits the built-in extensions and nothing else", () => {
    for (const id of DEFAULT_ORG_BROKER_SESSION_EXTENSIONS) {
      expect(orgBrokerSessionAllowed(id, {})).toBe(true);
    }
    expect(orgBrokerSessionAllowed("@marshal/vault", {})).toBe(true);
    expect(orgBrokerSessionAllowed("@evil/extension", {})).toBe(false);
    expect(orgBrokerSessionAllowed("@marshal/brain-evil", {})).toBe(false);
  });

  it("lets tenant policy replace the list", () => {
    const policy = { orgBrokerSessionExtensions: ["@acme/tool"] };
    expect(orgBrokerSessionAllowed("@acme/tool", policy)).toBe(true);
    expect(orgBrokerSessionAllowed("@marshal/brain", policy)).toBe(false);
    expect(orgBrokerSessionAllowed("@marshal/brain", { orgBrokerSessionExtensions: [] })).toBe(
      false,
    );
  });
});

describe("secure-storage allowlist plumbing", () => {
  it("is separate from the broker allowlist and does not list a non-extension", () => {
    expect(DEFAULT_ORG_BROKER_SESSION_EXTENSIONS).not.toContain("@marshal/secure-storage");
    expect(secureStorageAllowed("@marshal/vault", {})).toBe(true);
    expect(secureStorageAllowed("@marshal/brain", {})).toBe(false);
    expect(secureStorageAllowed("@marshal/vault", { secureStorageExtensions: [] })).toBe(false);
  });

  it("admission guards an identity that either list names, even when policy drops it from one", () => {
    const policy: { orgBrokerSessionExtensions?: string[]; secureStorageExtensions?: string[] } = {
      orgBrokerSessionExtensions: ["@marshal/brain"],
    };
    const guarded = (id: string) =>
      orgBrokerSessionAllowed(id, policy) || secureStorageAllowed(id, policy);
    expect(guarded("@marshal/vault")).toBe(true);
    expect(guarded("@marshal/brain")).toBe(true);
    expect(guarded("@random/tool")).toBe(false);
  });
});
