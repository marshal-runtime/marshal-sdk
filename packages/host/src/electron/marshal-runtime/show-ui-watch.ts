import { watch, type WatchOptions } from "node:fs";
import path from "node:path";

import { createLogger } from "../../common/marshal-logger";

const log = createLogger("ShowUiWatch");
const DEFAULT_DEBOUNCE_MS = 120;
const MAX_WATCHED_DIRECTORIES = 64;

interface Closable {
  close(): void;
  on(event: "error", listener: () => void): unknown;
}

type WatchFunction = (directory: string, options: WatchOptions, listener: () => void) => Closable;

export interface ShowUiSourceWatcherOptions {
  readonly debounceMs?: number;
  readonly watchFn?: WatchFunction;
  readonly recursive?: boolean;
}

/**
 * Pushes source edits of file-backed authored views to the open view: the
 * renderer's poll stays as the slow fallback, this makes the common case
 * immediate. A directory watch covers the entry file and the imports beside it.
 */
export class ShowUiSourceWatcher {
  private readonly tracked = new Map<
    string,
    { readonly watchers: Closable[]; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly debounceMs: number;
  private readonly watchFn: WatchFunction;
  private readonly recursive: boolean;

  constructor(
    private readonly onChange: (instanceId: string) => void,
    options: ShowUiSourceWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.watchFn =
      options.watchFn ??
      ((directory, watchOptions, listener) => watch(directory, watchOptions, listener));
    this.recursive = options.recursive ?? process.platform !== "linux";
  }

  /** Replaces what the view watches; call again after each refresh. */
  track(instanceId: string, files: readonly string[]): void {
    this.untrack(instanceId);
    const directories = [...new Set(files.map((file) => path.dirname(file)))].slice(
      0,
      MAX_WATCHED_DIRECTORIES,
    );
    const entry: { watchers: Closable[]; timer?: ReturnType<typeof setTimeout> } = {
      watchers: [],
    };
    for (const directory of directories) {
      try {
        const watcher = this.watchFn(
          directory,
          { persistent: false, recursive: this.recursive },
          () => this.schedule(instanceId),
        );
        watcher.on("error", () => watcher.close());
        entry.watchers.push(watcher);
      } catch (error) {
        log.warn(
          `Source watch unavailable; the poll refresh still applies (${error instanceof Error ? error.name : "error"})`,
        );
      }
    }
    if (entry.watchers.length > 0) this.tracked.set(instanceId, entry);
  }

  untrack(instanceId: string): void {
    const entry = this.tracked.get(instanceId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const watcher of entry.watchers) watcher.close();
    this.tracked.delete(instanceId);
  }

  isTracking(instanceId: string): boolean {
    return this.tracked.has(instanceId);
  }

  dispose(): void {
    for (const instanceId of [...this.tracked.keys()]) this.untrack(instanceId);
  }

  private schedule(instanceId: string): void {
    const entry = this.tracked.get(instanceId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.onChange(instanceId);
    }, this.debounceMs);
    entry.timer.unref?.();
  }
}
