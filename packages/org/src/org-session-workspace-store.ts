import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";

const log = createLogger("OrgSessionWorkspaceStore");

/** Most choices kept; the oldest go first. */
export const MAX_SESSION_WORKSPACE_CHOICES = 500;

/** Fields a stored choice may carry on disk. Add a new field here and to the schema together. */
export const SESSION_WORKSPACE_KNOWN_FIELDS = [
  "sessionId",
  "orgId",
  "orgWorkspaceId",
  "chosenAt",
] as const;

const EntrySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    /** The organization the choice was made in; another account never sees it. */
    orgId: z.string().max(63),
    orgWorkspaceId: z.string().min(1).max(256),
    chosenAt: z.number().int().nonnegative(),
  })
  .strict();

const FileSchema = z
  .object({
    version: z.literal(1),
    choices: z.array(EntrySchema).max(MAX_SESSION_WORKSPACE_CHOICES),
  })
  .strict();

/** The organization workspace a person picked for a session whose own workspace maps to none. */
export type OrgSessionWorkspaceChoice = z.output<typeof EntrySchema>;

export interface OrgSessionWorkspaceStore {
  load(): OrgSessionWorkspaceChoice[];
  save(choices: OrgSessionWorkspaceChoice[]): void;
}

export function orgSessionWorkspacePath(): string {
  return path.join(getAppDataDir(), "org-session-workspaces.json");
}

export class FileOrgSessionWorkspaceStore implements OrgSessionWorkspaceStore {
  constructor(private readonly filePath: string = orgSessionWorkspacePath()) {}

  load(): OrgSessionWorkspaceChoice[] {
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
    if (parsed.success) return parsed.data.choices;
    this.quarantine();
    return [];
  }

  /** Keeps the bad file for inspection instead of losing it to the next save. */
  private quarantine(): void {
    log.error("Stored session workspace choices are unreadable; keeping the file as .corrupt");
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      log.error("Could not rename the stored session workspace choices file");
    }
  }

  save(choices: OrgSessionWorkspaceChoice[]): void {
    if (choices.length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: 1, choices: choices.slice(-MAX_SESSION_WORKSPACE_CHOICES) }),
      { mode: 0o600 },
    );
    fs.renameSync(temp, this.filePath);
  }
}

export class InMemoryOrgSessionWorkspaceStore implements OrgSessionWorkspaceStore {
  constructor(public choices: OrgSessionWorkspaceChoice[] = []) {}
  load(): OrgSessionWorkspaceChoice[] {
    return structuredClone(this.choices);
  }
  save(choices: OrgSessionWorkspaceChoice[]): void {
    this.choices = structuredClone(choices);
  }
}
