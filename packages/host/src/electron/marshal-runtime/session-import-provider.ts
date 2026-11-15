import { gunzipSync } from "node:zlib";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
} from "@marshal/runtime";
import { z } from "zod";

import type { CreateFromNativeStateError } from "../../common/marshal-ipc-contract";
import type { RuntimeNativeSessionState } from "../backend/runtime-contract";

export const SESSION_IMPORT_NATIVE_CAPABILITY = "marshal.sessions.importNative";
export const SESSION_IMPORT_NATIVE_PERMISSION = "marshal.sessions.importNative";

export type SessionImportNativeError = CreateFromNativeStateError | "invalid-encoding";

/** What the provider needs from the session manager: `SessionManager.createFromNativeState`. */
export interface SessionImportNativePort {
  createFromNative(request: {
    name: string;
    workspace?: { workspaceName: string };
    state: RuntimeNativeSessionState;
    activate: boolean;
  }): Promise<
    { success: true; sessionId: string } | { success: false; error: CreateFromNativeStateError }
  >;
  /** Shows the new session in the app; making it active in main does not move the renderer. */
  openSession(sessionId: string): void;
}

const MAX_NAME = 200;
/** The input crosses the runtime as JSON; a gzipped conversation of the full native size still fits. */
const MAX_ENCODED_CHARS = 64 * 1024 * 1024;

const input = (maxEncodedChars: number) =>
  z
    .object({
      name: z.string().trim().min(1).max(MAX_NAME),
      state: z
        .object({
          format: z
            .string()
            .regex(/^[a-z][a-z0-9-]{0,63}$/)
            .describe("The runtime's native state format, for example claude-jsonl."),
          encoding: z.enum(["base64", "gzip-base64"]),
          data: z.string().min(1).max(maxEncodedChars),
        })
        .strict(),
      workspaceName: z
        .string()
        .min(1)
        .max(MAX_NAME)
        .optional()
        .describe("A Marshal workspace to place the session in; the default workspace otherwise."),
      open: z.boolean().optional().describe("Switch the app to the new session. Default true."),
    })
    .strict();

const output = z
  .object({
    ok: z.boolean(),
    sessionId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

/**
 * `marshal.sessions.importNative`: a new local session from a runtime's own conversation file (for example a
 * Claude session a headless Marshal host ran), resumed natively, as an organization fork does without the
 * organization. Its permission is routed to the Marshal permission policy (production-adapter.ts).
 */
export function createSessionImportProvider(
  port: SessionImportNativePort,
  maxStateBytes: number,
): CapabilityProvider {
  // Decoding stops at maxStateBytes whatever the encoding, so a small gzip cannot expand past it.
  const schema = input(Math.min(MAX_ENCODED_CHARS, Math.ceil((maxStateBytes * 4) / 3) + 4));
  const descriptor: CapabilityDescriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: SESSION_IMPORT_NATIVE_CAPABILITY,
    version: "1.0.0",
    title: "Continue a conversation file as a local Marshal session",
    description:
      "Create a new local Marshal session from a runtime's native conversation state (format claude-jsonl: a Claude session .jsonl, base64 or gzip+base64) and resume it natively, then open it. Use it to continue a session a headless Marshal host or another machine ran. Fails with ok:false and an error code (unsupported-format, invalid-state, state-too-large, workspace-unavailable, runtime-unavailable, invalid-encoding, start-failed).",
    tags: ["sessions", "import", "continue"],
    inputSchema: z.toJSONSchema(schema),
    outputSchema: z.toJSONSchema(output),
    permissions: [{ permission: SESSION_IMPORT_NATIVE_PERMISSION, risk: "medium" }],
  };
  return {
    id: "marshal.session-import-host",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name) => (name === descriptor.name ? descriptor : undefined),
    invoke: async (name, value) => {
      if (name !== descriptor.name) throw new Error(`Unknown capability ${name}`);
      const request = schema.parse(value);
      const bytes = decode(request.state.encoding, request.state.data, maxStateBytes);
      if (bytes === "invalid") return { output: { ok: false, error: "invalid-encoding" } };
      if (bytes === "too-large") return { output: { ok: false, error: "state-too-large" } };
      const open = request.open !== false;
      const created = await port.createFromNative({
        name: request.name,
        ...(request.workspaceName ? { workspace: { workspaceName: request.workspaceName } } : {}),
        state: { format: request.state.format, bytes },
        activate: open,
      });
      if (!created.success) return { output: { ok: false, error: created.error } };
      if (open) port.openSession(created.sessionId);
      return { output: { ok: true, sessionId: created.sessionId } };
    },
  };
}

function decode(
  encoding: "base64" | "gzip-base64",
  data: string,
  maxBytes: number,
): Uint8Array | "invalid" | "too-large" {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return "invalid";
  const raw = Buffer.from(data, "base64");
  if (raw.byteLength === 0) return "invalid";
  if (encoding === "base64") return raw.byteLength > maxBytes ? "too-large" : new Uint8Array(raw);
  try {
    return new Uint8Array(gunzipSync(raw, { maxOutputLength: maxBytes }));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "invalid";
  }
}
