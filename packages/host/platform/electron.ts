// The host source is shared with the desktop, where `electron` is the real module. Outside Electron the SDK
// resolves `electron` to this file: the few app facts the host reads come from configureHostPlatform().
import os from "node:os";
import path from "node:path";

export interface HostPlatform {
  /** Folders by Electron's names: userData, temp, documents, home, appData, logs. */
  readonly paths?: Partial<Record<string, string>>;
  readonly isPackaged?: boolean;
  readonly version?: string;
  readonly name?: string;
}

let platform: HostPlatform = {};

export function configureHostPlatform(next: HostPlatform): void {
  platform = { ...platform, ...next, paths: { ...platform.paths, ...next.paths } };
}

function defaultPath(name: string): string {
  const home = os.homedir();
  switch (name) {
    case "home":
      return home;
    case "temp":
      return os.tmpdir();
    case "documents":
      return path.join(home, "Documents");
    case "appData":
      return process.platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".config");
    case "userData":
      return path.join(home, ".marshal");
    case "logs":
      return path.join(home, ".marshal", "logs");
    default:
      throw new Error(`host platform has no path named ${name}`);
  }
}

export const app = {
  get isPackaged(): boolean {
    return platform.isPackaged ?? false;
  },
  getPath(name: string): string {
    return platform.paths?.[name] ?? defaultPath(name);
  },
  getVersion(): string {
    return platform.version ?? "0.0.0";
  },
  getName(): string {
    return platform.name ?? "Marshal";
  },
};

export interface BrowserWindow {
  readonly webContents: { send(channel: string, ...args: unknown[]): void };
  isDestroyed(): boolean;
}
