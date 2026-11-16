import http from "node:http";
import type { AddressInfo } from "node:net";

import type { Automation, HostAutomations } from "./automations.js";

/**
 * The host API code outside the SDK uses to put schedules and events INTO its automations: a brand VM's zs.schedule.*
 * tools and event emitters, or any service that does not run the SDK. It is a bearer-token API where every token names
 * one tenant (a brand): the tenant of a schedule or an event is the caller's, never a request field, and a caller sees
 * and deletes only the schedules it created (createdBy `external:`), never the host's own routines.
 */

export type ExternalScope = "schedule:read" | "schedule:write" | "event:emit";

export interface ExternalCaller {
  /** The tenant this token belongs to. Everything the caller creates or emits is in it. */
  tenant: string;
  /** Default: all scopes. */
  scopes?: readonly ExternalScope[];
  /** Names the caller in `createdBy` (`external:<label>`); default: the tenant. */
  label?: string;
}

export interface AutomationsApiOptions {
  automations: HostAutomations;
  /** The caller a bearer token belongs to; undefined refuses it (401). The host keeps the tokens (a secret store, per brand). */
  authenticate(token: string): ExternalCaller | undefined | Promise<ExternalCaller | undefined>;
  /** Most schedules one tenant's external callers may hold at once. Default 50. */
  maxSchedulesPerTenant?: number;
  /** Whether a session may be woken by a schedule of this tenant (its tenant label must be the caller's). Without it `targetSessionId` is refused. */
  canTarget?(sessionId: string, tenant: string): boolean | Promise<boolean>;
  /** Biggest request body in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
}

export interface ApiRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const EXTERNAL = "external:";
const EVENT_TYPE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Events the host itself emits: a caller must not be able to forge a finished run (the `after` chain) or a host event. */
const RESERVED_EVENT_PREFIXES = ["session.", "marshal.", "automation.", "host."];
const MAX_PAYLOAD_BYTES = 16 * 1024;
const SCHEDULE_FIELDS = new Set(["name", "description", "prompt", "schedule", "timezone", "runAt", "runInMinutes", "oneShot", "enabled", "targetSessionId", "model", "reasoningEffort"]);
const SCOPES: readonly ExternalScope[] = ["schedule:read", "schedule:write", "event:emit"];

const reply = (status: number, body: unknown): ApiResponse => ({ status, body });
const failure = (status: number, code: string, message: string): ApiResponse => reply(status, { error: { code, message } });

function isExternal(automation: Automation): boolean {
  return automation.createdBy?.startsWith(EXTERNAL) === true;
}

function view(automation: Automation) {
  return {
    id: automation.id,
    name: automation.name,
    description: automation.description,
    prompt: automation.prompt,
    enabled: automation.enabled,
    oneShot: automation.oneShot,
    state: automation.state,
    trigger: automation.trigger,
    ...(automation.targetSessionId ? { targetSessionId: automation.targetSessionId } : {}),
    createdAt: automation.createdAt,
    runs: automation.runs.slice(-5).map((run) => ({ at: run.at, trigger: run.trigger, sessionId: run.sessionId, ...(run.outcome ? { outcome: run.outcome } : {}) })),
  };
}

function bearer(headers: ApiRequest["headers"]): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === "string" ? /^Bearer\s+(\S{8,512})$/i.exec(value) : null;
  return match?.[1];
}

