import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";

const log = createLogger("OrgCloudStrandedStore");

/** Most rows kept; the Cloud list itself never shows more than 50. */
export const MAX_STRANDED_SESSIONS = 100;

/** Fields a stored row may carry on disk. Add a new field here and to the schema together. */
export const CLOUD_STRANDED_KNOWN_FIELDS = [
  "sessionId",
  "orgId",
  "title",
  "workspaceId",
  "lastActivityAt",
] as const;

const EntrySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    /** The organization signed in when the continue was refused; another account never sees the row. */
    orgId: z.string().max(63),
    title: z.string().max(512),
    workspaceId: z.string().max(256),
    lastActivityAt: z.string().max(64),
  })
  .strict();

const FileSchema = z
  .object({ version: z.literal(1), sessions: z.array(EntrySchema).max(MAX_STRANDED_SESSIONS) })
  .strict();

/** A cloud-only session whose Continue here was refused after the lease was taken. Metadata only, never content. */
export type OrgCloudStrandedEntry = z.output<typeof EntrySchema>;

export interface OrgCloudStrandedStore {
  load(): OrgCloudStrandedEntry[];
  save(sessions: OrgCloudStrandedEntry[]): void;
}

export function orgCloudStrandedPath(): string {
  return path.join(getAppDataDir(), "org-cloud-stranded.json");
}

export class FileOrgCloudStrandedStore implements OrgCloudStrandedStore {
  constructor(private readonly filePath: string = orgCloudStrandedPath()) {}

  load(): OrgCloudStrandedEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    let json: unknown;
    try {
      json = JSON.parse(raw); // SF-4: validated by FileSchema.safeParse
    } catch {
      this.quarantine();
      return [];
    }
    const parsed = FileSchema.safeParse(json);
    if (parsed.success) return parsed.data.sessions;
    this.quarantine();
    return [];
  }

  /** Keeps the bad file for inspection instead of losing it to the next save. */
  private quarantine(): void {
    log.error("Stored stranded cloud sessions are unreadable; keeping the file as .corrupt");
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      log.error("Could not rename the stored stranded cloud sessions file");
    }
  }

  save(sessions: OrgCloudStrandedEntry[]): void {
    if (sessions.length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: 1, sessions: sessions.slice(-MAX_STRANDED_SESSIONS) }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, this.filePath);
  }
}

export class InMemoryOrgCloudStrandedStore implements OrgCloudStrandedStore {
  constructor(public sessions: OrgCloudStrandedEntry[] = []) {}
  load(): OrgCloudStrandedEntry[] {
    return structuredClone(this.sessions);
  }
  save(sessions: OrgCloudStrandedEntry[]): void {
    this.sessions = structuredClone(sessions);
  }
}
