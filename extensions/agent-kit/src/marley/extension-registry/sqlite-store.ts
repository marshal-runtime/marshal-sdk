import type Database from "better-sqlite3";

import {
  checkFiles,
  RegistryConflict,
  RegistryRefusal,
  type ExtensionFiles,
  type ExtensionRegistryStore,
  type ExtensionVersion,
  type ExtensionVersionRef,
  type ExtensionVersionStatus,
  type RoutineBinding,
  type RunPin,
} from "./sdk-registry.js";

/**
 * The extension registry of record on the agent server's own database (the legacy `routine_specs` table is no longer read), so a
 * routine's version authority stays in one store. Rows are append-only except the status, which changes by
 * compare-and-set. Default off: nothing in the server constructs it yet (MLY-677, plan steps 5-6).
 */
export const EXTENSION_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS extension_versions (
  tenant TEXT NOT NULL, extension_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, row_json TEXT NOT NULL,
  PRIMARY KEY (tenant, extension_id, version)
);
CREATE TABLE IF NOT EXISTS extension_files (
  tenant TEXT NOT NULL, extension_id TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL,
  PRIMARY KEY (tenant, extension_id, version, path)
);
CREATE TABLE IF NOT EXISTS extension_bindings (
  tenant TEXT NOT NULL, routine_id TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (tenant, routine_id)
);
CREATE TABLE IF NOT EXISTS extension_run_pins (
  tenant TEXT NOT NULL, run_id TEXT NOT NULL, at TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (tenant, run_id)
);`;

export class SqliteExtensionRegistryStore implements ExtensionRegistryStore {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    db.exec(EXTENSION_REGISTRY_DDL);
  }

  async listVersions(tenant: string, extensionId?: string): Promise<ExtensionVersion[]> {
    const rows = (extensionId === undefined
      ? this.db.prepare("SELECT row_json FROM extension_versions WHERE tenant=? ORDER BY extension_id, version").all(tenant)
      : this.db.prepare("SELECT row_json FROM extension_versions WHERE tenant=? AND extension_id=? ORDER BY version").all(tenant, extensionId)) as { row_json: string }[];
    return rows.map((row) => JSON.parse(row.row_json) as ExtensionVersion);
  }

  async createVersion(version: ExtensionVersion, files: ExtensionFiles): Promise<void> {
    const entries = checkFiles(files);
    const insert = this.db.transaction(() => {
      const result = this.db
        .prepare("INSERT INTO extension_versions (tenant,extension_id,version,status,row_json) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING")
        .run(version.tenant, version.extensionId, version.version, version.status, JSON.stringify(version));
      if (result.changes !== 1) throw new RegistryConflict(`version ${version.version} exists`);
      const file = this.db.prepare("INSERT INTO extension_files (tenant,extension_id,version,path,content) VALUES (?,?,?,?,?)");
      for (const [name, content] of entries) file.run(version.tenant, version.extensionId, version.version, name, content);
    });
    insert();
  }

  async updateStatus(ref: ExtensionVersionRef, expected: ExtensionVersionStatus, next: ExtensionVersionStatus, approvedBy?: string): Promise<ExtensionVersion> {
    const update = this.db.transaction((): ExtensionVersion => {
      const row = this.db.prepare("SELECT row_json FROM extension_versions WHERE tenant=? AND extension_id=? AND version=?").get(ref.tenant, ref.extensionId, ref.version) as
        | { row_json: string }
        | undefined;
      if (!row) throw new RegistryRefusal("no such version");
      const current = JSON.parse(row.row_json) as ExtensionVersion;
      const updated: ExtensionVersion = { ...current, status: next, ...(approvedBy ? { approvedBy } : {}), ...(next === "active" && expected === "proposed" ? { activatedAt: this.now().toISOString() } : {}) };
      const result = this.db
        .prepare("UPDATE extension_versions SET status=?, row_json=? WHERE tenant=? AND extension_id=? AND version=? AND status=?")
        .run(next, JSON.stringify(updated), ref.tenant, ref.extensionId, ref.version, expected);
      if (result.changes !== 1) throw new RegistryConflict(`version is ${current.status}, not ${expected}`);
      return updated;
    });
    return update();
  }

  async readFiles(ref: ExtensionVersionRef): Promise<ExtensionFiles> {
    const rows = this.db.prepare("SELECT path, content FROM extension_files WHERE tenant=? AND extension_id=? AND version=?").all(ref.tenant, ref.extensionId, ref.version) as
      { path: string; content: Buffer }[];
    return Object.fromEntries(rows.map((row) => [row.path, Buffer.from(row.content)]));
  }

  async getBinding(tenant: string, routineId: string): Promise<RoutineBinding | undefined> {
    const row = this.db.prepare("SELECT row_json FROM extension_bindings WHERE tenant=? AND routine_id=?").get(tenant, routineId) as { row_json: string } | undefined;
    return row ? (JSON.parse(row.row_json) as RoutineBinding) : undefined;
  }

  async listBindings(tenant: string): Promise<RoutineBinding[]> {
    return (this.db.prepare("SELECT row_json FROM extension_bindings WHERE tenant=? ORDER BY routine_id").all(tenant) as { row_json: string }[]).map(
      (row) => JSON.parse(row.row_json) as RoutineBinding,
    );
  }

  async putBinding(binding: RoutineBinding): Promise<void> {
    this.db
      .prepare("INSERT INTO extension_bindings (tenant,routine_id,row_json) VALUES (?,?,?) ON CONFLICT(tenant,routine_id) DO UPDATE SET row_json=excluded.row_json")
      .run(binding.tenant, binding.routineId, JSON.stringify(binding));
  }

  async recordRunPin(pin: RunPin): Promise<void> {
    this.db.prepare("INSERT INTO extension_run_pins (tenant,run_id,at,row_json) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(pin.tenant, pin.runId, pin.at, JSON.stringify(pin));
  }

  async listRunPins(tenant: string, limit = 100): Promise<RunPin[]> {
    return (this.db.prepare("SELECT row_json FROM extension_run_pins WHERE tenant=? ORDER BY at DESC, rowid DESC LIMIT ?").all(tenant, limit) as { row_json: string }[]).map(
      (row) => JSON.parse(row.row_json) as RunPin,
    );
  }
}
