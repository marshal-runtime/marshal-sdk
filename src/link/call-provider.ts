import { RUNTIME_PROTOCOL_VERSION, type CapabilityProvider } from "@marshal/runtime";

import { HOST_ROOM_ROUTES, type LinkRelay } from "../org-host-room.js";

export const LINK_CALL_CAPABILITY = "marshal.link.call";

const descriptor = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  name: LINK_CALL_CAPABILITY,
  version: "1.0.0",
  title: "Call this host's link API in process",
  description:
    "One link v1 request (docs/link.md) answered by this host without HTTP exposure: GET /v1/info, /v1/sessions[/:id[/transcript|telemetry|native]], /v1/runs, /v1/files[/read], /v1/decisions; POST /v1/sessions/:id/messages|cancel, /v1/decisions/:id/answer. Answers {status, body} or {status, error: {code, message}}. The org extension relays rooms requests through it.",
  tags: ["marshal-sdk", "link", "host"],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["method", "path"],
    properties: {
      method: { enum: ["GET", "POST"] },
      path: { type: "string", minLength: 1, maxLength: 1024 },
      query: { type: "object", additionalProperties: { type: "string" } },
      body: {},
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "integer" },
      body: {},
      error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
    },
  },
  permissions: [{ permission: LINK_CALL_CAPABILITY, risk: "medium" as const }],
};

/**
 * `marshal.link.call`: the link API (src/link/server.ts) in process, on the routes the host room offers. `relay` is
 * resolved per call because the host's link starts after its extensions activate.
 */
export function createLinkCallProvider(relay: () => LinkRelay | undefined): CapabilityProvider {
  return {
    id: "marshal.link-call",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name: string) => (name === LINK_CALL_CAPABILITY ? descriptor : undefined),
    invoke: async (name: string, value: unknown) => {
      if (name !== LINK_CALL_CAPABILITY) throw new Error(`Unknown capability ${name}`);
      const input = (value ?? {}) as { method?: string; path?: string; query?: Record<string, string>; body?: unknown };
      const method = input.method === "POST" ? "POST" : "GET";
      const path = String(input.path ?? "");
      if (!HOST_ROOM_ROUTES.some((route) => route.method === method && route.pattern.test(path))) {
        return { output: { status: 404, error: { code: "not-found", message: `No offered link route ${method} ${path}.` } } };
      }
      const call = relay();
      if (!call) return { output: { status: 503, error: { code: "unavailable", message: "This host's link is not ready yet." } } };
      const answer = await call({ method, path, ...(input.query ? { query: input.query } : {}), ...(input.body !== undefined ? { body: input.body } : {}) });
      return { output: { status: answer.status, ...(answer.error ? { error: answer.error } : { body: answer.body ?? null }) } };
    },
  } as unknown as CapabilityProvider;
}
