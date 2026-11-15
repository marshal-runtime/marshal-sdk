import http from "node:http";
import type { AddressInfo } from "node:net";

export interface OrgLoopbackCallback {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects with an OrgLoopbackError. */
  result: Promise<string>;
  close(): void;
}

const PAGE_OK =
  "<!doctype html><meta charset=utf-8><title>Marshal</title><p>Signed in. You can close this tab and return to Marshal.</p>";
const PAGE_FAIL =
  "<!doctype html><meta charset=utf-8><title>Marshal</title><p>Sign-in did not complete. You can close this tab and try again in Marshal.</p>";

export class OrgLoopbackError extends Error {
  constructor(readonly code: "timeout" | "denied" | "missing-code" | "closed") {
    super(`organization sign-in callback failed: ${code}`);
    this.name = "OrgLoopbackError";
  }
}

/**
 * One-shot HTTP server on 127.0.0.1 (random port, `/callback`). It accepts exactly one valid
 * callback carrying the expected `state`, then closes. Requests with a wrong state are rejected
 * without ending the wait so a stray local request cannot cancel a sign-in.
 */
export async function startOrgLoopback(options: {
  expectedState: string;
  timeoutMs: number;
}): Promise<OrgLoopbackCallback> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: OrgLoopbackError) => void = () => undefined;
  const result = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  result.catch(() => undefined);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (url.searchParams.get("state") !== options.expectedState) {
      res.writeHead(400, { "content-type": "text/plain" }).end("state mismatch");
      return;
    }
    const code = url.searchParams.get("code");
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    };
    if (url.searchParams.get("error")) {
      res.writeHead(200, headers).end(PAGE_FAIL);
      rejectCode(new OrgLoopbackError("denied"));
    } else if (!code) {
      res.writeHead(200, headers).end(PAGE_FAIL);
      rejectCode(new OrgLoopbackError("missing-code"));
    } else {
      res.writeHead(200, headers).end(PAGE_OK);
      resolveCode(code);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.on("error", () => rejectCode(new OrgLoopbackError("closed")));
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- listening on a TCP port returns AddressInfo
  const { port } = server.address() as AddressInfo;

  const timer = setTimeout(() => rejectCode(new OrgLoopbackError("timeout")), options.timeoutMs);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    rejectCode(new OrgLoopbackError("closed"));
    server.close();
    server.closeIdleConnections();
    // Lets the callback page finish flushing before any lingering keep-alive socket is dropped.
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  };
  void result.then(close, close);

  return { redirectUri: `http://127.0.0.1:${port}/callback`, result, close };
}
