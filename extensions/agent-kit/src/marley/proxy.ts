import { randomBytes } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";

import { errorMessage, type Logger } from "./logger.js";
import { failureFields } from "./operation-error.js";
import type { PlanUsage } from "./pool/pool-types.js";
import { windowsFromHeaders } from "./pool/usage-windows.js";
import { estimateVertexCostUsd, parseVertexTarget, vertexBodyRefusal, vertexUpstreamUrl, VertexUsageParser, type VertexAuth, type VertexConfig, type VertexSpendCap } from "./vertex.js";
import { BROWSER_DECIDE_PATH, DECIDE_MAX_BODY_BYTES } from "./browser-decide.js";

/** Which model API a session's key may call: the Anthropic API (Claude Code) or Vertex AI (the Antigravity bridge on the VM). */
export type ProxyProvider = "anthropic" | "vertex";

/** The Vertex side of the proxy (vertex.ts). Absent: every /vertex/ path is refused. */
export interface ProxyVertex {
  config: Pick<VertexConfig, "project" | "location" | "models" | "prices">;
  auth: VertexAuth;
  spend: VertexSpendCap;
  /** Replaces the Vertex origin (`https://<host>`): a test's fake upstream only. */
  upstream?: string | (() => string);
}

/** What the proxy sends upstream for one session: a subscription setup token or an API key. */
export interface ProxyMember {
  id: string;
  kind: "subscription" | "api_key";
  token: string;
  trial?: string;
}

export interface Usage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * The ledger eval-run turns are charged to instead of their brand's (MLY-315): an inspector test conversation the operator started
 * for an eval run. Brand ids are UUIDs, so this key can never be a brand's ledger.
 */
export const EVAL_LEDGER = "__evals__";

/** Spend per ledger (a brand id, or `EVAL_LEDGER`) and UTC day: accounting only, nothing is refused on it (Omer, 2026-11-18). */
export interface Budget {
  record(ledger: string, day: string, usage: Usage, costUsd: number): void;
}

