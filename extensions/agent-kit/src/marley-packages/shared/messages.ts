export const CHANNELS = ["whatsapp", "imessage", "inspector", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export type ConversationKind = "dm";

export interface ReplyButtonsContent {
  type: "reply_buttons";
  text: string;
  buttons: { id: string; title: string }[];
}

/**
 * A WhatsApp message template: the only message a business may send first, or outside the 24-hour window. The gateway
 * sends only template names on its own allowlist, only to the brand's signup owner, and never retries an unknown outcome.
 */
export interface TemplateContent {
  type: "template";
  template: {
    /** Meta's template name (lower case, digits, underscores). */
    name: string;
    /** Meta's language code of the approved translation, for example `en` or `pt_BR`. */
    language: string;
    /** The body's `{{1}}`, `{{2}}`, ... values, in order, or the values of its named parameters (`{{artifact}}`) when `bodyParameterNames` is set. */
    bodyParameters: string[];
    /** For a template whose body uses named parameters: the name of each value of `bodyParameters`, in the same order (Meta's `parameter_name`). */
    bodyParameterNames?: string[];
    /** The payload of the template's first quick-reply button; the gateway prefixes it so a tap is never an approval candidate. */
    buttonPayload?: string;
  };
}

/** A transport decision candidate, never an authorization receipt. Button meaning comes from a stored opaque ID, not its label. */
export type ApprovalDecisionInput = { opaqueId: string; source: "button"; replyToMessageId: string };
export type ApprovalDecision = ApprovalDecisionInput & { sender: { phone: string; memberId: string } };

export interface MediaRef {
  kind: "image" | "audio" | "video" | "document" | "sticker";
  mimeType: string;
  channelMediaId: string;
  caption?: string;
}

export interface InboundMessage {
  id: string;
  channel: Channel;
  hostId: string;
  brandId: string | null;
  receivedAt: string;
  from: {phone: string; name?: string; memberId?: string};
  conversation: {kind: ConversationKind; id: string; title?: string};
  text?: string;
  media?: MediaRef[];
  replyToMessageId?: string;
  approvalDecision?: ApprovalDecision;
}

export interface OutboundMessage {
  channel: Channel;
  hostId: string;
  brandId: string;
  conversation: {kind: ConversationKind; id: string};
  text: string;
  replyToMessageId?: string;
  idempotencyKey: string;
}

export type OutboundReplyButtonsMessage = Omit<OutboundMessage, "text"> & ReplyButtonsContent;
export type OutboundTemplateMessage = Omit<OutboundMessage, "text"> & TemplateContent;

export const PUBSUB_ATTRIBUTES = {
  hostId: "host_id",
  brandId: "brand_id",
  channel: "channel",
  /** The sending channel's ChannelCapabilities as compact JSON (under the 1024-byte attribute limit); consumers that do not read it ignore it. */
  capabilities: "capabilities",
} as const;
