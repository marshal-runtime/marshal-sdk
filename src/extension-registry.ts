import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Per-tenant extension registry (G6): which version of an extension a tenant (a brand) runs, who wrote it, its content
 * hash, and the pin each run used.
 *
 * - The release copy of an extension is tenant `RELEASE_TENANT`, versions 1..n in release order.
 * - A tenant's own copy is a fork: versions 1..n under that tenant, each naming the version it was forked from.
 * - A routine binding says which extension and agent a tenant's routine runs, pinned to one version or following the
 *   tenant's active version (falling back to the newest active release version).
 * - Every run records the version and content hash it resolved, so a run can be reproduced exactly.
 *
 * The registry decides nothing about authority: `activate` takes an approval the host has already checked (for Marley,
 * the owner's own live turn). Content is stored with the version and checked against its hash every time it is read.
 */

export const RELEASE_TENANT = "release";

export type ExtensionAuthor = "release" | "marley" | "owner";
export type ExtensionVersionStatus = "draft" | "proposed" | "active" | "retired";

export interface ExtensionVersionRef {
  tenant: string;
  extensionId: string;
  version: number;
}

export interface ExtensionVersion extends ExtensionVersionRef {
  author: ExtensionAuthor;
  /** Who, in the author's world: a member id, a session id, a release tag. Never a phone number or name. */
  authorRef?: string;
  /** The version this one was forked from (a release version for a tenant's first fork). */
  forkOf?: ExtensionVersionRef;
  /** sha256 over the sorted (path, sha256(content)) list; see `hashExtensionFiles`. */
  contentHash: string;
  createdAt: string;
  status: ExtensionVersionStatus;
  /** Who approved activation, as the host recorded it. */
  approvedBy?: string;
  note?: string;
}

export interface RoutineBinding {
  tenant: string;
  routineId: string;
  extensionId: string;
  agentId: string;
  /** A fixed version of the tenant's (or the release's) copy; absent = follow the active version. */
  pin?: { tenant: string; version: number };
  enabled: boolean;
  updatedAt: string;
}

export interface RunPin extends ExtensionVersionRef {
  runId: string;
  routineId?: string;
  agentId: string;
  contentHash: string;
  /** Whose copy ran: the tenant's own fork or `release`. */
  copyTenant: string;
  at: string;
}

export interface ResolvedExtension {
  binding?: RoutineBinding;
  version: ExtensionVersion;
  agentId: string;
}

/** Package files by relative path. */
export type ExtensionFiles = Record<string, string | Buffer>;

/** Where the registry keeps its rows and contents. The file store is the default; a host can back it with a database. */
export interface ExtensionRegistryStore {
  listVersions(tenant: string, extensionId?: string): Promise<ExtensionVersion[]>;
  /** Creates the version with the given number; fails with `RegistryConflict` when that number exists. */
  createVersion(version: ExtensionVersion, files: ExtensionFiles): Promise<void>;
  /** Changes the status when the current status is `expected`; fails with `RegistryConflict` otherwise. */
  updateStatus(ref: ExtensionVersionRef, expected: ExtensionVersionStatus, next: ExtensionVersionStatus, approvedBy?: string): Promise<ExtensionVersion>;
  readFiles(ref: ExtensionVersionRef): Promise<ExtensionFiles>;
  getBinding(tenant: string, routineId: string): Promise<RoutineBinding | undefined>;
  listBindings(tenant: string): Promise<RoutineBinding[]>;
  putBinding(binding: RoutineBinding): Promise<void>;
  recordRunPin(pin: RunPin): Promise<void>;
  listRunPins(tenant: string, limit?: number): Promise<RunPin[]>;
}

export class RegistryConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConflict";
  }
}

export class RegistryRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryRefusal";
  }
}

const TENANT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EXTENSION_ID = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const ROUTINE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_EXTENSION_FILES = 500;
export const MAX_EXTENSION_BYTES = 8 * 1024 * 1024;

