import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";

const STEP_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_BYTES = 4_000;

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

export interface BuildPlan {
  readonly packageManager: PackageManager;
  /** Directory dependencies are installed in: the nearest one with a lockfile, else the package. */
  readonly installRoot: string;
  readonly hasLockfile: boolean;
  /** The manifest declares an installation script, which the runtime runs on its own copy. */
  readonly declaresInstallation: boolean;
  /** False when the manifest declares its own installation script (the runtime runs it) or there is no build script. */
  readonly runBuild: boolean;
  readonly installDependencies: boolean;
}

export interface CommandRunner {
  (
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<{ exitCode: number | null; output: string }>;
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Decides how to build a package found at packageRoot inside a checkout rooted at repoRoot. */
export async function planPackageBuild(packageRoot: string, repoRoot: string): Promise<BuildPlan> {
  const manifest = await readJson(path.join(packageRoot, "runtime-extension.json"));
  const packageJson = await readJson(path.join(packageRoot, "package.json"));
  const scripts = packageJson?.scripts;
  const hasBuildScript =
    scripts !== null &&
    typeof scripts === "object" &&
    typeof Reflect.get(scripts, "build") === "string";
  const declaresInstallation = manifest?.installation !== undefined;

  let directory = packageRoot;
  const stop = path.resolve(repoRoot);
  for (;;) {
    for (const [lockfile, packageManager] of LOCKFILES) {
      // eslint-disable-next-line no-await-in-loop -- lockfile precedence is ordered
      if (await exists(path.join(directory, lockfile))) {
        return {
          packageManager,
          installRoot: directory,
          hasLockfile: true,
          declaresInstallation,
          runBuild: hasBuildScript && !declaresInstallation,
          installDependencies: !declaresInstallation,
        };
      }
    }
    const parent = path.dirname(directory);
    if (path.resolve(directory) === stop || parent === directory) break;
    directory = parent;
  }
  const hasDependencies = ["dependencies", "devDependencies"].some((key) => {
    const value = packageJson?.[key];
    return value !== null && typeof value === "object" && Object.keys(value).length > 0;
  });
  return {
    packageManager: "npm",
    installRoot: packageRoot,
    hasLockfile: false,
    declaresInstallation,
    runBuild: hasBuildScript && !declaresInstallation,
    installDependencies: !declaresInstallation && hasBuildScript && hasDependencies,
  };
}

function installArguments(plan: BuildPlan): string[] {
  if (!plan.hasLockfile) return ["install"];
  switch (plan.packageManager) {
    case "npm":
      return ["ci"];
    case "pnpm":
    case "yarn":
    case "bun":
      return ["install", "--frozen-lockfile"];
    default:
      throw new Error(`Unsupported package manager: ${String(plan.packageManager)}`);
  }
}

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // Package managers are .cmd shims on Windows; arguments here are fixed, never user text.
      shell: process.platform === "win32",
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output });
    });
  });

export class PackageBuildError extends Error {
  constructor(
    message: string,
    readonly outputTail: string,
  ) {
    super(message);
    this.name = "PackageBuildError";
  }
}

/** Installs dependencies and runs the package's build script, as the plan says. */
export async function buildPackage(
  packageRoot: string,
  plan: BuildPlan,
  run: CommandRunner = runCommand,
): Promise<void> {
  const steps: { cwd: string; args: string[]; label: string }[] = [];
  if (plan.installDependencies) {
    steps.push({ cwd: plan.installRoot, args: installArguments(plan), label: "install" });
  }
  if (plan.runBuild) steps.push({ cwd: packageRoot, args: ["run", "build"], label: "build" });
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop -- install must finish before build
    const result = await run(plan.packageManager, step.args, {
      cwd: step.cwd,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new PackageBuildError(
        `${plan.packageManager} ${step.args.join(" ")} failed (exit ${String(result.exitCode)}).`,
        result.output,
      );
    }
  }
}

/** Reads identity and entrypoint from a package's runtime-extension.json. */
export async function readExtensionManifest(
  packageRoot: string,
): Promise<{ identity: string; version?: string; entrypoint?: string } | undefined> {
  const manifest = await readJson(path.join(packageRoot, "runtime-extension.json"));
  const identity = manifest?.identity;
  if (typeof identity !== "string") return undefined;
  const version = manifest?.version;
  const entrypoint = manifest?.entrypoint;
  return {
    identity,
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof entrypoint === "string" ? { entrypoint } : {}),
  };
}
