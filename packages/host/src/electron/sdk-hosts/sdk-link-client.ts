import type {
  SdkFileContent,
  SdkFileEntry,
  SdkHostError,
  SdkSessionState,
  SdkSessionTelemetry,
} from "../../common/sdk-hosts-contract";
import type { SdkHostTransport } from "./sdk-host-transport";

const DEFAULT_TIMEOUT_MS = 8_000;
/** A native conversation file can be large; the host caps it, this caps what the desktop will take. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The fields of a host's session record (marshal-sdk `SessionRecord`) the desktop reads. */
export interface LinkSessionRecord {
  id: string;
  title: string;
  state: SdkSessionState;
  createdAt: string;
  updatedAt: string;
  model?: string;
  parentId?: string;
  runId: string;
  workspace?: string;
  labels: Record<string, string>;
  messageCount: number;
  costUsd: number;
}

export interface LinkInfo {
  protocol: number;
  sdkVersion?: string;
  host: { id: string; kind: string };
  mode: "live" | "store";
  runs: number;
  sessions: number;
  extensions: { identity: string; version: string }[];
  files: string[];
}

export interface LinkTranscriptMessage {
  index: number;
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  error?: boolean;
  truncated?: number;
}

export interface LinkTranscript {
  session: LinkSessionRecord;
  total: number;
  cursor: number;
  messages: LinkTranscriptMessage[];
}

export interface LinkNativeState {
  title: string;
  nativeSessionId?: string;
  state: { format: string; encoding: string; data: string };
}

export class SdkLinkError extends Error {
  constructor(
    readonly code: SdkHostError,
    readonly status?: number,
  ) {
    super(`SDK host request failed: ${code}${status ? ` (${status})` : ""}`);
  }
}

/** One link v1 call: the parsed JSON body, or an SdkLinkError carrying the link's error code. */
export type LinkRequester = (
  method: "GET" | "POST",
  route: string,
  query: Record<string, string> | undefined,
  body: unknown,
  timeoutMs: number,
) => Promise<unknown>;

export type SdkLinkClientOptions =
  | { url: string; token: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }
  /** The same payloads carried another way (a host room): the client only parses. */
  | { request: LinkRequester; timeoutMs?: number };

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a non-array object read field by field as unknown
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

const STATES: readonly SdkSessionState[] = ["running", "idle", "failed"];

function isSessionState(value: string): value is SdkSessionState {
  return STATES.some((state) => state === value);
}

/** Reads a host's session record defensively: the host is another program, its JSON is data. */
export function parseSessionRecord(value: unknown): LinkSessionRecord | undefined {
  const source = record(value);
  if (!source) return undefined;
  const id = text(source.id);
  const state = text(source.state);
  if (!id || !isSessionState(state)) return undefined;
  const usage = record(source.usage);
  return {
    id,
    title: text(source.title, "Untitled session") || "Untitled session",
    state,
    createdAt: text(source.createdAt),
    updatedAt: text(source.updatedAt, text(source.createdAt)),
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.parentId === "string" ? { parentId: source.parentId } : {}),
    runId: text(source.runId),
    ...(typeof source.workspace === "string" ? { workspace: source.workspace } : {}),
    labels: stringMap(source.labels),
    messageCount: count(source.messageCount),
    costUsd: count(usage?.costUsd),
  };
}

export function statusCode(status: number, body: unknown): SdkHostError {
  const code = text(record(record(body)?.error)?.code);
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return code === "no-native-state" ? "no-native-state" : "not-found";
  if (status === 409) {
    if (code === "store-only") return "store-only";
    if (code === "running") return "running";
    return "invalid-request";
  }
  if (status === 400 || status === 422) return "invalid-request";
  if (status === 413) return "too-large";
  return "unavailable";
}

/** Normalizes a host URL to `scheme://host[:port][/base]` without a trailing slash; only http(s). */
export function normalizeHostUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function parseLinkInfo(value: unknown): LinkInfo {
  const body = record(value);
  const host = record(body?.host);
  if (!body || typeof body.protocol !== "number" || !host) throw new SdkLinkError("protocol");
  const extensions = Array.isArray(body.extensions)
    ? body.extensions.flatMap((entry) => {
        const item = record(entry);
        return item && typeof item.identity === "string"
          ? [{ identity: item.identity, version: text(item.version) }]
          : [];
      })
    : [];
  return {
    protocol: body.protocol,
    ...(typeof body.sdkVersion === "string" ? { sdkVersion: body.sdkVersion } : {}),
    host: { id: text(host.id), kind: text(host.kind) },
    mode: body.mode === "live" ? "live" : "store",
    runs: Array.isArray(body.runs) ? body.runs.length : count(body.runs),
    sessions: count(body.sessions),
    extensions,
    files: Array.isArray(body.files)
      ? body.files.filter((root): root is string => typeof root === "string")
      : [],
  };
}