export interface ProxyOptions {
  /** Base URL of the model API (a function lets a test stand-in that listens later be used). */
  upstream: string | (() => string);
  budget: Budget;
  logger: Logger;
  /** Picks the pool member a session of this brand uses; null when none can take a session. */
  pickMember(brandId: string, excluded?: string[]): Promise<ProxyMember | null>;
  releaseMember?(member: ProxyMember): void;
  /** A second check that the member may serve the brand (subscription members: internal brands only); default allows. */
  memberAllowed?(brandId: string, member: ProxyMember): boolean;
  /** Why no member could be picked right now (shown to the model client and recorded on the turn). */
  whyUnavailable?(brandId: string): string;
  /** Called when upstream rejects the member (rate limit or auth), so the pool can rest it. */
  onMemberRejected?(member: ProxyMember, status: number): void;
  onMemberUsage?(member: ProxyMember, windows: Partial<PlanUsage>): void;
  /**
   * The browser relay's step endpoint (POST /zs/browser/step, browser-relay.ts): served for an open session with its own brand, chat and role;
   * no pool member, no budget and no upstream call. Absent: the path is refused like any other.
   */
  browserStep?(session: { brandId: string; front: boolean; chat: string | null; key: string }, input: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /**
   * The stored UA analysis for the VM's read-only `latest` readers (POST /zs/ua/read, routines/ua-server): served for an open session with its own brand and chat; no
   * pool member, no budget and no upstream call. The analysis itself runs only on the server's own schedule; nothing on this path starts it.
   */
  uaRead?(session: { brandId: string; front: boolean; chat: string | null; key: string }, input: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /**
   * The VM browser's model (POST /zs/decide, browser-decide.ts): marshal-sdk's decide service on the server's OpenAI key, served for an open session with its
   * own brand; no pool member and no upstream Anthropic call. The body may carry screenshots (DECIDE_MAX_BODY_BYTES). Absent: the path is refused like any other.
   */
  browserDecide?(session: { brandId: string; front: boolean; chat: string | null; key: string }, input: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  now?: () => number;
  /**
   * LOCAL STACK ONLY (src/local-stack/model-tape.ts, set by src/local-stack/main.ts; production never sets it): records the model calls of a node, or
   * answers them from a recording. Asked first for every allowed endpoint, before the budget, the pool member and the upstream (a replayed call needs no
   * credential and costs nothing); a non-null answer is the call's whole answer. Absent: the proxy behaves exactly as without it.
   */
  tape?: ProxyTape;
  /** Vertex AI for sessions opened with provider `vertex` (vertex.ts): this server's own token, a model allowlist and a hard spend cap. */
  vertex?: ProxyVertex;
}

/** One model call as the tape sees it: the server's own session (brand, key and when it was opened; never request text) and the request body. */
export interface ProxyTapeCall {
  brandId: string;
  session: string;
  /** When the proxy opened the session (its clock): a session opened before the tape was armed belongs to an earlier run. */
  sessionOpenedAt: number;
  endpoint: string;
  body: Buffer;
}
/** An answer the tape gives in place of the upstream; `errorType` is the typed `error.type` of a non-2xx answer (recorded as the session's refusal). */
export interface ProxyTapeReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  errorType: string | null;
}
/** What the client got for a call that went upstream: status, content type and the response body (at most 32 MiB kept). */
export interface ProxyTapeAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}
export interface ProxyTape {
  serve(call: ProxyTapeCall): ProxyTapeReply | null;
  observe(call: ProxyTapeCall, answer: ProxyTapeAnswer): void;
}
const TAPE_ANSWER_MAX_BYTES = 32 * 1024 * 1024;

interface Session {
  brandId: string;
  /** The budget ledger the session's calls are charged to and checked against: the brand id, or `EVAL_LEDGER` for an eval run's conversation. */
  ledger: string;
  key: string;
  openedAt: number;
  /** A conversation's own (front) session and its chat; a background worker's session is not front. */
  front: boolean;
  chat: string | null;
  /** The outbox composer's session (claude.ts compose): it reaches no browser, neither a step nor /zs/decide. */
  composer: boolean;
  dummyKey: string;
  /** The only model API this session's key may call. */
  provider: ProxyProvider;
  member: ProxyMember | null;
  selecting?: Promise<ProxyMember | null>;
  closed?: boolean;
  /** Why the latest call found no pool member; cleared by the next call that does. */
  unavailable: string | null;
  /** The provider's answer to the latest upstream call when it was an HTTP error passed through; cleared by the next upstream success. */
  refusal: ProviderRefusal | null;
  calls: number;
  costUsd: number;
}

/**
 * An upstream HTTP error the proxy passed through to the model client, typed from what the provider returned (MLY-524): its status,
 * the `error.type` field of its JSON error body (null when there is none) and its `request-id` header. `call` is the session's call
 * number it answered, so a runner can tell a refusal of the current turn from an older one of the same live session.
 */
export interface ProviderRefusal {
  status: number;
  providerErrorType: string | null;
  providerRequestId: string | null;
  call: number;
}

export interface OpenSession {
  /** The dummy API key the process on the VM sends; it identifies the session and is worth nothing anywhere else. */
  dummyKey: string;
  /** Estimated cost of the calls made with this key so far. */
  costUsd(): number;
  /** Why the latest call of this session found no pool member, or null. */
  unavailable(): string | null;
  /** The provider's error answer to the latest upstream call, or null when that call succeeded or none was made. */
  refusal(): ProviderRefusal | null;
  /** Upstream calls made with this key so far. */
  calls(): number;
  close(): void;
}

/** First match wins: current models first, then each family's older rates. Cache writes are the 5-minute rate (1.25x input). */
const PRICES_PER_MTOK = [
  { match: /opus-5-5/i, input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  { match: /opus-(5|4-[678])/i, input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  { match: /opus/i, input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { match: /sonnet-5/i, input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  { match: /haiku-5-5/i, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  { match: /haiku/i, input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  { match: /.*/, input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
];

/** An estimate of the call's cost in dollars from token counts; subscription calls cost nothing extra, but the estimate still bounds a brand. */
export function estimateCostUsd(usage: Usage): number {
  const price = PRICES_PER_MTOK.find((p) => p.match.test(usage.model ?? ""))!;
  return (
    (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheWriteTokens * price.cacheWrite + usage.cacheReadTokens * price.cacheRead) / 1_000_000
  );
}

/** Collects token usage from an Anthropic response stream (SSE) or JSON body without keeping the content. */
export class UsageParser {
  readonly usage: Usage = { model: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  /** The `error.type` field of an Anthropic error body or SSE `error` event (`{"type":"error","error":{"type":...}}`), when one was seen. */
  errorType: string | null = null;
  private tail = "";
  private body: Buffer[] = [];
  private bodyBytes = 0;

  constructor(private readonly sse: boolean) {}

  push(chunk: Buffer): void {
    if (!this.sse) {
      if (this.bodyBytes < 8 * 1024 * 1024) {
        this.body.push(chunk);
        this.bodyBytes += chunk.length;
      }
      return;
    }
    this.tail += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.tail.indexOf("\n")) >= 0) {
      this.line(this.tail.slice(0, newline).trim());
      this.tail = this.tail.slice(newline + 1);
    }
  }

  finish(): Usage {
    if (this.sse) this.line(this.tail.trim());
    else {
      try {
        this.apply(JSON.parse(Buffer.concat(this.body).toString("utf8")) as unknown);
      } catch {
        /* not a message body */
      }
    }
    return this.usage;
  }

  private line(text: string): void {
    if (!text.startsWith("data:")) return;
    try {
      this.apply(JSON.parse(text.slice(5).trim()) as unknown);
    } catch {
      /* partial or non-JSON event */
    }
  }

  private apply(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const event = value as { type?: string; error?: { type?: unknown }; message?: { model?: string; usage?: Record<string, number> }; usage?: Record<string, number>; model?: string };
    if (event.type === "error" && typeof event.error?.type === "string") this.errorType = event.error.type.slice(0, 64);
    const usage = event.type === "message_start" ? event.message?.usage : event.usage;
    const model = event.type === "message_start" ? event.message?.model : event.model;
    if (model) this.usage.model = model;
    if (!usage) return;
    if (typeof usage.input_tokens === "number" && event.type !== "message_delta") this.usage.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") this.usage.outputTokens = usage.output_tokens;
    if (typeof usage.cache_creation_input_tokens === "number") this.usage.cacheWriteTokens = usage.cache_creation_input_tokens;
    if (typeof usage.cache_read_input_tokens === "number") this.usage.cacheReadTokens = usage.cache_read_input_tokens;
  }
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "x-api-key", "authorization", "accept-encoding"]);
const OAUTH_BETA = "oauth-2025-04-20";
/** The only upstream endpoints a session may reach with the pool credential (everything real Claude Code sends here). */
const ALLOWED_ENDPOINTS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const errorBody = (type: string, message: string): string => JSON.stringify({ type: "error", error: { type, message } });

/**
 * The model proxy. The Claude Code process on a sandbox VM reaches it through the SSH reverse tunnel with a dummy key;
 * the proxy swaps in a pool credential, enforces the brand's daily budget, logs every call without its content and
 * refuses once the session is closed. The credential never leaves this process.
 */
export class ModelProxy {
  private readonly sessions = new Map<string, Session>();
  private server: http.Server | null = null;
  private listening: number | null = null;

  constructor(private readonly options: ProxyOptions) {}

  /** The port the proxy listens on, or null before `listen` and after `close`. */
  port(): number | null {
    return this.listening;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    // A throw inside handle reaches the client as a 502 api_error; log it typed, or a worker's failed calls leave no trace on the server
    // (a staging worker retried ten such calls on 2026-11-12 and no proxy line explained them).
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((error) => {
      this.options.logger.warn("proxy.failed", { path: (req.url ?? "").split("?")[0], ...failureFields(error) });
      this.fail(res, 502, "api_error", errorMessage(error));
    }));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, resolve);
    });
    this.listening = (this.server.address() as AddressInfo).port;
    return this.listening;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) this.endSession(session);
    this.sessions.clear();
    this.listening = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Opens a session for a brand; calls with the returned key are served until `close`. `ledger` is the budget it is charged to: the
   * brand's own unless the caller (the turn runner, from the server's record of the conversation) names `EVAL_LEDGER`.
   */
  open(brandId: string, key: string, role: { front: boolean; chat: string | null; composer?: boolean } = { front: false, chat: null }, ledger: string = brandId, provider: ProxyProvider = "anthropic"): OpenSession {
    if (provider === "vertex" && !this.options.vertex) throw new Error("vertex is not configured on this server");
    const dummyKey = `${provider === "vertex" ? "zs-vtx-" : "sk-ant-zs-"}${randomBytes(24).toString("base64url")}`;
    const session: Session = { brandId, ledger: ledger === EVAL_LEDGER ? EVAL_LEDGER : brandId, key, openedAt: this.now(), front: role.front, chat: role.chat, composer: role.composer === true, dummyKey, provider, member: null, unavailable: null, refusal: null, calls: 0, costUsd: 0 };
    this.sessions.set(dummyKey, session);
    return {
      dummyKey,
      costUsd: () => session.costUsd,
      unavailable: () => session.unavailable,
      refusal: () => session.refusal,
      calls: () => session.calls,
      close: () => { this.endSession(session); this.sessions.delete(dummyKey); },
    };
  }

  private async browserStep(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 64 * 1024) chunks.push(chunk); });
      req.on("end", resolve); req.on("error", reject);
    });
    if (bytes > 64 * 1024) return this.fail(res, 413, "invalid_request_error", "browser step too large");
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.fail(res, 400, "invalid_request_error", "browser step is not JSON"); }
    // The session may have closed while the body was arriving (its process is gone); a live conversation's session, reused across its
    // turns, stays open and is governed by the chat's current turn mark.
    if (session.closed) return this.fail(res, 401, "authentication_error", "session closed");
    const answer = await this.options.browserStep!({ brandId: session.brandId, front: session.front, chat: session.chat, key: session.key }, input);
    if (!res.headersSent) res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }

  private async browserDecide(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= DECIDE_MAX_BODY_BYTES) chunks.push(chunk); });
      req.on("end", resolve); req.on("error", reject);
    });
    if (bytes > DECIDE_MAX_BODY_BYTES) return this.fail(res, 413, "invalid_request_error", "decision too large");
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.fail(res, 400, "invalid_request_error", "decision is not JSON"); }
    if (session.closed) return this.fail(res, 401, "authentication_error", "session closed");
    const answer = await this.options.browserDecide!({ brandId: session.brandId, front: session.front, chat: session.chat, key: session.key }, input);
    if (!res.headersSent) res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }

  private async uaRead(session: Session, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 4096) chunks.push(chunk); });
      req.on("end", resolve); req.on("error", reject);
    });
    if (bytes > 4096) return this.fail(res, 413, "invalid_request_error", "request too large");
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return this.fail(res, 400, "invalid_request_error", "request is not JSON"); }
    if (session.closed) return this.fail(res, 401, "authentication_error", "session closed");
    const answer = await this.options.uaRead!({ brandId: session.brandId, front: session.front, chat: session.chat, key: session.key }, input);
    if (!res.headersSent) res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  }

  private endSession(session: Session): void {
    session.closed = true;
    if (session.member) this.options.releaseMember?.(session.member);
  }

  openSessions(): number {
    return this.sessions.size;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private fail(res: http.ServerResponse, status: number, type: string, message: string, extraHeaders: http.OutgoingHttpHeaders = {}): void {
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
    res.end(errorBody(type, message));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, body?: Buffer, attempted = new Set<string>(), tapeCall?: ProxyTapeCall): Promise<void> {
    if (!body && (req.url ?? "").startsWith("/vertex/")) return this.handleVertex(req, res);
    const started = this.now();
    const presented = (req.headers["x-api-key"] as string | undefined) ?? /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const session = presented ? this.sessions.get(presented) : undefined;
    if (!session) {
      req.resume();
      return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
    }
    const { budget, logger } = this.options;
    const endpoint = (req.url ?? "").split("?")[0] ?? "";
    // The composer has no browser (not reviewed for it, and it carries no relay mark): its key reaches neither a browser step nor the browser's model.
    if (session.composer && (endpoint === "/zs/browser/step" || endpoint === BROWSER_DECIDE_PATH)) {
      req.resume();
      logger.warn("proxy.composer_browser_refused", { brandId: session.brandId, session: session.key, path: endpoint });
      return this.fail(res, 403, "permission_error", "the composer has no browser");
    }
    // Both are a Claude session's (its key is the VM runtime's): a `vertex` session's key (a Gemini bridge's) reaches only /vertex/.
    if (endpoint === "/zs/browser/step" && req.method === "POST" && this.options.browserStep && !session.closed && session.provider === "anthropic") return this.browserStep(session, req, res);
    if (endpoint === "/zs/ua/read" && req.method === "POST" && this.options.uaRead && !session.closed && session.provider === "anthropic") return this.uaRead(session, req, res);
    if (endpoint === BROWSER_DECIDE_PATH && req.method === "POST" && this.options.browserDecide && !session.closed && session.provider === "anthropic") return this.browserDecide(session, req, res);
    if (req.method !== "POST" || !ALLOWED_ENDPOINTS.has(endpoint) || session.provider !== "anthropic") {
      req.resume();
      logger.warn("proxy.endpoint_refused", { brandId: session.brandId, session: session.key, method: req.method, path: endpoint });
      return this.fail(res, 404, "not_found_error", "this endpoint is not available");
    }
    const tape = this.options.tape;
    if (tape && !tapeCall) {
      if (!body) {
        body = (await this.readRequest(req)) ?? undefined;
        if (!body) return this.fail(res, 413, "invalid_request_error", "model request too large");
      }
      if (session.closed) return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
      tapeCall = { brandId: session.brandId, session: session.key, sessionOpenedAt: session.openedAt, endpoint, body };
      const reply = tape.serve(tapeCall);
      if (reply) {
        session.calls += 1;
        session.refusal = reply.status < 400 ? null : { status: reply.status, providerErrorType: reply.errorType, providerRequestId: null, call: session.calls };
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
        return;
      }
    }
    const day = new Date(started).toISOString().slice(0, 10);
    if (!body) {
      body = (await this.readRequest(req)) ?? undefined;
      if (!body) return this.fail(res, 413, "invalid_request_error", "model request too large");
    }
    if (!session.member) {
      session.selecting ??= this.options.pickMember(session.brandId, [...attempted]);
      // Cleared whatever the pick's outcome: a rejected pick left in place answered every later call of the session with the same
      // rejection until the session ended.
      try { session.member = await session.selecting; }
      finally { session.selecting = undefined; }
    }
    const member = session.member;
    if (session.closed) {
      if (member) this.options.releaseMember?.(member);
      return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
    }
    if (member && attempted.has(member.id)) {
      this.options.releaseMember?.(member);
      session.member = null;
      return this.fail(res, 403, "permission_error", "no untried model account is available", { "x-should-retry": "false" });
    }
    if (member) session.unavailable = null;
    if (member && this.options.memberAllowed && !this.options.memberAllowed(session.brandId, member)) {
      this.options.releaseMember?.(member);
      session.member = null;
      req.resume();
      logger.warn("proxy.member_refused", { brandId: session.brandId, session: session.key });
      return this.fail(res, 403, "permission_error", "this brand may not use that model account");
    }
    if (!member) {
      req.resume();
      const reason = this.options.whyUnavailable?.(session.brandId) ?? "the model pool is not configured or every member is resting";
      session.unavailable = reason;
      logger.warn("proxy.no_member", { brandId: session.brandId, session: session.key, reason });
      // A 4xx with x-should-retry: false: Claude Code retries 5xx and 429 for minutes, and this answer will not change within a turn.
      return this.fail(res, 403, "permission_error", `model pool unavailable: ${reason}`, { "x-should-retry": "false" });
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
    headers["accept-encoding"] = "identity";
    if (member.kind === "subscription") {
      headers.authorization = `Bearer ${member.token}`;
      const beta = String(headers["anthropic-beta"] ?? "");
      if (!beta.split(",").map((s) => s.trim()).includes(OAUTH_BETA)) headers["anthropic-beta"] = beta ? `${beta},${OAUTH_BETA}` : OAUTH_BETA;
    } else {
      headers["x-api-key"] = member.token;
    }
    const url = new URL(req.url ?? "/", typeof this.options.upstream === "function" ? this.options.upstream() : this.options.upstream);
    const transport = url.protocol === "http:" ? http : https;
    session.calls += 1;
    attempted.add(member.id);

    const retry = await new Promise<boolean>((resolve) => {
      const upstream = transport.request(url, { method: req.method, headers }, (response) => {
        const status = response.statusCode ?? 502;
        if (member.kind === "subscription") {
          try { this.options.onMemberUsage?.(member, windowsFromHeaders(response.headers)); }
          catch (error) { logger.warn("proxy.usage_unavailable", { member: member.id, ...failureFields(error) }); }
        }
        if ([429, 401, 403].includes(status)) {
          logger.warn("proxy.member_retry", { brandId: session.brandId, session: session.key, member: member.id, path: url.pathname, status });
          this.options.onMemberRejected?.(member, status);
          this.options.releaseMember?.(member);
          if (session.member === member) session.member = null;
          response.resume();
          response.on("end", () => resolve(true));
          response.on("error", () => resolve(true));
          return;
        }
        const outHeaders = { ...response.headers };
        delete outHeaders["transfer-encoding"];
        delete outHeaders.connection;
        res.writeHead(status, outHeaders);
        const parser = new UsageParser(String(response.headers["content-type"] ?? "").includes("event-stream"));
        const kept: Buffer[] = [];
        let keptBytes = 0;
        const observe = () => { if (tape && tapeCall) tape.observe(tapeCall, { status, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(kept) }); };
        response.on("data", (chunk: Buffer) => {
          parser.push(chunk);
          if (tapeCall && keptBytes + chunk.length <= TAPE_ANSWER_MAX_BYTES) { kept.push(chunk); keptBytes += chunk.length; }
          res.write(chunk);
        });
        response.on("end", () => {
          res.end();
          observe();
          const usage = parser.finish();
          const cost = estimateCostUsd(usage);
          if (status < 400) {
            budget.record(session.ledger, day, usage, cost);
            session.costUsd += cost;
            session.refusal = null;
          } else {
            // The provider refused or failed the call and the client got its answer as it was (MLY-524). Typed from the status, the
            // body's error.type field and the request-id header only. A provider fault is WARN (OB01); the export names this event so
            // the model-calls-refused monitor can read it (OB02).
            const requestId = response.headers["request-id"];
            session.refusal = { status, providerErrorType: parser.errorType, providerRequestId: typeof requestId === "string" ? requestId.slice(0, 128) : null, call: session.calls };
            logger.warn("proxy.provider_refused", {
              brandId: session.brandId,
              session: session.key,
              ...(session.ledger === EVAL_LEDGER ? { ledger: "evals" } : {}),
              member: member.id,
              path: url.pathname,
              status,
              providerErrorType: session.refusal.providerErrorType,
              providerRequestId: session.refusal.providerRequestId,
            });
          }
          logger.info("proxy.call", {
            brandId: session.brandId,
            session: session.key,
            ...(session.ledger === EVAL_LEDGER ? { ledger: "evals" } : {}),
            member: member.id,
            path: url.pathname,
            status,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costUsd: Number(cost.toFixed(6)),
            ms: this.now() - started,
          });
          resolve(false);
        });
        response.on("error", () => {
          res.destroy();
          observe();
          resolve(false);
        });
      });
      upstream.on("error", (error) => {
        logger.warn("proxy.upstream_error", { brandId: session.brandId, session: session.key, ...failureFields(error) });
        this.fail(res, 502, "api_error", "model API unreachable");
        if (tape && tapeCall) tape.observe(tapeCall, { status: 502, contentType: "application/json", body: Buffer.alloc(0) });
        resolve(false);
      });
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      upstream.end(body);
    });
    if (retry && !res.destroyed) await this.handle(req, res, body, attempted, tapeCall);
  }

  /**
   * One Vertex call of a `vertex` session (the Antigravity bridge on the brand VM, through the same reverse tunnel). The key travels in
   * `x-zs-session-key` only. The path must name an allowed model and action, the body may carry only plain generation fields and function tools,
   * the cap is reserved before anything is sent, and the upstream request carries exactly the content headers plus this server's own token: no
   * header of the client's that could carry a credential (authorization, x-goog-api-key, x-goog-user-project, cookies) is forwarded.
   */
  private async handleVertex(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = this.now();
    const presented = req.headers["x-zs-session-key"];
    const session = typeof presented === "string" ? this.sessions.get(presented) : undefined;
    const { logger, budget } = this.options;
    if (!session || session.closed || session.provider !== "vertex") {
      req.resume();
      return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
    }
    const vertex = this.options.vertex;
    const target = vertex && req.method === "POST" ? parseVertexTarget(req.url ?? "", vertex.config.models) : null;
    if (!vertex || !target) {
      req.resume();
      logger.warn("proxy.endpoint_refused", { brandId: session.brandId, session: session.key, method: req.method, path: (req.url ?? "").split("?")[0]?.slice(0, 200) });
      return this.fail(res, 404, "not_found_error", "this endpoint is not available");
    }
    const body = await this.readRequest(req);
    if (!body) return this.fail(res, 413, "invalid_request_error", "model request too large");
    const bodyRefusal = vertexBodyRefusal(body);
    if (bodyRefusal) {
      logger.warn("proxy.vertex_body_refused", { brandId: session.brandId, session: session.key, model: target.model, reason: bodyRefusal });
      return this.fail(res, 400, "invalid_request_error", bodyRefusal);
    }
    if (session.closed) return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
    // The cap is taken before any await that could let a second call pass the same check.
    const capRefusal = vertex.spend.reserve();
    if (capRefusal) {
      session.unavailable = capRefusal;
      logger.warn("proxy.vertex_cap_refused", { brandId: session.brandId, session: session.key, model: target.model, ...vertex.spend.snapshot() });
      return this.fail(res, 402, "permission_error", capRefusal, { "x-should-retry": "false" });
    }
    let settled = false;
    const settle = (cost: number | null, atLeastReserve = false): number => {
      if (settled) return 0;
      settled = true;
      return vertex.spend.settle(cost, atLeastReserve);
    };
    const release = (): void => {
      if (settled) return;
      settled = true;
      vertex.spend.release();
    };
    let auth: Record<string, string>;
    try {
      auth = await vertex.auth.headers();
    } catch (error) {
      release();
      logger.error("proxy.vertex_auth_failed", { brandId: session.brandId, session: session.key, ...failureFields(error) });
      return this.fail(res, 502, "api_error", "model API credential unavailable");
    }
    if (session.closed) {
      release();
      return this.fail(res, 401, "authentication_error", "this session is closed or unknown");
    }
    session.unavailable = null;
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/json", "accept-encoding": "identity", "content-length": String(body.length) };
    for (const name of ["accept", "user-agent", "x-goog-api-client"]) {
      const value = req.headers[name];
      if (typeof value === "string" && value.length <= 512) headers[name] = value;
    }
    Object.assign(headers, auth);
    const real = vertexUpstreamUrl(vertex.config, target.model, target.action, target.sse);
    const origin = typeof vertex.upstream === "function" ? vertex.upstream() : vertex.upstream;
    const url = new URL(origin ? real.replace(/^https:\/\/[^/]+/, origin.replace(/\/+$/, "")) : real);
    const transport = url.protocol === "http:" ? http : https;
    const day = new Date(started).toISOString().slice(0, 10);
    session.calls += 1;
    const record = (usage: ReturnType<VertexUsageParser["finish"]>, charged: number, status: number, outcome: string): void => {
      if (charged > 0) {
        budget.record(session.ledger, day, { ...usage, model: usage.model ?? target.model }, charged);
        session.costUsd += charged;
      }
      const spend = vertex.spend.snapshot();
      logger.info("proxy.vertex_call", {
        brandId: session.brandId,
        session: session.key,
        ...(session.ledger === EVAL_LEDGER ? { ledger: "evals" } : {}),
        model: target.model,
        action: target.action,
        status,
        outcome,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        costUsd: Number(charged.toFixed(6)),
        spentUsd: Number(spend.spentUsd.toFixed(6)),
        capUsd: spend.capUsd,
        ms: this.now() - started,
      });
    };
    await new Promise<void>((resolve) => {
      const upstream = transport.request(url, { method: "POST", headers }, (response) => {
        const status = response.statusCode ?? 502;
        const outHeaders = { ...response.headers };
        for (const name of ["transfer-encoding", "connection", "set-cookie", "alt-svc"]) delete outHeaders[name];
        res.writeHead(status, outHeaders);
        const parser = new VertexUsageParser(String(response.headers["content-type"] ?? "").includes("event-stream"));
        let ended = false;
        response.on("data", (chunk: Buffer) => {
          parser.push(chunk);
          res.write(chunk);
        });
        response.on("end", () => {
          ended = true;
          res.end();
          const usage = parser.finish();
          if (status >= 400) {
            // A provider error answer is not billed; the client got it as it was.
            release();
            session.refusal = { status, providerErrorType: parser.errorStatus, providerRequestId: null, call: session.calls };
            logger.warn("proxy.provider_refused", { brandId: session.brandId, session: session.key, provider: "vertex", path: url.pathname, status, providerErrorType: parser.errorStatus });
            record(usage, 0, status, "provider_error");
          } else {
            session.refusal = null;
            const cost = parser.seen ? estimateVertexCostUsd(usage, vertex.config.prices) : target.action === "countTokens" ? 0 : null;
            record(usage, settle(cost), status, parser.seen || target.action === "countTokens" ? "ok" : "usage_unknown");
          }
          resolve();
        });
        response.on("error", () => {
          if (ended) return;
          res.destroy();
          const usage = parser.finish();
          // Cut mid-answer: Google bills what it generated, which the last totals may undercount; at least the reservation is charged.
          record(usage, settle(parser.seen ? estimateVertexCostUsd(usage, vertex.config.prices) : null, true), status, "cut");
          resolve();
        });
        res.on("close", () => {
          if (ended || settled) return;
          response.destroy();
          const usage = parser.finish();
          record(usage, settle(parser.seen ? estimateVertexCostUsd(usage, vertex.config.prices) : null, true), status, "client_closed");
          resolve();
        });
      });
      upstream.on("error", (error) => {
        if (settled) { resolve(); return; }
        // Whether Google ran the call is unknown (a lost answer is not proof it did not): the reservation is charged.
        logger.warn("proxy.upstream_error", { brandId: session.brandId, session: session.key, provider: "vertex", ...failureFields(error) });
        record({ model: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, settle(null), 502, "upstream_error");
        this.fail(res, 502, "api_error", "model API unreachable");
        resolve();
      });
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      upstream.end(body);
    });
  }

  /** The request body, or null when it is over 32 MiB. */
  private async readRequest(req: http.IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 32 * 1024 * 1024) chunks.push(chunk); });
      req.on("end", resolve); req.on("error", reject);
    });
    return bytes > 32 * 1024 * 1024 ? null : Buffer.concat(chunks);
  }
}
