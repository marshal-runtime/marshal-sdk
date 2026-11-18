import { randomUUID } from "node:crypto";
import { watch, type WatchOptions } from "node:fs";
import path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import type { MarshalRuntimeScope } from "./contracts";

const log = createLogger("LocalExtensionHotReload");
const DEFAULT_DEBOUNCE_MS = 500;
const IGNORED_SEGMENTS = new Set(["node_modules", ".git", ".DS_Store"]);

interface Closable {
  close(): void;
  on(event: "error", listener: () => void): unknown;
}

type WatchFunction = (
  directory: string,
  options: WatchOptions,
  listener: (event: string, filename: string | null) => void,
) => Closable;

export interface LocalExtensionWatchEntry {
  readonly identity: string;
  readonly sourceRoot: string;
  /** The session that installed it; absent for watches restored after a restart. */
  readonly scope?: MarshalRuntimeScope;
}

export type LocalExtensionReloadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface LocalExtensionHotReloadOptions {
  /** Runs the transactional update; a failure leaves the previous version live. */
  readonly update: (
    entry: LocalExtensionWatchEntry,
    idempotencyKey: string,
  ) => Promise<LocalExtensionReloadOutcome>;
  /** Read per change so the setting takes effect without re-installing. */
  readonly enabled: () => boolean;
  readonly onResult?: (
    entry: LocalExtensionWatchEntry,
    outcome: LocalExtensionReloadOutcome,
  ) => void;
  readonly debounceMs?: number;
  readonly watchFn?: WatchFunction;
  readonly recursive?: boolean;
}

interface Tracked {
  readonly entry: LocalExtensionWatchEntry;
  readonly watcher: Closable;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  dirty: boolean;
}

/**
 * Re-runs the transactional extension update when a locally installed
 * extension's source directory changes. Changes are debounced and updates for
 * one extension never overlap: edits that land mid-update trigger one more run.
 */
export class LocalExtensionHotReload {
  private readonly tracked = new Map<string, Tracked>();
  private readonly debounceMs: number;
  private readonly watchFn: WatchFunction;
  private readonly recursive: boolean;

  constructor(private readonly options: LocalExtensionHotReloadOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.watchFn =
      options.watchFn ??
      ((directory, watchOptions, listener) =>
        watch(directory, watchOptions, (event, filename) =>
          listener(event, typeof filename === "string" ? filename : null),
        ));
    this.recursive = options.recursive ?? process.platform !== "linux";
  }

  /** Starts (or restarts) watching an extension's source directory; always on for local installs. */
  watch(entry: LocalExtensionWatchEntry): void {
    this.unwatch(entry.identity);
    const sourceRoot = path.resolve(entry.sourceRoot);
    let watcher: Closable;
    const tracked: Omit<Tracked, "watcher"> = {
      entry: { ...entry, sourceRoot },
      running: false,
      dirty: false,
    };
    try {
      watcher = this.watchFn(
        sourceRoot,
        { persistent: false, recursive: this.recursive },
        (_event, filename) => {
          if (isIgnored(filename)) return;
          this.schedule(entry.identity);
        },
      );
      watcher.on("error", () => this.unwatch(entry.identity));
    } catch (error) {
      log.warn(
        `Cannot watch a local extension directory; use runtimeUpdateExtension (${error instanceof Error ? error.name : "error"})`,
      );
      return;
    }
    this.tracked.set(entry.identity, { ...tracked, watcher });
  }

  unwatch(identity: string): void {
    const tracked = this.tracked.get(identity);
    if (!tracked) return;
    if (tracked.timer) clearTimeout(tracked.timer);
    tracked.watcher.close();
    this.tracked.delete(identity);
  }

  isWatching(identity: string): boolean {
    return this.tracked.has(identity);
  }

  dispose(): void {
    for (const identity of [...this.tracked.keys()]) this.unwatch(identity);
  }

  private schedule(identity: string): void {
    const tracked = this.tracked.get(identity);
    if (!tracked) return;
    if (tracked.running) {
      tracked.dirty = true;
      return;
    }
    if (tracked.timer) clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => void this.run(identity), this.debounceMs);
    tracked.timer.unref?.();
  }

  private async run(identity: string): Promise<void> {
    const tracked = this.tracked.get(identity);
    if (!tracked) return;
    tracked.timer = undefined;
    if (!this.options.enabled()) return;
    tracked.running = true;
    let outcome: LocalExtensionReloadOutcome;
    try {
      outcome = await this.options.update(tracked.entry, `local-extension-reload:${randomUUID()}`);
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : "Update failed." };
    }
    tracked.running = false;
    if (outcome.ok) log.info("Reloaded a locally installed extension after a source change");
    else
      log.warn(
        `Local extension reload failed; the previous version stays active: ${outcome.message}`,
      );
    this.options.onResult?.(tracked.entry, outcome);
    if (tracked.dirty && this.tracked.get(identity) === tracked) {
      tracked.dirty = false;
      this.schedule(identity);
    }
  }
}

function isIgnored(filename: string | null): boolean {
  if (!filename) return false;
  return filename.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}
