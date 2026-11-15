import { OrgApiError } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import { MAX_COMMENT_BYTES, OrgComments, type OrgCommentClient } from "./org-comments";
import type { OrgFlags } from "./org-service";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  sessionSharing: true,
  cloudMove: true,
  remoteMode: true,
};

function setup(
  options: {
    flags?: OrgFlags;
    features?: string[];
    client?: OrgCommentClient | null;
    orgId?: string | undefined;
  } = {},
) {
  const postMessage = vi.fn<OrgCommentClient["postMessage"]>(async () => ({
    id: "m",
    seq: 1,
    status: "held",
    position: 0,
    executor: { state: "none" },
  }));
  const features = options.features ?? ["messages", "multiUser"];
  const client: OrgCommentClient | null =
    options.client === undefined
      ? { supports: (feature: string) => features.includes(feature), postMessage }
      : options.client;
  const comments = new OrgComments({
    getFlags: () => options.flags ?? ON,
    getClient: async () => client,
    getSignedInOrgId: () => ("orgId" in options ? options.orgId : "org-1"),
    newId: () => "id-1",
  });
  return { comments, postMessage };
}

describe("OrgComments", () => {
  it("posts a comment kind from the desktop and nothing else", async () => {
    const { comments, postMessage } = setup();
    expect(await comments.post("s1", "is this right?")).toEqual({ success: true });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      "s1",
      { clientMsgId: "comment-id-1", text: "is this right?", kind: "comment" },
      "desktop",
    );
  });

  it("is inert while org.remoteMode is off", async () => {
    const { comments, postMessage } = setup({ flags: { ...ON, remoteMode: false } });
    expect(await comments.post("s1", "hi")).toEqual({ success: false, error: "disabled" });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("never posts when the organization does not serve multiUser, so a comment cannot become an instruction", async () => {
    const { comments, postMessage } = setup({ features: ["messages"] });
    expect(await comments.post("s1", "hi")).toEqual({ success: false, error: "unsupported" });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("refuses an empty or oversized text and a signed-out user before any request", async () => {
    const { comments, postMessage } = setup();
    expect(await comments.post("s1", "   ")).toEqual({ success: false, error: "empty" });
    expect(await comments.post("s1", "x".repeat(MAX_COMMENT_BYTES + 1))).toEqual({
      success: false,
      error: "too-large",
    });
    expect(await setup({ orgId: undefined }).comments.post("s1", "hi")).toEqual({
      success: false,
      error: "not-signed-in",
    });
    expect(await setup({ client: null }).comments.post("s1", "hi")).toEqual({
      success: false,
      error: "not-signed-in",
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("reports the server's refusal and a network failure by name", async () => {
    const refused = setup();
    refused.postMessage.mockRejectedValue(new OrgApiError(403, "forbidden", "no"));
    expect(await refused.comments.post("s1", "hi")).toEqual({ success: false, error: "forbidden" });
    const down = setup();
    down.postMessage.mockRejectedValue(new OrgApiError(0, "unreachable", "down"));
    expect(await down.comments.post("s1", "hi")).toEqual({ success: false, error: "unreachable" });
  });

  it("passes a full comment queue through by code instead of calling the organization unreachable", async () => {
    const full = setup();
    full.postMessage.mockRejectedValue(new OrgApiError(429, "queue-full", "too many"));
    expect(await full.comments.post("s1", "hi")).toEqual({ success: false, error: "queue-full" });
    const busy = setup();
    busy.postMessage.mockRejectedValue(new OrgApiError(503, "unavailable", "busy"));
    expect(await busy.comments.post("s1", "hi")).toEqual({ success: false, error: "unreachable" });
  });
});
