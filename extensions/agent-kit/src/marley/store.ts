// Extract of zygstinct apps/agent-server/src/store.ts at 7110e58c8: only ConversationKey, StoredMessage, Store:declare, ConversationRecord, isDeletion, MessageState.
import Database from "better-sqlite3";
import type { Channel, ConversationKind } from "@zygstinct/shared";
import type { Attachment, PublishedInbound, StoredAttachment } from "./attachments.js";
import { UaFigures } from "./ua-figures.js";
import { TaskLedger } from "./tasks/ledger.js";
import { type ListTasksQuery, type Task } from "./tasks/schema.js";
import { type PromptSegment } from "./prompt-segments.js";
import { recordDataQueries } from "./query-log.js";

/** `pending` needs a reply turn; `context` is stored group chatter shown to the next turn; `delivered` was shown; `skipped` was dropped. */
export type MessageState = "pending" | "context" | "delivered" | "skipped";

export interface ConversationKey {
  brandId: string;
  channel: Channel;
  conversationId: string;
}

/** The eval run and case an inspector test conversation was started for (MLY-315). */
export interface EvalIds {
  runId: string;
  caseId: string;
}

export interface StoredMessage {
  seq: number;
  id: string;
  key: ConversationKey;
  kind: ConversationKind;
  title: string | null;
  receivedAt: string;
  fromPhone: string;
  fromName: string | null;
  memberId: string | null;
  text: string | null;
  mediaJson: string | null;
  /** Saved media of the message (the gateway uploads them to the attachments bucket). */
  attachments: StoredAttachment[];
  /** Things the gateway noted: a media item that failed, a transcript still to come. */
  notes: string[];
  /** Set on a late transcript: the id of the message it belongs to. */
  updateOf: string | null;
  replyTo: string | null;
  state: MessageState;
}

/** How long after the last slot window that named a built file its name covers the builder's own copy too (time zones are at most about 26 hours apart). */
const NAME_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A delete-for-everyone, by the gateway's own note (whatsapp-inbound.ts; a person cannot type a note). Its replyTo is the
 * deleted message, whose text must not come back into a turn.
 */
export const isDeletion = (message: StoredMessage): boolean => message.notes.some((note) => note.startsWith(DELETION_NOTE));

const DELETION_NOTE = "the user deleted message ";

/** The message a person replied or reacted to, from this conversation's own records. A deleted one carries no text. */
export type QuotedMessage =
  | { deleted: true }
  | { byAgent: true; text: string | null }
  | { byAgent: false; fromName: string | null; fromPhone: string; memberId: string | null; receivedAt: string; text: string | null };

export interface ConversationRecord {
  key: ConversationKey;
  kind: ConversationKind;
  title: string | null;
  sdkSessionId: string | null;
  sessionStartedAt: number | null;
  lastActivityAt: number | null;
  contextTokens: number;
  sessionTurns: number;
  /** Summary of the previous session; the next session starts from it. */
  carriedSummary: string | null;
  /** Hash of the host context block the session last saw. */
  memoryHash: string | null;
  /** The brand's sandbox host id, taken from the latest inbound message. */
  hostId: string | null;
  /** Id of the agent_sessions row for the current SDK session. */
  sessionRowId: string | null;
  /**
   * The maintainer phone lease epoch (maintainer_phone_leases.epoch) this conversation's session was started under. 0 for everyone who is
   * not a maintainer. A DM turn that finds a different epoch starts a fresh session (docs/CONTRACTS.md, "Platform maintainers").
   */
  leaseEpoch: number;
}

/** What a chat's claim on the brief day's video says about its send: in flight, accepted by the gateway, or possibly delivered (SD02). `null`: a claim written before states were recorded. */
export type BriefVideoState = "claimed" | "accepted" | "unknown" | null;

