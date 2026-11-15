// @omer/marshal-sdk-sessions: the sessions a headless Marshal host (marshal-sdk) ran, read inside Marshal.
// Runs -> sessions -> transcript, from the host's session store folders.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { gzipSync } from "node:zlib";

import { VIEW_HTML } from "./generated/view";
import { claudeNativeFile, expandHome, findSession, findStores, readSessions, readTranscript, searchSessions, summarizeRuns } from "./store";

type Row = Record<string, any>;
type JsonSchema = Record<string, unknown>;

const EXTENSION_ID = "@omer/marshal-sdk-sessions";
const APP_ID = "viewer";
const RENDER_ID = "sdksessions.viewer.v1";
const VERSION = "1.0.0";
const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_ROOTS = ["~/marshal/marshal-sdk/.runs"];
const MAX_MESSAGE_CHARS = 20_000;
export const IMPORT_NATIVE_CAPABILITY = "marshal.sessions.importNative";
const IMPORT_NATIVE_PR = "https://github.com/OmerMachluf/marshal/pull/155";
/** Why marshal.sessions.importNative refused, in words for the person who pressed Continue. */
const IMPORT_ERRORS: Record<string, string> = {
  "unsupported-format": "This Marshal can't resume that kind of conversation file.",
  "runtime-unavailable": "Marshal's Claude runtime isn't set up here, so the conversation can't be resumed.",
  "invalid-state": "The conversation file couldn't be read as a Claude session.",
  "invalid-encoding": "The conversation file couldn't be read as a Claude session.",
  "state-too-large": "The conversation file is too large to continue here.",
  "workspace-unavailable": "That workspace isn't available in this Marshal.",
  "already-local": "This session is already in Marshal.",
  "start-failed": "Marshal couldn't start the session.",
};

