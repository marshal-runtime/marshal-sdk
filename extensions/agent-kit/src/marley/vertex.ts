import * as fs from "node:fs";
import * as path from "node:path";

import type { Logger } from "./logger.js";
import type { Usage } from "./proxy.js";

/** config.ts parseModelId's shape, kept here so config.ts can import this module without a cycle. */
const parseModelId = (raw: string): string | null => (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw) ? raw : null);

/**
 * Vertex AI (Gemini) behind the model proxy, for a model runtime that runs on the brand VM (the Antigravity bridge): the VM gets a loopback base URL
 * and a per-session key, never a Google credential. The proxy authenticates the key, allows a fixed set of model paths, strips every client
 * credential header, adds this server's own token, charges the call's estimated cost to a cumulative spend ledger and refuses every call once that
 * ledger reaches its cap. Off unless VERTEX_PROJECT is set; production sets none of these.
 */
export interface VertexConfig {
  project: string;
  /** `global` (aiplatform.googleapis.com) or a region (`<region>-aiplatform.googleapis.com`). */
  location: string;
  /** The only model ids a session may call. */
  models: readonly string[];
  /** Hard cap in USD on the cumulative estimated spend of every Vertex call this server made (persisted in `spendFile`). */
  spendCapUsd: number;
  /** Held against the cap while a call is in flight, and charged when the call's real usage is unknown. */
  reserveUsd: number;
  prices: VertexPrices;
  spendFile: string;
  /** An authorized_user ADC file (the local stack); null: this server's metadata-server token. */
  adcFile: string | null;
}

/** USD per million tokens. Estimates the operator sets (VERTEX_PRICES_PER_MTOK), not a price list: Google's real bill is the authority. */
export interface VertexPrices {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Gemini 4 Neon defaults: an ESTIMATE for the spend cap ($3 input, $0.15 cached input, $15 output and thinking per million tokens). Change it with
 * VERTEX_PRICES_PER_MTOK="input,cached,output" when Google's published price differs.
 */
export const DEFAULT_VERTEX_PRICES: VertexPrices = { input: 3, cachedInput: 0.15, output: 15 };
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^(global|[a-z]+-[a-z]+[0-9]{1,2})$/;

/** VERTEX_* settings; null when VERTEX_PROJECT is unset. A malformed setting fails startup naming the setting only. */
export function parseVertexConfig(env: Record<string, string | undefined>, stateDir: string): VertexConfig | null {
  const project = env.VERTEX_PROJECT?.trim() ?? "";
  if (!project) return null;
  if (!PROJECT.test(project)) throw new Error("VERTEX_PROJECT must be a GCP project id");
  const location = env.VERTEX_LOCATION?.trim() || "global";
  if (!LOCATION.test(location)) throw new Error("VERTEX_LOCATION must be global or a region");
  const modelsRaw = env.VERTEX_MODELS?.trim() || "gemini-4-neon";
  const models = modelsRaw.split(",").map((item) => item.trim());
  if (models.length === 0 || models.length > 8 || models.some((model) => parseModelId(model) !== model || !model.startsWith("gemini-") || model.includes(".."))) {
    throw new Error("VERTEX_MODELS must be 1 to 8 gemini-* model ids");
  }
  const cap = Number(env.VERTEX_SPEND_CAP_USD?.trim() ?? "");
  // A Vertex proxy without a cap is refused: the cap is the only bound on pay-per-token spend.
  if (!env.VERTEX_SPEND_CAP_USD?.trim() || !Number.isFinite(cap) || cap <= 0 || cap > 10_000) throw new Error("VERTEX_SPEND_CAP_USD must be a positive number up to 10000 when VERTEX_PROJECT is set");
  const reserveRaw = env.VERTEX_CALL_RESERVE_USD?.trim();
  const reserve = reserveRaw ? Number(reserveRaw) : 2;
  if (!Number.isFinite(reserve) || reserve <= 0 || reserve > cap) throw new Error("VERTEX_CALL_RESERVE_USD must be a positive number not above the cap");
  let prices = DEFAULT_VERTEX_PRICES;
  const pricesRaw = env.VERTEX_PRICES_PER_MTOK?.trim();
  if (pricesRaw) {
    const parts = pricesRaw.split(",").map((item) => Number(item.trim()));
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value) || value < 0 || value > 1000)) throw new Error("VERTEX_PRICES_PER_MTOK must be input,cached,output in USD per million tokens");
    prices = { input: parts[0]!, cachedInput: parts[1]!, output: parts[2]! };
  }
  const spendFile = env.VERTEX_SPEND_FILE?.trim() || path.join(stateDir, "vertex-spend.json");
  if (!path.isAbsolute(spendFile)) throw new Error("VERTEX_SPEND_FILE must be an absolute path");
  const adcFile = env.VERTEX_ADC_FILE?.trim() || null;
  if (adcFile !== null && !path.isAbsolute(adcFile)) throw new Error("VERTEX_ADC_FILE must be an absolute path");
  return { project, location, models, spendCapUsd: cap, reserveUsd: reserve, prices, spendFile, adcFile };
}

