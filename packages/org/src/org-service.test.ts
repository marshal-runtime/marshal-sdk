import { OrgApiError, type FetchLike } from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";
import { describe, expect, it, vi } from "vitest";

import { OrgNotSignedInError, OrgService, type OrgFlags } from "./org-service";
import type { OrgStoredSession, OrgTokenStore } from "./org-token-store";

const ON: OrgFlags = { enabled: true, signIn: true, workspaces: true, remoteSessions: false };
const OFF: OrgFlags = { enabled: false, signIn: false, workspaces: false, remoteSessions: false };
const ADA = "user:ada";

function memoryTokenStore(initial?: OrgStoredSession) {
  let current: OrgStoredSession | null = initial ?? null;
  const calls: string[] = [];
  const store: OrgTokenStore = {
    load: async () => {
      calls.push("load");
      return current;
    },
    save: async (session) => {
      calls.push("save");
      current = session;
    },
    clear: async () => {
      calls.push("clear");
      current = null;
    },
  };
  return { store, calls, peek: () => current };
}

function setup(
  options: {
    flags?: OrgFlags;
    orgUrl?: string;
    managed?: boolean;
    stored?: (org: ReturnType<typeof createInMemoryOrgProvider>) => OrgStoredSession;
    signInTimeoutMs?: number;
    revocation?: boolean;
    features?: ("signIn" | "workspaces" | "directory")[];
    openBrowser?: boolean;
    discoveryDown?: { value: boolean };
    discoveryGate?: Promise<void>;
    respond?: (url: URL) => Response | undefined;
  } = {},
) {
  const org = createInMemoryOrgProvider({
    users: [{ principal: ADA, email: "ada@example.test", displayName: "Ada" }],
    workspaces: [
      { id: "ws:platform", displayName: "Platform", repositories: [] },
      { id: "ws:growth", displayName: "Growth", repositories: [] },
    ],
    features: options.features,
  });
  const extra: { method: string; url: string; body?: string }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const canned = options.respond?.(url);
    if (canned) return canned;
    if (options.discoveryGate && url.pathname.includes("/.well-known/marshal-org")) {
      await options.discoveryGate;
    }
    if (options.discoveryDown?.value && url.pathname.includes("/.well-known/marshal-org")) {
      throw new TypeError("offline");
    }
    if (options.revocation) {
      if (url.pathname === "/idp/.well-known/openid-configuration") {
        const response = await org.fetch(input, init);
        const body: Record<string, unknown> = await response.json();
        return new Response(
          JSON.stringify({ ...body, revocation_endpoint: `${org.issuer}/revoke` }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.pathname === "/idp/revoke") {
        extra.push({
          method: init?.method ?? "GET",
          url: input,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(null, { status: 200 });
      }
    }
    return org.fetch(input, init);
  };
  const fetchSpy = vi.fn<FetchLike>(fetchImpl);
  const tokens = memoryTokenStore(options.stored?.(org));
  let orgUrl = options.orgUrl ?? org.orgUrl;
  let nowMs = Date.now();
  const opened: string[] = [];

  const browse = async (authorizationUrl: string) => {
    const redirect = await org.fetch(authorizationUrl);
    await fetch(redirect.headers.get("location")!);
  };

  const service = new OrgService({
    getFlags: () => options.flags ?? ON,
    getOrgUrl: () => ({ url: orgUrl, managed: options.managed ?? false }),
    persistOrgUrl: (url) => {
      orgUrl = url;
    },
    tokenStore: tokens.store,
    openExternal: (url) => {
      opened.push(url);
      if (options.openBrowser !== false) void browse(url);
    },
    fetch: fetchSpy,
    now: () => nowMs,
    signInTimeoutMs: options.signInTimeoutMs,
  });
  return {
    org,
    tokens,
    service,
    opened,
    fetchSpy,
    revokes: extra,
    getOrgUrl: () => orgUrl,
    setUrl: (next: string) => {
      orgUrl = next;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    browse,
  };
}

const tokenPosts = (org: ReturnType<typeof createInMemoryOrgProvider>) =>
  org.requests.filter((r) => r.method === "POST" && r.url.endsWith("/idp/token")).length;

describe("OrgService with flags off", () => {
  it("does nothing: no network, no disk, no browser, disabled status", async () => {
    const { service, fetchSpy, tokens, opened } = setup({ flags: OFF });
    const statuses = await Promise.all([
      service.getStatus(),
      service.signIn(),
      service.signOut(),
      service.whoami(),
      service.setOrgUrl("https://org.example.test"),
    ]);
    for (const status of statuses) {
      expect(status).toMatchObject({ success: true, state: "disabled", enabled: false });
    }
    expect(await service.getClient()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(tokens.calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("stays off when only org.enabled is set", async () => {
    const { service, fetchSpy } = setup({
      flags: { enabled: true, signIn: false, workspaces: false, remoteSessions: false },
    });
    expect((await service.signIn()).state).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OrgService sign-in", () => {
  it("signs in through the browser and loopback, stores tokens, and reads who you are", async () => {
    const { service, org, tokens, opened } = setup();
    const status = await service.signIn();
    expect(status).toMatchObject({
      state: "signed-in",
      orgDisplayName: "Fake Org",
      identity: { displayName: "Ada", email: "ada@example.test" },
    });
    expect(status.lastError).toBeUndefined();
    expect(opened).toHaveLength(1);
    const authUrl = new URL(opened[0]);
    expect(authUrl.origin + authUrl.pathname).toBe(`${org.issuer}/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(tokens.peek()).toMatchObject({ orgUrl: org.orgUrl });
    expect(tokens.peek()?.tokens.refreshToken).toBeTruthy();
  });

  it("ignores a callback with the wrong state and still completes with the right one", async () => {
    const { service, tokens, opened, browse } = setup({ openBrowser: false });
    const pending = service.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const redirect = new URL(opened[0]).searchParams.get("redirect_uri")!;
    const bad = await fetch(`${redirect}?code=x&state=wrong`);
    expect(bad.status).toBe(400);
    expect(tokens.peek()).toBeNull();
    await browse(opened[0]);
    expect((await pending).state).toBe("signed-in");
  });

  it("reports a short code and stays signed out when the sign-in times out", async () => {
    const { service, tokens } = setup({ openBrowser: false, signInTimeoutMs: 30 });
    const status = await service.signIn();
    expect(status).toMatchObject({ state: "signed-out", lastError: "timeout" });
    expect(tokens.peek()).toBeNull();
  });

  it("reports denied when the provider returns an error", async () => {
    const { service, org, opened } = setup({ openBrowser: false });
    const pending = service.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const authUrl = new URL(opened[0]);
    await fetch(
      `${authUrl.searchParams.get("redirect_uri")}?error=access_denied&state=${authUrl.searchParams.get("state")}`,
    );
    expect(await pending).toMatchObject({ state: "signed-out", lastError: "denied" });
    expect(tokenPosts(org)).toBe(0);
  });

  it("explains when the organization does not offer sign-in", async () => {
    const { service, opened } = setup({ features: ["workspaces"] });
    expect(await service.signIn()).toMatchObject({
      state: "signed-out",
      lastError: "sign-in-unsupported",
    });
    expect(opened).toEqual([]);
  });

  it("never exposes tokens or codes in status", async () => {
    const { service } = setup();
    const status = JSON.stringify(await service.signIn());
    expect(status).not.toMatch(/at_|rt_|code_/);
  });
});

describe("OrgService tokens", () => {
  const stored = (org: ReturnType<typeof createInMemoryOrgProvider>): OrgStoredSession => ({
    orgUrl: org.orgUrl,
    tokens: { accessToken: org.issueToken(ADA), tokenType: "Bearer", refreshToken: "rt_stored" },
  });

  it("loads a stored session for the current org URL", async () => {
    const { service } = setup({ stored });
    expect((await service.getStatus()).state).toBe("signed-in");
  });

  it("fetches the person for a restored session in the background and announces it", async () => {
    const { service } = setup({ stored });
    const changed = vi.fn<() => void>();
    const first = await service.getStatus();
    expect(first.identity).toBeUndefined();
    service.on("changed", changed);
    await vi.waitFor(async () =>
      expect((await service.getStatus()).identity?.email).toBe("ada@example.test"),
    );
    expect(changed).toHaveBeenCalled();
  });

  it("retries loading the stored session after a failed load", async () => {
    const { service, tokens } = setup({ stored });
    vi.spyOn(tokens.store, "load").mockRejectedValueOnce(new Error("safeStorage not ready"));
    await expect(service.getStatus()).rejects.toThrow("safeStorage not ready");
    expect((await service.getStatus()).state).toBe("signed-in");
  });

  it("adopts the stored session's organization when no URL is configured", async () => {
    const { service, tokens, getOrgUrl, org } = setup({ stored, orgUrl: "" });
    expect((await service.getStatus()).state).toBe("signed-in");
    expect(getOrgUrl()).toBe(org.orgUrl);
    expect(tokens.peek()).not.toBeNull();
  });

  it("stays without an organization when no URL is configured and nobody is signed in", async () => {
    const { service, getOrgUrl } = setup({ orgUrl: "" });
    const status = await service.getStatus();
    expect(status.state).not.toBe("signed-in");
    expect(status.orgUrl).toBeUndefined();
    expect(getOrgUrl()).toBe("");
  });

  it("discards a stored session that belongs to another organization URL", async () => {
    const { service, tokens } = setup({
      stored: (org) => ({ ...stored(org), orgUrl: "https://other.example.test" }),
    });
    expect((await service.getStatus()).state).toBe("signed-out");
    expect(tokens.peek()).toBeNull();
  });

  it("refreshes the access token shortly before it expires, once for concurrent callers", async () => {
    const { service, org, tokens, advance } = setup();
    await service.signIn();
    const first = tokens.peek()!.tokens.accessToken;
    advance(2 * 3_600_000);
    const [a, b] = await Promise.all([service.getAccessToken(), service.getAccessToken()]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(tokenPosts(org)).toBe(2);
    expect(tokens.peek()?.tokens.refreshToken).toBeTruthy();
  });

  it("does not refresh a token that is comfortably valid", async () => {
    const { service, org, tokens } = setup();
    await service.signIn();
    const before = tokenPosts(org);
    expect(await service.getAccessToken()).toBe(tokens.peek()!.tokens.accessToken);
    expect(tokenPosts(org)).toBe(before);
  });

  it("signs out locally when the refresh token is rejected", async () => {
    const { service, tokens } = setup({
      stored: (org) => ({
        orgUrl: org.orgUrl,
        tokens: {
          accessToken: org.issueToken(ADA),
          tokenType: "Bearer",
          refreshToken: "rt_bogus",
          expiresAt: Date.now() - 1000,
        },
      }),
    });
    await expect(service.getAccessToken()).rejects.toBeInstanceOf(OrgNotSignedInError);
    expect(tokens.peek()).toBeNull();
    expect(await service.getStatus()).toMatchObject({
      state: "signed-out",
      lastError: "session-expired",
    });
  });

  it("on a cold start with saved tokens, reports the organization's features as soon as it says signed-in", async () => {
    const { service } = setup({ stored });
    const status = await service.getStatus();
    expect(status.state).toBe("signed-in");
    expect(status.features.length).toBeGreaterThan(0);
    expect(status.featuresKnown).toBe(true);
    expect(status.discoveryFailed).toBeUndefined();
  });

  it("reports discoveryFailed, without throwing, when discovery cannot be loaded, and backs off", async () => {
    const down = { value: true };
    const { service, advance, fetchSpy } = setup({ stored, discoveryDown: down });
    const status = await service.getStatus();
    expect(status).toMatchObject({ state: "signed-in", discoveryFailed: true, features: [] });
    expect(status.featuresKnown).toBeUndefined();
    const calls = fetchSpy.mock.calls.length;
    await service.getStatus();
    expect(fetchSpy.mock.calls.length).toBe(calls);
    down.value = false;
    advance(31_000);
    const recovered = await service.getStatus();
    expect(recovered).toMatchObject({ state: "signed-in", featuresKnown: true });
    expect(recovered.discoveryFailed).toBeUndefined();
  });

  it("shares one discovery fetch between concurrent status reads and emits changed once", async () => {
    const { service, fetchSpy } = setup({ stored });
    const changed = vi.fn<() => void>();
    service.on("changed", changed);
    await Promise.all([service.getStatus(), service.getStatus(), service.getStatus()]);
    const discoveryCalls = fetchSpy.mock.calls.filter(([url]) =>
      url.includes("/.well-known/marshal-org"),
    );
    expect(discoveryCalls).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    await service.getStatus();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("ignores a discovery answer that lands after the organization URL changed", async () => {
    const gate: { release?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { service, setUrl } = setup({ stored, discoveryGate: held });
    const pending = service.getStatus();
    setUrl("https://other.example.test");
    await service.setOrgUrl("https://other.example.test").catch(() => undefined);
    gate.release?.();
    await pending.catch(() => undefined);
    const status = await service.getStatus();
    expect(status.features).toEqual([]);
    expect(status.featuresKnown).toBeUndefined();
  });

  it("requestJson returns a small JSON answer, names the refused field, and caps a response at 2 MiB", async () => {
    const respond = (url: URL) => {
      if (url.pathname.endsWith("/v1/small")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/v1/refused")) {
        return Response.json(
          { error: "invalid-request", field: "slackDestination" },
          { status: 400 },
        );
      }
      if (url.pathname.endsWith("/v1/huge")) {
        return new Response(JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 1) }));
      }
      return undefined;
    };
    const { service } = setup({ stored, respond });
    expect(await service.requestJson("GET", "/v1/small")).toEqual({ ok: true });
    await expect(service.requestJson("POST", "/v1/refused", {})).rejects.toMatchObject({
      status: 400,
      code: "invalid-request",
      message: expect.stringContaining("slackDestination"),
    });
    const huge = await service.requestJson("GET", "/v1/huge").catch((error: unknown) => error);
    expect(huge).toBeInstanceOf(OrgApiError);
    expect(huge).toMatchObject({ code: "response-too-large" });
  });

  it("gives a client that can list workspaces with the current token", async () => {
    const { service } = setup({ stored });
    const client = await service.getClient();
    expect((await client!.listWorkspaces()).map((w) => w.id)).toEqual(["ws:platform", "ws:growth"]);
  });
});

describe("OrgService sign-out", () => {
  it("revokes the refresh token when the provider has a revocation endpoint, then clears tokens", async () => {
    const { service, tokens, revokes } = setup({ revocation: true });
    await service.signIn();
    const refresh = tokens.peek()!.tokens.refreshToken;
    expect((await service.signOut()).state).toBe("signed-out");
    expect(revokes).toHaveLength(1);
    expect(revokes[0].method).toBe("POST");
    expect(new URLSearchParams(revokes[0].body).get("token")).toBe(refresh);
    expect(tokens.peek()).toBeNull();
  });

  it("clears tokens without revoking when there is no revocation endpoint", async () => {
    const { service, org, tokens } = setup();
    await service.signIn();
    await service.signOut();
    expect(org.requests.some((r) => r.url.endsWith("/revoke"))).toBe(false);
    expect(tokens.peek()).toBeNull();
  });
});

describe("OrgService org URL", () => {
  it("rejects non-https remote URLs and accepts loopback http", async () => {
    const { service, getOrgUrl, org } = setup();
    expect(await service.setOrgUrl("http://evil.example.test")).toMatchObject({
      success: false,
      error: "invalid-url",
    });
    expect(getOrgUrl()).toBe(org.orgUrl);
    expect((await service.setOrgUrl("http://localhost:8080/some/path")).orgUrl).toBe(
      "http://localhost:8080",
    );
  });

  it("refuses to change a URL pinned by an admin policy", async () => {
    const { service, getOrgUrl, org } = setup({ managed: true });
    expect(await service.setOrgUrl("https://other.example.test")).toMatchObject({
      success: false,
      error: "managed",
      orgUrlManaged: true,
    });
    expect(getOrgUrl()).toBe(org.orgUrl);
  });

  it("signs out of the old organization when the URL changes", async () => {
    const { service, tokens } = setup({
      stored: (org) => ({
        orgUrl: org.orgUrl,
        tokens: { accessToken: org.issueToken(ADA), tokenType: "Bearer" },
      }),
    });
    await service.getStatus();
    const status = await service.setOrgUrl("https://other.example.test");
    expect(status).toMatchObject({ state: "signed-out", orgUrl: "https://other.example.test" });
    expect(tokens.peek()).toBeNull();
  });
});

describe("OrgService org binding", () => {
  function twoOrgs() {
    const orgA = createInMemoryOrgProvider({
      orgUrl: "https://org-a.example.test",
      users: [{ principal: ADA, email: "ada@a.test", displayName: "Ada" }],
    });
    const orgB = createInMemoryOrgProvider({
      orgUrl: "https://org-b.example.test",
      users: [{ principal: ADA, email: "ada@b.test", displayName: "Ada" }],
    });
    const seen: { url: string; authorization?: string }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      seen.push({
        url: input,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      const origin = new URL(input).origin;
      if (origin === orgA.orgUrl) return orgA.fetch(input, init);
      if (origin === orgB.orgUrl) return orgB.fetch(input, init);
      throw new TypeError("unreachable");
    };
    let url = orgA.orgUrl;
    const tokens = memoryTokenStore();
    const tokenA = orgA.issueToken(ADA);
    void tokens.store.save({
      orgUrl: orgA.orgUrl,
      tokens: { accessToken: tokenA, tokenType: "Bearer" },
    });
    const service = new OrgService({
      getFlags: () => ON,
      getOrgUrl: () => ({ url, managed: true }),
      persistOrgUrl: () => undefined,
      tokenStore: tokens.store,
      openExternal: () => undefined,
      fetch: fetchImpl,
    });
    return {
      service,
      seen,
      tokenA,
      tokens,
      orgB,
      setUrl: (next: string) => {
        url = next;
      },
    };
  }

  it("never sends one organization's token to another when the URL changes underneath", async () => {
    const { service, seen, tokenA, orgB, setUrl, tokens } = twoOrgs();
    expect((await service.whoami()).identity?.email).toBe("ada@a.test");
    setUrl(orgB.orgUrl);
    const status = await service.whoami();
    expect(status.state).toBe("signed-out");
    expect(await service.getClient()).toBeNull();
    await expect(service.getAccessToken()).rejects.toBeInstanceOf(OrgNotSignedInError);
    expect(
      seen.filter(
        (r) => new URL(r.url).origin === orgB.orgUrl && r.authorization?.includes(tokenA),
      ),
    ).toEqual([]);
    expect(
      seen.some(
        (r) =>
          r.authorization?.includes(tokenA) &&
          new URL(r.url).origin !== "https://org-a.example.test",
      ),
    ).toBe(false);
    expect(tokens.peek()).toBeNull();
  });

  it("drops the session and emits changed when the policy URL changes", async () => {
    const { service, setUrl, orgB } = twoOrgs();
    await service.getStatus();
    const changed = vi.fn<() => void>();
    service.on("changed", changed);
    setUrl(orgB.orgUrl);
    service.onConfigChanged();
    expect(changed).toHaveBeenCalled();
    expect((await service.getStatus()).state).toBe("signed-out");
  });

  it("refreshes against the session's own organization, never the current URL", async () => {
    const { service, seen, orgB, setUrl } = twoOrgs();
    const orgA = "https://org-a.example.test";
    await service.getStatus();
    setUrl(orgB.orgUrl);
    await expect(service.getAccessToken()).rejects.toBeInstanceOf(OrgNotSignedInError);
    expect(
      seen.every((r) => new URL(r.url).origin === orgA || new URL(r.url).origin === orgB.orgUrl),
    ).toBe(true);
    expect(
      seen.some((r) => new URL(r.url).origin === orgB.orgUrl && r.url.endsWith("/token")),
    ).toBe(false);
  });

  it("discards tokens from a sign-in whose organization URL changed during the exchange", async () => {
    const { service, tokens, opened, setUrl, browse } = setup({ openBrowser: false });
    const pending = service.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    setUrl("https://org-b.example.test");
    await browse(opened[0]);
    const status = await pending;
    expect(status).toMatchObject({ state: "signed-out", lastError: "org-url-changed" });
    expect(tokens.peek()).toBeNull();
  });
});

describe("OrgService timeouts and cancel", () => {
  it("stops waiting on a token endpoint that never answers and resets the signing-in state", async () => {
    const org = createInMemoryOrgProvider({
      users: [{ principal: ADA, email: "ada@example.test", displayName: "Ada" }],
    });
    const hang: FetchLike = (input, init) =>
      input.endsWith("/idp/token")
        ? new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
        : org.fetch(input, init);
    const tokens = memoryTokenStore();
    const service = new OrgService({
      getFlags: () => ON,
      getOrgUrl: () => ({ url: org.orgUrl, managed: false }),
      persistOrgUrl: () => undefined,
      tokenStore: tokens.store,
      openExternal: (url) => {
        void org.fetch(url).then((r) => fetch(r.headers.get("location")!));
      },
      fetch: hang,
      requestTimeoutMs: 50,
    });
    const status = await service.signIn();
    expect(status.state).toBe("signed-out");
    expect(status.lastError).toBeTruthy();
    expect(tokens.peek()).toBeNull();
  });

  it("clears local tokens even when revocation hangs", async () => {
    const org = createInMemoryOrgProvider({
      users: [{ principal: ADA, email: "ada@example.test", displayName: "Ada" }],
    });
    const hang: FetchLike = (input, init) => {
      if (input.endsWith("/idp/.well-known/openid-configuration")) {
        return org.fetch(input, init).then(
          async (r) =>
            new Response(
              JSON.stringify({
                ...(await r.json()),
                revocation_endpoint: `${org.issuer}/revoke`,
              }),
            ),
        );
      }
      if (input.endsWith("/idp/revoke")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return org.fetch(input, init);
    };
    const tokens = memoryTokenStore({
      orgUrl: org.orgUrl,
      tokens: { accessToken: org.issueToken(ADA), tokenType: "Bearer", refreshToken: "rt_x" },
    });
    const service = new OrgService({
      getFlags: () => ON,
      getOrgUrl: () => ({ url: org.orgUrl, managed: false }),
      persistOrgUrl: () => undefined,
      tokenStore: tokens.store,
      openExternal: () => undefined,
      fetch: hang,
      requestTimeoutMs: 50,
    });
    await service.getStatus();
    const pending = service.signOut();
    await vi.waitFor(() => expect(tokens.peek()).toBeNull());
    expect((await pending).state).toBe("signed-out");
  });

  it("lets a signing-in attempt be cancelled without an error", async () => {
    const { service, opened } = setup({ openBrowser: false });
    const pending = service.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect((await service.getStatus()).state).toBe("signing-in");
    await service.signOut();
    expect(await pending).toMatchObject({ state: "signed-out" });
    expect((await pending).lastError).toBeUndefined();
  });

  it("records the organization id with the session and exposes it only while signed in", async () => {
    const { service, tokens } = setup();
    expect(service.signedInOrgId()).toBeUndefined();
    await service.signIn();
    expect(service.signedInOrgId()).toBe("fake");
    expect(tokens.peek()?.orgId).toBe("fake");
    await service.signOut();
    expect(service.signedInOrgId()).toBeUndefined();
  });

  it("loads stored tokens once for concurrent first calls", async () => {
    const { service, tokens } = setup();
    await Promise.all([service.getStatus(), service.getStatus(), service.whoami()]);
    expect(tokens.calls.filter((call) => call === "load")).toHaveLength(1);
  });
});
