/**
 * Messages between sessions, addressed so the target may live on another host.
 *
 * A session is addressed by `{host, sessionId}`. No `host`, or this host's id, means a session on this host; any
 * other host is reached through a `SessionTransport` registered for it (the link adds one per connected host). The
 * sender is always recorded: on the delivered transcript message (`from`) and in the text the target reads.
 */

export type DeliveryMode = "queue" | "interrupt";

export interface SessionAddress {
  /** The host the session lives on; omitted for this host. */
  host?: string;
  sessionId: string;
}

/** Who a message comes from, as the target sees it. */
export interface MessageSender {
  kind: "session" | "person" | "host";
  /** The sending session (kind session). */
  sessionId?: string;
  /** Session title, person's name, or host name. */
  name?: string;
  /** The sender's host; set when it is not the target's host. */
  host?: string;
  /** A person's id on the route that carried their answer (phone number, Marshal user). */
  personId?: string;
}

export interface SessionEnvelope {
  messageId: string;
  from: MessageSender;
  to: SessionAddress;
  body: string;
  deliveryMode: DeliveryMode;
  sentAt: string;
  /** Drop the sender's own messages to this session that have not started, and send this one instead. */
  replaceQueued?: boolean;
  /** Resolve with the target's reply to this message. */
  waitForResponse?: boolean;
  timeoutMs?: number;
}

export interface DeliveryResult {
  success: boolean;
  accepted: boolean;
  messageId: string;
  /** Where the message is now: queued behind a running turn, or started as a turn. */
  deliveryState?: "queued" | "started";
  /** The target's reply, when waitForResponse was set and it answered in time. */
  response?: string;
  /** waitForResponse ran out before the target answered. */
  status?: "timeout";
  replacedMessageIds?: string[];
  error?: string;
}

/**
 * Carries envelopes to the sessions of one other host. The link implements it; this package only defines it.
 * `deliver` resolves once the remote host accepted (or refused) the message, with the remote host's result.
 */
export interface SessionTransport {
  readonly hostId: string;
  deliver(envelope: SessionEnvelope): Promise<DeliveryResult>;
}

/** The line a target reads above a message, naming the sender the way the desktop does. */
export function senderLine(from: MessageSender): string {
  const where = from.host ? ` on host ${from.host}` : "";
  switch (from.kind) {
    case "session":
      return `Message from session ${from.name ?? from.sessionId} (${from.sessionId})${where}:`;
    case "person":
      return `Message from ${from.name ?? from.personId ?? "a person"}${where}:`;
    case "host":
      return `Message from host ${from.name ?? from.host ?? "this host"}:`;
  }
}

export function isLocalAddress(address: SessionAddress, hostId: string): boolean {
  return address.host === undefined || address.host === "" || address.host === hostId;
}