/** The Vertex endpoint of one allowed call; the host is fixed by the location, never by the request. */
export function vertexUpstreamUrl(config: Pick<VertexConfig, "project" | "location">, model: string, action: VertexAction, sse: boolean): string {
  const host = config.location === "global" ? "aiplatform.googleapis.com" : `${config.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${config.project}/locations/${config.location}/publishers/google/models/${model}:${action}${sse ? "?alt=sse" : ""}`;
}

export type VertexAction = "streamGenerateContent" | "generateContent" | "countTokens";
const VERTEX_PATH = /^\/vertex\/v1beta1\/publishers\/google\/models\/([a-z0-9][a-z0-9.-]{0,62}):(streamGenerateContent|generateContent|countTokens)$/;

/**
 * Parses the raw request target of a Vertex call. Only `/vertex/v1beta1/publishers/google/models/<allowed model>:<action>` with no query, or with
 * exactly `alt=sse` on streamGenerateContent. Anything else (another resource, an encoded character, a dot segment, an extra parameter) is null.
 */
export function parseVertexTarget(rawUrl: string, models: readonly string[]): { model: string; action: VertexAction; sse: boolean } | null {
  if (rawUrl.length > 512 || /[%\\]/.test(rawUrl)) return null;
  const query = rawUrl.indexOf("?");
  const pathname = query < 0 ? rawUrl : rawUrl.slice(0, query);
  const search = query < 0 ? null : rawUrl.slice(query + 1);
  const match = VERTEX_PATH.exec(pathname);
  if (!match) return null;
  const model = match[1]!;
  const action = match[2] as VertexAction;
  if (model.includes("..") || !models.includes(model)) return null;
  if (search !== null && !(search === "alt=sse" && action === "streamGenerateContent")) return null;
  return { model, action, sse: search === "alt=sse" };
}

/** Top-level request fields a generate or count call may carry. `cachedContent` (a resource name in this project), `labels` and anything else are refused. */
const BODY_FIELDS = new Set(["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"]);
/** Tool kinds a call may declare: function declarations only (no retrieval against a datastore of this project, no billed search grounding). */
const TOOL_FIELDS = new Set(["functionDeclarations"]);

/** Why the body may not be forwarded with this server's credential, or null when it may. */
export function vertexBodyRefusal(body: Buffer): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return "request is not JSON"; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "request is not a JSON object";
  for (const key of Object.keys(parsed)) if (!BODY_FIELDS.has(key)) return `field ${key.slice(0, 40)} is not allowed`;
  const tools = (parsed as { tools?: unknown }).tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return "tools must be a list";
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "a tool must be an object";
      for (const key of Object.keys(tool)) if (!TOOL_FIELDS.has(key)) return `tool ${key.slice(0, 40)} is not allowed`;
    }
  }
  return null;
}

/** Estimated USD of one call from its Vertex usage (Usage: input excludes cached tokens; output includes thinking tokens). */
export function estimateVertexCostUsd(usage: Usage, prices: VertexPrices): number {
  return (usage.inputTokens * prices.input + usage.cacheReadTokens * prices.cachedInput + usage.outputTokens * prices.output) / 1_000_000;
}