export function checkTenant(tenant: string): string {
  if (!TENANT.test(tenant)) throw new RegistryRefusal(`invalid tenant: ${JSON.stringify(tenant).slice(0, 80)}`);
  return tenant;
}

export function checkExtensionId(id: string): string {
  if (!EXTENSION_ID.test(id)) throw new RegistryRefusal(`invalid extension id: ${JSON.stringify(id).slice(0, 80)}`);
  return id;
}

/** A package-relative path: forward slashes, no empty, `.` or `..` segment, not absolute, no NUL or backslash. */
export function checkRelativePath(file: string): string {
  if (!file || file.length > 400 || file.startsWith("/") || /[\\\0]/.test(file)) throw new RegistryRefusal(`invalid package path: ${JSON.stringify(file).slice(0, 80)}`);
  for (const segment of file.split("/")) {
    if (!segment || segment === "." || segment === "..") throw new RegistryRefusal(`invalid package path: ${JSON.stringify(file).slice(0, 80)}`);
  }
  return file;
}

function bytes(content: string | Buffer): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

/** Checks a package's files (paths, count, total size); returns them sorted by path. */
export function checkFiles(files: ExtensionFiles): [string, Buffer][] {
  const entries = Object.entries(files).map(([file, content]) => [checkRelativePath(file), bytes(content)] as [string, Buffer]);
  if (entries.length === 0) throw new RegistryRefusal("an extension needs at least one file");
  if (entries.length > MAX_EXTENSION_FILES) throw new RegistryRefusal(`too many files (${entries.length} > ${MAX_EXTENSION_FILES})`);
  const total = entries.reduce((sum, [, content]) => sum + content.length, 0);
  if (total > MAX_EXTENSION_BYTES) throw new RegistryRefusal(`package too large (${total} > ${MAX_EXTENSION_BYTES} bytes)`);
  if (!entries.some(([file]) => file === "runtime-extension.json")) throw new RegistryRefusal("an extension needs runtime-extension.json");
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 over `path\0sha256(content)\n` lines in path order: the same files always give the same hash. */
export function hashExtensionFiles(files: ExtensionFiles): string {
  const hash = createHash("sha256");
  for (const [file, content] of checkFiles(files)) hash.update(`${file}\0${createHash("sha256").update(content).digest("hex")}\n`);
  return `sha256:${hash.digest("hex")}`;
}

export interface ExtensionRegistryOptions {
  store: ExtensionRegistryStore;
  now?: () => Date;
}

export class ExtensionRegistry {
  private readonly store: ExtensionRegistryStore;
  private readonly now: () => Date;

  constructor(options: ExtensionRegistryOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** Adds a release version (active at once: the release is reviewed elsewhere). */
  async publishRelease(extensionId: string, files: ExtensionFiles, input: { authorRef?: string; note?: string } = {}): Promise<ExtensionVersion> {
    return this.add(RELEASE_TENANT, extensionId, files, { author: "release", status: "active", ...input });
  }

  /**
   * Adds a tenant version as a draft. `forkOf` defaults to the version the tenant runs now (its newest active one, else
   * the newest active release one), so a first edit of a system routine is a fork of the release copy.
   */
  async draft(
    tenant: string,
    extensionId: string,
    files: ExtensionFiles,
    input: { author: Exclude<ExtensionAuthor, "release">; authorRef?: string; note?: string; forkOf?: ExtensionVersionRef },
  ): Promise<ExtensionVersion> {
    if (checkTenant(tenant) === RELEASE_TENANT) throw new RegistryRefusal("drafts belong to a tenant, not the release");
    const forkOf = input.forkOf ?? (await this.current(tenant, extensionId).catch(() => undefined));
    return this.add(tenant, extensionId, files, { ...input, status: "draft", forkOf: forkOf ? refOf(forkOf) : undefined });
  }

  async propose(ref: ExtensionVersionRef): Promise<ExtensionVersion> {
    return this.store.updateStatus(ref, "draft", "proposed");
  }

  /**
   * Makes a proposed tenant version the one the tenant runs. The caller has already checked who approved it; the registry
   * only records that id. Older active versions of the same extension are retired.
   */
  async activate(ref: ExtensionVersionRef, approvedBy: string): Promise<ExtensionVersion> {
    if (!approvedBy) throw new RegistryRefusal("activation needs the approver the host checked");
    const activated = await this.store.updateStatus(ref, "proposed", "active", approvedBy);
    for (const other of await this.store.listVersions(ref.tenant, ref.extensionId)) {
      if (other.version !== ref.version && other.status === "active") await this.store.updateStatus(other, "active", "retired");
    }
    return activated;
  }

  async retire(ref: ExtensionVersionRef): Promise<ExtensionVersion> {
    return this.store.updateStatus(ref, "active", "retired");
  }

  async versions(tenant: string, extensionId?: string): Promise<ExtensionVersion[]> {
    return this.store.listVersions(checkTenant(tenant), extensionId);
  }

  /** The version a tenant runs for an extension when no routine pins one. */
  async current(tenant: string, extensionId: string): Promise<ExtensionVersion> {
    const own = newestActive(await this.store.listVersions(checkTenant(tenant), checkExtensionId(extensionId)));
    if (own) return own;
    const release = newestActive(await this.store.listVersions(RELEASE_TENANT, extensionId));
    if (!release) throw new RegistryRefusal(`no active version of ${extensionId} for ${tenant}`);
    return release;
  }

  async bind(binding: Omit<RoutineBinding, "updatedAt">): Promise<RoutineBinding> {
    checkTenant(binding.tenant);
    if (!ROUTINE_ID.test(binding.routineId)) throw new RegistryRefusal(`invalid routine id: ${binding.routineId}`);
    checkExtensionId(binding.extensionId);
    if (binding.pin) {
      if (binding.pin.tenant !== binding.tenant && binding.pin.tenant !== RELEASE_TENANT) throw new RegistryRefusal("a pin names the tenant's own copy or the release");
      const pinned = (await this.store.listVersions(binding.pin.tenant, binding.extensionId)).find((v) => v.version === binding.pin!.version);
      if (!pinned || pinned.status === "draft") throw new RegistryRefusal("a pin names an existing, non-draft version");
    }
    const row: RoutineBinding = { ...binding, updatedAt: this.now().toISOString() };
    await this.store.putBinding(row);
    return row;
  }

  /** Which version brand B runs for routine R. */
  async resolve(tenant: string, routineId: string): Promise<ResolvedExtension> {
    const binding = await this.store.getBinding(checkTenant(tenant), routineId);
    if (!binding) throw new RegistryRefusal(`no routine ${routineId} for ${tenant}`);
    if (!binding.enabled) throw new RegistryRefusal(`routine ${routineId} is off for ${tenant}`);
    if (binding.pin) {
      const pinned = (await this.store.listVersions(binding.pin.tenant, binding.extensionId)).find((v) => v.version === binding.pin!.version);
      if (!pinned || pinned.status === "draft") throw new RegistryRefusal(`pinned version of ${binding.extensionId} is missing`);
      return { binding, version: pinned, agentId: binding.agentId };
    }
    return { binding, version: await this.current(tenant, binding.extensionId), agentId: binding.agentId };
  }

  /** The files of a version, checked against its hash. */
  async files(ref: ExtensionVersionRef): Promise<ExtensionFiles> {
    const version = (await this.store.listVersions(ref.tenant, ref.extensionId)).find((v) => v.version === ref.version);
    if (!version) throw new RegistryRefusal("no such version");
    const files = await this.store.readFiles(ref);
    if (hashExtensionFiles(files) !== version.contentHash) throw new RegistryRefusal(`content of ${ref.extensionId}@${ref.tenant}/${ref.version} does not match its hash`);
    return files;
  }

  /**
   * Writes a version's files into a new directory, read-only (files 0444, directories 0555): the copy a sandbox run gets.
   * `target` must not exist. Returns the content hash written.
   */
  async materialize(ref: ExtensionVersionRef, target: string): Promise<string> {
    const files = await this.files(ref);
    fs.mkdirSync(target, { recursive: false, mode: 0o755 });
    const dirs = new Set<string>();
    for (const [file, content] of checkFiles(files)) {
      const destination = path.join(target, ...file.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      for (let dir = path.dirname(destination); dir !== target && dir.startsWith(target); dir = path.dirname(dir)) dirs.add(dir);
      const handle = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        fs.writeSync(handle, content);
      } finally {
        fs.closeSync(handle);
      }
      fs.chmodSync(destination, 0o444);
    }
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) fs.chmodSync(dir, 0o555);
    fs.chmodSync(target, 0o555);
    return hashExtensionFiles(files);
  }

  /** Records the version a run used; returns the pin. */
  async pinRun(input: { runId: string; tenant: string; routineId?: string; resolved: ResolvedExtension }): Promise<RunPin> {
    const pin: RunPin = {
      runId: input.runId,
      tenant: checkTenant(input.tenant),
      routineId: input.routineId,
      extensionId: input.resolved.version.extensionId,
      version: input.resolved.version.version,
      agentId: input.resolved.agentId,
      contentHash: input.resolved.version.contentHash,
      copyTenant: input.resolved.version.tenant,
      at: this.now().toISOString(),
    };
    await this.store.recordRunPin(pin);
    return pin;
  }

  async runPins(tenant: string, limit?: number): Promise<RunPin[]> {
    return this.store.listRunPins(checkTenant(tenant), limit);
  }

  private async add(
    tenant: string,
    extensionId: string,
    files: ExtensionFiles,
    input: { author: ExtensionAuthor; authorRef?: string; note?: string; status: ExtensionVersionStatus; forkOf?: ExtensionVersionRef },
  ): Promise<ExtensionVersion> {
    checkTenant(tenant);
    checkExtensionId(extensionId);
    const contentHash = hashExtensionFiles(files);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.store.listVersions(tenant, extensionId);
      const version: ExtensionVersion = {
        tenant,
        extensionId,
        version: existing.reduce((max, v) => Math.max(max, v.version), 0) + 1,
        author: input.author,
        ...(input.authorRef ? { authorRef: input.authorRef } : {}),
        ...(input.forkOf ? { forkOf: refOf(input.forkOf) } : {}),
        contentHash,
        createdAt: this.now().toISOString(),
        status: input.status,
        ...(input.note ? { note: input.note.slice(0, 500) } : {}),
      };
      try {
        await this.store.createVersion(version, files);
        return version;
      } catch (error) {
        if (!(error instanceof RegistryConflict)) throw error;
      }
    }
    throw new RegistryConflict(`could not allocate a version of ${extensionId} for ${tenant}`);
  }
}

