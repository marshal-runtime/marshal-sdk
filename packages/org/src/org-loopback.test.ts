import { afterEach, describe, expect, it } from "vitest";

import { startOrgLoopback, type OrgLoopbackCallback } from "./org-loopback";

let active: OrgLoopbackCallback | undefined;
afterEach(() => active?.close());

describe("startOrgLoopback", () => {
  it("serves only GET /callback on 127.0.0.1", async () => {
    active = await startOrgLoopback({ expectedState: "s", timeoutMs: 5000 });
    const base = new URL(active.redirectUri);
    expect(base.hostname).toBe("127.0.0.1");
    expect((await fetch(`${base.origin}/other?state=s&code=c`)).status).toBe(404);
    expect((await fetch(`${base.origin}/callback?state=s&code=c`, { method: "POST" })).status).toBe(
      404,
    );
    expect((await fetch(`${base.origin}/callback?state=wrong&code=c`)).status).toBe(400);
  });

  it("resolves the code once for the right state", async () => {
    active = await startOrgLoopback({ expectedState: "s", timeoutMs: 5000 });
    await fetch(`${active.redirectUri}?state=s&code=abc`);
    await expect(active.result).resolves.toBe("abc");
  });
});