/** Collects `usageMetadata` from a Vertex response (SSE `data:` lines, a JSON object or a JSON array of chunks) without keeping its content. */
export class VertexUsageParser {
  readonly usage: Usage = { model: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  /** True once a usageMetadata block was read. */
  seen = false;
  errorStatus: string | null = null;
  private tail = "";
  private body: Buffer[] = [];
  private bodyBytes = 0;

  constructor(private readonly sse: boolean) {}

  push(chunk: Buffer): void {
    if (!this.sse) {
      if (this.bodyBytes < 8 * 1024 * 1024) { this.body.push(chunk); this.bodyBytes += chunk.length; }
      return;
    }
    this.tail += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.tail.indexOf("\n")) >= 0) {
      this.line(this.tail.slice(0, newline).trim());
      this.tail = this.tail.slice(newline + 1);
    }
    // A line longer than 8 MiB is not a usage line worth keeping in memory.
    if (this.tail.length > 8 * 1024 * 1024) this.tail = "";
  }

  finish(): Usage {
    if (this.sse) this.line(this.tail.trim());
    else {
      try {
        const value = JSON.parse(Buffer.concat(this.body).toString("utf8")) as unknown;
        for (const item of Array.isArray(value) ? value : [value]) this.apply(item);
      } catch { /* not a response body */ }
    }
    return this.usage;
  }

  private line(text: string): void {
    if (!text.startsWith("data:")) return;
    try { this.apply(JSON.parse(text.slice(5).trim()) as unknown); } catch { /* partial or non-JSON event */ }
  }

  private apply(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const chunk = value as { modelVersion?: unknown; usageMetadata?: Record<string, unknown>; error?: { status?: unknown } };
    if (typeof chunk.error?.status === "string") this.errorStatus = chunk.error.status.slice(0, 64);
    if (typeof chunk.modelVersion === "string") this.usage.model = chunk.modelVersion.slice(0, 64);
    const meta = chunk.usageMetadata;
    if (!meta || typeof meta !== "object") return;
    const count = (name: string): number => {
      const raw = meta[name];
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
    };
    // Each streamed chunk carries the running totals: the latest block wins, never a sum.
    const prompt = count("promptTokenCount");
    const cached = Math.min(count("cachedContentTokenCount"), prompt);
    this.usage.inputTokens = prompt - cached;
    this.usage.cacheReadTokens = cached;
    this.usage.outputTokens = count("candidatesTokenCount") + count("thoughtsTokenCount") + count("toolUsePromptTokenCount");
    this.seen = true;
  }
}

export interface VertexSpendSnapshot {
  spentUsd: number;
  reservedUsd: number;
  capUsd: number;
  calls: number;
}

/**
 * The cumulative Vertex spend against a hard cap, persisted so a restart keeps it. One server process owns the file. A call reserves `reserveUsd`
 * before it is forwarded (refused when spent plus every reservation plus this one would pass the cap) and settles with its estimated cost, or with
 * the reservation when its usage is unknown. The ledger fails closed: an unreadable file at start throws, and a failed write refuses every later call.
 * Known limit: a single call costing more than its reservation can pass the cap by that difference, never more than the calls then in flight.
 */
export class VertexSpendCap {
  private spent = 0;
  private reserved = 0;
  private calls = 0;
  private broken: string | null = null;

