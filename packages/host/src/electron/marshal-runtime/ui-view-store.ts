import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeUiInstance } from "../../common/runtime-ui";
import type { RuntimeUiDesktopLayout } from "../../common/runtime-ui-layout";
import { secureAtomicWriteFileSync } from "../platform-security";

const STORE_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** One session's persisted views and desktop arrangement. */
export interface StoredSessionViews {
  readonly version: typeof STORE_VERSION;
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly updatedAt: string;
  readonly instances: readonly RuntimeUiInstance[];
  readonly desktop?: RuntimeUiDesktopLayout;
}

/**
 * Per-machine store of each session's docked tabs, permanent cards, and
 * desktop layout (one small JSON file per session). Transient cards are never
 * written. Session content itself stays in the session store.
 */
export class RuntimeUiViewStore {
  constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
  ) {}

  read(sessionId: string): StoredSessionViews | undefined {
    return this.readFile(this.fileFor(sessionId));
  }

  writeInstances(
    sessionId: string,
    workspaceName: string,
    instances: readonly RuntimeUiInstance[],
  ): void {
    const previous = this.read(sessionId);
    if (instances.length === 0 && !previous?.desktop) {
      this.remove(sessionId);
      return;
    }
    this.write({
      ...(previous?.desktop ? { desktop: previous.desktop } : {}),
      version: STORE_VERSION,
      sessionId,
      workspaceName,
      updatedAt: new Date(this.clock()).toISOString(),
      instances: instances.filter((instance) => !instance.transient),
    });
  }

  writeDesktopLayout(
    sessionId: string,
    workspaceName: string,
    desktop: RuntimeUiDesktopLayout,
  ): void {
    const previous = this.read(sessionId);
    this.write({
      version: STORE_VERSION,
      sessionId,
      workspaceName,
      updatedAt: new Date(this.clock()).toISOString(),
      instances: previous?.instances ?? [],
      desktop,
    });
  }

  /** Recently updated sessions, newest first; older files are pruned. */
  recent(limit: number, maxAgeMs: number): StoredSessionViews[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.root).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const cutoff = this.clock() - maxAgeMs;
    const files: { readonly file: string; readonly mtime: number }[] = [];
    for (const name of names) {
      const file = path.join(this.root, name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime < cutoff) fs.rmSync(file, { force: true });
        else files.push({ file, mtime });
      } catch {
        // A file that disappears or cannot be read is skipped.
      }
    }
    return files
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, limit)
      .flatMap(({ file }) => this.readFile(file) ?? []);
  }

  remove(sessionId: string): void {
    fs.rmSync(this.fileFor(sessionId), { force: true });
  }

  private write(record: StoredSessionViews): void {
    secureAtomicWriteFileSync(this.fileFor(record.sessionId), JSON.stringify(record), {
      mode: 0o600,
    });
  }

  private fileFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
    return path.join(this.root, `${digest}.json`);
  }

  private readFile(file: string): StoredSessionViews | undefined {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isStoredSessionViews(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape check only; every restored instance is re-validated by the controller
 * and every layout is replayed defensively by the renderer.
 */
function isStoredSessionViews(value: unknown): value is StoredSessionViews {
  if (!isRecord(value)) return false;
  if (value.version !== STORE_VERSION) return false;
  if (typeof value.sessionId !== "string" || typeof value.workspaceName !== "string") return false;
  if (!Array.isArray(value.instances) || !value.instances.every(isRecord)) return false;
  if (value.desktop !== undefined) {
    const desktop = value.desktop;
    if (!isRecord(desktop) || !isRecord(desktop.dockview) || !isRecord(desktop.summary)) {
      return false;
    }
    if (!Array.isArray(desktop.summary.placements)) return false;
  }
  return true;
}

const LEDGER_VERSION = 1;
export const MAX_VIEW_REVISIONS = 20;
const MAX_LEDGER_INSTANCES = 100;
const MAX_REVISION_TEXT = 600;

export type UiViewRevisionStatus = "live" | "superseded" | "failed";

/** One state of an agent-authored view: a render that was (or tried to be) shown. */
export interface UiViewRevision {
  readonly revisionId: string;
  readonly createdAt: string;
  readonly status: UiViewRevisionStatus;
  readonly title: string;
  /** Present for any revision whose render exists, so it can be rolled back to. */
  readonly renderId?: string;
  readonly failure?: { readonly stage: string; readonly message: string };
}

interface StoredLedger {
  readonly version: typeof LEDGER_VERSION;
  readonly sessionId: string;
  readonly updatedAt: string;
  readonly instances: Readonly<Record<string, readonly UiViewRevision[]>>;
}

/**
 * Per-instance revision history for agent-authored views (max 20 each), one
 * small JSON file per session beside the view store. A refresh is a candidate:
 * the ledger records what became live and what failed, so a failed candidate
 * never replaces a working revision and the agent can roll back.
 */
export class RuntimeUiRevisionLedger {
  constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
  ) {}

  list(sessionId: string, instanceId: string): readonly UiViewRevision[] {
    return this.read(sessionId)?.instances[instanceId] ?? [];
  }

  /** The newest revision still showing. */
  live(sessionId: string, instanceId: string): UiViewRevision | undefined {
    return [...this.list(sessionId, instanceId)].reverse().find((entry) => entry.status === "live");
  }

  /**
   * Records a revision. A live revision supersedes the previous live one; a
   * failed candidate leaves the live revision untouched.
   */
  append(
    sessionId: string,
    instanceId: string,
    revision: Omit<UiViewRevision, "revisionId" | "createdAt">,
  ): UiViewRevision {
    const ledger = this.read(sessionId);
    const existing = ledger?.instances[instanceId] ?? [];
    const nextNumber = existing.reduce((max, entry) => Math.max(max, revisionNumber(entry)), 0) + 1;
    const created: UiViewRevision = {
      ...revision,
      title: revision.title.slice(0, MAX_REVISION_TEXT),
      ...(revision.failure
        ? {
            failure: {
              stage: revision.failure.stage,
              message: revision.failure.message.slice(0, MAX_REVISION_TEXT),
            },
          }
        : {}),
      revisionId: `r${nextNumber}`,
      createdAt: new Date(this.clock()).toISOString(),
    };
    const settled =
      created.status === "live"
        ? existing.map((entry) =>
            entry.status === "live" ? { ...entry, status: "superseded" as const } : entry,
          )
        : [...existing];
    this.write(sessionId, instanceId, ledger, [...settled, created].slice(-MAX_VIEW_REVISIONS));
    return created;
  }

  /** Makes an existing revision the live one (rollback), superseding the current live one. */
  markLive(sessionId: string, instanceId: string, revisionId: string): void {
    const ledger = this.read(sessionId);
    const existing = ledger?.instances[instanceId] ?? [];
    if (!existing.some((entry) => entry.revisionId === revisionId)) return;
    this.write(
      sessionId,
      instanceId,
      ledger,
      existing.map((entry) => {
        if (entry.revisionId === revisionId) return { ...entry, status: "live" as const };
        return entry.status === "live" ? { ...entry, status: "superseded" as const } : entry;
      }),
    );
  }

  remove(sessionId: string): void {
    fs.rmSync(this.fileFor(sessionId), { force: true });
  }

  private write(
    sessionId: string,
    instanceId: string,
    ledger: StoredLedger | undefined,
    revisions: readonly UiViewRevision[],
  ): void {
    const instances = { ...ledger?.instances, [instanceId]: revisions };
    const ids = Object.keys(instances);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_LEDGER_INSTANCES))) {
      delete instances[id];
    }
    const record: StoredLedger = {
      version: LEDGER_VERSION,
      sessionId,
      updatedAt: new Date(this.clock()).toISOString(),
      instances,
    };
    secureAtomicWriteFileSync(this.fileFor(sessionId), JSON.stringify(record), { mode: 0o600 });
  }

  private read(sessionId: string): StoredLedger | undefined {
    const file = this.fileFor(sessionId);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return isRecord(parsed) &&
        parsed.version === LEDGER_VERSION &&
        parsed.sessionId === sessionId &&
        isRecord(parsed.instances)
        ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- version, session and instances shape checked above; revisions are only read field by field
          (parsed as unknown as StoredLedger)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private fileFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
    return path.join(this.root, `${digest}.json`);
  }
}

function revisionNumber(revision: UiViewRevision): number {
  const parsed = Number.parseInt(revision.revisionId.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
