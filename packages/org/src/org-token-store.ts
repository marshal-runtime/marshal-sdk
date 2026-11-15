import fs from "node:fs";
import path from "node:path";

import type { TokenSet } from "@marshal/agent-runtime-org";
import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";
import {
  assertSafeStorageReady,
  loadOrCreateKey,
  readEncryptedFile,
  writeEncryptedFile,
} from "../host-deps";

const log = createLogger("OrgTokenStore");

const StoredTokensSchema = z
  .object({
    accessToken: z.string().min(1).max(16384),
    tokenType: z.string().max(32),
    expiresAt: z.number().optional(),
    refreshToken: z.string().max(16384).optional(),
    idToken: z.string().max(16384).optional(),
    scope: z.string().max(4096).optional(),
  })
  .strict();

const StoredSessionSchema = z
  .object({
    version: z.literal(1),
    orgUrl: z.string().max(2048),
    orgId: z.string().max(63).optional(),
    tokens: StoredTokensSchema,
  })
  .strict();

export interface OrgStoredSession {
  orgUrl: string;
  /** The organization id from discovery, so data bound to an org can tell which org this session is for. */
  orgId?: string;
  tokens: TokenSet;
}

export interface OrgTokenStore {
  load(): Promise<OrgStoredSession | null>;
  save(session: OrgStoredSession): Promise<void>;
  clear(): Promise<void>;
}

export function orgTokenFilePath(): string {
  return path.join(getAppDataDir(), "org-auth.enc");
}

/**
 * Tokens live in an AES-GCM file keyed through Electron safeStorage. Every method touches
 * safeStorage, so callers must run after `app.whenReady()` (assertSafeStorageReady guards it).
 * When safeStorage has no key the store refuses to persist rather than falling back to plaintext.
 */
export class SafeStorageOrgTokenStore implements OrgTokenStore {
  constructor(private readonly filePath: string = orgTokenFilePath()) {}

  async load(): Promise<OrgStoredSession | null> {
    assertSafeStorageReady("org-token-store.load");
    let raw: string;
    try {
      raw = await readEncryptedFile(this.filePath);
    } catch {
      return null;
    }
    try {
      const parsed = StoredSessionSchema.safeParse(JSON.parse(raw)); // SF-4: validated by StoredSessionSchema.safeParse
      if (!parsed.success) {
        log.warn("Stored organization session is invalid; ignoring it");
        return null;
      }
      const { tokens } = parsed.data;
      return {
        orgUrl: parsed.data.orgUrl,
        ...(parsed.data.orgId ? { orgId: parsed.data.orgId } : {}),
        tokens: stripUndefined(tokens),
      };
    } catch {
      log.warn("Stored organization session is unreadable; ignoring it");
      return null;
    }
  }

  async save(session: OrgStoredSession): Promise<void> {
    assertSafeStorageReady("org-token-store.save");
    if (!loadOrCreateKey()) {
      log.warn("safeStorage unavailable; organization tokens stay in memory only");
      return;
    }
    await writeEncryptedFile(
      this.filePath,
      JSON.stringify({
        version: 1,
        orgUrl: session.orgUrl,
        ...(session.orgId ? { orgId: session.orgId } : {}),
        tokens: session.tokens,
      }),
    );
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.filePath, { force: true });
    await fs.promises.rm(`${this.filePath}.bak`, { force: true });
  }
}

function stripUndefined(tokens: z.infer<typeof StoredTokensSchema>): TokenSet {
  const out: TokenSet = { accessToken: tokens.accessToken, tokenType: tokens.tokenType };
  if (tokens.expiresAt !== undefined) out.expiresAt = tokens.expiresAt;
  if (tokens.refreshToken !== undefined) out.refreshToken = tokens.refreshToken;
  if (tokens.idToken !== undefined) out.idToken = tokens.idToken;
  if (tokens.scope !== undefined) out.scope = tokens.scope;
  return out;
}