const ANY: JsonSchema = { type: ["object", "array", "string", "number", "boolean", "null"] };
const OUT: JsonSchema = { type: "object", properties: { result: ANY }, required: ["result"], additionalProperties: false };
const obj = (properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const str: JsonSchema = { type: "string" };
const roots: JsonSchema = { type: "array", items: str, description: "Store folders, or folders to search for state/sessions/index.json. Defaults to the configured roots." };

interface Context {
  configuration: Row;
  execute?: (request: Row, invocation: unknown) => Promise<{ status: string; error?: { code?: string; message?: string }; result?: { output?: any } }>;
}

interface Capability {
  name: string;
  title: string;
  description: string;
  input: JsonSchema;
  read: boolean;
  handler: (input: Row, invocation: unknown) => unknown;
}

export function createExtension(context: Context) {
  const configured = (input: Row): string[] => {
    const fromInput = Array.isArray(input.roots) ? input.roots.filter((root: unknown) => typeof root === "string") : [];
    if (fromInput.length) return fromInput;
    const fromConfig = Array.isArray(context.configuration?.roots) ? context.configuration.roots.filter((root: unknown) => typeof root === "string") : [];
    if (fromConfig.length) return fromConfig;
    const fromEnv = (process.env.MARSHAL_SDK_SESSION_ROOTS ?? "").split(":").filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ROOTS;
  };
  const storesFor = (input: Row) => findStores(configured(input));
  // What the last sdksessions.open asked to show; the view reads it when its own open state is missing.
  let focus: { runId: string | null; sessionId: string | null } = { runId: null, sessionId: null };

  const capabilities: Capability[] = [
    {
      name: "sdksessions.open",
      title: "Open the SDK sessions viewer",
      description: "Open the tab that shows runs of headless Marshal hosts (marshal-sdk), their sessions and transcripts. runId and sessionId preselect.",
      input: obj({ runId: str, sessionId: str, placement: str, roots }),
      read: false,
      handler: async (input, invocation) => {
        if (!context.execute) throw new Error("This Marshal doesn't let extensions open views.");
        focus = {
          runId: typeof input.runId === "string" ? input.runId : null,
          sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
        };
        const response = await context.execute(
          {
            protocolVersion: PROTOCOL_VERSION,
            targetType: "operation",
            target: "ui.application.open",
            input: {
              extensionId: EXTENSION_ID,
              applicationId: APP_ID,
              placement: typeof input.placement === "string" ? input.placement : "chat-tab",
              title: "SDK sessions",
              state: { runId: input.runId ?? null, sessionId: input.sessionId ?? null, roots: input.roots ?? null },
              idempotencyKey: `sdksessions-open-${randomUUID()}`,
            },
          },
          invocation,
        );
        if (response.status !== "success") throw new Error(response.error?.message ?? "ui.application.open failed.");
        const out = (response.result?.output ?? {}) as Row;
        const value = out.ok === true && "value" in out ? out.value : out;
        return { opened: true, instanceId: value?.receipt?.instanceId ?? value?.instance?.instanceId ?? value?.instanceId ?? null };
      },
    },
    {
      name: "sdksessions.runs",
      title: "List SDK runs",
      description: "Runs of headless Marshal hosts found in the session stores: run id, host, when, how many sessions, models, cost.",
      input: obj({ roots }),
      read: true,
      handler: (input) => {
        const stores = storesFor(input);
        return { roots: configured(input).map(expandHome), stores, runs: summarizeRuns(stores), focus };
      },
    },
    {
      name: "sdksessions.sessions",
      title: "List a run's sessions",
      description: "Every session of one run: title, state, model, effort, usage, labels, host, parent and native (Claude) session id.",
      input: obj({ runId: str, roots }, ["runId"]),
      read: true,
      handler: (input) => {
        const runId = String(input.runId);
        const sessions = storesFor(input).flatMap((store) =>
          readSessions(store)
            .filter((session) => session.runId === runId)
            .map((session) => ({ ...session, store })),
        );
        return { runId, sessions: sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt)) };
      },
    },
    {
      name: "sdksessions.transcript",
      title: "Read a session's transcript",
      description: "A session's messages (user, assistant, system) with its record. limit keeps the latest messages.",
      input: obj({ sessionId: str, limit: { type: "integer", minimum: 1, maximum: 500 }, roots }, ["sessionId"]),
      read: true,
      handler: (input) => {
        const found = findSession(storesFor(input), String(input.sessionId));
        if (!found) return { found: false };
        const all = readTranscript(found.store, found.session.id);
        const limit = typeof input.limit === "number" ? input.limit : all.length;
        const messages = all.slice(-limit).map((message) =>
          message.content.length > MAX_MESSAGE_CHARS
            ? { ...message, content: message.content.slice(0, MAX_MESSAGE_CHARS), truncated: message.content.length }
            : message,
        );
        return { found: true, store: found.store, session: found.session, messageCount: all.length, messages };
      },
    },
    {
      name: "sdksessions.continue",
      title: "Continue a session in Marshal",
      description:
        "Open a copy of an SDK session as a new local Marshal session that resumes its Claude conversation (through marshal.sessions.importNative). Answers ok:false with reason unavailable when this Marshal has no import yet.",
      input: obj({ sessionId: str, workspaceName: str, roots }, ["sessionId"]),
      read: false,
      handler: async (input, invocation) => {
        const found = findSession(storesFor(input), String(input.sessionId));
        if (!found) return { ok: false, reason: "not-found", message: "This session is not in the stores any more." };
        if (found.session.state === "running") {
          return { ok: false, reason: "running", message: "This session is still running. Continue it once it is idle." };
        }
        const file = claudeNativeFile(found.session);
        if (!file || !fs.existsSync(file)) {
          return {
            ok: false,
            reason: "no-native-state",
            message: `This session's Claude conversation file isn't on this machine${file ? ` (${file})` : ""}.`,
          };
        }
        if (!context.execute) return unavailable();
        const response = await context.execute(
          {
            protocolVersion: PROTOCOL_VERSION,
            targetType: "operation",
            target: IMPORT_NATIVE_CAPABILITY,
            input: {
              name: found.session.title,
              state: { format: "claude-jsonl", encoding: "gzip-base64", data: gzipSync(fs.readFileSync(file)).toString("base64") },
              ...(typeof input.workspaceName === "string" && input.workspaceName ? { workspaceName: input.workspaceName } : {}),
            },
          },
          invocation,
        );
        if (response.status !== "success") {
          const code = String(response.error?.code ?? "");
          const text = String(response.error?.message ?? "");
          if (code === "not-found" || /was not found|unknown capability/i.test(text)) return unavailable();
          if (/approval/i.test(code)) {
            return { ok: false, reason: "approval", message: "Marshal asked you to approve continuing this session. Approve it, then press Continue in Marshal again." };
          }
          if (/permission|denied/i.test(code)) return { ok: false, reason: "denied", message: "Continuing sessions isn't allowed by your permission settings." };
          return { ok: false, reason: "failed", message: text || "Marshal couldn't continue this session." };
        }
        const out = (response.result?.output ?? {}) as Row;
        if (out.ok === true) return { ok: true, sessionId: out.sessionId, message: "Opened as a new session in Marshal." };
        const error = String(out.error ?? "start-failed");
        return { ok: false, reason: error, message: IMPORT_ERRORS[error] ?? "Marshal couldn't continue this session." };
      },
    },
    {
      name: "sdksessions.search",
      title: "Search SDK sessions",
      description: "Find sessions by words in their title, labels, run id or transcript.",
      input: obj({ query: str, limit: { type: "integer", minimum: 1, maximum: 100 }, roots }, ["query"]),
      read: true,
      handler: (input) => ({
        query: String(input.query),
        hits: searchSessions(storesFor(input), String(input.query), typeof input.limit === "number" ? input.limit : 20).map((hit) => ({
          sessionId: hit.session.id,
          runId: hit.session.runId,
          title: hit.session.title,
          state: hit.session.state,
          host: hit.session.host,
          snippet: hit.snippet,
          score: hit.score,
        })),
      }),
    },
  ];

  const descriptors = capabilities.map((capability) => ({
    protocolVersion: PROTOCOL_VERSION,
    name: capability.name,
    version: VERSION,
    title: capability.title,
    description: capability.description,
    tags: ["marshal-sdk", "sessions", "runs"],
    inputSchema: capability.input,
    outputSchema: OUT,
  }));
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const descriptorByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  const provider = {
    id: EXTENSION_ID,
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => descriptorByName.get(name),
    async invoke(name: string, value: unknown, invocation: unknown) {
      const capability = byName.get(name);
      if (!capability) throw new Error(`Unknown capability "${name}".`);
      const input = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Row;
      try {
        return { output: { result: (await capability.handler(input, invocation)) ?? null } };
      } catch (error) {
        return { output: { result: { ok: false, error: error instanceof Error ? error.message : String(error) } } };
      }
    },
  };

  const action = (capability: Capability) => ({
    id: capability.name.replace(/\./g, "-"),
    version: VERSION,
    title: capability.title,
    target: { kind: "capability", capability: capability.name },
    inputSchema: capability.input,
    outputSchema: OUT,
    allowedScopes: ["session"],
    requiredPermissions: [],
    risk: capability.read ? "read" : "write",
    idempotency: capability.read ? "supported" : "none",
  });

  const uiApplications = [
    {
      id: APP_ID,
      title: "SDK sessions",
      description: "Runs of headless Marshal hosts (marshal-sdk): each run's sessions, their usage and transcripts.",
      renderId: RENDER_ID,
      resource: { uri: "ui://omer/marshal-sdk-sessions/viewer", mimeType: "text/html", text: VIEW_HTML },
      application: {
        version: VERSION,
        presentationModes: ["inline", "fullscreen"],
        tools: [],
        actions: capabilities.filter((capability) => capability.name !== "sdksessions.open").map(action),
      },
      tags: ["marshal-sdk", "sessions"],
      metadata: { "marshal.ui.viewports": ["mobile", "desktop"] },
    },
  ];

  return {
    capabilityProviders: [provider],
    uiApplications,
    uiPlacements: [{ placementId: "nav.primary", applicationId: APP_ID, action: "augment" }],
  };
}

export const CAPABILITY_NAMES = [
  "sdksessions.open",
  "sdksessions.runs",
  "sdksessions.sessions",
  "sdksessions.transcript",
  "sdksessions.continue",
  "sdksessions.search",
];

function unavailable() {
  return {
    ok: false,
    reason: "unavailable",
    message: `This Marshal can't continue a session yet: it has no ${IMPORT_NATIVE_CAPABILITY}. That arrives with ${IMPORT_NATIVE_PR}; after the update and a restart, this button opens the session here.`,
  };
}

export function activate(context: Context) {
  return createExtension(context);
}

export default { activate };
