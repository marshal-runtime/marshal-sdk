/**
 * A host whose sessions people open and drive from their own Marshal through the organization, with no link.
 *
 * The bridge publishes the host's sessions as org sessions (src/org-publish.ts: envelope, transcript, checkpoint),
 * holds each one's lease as its executor and turns live collaboration on, so the owner and anyone the owner granted
 * `collaborator` or `driver` can post instructions from their desktop. It asks the org for pending work every
 * `pollSeconds`, claims a session's queued messages, runs them in the session (each as a message from that person),
 * marks them done with the answer, and appends the turn to the org transcript with a fresh checkpoint.
 *
 * The org accepts a session only from its owner and lets only the owner's own desktop run other people's live
 * messages, so the client holds the owner's token (docs/org-bridge.md names the service identity a fleet would need).
 * Writing to anything but a test organization is refused unless `allowProductionOrg` is set.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { OrgClient, OrgSessionMessage, UserPrincipal } from "@marshal/agent-runtime-org";

import { localSessionIdOf, publishToOrg, type OrgPublishOptions, type OrgPublishResult } from "./org-publish.js";
import type { DeliveryResult, SessionEnvelope } from "./session-messages.js";
import type { FileSessionStore } from "./session-store.js";

export type OrgBridgeClient = Pick<
  OrgClient,
  | "discovery"
  | "supports"
  | "putSession"
  | "putTranscript"
  | "acquireLease"
  | "heartbeatLease"
  | "putEnvelope"
  | "releaseLease"
  | "setSessionLive"
  | "listLivePending"
  | "claimMessages"
  | "completeMessages"
>;

export interface OrgBridgeOptions extends Omit<OrgPublishOptions, "client" | "store" | "sessionIds" | "holdLease" | "inboxMessageId"> {
  client: OrgBridgeClient;
  store: FileSessionStore;
  /** Runs a message in a session; the host's agent port (`host.agents`). */
  agents: { deliver(envelope: SessionEnvelope): Promise<DeliveryResult> };
  /**
   * Writing to a real organization. Off: the bridge starts only against a test organization (a loopback host, or a
   * name under .test, .example, .invalid or .localhost). Whether a host writes to the production org is the owner's call.
   */
  allowProductionOrg?: boolean;
  /** Turn live collaboration on for every published session, so granted people's instructions run here. Default true. */
  live?: boolean;
  participantTurnsPerDay?: number;
  /** Longest wait for one message's turn before it is marked done with a note. Default 30 minutes. */
  turnTimeoutMs?: number;
  /** How often to publish what the host's own turns added. Default 30 s. */
  syncSeconds?: number;
  /** A person's display name for the sender line; default their principal without `user:`. */
  nameOf?: (principal: UserPrincipal) => string | undefined;
  log?: (line: string) => void;
}

export type OrgLeaseState = "held" | "elsewhere" | "lost";

export interface OrgBridgeSession {
  sessionId: string;
  orgSessionId: string;
  lease: OrgLeaseState;
  live: boolean;
  /** Org messages this host ran in the session. */
  ran: number;
}

export interface OrgBridgeTurn {
  sessionId: string;
  orgSessionId: string;
  turnId: string;
  messages: { id: string; author: UserPrincipal; text: string }[];
  final: string;
  error?: string;
}

export interface OrgBridge {
  readonly host: string;
  sessions(): OrgBridgeSession[];
  /** Publishes what is new, takes the leases of new sessions and turns them live. */
  sync(): Promise<OrgPublishResult[]>;
  /** Asks the org for pending work once and starts a turn for every session that has some; `idle()` waits for them. */
  poll(): Promise<{ started: string[]; pollSeconds: number }>;
  idle(): Promise<OrgBridgeTurn[]>;
  /** Renews every held lease; a lease another host took (410) is marked lost and never taken back. Runs every 30 s once started. */
  heartbeat(): Promise<void>;
  /** Syncs and polls on a timer until `close()`. */
  start(): void;
  /** Stops the timer, waits for running turns, publishes them with a checkpoint and gives the leases back. */
  close(): Promise<void>;
}

const LEASE_TTL_SECONDS = 120;
const HEARTBEAT_MS = 30_000;
const MAX_CLAIM = 5;
const MAX_FINAL_CHARS = 32_000;
const INBOX_FILE = "org-inbox.json";
const TEST_HOST = /(^|\.)(test|example|invalid|localhost)$/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Whether an org API address is a test organization (loopback, or a reserved test name), not a real one. */
export function isTestOrg(apiBase: string): boolean {
  let host: string;
  try {
    host = new URL(apiBase).hostname;
  } catch {
    return false;
  }
  return LOOPBACK.has(host) || TEST_HOST.test(host);
}