function refOf(ref: ExtensionVersionRef): ExtensionVersionRef {
  return { tenant: ref.tenant, extensionId: ref.extensionId, version: ref.version };
}

function newestActive(versions: ExtensionVersion[]): ExtensionVersion | undefined {
  return versions.filter((v) => v.status === "active").sort((a, b) => b.version - a.version)[0];
}

// ── File store ─────────────────────────────────────────────

/**
 * Default store: `<root>/<tenant>/<encoded extension id>/<version>/{version.json,files/...}`, bindings in
 * `<root>/<tenant>/bindings/<routine>.json` and run pins appended to `<root>/<tenant>/runs.jsonl`. A version directory is
 * created with an exclusive mkdir, so two writers cannot get the same number. Status changes are compare-and-set inside
 * the process and atomic renames on disk.
 */
export class FileExtensionRegistryStore implements ExtensionRegistryStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  async listVersions(tenant: string, extensionId?: string): Promise<ExtensionVersion[]> {
    const tenantDir = path.join(this.root, checkTenant(tenant));
    const extensionDirs = extensionId ? [encodeId(checkExtensionId(extensionId))] : listDir(tenantDir).filter((name) => name.startsWith("x_"));
    const out: ExtensionVersion[] = [];
    for (const dir of extensionDirs) {
      for (const name of listDir(path.join(tenantDir, dir))) {
        if (!/^\d+$/.test(name)) continue;
        const file = path.join(tenantDir, dir, name, "version.json");
        if (fs.existsSync(file)) out.push(JSON.parse(fs.readFileSync(file, "utf8")) as ExtensionVersion);
      }
    }
    return out.sort((a, b) => (a.extensionId === b.extensionId ? a.version - b.version : a.extensionId < b.extensionId ? -1 : 1));
  }

  async createVersion(version: ExtensionVersion, files: ExtensionFiles): Promise<void> {
    const extensionDir = path.join(this.root, checkTenant(version.tenant), encodeId(checkExtensionId(version.extensionId)));
    fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
    const dir = path.join(extensionDir, String(version.version));
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RegistryConflict(`version ${version.version} exists`);
      throw error;
    }
    for (const [file, content] of checkFiles(files)) {
      const destination = path.join(dir, "files", ...file.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600, flag: "wx" });
    }
    writeAtomic(path.join(dir, "version.json"), JSON.stringify(version, null, 2));
  }

  updateStatus(ref: ExtensionVersionRef, expected: ExtensionVersionStatus, next: ExtensionVersionStatus, approvedBy?: string): Promise<ExtensionVersion> {
    return this.serial(async () => {
      const file = path.join(this.root, checkTenant(ref.tenant), encodeId(checkExtensionId(ref.extensionId)), String(ref.version), "version.json");
      if (!fs.existsSync(file)) throw new RegistryRefusal("no such version");
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as ExtensionVersion;
      if (current.status !== expected) throw new RegistryConflict(`version is ${current.status}, not ${expected}`);
      const updated: ExtensionVersion = { ...current, status: next, ...(approvedBy ? { approvedBy } : {}) };
      writeAtomic(file, JSON.stringify(updated, null, 2));
      return updated;
    });
  }

  async readFiles(ref: ExtensionVersionRef): Promise<ExtensionFiles> {
    const base = path.join(this.root, checkTenant(ref.tenant), encodeId(checkExtensionId(ref.extensionId)), String(ref.version), "files");
    const out: ExtensionFiles = {};
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) out[rel] = fs.readFileSync(path.join(dir, entry.name));
        else throw new RegistryRefusal(`unexpected entry in stored package: ${rel}`);
      }
    };
    walk(base, "");
    return out;
  }

  async getBinding(tenant: string, routineId: string): Promise<RoutineBinding | undefined> {
    const file = path.join(this.root, checkTenant(tenant), "bindings", `${routineId}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as RoutineBinding) : undefined;
  }

  async listBindings(tenant: string): Promise<RoutineBinding[]> {
    const dir = path.join(this.root, checkTenant(tenant), "bindings");
    return listDir(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RoutineBinding);
  }

  async putBinding(binding: RoutineBinding): Promise<void> {
    const dir = path.join(this.root, checkTenant(binding.tenant), "bindings");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(dir, `${binding.routineId}.json`), JSON.stringify(binding, null, 2));
  }

  async recordRunPin(pin: RunPin): Promise<void> {
    const dir = path.join(this.root, checkTenant(pin.tenant));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  }

  async listRunPins(tenant: string, limit = 100): Promise<RunPin[]> {
    const file = path.join(this.root, checkTenant(tenant), "runs.jsonl");
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as RunPin).reverse();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

function encodeId(id: string): string {
  return `x_${Buffer.from(id, "utf8").toString("base64url")}`;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
