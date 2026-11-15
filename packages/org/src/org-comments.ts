import { randomUUID } from "node:crypto";

import type { OrgPostCommentResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgComments");

/** The most bytes of a comment, the same limit as a message. */
export const MAX_COMMENT_BYTES = 64 * 1024;

const QUEUE_FULL = "queue-full";
const MULTI_USER = "multiUser";

/** What a comment needs of the organization client; a pack that predates comments still satisfies it, which is why `supports` is checked before the post. */
export interface OrgCommentClient {
  supports(feature: string): boolean;
  postMessage(
    sessionId: string,
    request: { clientMsgId: string; text: string; kind: "comment" },
    source: "desktop",
  ): Promise<unknown>;
}

export interface OrgCommentsDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgCommentClient | null>;
  getSignedInOrgId: () => string | undefined;
  newId?: () => string;
}

/**
 * Posts a comment on a session the person can see: a note for the owner that never starts a turn.
 * Inert unless `org.remoteMode` is on, and refused unless the organization serves `multiUser`: a
 * runtime pack that does not know comments would post the text as an instruction, so the check
 * is the feature, never the request. Not retried and not queued offline: the person sees the error and sends again.
 */
export class OrgComments {
  constructor(private readonly deps: OrgCommentsDeps) {}

  async post(sessionId: string, text: string): Promise<OrgPostCommentResult> {
    if (this.deps.getFlags().remoteMode !== true) return { success: false, error: "disabled" };
    if (text.trim() === "") return { success: false, error: "empty" };
    if (Buffer.byteLength(text, "utf8") > MAX_COMMENT_BYTES)
      return { success: false, error: "too-large" };
    if (!this.deps.getSignedInOrgId()) return { success: false, error: "not-signed-in" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (!client.supports("messages") || !client.supports(MULTI_USER)) {
        return { success: false, error: "unsupported" };
      }
      await client.postMessage(
        sessionId,
        { clientMsgId: `comment-${this.deps.newId?.() ?? randomUUID()}`, text, kind: "comment" },
        "desktop",
      );
      return { success: true };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Comment failed: code=${failure.code} status=${failure.status ?? 0}`);
      const unreachable = failure.transient && failure.code !== QUEUE_FULL;
      return { success: false, error: unreachable ? "unreachable" : failure.code };
    }
  }
}