  /** `logger`: where a failed ledger write is reported, once, when it happens (every later call is then refused with 402). */
  constructor(private readonly options: { capUsd: number; reserveUsd: number; file: string | null; now?: () => number; logger?: Pick<Logger, "error"> }) {
    if (!options.file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(options.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("vertex spend ledger is unreadable");
    }
    const parsed = (() => { try { return JSON.parse(raw) as { spentUsd?: unknown; calls?: unknown }; } catch { return null; } })();
    if (!parsed || typeof parsed.spentUsd !== "number" || !Number.isFinite(parsed.spentUsd) || parsed.spentUsd < 0) throw new Error("vertex spend ledger is malformed");
    this.spent = parsed.spentUsd;
    this.calls = typeof parsed.calls === "number" && Number.isSafeInteger(parsed.calls) && parsed.calls >= 0 ? parsed.calls : 0;
  }

  snapshot(): VertexSpendSnapshot {
    return { spentUsd: this.spent, reservedUsd: this.reserved, capUsd: this.options.capUsd, calls: this.calls };
  }

  /** Why no call may start now, or null after the call's reservation was taken (synchronously, so two calls cannot both pass one check). */
  reserve(): string | null {
    if (this.broken) return this.broken;
    if (this.spent + this.reserved + this.options.reserveUsd > this.options.capUsd) return `vertex spend cap reached (spent ${this.spent.toFixed(4)} of ${this.options.capUsd} USD)`;
    this.reserved += this.options.reserveUsd;
    return null;
  }

  /**
   * Ends a reserved call: charges `costUsd`, or the reservation itself when the cost is unknown (null). `atLeastReserve`: a call cut before its
   * final totals, charged the larger of what was seen and the reservation.
   */
  settle(costUsd: number | null, atLeastReserve = false): number {
    this.reserved = Math.max(0, this.reserved - this.options.reserveUsd);
    const known = costUsd !== null && Number.isFinite(costUsd) && costUsd >= 0;
    const charged = !known ? this.options.reserveUsd : atLeastReserve ? Math.max(costUsd, this.options.reserveUsd) : costUsd;
    this.spent += charged;
    this.calls += 1;
    this.persist();
    return charged;
  }

  /** Ends a reserved call that certainly cost nothing (refused before it was sent, or a provider error answer). */
  release(): void {
    this.reserved = Math.max(0, this.reserved - this.options.reserveUsd);
  }

  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ spentUsd: this.spent, calls: this.calls, capUsd: this.options.capUsd, updatedAt: new Date((this.options.now ?? Date.now)()).toISOString() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (error) {
      // A spend that cannot be recorded cannot be bounded: every later call is refused until the server restarts with a readable ledger.
      if (!this.broken) this.options.logger?.error("vertex.spend_ledger_write_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown", spentUsd: this.spent, calls: this.calls, capUsd: this.options.capUsd });
      this.broken = "vertex spend ledger could not be written";
    }
  }
}

/** A Google access token for this server only. Never handed to a VM, a prompt or a log. */
export interface VertexAuth {
  headers(): Promise<Record<string, string>>;
}

/** This server's metadata-server token (production and staging pods): the existing TokenSource. */
export function tokenSourceAuth(tokens: { accessToken(): Promise<string> }): VertexAuth {
  return { headers: async () => ({ authorization: `Bearer ${await tokens.accessToken()}` }) };
}

/**
 * An `authorized_user` ADC file (the local stack's agent-server container mounts the operator's, read-only): a refresh token exchanged for a short
 * access token, cached until a minute before expiry. `x-goog-user-project` is always the configured Vertex project, never the file's own quota
 * project, so quota and billing land on the project the cap was authorized for. Other credential types are refused (no service-account key file).
 */
export function adcFileAuth(file: string, project: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): VertexAuth {
  if (!PROJECT.test(project)) throw new Error("vertex project is invalid");
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  const read = (): { clientId: string; clientSecret: string; refreshToken: string } => {
    let parsed: { type?: unknown; client_id?: unknown; client_secret?: unknown; refresh_token?: unknown };
    const raw = fs.readFileSync(file, "utf8");
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // A fixed message: JSON.parse's own quotes part of the input, which holds the refresh token and client secret, and it would reach the logs.
      throw new Error("VERTEX_ADC_FILE is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("VERTEX_ADC_FILE must be an authorized_user credentials file");
    if (parsed.type !== "authorized_user" || typeof parsed.client_id !== "string" || typeof parsed.client_secret !== "string" || typeof parsed.refresh_token !== "string") {
      throw new Error("VERTEX_ADC_FILE must be an authorized_user credentials file");
    }
    return { clientId: parsed.client_id, clientSecret: parsed.client_secret, refreshToken: parsed.refresh_token };
  };
  const mint = async (): Promise<string> => {
    const creds = read();
    const response = await fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`vertex token refresh failed: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") throw new Error("vertex token refresh answered without a token");
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return body.access_token;
  };
  return {
    async headers() {
      let token: string;
      if (cached && cached.expiresAt - 60_000 > now()) token = cached.token;
      else {
        pending ??= mint().finally(() => { pending = null; });
        token = await pending;
      }
      return { authorization: `Bearer ${token}`, "x-goog-user-project": project };
    },
  };
}
