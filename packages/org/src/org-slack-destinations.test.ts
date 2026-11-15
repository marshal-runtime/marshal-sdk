import { OrgApiError } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { OrgFlags } from "./org-service";
import { OrgSlackDestinations } from "./org-slack-destinations";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: false,
  remoteSessions: false,
  cloudMove: true,
};
const OFF: OrgFlags = { ...ON, cloudMove: false };

function make(flags: OrgFlags, answer: () => Promise<unknown>) {
  const requestJson = vi.fn<(method: "GET", route: string) => Promise<unknown>>(answer);
  return { service: new OrgSlackDestinations({ getFlags: () => flags, requestJson }), requestJson };
}

describe("OrgSlackDestinations", () => {
  it("makes no request with org.cloudMove off", async () => {
    const { service, requestJson } = make(OFF, async () => ({}));
    expect(await service.list({})).toEqual({ success: false, error: "disabled" });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("sends query, cursor, limit and session, and returns valid destinations only", async () => {
    const { service, requestJson } = make(ON, async () => ({
      destinations: [
        {
          kind: "dm",
          id: null,
          name: "Direct message with the Zyg Agents bot",
          visibility: "private",
        },
        { kind: "channel", id: "C0123ABCD", name: "#eng", visibility: "channel" },
        { kind: "channel", id: "not an id", name: "#bad", visibility: "channel" },
        { kind: "channel", id: "G0456EFGH", name: "#secret", visibility: "weird" },
      ],
      nextCursor: "2",
      truncated: true,
    }));
    const result = await service.list({ query: "en g", cursor: "1", limit: 500, sessionId: "s 1" });
    expect(requestJson).toHaveBeenCalledWith(
      "GET",
      "/v1/slack/destinations?query=en+g&cursor=1&limit=50&session=s+1",
    );
    expect(result).toEqual({
      success: true,
      destinations: [
        {
          kind: "dm",
          id: null,
          name: "Direct message with the Zyg Agents bot",
          visibility: "private",
        },
        { kind: "channel", id: "C0123ABCD", name: "#eng", visibility: "channel" },
      ],
      nextCursor: "2",
      truncated: true,
    });
  });

  it("answers unavailable for a 404 so the picker stays hidden", async () => {
    const { service } = make(ON, async () => {
      throw new OrgApiError(404, "not-found", "x");
    });
    expect(await service.list({})).toEqual({ success: false, error: "unavailable" });
  });

  it("passes a short code for Slack being down, and rejects a malformed answer", async () => {
    const down = make(ON, async () => {
      throw new OrgApiError(503, "slack-unavailable", "x");
    });
    expect(await down.service.list({})).toEqual({ success: false, error: "slack-unavailable" });
    const bad = make(ON, async () => ({ nope: true }));
    expect(await bad.service.list({})).toEqual({ success: false, error: "invalid-response" });
  });
});
