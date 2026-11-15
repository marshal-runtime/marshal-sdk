/* eslint-disable no-await-in-loop -- the outbox posts one message at a time so a session's messages keep their order */
import { randomUUID } from "node:crypto";

import {
  OrgApiError,
  type OrgClient,
  type OrgSessionMessage,
  type OrgSessionMessagePage,
  type OrgSessionView,
} from "@marshal/agent-runtime-org";
import type { MESSAGE_ERROR_CODES } from "@marshal/agent-runtime-org";

import type { OrgRemoteExecutor, OrgRemoteInbox, OrgRemoteInboxResult, OrgRemoteMessage, OrgRemoteMessageActionResult, OrgRemoteMessageRef, OrgReturnedMessage, OrgSendRemoteMessageRequest, OrgSendRemoteMessageResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import type { OrgCloudMoveStore } from "./org-cloud-move-store";
import { classifyOrgFailure } from "./org-errors";
import {
  MAX_MESSAGE_OUTBOX_ENTRIES,
  MAX_REMOTE_MESSAGE_BYTES,
  OrgMessageOutboxUnavailableError,
  type OrgMessageOutboxEntry,
  type OrgMessageOutboxStore,
} from "./org-message-outbox";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgRemoteSend");

const LIST_PAGE = 100;
const MAX_LIST_PAGES = 5;
const MAX_SHOWN = 50;

/** The part of the organization client the remote mode uses. */
export type OrgInboxClient = Pick<
  OrgClient,
  | "supports"
  | "whoami"
  | "postMessage"
  | "listMessages"
  | "cancelMessage"
  | "runHeldMessage"
  | "getSession"
>;

/**
 * Refusals a later retry cannot fix: the session's queue is full, or this person spent today's turns on a live
 * session. Both arrive as 429, which `classifyOrgFailure` marks transient.
 */
const NOT_RETRIED: ReadonlySet<string> = new Set<(typeof MESSAGE_ERROR_CODES)[number]>([
  "queue-full",
  "turn-budget-spent",
]);

type LiveCheck = { live: true } | { live: false; error: string; transient?: boolean };

/**
 * Whether a session that the cloud does not hold takes this person's messages: it must be shared with them as
 * collaborator or driver and its owner must have turned live collaboration on.
 */
function liveEnabled(view: OrgSessionView): boolean {
  return view.live?.enabled === true;
}

export interface OrgRemoteSendDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<OrgInboxClient | null>;
  getSignedInOrgId: () => string | undefined;
  /** Where the cloud-held sessions are recorded; only those accept remote sends. */
  moves: Pick<OrgCloudMoveStore, "load">;
  outbox: OrgMessageOutboxStore;
  now?: () => number;
  newId?: () => string;
}

type Prepared =
  | { success: false; error: string; transient?: boolean }
  | { success: true; client: OrgInboxClient; orgId: string };

