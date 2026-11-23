import { createHash } from "node:crypto";

import { CONNECTOR_PROVIDERS } from "@zygstinct/shared";
import { z } from "zod";

import type { Logger } from "./logger.js";

/**
 * What the model sends while a turn is still running: text, voice note, image, file, reaction, connect link.
 *
 * The capability that queues them runs on the brand VM, as the conversation's own Unix user, and writes one small file per
 * message into that conversation's private `~/.zs/sends/<turnId>/`. It has no recipient, conversation or brand field. This
 * server reads the folder while the turn runs and sends each message to the conversation the turn belongs to, which the
 * server's own turn record decides. The earlier `zs.chat.send_message` was removed because every conversation of a brand
 * shared one Unix user, so a model could read another session's bearer and speak through it. Here no bearer exists and the
 * folder is private to one conversation's user; a handle without a private conversation identity reads nothing.
 */
export const SENDS_DIR = ".zs/sends";
export const MAX_LIVE_SENDS = 24;
export const MAX_LIVE_TEXT = 3000;
/** What the envelope accepts: the gateway's own limit, so a voice note an older VM accepted (601 to 1200 characters) is never dropped here. Delivery cuts it to the voice cap. */
export const MAX_LIVE_VOICE = 1200;
export const LIVE_SEND_POLL_MS = 1000;

/** The ref of one of the turn's messages to quote (message-ref.ts): the server resolves it against the turn's own messages and nothing else. */
const REF = z.string().trim().min(2).max(24);
/** `corrects`: the model's typed statement that this message takes back or corrects something already told; read only by the outbox (outbox.ts), never from the words. */
export const TEXT_INPUT = z.strictObject({ text: z.string().trim().min(1).max(MAX_LIVE_TEXT), to: REF.optional(), corrects: z.boolean().optional() });
export const VOICE_INPUT = z.strictObject({ text: z.string().trim().min(1).max(MAX_LIVE_VOICE), lang: z.string().min(2).max(20).optional(), to: REF.optional(), corrects: z.boolean().optional() });
export const IMAGE_INPUT = z.strictObject({ path: z.string().min(1).max(300), caption: z.string().max(1000).optional() });
export const FILE_INPUT = z.strictObject({ path: z.string().min(1).max(300), caption: z.string().max(1000).optional() });
export const REACT_INPUT = z.strictObject({ emoji: z.string().min(1).max(16), to: REF.optional() });
/** An existing brand file by its artifact id (marley.outbox.send_artifact). The id names a file only; the server reads it by the turn's own brand and sends it into the turn's own chat. */
export const ARTIFACT_INPUT = z.strictObject({ artifactId: z.uuid(), caption: z.string().max(1000).optional() });
/** The source is a connector provider; the server builds and signs the link itself, so the envelope carries no URL. Whether this member may be offered it is decided at delivery. */
export const CONNECT_INPUT = z.strictObject({ source: z.enum(CONNECTOR_PROVIDERS), text: z.string().trim().min(1).max(1000) });
/** A request the model waits on (today only zs.team.invite). The handler validates the input strictly; the server writes its answer to `ANSWERS_DIR`. */
export const ASK_INPUT = z.record(z.string(), z.unknown());
export const ANSWERS_DIR = ".zs/answers";

/** A task id as the ledger mints it (tasks/schema.ts); the server checks it names a task of this conversation before it acts on it. */
const TASK_ID = z.string().trim().min(1).max(80);
/**
 * `outbox.put` (the VM's marley.outbox.* capabilities, packages/outbox-tools, one part per call): one or more parts of what a session says, for the outbox agent to put to the person. The same parts the reply tools
 * queue one by one, plus what the parts rest on: `basis` "state" (the brand state the session already had, no fresh work) or "work" (a worker's own
 * checking), the task a worker writes for, and the earlier message the words answer. No recipient, brand or conversation: the server's turn decides them.
 */
