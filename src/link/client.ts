// A client for the link (docs/link.md) on node's http/https, so it also runs inside a Marshal extension.
import http from "node:http";
import https from "node:https";

export class LinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LinkClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

export interface LinkStream {
  close(): void;
  /** Resolves when the stream ends (closed, or the host went away). */
  done: Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined | readonly string[]>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class LinkClient {
  private readonly base: URL;

  constructor(private readonly options: LinkClientOptions) {
    this.base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
    if (this.base.protocol !== "http:" && this.base.protocol !== "https:") throw new Error("A link URL is http or https.");
  }

  private target(path: string, query: Query = {}): URL {
    const url = new URL(`v1/${path}`, this.base);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  private raw(method: "GET" | "POST", path: string, query: Query, body: unknown, timeoutMs: number | undefined, accept: string): Promise<{ status: number; bytes: Buffer }> {
    const url = this.target(path, query);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === "https:" ? https : http;
    const timeout = timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept,
            ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          },
          timeout,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
          response.on("error", reject);
        },
      );
      request.on("timeout", () => request.destroy(new LinkError(0, "timeout", `The host did not answer within ${Math.round(timeout / 1000)}s.`)));
      request.on("error", (error: Error & { code?: string }) =>
        reject(error instanceof LinkError ? error : new LinkError(0, "unreachable", `Can't reach the host: ${error.code ?? error.message}.`)),
      );
      if (payload) request.write(payload);
      request.end();
    });
  }

  async request<T = any>(method: "GET" | "POST", path: string, query: Query = {}, body?: unknown, timeoutMs?: number): Promise<T> {
    const { status, bytes } = await this.raw(method, path, query, body, timeoutMs, "application/json");
    const text = bytes.toString("utf8");
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new LinkError(status, "bad-response", `The host answered ${status} with something that is not JSON.`);
    }
    if (status >= 400) throw new LinkError(status, parsed?.error?.code ?? "failed", parsed?.error?.message ?? `HTTP ${status}`);
    return parsed as T;
  }

  /** A binary answer (a picture). */
  async bytes(path: string, timeoutMs = 120_000): Promise<Buffer> {
    const { status, bytes } = await this.raw("GET", path, {}, undefined, timeoutMs, "*/*");
    if (status >= 400) {
      let error: any;
      try {
        error = JSON.parse(bytes.toString("utf8"))?.error;
      } catch {
        // Not JSON.
      }
      throw new LinkError(status, error?.code ?? "failed", error?.message ?? `HTTP ${status}`);
    }
    return bytes;
  }

  info() {
    return this.request("GET", "info");
  }

  runs() {
    return this.request("GET", "runs");
  }

  sessions(filter: { runId?: string; state?: string; parentId?: string; labels?: Record<string, string>; q?: string; limit?: number } = {}) {
    return this.request("GET", "sessions", {
      runId: filter.runId,
      state: filter.state,
      parentId: filter.parentId,
      q: filter.q,
      limit: filter.limit,
      label: Object.entries(filter.labels ?? {}).map(([key, value]) => `${key}:${value}`),
    });
  }

  session(id: string) {
    return this.request("GET", `sessions/${encodeURIComponent(id)}`);
  }

  /** Messages from index `since`; with waitMs the host holds the answer until something changes (long poll). */
  transcript(id: string, options: { since?: number; limit?: number; tail?: number; waitMs?: number; state?: string; updatedAt?: string } = {}) {
    const wait = options.waitMs ?? 0;
    return this.request(
      "GET",
      `sessions/${encodeURIComponent(id)}/transcript`,
      { since: options.since, limit: options.limit, tail: options.tail, waitMs: wait || undefined, state: options.state, updatedAt: options.updatedAt },
      undefined,
      wait ? wait + 10_000 : undefined,
    );
  }

  events(id: string, since = 0, limit?: number) {
    return this.request("GET", `sessions/${encodeURIComponent(id)}/events`, { since, limit });
  }

  sessionTelemetry(id: string) {
    return this.request("GET", `sessions/${encodeURIComponent(id)}/telemetry`);
  }

  runTelemetry(runId: string) {
    return this.request("GET", `runs/${encodeURIComponent(runId)}/telemetry`);
  }

  send(id: string, text: string, deliveryMode: "queue" | "interrupt" = "queue") {
    return this.request("POST", `sessions/${encodeURIComponent(id)}/messages`, {}, { text, deliveryMode });
  }

  cancel(id: string) {
    return this.request("POST", `sessions/${encodeURIComponent(id)}/cancel`, {}, {});
  }

  invoke(capability: string, input: unknown = {}, timeoutMs = 300_000) {
    return this.request("POST", "invoke", {}, { capability, input }, timeoutMs);
  }

  files(root: string, path = "") {
    return this.request("GET", "files", { root, path });
  }

  readFile(root: string, path: string, maxBytes?: number) {
    return this.request("GET", "files/read", { root, path, maxBytes });
  }

  /** The envelope `marshal.sessions.importNative` takes: { format, encoding, data }. */
  native(id: string) {
    return this.request("GET", `sessions/${encodeURIComponent(id)}/native`, {}, undefined, 120_000);
  }

  /** Pages the host's Page Studio holds (runId: the ones that run made). */
  pages(runId?: string) {
    return this.request("GET", "pages", { runId });
  }

  /** One page with the pictures it shows (src/link/pages.ts PageManifest). */
  page(id: string) {
    return this.request("GET", `pages/${encodeURIComponent(id)}`, {}, undefined, 60_000);
  }

  pagePicture(id: string, brand: string, name: string) {
    return this.bytes(`pages/${encodeURIComponent(id)}/pictures/${encodeURIComponent(brand)}/${encodeURIComponent(name)}`);
  }

  /** Server-sent events of a session (`sessions/<id>/stream`) or a run (`runs/<id>/stream`). */
  stream(path: string, onEvent: (event: string, data: any) => void, query: Query = {}): LinkStream {
    const url = this.target(path, query);
    const transport = url.protocol === "https:" ? https : http;
    let request: http.ClientRequest | undefined;
    const done = new Promise<void>((resolve, reject) => {
      request = transport.request(url, { method: "GET", headers: { authorization: `Bearer ${this.options.token}`, accept: "text/event-stream" } }, (response) => {
        if ((response.statusCode ?? 0) >= 400) {
          response.resume();
          return reject(new LinkError(response.statusCode ?? 0, "failed", `Stream refused with HTTP ${response.statusCode}.`));
        }
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (!data.length) continue;
            try {
              onEvent(event, JSON.parse(data.join("\n")));
            } catch {
              // A listener error or a malformed frame must not end the stream.
            }
          }
        });
        response.on("end", () => resolve());
        response.on("close", () => resolve());
      });
      request.on("error", (error) => (request?.destroyed ? resolve() : reject(error)));
      request.end();
    });
    return {
      close: () => request?.destroy(),
      done,
    };
  }
}
