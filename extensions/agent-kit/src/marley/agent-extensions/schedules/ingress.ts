import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import type { SecretProvider } from "../../gcp.js";
import { type Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import { EventBody, type EventBus } from "./events.js";

export const EVENTS_PATH = "/zs/events/v1";
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_CACHE_MS = 60_000;
const MIN_TOKEN_LENGTH = 16;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** True for loopback and private (VPC) addresses, including the IPv4-mapped IPv6 form. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (ip === "::1") return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface IngressDeps {
  bus: EventBus;
  secrets: SecretProvider;
  tokenSecret: string;
  host: string;
  port: number;
  logger: Logger;
  now?: () => number;
  personaRoutes?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  /** Whether this environment has the brand (true/false), or null when that cannot be told. A false brand's event is ignored. */
  brandKnown?: (brandId: string) => Promise<boolean | null>;
}

/**
 * POST /zs/events/v1: other services in the VPC (the data pipeline) tell the agent server that something happened.
 * Three gates, all closed by default: the caller's address must be private, the bearer token must match the secret
 * `zs-events-token`, and that secret must exist. Until the secret exists every request answers 503.
 */
export class EventsIngress {
  private server: http.Server | null = null;
  private bound: number | null = null;
  private token: { value: string | null; at: number } | null = null;
  private paused = false;

  pause(paused: boolean): void {
    this.paused = paused;
  }

  constructor(private readonly deps: IngressDeps) {}

  port(): number | null {
    return this.bound;
  }

  async listen(port: number = this.deps.port): Promise<number> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.deps.host, resolve);
    });
    this.server = server;
    this.bound = (server.address() as AddressInfo).port;
    return this.bound;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.bound = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async expectedToken(): Promise<string | null> {
    const now = (this.deps.now ?? Date.now)();
    if (this.token && now - this.token.at < TOKEN_CACHE_MS) return this.token.value;
    let value: string | null = null;
    try {
      const raw = (await this.deps.secrets.get(this.deps.tokenSecret))?.trim() ?? "";
      value = raw.length >= MIN_TOKEN_LENGTH && !/^(placeholder|changeme|todo|unset)/i.test(raw) ? raw : null;
    } catch (error) {
      this.deps.logger.warn("events_ingress.secret_unreadable", { ...failureFields(error) });
    }
    this.token = { value, at: now };
    return value;
  }

  private async brandKnown(brandId: string): Promise<boolean | null> {
    if (!this.deps.brandKnown) return null;
    try {
      return await this.deps.brandKnown(brandId.toLowerCase());
    } catch (error) {
      this.deps.logger.warn("events_ingress.brand_lookup_failed", { brandId, ...failureFields(error) });
      return null;
    }
  }

  private send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.paused && await this.deps.personaRoutes?.(req, res)) return;
      const { status, body } = await this.process(req);
      this.send(res, status, body);
    } catch (error) {
      if (error instanceof HttpError) return this.send(res, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
      this.deps.logger.error("events_ingress.failed", { ...failureFields(error) });
      this.send(res, 500, { error: "internal_error" });
    } finally {
      req.resume();
    }
  }

  private async process(req: http.IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    if (this.paused) throw new HttpError(503, "draining");
    if (req.url?.split("?")[0] !== EVENTS_PATH) throw new HttpError(404, "not_found");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    if (!isPrivateAddress(req.socket.remoteAddress)) {
      this.deps.logger.warn("events_ingress.refused_address", {});
      throw new HttpError(403, "forbidden");
    }
    const expected = await this.expectedToken();
    if (!expected) throw new HttpError(503, "not_configured");
    const presented = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(presented), digest(expected))) {
      this.deps.logger.warn("events_ingress.unauthorized");
      throw new HttpError(401, "unauthorized");
    }
    const raw = await readBody(req);
    if (this.paused) throw new HttpError(503, "draining");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_request");
    }
    const parsed = EventBody.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(400, "bad_input", parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
    }
    // Composer sends brand data events to every environment's agent server (the data is shared, the brands are not), so an event
    // of a brand this server does not have is normal: answer 200, record and run nothing. An unknown answer (directory down, or no
    // brand at all) keeps the old path, so a database blip never drops a real brand's event.
    const known = await this.brandKnown(parsed.data.brandId);
    if (known === false) {
      this.deps.logger.info("event.ignored_unknown_brand", { brandId: parsed.data.brandId, event: parsed.data.event, eventId: parsed.data.id ?? null });
      return { status: 200, body: { eventId: parsed.data.id ?? null, accepted: false, matched: 0, ignored: "unknown_brand" } };
    }
    const { eventId, accepted, matched } = this.deps.bus.receiveBody(parsed.data);
    return { status: accepted ? 202 : 200, body: { eventId, accepted, matched } };
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