function httpRequester(
  base: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): LinkRequester {
  return async (method, route, query, body, timeoutMs) => {
    const url = new URL(`${base}${route}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      throw new SdkLinkError("unreachable");
    } finally {
      clearTimeout(timer);
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RESPONSE_BYTES) throw new SdkLinkError("too-large", response.status);
    let parsed: unknown;
    try {
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_BYTES) throw new SdkLinkError("too-large", response.status);
      parsed = raw ? (JSON.parse(raw) as unknown) : {};
    } catch (error) {
      if (error instanceof SdkLinkError) throw error;
      throw new SdkLinkError(response.ok ? "protocol" : statusCode(response.status, undefined));
    }
    if (!response.ok) throw new SdkLinkError(statusCode(response.status, parsed), response.status);
    return parsed;
  };
}

/**
 * The desktop's client for the SDK link protocol v1 (marshal-sdk docs/link.md). Every request carries the
 * host's bearer token; answers are parsed field by field, never trusted as typed.
 */
export class SdkLinkClient implements SdkHostTransport {
  private readonly requester: LinkRequester;
  private readonly timeoutMs: number;

  constructor(options: SdkLinkClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if ("request" in options) {
      this.requester = options.request;
      return;
    }
    const base = normalizeHostUrl(options.url);
    if (!base) throw new SdkLinkError("invalid-request");
    this.requester = httpRequester(base, options.token, options.fetch ?? globalThis.fetch);
  }

  private request(
    method: "GET" | "POST",
    route: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    const strings = query
      ? Object.fromEntries(
          Object.entries(query).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, String(value)]],
          ),
        )
      : undefined;
    return this.requester(method, route, strings, body, timeoutMs);
  }

  async info(): Promise<LinkInfo> {
    return parseLinkInfo(await this.request("GET", "/v1/info"));
  }

  async sessions(): Promise<LinkSessionRecord[]> {
    const body = record(await this.request("GET", "/v1/sessions"));
    if (!body || !Array.isArray(body.sessions)) throw new SdkLinkError("protocol");
    return body.sessions.flatMap((entry) => parseSessionRecord(entry) ?? []);
  }

  async search(
    query: string,
    limit: number,
  ): Promise<{ session: LinkSessionRecord; snippet: string; score: number }[]> {
    const body = record(await this.request("GET", "/v1/sessions", { q: query, limit }));
    if (!body || !Array.isArray(body.hits)) throw new SdkLinkError("protocol");
    return body.hits.flatMap((entry) => {
      const hit = record(entry);
      const session = parseSessionRecord(hit?.session);
      return session
        ? [
            {
              session,
              snippet: text(hit?.snippet),
              score: typeof hit?.score === "number" ? hit.score : 0,
            },
          ]
        : [];
    });
  }

  async transcript(sessionId: string, options: { tail: number }): Promise<LinkTranscript> {
    const body = record(
      await this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, {
        tail: options.tail,
      }),
    );
    const session = parseSessionRecord(body?.session);
    if (!body || !session || !Array.isArray(body.messages)) throw new SdkLinkError("protocol");
    const messages = body.messages.flatMap((entry): LinkTranscriptMessage[] => {
      const message = record(entry);
      const role = text(message?.role);
      if (!message || (role !== "user" && role !== "assistant" && role !== "system")) return [];
      return [
        {
          index: count(message.index),
          id: text(message.id, String(count(message.index))),
          role,
          content: text(message.content),
          ...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}),
          ...(message.error === true ? { error: true } : {}),
          ...(typeof message.truncated === "number" ? { truncated: message.truncated } : {}),
        },
      ];
    });
    return { session, total: count(body.total), cursor: count(body.cursor), messages };
  }

  async telemetry(sessionId: string): Promise<SdkSessionTelemetry> {
    const body = record(
      await this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/telemetry`),
    );
    const telemetry = record(body?.telemetry);
    if (!telemetry) throw new SdkLinkError("protocol");
    return pickTelemetry(telemetry);
  }

  async files(
    root: string,
    filePath: string,
  ): Promise<{ entries: SdkFileEntry[]; truncated: boolean }> {
    const body = record(await this.request("GET", "/v1/files", { root, path: filePath }));
    if (!body || !Array.isArray(body.entries)) throw new SdkLinkError("protocol");
    const entries = body.entries.flatMap((entry): SdkFileEntry[] => {
      const item = record(entry);
      if (!item || typeof item.name !== "string") return [];
      const type = item.type === "file" || item.type === "directory" ? item.type : "other";
      return [
        {
          name: item.name,
          type,
          size: count(item.size),
          ...(typeof item.modifiedAt === "string" ? { modifiedAt: item.modifiedAt } : {}),
        },
      ];
    });
    return { entries, truncated: body.truncated === true };
  }

  async readFile(root: string, filePath: string, maxBytes: number): Promise<SdkFileContent> {
    const body = record(
      await this.request("GET", "/v1/files/read", { root, path: filePath, maxBytes }),
    );
    if (!body || typeof body.content !== "string") throw new SdkLinkError("protocol");
    return {
      root,
      path: filePath,
      size: count(body.size),
      encoding: body.encoding === "base64" ? "base64" : "utf8",
      content: body.content,
      truncated: body.truncated === true,
    };
  }

  async send(
    sessionId: string,
    message: string,
    deliveryMode: "queue" | "interrupt",
  ): Promise<void> {
    await this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      undefined,
      {
        text: message,
        deliveryMode,
      },
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
      undefined,
      {},
    );
  }

  async native(sessionId: string): Promise<LinkNativeState> {
    const body = record(
      await this.request(
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}/native`,
        undefined,
        undefined,
        60_000,
      ),
    );
    const state = record(body?.state);
    if (!body || !state || typeof state.data !== "string") throw new SdkLinkError("protocol");
    return {
      title: text(body.title),
      ...(typeof body.nativeSessionId === "string"
        ? { nativeSessionId: body.nativeSessionId }
        : {}),
      state: { format: text(state.format), encoding: text(state.encoding), data: state.data },
    };
  }
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberMap(value: unknown): Record<string, number> | undefined {
  const source = record(value);
  if (!source) return undefined;
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

/** Keeps only the telemetry fields the desktop shows, each checked. */
export function pickTelemetry(source: Record<string, unknown>): SdkSessionTelemetry {
  const tokens = record(source.tokens);
  const durations = record(source.turnDurations);
  const errors = record(source.errors);
  const models = record(source.models);
  const out: SdkSessionTelemetry = {};
  for (const key of [
    "costUsd",
    "turns",
    "modelRoundTrips",
    "toolCallTotal",
    "toolErrors",
  ] as const) {
    const value = numberField(source, key);
    if (value !== undefined) out[key] = value;
  }
  if (tokens) {
    out.tokens = {
      input: numberField(tokens, "input"),
      output: numberField(tokens, "output"),
      cacheRead: numberField(tokens, "cacheRead"),
      cacheWrite: numberField(tokens, "cacheWrite"),
    };
  }
  const toolCalls = numberMap(source.toolCalls);
  if (toolCalls) out.toolCalls = toolCalls;
  if (durations) {
    out.turnDurations = {
      count: numberField(durations, "count"),
      averageMs: numberField(durations, "averageMs"),
      medianMs: numberField(durations, "medianMs"),
      maxMs: numberField(durations, "maxMs"),
    };
  }
  if (errors) {
    out.errors = {
      count: numberField(errors, "count"),
      last: Array.isArray(errors.last)
        ? errors.last.flatMap((entry) => {
            if (typeof entry === "string") return [entry.slice(0, 500)];
            const item = record(entry);
            const message = item ? text(item.message ?? item.error) : "";
            return message ? [message.slice(0, 500)] : [];
          })
        : undefined,
    };
  }
  if (models) {
    out.models = Object.fromEntries(
      Object.entries(models).flatMap(([name, value]) => {
        const item = record(value);
        return item
          ? [
              [
                name,
                {
                  costUsd: numberField(item, "costUsd"),
                  outputTokens: numberField(item, "outputTokens"),
                },
              ],
            ]
          : [];
      }),
    );
  }
  if (typeof source.firstEventAt === "string") out.firstEventAt = source.firstEventAt;
  if (typeof source.lastEventAt === "string") out.lastEventAt = source.lastEventAt;
  return out;
}
