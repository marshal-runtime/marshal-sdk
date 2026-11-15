import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { createLogger } from "../host-deps";
import { getAppDataDir } from "../host-deps";

const log = createLogger("OrgCloudMoveStore");

/** Fields a stored move may carry on disk. Add a new field here and to the schema together. */
export const CLOUD_MOVE_KNOWN_FIELDS = [
  "sessionId",
  "orgId",
  "runId",
  "host",
  "movedAt",
  "messageCount",
  "state",
] as const;

const EntrySchema = z
  .object({
    sessionId: z.string().max(128),
    orgId: z.string().max(63),
    runId: z.string().max(128),
    host: z.string().max(128),
    movedAt: z.number(),
    messageCount: z.number().int().min(0),
    /** `pending` is written before the cloud is asked, so a crash mid-move still leaves the session read-only. */
    state: z.enum(["pending", "cloud"]).default("cloud"),
  })
  .strict();

const FileSchema = z.object({ version: z.literal(1), moves: z.array(EntrySchema) }).strict();

/** A session the organization's cloud drives; it stays read-only here until Continue here. Metadata only, never content. */
export type OrgCloudMoveEntry = z.output<typeof EntrySchema>;

export interface OrgCloudMoveStore {
  load(): OrgCloudMoveEntry[];
  save(moves: OrgCloudMoveEntry[]): void;
}

export function orgCloudMovesPath(): string {
  return path.join(getAppDataDir(), "org-cloud-moves.json");
}

function errorCode(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : "unknown";
}

function salvageLockedSessions(json: unknown): OrgCloudMoveEntry[] {
  const moves: unknown =
    typeof json === "object" && json !== null ? Reflect.get(json, "moves") : undefined;
  if (!Array.isArray(moves)) return [];
  const entries: OrgCloudMoveEntry[] = [];
  for (const move of moves as unknown[]) {
    const sessionId: unknown =
      typeof move === "object" && move !== null ? Reflect.get(move, "sessionId") : undefined;
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) continue;
    entries.push({
      sessionId,
      orgId: "",
      runId: "",
      host: "",
      movedAt: 0,
      messageCount: 0,
      state: "cloud",
    });
  }
  return entries;
}

export class FileOrgCloudMoveStore implements OrgCloudMoveStore {
  /** Set when the file could not be read at all, so no session could be re-locked from it. */
  unreadableNotice = false;

  constructor(private readonly filePath: string = orgCloudMovesPath()) {}

  load(): OrgCloudMoveEntry[] {
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
      this.quarantine("unreadable");
      this.unreadableNotice = true;
      return [];
    }
    const parsed = FileSchema.safeParse(json);
    if (parsed.success) return parsed.data.moves;
    this.quarantine("invalid");
    // Fail closed: a newer or damaged file still names the sessions the cloud holds.
    const salvaged = salvageLockedSessions(json);
    if (salvaged.length === 0) this.unreadableNotice = true;
    else {
      try {
        this.save(salvaged);
      } catch (error) {
        // The locks still apply in memory; the next successful save rewrites the file.
        log.error(`Could not rewrite the salvaged cloud moves: code=${errorCode(error)}`);
      }
    }
    return salvaged;
  }

  /** Keeps the bad file for inspection instead of losing it to the next save. */
  private quarantine(code: "unreadable" | "invalid"): void {
    log.error(`Stored cloud moves are ${code}; keeping the file as .corrupt and failing closed`);
    try {
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      log.error("Could not rename the stored cloud moves file");
    }
  }

  save(moves: OrgCloudMoveEntry[]): void {
    if (moves.length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, moves }), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}

export class InMemoryOrgCloudMoveStore implements OrgCloudMoveStore {
  constructor(public moves: OrgCloudMoveEntry[] = []) {}
  load(): OrgCloudMoveEntry[] {
    return structuredClone(this.moves);
  }
  save(moves: OrgCloudMoveEntry[]): void {
    this.moves = structuredClone(moves);
  }
}
