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

const log = createLogger("OrgSharedLinkStore");

export const MAX_SHARED_LINKS = 500;
export const MAX_ADOPTED_MESSAGES = 5000;
export const MAX_PARTICIPANTS = 200;

/** Fields a link may carry on disk. Add a new field here and to the schema together. */
export const SHARED_LINK_KNOWN_FIELDS = [
  "orgId",
  "principal",
  "localSessionId",
  "orgSessionId",
  "role",
  "ownerPrincipal",
  "status",
  "pulledThrough",
  "pushedThrough",
  "contextThrough",
  "adoptedThrough",
  "onServer",
  "orgTitle",
  "sharedTitle",
  "participants",
  "linkedAt",
] as const;

const LinkSchema = z
  .object({
    orgId: z.string().max(63),
    /** The signed-in person this link belongs to. */
    principal: z.string().max(256),
    localSessionId: z.string().max(128),
    orgSessionId: z.string().max(128),
    role: z.enum(["owner", "driver", "collaborator"]),
    ownerPrincipal: z.string().max(256),
    status: z.enum(["active", "revoked", "gone", "offline"]),
    /** Transcript messages on the server this desktop has read (the next pull starts at this index). */
    pulledThrough: z.number().int().min(0),
    /** The last local message the server holds; the next push starts after it. */
    pushedThrough: z.string().max(256).optional(),
    /** The last message from others the model was given as turn context. */
    contextThrough: z.string().max(256).optional(),
    /** Owner links over a transcript written before message ids: the last local message matched to an id-less server message. */
    adoptedThrough: z.string().max(256).optional(),
    /** Local messages matched that way, after `pushedThrough`: the server already holds them, so a push skips them. */
    onServer: z.array(z.string().max(256)).max(MAX_ADOPTED_MESSAGES).optional(),
    /** A joined copy: the organization title last applied to the local session, so a later change there renames it again. */
    orgTitle: z.string().max(512).optional(),
    /** The owner: the title last stored in the organization envelope. */
    sharedTitle: z.string().max(512).optional(),
    /** Everyone seen writing in the session, kept as messages arrive so describing the link never reads the session. */
    participants: z.array(z.string().max(256)).max(MAX_PARTICIPANTS).optional(),
    linkedAt: z.number(),
  })
  .strict();

const FileSchema = z
  .object({ version: z.literal(1), links: z.array(LinkSchema).max(MAX_SHARED_LINKS) })
  .strict();

export type OrgSharedLinkEntry = z.infer<typeof LinkSchema>;

export interface OrgSharedLinkStore {
  load(): Promise<OrgSharedLinkEntry[]>;
  save(links: readonly OrgSharedLinkEntry[]): Promise<void>;
}

export function orgSharedLinkStorePath(): string {
  return path.join(getAppDataDir(), "org-shared-links.enc");
}

/** Validates a file the way {@link SafeStorageOrgSharedLinkStore.load} does. */
export function parseOrgSharedLinkFile(value: unknown): OrgSharedLinkEntry[] | null {
  const parsed = FileSchema.safeParse(value);
  return parsed.success ? parsed.data.links : null;
}

/** Encrypted at rest; read only after app ready, and only while shared sessions are on. */
export class SafeStorageOrgSharedLinkStore implements OrgSharedLinkStore {
  constructor(private readonly filePath: string = orgSharedLinkStorePath()) {}

  async load(): Promise<OrgSharedLinkEntry[]> {
    assertSafeStorageReady("org-shared-link-store.load");
    let raw: string;
    try {
      raw = await readEncryptedFile(this.filePath);
    } catch {
      return [];
    }
    try {
      const links = parseOrgSharedLinkFile(JSON.parse(raw)); // SF-4: validated by parseOrgSharedLinkFile
      if (links) return links;
      log.warn("Stored shared links are invalid; starting empty");
    } catch {
      log.warn("Stored shared links are unreadable; starting empty");
    }
    return [];
  }

  async save(links: readonly OrgSharedLinkEntry[]): Promise<void> {
    assertSafeStorageReady("org-shared-link-store.save");
    if (!loadOrCreateKey()) {
      log.warn("safeStorage unavailable; shared links stay in memory only");
      return;
    }
    await writeEncryptedFile(
      this.filePath,
      JSON.stringify({ version: 1, links: links.slice(-MAX_SHARED_LINKS) }),
    );
  }
}

export class InMemoryOrgSharedLinkStore implements OrgSharedLinkStore {
  saves = 0;
  constructor(public links: OrgSharedLinkEntry[] = []) {}
  async load(): Promise<OrgSharedLinkEntry[]> {
    return structuredClone(this.links);
  }
  async save(links: readonly OrgSharedLinkEntry[]): Promise<void> {
    this.saves += 1;
    this.links = structuredClone([...links]);
  }
}
