import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ANTIGRAVITY_BRIDGE_SOURCE } from "./bridge-source";
import {
  ANTIGRAVITY_PYTHON_ENV,
  ANTIGRAVITY_PYTHON_VERSION,
  ANTIGRAVITY_SDK_PACKAGE,
  ANTIGRAVITY_SDK_VERSION,
  type AntigravityProcessEnv,
} from "./constants";

const run = promisify(execFile);
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MARKER_FILENAME = ".marshal-antigravity-sdk";

export interface AntigravityPythonEnvironment {
  /** The interpreter that has the SDK installed. */
  python: string;
  /** The bridge script, written next to the environment. */
  bridgePath: string;
}

export interface AntigravityEnvironmentOptions {
  /** Folder that holds the venv and the bridge script (`<app data>/antigravity`). */
  homeDir: string;
  env?: AntigravityProcessEnv;
  /** Progress lines while the SDK is installed for the first time. */
  onProgress?: (message: string) => void;
}

const preparing = new Map<string, Promise<AntigravityPythonEnvironment>>();

export function defaultAntigravityHome(appDataDir?: string): string {
  return path.join(appDataDir ?? path.join(homedir(), ".marshal"), "antigravity");
}

function venvPython(venvDir: string): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeBridge(homeDir: string): Promise<string> {
  const digest = createHash("sha256").update(ANTIGRAVITY_BRIDGE_SOURCE).digest("hex").slice(0, 12);
  const bridgePath = path.join(homeDir, `bridge-${digest}.py`);
  if (!(await exists(bridgePath))) {
    await mkdir(homeDir, { recursive: true });
    const temporary = `${bridgePath}.${process.pid}.tmp`;
    await writeFile(temporary, ANTIGRAVITY_BRIDGE_SOURCE, { mode: 0o644 });
    await rename(temporary, bridgePath);
  }
  return bridgePath;
}

async function findExecutable(
  candidates: readonly string[],
  versionArgs: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- candidates are probed in priority order
      await run(candidate, [...versionArgs], { windowsHide: true, timeout: 20_000 });
      return candidate;
    } catch {
      // Not installed here; try the next location.
    }
  }
  return undefined;
}

function uvCandidates(env: AntigravityProcessEnv): string[] {
  const home = env["HOME"] ?? homedir();
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  return [
    exe,
    path.join(home, ".local", "bin", exe),
    path.join(home, ".cargo", "bin", exe),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ];
}

async function pythonAtLeast310(python: string): Promise<boolean> {
  try {
    await run(python, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], {
      windowsHide: true,
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasSdk(python: string): Promise<boolean> {
  try {
    await run(python, ["-I", "-c", "import google.antigravity"], {
      windowsHide: true,
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function install(options: AntigravityEnvironmentOptions): Promise<string> {
  const env = options.env ?? process.env;
  const venvDir = path.join(options.homeDir, "venv");
  const python = venvPython(venvDir);
  const marker = path.join(venvDir, MARKER_FILENAME);
  const wanted = `${ANTIGRAVITY_SDK_PACKAGE}==${ANTIGRAVITY_SDK_VERSION}`;
  if ((await exists(python)) && (await readFile(marker, "utf8").catch(() => "")) === wanted) {
    return python;
  }
  await mkdir(options.homeDir, { recursive: true });
  const childEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  const uv = await findExecutable(uvCandidates(env), ["--version"]);
  options.onProgress?.(`Installing ${wanted} for Antigravity (first use only)`);
  if (uv) {
    if (!(await exists(python))) {
      await run(uv, ["venv", "--quiet", "--python", ANTIGRAVITY_PYTHON_VERSION, venvDir], {
        windowsHide: true,
        timeout: INSTALL_TIMEOUT_MS,
        env: childEnv,
      });
    }
    await run(uv, ["pip", "install", "--quiet", "--python", python, wanted], {
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      env: childEnv,
    });
  } else {
    const system = await findExecutable(
      process.platform === "win32"
        ? ["py", "python"]
        : ["python3.13", "python3.12", "python3.11", "python3.10", "python3"],
      ["--version"],
    );
    if (!system || !(await pythonAtLeast310(system))) {
      throw new Error(
        "Antigravity needs Python 3.10 or newer, or uv (https://docs.astral.sh/uv/). Install one of them, then try again.",
      );
    }
    if (await exists(venvDir)) await rm(venvDir, { recursive: true, force: true });
    await run(system, ["-m", "venv", venvDir], {
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      env: childEnv,
    });
    await run(python, ["-m", "pip", "install", "--quiet", wanted], {
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      env: childEnv,
    });
  }
  await writeFile(marker, wanted);
  return python;
}

async function prepare(options: AntigravityEnvironmentOptions): Promise<AntigravityPythonEnvironment> {
  const env = options.env ?? process.env;
  const bridgePath = await writeBridge(options.homeDir);
  const prepared = env[ANTIGRAVITY_PYTHON_ENV]?.trim();
  if (prepared) {
    if (!(await hasSdk(prepared))) {
      throw new Error(
        `${ANTIGRAVITY_PYTHON_ENV}=${prepared} cannot import google.antigravity. Install ${ANTIGRAVITY_SDK_PACKAGE} into it, or unset the variable so Marshal installs it.`,
      );
    }
    return { python: prepared, bridgePath };
  }
  return { python: await install(options), bridgePath };
}

/**
 * The Python environment the bridge runs in: a private venv with the pinned
 * SDK under `homeDir`, created on first use (uv when present, else a system
 * Python 3.10+). Concurrent callers share one preparation.
 */
export function ensureAntigravityEnvironment(
  options: AntigravityEnvironmentOptions,
): Promise<AntigravityPythonEnvironment> {
  const key = path.resolve(options.homeDir);
  const existing = preparing.get(key);
  if (existing) return existing;
  const pending = prepare(options).catch((error: unknown) => {
    preparing.delete(key);
    throw error;
  });
  preparing.set(key, pending);
  return pending;
}
