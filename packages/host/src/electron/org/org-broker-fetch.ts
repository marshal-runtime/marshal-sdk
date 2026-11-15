import { OrgApiError } from "@marshal/agent-runtime-org";

export const BROKER_TIMEOUT_MS = 60_000;
export const BROKER_MAX_REQUEST_BYTES = 1024 * 1024;
export const BROKER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BROKER_PREFIX = "/v1/broker/";
const MAX_PATH_CHARS = 2048;
const METHODS = new Set(["GET", "POST"]);
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "content-type", "mcp-session-id"]);
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2"]);

export interface OrgBrokerIdentity {
  readonly email: string;
  readonly orgId: string;
  readonly orgDisplayName: string;
}

export interface OrgBrokerFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface OrgBrokerFetchResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function hasForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || character === "\\" || character === "#") return true;
  }
  return false;
}

function refuse(code: string, message: string): never {
  throw new OrgApiError(0, code, message);
}

/**
 * Builds the broker URL from the org's API base and a path under `/v1/broker/`. Absolute URLs,
 * other origins, dot segments and encoded separators are refused, so the bearer only ever goes to
 * the broker routes of the org it was issued for.
 */
export function prepareBrokerRequest(
  apiBase: string,
  path: unknown,
  init: OrgBrokerFetchInit,
): { url: string; request: { method: string; headers: Record<string, string>; body?: string } } {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_CHARS) {
    refuse("path-not-allowed", "broker path is invalid");
  }
  if (
    !path.startsWith(BROKER_PREFIX) ||
    hasForbiddenCharacter(path) ||
    path.split("?")[0].includes("//") ||
    /%(2e|2f|5c|00)/i.test(path.split("?")[0])
  ) {
    refuse("path-not-allowed", "broker path must be under /v1/broker/");
  }
  const [pathname] = path.split("?");
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    refuse("path-not-allowed", "broker path must be under /v1/broker/");
  }
  const base = new URL(apiBase.replace(/\/+$/, "") + "/");
  const url = new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + BROKER_PREFIX)
  ) {
    refuse("path-not-allowed", "broker path must be under /v1/broker/");
  }
  const method = (init.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) refuse("method-not-allowed", "broker requests are GET or POST");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (typeof value === "string" && ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = value;
    }
  }
  let body: string | undefined;
  if (init.body !== undefined) {
    if (typeof init.body !== "string" || Buffer.byteLength(init.body) > BROKER_MAX_REQUEST_BYTES) {
      refuse("request-too-large", "broker request body exceeds 1 MiB");
    }
    body = init.body;
  }
  return {
    url: url.toString(),
    request: { method, headers, ...(body === undefined ? {} : { body }) },
  };
}

export async function readBrokerResponse(response: Response): Promise<OrgBrokerFetchResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read sequentially
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BROKER_MAX_RESPONSE_BYTES) {
        // eslint-disable-next-line no-await-in-loop -- runs once, then the loop throws
        await reader.cancel().catch(() => undefined);
        throw new OrgApiError(response.status, "response-too-large", "response exceeds 8 MiB");
      }
      chunks.push(value);
    }
  }
  return {
    status: response.status,
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}
