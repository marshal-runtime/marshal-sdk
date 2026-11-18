import * as fs from "node:fs";

import { z } from "zod";

import { createLogger } from "../../../common/marshal-logger";
import { secureAtomicWriteFileSync } from "../../platform-security";

const log = createLogger("ExtensionSourceStore");

const CommitSchema = z.object({ sha: z.string(), subject: z.string() });

/**
 * One persisted record per installed extension. Zod strips unknown keys, so this schema is the
 * allowlist of fields kept on disk: add a field here when you add it to the record.
 */
const SourceRecordSchema = z.object({
  identity: z.string().min(1),
  kind: z.enum(["git", "local"]),
  localPath: z.string().min(1),
  repoRoot: z.string().optional(),
  repoUrl: z.string().optional(),
  remoteName: z.string().optional(),
  branch: z.string().optional(),
  subdir: z.string().optional(),
  installedCommit: z.string().optional(),
  installedFromDirtyTree: z.boolean().optional(),
  policy: z.enum(["auto", "notify", "pinned"]),
  hotReload: z.boolean(),
  scope: z.object({ sessionId: z.string(), workspaceName: z.string() }).optional(),
  latestCommit: z.string().optional(),
  checkedAt: z.string().optional(),
  updateAvailable: z.boolean().optional(),
  pendingCommits: z.array(CommitSchema).optional(),
  lastError: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  notifiedCommit: z.string().optional(),
});

const StoreFileSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(z.unknown()),
});

export type ExtensionSourceRecord = z.infer<typeof SourceRecordSchema>;

/** Records of where installed extensions came from, kept beside the runtime's own extension state. */
export class ExtensionSourceStore {
  private records = new Map<string, ExtensionSourceRecord>();

  constructor(private readonly filePath: string) {
    this.records = this.load();
  }

  list(): ExtensionSourceRecord[] {
    return [...this.records.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    );
  }

  get(identity: string): ExtensionSourceRecord | undefined {
    return this.records.get(identity);
  }

  put(record: ExtensionSourceRecord): ExtensionSourceRecord {
    const parsed = SourceRecordSchema.parse(record);
    this.records.set(parsed.identity, parsed);
    this.save();
    return parsed;
  }

  patch(identity: string, changes: Partial<ExtensionSourceRecord>): ExtensionSourceRecord {
    const current = this.records.get(identity);
    if (!current) throw new Error(`No source is recorded for ${identity}.`);
    const next: Record<string, unknown> = { ...current, ...changes };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete next[key];
    }
    return this.put(SourceRecordSchema.parse(next));
  }

  delete(identity: string): void {
    if (this.records.delete(identity)) this.save();
  }

  private load(): Map<string, ExtensionSourceRecord> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return new Map();
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      log.warn("Extension source file is not valid JSON; starting empty");
      return new Map();
    }
    const file = StoreFileSchema.safeParse(data);
    if (!file.success) {
      log.warn("Extension source file has an unknown shape; starting empty");
      return new Map();
    }
    const records = new Map<string, ExtensionSourceRecord>();
    for (const candidate of file.data.sources) {
      const parsed = SourceRecordSchema.safeParse(candidate);
      if (parsed.success) records.set(parsed.data.identity, parsed.data);
    }
    return records;
  }

  private save(): void {
    secureAtomicWriteFileSync(
      this.filePath,
      `${JSON.stringify({ schemaVersion: 1, sources: this.list() }, null, 2)}\n`,
      { encoding: "utf8" },
    );
  }
}
