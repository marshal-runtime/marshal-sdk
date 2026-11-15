import { describe, expect, it, vi } from "vitest";

import {
  type ProtocolClientApp,
  findOrgSessionDeepLinkInArgv,
  OrgDeepLinkRouter,
  parseOrgSessionDeepLink,
  registerOrgDeepLinkProtocol,
  shouldRegisterOrgDeepLinkProtocol,
} from "./org-deep-link";

describe("parseOrgSessionDeepLink", () => {
  it("accepts the scheme and host in any letter case", () => {
    expect(parseOrgSessionDeepLink("MARSHAL://Org-Session/s1")).toEqual({ sessionId: "s1" });
  });

  it("accepts marshal://org-session/<id>", () => {
    expect(parseOrgSessionDeepLink("marshal://org-session/s_1-AbC")).toEqual({
      sessionId: "s_1-AbC",
    });
    expect(
      parseOrgSessionDeepLink("marshal://org-session/0b9f6c1e-3c1a-4a55-9a7e-1d6f0c2b8f10"),
    ).toEqual({ sessionId: "0b9f6c1e-3c1a-4a55-9a7e-1d6f0c2b8f10" });
  });

  it.each([
    "",
    "not a url",
    "https://org-session/s1",
    "marshal://app/s1",
    "marshal://org-session",
    "marshal://org-session/",
    "marshal://org-session/s1/extra",
    "marshal://org-session/s1?x=1",
    "marshal://org-session/s1#frag",
    "marshal://user:pw@org-session/s1",
    "marshal://org-session:80/s1",
    "marshal://org-session/..%2Fetc",
    "marshal://org-session/a%20b",
    "marshal://org-session/%E0%A4%A",
    "marshal://org-session/s1;rm",
    "marshal://org-session/s1?",
    "marshal://org-session/s1#",
    "marshal://org-session:/s1",
    "marshal://org-session/./s1",
    "marshal://org-session/a/../s1",
    "marshal://org-session/..",
    " marshal://org-session/s1",
    "marshal://org-session/s1 ",
    "marshal://org-session/s\t1",
    "marshal://org-session/s1\n",
    "marshal://org-session/s\u00001",
    "marshal://org-session/s\u007f1",
    `marshal://org-session/${"a".repeat(129)}`,
  ])("rejects %s", (raw) => {
    expect(parseOrgSessionDeepLink(raw)).toBeNull();
  });
});

describe("findOrgSessionDeepLinkInArgv", () => {
  it("finds the first valid link among arguments", () => {
    expect(
      findOrgSessionDeepLinkInArgv([
        "Marshal.exe",
        "--flag",
        "marshal://org-session/bad/extra",
        "marshal://org-session/s9",
      ]),
    ).toBe("marshal://org-session/s9");
    expect(findOrgSessionDeepLinkInArgv(["Marshal.exe", "--x"])).toBeUndefined();
  });
});

describe("registerOrgDeepLinkProtocol", () => {
  it("registers the plain scheme when packaged", () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn<ProtocolClientApp["setAsDefaultProtocolClient"]>(
        () => true,
      ),
    };
    registerOrgDeepLinkProtocol(app, { defaultApp: false, execPath: "/App", argv: ["/App"] });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("marshal");
  });

  it("passes execPath and the app path in dev, where the binary is generic Electron", () => {
    const app = {
      setAsDefaultProtocolClient: vi.fn<ProtocolClientApp["setAsDefaultProtocolClient"]>(
        () => true,
      ),
    };
    registerOrgDeepLinkProtocol(app, {
      defaultApp: true,
      execPath: "/electron",
      argv: ["/electron", "dist-electron/main.js"],
    });
    const [scheme, exec, args] = app.setAsDefaultProtocolClient.mock.calls[0];
    expect([scheme, exec]).toEqual(["marshal", "/electron"]);
    expect(args?.[0]).toMatch(/dist-electron[\\/]main\.js$/);
  });
});

describe("shouldRegisterOrgDeepLinkProtocol", () => {
  it("registers for packaged and unpackaged dev runs, not for mock, E2E or an explicit opt-out", () => {
    expect(shouldRegisterOrgDeepLinkProtocol({ mockMode: false, env: {} })).toBe(true);
    expect(shouldRegisterOrgDeepLinkProtocol({ mockMode: true, env: {} })).toBe(false);
    expect(shouldRegisterOrgDeepLinkProtocol({ mockMode: false, env: { MARSHAL_E2E: "1" } })).toBe(
      false,
    );
    expect(
      shouldRegisterOrgDeepLinkProtocol({
        mockMode: false,
        env: { MARSHAL_SKIP_PROTOCOL_REGISTRATION: "1" },
      }),
    ).toBe(false);
  });
});

describe("OrgDeepLinkRouter", () => {
  it("reports whether the session exists locally, from the store", () => {
    const router = new OrgDeepLinkRouter({
      focus: vi.fn<() => void>(),
      notify: vi.fn<() => void>(),
      hasLocalSession: (id) => id === "mine",
    });
    router.handle("marshal://org-session/mine");
    expect(router.takePending()).toMatchObject({ sessionId: "mine", local: true });
    router.handle("marshal://org-session/theirs");
    expect(router.takePending()).toMatchObject({ sessionId: "theirs", local: false });
  });

  it("focuses, notifies and hands the id over once", () => {
    const focus = vi.fn<() => void>();
    const notify = vi.fn<() => void>();
    const router = new OrgDeepLinkRouter({ focus, notify, hasLocalSession: () => false });
    expect(router.handle("marshal://org-session/s1")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(router.takePending()).toEqual({ success: true, sessionId: "s1", local: false });
    expect(router.takePending()).toEqual({ success: true, sessionId: null, local: false });
  });

  it("drops invalid links without focusing or notifying", () => {
    const focus = vi.fn<() => void>();
    const notify = vi.fn<() => void>();
    const router = new OrgDeepLinkRouter({ focus, notify, hasLocalSession: () => false });
    expect(router.handle("marshal://org-session/s1?x")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(router.takePending().sessionId).toBeNull();
  });

  it("keeps a link that arrives before the renderer asks, and the latest one wins", () => {
    const router = new OrgDeepLinkRouter({
      focus: vi.fn<() => void>(),
      notify: vi.fn<() => void>(),
      hasLocalSession: () => false,
    });
    router.handle("marshal://org-session/a");
    router.handle("marshal://org-session/b");
    expect(router.takePending().sessionId).toBe("b");
  });
});
