// Extract of zygstinct apps/agent-server/src/attachments.ts at 7110e58c8: only StoredAttachment, PublishedInbound.
import * as path from "node:path";
import type { InboundMessage } from "@zygstinct/shared";

export const ATTACHMENT_KINDS = ["image", "document", "audio", "voice", "video", "sticker"] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** One saved media item of an inbound message, as the channel gateway publishes it. */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  mimeType: string;
  filename: string;
  size: number;
  sha256?: string;
  uri: string;
  caption?: string;
  transcript?: string;
  language?: string;
}

/** An attachment as the turn sees it: where it landed on the VM, or why it did not. */
export interface StoredAttachment extends Attachment {
  path?: string;
  copyError?: string;
}

/** An inbound message with the gateway's media fields. `updateOf` marks a late transcript of an earlier message. */
export interface PublishedInbound extends InboundMessage {
  attachments?: Attachment[];
  notes?: string[];
  updateOf?: string;
  /** The gateway marks reactions, revokes, system notices and empty unsupported messages: stored as context, no turn. */
  contextOnly?: boolean;
}