export function createOrgBridge(options: OrgBridgeOptions): OrgBridge {
  const apiBase = options.client.discovery.apiBase;
  if (!isTestOrg(apiBase) && options.allowProductionOrg !== true) {
    throw Object.assign(
      new Error(`Refusing to write to the organization at ${new URL(apiBase).host}: the org bridge writes only to a test organization unless allowProductionOrg is set.`),
      { code: "production-org-off" },
    );
  }
  for (const feature of ["sessions", "leases", "messages", "liveSessions"] as const) {
    if (!options.client.supports(feature)) throw Object.assign(new Error(`The organization does not serve "${feature}".`), { code: "unsupported" });
  }
  const { client, store, host } = options;
  const log = options.log ?? (() => undefined);
  const wantLive = options.live !== false;
  const state = new Map<string, OrgBridgeSession>();
  const running = new Map<string, Promise<OrgBridgeTurn | undefined>>();
  const finished: OrgBridgeTurn[] = [];
  const inboxFile = path.join(store.root, INBOX_FILE);
  const inbox = readInbox(inboxFile);
  let pollSeconds = 4;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let lastSync = 0;
  // publishToOrg rewrites its whole ledger file: one publish at a time.
  let publishing: Promise<unknown> = Promise.resolve();

  const publish = (sessionIds?: string[], holdLease = true): Promise<OrgPublishResult[]> => {
    const next = publishing.then(() =>
      publishToOrg({
        ...options,
        client,
        store,
        holdLease,
        inboxMessageId: (sessionId, index) => inbox[sessionId]?.[index],
        ...(sessionIds ? { sessionIds } : {}),
      }),
    );
    publishing = next.catch(() => undefined);
    return next;
  };

  const lost = (error: unknown): boolean => (error as { status?: number })?.status === 410;
  const held = (error: unknown): boolean => (error as { status?: number })?.status === 409;

  async function sync(): Promise<OrgPublishResult[]> {
    lastSync = Date.now();
    const busy = new Set(running.keys());
    const ids = store.list(options.runId ? { runId: options.runId } : {}).map((record) => record.id).filter((id) => !busy.has(id));
    const results = await publish(ids);
    for (const result of results) {
      if (result.error) {
        log(`org: ${result.sessionId} not published: ${result.error}`);
        continue;
      }
      const entry = state.get(result.sessionId) ?? { sessionId: result.sessionId, orgSessionId: result.orgSessionId, lease: "lost" as OrgLeaseState, live: false, ran: 0 };
      state.set(result.sessionId, entry);
      if (entry.lease !== "held") {
        try {
          await client.acquireLease(entry.orgSessionId, { host, ttlSeconds: LEASE_TTL_SECONDS });
          entry.lease = "held";
        } catch (error) {
          // Someone else drives it now (the owner took it to their desktop, or it moved to the cloud): leave it to them.
          entry.lease = held(error) ? "elsewhere" : entry.lease;
          if (!held(error)) log(`org: lease for ${entry.orgSessionId}: ${(error as Error).message}`);
          continue;
        }
      }
      if (wantLive && !entry.live) {
        await client.setSessionLive(entry.orgSessionId, {
          enabled: true,
          host,
          ...(options.participantTurnsPerDay ? { participantTurnsPerDay: options.participantTurnsPerDay } : {}),
        });
        entry.live = true;
      }
    }
    return results;
  }

  async function heartbeat(): Promise<void> {
    for (const entry of state.values()) {
      if (entry.lease !== "held") continue;
      try {
        await client.heartbeatLease(entry.orgSessionId, host);
      } catch (error) {
        if (lost(error)) {
          entry.lease = "lost";
          log(`org: lost the lease of ${entry.orgSessionId}; another host drives it now`);
        }
      }
    }
  }

  async function runTurn(entry: OrgBridgeSession): Promise<OrgBridgeTurn | undefined> {
    const { messages } = await client.claimMessages(entry.orgSessionId, { host, max: MAX_CLAIM });
    if (!messages.length) return undefined;
    const turnId = `msdk.${Date.now().toString(36)}.${randomUUID().slice(0, 8)}`;
    const answers: string[] = [];
    let failure: string | undefined;
    for (const message of messages) {
      const answer = await runMessage(entry, message);
      if (answer.error) failure = answer.error;
      answers.push(answer.text);
    }
    const final = clipFinal(answers.filter(Boolean).join("\n\n"));
    const turn: OrgBridgeTurn = {
      sessionId: entry.sessionId,
      orgSessionId: entry.orgSessionId,
      turnId,
      messages: messages.map((message) => ({ id: message.id, author: message.author, text: message.text })),
      final,
      ...(failure ? { error: failure } : {}),
    };
    try {
      await client.completeMessages(entry.orgSessionId, { host, turnId, final });
    } catch (error) {
      if (lost(error)) entry.lease = "lost";
      turn.error = (error as Error).message;
      return turn;
    }
    entry.ran += messages.length;
    const [published] = await publish([entry.sessionId]);
    if (published?.error) turn.error = published.error;
    return turn;
  }

  async function runMessage(entry: OrgBridgeSession, message: OrgSessionMessage): Promise<{ text: string; error?: string }> {
    const before = store.messages(entry.sessionId).length;
    const name = options.nameOf?.(message.author) ?? message.author.replace(/^user:/, "");
    const result = await options.agents.deliver({
      messageId: `org-${message.id}`,
      from: { kind: "person", personId: message.author, name },
      to: { sessionId: entry.sessionId },
      body: message.text,
      deliveryMode: "queue",
      sentAt: message.at,
      waitForResponse: true,
      timeoutMs: options.turnTimeoutMs ?? 30 * 60_000,
    });
    remember(entry.sessionId, before, message);
    if (!result.accepted) return { text: "", error: result.error ?? "The host refused the message." };
    if (result.status === "timeout") return { text: "The turn is still running on the host; its answer will be in the transcript." };
    return { text: result.response ?? "" };
  }

  /** Notes which local user message ran an org message, so the org transcript names its author. */
  function remember(sessionId: string, before: number, message: OrgSessionMessage): void {
    const local = store.messages(sessionId);
    const taken = new Set(Object.keys(inbox[sessionId] ?? {}).map(Number));
    for (let index = before; index < local.length; index += 1) {
      const candidate = local[index]!;
      if (candidate.role !== "user" || taken.has(index)) continue;
      if (candidate.from?.kind !== "person" || candidate.from.personId !== message.author || !candidate.content.endsWith(message.text)) continue;
      inbox[sessionId] = { ...(inbox[sessionId] ?? {}), [index]: message.id };
      writeInbox(inboxFile, inbox);
      return;
    }
  }

  async function poll(): Promise<{ started: string[]; pollSeconds: number }> {
    const pending = await client.listLivePending({ host });
    pollSeconds = pending.pollSeconds;
    const started: string[] = [];
    for (const { id } of pending.sessions) {
      const sessionId = localSessionIdOf(id);
      const entry = sessionId ? state.get(sessionId) : undefined;
      if (!entry || entry.lease !== "held" || running.has(entry.sessionId)) continue;
      const work = runTurn(entry)
        .catch((error: unknown): OrgBridgeTurn | undefined => {
          if (lost(error)) entry.lease = "lost";
          log(`org: turn in ${entry.orgSessionId} failed: ${(error as Error).message}`);
          return undefined;
        })
        .then((turn) => {
          running.delete(entry.sessionId);
          if (turn) finished.push(turn);
          return turn;
        });
      running.set(entry.sessionId, work);
      started.push(entry.sessionId);
    }
    return { started, pollSeconds };
  }

  async function idle(): Promise<OrgBridgeTurn[]> {
    while (running.size) await Promise.all(running.values());
    return finished.splice(0);
  }

  async function loop(): Promise<void> {
    if (closed) return;
    try {
      if (Date.now() - lastSync >= (options.syncSeconds ?? 30) * 1000) await sync();
      await poll();
    } catch (error) {
      log(`org: ${(error as Error).message}`);
    }
    if (!closed) timer = setTimeout(() => void loop(), pollSeconds * 1000);
  }

  let beat: NodeJS.Timeout | undefined;
  return {
    host,
    sessions: () => [...state.values()].map((entry) => ({ ...entry })),
    sync,
    poll,
    idle,
    heartbeat,
    start() {
      if (beat || closed) return;
      beat = setInterval(() => void heartbeat(), HEARTBEAT_MS);
      beat.unref();
      void loop();
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(beat);
      await idle();
      const mine = [...state.values()].filter((entry) => entry.lease === "held").map((entry) => entry.sessionId);
      await publish(mine, false).catch((error: unknown) => log(`org: last publish failed: ${(error as Error).message}`));
      for (const entry of state.values()) {
        if (entry.lease !== "held") continue;
        await client.releaseLease(entry.orgSessionId, { host }).catch(() => undefined);
        entry.lease = "lost";
      }
    },
  };
}

function clipFinal(text: string): string {
  return text.length <= MAX_FINAL_CHARS ? text : `${text.slice(0, MAX_FINAL_CHARS - 40)}\n[cut: the rest is in the transcript]`;
}

type Inbox = Record<string, Record<number, string>>;

function readInbox(file: string): Inbox {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Inbox) : {};
  } catch {
    return {};
  }
}

function writeInbox(file: string, inbox: Inbox): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(inbox));
  fs.renameSync(temporary, file);
}
