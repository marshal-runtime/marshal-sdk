import { VOICE_CATALOG_SCHEMA, type VoiceCatalog, type VoiceSelection, type OutboundMessage, type ReplyButtonsContent, type TemplateContent } from "@zygstinct/shared";

import type { FetchFn, TokenSource } from "./gcp.js";

export type MediaSendType = "image" | "document" | "audio" | "video";

/** A body for the gateway's POST /v1/send. A body without `type` is a text message. */
export type OutboundRequest = Omit<OutboundMessage, "text"> &
  (
    | { type?: "text"; text: string }
    | { type: "reaction"; messageId: string; emoji: string }
    | ReplyButtonsContent
    | TemplateContent
    | { type: MediaSendType; uri: string; caption?: string; filename?: string }
    | { type: "voice"; text: string; language?: string; voice?: VoiceSelection }
  );

export type BeforeDispatch = () => void | Promise<void>;
export interface Sender {
  /** Await after async setup before every dispatch/retry; any guard failure is terminal for this send. */
  send(message: OutboundRequest, beforeDispatch?: BeforeDispatch): Promise<{ messageId: string }>;
}

/** Only a Node errno or the error name of a transport failure: its message can quote a URL or a provider's text. */
function causeLabel(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z]{2,40}$/.test(name) ? name : "unknown";
}

/** A gateway reason is a short snake_case code; anything else is replaced, since it reaches the error message and the logs. */
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

export class DispatchBlockedError extends Error {}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** The gateway's `reason` for a refusal (for example `send_outcome_unknown`), when its answer named one. */
    readonly reason?: string,
    /** The gateway's own `retryable` flag when its answer carried one: false means repeating the same request cannot change the answer (a key reused for a different message). */
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "GatewayError";
  }
  /** True when an earlier attempt of the same send got no answer or a server error before this answer: that attempt may have gone out, whatever this answer says. */
  afterLostAttempt = false;
}

export interface GatewayOptions {
  url: string;
  tokens: TokenSource;
  fetchFn?: FetchFn;
  retries?: number;
  /** How long one request may take (default 20 s). */
  timeoutMs?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** POST /v1/send on the channel gateway with a Google ID token. Retries network errors and 5xx; the idempotency key makes retries safe. */
export class GatewayClient implements Sender {
  private readonly fetchFn: FetchFn;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GatewayOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.retries = options.retries ?? 3;
    this.backoffMs = options.backoffMs ?? 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async voiceCatalog(): Promise<VoiceCatalog> {
    if (!this.options.url) throw new GatewayError("gateway url is not configured", null);
    const token = await this.options.tokens.idToken(this.options.url);
    const response = await this.fetchFn(`${this.options.url}/v1/voices`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new GatewayError("voice catalog unavailable", response.status);
    return VOICE_CATALOG_SCHEMA.parse(await response.json());
  }

  async send(message: OutboundRequest, beforeDispatch?: BeforeDispatch): Promise<{ messageId: string }> {
    if (!this.options.url) throw new GatewayError("gateway url is not configured", null);
    let last: GatewayError | null = null;
    let lost = false;
    const refused = (error: GatewayError): GatewayError => { if (lost) error.afterLostAttempt = true; return error; };
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      let checkingGuard = false;
      try {
        const token = await this.options.tokens.idToken(this.options.url);
        checkingGuard = true;
        await beforeDispatch?.();
        checkingGuard = false;
        const response = await this.fetchFn(`${this.options.url}/v1/send`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { messageId?: string };
          return { messageId: body.messageId ?? "" };
        }
        const answer = await response.json().then((body: { reason?: unknown; retryable?: unknown }) => ({
          reason: typeof body?.reason === "string" ? (REASON_PATTERN.test(body.reason) ? body.reason : "unknown") : undefined,
          retryable: typeof body?.retryable === "boolean" ? body.retryable : undefined,
        }), () => ({ reason: undefined, retryable: undefined }));
        const { reason, retryable } = answer;
        last = new GatewayError(`gateway send failed: HTTP ${response.status}${reason ? ` (${reason})` : ""}`, response.status, reason, retryable);
        if (response.status >= 500) lost = true;
        if (response.status < 500 && response.status !== 429) throw refused(last);
      } catch (error) {
        if (checkingGuard || error instanceof DispatchBlockedError) throw error;
        if (error instanceof GatewayError && error.status !== null && error.status < 500 && error.status !== 429) throw error;
        if (!(error instanceof GatewayError)) lost = true;
        last = error instanceof GatewayError ? error : new GatewayError(`gateway send failed: no answer (${causeLabel(error)})`, null);
      }
    }
    throw last ? refused(last) : new GatewayError("gateway send failed", null);
  }
}

const MAX_CHUNK = 3800;

/** Splits a reply into WhatsApp-sized messages at paragraph, then line, then space boundaries. */
export function splitReply(text: string, max: number = MAX_CHUNK): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
