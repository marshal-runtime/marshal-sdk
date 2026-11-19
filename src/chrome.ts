// A Chrome for a run whose agent declares the `browser` port: found once by the host, probed over its DevTools pipe,
// and handed to the agent (and its extension's own browser code) through MARSHAL_SDK_CHROME and
// MARSHAL_SDK_CHROME_LAUNCHER (a wrapper adding the flags this machine needs).
import fs from "node:fs";
import path from "node:path";

export const NO_CHROME_WARNING =
  "no Chrome or Playwright Chromium found: the agent's renders and screenshots will fail. Install one (npx playwright install chromium chromium-headless-shell) or set MARSHAL_SDK_CHROME.";

/**
 * The first Chrome that answers the DevTools pipe: $MARSHAL_SDK_CHROME, Playwright's installed Chromium, else the
 * system's. Found 2026-11-15: Playwright's "Google Chrome for Testing" on macOS starts but never answers the pipe, so
 * every look waited out its kill timer; a given path is trusted, the others are probed.
 */
export async function resolveChrome(env: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> {
  const given = env.MARSHAL_SDK_CHROME;
  // "none": no browser on this host (tests).
  if (given === "none") return undefined;
  if (given) return given;
  const candidates: string[] = [];
  try {
    const { chromium } = await import("playwright-core");
    candidates.push(chromium.executablePath());
  } catch {
    // Playwright has no Chromium installed for this platform.
  }
  if (process.platform === "darwin") candidates.unshift("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  if (process.platform === "linux") candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable");
  const present = candidates.filter((candidate) => candidate && fs.existsSync(candidate));
  for (const candidate of present) if (await answersPipe(candidate)) return candidate;
  return present[0];
}

export async function answersPipe(chrome: string, timeoutMs = 10_000): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-sdk-chrome-"));
  const flags = [...chromeFlags(), "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"];
  const child = spawn(chrome, flags, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const [toChrome, fromChrome] = [child.stdio[3], child.stdio[4]] as [NodeJS.WritableStream, NodeJS.ReadableStream];
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("error", () => resolve(false));
      child.once("exit", () => resolve(false));
      // A killed Chrome can reset its pipe; unhandled, that 'error' ends the whole run (Coder build 900023).
      fromChrome.on("error", () => resolve(false));
      (toChrome as NodeJS.WritableStream & { on: (event: "error", fn: () => void) => unknown }).on("error", () => resolve(false));
      fromChrome.once("data", () => {
        clearTimeout(timer);
        resolve(true);
      });
      toChrome.write(`${JSON.stringify({ id: 1, method: "Browser.getVersion" })}\0`);
    });
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve(undefined)));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The flags every Chrome this host starts needs. --no-sandbox as root on Linux or with MARSHAL_SDK_CHROME_NO_SANDBOX=1:
 * Chrome refuses to run as root with its sandbox (Coder runs as root), and a container without user namespaces has no
 * sandbox. --disable-dev-shm-usage on Linux: containers often have a 64 MB /dev/shm, on which Chrome dies mid-render
 * (Coder builds 900005/900006 lost their look rounds to "the browser closed").
 */
export function chromeFlags(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string[] {
  if (platform === "win32") return [];
  const noSandbox = env.MARSHAL_SDK_CHROME_NO_SANDBOX === "1" || (platform === "linux" && uid === 0);
  return [...(noSandbox ? ["--no-sandbox"] : []), ...(platform === "linux" ? ["--disable-dev-shm-usage"] : [])];
}

/** A wrapper script that starts Chrome with chromeFlags(), for code that starts Chrome itself; the path as is without flags. */
export function chromeWrapper(chrome: string, state: string, flags: readonly string[] = chromeFlags()): string {
  if (!flags.length || process.platform === "win32") return chrome;
  const wrapper = path.join(state, "chrome-no-sandbox.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${chrome.replaceAll("'", "'\\''")}' ${flags.join(" ")} "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/**
 * The browser variables a run sets. A value the host already set is kept as it is: on 2026-11-16 a run replaced
 * Coder's own Chrome wrapper with one that lacked --disable-dev-shm-usage, and the renders crashed.
 */
export function browserEnv(
  chrome: string,
  state: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  flags: readonly string[] = chromeFlags(),
): { MARSHAL_SDK_CHROME: string; MARSHAL_SDK_CHROME_LAUNCHER: string } {
  return {
    MARSHAL_SDK_CHROME: env.MARSHAL_SDK_CHROME || chrome,
    MARSHAL_SDK_CHROME_LAUNCHER: env.MARSHAL_SDK_CHROME_LAUNCHER || chromeWrapper(chrome, state, flags),
  };
}
