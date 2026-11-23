import type { BeforeDispatch, OutboundRequest, Sender } from "./gateway.js";
import { logCaughtError, type Logger } from "./logger.js";

/** Which server path sent it: anything through the router's sender (replies, approval cards, executors), the signup greeting or the proactive engine. */
export type MessageSource = "chat" | "greeting" | "proactive";

/**
 * Messages for the Mega Dashboard's traction block (packages/analytics catalog, MLY-499): `message.received` for every person's message the
 * router stored, `message.sent` for every message a channel accepted from Marley. Observation only: a line never decides or changes a send or
 * a turn. The channel's message id and the send's idempotency key are on the line only so the forwarder can derive a stable event id; neither
 * becomes an event property (a WhatsApp message id encodes the phone number).
 */
export class MessageEvents {
  constructor(private readonly logger: Logger) {}

  /** A person's message stored by `Router.ingest` (its `onInbound` hook: no duplicate, no reaction or other context-only line, no transcript update). */
  received(message: { id: string; channel: string; brandId?: string | null; from?: { phone?: string; memberId?: string } }): void {
    if (!message.brandId || message.from?.phone?.startsWith("system:")) return;
    try {
      this.logger.info("message.received", { brandId: message.brandId, memberId: message.from?.memberId ?? null, channel: message.channel, messageId: message.id });
    } catch (error) {
      logCaughtError(error, "message.event_failed", { brandId: message.brandId, step: "received" }, this.logger);
    }
  }

  /** A send the channel accepted (the sender returned). A reaction is not a message. */
  sent(message: OutboundRequest, source: MessageSource): void {
    const type = message.type ?? "text";
    if (type === "reaction") return;
    try {
      this.logger.info("message.sent", { brandId: message.brandId, channel: message.channel, type, source, idempotencyKey: message.idempotencyKey });
    } catch (error) {
      logCaughtError(error, "message.event_failed", { brandId: message.brandId, step: "sent" }, this.logger);
    }
  }

  /** Wraps a sender so each accepted send logs `message.sent`; a refused or failed send logs nothing and its error reaches the caller unchanged. */
  counting(sender: Sender, source: MessageSource): Sender {
    return {
      send: async (message: OutboundRequest, beforeDispatch?: BeforeDispatch) => {
        const result = await sender.send(message, beforeDispatch);
        this.sent(message, source);
        return result;
      },
    };
  }
}