/** The agent's local SQLite state: inbound messages, session mapping, outbound ids, turn log. */
export declare class Store {
  private readonly db;
  /** The task ledger (tasks/ledger.ts); lane C and the inspector read it through listTasks and getTask. */
readonly tasks: TaskLedger;
  /** The owner's captured Meta figures (ua-figures.ts). */
readonly uaFigures: UaFigures;
  constructor(file: string);
  /** Background tasks of a brand, newest first (docs/CONTRACTS.md, "Task ledger"). */
listTasks(query: ListTasksQuery): Task[];
  getTask(taskId: string): Task | null;
  /** The spilled full result a task's `result_ref` points at, as the JSON the worker returned (validated before it was stored). */
getTaskResult(taskId: string): string | null;
  /** Called after a task reaches done, failed or cancelled; a listener's error is swallowed. */
onTaskFinished(listener: (task: Task) => void): void;
  /** Called once for each task right after it is created, still queued; a listener's error is swallowed. */
onTaskCreated(listener: (task: Task) => void): void;
  /** Called each time a worker claims a task (it is now working); a listener's error is swallowed. */
onTaskStarted(listener: (task: Task) => void): void;
  /** Stores the data-query log entries a VM wrote during one turn (validated here; untrusted input). Returns how many were new. */
recordDataQueries(context: { turnId: string; brandId: string; channel: string; conversationId: string }, raw: unknown[], now?: number): number;
  get database(): Database.Database;
  private migrate;
  close(): void;
  /** A consistent copy of the database, safe while the service is running. */
backupTo(file: string): Promise<void>;
  /** Persists an inbound message. Returns false when the id was already stored (duplicate delivery). */
insertInbound(message: PublishedInbound, state: MessageState, now?: number): boolean;
  getMessage(id: string): StoredMessage | null;
  /**
   * Adds late transcripts to the attachments of a stored message (matched by attachment id) and drops the "transcript still to
   * come" note. Returns false when the message is not stored.
   */
mergeTranscripts(messageId: string, updates: Attachment[]): boolean;
  hasMessage(id: string): boolean;
  /** Messages the next turn must show: pending ones and stored group context, oldest first. */
openMessages(key: ConversationKey, limit?: any): StoredMessage[];
  /** The newest stored messages of a conversation (any state), newest first. */
recentMessages(key: ConversationKey, limit?: any): StoredMessage[];
  /** The newest texts the agent sent in a conversation (what the person saw or heard), newest first. */
recentOutbound(key: ConversationKey, limit?: any): { text: string; createdAt: number }[];
  /** One sender's messages in a conversation that turns handled, stored by this server at or after `since`, newest first; never a server-written row. */
deliveredSince(key: ConversationKey, sender: { memberId: string; phone: string | null }, since: number, limit?: any): StoredMessage[];
  hasPending(key: ConversationKey): boolean;
  /** Conversations that still have a pending message (after a restart). */
conversationsWithPending(): ConversationKey[];
  setState(ids: string[], state: MessageState): void;
  /** Creates the conversation row when missing (the brand control session has no inbound message). */
ensureConversation(key: ConversationKey, kind: ConversationKind, title: string | null): void;
  /**
   * Marks a new inspector test conversation as one case of an eval run (MLY-315), once: an existing mark is never replaced.
   * Returns false when the conversation already had one. Only the test ingress writes it; the turn runner reads it to charge
   * the eval budget instead of the brand's.
   */
markEvalConversation(key: ConversationKey, ids: EvalIds, now?: number): boolean;
  /** Removes a mark the test ingress just wrote when its message was not stored, so the conversation is not left marked. */
unmarkEvalConversation(key: ConversationKey, ids: EvalIds): void;
  /** The eval run and case of a conversation, or null for every conversation the test ingress did not mark. */
evalOf(key: ConversationKey): EvalIds | null;
  getConversation(key: ConversationKey): ConversationRecord | null;
  /** Saves the SDK session mapping of a conversation. */
updateSession(key: ConversationKey, change: Partial<Pick<ConversationRecord, "sdkSessionId" | "sessionStartedAt" | "lastActivityAt" | "contextTokens" | "sessionTurns" | "carriedSummary" | "memoryHash" | "sessionRowId" | "leaseEpoch">>): void;
  /** The brands that have at least one conversation here (every brand served when a flag is `*`). */
brandIdsWithConversations(): string[];
  conversationsOfBrand(brandId: string): ConversationRecord[];
  /** `text` is what the person saw or heard (never a signed link), kept so a later reply to this message can show it. */
  /** `kind` is the send's type (`OutboundRequest.type`: text, voice, image, document, audio, video, reaction, template, ...), read by the inspector's Chat. */
  /** `filename` is the name a file send went out under (the artifact copy of that send has the same name), so a later reply to the message can find its file. */
recordOutbound(messageId: string, key: ConversationKey, turnId: string, now?: number, text?: string | null, kind?: any, filename?: string | null): void;
  /** The send record of a message of ours in this conversation (never another conversation's), or null when it is not one of ours. */
outboundOf(key: ConversationKey, messageId: string): { turnId: string; kind: string | null; filename: string | null } | null;
  /**
   * The messages these messages reply or react to, by quoted id, looked up only in the same conversation: a quoted id
   * from elsewhere (or one never stored) is absent from the map. A message with a stored deletion in this conversation
   * is `{ deleted: true }`, whoever quotes it.
   */
quotedMessages(key: ConversationKey, messages: StoredMessage[]): Map<string, QuotedMessage>;
  /** Records an agent reply on the inspector channel (nothing leaves the server) and returns its local message id. A retry of the same reply keeps its id. */
  /** `kind` is the outbound message's own type (text, voice, image, document, ...), kept so a reader never has to read it back out of the text. */
recordInspectorReply(reply: { brandId: string; conversationId: string; idempotencyKey: string; text: string; kind?: string }, now?: number): string;
  inspectorReplies(brandId: string, conversationId: string): { id: string; text: string; createdAt: number }[];
  /**
   * One morning-brief video per chat and brief day. The first send to claim the day keeps it (a retry of the same turn and file claims again, as itself); any other
   * turn is `taken` and sends nothing, so a second build, a rerun or a model's own reply never puts a second video in the owner's chat.
   * The one exception is a remake (G-T-brief-remake): after a saved change to the daily brief the server recorded an offer for this chat and day (`offerBriefRemake`),
   * and while that offer is open and unused, one different file whose first video already went out takes the day over, once. The offer is one row, spent by one
   * compare-and-set, so a second remake, a retry of another turn or a remake with no offer stays `taken`.
   */
claimBriefVideo(key: ConversationKey, day: string, turnId: string, file: string, now?: number): "claimed" | "taken";
  /** Whether a send of this turn's brief video would be refused as a second one: the day is claimed by another turn or another file, and no open remake offer lets it through. Reads only. */
briefVideoTaken(key: ConversationKey, day: string, turnId: string, file: string, now?: number): boolean;
  private sentBriefDay;
  /**
   * Whether the chat's brief day could take its one remake offer, reading only: the day's brief video must have gone out and the day must hold no offer yet (an
   * offer lives for the whole day, spent or not). A saved change's task asks this before its result is stored; nothing is written until the result wins its claim.
   */
briefRemakeAvailable(key: ConversationKey, since: number): { day: string } | { refused: "no_brief_today" | "already_offered" };
  /**
   * Records the one remake offer of a chat's brief day, for the task whose stored result carries it: the day's brief video must have gone out and a day has at most
   * one offer for its whole life. The refusal is typed: `no_brief_today` or `already_offered`.
   */
recordBriefRemake(key: ConversationKey, since: number, now: number, expiresAt: number, taskId: string | null): { day: string } | { refused: "no_brief_today" | "already_offered" };
  /** The task whose result carries the day's remake offer, or null (no offer, or one recorded with no task). Reads only. */
briefRemakeOfferedBy(key: ConversationKey, day: string): string | null;
  /** The chat's brief day whose remake offer is open (offered, unspent, unexpired), newest first, or null. Reads only. */
openBriefRemake(key: ConversationKey, now?: number): { day: string; expiresAt: number } | null;
  private briefRemakeOpen;
  /** A turn's send of the claimed video was accepted by the gateway (`accepted`) or may have gone out (`unknown`, SD02). Only the claiming turn settles its own claim. */
settleBriefVideo(key: ConversationKey, day: string, turnId: string, state: "accepted" | "unknown"): void;
  /** What the chat's claim of the brief day's video says: `claimed` while its send is in flight, then `accepted` or `unknown`; null when no turn holds the day. Reads only. */
briefVideoState(key: ConversationKey, day: string): { state: BriefVideoState; createdAt: number } | null;
  /** A video file of this chat's outbox that went out (the gateway accepted the native send, or the artifact store holds the file for a link): the record `sentFileRecords` reads. An unknown outcome is not recorded. */
recordSentFile(key: ConversationKey, file: string, now?: number): void;
  /**
   * What the server's own records say about files already sent from this brand's chats, for the snapshot upgrade (`SnapshotUpgradeDeps.sentMedia`). Reads only.
   * - `inChat`: a file covered for one chat: that chat's own brief claim says it went out, or may have (accepted, unknown or from before states), or a video file of its outbox was sent
   *   (`sent_files`, with the time, so a video made again under the same name after that send is not covered). Never covered while a record of that chat still waits on the name
   *   (a claim in flight, a send being prepared or retried, an open template offer). A scheduled send's own status (`accepted`, `sent`, `expired`) covers nothing: it is derived from
   *   the chat's messages, so it can hold a failed video send's file as delivered; an uncovered file is carried.
   * - `names`: a name covered in every chat, the builder's own copy included: a brief claim delivered it, no record of any chat waits on it, and the last slot window
   *   that named it ended a day ago (`NAME_GRACE_MS`), so no owner whose slot is still to come (another time zone, a capped tick) can need the builder's copy.
   */
sentFileRecords(brandId: string, now?: number): { names: Set<string>; inChat: { channel: string; conversationId: string; file: string; sentAt: number }[] };
  /** Gives the day back after a send that provably did not go out (a refusal before the gateway took it), so the video can still be sent. */
releaseBriefVideo(key: ConversationKey, day: string, turnId: string): void;
  isAgentMessage(messageId: string): boolean;
  beginTurn(id: string, key: ConversationKey, messageCount: number, now?: number): void;
  /**
   * The system prompt a turn's model run started with, kept once per distinct text (for the inspector's trace), with the
   * labeled span of each layer when the caller has them. The spans belong to the text, so the first ones kept stay.
   */
  /**
   * The system prompt of a background worker, kept under its own turn id (`tsk_…-wN`) so the inspector can show it like a front turn's.
   * The row is written already ended (outcome "worker"), so it never counts as an open turn for the drain check.
   */
recordWorkerPrompt(turnId: string, key: ConversationKey, text: string, segments: PromptSegment[], now?: number): void;
  setTurnSystemPrompt(id: string, text: string, segments?: PromptSegment[], now?: number): void;
  /**
   * The labeled spans of the turn prompt a turn sent, with the hash of its exact text (so the inspector can tell that the
   * transcript's prompt is the one the spans belong to) and which host context it carried. Written apart from the system
   * prompt: a failure here costs the layer view of one turn and nothing else.
   */
setTurnPromptLayers(id: string, record: { text: string; hostContextHash: string; hostContextIncluded: boolean; segments: PromptSegment[] }): void;
  /**
   * The prompt overrides of an inspector test message (prompt-lab.ts), kept until a turn reads them. Only the inspector's own
   * channel may hold any: the table refuses a key of a real channel, so a WhatsApp message can never carry one.
   */
putLabOverrides(messageId: string, key: ConversationKey, bodyJson: string, now?: number): void;
  dropLabOverrides(messageId: string): void;
  /** The newest stored overrides among these messages of this conversation, as stored JSON; null when none of them has any. */
labOverridesOf(key: ConversationKey, messageIds: string[]): string | null;
  /** Which prompt pieces a lab turn changed (ids only, never text), for the inspector's badge. */
setTurnLabOverrides(id: string, record: unknown): void;
  endTurn(id: string, outcome: string, costUsd: number | null, now?: number, reason?: string | null): void;
  turnsOf(brandId: string, conversationId: string): { id: string; outcome: string | null; reason: string | null; messageCount: number; ended: boolean }[];
  /** Adds one model call to a ledger's spend of the day: a brand id, or the eval ledger (`EVAL_LEDGER` in proxy.ts). */
addUsage(brandId: string, day: string, usage: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }, costUsd: number): void;
  spentUsd(brandId: string, day: string): number;
  /** Saves a person or private memory entry (the server keeps these; the VM never sees them). */
memoryPut(brandId: string, audience: { kind: "person" | "private"; id: string }, name: string, content: string, now?: number): void;
  memoryGet(brandId: string, audience: { kind: "person" | "private"; id: string }, name: string): string | null;
  memoryList(brandId: string, audience: { kind: "person" | "private"; id: string }): { name: string; content: string; updatedAt: number }[];
  memoryDelete(brandId: string, audience: { kind: "person" | "private"; id: string }, name: string): boolean;
  countMessages(state?: MessageState): number;
}