const OUTBOX_PART = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string().trim().min(1).max(MAX_LIVE_TEXT), lang: z.string().min(2).max(20).optional(), corrects: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("voice"), text: z.string().trim().min(1).max(MAX_LIVE_VOICE), lang: z.string().min(2).max(20).optional(), corrects: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("image"), path: z.string().min(1).max(300), caption: z.string().max(1000).optional() }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1).max(300), caption: z.string().max(1000).optional() }),
  z.strictObject({ kind: z.literal("react"), emoji: z.string().min(1).max(16) }),
  z.strictObject({ kind: z.literal("connect_link"), source: z.enum(CONNECTOR_PROVIDERS), text: z.string().trim().min(1).max(1000) }),
  z.strictObject({ kind: z.literal("artifact"), artifactId: z.uuid(), caption: z.string().max(1000).optional() }),
]);
export const MAX_OUTBOX_PARTS = 8;
export const OUTBOX_INPUT = z.strictObject({ parts: z.array(OUTBOX_PART).min(1).max(MAX_OUTBOX_PARTS), replyTo: REF.optional(), basis: z.enum(["state", "work"]), taskId: TASK_ID.optional() });
/** `marley.task.steer`: words for a task already running or idle (a follow-up or a correction of its course), instead of a new fork. */
export const STEER_INPUT = z.strictObject({ taskId: TASK_ID, message: z.string().trim().min(1).max(4000) });

const Envelope = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("text"), input: TEXT_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("voice"), input: VOICE_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("image"), input: IMAGE_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("file"), input: FILE_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("artifact"), input: ARTIFACT_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("react"), input: REACT_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("connect"), input: CONNECT_INPUT }),
  // askedAt is the VM's clock when the model asked; a request without it is never acted on.
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("invite"), input: ASK_INPUT, askedAt: z.number().int().positive().optional() }),
  // zs.nudge.propose: an operator nudge turn's proposal (nudges/service.ts); the answer is the stored nudge or why it was refused.
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("nudge"), input: ASK_INPUT, askedAt: z.number().int().positive().optional() }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("steer"), input: STEER_INPUT }),
  z.strictObject({ version: z.literal(1), turnId: z.string().min(1).max(80), id: z.uuid(), kind: z.literal("outbox"), input: OUTBOX_INPUT }),
]);
type EnvelopeMessage = z.infer<typeof Envelope>;
/** What an outbox.put part carries besides the words: read by the outbox (outbox/store.ts `basis`, `taskId`, `replyTo`). */
export interface OutboxFacts { basis: "state" | "work"; taskId: string | null; replyTo: string | null }
/** One send of a turn: an envelope, or one part of an outbox.put envelope (with its `outbox` facts). */
export type LiveMessage = Exclude<EnvelopeMessage, { kind: "outbox" }> & { outbox?: OutboxFacts };

/** The parts of one outbox.put as the sends the reply tools queue, in order. The first part keeps the envelope's id; the others get ids derived from it. */
function outboxParts(envelope: Extract<EnvelopeMessage, { kind: "outbox" }>): LiveMessage[] {
  const facts: OutboxFacts = { basis: envelope.input.basis, taskId: envelope.input.taskId ?? null, replyTo: envelope.input.replyTo ?? null };
  const to = envelope.input.replyTo;
  const base = { version: 1 as const, turnId: envelope.turnId };
  return envelope.input.parts.map((part, index): LiveMessage => {
    const id = index === 0 ? envelope.id : derivedId(envelope.id, index);
    switch (part.kind) {
      case "text": return { ...base, id, kind: "text", input: { text: part.text, ...(to ? { to } : {}), ...(part.corrects !== undefined ? { corrects: part.corrects } : {}) }, outbox: facts };
      case "voice": return { ...base, id, kind: "voice", input: { text: part.text, ...(part.lang ? { lang: part.lang } : {}), ...(to ? { to } : {}), ...(part.corrects !== undefined ? { corrects: part.corrects } : {}) }, outbox: facts };
      case "image": return { ...base, id, kind: "image", input: { path: part.path, ...(part.caption !== undefined ? { caption: part.caption } : {}) }, outbox: facts };
      case "file": return { ...base, id, kind: "file", input: { path: part.path, ...(part.caption !== undefined ? { caption: part.caption } : {}) }, outbox: facts };
      case "react": return { ...base, id, kind: "react", input: { emoji: part.emoji, ...(to ? { to } : {}) }, outbox: facts };
      case "connect_link": return { ...base, id, kind: "connect", input: { source: part.source, text: part.text }, outbox: facts };
      case "artifact": return { ...base, id, kind: "artifact", input: { artifactId: part.artifactId, ...(part.caption !== undefined ? { caption: part.caption } : {}) }, outbox: facts };
    }
  });
}

