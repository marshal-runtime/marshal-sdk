// @omer/marshal-sdk-sessions: runs of headless Marshal hosts (marshal-sdk) inside Marshal.
// Hosts -> runs -> sessions -> transcript, telemetry and files, from local folders or linked hosts (docs/link.md).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { VIEW_HTML } from "./generated/view";
import { configuredLinks, folderHost, linkedHost, linkProblem, LOCAL_HOST_ID, type Host } from "./hosts";
import { expandHome } from "./store";

type Row = Record<string, any>;
type JsonSchema = Record<string, unknown>;

const EXTENSION_ID = "@omer/marshal-sdk-sessions";
const APP_ID = "viewer";
const RENDER_ID = "sdksessions.viewer.v1";
const VERSION = "1.0.0";
const PROTOCOL_VERSION = "1.0.0";
const DEFAULT_ROOTS = ["~/marshal/marshal-sdk/.runs", "~/marshal/marshal-sdk/.pulled"];
const PULL_ROOT = "~/marshal/marshal-sdk/.pulled";
const PAGE = 500;
export const IMPORT_NATIVE_CAPABILITY = "marshal.sessions.importNative";
const IMPORT_NATIVE_PR = "https://github.com/OmerMachluf/marshal/pull/155";
const HOW_TO_ADD =
  'Add a linked host with runtimeConfigureExtension {identity: "@omer/marshal-sdk-sessions", configuration: {roots?, hosts: [{id, name, url, token or tokenFile}]}} (keep the hosts already there; a token is only ever shown as its last four characters).';
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
const int = (minimum: number, maximum: number): JsonSchema => ({ type: "integer", minimum, maximum });
const bool: JsonSchema = { type: "boolean" };
const hostId: JsonSchema = { type: "string", description: 'Host id from sdksessions.hosts: "local" (folders on this Mac, the default) or a linked host.' };
const roots: JsonSchema = { type: "array", items: str, description: "Folders for the local host instead of the configured roots." };

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
  const configuredRoots = (input: Row): string[] => {
    const pick = (value: unknown) => (Array.isArray(value) ? value.filter((root): root is string => typeof root === "string") : []);
    const fromInput = pick(input.roots);
    if (fromInput.length) return fromInput;
    const fromConfig = pick(context.configuration?.roots);
    if (fromConfig.length) return fromConfig;
    const fromEnv = (process.env.MARSHAL_SDK_SESSION_ROOTS ?? "").split(":").filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ROOTS;
  };
  const links = configuredLinks(context.configuration);
  const linked = new Map(links.hosts.map((config) => [config.id, linkedHost(config)]));
  const allHosts = (input: Row): Host[] => [folderHost(configuredRoots(input)), ...linked.values()];
  const hostFor = (input: Row): Host => {
    const id = typeof input.hostId === "string" && input.hostId ? input.hostId : LOCAL_HOST_ID;
    if (id === LOCAL_HOST_ID) return folderHost(configuredRoots(input));
    const host = linked.get(id);
    if (!host) throw new Error(`No host "${id}". Hosts: ${[LOCAL_HOST_ID, ...linked.keys()].join(", ")}. ${HOW_TO_ADD}`);
    return host;
  };
  // What the last sdksessions.open asked to show; the view reads it when its own open state is missing.
  let focus: { hostId: string; runId: string | null; sessionId: string | null; tab: string | null; filesRoot?: string; filesPath?: string } = {
    hostId: LOCAL_HOST_ID,
    runId: null,
    sessionId: null,
    tab: null,
  };

  const importNative = async (name: string, state: Row, workspaceName: unknown, invocation: unknown) => {
    if (!context.execute) return unavailable();
    const response = await context.execute(
      {
        protocolVersion: PROTOCOL_VERSION,
        targetType: "operation",
        target: IMPORT_NATIVE_CAPABILITY,
        input: { name, state, ...(typeof workspaceName === "string" && workspaceName ? { workspaceName } : {}) },
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
  };

  const capabilities: Capability[] = [
    {
      name: "sdksessions.open",
      title: "Open the SDK sessions viewer",
      description: "Open the tab that shows hosts running marshal-sdk (local folders and linked hosts), their runs, sessions, transcripts, telemetry and files. hostId, runId, sessionId and tab preselect.",
      input: obj({ hostId, runId: str, sessionId: str, tab: { type: "string", enum: ["transcript", "telemetry", "files"] }, filesRoot: str, filesPath: str, placement: str, roots }),
      read: false,
      handler: async (input, invocation) => {
        if (!context.execute) throw new Error("This Marshal doesn't let extensions open views.");
        focus = {
          hostId: typeof input.hostId === "string" ? input.hostId : LOCAL_HOST_ID,
          runId: typeof input.runId === "string" ? input.runId : null,
          sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
          tab: typeof input.tab === "string" ? input.tab : null,
          ...(typeof input.filesRoot === "string" ? { filesRoot: input.filesRoot, filesPath: typeof input.filesPath === "string" ? input.filesPath : "" } : {}),
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
              state: { ...focus, roots: input.roots ?? null },
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
      name: "sdksessions.hosts",
      title: "List SDK hosts",
      description:
        "Hosts this viewer reads: local (session stores in folders on this Mac) and every linked host (a marshal-sdk serving the link): online or not, live or store-only, SDK version, extensions, capability names, file roots, runs. Tokens show only their last four characters.",
      input: obj({ roots }),
      read: true,
      handler: async (input) => {
        const hosts = await Promise.all(
          allHosts(input).map(async (host) => {
            const info = await host.info();
            return { ...host.summary, ...info, ...(info.host ? { remote: info.host } : {}), host: undefined };
          }),
        );
        return { hosts, focus, problems: links.problems, howToAdd: HOW_TO_ADD };
      },
    },
    {
      name: "sdksessions.runs",
      title: "List SDK runs",
      description: "Runs on one host (hostId), or on every host when hostId is absent: run id, host, when, sessions, models, cost. Each run carries its hostId.",
      input: obj({ hostId, roots }),
      read: true,
      handler: async (input) => {
        const hosts = typeof input.hostId === "string" && input.hostId ? [hostFor(input)] : allHosts(input);
        const runs: Row[] = [];
        const problems: Row[] = [];
        for (const host of hosts) {
          try {
            for (const run of await host.runs()) runs.push({ ...run, hostId: host.summary.id });
          } catch (error) {
            problems.push({ hostId: host.summary.id, ...linkProblem(error) });
          }
        }
        return { runs: runs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt))), problems, focus, roots: configuredRoots(input).map(expandHome) };
      },
    },
    {
      name: "sdksessions.sessions",
      title: "List a run's sessions",
      description: "Every session of one run on a host: title, state, model, effort, usage, labels, host, parent and native (Claude) session id.",
      input: obj({ hostId, runId: str, roots }, ["runId"]),
      read: true,
      handler: async (input) => ({ hostId: hostFor(input).summary.id, runId: String(input.runId), sessions: await hostFor(input).sessions(String(input.runId)) }),
    },
    {
      name: "sdksessions.transcript",
      title: "Read a session's transcript",
      description: "A session's messages with its record. since is a message index (the cursor of the previous page); tail keeps the latest messages.",
      input: obj({ hostId, sessionId: str, since: int(0, 1_000_000), tail: int(1, 500), limit: int(1, 500), roots }, ["sessionId"]),
      read: true,
      handler: async (input) => {
        const host = hostFor(input);
        const transcript = await host.transcript(String(input.sessionId), {
          ...(typeof input.since === "number" ? { since: input.since } : {}),
          ...(typeof input.tail === "number" ? { tail: input.tail } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        });
        return { hostId: host.summary.id, ...transcript, messageCount: transcript.total };
      },
    },
    {
      name: "sdksessions.watch",
      title: "Wait for a session to change",
      description: "Long poll: returns as soon as the session has messages past `since` or its state changes (or after waitMs, at most 20 s), with the new messages and what the backend did meanwhile (tool calls, text, results).",
      input: obj({ hostId, sessionId: str, since: int(0, 1_000_000), eventCursor: int(0, 100_000_000), state: str, updatedAt: str, waitMs: int(0, 20_000), roots }, ["sessionId", "since"]),
      read: true,
      handler: async (input) => {
        const host = hostFor(input);
        return {
          hostId: host.summary.id,
          ...(await host.watch(String(input.sessionId), {
            since: Number(input.since ?? 0),
            eventCursor: Number(input.eventCursor ?? 0),
            ...(typeof input.state === "string" ? { state: input.state } : {}),
            ...(typeof input.updatedAt === "string" ? { updatedAt: input.updatedAt } : {}),
            waitMs: Number(input.waitMs ?? 12_000),
          })),
        };
      },
    },
    {
      name: "sdksessions.telemetry",
      title: "Session or run telemetry",
      description: "Tokens, cost, turns, model round trips, tool calls by name, tool errors, turn durations (median, max, latest) and errors, computed from the host's events.jsonl. Pass sessionId or runId.",
      input: obj({ hostId, sessionId: str, runId: str, roots }),
      read: true,
      handler: async (input) => {
        if (typeof input.sessionId !== "string" && typeof input.runId !== "string") throw new Error("Pass sessionId or runId.");
        const host = hostFor(input);
        return {
          hostId: host.summary.id,
          ...(await host.telemetry(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : { runId: String(input.runId) })),
        };
      },
    },
    {
      name: "sdksessions.send",
      title: "Send a message to an SDK session",
      description: "Send a message into a session on a live linked host: it runs now if the session is idle, or after the current turn (deliveryMode queue) or instead of it (interrupt). cancel:true stops the running turn instead.",
      input: obj({ hostId, sessionId: str, text: str, deliveryMode: { type: "string", enum: ["queue", "interrupt"] }, cancel: bool }, ["sessionId"]),
      read: false,
      handler: async (input) => {
        const host = hostFor(input);
        if (input.cancel === true) return host.cancel(String(input.sessionId));
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!text) throw new Error("text is required.");
        return host.send(String(input.sessionId), text, input.deliveryMode === "interrupt" ? "interrupt" : "queue");
      },
    },
    {
      name: "sdksessions.files",
      title: "List or read a run's files",
      description: "A host's file roots (workspace, output, …): without root, the roots; with root and path, a folder listing; with read:true, the file (text, or base64 for binary; at most 1 MiB, truncated flag). Paths never leave their root.",
      input: obj({ hostId, runId: str, root: str, path: str, read: bool, maxBytes: int(1, 1024 * 1024), roots }),
      read: true,
      handler: async (input) => {
        const host = hostFor(input);
        const runId = typeof input.runId === "string" ? input.runId : undefined;
        const relative = typeof input.path === "string" ? input.path : "";
        if (input.read === true) {
          if (typeof input.root !== "string") throw new Error("root is required to read a file.");
          return host.readFile(runId, input.root, relative, typeof input.maxBytes === "number" ? input.maxBytes : undefined);
        }
        return host.files(runId, typeof input.root === "string" ? input.root : undefined, relative);
      },
    },
    {
      name: "sdksessions.pull",
      title: "Pull a run or session to this Mac",
      description:
        "Copy a run (or one session) from a host into ~/marshal/marshal-sdk/.pulled/<host>/<run> as a session store: records, transcripts, backend events and, when the host has them, the Claude conversation files. The copy then shows under the local host and can be continued offline.",
      input: obj({ hostId, runId: str, sessionId: str, native: { type: "boolean", description: "Also pull Claude conversation files. Default true." }, roots }),
      read: false,
      handler: async (input) => pull(hostFor(input), input, typeof context.configuration?.pullRoot === "string" ? context.configuration.pullRoot : PULL_ROOT),
    },
    {
      name: "sdksessions.continue",
      title: "Continue a session in Marshal",
      description:
        "Open a copy of an SDK session (from a folder or a linked host) as a new local Marshal session that resumes its Claude conversation, through marshal.sessions.importNative. Answers ok:false with a reason (unavailable, running, no-native-state, approval, denied, offline) instead of failing.",
      input: obj({ hostId, sessionId: str, workspaceName: str, roots }, ["sessionId"]),
      read: false,
      handler: async (input, invocation) => {
        const native = await hostFor(input).native(String(input.sessionId));
        if (!native.ok) return native;
        return importNative(native.title, native.state, input.workspaceName, invocation);
      },
    },
    {
      name: "sdksessions.search",
      title: "Search SDK sessions",
      description: "Find sessions by words in their title, labels, run id or transcript, on one host or all of them.",
      input: obj({ hostId, query: str, limit: int(1, 100), roots }, ["query"]),
      read: true,
      handler: async (input) => {
        const limit = typeof input.limit === "number" ? input.limit : 20;
        const hosts = typeof input.hostId === "string" && input.hostId ? [hostFor(input)] : allHosts(input);
        const hits: Row[] = [];
        for (const host of hosts) {
          try {
            for (const hit of await host.search(String(input.query), limit)) {
              hits.push({
                hostId: host.summary.id,
                sessionId: hit.session.id,
                runId: hit.session.runId,
                title: hit.session.title,
                state: hit.session.state,
                host: hit.session.host,
                snippet: hit.snippet,
                score: hit.score,
              });
            }
          } catch {
            // An offline host has no hits; sdksessions.hosts says why.
          }
        }
        return { query: String(input.query), hits: hits.sort((left, right) => right.score - left.score).slice(0, limit) };
      },
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
        return { output: { result: { ok: false, ...linkProblem(error), error: error instanceof Error ? error.message : String(error) } } };
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
      description: "Hosts running marshal-sdk (folders on this Mac and linked hosts): runs, sessions, live transcripts, telemetry and files.",
      renderId: RENDER_ID,
      resource: { uri: "ui://omer/marshal-sdk-sessions/viewer", mimeType: "text/html", text: VIEW_HTML },
      application: {
        version: VERSION,
        presentationModes: ["inline", "fullscreen"],
        tools: [],
        actions: capabilities.filter((capability) => capability.name !== "sdksessions.open" && capability.name !== "sdksessions.pull").map(action),
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

/** Copies a run or session from a host into a local session store the folder host reads. */
async function pull(host: Host, input: Row, pullRoot: string) {
  if (typeof input.runId !== "string" && typeof input.sessionId !== "string") throw new Error("Pass runId or sessionId.");
  let sessions;
  if (typeof input.sessionId === "string") {
    const session = await host.session(input.sessionId);
    if (!session) return { ok: false, reason: "not-found", message: `No session ${input.sessionId} on ${host.summary.id}.` };
    sessions = [session];
  } else {
    sessions = await host.sessions(String(input.runId));
    if (!sessions.length) return { ok: false, reason: "not-found", message: `No run ${input.runId} on ${host.summary.id}.` };
  }
  const runId = sessions[0]!.runId;
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "-");
  const target = path.join(expandHome(pullRoot), safe(host.summary.id), safe(runId));
  const store = path.join(target, "state", "sessions");
  const claudeDir = path.join(target, "claude");
  fs.mkdirSync(store, { recursive: true });
  const indexFile = path.join(store, "index.json");
  let index: Row[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (Array.isArray(parsed)) index = parsed as Row[];
  } catch {
    // A first pull.
  }
  const totals = { sessions: 0, messages: 0, events: 0, native: 0 };
  for (const session of sessions) {
    const dir = path.join(store, safe(session.id));
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let since = 0; ; ) {
      const page = await host.transcript(session.id, { since, limit: PAGE });
      for (const { index: _index, ...message } of page.messages) lines.push(JSON.stringify(message));
      if (!page.messages.length || page.cursor >= page.total) break;
      since = page.cursor;
    }
    fs.writeFileSync(path.join(dir, "transcript.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
    const events: string[] = [];
    for (let since = 0; ; ) {
      const page = await host.events(session.id, since, PAGE);
      for (const line of page.events) events.push(JSON.stringify(line));
      if (page.events.length < PAGE) break;
      since = page.events.at(-1)!.seq;
    }
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.length ? `${events.join("\n")}\n` : "");
    let record: Row = { ...session, messageCount: lines.length, labels: { ...session.labels, pulledFrom: host.summary.id } };
    if (input.native !== false && session.state !== "running" && session.native?.sessionId) {
      const native = await host.native(session.id);
      if (native.ok) {
        const project = String(session.native.cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-");
        const file = path.join(claudeDir, "projects", project, `${safe(session.native.sessionId)}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, gunzipSync(Buffer.from(String(native.state.data), "base64")));
        record = { ...record, native: { ...session.native, configDir: claudeDir } };
        totals.native += 1;
      }
    }
    index = [...index.filter((entry) => entry?.id !== session.id), record];
    totals.sessions += 1;
    totals.messages += lines.length;
    totals.events += events.length;
  }
  const temporary = `${indexFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(index, null, 1));
  fs.renameSync(temporary, indexFile);
  return { ok: true, hostId: host.summary.id, runId, path: target.replace(os.homedir(), "~"), ...totals, message: `Pulled into ${target.replace(os.homedir(), "~")}; it now shows under the local host.` };
}

export const CAPABILITY_NAMES = [
  "sdksessions.open",
  "sdksessions.hosts",
  "sdksessions.runs",
  "sdksessions.sessions",
  "sdksessions.transcript",
  "sdksessions.watch",
  "sdksessions.telemetry",
  "sdksessions.send",
  "sdksessions.files",
  "sdksessions.pull",
  "sdksessions.continue",
  "sdksessions.search",
];

function unavailable() {
  return {
    ok: false,
    reason: "unavailable",
    message: `This Marshal can't continue a session yet: it has no ${IMPORT_NATIVE_CAPABILITY}, which is on Marshal's main since ${IMPORT_NATIVE_PR}. Update Marshal (git pull, pnpm install) and restart it; then this button opens the session here.`,
  };
}

export function activate(context: Context) {
  return createExtension(context);
}

export default { activate };
