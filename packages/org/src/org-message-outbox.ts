import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";
import {
  assertSafeStorageReady,
  loadOrCreateKey,
  readEncryptedFile,
  writeEncryptedFile,
} from "../host-deps";

const log = createLogger("OrgMessageOutbox");

export const MAX_MESSAGE_OUTBOX_ENTRIES = 50;
/** The most bytes of text the organization's inbox accepts in one message. */
export const MAX_REMOTE_MESSAGE_BYTES = 64 * 1024;

/** Fields an outbox entry may carry on disk. Add a new field here and to the schema together. */
export const MESSAGE_OUTBOX_ENTRY_KNOWN_FIELDS = [
  "sessionId",
  "orgId",
  "clientMsgId",
  "text",
  "queuedAt",
  "attempts",
  "state",
  "error",
] as const;

const EntrySchema = z
  .object({
    sessionId: z.string().max(128),
    orgId: z.string().max(63),
    clientMsgId: z.string().max(128),
    text: z.string().max(MAX_REMOTE_MESSAGE_BYTES),
    queuedAt: z.number(),
    attempts: z.number().int().min(0),
    state: z.enum(["pending", "failed"]),
    error: z.string().max(64).optional(),
  })
  .strict();

const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) }).strict();

/**
 * A message written while the cloud holds a session that has not reached the organization yet.
 * `pending` waits for a connection; `failed` was refused for good and waits for the person to
 * take it back. The text is customer content, so it is only ever stored encrypted.
 */
export interface OrgMessageOutboxEntry {
  sessionId: string;
  /** The organization it was written for; it only posts while signed in to that organization. */
  orgId: string;
  /** Posting the same id again returns the stored message, so a retry never sends it twice. */
  clientMsgId: string;
  text: string;
  queuedAt: number;
  attempts: number;
  state: "pending" | "failed";
  /** Why a `failed` entry was refused. */
  error?: string;
}

/** The outbox could not be written: there is no secure storage, and messages are never kept in plain text or only in memory. */
export class OrgMessageOutboxUnavailableError extends Error {
  constructor() {
    super("outbox-unavailable");
  }
}

export interface OrgMessageOutboxStore {
  load(): Promise<OrgMessageOutboxEntry[]>;
  save(entries: OrgMessageOutboxEntry[]): Promise<void>;
}

export function orgMessageOutboxPath(): string {
  return path.join(getAppDataDir(), "org-message-outbox.enc");
}

export class SafeStorageOrgMessageOutbox implements OrgMessageOutboxStore {
  constructor(private readonly filePath: string = orgMessageOutboxPath()) {}

  async load(): Promise<OrgMessageOutboxEntry[]> {
    assertSafeStorageReady("org-message-outbox.load");
    let raw: string;
    try {
      raw = await readEncryptedFile(this.filePath);
    } catch {
      return [];
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(raw)); // SF-4: validated by FileSchema.safeParse
      if (!parsed.success) {
        log.warn("Stored message outbox is invalid; ignoring it");
        return [];
      }
      return parsed.data.entries;
    } catch {
      log.warn("Stored message outbox is unreadable; ignoring it");
      return [];
    }
  }

  async save(entries: OrgMessageOutboxEntry[]): Promise<void> {
    assertSafeStorageReady("org-message-outbox.save");
    if (entries.length === 0) {
      await fs.promises.rm(this.filePath, { force: true });
      await fs.promises.rm(`${this.filePath}.bak`, { force: true });
      return;
    }
    if (!loadOrCreateKey()) {
      log.warn("safeStorage unavailable; the message outbox was not written");
      throw new OrgMessageOutboxUnavailableError();
    }
    await writeEncryptedFile(this.filePath, JSON.stringify({ version: 1, entries }));
  }
}

export class InMemoryOrgMessageOutbox implements OrgMessageOutboxStore {
  constructor(public entries: OrgMessageOutboxEntry[] = []) {}
  async load(): Promise<OrgMessageOutboxEntry[]> {
    return structuredClone(this.entries);
  }
  async save(entries: OrgMessageOutboxEntry[]): Promise<void> {
    this.entries = structuredClone(entries);
  }
}