/** A stable uuid-shaped id for part `index` of an envelope (the live sends dedupe by id across polls). */
function derivedId(id: string, index: number): string {
  const hex = createHash("sha256").update(`${id}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface LiveSendFile {
  name: string;
  value: unknown;
}

/** Lists the queued sends of one turn, oldest first. Run as the conversation's own user; refuses anything but private regular files. */
export const TURN_SENDS_READER = `import os,sys,json,stat
home,turn=sys.argv[1:]
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
 for part in home.split('/')[1:]+['.zs','sends',turn]:
  if not part or part in ('.','..'): raise ValueError('sends path')
  try: child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  except FileNotFoundError:
   print('[]'); sys.exit(0)
  os.close(fd); fd=child
 info=os.fstat(fd)
 if info.st_uid!=os.getuid() or info.st_mode & 0o077: raise ValueError('private sends folder')
 names=sorted(name for name in os.listdir(fd) if not name.startswith('.'))[:${MAX_LIVE_SENDS}]
 values=[]
 for name in names:
  try: entry=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  except OSError: continue
  with os.fdopen(entry,'rb') as source:
   info=os.fstat(source.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_size>65536: continue
   raw=source.read(65537)
   if len(raw)>65536: continue
   try: values.append({'name':name,'value':json.loads(raw)})
   except (ValueError,UnicodeError): continue
 print(json.dumps(values))
finally: os.close(fd)
`;

/** Turns the files read from the VM into validated messages for this turn, in the order the model queued them. Anything else is dropped. */
export function parseLiveSends(files: LiveSendFile[], turnId: string): { id: string; message: LiveMessage }[] {
  return readLiveSends(files, turnId).sends;
}

/** Envelopes a read did not turn into a send, by the condition that dropped each one (set where it is detected, never read from a message). */
export interface LiveSendDrops { schema: number; other_turn: number; cap: number }
const noDrops = (): LiveSendDrops => ({ schema: 0, other_turn: 0, cap: 0 });
const anyDrops = (drops: LiveSendDrops): boolean => drops.schema > 0 || drops.other_turn > 0 || drops.cap > 0;

/** `parseLiveSends`, with a count of what it dropped: a file that is not an envelope (`schema`), one of another turn (`other_turn`) and valid ones past the per-turn cap (`cap`). */
export function readLiveSends(files: LiveSendFile[], turnId: string): { sends: { id: string; message: LiveMessage }[]; dropped: LiveSendDrops } {
  const sends: { id: string; message: LiveMessage }[] = [];
  const dropped = noDrops();
  for (const file of files) {
    const parsed = Envelope.safeParse(file.value);
    if (!parsed.success) { dropped.schema += 1; continue; }
    if (parsed.data.turnId !== turnId) { dropped.other_turn += 1; continue; }
    const messages = parsed.data.kind === "outbox" ? outboxParts(parsed.data) : [parsed.data];
    for (const message of messages) {
      if (sends.length >= MAX_LIVE_SENDS) { dropped.cap += 1; continue; }
      sends.push({ id: message.id, message });
    }
  }
  return { sends, dropped };
}

/**
 * The send key of a live message: the turn, its place in the turn and a digest of what it says (text, voice text and language, or an image's path and caption).
 * A turn id is the hash of its batch, so a retry or a resume after a restart runs under the same turn id and counts from 0 again, usually with other words. The same
 * message at the same place is the same send (the gateway replays it, once), a different message never reuses a key (the gateway refuses that with 409).
 * The inspector parses this key to show live sends (`liveReplies` in apps/inspector/src/store.ts); change both together.
 */
export function liveSendKey(turnId: string, ordinal: number, message: LiveMessage): string {
  // `to` is part of the digest only when set, so the key of a message with no quote is what it was before quotes existed.
  const parts: string[] = message.kind === "image" || message.kind === "file" ? [message.kind, message.input.path, message.input.caption ?? ""]
    : message.kind === "voice" ? [message.kind, message.input.text, message.input.lang ?? "", ...(message.input.to ? [message.input.to] : [])]
    : message.kind === "artifact" ? [message.kind, message.input.artifactId.toLowerCase(), message.input.caption ?? ""]
    : message.kind === "react" ? [message.kind, message.input.emoji, message.input.to ?? ""]
    : message.kind === "connect" ? [message.kind, message.input.source, message.input.text]
    : [message.kind, message.kind === "text" ? message.input.text : "", ...(message.kind === "text" && message.input.to ? [message.input.to] : [])];
  return `${turnId}:live:${ordinal}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12)}`;
}

export const MAX_LIVE_ATTEMPTS = 3;
/** How long the final drain may hold the final reply and the conversation's turn slot, whatever the gateway is doing. */
export const LIVE_FINISH_DEADLINE_MS = 45_000;
const LIVE_RETRY_PAUSE_MS = 500;
const LIVE_REPORT_DEADLINE_MS = 5_000;

export interface LiveSendsDeps {
  turnId: string;
  /** Runs once before polling begins, to clear what an earlier attempt of the same turn left in the send folder. If it throws, nothing is sent live for this turn. */
  prepare?(): Promise<void>;
  /** True on a tools-protocol turn, where the live sends are the only way the turn speaks: a failed prepare then fails the turn (the router retries it) instead of leaving the person with silence. */
  prepareRequired?: boolean;
  read(): Promise<LiveSendFile[]>;
  /** Called once per cycle that has something to send, before any of it leaves. Returns false to stop all sending for this turn. */
  authorize(): Promise<boolean>;
  /**
   * Sends one message to the turn's own conversation. `ordinal` counts messages of this turn from 0 and is the base of the stable send key; a retry of the same message gets the same ordinal.
   * An `invite` is handled once and answered to the model by the handler itself: "sent" when a message went out, "answered" when
   * none did, "stopped" when the conversation closed; never "failed", so it is never retried.
   * "rejected" is a refusal that repeating cannot change (the gateway answered 4xx other than 429): the message is lost at once, without further attempts.
   */
  deliver(message: LiveMessage, ordinal: number): Promise<"sent" | "answered" | "stopped" | "failed" | "rejected">;
  /** Called once, before the final reply, when messages could not be delivered after every attempt. */
  reportLost?(lost: LiveMessage[]): Promise<void>;
  logger: Logger;
  intervalMs?: number;
  /** Wall-clock limit of `finish`; what is still unsent when it passes counts as lost. Default LIVE_FINISH_DEADLINE_MS. */
  finishDeadlineMs?: number;
  /** Pause between the rounds of `finish` while deliveries keep failing. */
  retryPauseMs?: number;
}

interface Tracked {
  message: LiveMessage;
  ordinal: number;
  attempts: number;
  state: "pending" | "sent" | "lost";
}

/**
 * Follows one turn: reads the turn's send folder every second, sends what is new in order, never two cycles at once. A message
 * whose delivery fails is tried again on the next cycles with the same stable key, up to MAX_LIVE_ATTEMPTS times, and keeps its
 * place in the order; after that it is reported as lost. At most MAX_LIVE_SENDS messages are taken per turn, however many files
 * come and go. `finish` runs a last cycle after the model's turn ended and before the final reply goes out, so the final reply
 * is always last.
 */
export class LiveSends {
  private readonly tracked = new Map<string, Tracked>();
  private closed = false;
  /** The drop counts of the last `live_sends.dropped` line, so a file that stays in the folder is reported when it appears or changes, not on every poll. */
  private lastDropped: LiveSendDrops = noDrops();
  private polling = false;
  /** A read asked for by `poke` that has not started yet. */
  private poked = false;
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> = Promise.resolve();
  private cycleFailure: "read" | "authorize" | "cycle" | null = null;
  sent = 0;
  /**
   * Live texts that count as said this turn: delivered by the gateway, or handed to the outbox as material of this turn's moment (the router adds those; the
   * outbox sends them in the composed message before the turn's closing text is decided). Not voice, images, or the lost-message notice.
   */
  textsSent = 0;
  /** The text of every delivered live text, in order: what the person has already read this turn. */
  readonly textsDelivered: string[] = [];
  /** Every live message the model queued this turn, sent or not. */
  get queued(): number { return this.tracked.size; }
  /** Live messages queued this turn that speak to the person: a zs.nudge.propose request is answered to the model and says nothing to anyone. */
  get spoken(): number { return [...this.tracked.values()].filter((entry) => entry.message.kind !== "nudge").length; }

  /** Reads what the VM has queued so far (sending it as the poll would) and answers how many messages the model queued this turn. */
  async refresh(): Promise<number> {
    if (!this.closed) await this.run();
    return this.tracked.size;
  }

  constructor(private readonly deps: LiveSendsDeps) {}

  async start(): Promise<void> {
    if (this.deps.prepare) {
      try {
        await this.deps.prepare();
      } catch (error) {
        this.closed = true;
        this.deps.logger.warn("live_sends.prepare_failed", { turnId: this.deps.turnId, error: (error as Error).message });
        if (this.deps.prepareRequired) throw error;
        return;
      }
    }
    this.polling = true;
    const tick = (): void => {
      this.timer = setTimeout(() => {
        void this.run().finally(() => {
          if (this.polling) tick();
        });
      }, this.deps.intervalMs ?? LIVE_SEND_POLL_MS);
      this.timer.unref();
    };
    tick();
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Stops for good without sending anything more (a failed or aborted turn). A message already on its way is not recalled. */
  halt(): void {
    this.closed = true;
    this.stopPolling();
  }

  private pending(): Tracked[] {
    return [...this.tracked.values()].filter((entry) => entry.state === "pending");
  }

  /**
   * Stops polling, sends whatever the model queued last, tries failed ones until they are sent or out of attempts, then reports the
   * lost. It never takes longer than the finish deadline and gives up early when a cycle cannot even read or authorize: what is
   * still unsent then counts as lost. An authorization failure is never reported, because the sender is then unverified.
   */
  async finish(): Promise<void> {
    this.stopPolling();
    const pause = this.deps.retryPauseMs ?? LIVE_RETRY_PAUSE_MS;
    const drain = async (): Promise<"done"> => {
      await this.cycle;
      for (let round = 0; round < MAX_LIVE_ATTEMPTS * MAX_LIVE_SENDS; round += 1) {
        this.cycleFailure = null;
        await this.run();
        if (this.closed || this.pending().length === 0 || this.cycleFailure) break;
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
      return "done";
    };
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.deps.finishDeadlineMs ?? LIVE_FINISH_DEADLINE_MS);
    });
    const outcome = await Promise.race([drain(), expired]);
    clearTimeout(timer);
    const wasClosed = this.closed;
    this.closed = true;
    const failure = this.cycleFailure;
    if (!wasClosed && (outcome === "expired" || failure === "read" || failure === "cycle")) {
      const stranded = this.pending();
      if (stranded.length > 0) this.deps.logger.warn("live_sends.gave_up", { turnId: this.deps.turnId, reason: outcome === "expired" ? "deadline" : failure, unsent: stranded.length });
      for (const entry of stranded) entry.state = "lost";
    }
    const lost = [...this.tracked.values()].filter((entry) => entry.state === "lost");
    if (lost.length > 0 && !wasClosed && failure !== "authorize" && this.deps.reportLost) {
      let reportTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.deps.reportLost(lost.map((entry) => entry.message)),
          new Promise<void>((resolve) => { reportTimer = setTimeout(resolve, LIVE_REPORT_DEADLINE_MS); }),
        ]);
      } catch (error) {
        this.deps.logger.warn("live_sends.report_failed", { turnId: this.deps.turnId, error: (error as Error).message });
      } finally {
        clearTimeout(reportTimer);
      }
    }
  }

  private run(before?: () => void): Promise<void> {
    this.cycle = this.cycle.then(() => { before?.(); return this.once(); }).catch((error) => {
      this.cycleFailure = "cycle";
      this.deps.logger.error("live_sends.cycle_failed", { turnId: this.deps.turnId, error: (error as Error).message });
    });
    return this.cycle;
  }

  /**
   * Reads the folder now instead of at the next tick. The router calls it when a tool call of the turn returned: a reply tool has written its file by
   * then, so the message leaves one read later, not up to a poll interval and a read later. The read is the same cycle the poll runs (after the
   * one in flight, never beside it), with the same authorization before anything leaves; calls made while one is waiting share it.
   */
  poke(): void {
    if (this.closed || !this.polling || this.poked) return;
    this.poked = true;
    void this.run(() => { this.poked = false; });
  }

  private reportDropped(dropped: LiveSendDrops): void {
    if (dropped.schema === this.lastDropped.schema && dropped.other_turn === this.lastDropped.other_turn && dropped.cap === this.lastDropped.cap) return;
    this.lastDropped = dropped;
    if (anyDrops(dropped)) this.deps.logger.warn("live_sends.dropped", { turnId: this.deps.turnId, schema: dropped.schema, other_turn: dropped.other_turn, cap: dropped.cap });
  }

  private async once(): Promise<void> {
    if (this.closed) return;
    let files: LiveSendFile[];
    try {
      files = await this.deps.read();
    } catch (error) {
      this.cycleFailure = "read";
      this.deps.logger.warn("live_sends.read_failed", { turnId: this.deps.turnId, error: (error as Error).message });
      return;
    }
    const { sends, dropped } = readLiveSends(files, this.deps.turnId);
    for (const entry of sends) {
      if (this.tracked.has(entry.id)) continue;
      if (this.tracked.size >= MAX_LIVE_SENDS) { dropped.cap += 1; continue; }
      this.tracked.set(entry.id, { message: entry.message, ordinal: this.tracked.size, attempts: 0, state: "pending" });
    }
    this.reportDropped(dropped);
    const due = this.pending();
    if (due.length === 0) return;
    let allowed: boolean;
    try {
      allowed = await this.deps.authorize();
    } catch (error) {
      this.cycleFailure = "authorize";
      this.deps.logger.warn("live_sends.authorize_failed", { turnId: this.deps.turnId, error: (error as Error).message });
      return;
    }
    if (!allowed) {
      this.closed = true;
      return;
    }
    for (const entry of due) {
      if (this.closed) return;
      entry.attempts += 1;
      const outcome = await this.deps.deliver(entry.message, entry.ordinal);
      if (entry.state !== "pending") return;
      if (outcome === "sent" || outcome === "answered") {
        entry.state = "sent";
        if (outcome === "sent") { this.sent += 1; if (entry.message.kind === "text" || entry.message.kind === "connect") { this.textsSent += 1; this.textsDelivered.push(entry.message.input.text); } }
        continue;
      }
      if (outcome === "stopped") {
        this.closed = true;
        return;
      }
      if (outcome === "rejected") {
        entry.state = "lost";
        this.deps.logger.warn("live_sends.rejected", { turnId: this.deps.turnId, ordinal: entry.ordinal, kind: entry.message.kind });
        continue;
      }
      if (entry.attempts >= MAX_LIVE_ATTEMPTS) {
        entry.state = "lost";
        continue;
      }
      return;
    }
  }
}