/** The executor as the renderer reads it; `hostKind` comes only from a server that serves live sessions. */
function executorOf(info: OrgSessionMessagePage["executor"]): OrgRemoteExecutor {
  const { hostKind } = info;
  return {
    state: info.state,
    ...(info.hostLabel !== undefined ? { hostLabel: info.hostLabel } : {}),
    ...(info.estimatedStartSeconds !== undefined
      ? { estimatedStartSeconds: info.estimatedStartSeconds }
      : {}),
    ...(hostKind !== undefined ? { hostKind } : {}),
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Sends the person's messages to a session the organization's cloud holds, by posting them to
 * the session's inbox, and reports how each one is doing. Inert unless `org.remoteMode` is on:
 * with the flag off no method touches the network or the disk.
 *
 * A message that cannot reach the organization waits in an encrypted outbox and posts when the
 * connection is back, under the same `clientMsgId`, so a retry never sends it twice.
 */
export class OrgRemoteSend {
  private flushing: Promise<void> | null = null;
  private outboxQueue: Promise<void> = Promise.resolve();
  private principal: { orgId: string; value: string } | null = null;
  private readonly returning = new Map<string, number>();
  private readonly sending = new Map<string, Set<Promise<unknown>>>();
  /** The last answer about whether a shared session is live, so a message written offline can wait for the connection. */
  private readonly liveKnown = new Map<string, { orgId: string; live: boolean }>();

  constructor(private readonly deps: OrgRemoteSendDeps) {}

  private get enabled(): boolean {
    return this.deps.getFlags().remoteMode === true;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Marks a session as on its way back to this desktop for as long as Continue here runs, which can
   * take a minute: its move entry stays `cloud` until the end, but nothing may be posted for it now,
   * or the text would be neither returned nor run. Returns the call that ends the mark.
   */
  beginReturn(sessionId: string): () => void {
    this.returning.set(sessionId, (this.returning.get(sessionId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.returning.get(sessionId) ?? 1) - 1;
      if (left > 0) this.returning.set(sessionId, left);
      else this.returning.delete(sessionId);
    };
  }

  private isCloudHeld(sessionId: string, orgId: string): boolean {
    if (this.returning.has(sessionId)) return false;
    return this.deps.moves
      .load()
      .some((m) => m.sessionId === sessionId && m.orgId === orgId && m.state === "cloud");
  }

  /** True for a session this desktop moved to the cloud at some point: its own session, never a shared one. */
  private isOwnMovedSession(sessionId: string, orgId: string): boolean {
    return this.deps.moves.load().some((m) => m.sessionId === sessionId && m.orgId === orgId);
  }

  /** Asks the organization whether this person may instruct a session the cloud does not hold. */
  private async checkLive(
    client: OrgInboxClient,
    sessionId: string,
    orgId: string,
  ): Promise<LiveCheck> {
    let view: Awaited<ReturnType<OrgInboxClient["getSession"]>>;
    try {
      view = await client.getSession(sessionId);
    } catch (error) {
      const failure = classifyOrgFailure(error);
      const known = this.liveKnown.get(sessionId);
      if (failure.transient && known?.orgId === orgId && known.live) return { live: true };
      return {
        live: false,
        error: failure.transient ? "unreachable" : failure.code,
        transient: failure.transient,
      };
    }
    let check: LiveCheck;
    if (view.role === "owner") check = { live: false, error: "not-in-cloud" };
    else if (view.role === "viewer") check = { live: false, error: "viewer" };
    else if (!client.supports("liveSessions")) {
      check = { live: false, error: "live-unsupported" };
    } else if (!liveEnabled(view)) check = { live: false, error: "not-live" };
    else check = { live: true };
    this.liveKnown.set(sessionId, { orgId, live: check.live });
    return check;
  }

  private async connect(): Promise<Prepared> {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    let client: OrgInboxClient | null;
    try {
      client = await this.deps.getClient();
    } catch (error) {
      const failure = classifyOrgFailure(error);
      return { success: false, error: "unreachable", transient: failure.code !== "not-signed-in" };
    }
    if (!client) return { success: false, error: "not-signed-in" };
    if (!client.supports("messages")) return { success: false, error: "messages-unsupported" };
    return { success: true, client, orgId };
  }

  private async me(client: OrgInboxClient, orgId: string): Promise<string> {
    if (this.principal?.orgId === orgId) return this.principal.value;
    const { principal } = await client.whoami();
    this.principal = { orgId, value: principal };
    return principal;
  }

  private async loadOutbox(): Promise<OrgMessageOutboxEntry[]> {
    return this.deps.outbox.load();
  }

  /** Runs one change of the outbox at a time: each loads the file, changes it and saves it, so two overlapping would lose one. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.outboxQueue.then(work);
    this.outboxQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Adds an entry to the outbox; a full or unwritable outbox says so instead of dropping the message. */
  private addEntry(
    entry: OrgMessageOutboxEntry,
  ): Promise<"ok" | "outbox-full" | "outbox-unavailable"> {
    return this.exclusive(async () => {
      const entries = await this.loadOutbox();
      if (entries.length >= MAX_MESSAGE_OUTBOX_ENTRIES) return "outbox-full";
      entries.push(entry);
      try {
        await this.deps.outbox.save(entries);
      } catch (error) {
        if (error instanceof OrgMessageOutboxUnavailableError) return "outbox-unavailable";
        throw error;
      }
      return "ok";
    });
  }

  /** Changes an entry where it stands, so a retry never reorders the queue; false when it is no longer there (taken back or reclaimed meanwhile), and then nothing is written. */
  private updateEntry(
    orgId: string,
    clientMsgId: string,
    change: (entry: OrgMessageOutboxEntry) => OrgMessageOutboxEntry,
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const entries = await this.loadOutbox();
      const at = entries.findIndex((e) => e.orgId === orgId && e.clientMsgId === clientMsgId);
      if (at < 0) return false;
      entries[at] = change(entries[at]);
      await this.deps.outbox.save(entries);
      return true;
    });
  }

  /** Removes and returns the entries that match. */
  private takeEntries(
    match: (entry: OrgMessageOutboxEntry) => boolean,
  ): Promise<OrgMessageOutboxEntry[]> {
    return this.exclusive(async () => {
      const entries = await this.loadOutbox();
      const taken = entries.filter(match);
      if (taken.length > 0) await this.deps.outbox.save(entries.filter((e) => !match(e)));
      return taken;
    });
  }

  private outboxMessage(entry: OrgMessageOutboxEntry): OrgRemoteMessage {
    return {
      clientMsgId: entry.clientMsgId,
      text: entry.text,
      status: entry.state === "failed" ? "failed" : "offline",
      mine: true,
      source: "desktop",
      at: new Date(entry.queuedAt).toISOString(),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /**
   * Waits, for at most `maxMs`, for the sends of this session that are already in flight, so a
   * Continue here that took the mark first does not take the lease while a post is on its way.
   */
  async settleSends(sessionId: string, maxMs: number): Promise<void> {
    const pending = this.sending.get(sessionId);
    if (!pending || pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...pending]), limit]);
    clearTimeout(timer);
  }

  send(request: OrgSendRemoteMessageRequest): Promise<OrgSendRemoteMessageResult> {
    const run = this.sendMessage(request);
    const inFlight = this.sending.get(request.sessionId) ?? new Set<Promise<unknown>>();
    inFlight.add(run);
    this.sending.set(request.sessionId, inFlight);
    return run.finally(() => {
      inFlight.delete(run);
      if (inFlight.size === 0 && this.sending.get(request.sessionId) === inFlight) {
        this.sending.delete(request.sessionId);
      }
    });
  }

  private async sendMessage(
    request: OrgSendRemoteMessageRequest,
  ): Promise<OrgSendRemoteMessageResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const { sessionId, text } = request;
    if (text.trim() === "") return { success: false, error: "empty" };
    if (utf8Bytes(text) > MAX_REMOTE_MESSAGE_BYTES) return { success: false, error: "too-large" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const cloud = this.isCloudHeld(sessionId, orgId);
    if (!cloud && this.isOwnMovedSession(sessionId, orgId)) {
      return { success: false, error: "not-in-cloud" };
    }
    const stillSendable = () => (cloud ? this.isCloudHeld(sessionId, orgId) : true);

    const clientMsgId = `desktop-${this.deps.newId?.() ?? randomUUID()}`;
    const entry: OrgMessageOutboxEntry = {
      sessionId,
      orgId,
      clientMsgId,
      text,
      queuedAt: this.now(),
      attempts: 0,
      state: "pending",
    };
    const outbox = await this.loadOutbox();
    const behindOthers = outbox.some(
      (e) => e.orgId === orgId && e.sessionId === sessionId && e.state === "pending",
    );
    if (!cloud) {
      const prepared = await this.connect();
      if (!prepared.success) {
        const known = this.liveKnown.get(sessionId);
        if (!prepared.transient || !(known?.orgId === orgId && known.live)) {
          return { success: false, error: prepared.error };
        }
      } else {
        const check = await this.checkLive(prepared.client, sessionId, orgId);
        if (!check.live) return { success: false, error: check.error };
      }
    }
    if (!behindOthers) {
      const prepared = await this.connect();
      if (!prepared.success) {
        if (!prepared.transient) return { success: false, error: prepared.error };
      } else {
        try {
          const posted = await prepared.client.postMessage(
            sessionId,
            { clientMsgId, text },
            "desktop",
          );
          if (!stillSendable()) {
            // Continue here took the mark while the post was on its way: the text stays in the composer, so the stored copy goes.
            // Only a 409 means the cloud already ran or returned it (the composer clears as for any sent message); a cancel whose answer
            // was lost may have worked, so the text stays, and a duplicate in the draft is the lesser harm.
            if ((await this.cancelPosted(prepared.client, sessionId, posted.id)) !== "already") {
              return { success: false, error: "not-in-cloud" };
            }
          }
          return {
            success: true,
            message: {
              id: posted.id,
              clientMsgId,
              text,
              status: posted.status,
              mine: true,
              source: "desktop",
              at: new Date(this.now()).toISOString(),
              position: posted.position,
            },
          };
        } catch (error) {
          const failure = classifyOrgFailure(error);
          log.warn(`Remote send failed: code=${failure.code} status=${failure.status ?? 0}`);
          if (!failure.transient || NOT_RETRIED.has(failure.code)) {
            return { success: false, error: failure.code };
          }
        }
      }
    }
    // The chat may have left the cloud while the awaits above ran; a message kept for the cloud now would be neither run nor returned.
    if (!stillSendable()) return { success: false, error: "not-in-cloud" };
    const added = await this.addEntry(entry);
    if (added !== "ok") return { success: false, error: added };
    return { success: true, message: this.outboxMessage(entry) };
  }

  /** Posts what is waiting in the outbox, oldest first; a session stops at its first message that cannot go. */
  flushOutbox(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return;
    const entries = (await this.loadOutbox()).filter(
      (e) => e.orgId === orgId && e.state === "pending",
    );
    if (entries.length === 0) return;
    const prepared = await this.connect();
    if (!prepared.success) return;
    const blocked = new Set<string>();
    try {
      for (const entry of entries) {
        if (blocked.has(entry.sessionId)) continue;
        if (this.returning.has(entry.sessionId)) {
          // Continue here is running: leave the entry pending for it to hand back (or for the next flush if it fails).
          blocked.add(entry.sessionId);
          continue;
        }
        if (
          !this.isCloudHeld(entry.sessionId, orgId) &&
          !this.isOwnMovedSession(entry.sessionId, orgId)
        ) {
          // A shared session: it goes only while its owner keeps live collaboration on and this person may instruct it.
          // eslint-disable-next-line no-await-in-loop -- one session view at a time, in outbox order
          const check = await this.checkLive(prepared.client, entry.sessionId, orgId);
          if (!check.live) {
            if (!check.transient) {
              // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
              await this.updateEntry(orgId, entry.clientMsgId, (e) => ({
                ...e,
                state: "failed",
                error: check.error,
              }));
            }
            blocked.add(entry.sessionId);
            continue;
          }
        } else if (!this.isCloudHeld(entry.sessionId, orgId)) {
          // The cloud no longer holds this chat: nothing is posted, and Continue here hands the text back through reclaim.
          // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
          await this.updateEntry(orgId, entry.clientMsgId, (e) => ({
            ...e,
            state: "failed",
            error: "not-in-cloud",
          }));
          blocked.add(entry.sessionId);
          continue;
        }
        let postedId: string;
        try {
          // eslint-disable-next-line no-await-in-loop -- posts keep the order of the messages
          const posted = await prepared.client.postMessage(
            entry.sessionId,
            { clientMsgId: entry.clientMsgId, text: entry.text },
            "desktop",
          );
          postedId = posted.id;
        } catch (error) {
          const failure = classifyOrgFailure(error);
          log.warn(
            `Queued message retry failed: code=${failure.code} transient=${failure.transient}`,
          );
          if (failure.transient && !NOT_RETRIED.has(failure.code)) {
            // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
            await this.updateEntry(orgId, entry.clientMsgId, (e) => ({
              ...e,
              attempts: e.attempts + 1,
            }));
            if (failure.code === "not-signed-in" || failure.code === "unreachable") return;
          } else {
            // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
            await this.updateEntry(orgId, entry.clientMsgId, (e) => ({
              ...e,
              state: "failed",
              error: failure.code,
            }));
          }
          blocked.add(entry.sessionId);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
        const taken = await this.takeEntries(
          (e) => e.orgId === orgId && e.clientMsgId === entry.clientMsgId,
        );
        // Taken back or reclaimed while the post was in flight: the text is in the composer now, so the stored copy is cancelled.
        // eslint-disable-next-line no-await-in-loop -- one outbox change at a time
        if (taken.length === 0) await this.cancelPosted(prepared.client, entry.sessionId, postedId);
      }
    } catch (error) {
      if (error instanceof OrgMessageOutboxUnavailableError) {
        log.warn("The message outbox could not be updated");
        return;
      }
      throw error;
    }
  }

  private async cancelPosted(
    client: OrgInboxClient,
    sessionId: string,
    messageId: string,
  ): Promise<"cancelled" | "already" | "failed"> {
    try {
      await client.cancelMessage(sessionId, messageId);
      return "cancelled";
    } catch (error) {
      if (error instanceof OrgApiError && error.status === 409) return "already";
      log.warn(
        `Could not cancel a message that was taken back: code=${classifyOrgFailure(error).code}`,
      );
      return "failed";
    }
  }

  async getInbox(sessionId: string): Promise<OrgRemoteInboxResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    const waiting = (await this.loadOutbox())
      .filter((e) => e.orgId === orgId && e.sessionId === sessionId)
      .map((e) => this.outboxMessage(e));
    const prepared = await this.connect();
    if (!prepared.success) {
      if (prepared.error === "unreachable") return this.offlineInbox(waiting);
      return { success: false, error: prepared.error };
    }
    try {
      const me = await this.me(prepared.client, orgId);
      const listed: OrgSessionMessage[] = [];
      let executor: OrgRemoteExecutor = { state: "none" };
      let after = 0;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await prepared.client.listMessages(sessionId, { after, limit: LIST_PAGE });
        executor = executorOf(result.executor);
        listed.push(...result.messages);
        if (result.messages.length < LIST_PAGE) break;
        after = result.messages[result.messages.length - 1].seq;
      }
      const posted = new Set(listed.map((m) => m.clientMsgId));
      const inbox: OrgRemoteInbox = {
        executor,
        messages: [
          ...listed.slice(-MAX_SHOWN).map((m) => this.fromInbox(m, me)),
          ...waiting.filter((m) => !posted.has(m.clientMsgId)),
        ],
      };
      return { success: true, ...inbox };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Inbox read failed: code=${failure.code} status=${failure.status ?? 0}`);
      if (failure.transient) return this.offlineInbox(waiting);
      return { success: false, error: failure.code };
    }
  }

  private offlineInbox(waiting: OrgRemoteMessage[]): OrgRemoteInboxResult {
    return { success: true, executor: { state: "none" }, messages: waiting, offline: true };
  }

  private fromInbox(message: OrgSessionMessage, me: string): OrgRemoteMessage {
    const mine = message.author === me;
    const kind: unknown = Reflect.get(message, "kind");
    return {
      id: message.id,
      clientMsgId: message.clientMsgId,
      text: message.text,
      status: message.status,
      mine,
      ...(mine
        ? {}
        : { authorLabel: message.author.replace(/^user:/, ""), roleLabel: message.roleAtSend }),
      ...(kind === "comment" ? { kind: "comment" as const } : {}),
      source: message.source,
      at: message.at,
    };
  }

  /** Cancels a queued or held message, or takes back one still in the outbox; the text comes back so the composer can have it. */
  async cancel(ref: OrgRemoteMessageRef): Promise<OrgRemoteMessageActionResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const orgId = this.deps.getSignedInOrgId();
    if (!orgId) return { success: false, error: "not-signed-in" };
    if (!ref.messageId) {
      const [entry] = await this.takeEntries(
        (e) => e.orgId === orgId && e.clientMsgId === ref.clientMsgId,
      );
      if (!entry) return { success: false, error: "not-found" };
      return { success: true, text: entry.text };
    }
    const prepared = await this.connect();
    if (!prepared.success) return { success: false, error: prepared.error };
    try {
      const cancelled = await prepared.client.cancelMessage(ref.sessionId, ref.messageId);
      return { success: true, text: cancelled.text };
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }
  }

  /** The owner runs a message someone else wrote: it becomes the owner's own queued message. */
  async runHeld(ref: OrgRemoteMessageRef): Promise<OrgRemoteMessageActionResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!ref.messageId) return { success: false, error: "not-found" };
    const prepared = await this.connect();
    if (!prepared.success) return { success: false, error: prepared.error };
    try {
      await prepared.client.runHeldMessage(ref.sessionId, ref.messageId, {
        clientMsgId: `run-${ref.messageId}`,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: classifyOrgFailure(error).code };
    }
  }

  /**
   * Hands back what never reached the cloud when the person takes the session back: every message
   * still in the outbox for it. Needs no network and no flag, so a message written while remote
   * mode was on is never stranded.
   */
  async reclaim(sessionId: string): Promise<OrgReturnedMessage[]> {
    const mine = await this.takeEntries((e) => e.sessionId === sessionId);
    return mine
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .map((e) => ({ clientMsgId: e.clientMsgId, text: e.text }));
  }
}

/** What an agent is told when its message to a shared session cannot go; each names the next step it can take. */
const AGENT_SEND_REFUSALS: Record<string, string> = {
  viewer:
    "You can only view this shared session, so you cannot send it messages. Ask its owner for the collaborator role, or read it with getSessionTranscript.",
  "not-live":
    "This shared session does not take messages: its owner has not turned on live collaboration (their Marshal may need an update). Read it with getSessionTranscript.",
  "live-unsupported":
    "Your organization does not take messages for shared sessions yet. Read it with getSessionTranscript.",
  disabled:
    "Sending to shared sessions is turned off on this computer (organization remote mode). Read it with getSessionTranscript.",
  "not-signed-in": "Sign in to your organization in Marshal's settings first.",
  unreachable: "Could not reach your organization. Try again in a moment.",
  "queue-full": "Too many messages already wait to run in this session. Try again after some run.",
  "turn-budget-spent":
    "You have used today's messages for this live session. Its owner can raise the daily limit; otherwise try again tomorrow.",
  "too-large": "That message is too long (64 KB at most).",
  empty: "The message is empty.",
};

/**
 * messageSession for a session shared with the person: posts to its inbox through the same path as the shared
 * view's composer, so it waits and runs like a message the person typed. The answer is typed for the agent.
 */
export function createSharedSessionSendPort(remote: Pick<OrgRemoteSend, "send">): {
  send(request: {
    sessionId: string;
    text: string;
  }): Promise<
    | { success: true; messageId: string; status: OrgRemoteMessage["status"] }
    | { success: false; error: string; message: string }
  >;
} {
  return {
    async send({ sessionId, text }) {
      const result = await remote.send({ sessionId, text });
      if (result.success) {
        return {
          success: true,
          messageId: result.message.id ?? result.message.clientMsgId,
          status: result.message.status,
        };
      }
      return {
        success: false,
        error: result.error,
        message: AGENT_SEND_REFUSALS[result.error] ?? `The message was not sent (${result.error}).`,
      };
    },
  };
}
