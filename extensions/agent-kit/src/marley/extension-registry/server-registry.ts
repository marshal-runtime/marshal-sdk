import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

import { extensionFor, RELEASE_EXTENSION_FOR, type ReleaseSkillSource } from "./release-extensions.js";
import {
  ExtensionRegistry,
  hashExtensionFiles,
  RegistryRefusal,
  RELEASE_TENANT,
  type ExtensionFiles,
  type ExtensionVersion,
  type RoutineBinding,
  type RunPin,
} from "./sdk-registry.js";
import { SqliteExtensionRegistryStore } from "./sqlite-store.js";

/** A routine's resolved package for one brand: what the routine runner launches. */
export interface ResolvedRoutine {
  routineId: string;
  extensionId: string;
  agentId: string;
  version: number;
  /** The brand id when the brand runs its own fork, else `release`. */
  copyTenant: string;
  contentHash: string;
  author: ExtensionVersion["author"];
  files(): Promise<ExtensionFiles>;
  /** Writes the package read-only into a new directory; returns its content hash. */
  materialize(target: string): Promise<string>;
  /** The package's own `routines/<routineId>.yaml` (its triggers), if it ships one. */
  routineYaml(): Promise<string | undefined>;
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Reads a package directory into registry files (relative POSIX paths). */
export function readPackageDir(dir: string): ExtensionFiles {
  const files: ExtensionFiles = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files[rel] = fs.readFileSync(full);
    }
  };
  walk(dir, "");
  return files;
}

/**
 * The agent server's registry of record (plan steps 5-6), always built. It owns the
 * versions of every extension (release and per brand), answers which package a brand's
 * routine runs, and tells the routine runner when an owner's approval rebinds one.
 */
export class ServerExtensionRegistry {
  readonly registry: ExtensionRegistry;
  readonly store: SqliteExtensionRegistryStore;
  private readonly listeners = new Set<(brandId: string, routineId: string) => void>();

  constructor(private readonly options: { db: Database.Database; now?: () => Date; releaseSkills?: ReleaseSkillSource }) {
    this.store = new SqliteExtensionRegistryStore(options.db, options.now);
    this.registry = new ExtensionRegistry({ store: this.store, ...(options.now ? { now: options.now } : {}) });
  }

  /** Release versions from package directories. Idempotent: a package whose content equals the newest release version adds nothing. */
  async publishReleasePackages(dirs: readonly string[]): Promise<{ published: string[]; unchanged: string[] }> {
    const report = { published: [] as string[], unchanged: [] as string[] };
    for (const dir of dirs) {
      const files = readPackageDir(dir);
      const manifest = JSON.parse(String(files["runtime-extension.json"] ?? "null")) as { identity?: string } | null;
      if (!manifest?.identity) throw new RegistryRefusal(`${dir} has no runtime-extension.json identity`);
      const hash = hashExtensionFiles(files);
      const existing = await this.store.listVersions(RELEASE_TENANT, manifest.identity);
      const newest = existing.sort((a, b) => b.version - a.version)[0];
      if (newest?.contentHash === hash) {
        report.unchanged.push(manifest.identity);
        continue;
      }
      const version = await this.registry.publishRelease(manifest.identity, files, { authorRef: "release" });
      for (const old of existing) if (old.status === "active") await this.store.updateStatus(old, "active", "retired");
      report.published.push(`${manifest.identity}@${version.version}`);
    }
    return report;
  }

  /** Which package a brand's routine runs now: its binding (pin, else active fork), else the release default for a system routine. */
  async resolveRoutine(brandId: string, routineId: string): Promise<ResolvedRoutine | undefined> {
    const binding = await this.store.getBinding(brandId, routineId);
    let extensionId: string;
    let agentId: string;
    let version: ExtensionVersion;
    if (binding) {
      if (!binding.enabled) return undefined;
      const resolved = await this.registry.resolve(brandId, routineId);
      extensionId = resolved.version.extensionId;
      agentId = resolved.agentId;
      version = resolved.version;
    } else {
      const release = RELEASE_EXTENSION_FOR[routineId];
      if (!release) return undefined;
      try {
        version = await this.registry.current(brandId, release.extensionId);
      } catch {
        return undefined;
      }
      extensionId = release.extensionId;
      agentId = release.agentId;
    }
    const ref = { tenant: version.tenant, extensionId, version: version.version };
    return {
      routineId,
      extensionId,
      agentId,
      version: version.version,
      copyTenant: version.tenant,
      contentHash: version.contentHash,
      author: version.author,
      files: () => this.registry.files(ref),
      materialize: (target) => this.registry.materialize(ref, target),
      routineYaml: async () => {
        const text = (await this.registry.files(ref))[`routines/${routineId}.yaml`] ?? (await this.registry.files(ref))[`routines/${agentId}.yaml`];
        return text === undefined ? undefined : String(text);
      },
    };
  }

  /** The brand's own enabled routine bindings (forks and brand-made routines). */
  async listBindings(brandId: string): Promise<RoutineBinding[]> {
    return (await this.store.listBindings(brandId)).filter((binding) => binding.enabled);
  }

  async recordRunPin(input: { brandId: string; runId: string; routineId?: string; extensionId: string; version: number; agentId: string; contentHash: string; copyTenant: string }): Promise<void> {
    const pin: RunPin = {
      runId: input.runId,
      tenant: input.brandId,
      ...(input.routineId ? { routineId: input.routineId } : {}),
      extensionId: input.extensionId,
      version: input.version,
      agentId: input.agentId,
      contentHash: input.contentHash,
      copyTenant: input.copyTenant,
      at: (this.options.now?.() ?? new Date()).toISOString(),
    };
    await this.store.recordRunPin(pin);
  }

  onBindingChanged(listener: (brandId: string, routineId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyBindingChanged(brandId: string, routineId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(brandId, routineId);
      } catch {
        // a listener's failure never undoes an approval
      }
    }
  }
}

export { extensionFor };
