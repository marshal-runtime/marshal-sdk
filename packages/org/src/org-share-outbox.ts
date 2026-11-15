import fs from "node:fs";
import path from "node:path";

import {
  isOrgWorkspaceId,
  isPrincipal,
  isSessionId,
  type OrgSessionUpload,
  type OrgTranscriptMessage,
  type OrgWorkspaceId,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";
import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";
import {
  assertSafeStorageReady,
  loadOrCreateKey,
  readEncryptedFile,
  writeEncryptedFile,
} from "../host-deps";

const log = createLogger("OrgShareOutbox");

export const MAX_OUTBOX_ENTRIES = 50;

/** Fields an outbox entry may carry on disk. Add a new field here and to the schema together. */
export const OUTBOX_ENTRY_KNOWN_FIELDS = [
  "sessionId",
  "orgId",
  "queuedAt",
  "attempts",
  "upload",
  "messages",
] as const;

const UploadSchema = z
  .object({
    id: z.string().refine(isSessionId),
    workspaceId: z.custom<OrgWorkspaceId>(isOrgWorkspaceId),
    title: z.string().max(256),
    owner: z.custom<UserPrincipal>((v) => isPrincipal(v) && v.startsWith("user:")),
    createdAt: z.string().max(40),
    updatedAt: z.string().max(40),
    labels: z.enum(["public", "team", "restricted"]),
    runtime: z.string().max(32),
  })
  .strict();

const MessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    text: z.string(),
    at: z.string().max(40),
    messageId: z.string().max(128).optional(),
  })
  .strict();

const EntrySchema = z
  .object({
    sessionId: z.string().max(128),
    orgId: z.string().max(63),
    queuedAt: z.number(),
    attempts: z.number().int().min(0),
    upload: UploadSchema,
    messages: z.array(MessageSchema),
  })
  .strict();

const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) }).strict();

/** A sanitized session waiting to reach the organization. The transcript is customer content, so it is only ever stored encrypted. */
export interface OrgShareOutboxEntry {
  sessionId: string;
  /** The organization the share was made in; it only uploads while signed in to that organization. */
  orgId: string;
  queuedAt: number;
  attempts: number;
  upload: OrgSessionUpload;
  messages: OrgTranscriptMessage[];
}

export interface OrgShareOutboxStore {
  load(): Promise<OrgShareOutboxEntry[]>;
  save(entries: OrgShareOutboxEntry[]): Promise<void>;
}

export function orgShareOutboxPath(): string {
  return path.join(getAppDataDir(), "org-share-outbox.enc");
}

export class SafeStorageOrgShareOutbox implements OrgShareOutboxStore {
  constructor(private readonly filePath: string = orgShareOutboxPath()) {}

  async load(): Promise<OrgShareOutboxEntry[]> {
    assertSafeStorageReady("org-share-outbox.load");
    let raw: string;
    try {
      raw = await readEncryptedFile(this.filePath);
    } catch {
      return [];
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(raw)); // SF-4: validated by FileSchema.safeParse
      if (!parsed.success) {
        log.warn("Stored share outbox is invalid; ignoring it");
        return [];
      }
      return parsed.data.entries;
    } catch {
      log.warn("Stored share outbox is unreadable; ignoring it");
      return [];
    }
  }

  async save(entries: OrgShareOutboxEntry[]): Promise<void> {
    assertSafeStorageReady("org-share-outbox.save");
    if (entries.length === 0) {
      await fs.promises.rm(this.filePath, { force: true });
      await fs.promises.rm(`${this.filePath}.bak`, { force: true });
      return;
    }
    if (!loadOrCreateKey()) {
      log.warn("safeStorage unavailable; the share outbox stays in memory only");
      return;
    }
    await writeEncryptedFile(this.filePath, JSON.stringify({ version: 1, entries }));
  }
}

export class InMemoryOrgShareOutbox implements OrgShareOutboxStore {
  constructor(public entries: OrgShareOutboxEntry[] = []) {}
  async load(): Promise<OrgShareOutboxEntry[]> {
    return structuredClone(this.entries);
  }
  async save(entries: OrgShareOutboxEntry[]): Promise<void> {
    this.entries = structuredClone(entries);
  }
}
