import {
  OrgApiError,
  type OrgExecutorInfo,
  type OrgSessionMessage,
  type OrgSessionView,
  type SessionRole,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";

import type { OrgInboxClient } from "./org-remote-send";

type Message = OrgSessionMessage;
type Executor = OrgExecutorInfo;

const MAX_QUEUED = 10;

/**
 * A stand-in for the organization's session inbox that follows the runtime's `messages` contract
 * (runtime PR #28): idempotent posts by `clientMsgId`, 409 `not-in-cloud` unless the cloud is the
 * session's home, 429 `queue-full` at 10 queued or claimed, others' posts `held`, and 409
 * `conflict` when cancelling anything past `queued` or `held`. The pack's in-memory
 * provider does not serve the inbox routes yet, so the desktop keeps this one.
 */
export class FakeOrgInbox {
  home: "cloud" | "desktop" = "cloud";
  executor: Executor = { state: "running" };
  /** The organization serves `liveSessions` (live collaboration on a desktop-held session). */
  liveFeature = false;
  /** The owner turned live collaboration on for the session: a desktop-home session then takes everyone's instructions. */
  live = false;
  /** The caller's role on the session, as `getSession` reports it. */
  role: SessionRole = "owner";
  /** This participant started all of today's turns on the live session: posts get 429 `turn-budget-spent`. */
  budgetSpent = false;
  /** Reads of the session view, to show which paths ask the organization whether a session is live. */
  sessionReads = 0;
  readonly messages: Message[] = [];
  readonly posts: Array<{ sessionId: string; clientMsgId: string; source?: string }> = [];
  /** Fails the next calls with this error, once each, to model a lost connection. */
  failWith: Error[] = [];
  private nextSeq = 1;

  constructor(readonly me: UserPrincipal = "user:alice") {}

  private fail(): void {
    const error = this.failWith.shift();
    if (error) throw error;
  }

  private uuid(): string {
    return `00000000-0000-4000-8000-${String(this.nextSeq).padStart(12, "0")}`;
  }

  private ahead(): number {
    return this.messages.filter((m) => m.status === "queued" || m.status === "claimed").length;
  }

  private add(author: UserPrincipal, clientMsgId: string, text: string, status: Message["status"]) {
    const message: Message = {
      id: this.uuid(),
      seq: this.nextSeq,
      clientMsgId,
      author,
      source: "desktop",
      roleAtSend: author === this.me ? "owner" : "collaborator",
      text,
      status,
      at: new Date(1_700_000_000_000 + this.nextSeq * 1000).toISOString(),
    };
    this.nextSeq += 1;
    this.messages.push(message);
    return message;
  }

  /** Someone else wrote to the session; for a non-owner the server stores it `held`. */
  addFrom(author: UserPrincipal, text: string): Message {
    return this.add(author, `other-${this.nextSeq}`, text, "held");
  }

  client(): OrgInboxClient {
    return {
      supports: (feature) =>
        feature === "messages" || (feature === "liveSessions" && this.liveFeature),
      getSession: async (sessionId) => {
        this.fail();
        this.sessionReads += 1;
        const view: OrgSessionView = {
          session: {
            id: sessionId,
            workspaceId: "ws:platform",
            title: "Shared",
            owner: this.role === "owner" ? this.me : "user:ada",
            createdAt: "2026-11-12T08:00:00Z",
            updatedAt: "2026-11-12T08:00:00Z",
            labels: "team",
            runtime: "claude",
            transcript: { messageCount: 0, bytes: 0 },
          },
          role: this.role,
        };
        return this.liveFeature ? { ...view, live: { enabled: this.live } } : view;
      },
      whoami: async () => ({
        orgId: "org",
        principal: this.me,
        email: "alice@example.com",
        displayName: "Alice",
        groups: [],
        roles: [],
      }),
      postMessage: async (sessionId, request, source) => {
        this.fail();
        this.posts.push({ sessionId, clientMsgId: request.clientMsgId, source });
        const existing = this.messages.find((m) => m.clientMsgId === request.clientMsgId);
        if (existing) {
          return {
            id: existing.id,
            seq: existing.seq,
            status: existing.status,
            position: 0,
            executor: this.executor,
          };
        }
        const liveHere = this.home !== "cloud" && this.liveFeature && this.live;
        if (this.home !== "cloud" && !liveHere) {
          throw new OrgApiError(409, "not-in-cloud", "not in cloud");
        }
        if (this.role === "viewer") throw new OrgApiError(403, "forbidden", "forbidden");
        if (liveHere && this.budgetSpent) {
          throw new OrgApiError(429, "turn-budget-spent", "turn budget spent");
        }
        if (this.ahead() >= MAX_QUEUED) throw new OrgApiError(429, "queue-full", "queue full");
        const position = this.ahead();
        const message = this.add(this.me, request.clientMsgId, request.text, "queued");
        return {
          id: message.id,
          seq: message.seq,
          status: message.status,
          position,
          executor: this.executor,
        };
      },
      listMessages: async (_sessionId, input = {}) => {
        this.fail();
        const after = input.after ?? 0;
        const limit = input.limit ?? 50;
        return {
          messages: this.messages.filter((m) => m.seq > after).slice(0, limit),
          executor: this.executor,
        };
      },
      cancelMessage: async (_sessionId, messageId) => {
        this.fail();
        const message = this.messages.find((m) => m.id === messageId);
        if (!message) throw new OrgApiError(404, "not-found", "not found");
        if (message.status !== "queued" && message.status !== "held") {
          throw new OrgApiError(409, "conflict", "conflict");
        }
        message.status = "cancelled";
        return message;
      },
      runHeldMessage: async (_sessionId, messageId, request) => {
        this.fail();
        const held = this.messages.find((m) => m.id === messageId);
        if (!held || held.status !== "held") throw new OrgApiError(409, "conflict", "conflict");
        const existing = this.messages.find((m) => m.clientMsgId === request.clientMsgId);
        if (existing) {
          return {
            id: existing.id,
            seq: existing.seq,
            status: existing.status,
            position: 0,
            executor: this.executor,
          };
        }
        held.status = "cancelled";
        const position = this.ahead();
        const message = this.add(this.me, request.clientMsgId, held.text, "queued");
        return {
          id: message.id,
          seq: message.seq,
          status: "queued",
          position,
          executor: this.executor,
        };
      },
    };
  }
}