/** The request handler, with no transport: tests and hosts with their own server call it directly. */
export function createAutomationsApi(options: AutomationsApiOptions): (request: ApiRequest) => Promise<ApiResponse> {
  const { automations } = options;
  const cap = options.maxSchedulesPerTenant ?? 50;

  return async (request) => {
    const token = bearer(request.headers);
    if (!token) return failure(401, "unauthorized", "A bearer token is required.");
    const caller = await options.authenticate(token);
    if (!caller || typeof caller.tenant !== "string" || !caller.tenant) return failure(401, "unauthorized", "The token is not valid.");
    const scopes = new Set(caller.scopes ?? SCOPES);
    const need = (scope: ExternalScope): ApiResponse | undefined => (scopes.has(scope) ? undefined : failure(403, "forbidden", `The token does not carry ${scope}.`));
    const method = request.method.toUpperCase();
    const mine = () => automations.list(caller.tenant).filter(isExternal);

    try {
      if (request.path === "/v1/schedules" && method === "GET") {
        return need("schedule:read") ?? reply(200, { schedules: mine().map(view) });
      }
      if (request.path === "/v1/schedules" && method === "POST") {
        const refused = need("schedule:write");
        if (refused) return refused;
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "invalid-request", "A JSON object is required.");
        const unknown = Object.keys(body).filter((key) => !SCHEDULE_FIELDS.has(key));
        if (unknown.length) return failure(400, "invalid-request", `Unknown field ${unknown[0]}.`);
        const input = body as Record<string, unknown>;
        if (input.targetSessionId !== undefined) {
          if (typeof input.targetSessionId !== "string" || !(await options.canTarget?.(input.targetSessionId, caller.tenant))) {
            return failure(403, "forbidden", "That session cannot be woken by this tenant.");
          }
        }
        if (mine().length >= cap) return failure(429, "limit", `A tenant holds at most ${cap} external schedules.`);
        const created = await automations.create(
          { ...(input as object), tenant: caller.tenant } as Parameters<HostAutomations["create"]>[0],
          `${EXTERNAL}${caller.label ?? caller.tenant}`,
        );
        return reply(201, { schedule: view(created) });
      }
      const one = /^\/v1\/schedules\/([A-Za-z0-9._-]{1,128})$/.exec(request.path);
      if (one && method === "DELETE") {
        const refused = need("schedule:write");
        if (refused) return refused;
        const target = automations.get(one[1]!);
        // Another tenant's, a host routine and an unknown id all answer alike.
        if (!target || target.tenant !== caller.tenant || !isExternal(target)) return failure(404, "not-found", "No such schedule.");
        await automations.delete(target.id);
        return reply(200, { deleted: target.id });
      }
      if (request.path === "/v1/events" && method === "POST") {
        const refused = need("event:emit");
        if (refused) return refused;
        const body = request.body as { type?: unknown; payload?: unknown } | undefined;
        const type = body?.type;
        if (typeof type !== "string" || !EVENT_TYPE.test(type)) return failure(400, "invalid-request", "type must be a lowercase event name.");
        if (RESERVED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) return failure(403, "forbidden", `${type} is an event only the host emits.`);
        const payload = body?.payload ?? {};
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return failure(400, "invalid-request", "payload must be an object.");
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) return failure(413, "too-large", "payload is too big.");
        // Labels name the session an event came from and so its tenant; the caller's tenant is the only one that counts.
        const { labels: _labels, parentId: _parentId, ...data } = payload as Record<string, unknown>;
        const started = await automations.emit(type, data, caller.tenant);
        return reply(200, { started: started.length });
      }
      return failure(404, "not-found", "No such route.");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "invalid-request") return failure(400, code, (error as Error).message);
      throw error;
    }
  };
}

export interface AutomationsApiServer {
  url: string;
  close(): Promise<void>;
}

/** The handler over HTTP (JSON in, JSON out), on loopback unless `bind` says otherwise. */
export async function serveAutomationsApi(options: AutomationsApiOptions & { port?: number; bind?: string }): Promise<AutomationsApiServer> {
  const handle = createAutomationsApi(options);
  const limit = options.maxBodyBytes ?? 64 * 1024;
  const server = http.createServer((req, res) => {
    const send = (response: ApiResponse) => {
      const text = JSON.stringify(response.body);
      res.writeHead(response.status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooBig = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return send(failure(413, "too-large", "The request body is too big."));
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(failure(400, "invalid-request", "The body is not JSON."));
        }
      }
      const path = (req.url ?? "/").split("?")[0]!;
      handle({ method: req.method ?? "GET", path, headers: req.headers, body }).then(send, () => send(failure(500, "error", "The request failed.")));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.bind ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
