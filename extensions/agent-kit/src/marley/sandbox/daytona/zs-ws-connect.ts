// ssh ProxyCommand for a Daytona sandbox: `ssh -o ProxyCommand='node zs-ws-connect.js --sandbox <id> --secret-file <path>' ...`.
// It mints a signed preview URL for the relay port (60 s), connects, sends the relay secret as the first text frame, then pipes
// stdin and stdout as binary frames. The signed URL is expired when the socket ends (expiring it earlier closes the socket). The URL and the secret never reach a log:
// every failure prints one fixed line.
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

import { SdkDaytonaClient } from "./client.js";

export const RELAY_PORT = 8080;
/** Daytona closes an open socket when its signed URL lapses or is expired, so the URL must outlive the longest session; it is expired when the socket ends. */
export const SIGNED_URL_SECONDS = 4 * 3600;
const HIGH_WATER = 1 << 20;

export interface ConnectDeps {
  /** A fresh signed URL (https, as Daytona returns it) and the call that expires it. */
  mint(): Promise<{ url: string; expire(): Promise<void> }>;
  secret: string;
  stdin: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  openTimeoutMs?: number;
}

/** The mint step of one connection: a signed URL valid `ttlSeconds` (default `SIGNED_URL_SECONDS`) and the call that expires it. */
export function signedUrlMinter(client: Pick<SdkDaytonaClient, "signedPreviewUrl" | "expireSignedPreviewUrl">, sandboxId: string, ttlSeconds?: number): ConnectDeps["mint"] {
  return async () => {
    const signed = await client.signedPreviewUrl(sandboxId, RELAY_PORT, ttlSeconds || SIGNED_URL_SECONDS);
    return { url: signed.url, expire: () => client.expireSignedPreviewUrl(sandboxId, RELAY_PORT, signed.token) };
  };
}

const wsUrl = (url: string): string => url.replace(/^http/, "ws");

/** Runs one connection and resolves with the process exit code. */
export async function runConnect(deps: ConnectDeps): Promise<number> {
  const fail = (reason: string): number => {
    deps.stderr.write(`zs-ws-connect: ${reason}\n`);
    return 1;
  };
  let minted: Awaited<ReturnType<ConnectDeps["mint"]>>;
  try {
    minted = await deps.mint();
  } catch {
    return fail("could not mint a signed preview URL");
  }
  const socket = new WebSocket(wsUrl(minted.url), { handshakeTimeout: deps.openTimeoutMs ?? 15_000, perMessageDeflate: false });
  return new Promise<number>((resolve) => {
    let opened = false;
    let done = false;
    let received = false;
    let localEnd = false;
    const finish = (code: number, reason?: string): void => {
      if (done) return;
      done = true;
      if (reason) deps.stderr.write(`zs-ws-connect: ${reason}\n`);
      deps.stdin.pause();
      try { socket.terminate(); } catch { /* already closed */ }
      void minted.expire().catch(() => undefined);
      resolve(code);
    };
    socket.on("open", () => {
      opened = true;
      socket.send(deps.secret);
      // Not expired here: Daytona's proxy closes an open socket when its signed URL is expired (live G4); it is expired when the socket ends.
      deps.stdin.on("data", (chunk: Buffer | string) => {
        socket.send(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { binary: true });
        if (socket.bufferedAmount > HIGH_WATER) {
          deps.stdin.pause();
          const poll = setInterval(() => {
            if (done || socket.bufferedAmount < HIGH_WATER / 4) {
              clearInterval(poll);
              deps.stdin.resume();
            }
          }, 10);
        }
      });
      deps.stdin.on("end", () => { localEnd = true; socket.close(); });
      deps.stdin.resume();
    });
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      received = true;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!deps.stdout.write(bytes)) socket.pause();
    });
    deps.stdout.on("drain", () => socket.resume());
    // A relay that closes before sending one byte refused the secret (or sshd is down): that is a failure, not a clean end.
    socket.on("close", () => (opened && (received || localEnd) ? finish(0) : finish(1, "relay refused the connection")));
    socket.on("error", () => finish(1, opened ? "relay connection failed" : "could not connect to the relay"));
  });
}

function argument(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const sandboxId = argument(argv, "--sandbox");
  const secretFile = argument(argv, "--secret-file");
  const keyFile = argument(argv, "--api-key-file");
  let apiKey = env.DAYTONA_API_KEY;
  if (keyFile) {
    try { apiKey = fs.readFileSync(keyFile, "utf8").trim(); } catch { process.stderr.write("zs-ws-connect: cannot read the API key file\n"); return 2; }
  }
  if (!sandboxId || !/^[A-Za-z0-9-]{1,64}$/.test(sandboxId) || !secretFile || !apiKey) {
    process.stderr.write("zs-ws-connect: missing --sandbox, --secret-file or an API key\n");
    return 2;
  }
  let secret: string;
  try {
    secret = fs.readFileSync(secretFile, "utf8").trim();
  } catch {
    process.stderr.write("zs-ws-connect: cannot read the relay secret\n");
    return 2;
  }
  const client = new SdkDaytonaClient({ apiKey, ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}) });
  return runConnect({
    secret,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    mint: signedUrlMinter(client, sandboxId, Number(argument(argv, "--url-ttl")) || undefined),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), () => {
    process.stderr.write("zs-ws-connect: failed\n");
    process.exit(1);
  });
}
