// `marley.runs.today` and `marley.extension.list` for routine runs (the dream reads them to keep what worked). Their state lives only on the agent server
// (the org store's sessions of the brand, the extension registry of record), so the routine engine's host answers them itself, as it answers the memory
// tools (marshal-sdk #124 `remoteEmbedderTools`); the @marley/authoring package's sandbox binding is not wired and the brand VM runtime does not list them.
// The brand is the calling session's own `brand` label, set by the server when it started the run, never an input; a call without one is refused.
// `marley.fork.run`, `marley.lane.start` and `marley.lane.list` (Omer R9) are the engine's forks and lanes of the calling run (routine-delegation.ts).
import { MARLEY_IMPL } from "../org-store/index.js";

/**
 * The capabilities a routine run reaches on the host besides the fixed memory and session tools (routine-engine.ts `remoteEmbedderTools`). The fork and lane
 * ones are answered by the engine's RoutineDelegations (routine-delegation.ts), for the calling session only.
 */
export const ROUTINE_EMBEDDER_TOOLS = ["marley.runs.today", "marley.extension.list", "marley.fork.run", "marley.lane.start", "marley.lane.list"] as const;

/** The engine's side of the fork and lane capabilities (RoutineDelegations). */
export interface RoutineDelegate {
  fork(caller: string | undefined, brandId: string, input: Record<string, unknown>): Promise<unknown>;
  lane(caller: string | undefined, brandId: string, input: Record<string, unknown>): unknown;
  lanes(brandId: string): unknown;
}

const PROTOCOL_VERSION = "1.0";
const VERSION = "0.1.0";
const BRAND = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const EXCHANGES_MAX = 6;
const RUNS_DEFAULT = 30;
const RUNS_MAX = 50;
const TRANSCRIPT_BYTES_MAX = 2_000_000;

interface ObjectsLike {
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<string[]>;
}

export interface RoutineHostCapabilityDeps {
  /** The brand of the calling session (its `brand` label), undefined for an unknown session or one without the label. */
  brandOf(sessionId: string | undefined): string | undefined;
  /** The org store Marley's chat engine publishes to and its env partition; absent when the sink is off. */
  org?: { objects: unknown; env: string };
  /** The brand's extensions as the registry of record holds them (extension-tools.ts `brandExtensionList`); absent: no registry. */
  extensionList?: (brandId: string) => Promise<Record<string, unknown>>;
  /**
   * What people said and Marley answered in the run's conversation (its `conversation` label), for the replies sent inside the run's window, from the
   * server's typed message rows (run-exchanges.ts `storeExchanges`). Absent: runs carry no exchanges and say so.
   */
  exchanges?: (brand: string, conversation: string, from: string, to: string) => RunExchange[];
  /** Forks and lanes of the calling run; absent: those capabilities refuse. */
  delegate?: RoutineDelegate;
  now?: () => Date;
}

const RESULT = { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false };

const CAPABILITIES = [
  {
    name: "marley.runs.today",
    title: "What Marley did today",
    description:
      "This brand's sessions of a day (chats, background work, composed replies): which procedure, the conversation kind, and a few exchanges with how the person reacted. day is the UTC day a session started (default today). Read it to find what worked and is worth keeping.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, limit: { type: "integer", minimum: 1, maximum: RUNS_MAX } },
    },
  },
  {
    name: "marley.extension.list",
    title: "List this brand's extensions",
    description: "Every version of this brand's extensions (drafts, proposed, active, retired) with who wrote it and its dry runs, and which routines they are bound to.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "marley.fork.run",
    title: "Fork parts of this run and wait for them",
    description:
      "Runs independent parts of this run at once, each a fork on the brand's machine with your data tools, guides and memory but no send tool. The call waits until every fork ends and returns each one's final message (or error). A brief is all a fork knows: give it the context, what to look at and what to bring back. A fork may fork its own parts. A task with breaks is a breaker: it gets your move and its grounds in its brief and tries to break it; its answer ends with a VERDICT line (held, broken or partly).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["task"],
            properties: {
              task: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
              breaks: { type: "string", minLength: 1, description: "Makes this fork a breaker: the move (its book id or your ref) it tries to break in the data. The server gives it the breaker's brief and records its verdict; only a breaker's held verdict marks that move's ask checked." },
            },
          },
        },
      },
    },
  },
  {
    name: "marley.lane.start",
    title: "Start a lane for this brand",
    description:
      "Starts a lane: a background run for this brand that goes on after this run ends (a competitor scan, a deep dig). It starts with only the brief you write, files its findings in brand memory as it goes, and reports to nobody; the next run sees it with marley.lane.list. Returns its laneId at once. Free time (an awaited run) and its forks and lanes start lanes; a scheduled routine run cannot, because its words go out under the server's own delivery rules.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: { task: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } },
    },
  },
  {
    name: "marley.lane.list",
    title: "This brand's lanes",
    description: "The brand's 10 newest lanes, running or ended: name, brief, state, when, which run started it, and an ended lane's final message.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

export interface RunExchange {
  asked: string;
  answered: string;
  reaction?: string;
}

export interface RunDigest {
  runId: string;
  procedure: string;
  kind?: string;
  role?: string;
  title: string;
  status: string;
  startedAt: string;
  messages: number;
  toolCalls: number;
  tools: string[];
  exchanges: RunExchange[];
}

/**
 * The tools a transcript's assistant messages called, counted by the `tool_use` blocks' names (typed content blocks; no message text is read). A line
 * that is not JSON is counted in `unreadable`, never skipped silently.
 */
export function transcriptTools(jsonl: string, tools: Map<string, number>): { unreadable: number } {
  let unreadable = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: { role?: string; content?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    if (entry.role !== "assistant" || !Array.isArray(entry.content)) continue;
    for (const part of entry.content as { type?: string; name?: unknown }[]) {
      if (part?.type === "tool_use" && typeof part.name === "string") tools.set(part.name, (tools.get(part.name) ?? 0) + 1);
    }
  }
  return { unreadable };
}

const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

/** What could not be read while digesting a day: counted and returned with the runs, so a missing piece is never mistaken for "nothing happened". */
interface Unread {
  rows: number;
  transcripts: number;
  transcriptLines: number;
}

async function runsOfDay(org: { objects: ObjectsLike; env: string }, brand: string, day: string, limit: number, exchangesOf: RoutineHostCapabilityDeps["exchanges"]): Promise<{ runs: RunDigest[]; unread: Unread }> {
  const partition = `${MARLEY_IMPL.workspace}/${MARLEY_IMPL.impl}/env=${org.env}/brand=${brand}/${day}`;
  const names = (await org.objects.list(`sdk-index/v1/${partition}/_rows/`)).filter((name) => name.endsWith(".json"));
  const unread: Unread = { rows: 0, transcripts: 0, transcriptLines: 0 };
  const rows: Record<string, any>[] = [];
  for (const name of names) {
    const raw = decode(await org.objects.get(name));
    let row: Record<string, any> | undefined;
    try {
      row = raw ? (JSON.parse(raw) as Record<string, any>) : undefined;
    } catch {
      row = undefined;
    }
    if (!row) {
      unread.rows += 1;
      continue;
    }
    // The row must be this brand's (its partition), whatever its path said.
    if (row.part?.brand === brand && typeof row.id === "string" && ROW_ID.test(row.id)) rows.push(row);
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const digests: RunDigest[] = [];
  for (const row of rows.slice(-limit)) {
    const tools = new Map<string, number>();
    for (const member of Array.isArray(row.members) ? (row.members as unknown[]) : []) {
      if (typeof member !== "string" || !ROW_ID.test(member)) continue;
      const bytes = await org.objects.get(`sdk/v1/${partition}/${row.id}/transcripts/${member}.jsonl`);
      if (!bytes || bytes.byteLength > TRANSCRIPT_BYTES_MAX) {
        unread.transcripts += 1;
        continue;
      }
      unread.transcriptLines += transcriptTools(decode(bytes) ?? "", tools).unreadable;
    }
    const labels = (row.labels ?? {}) as Record<string, string>;
    // The people's words come from the server's typed message rows of the run's conversation, never from a transcript's text (lean.md LN01).
    const exchanges = labels.conversation && exchangesOf ? exchangesOf(brand, labels.conversation, String(row.createdAt ?? ""), String(row.updatedAt ?? row.createdAt ?? "")) : [];
    digests.push({
      runId: row.id,
      procedure: labels.procedure ?? "",
      ...(labels.kind ? { kind: labels.kind } : {}),
      ...(labels.role ? { role: labels.role } : {}),
      title: String(row.title ?? ""),
      status: String(row.state ?? ""),
      startedAt: String(row.createdAt ?? ""),
      messages: Number(row.messages ?? 0),
      toolCalls: [...tools.values()].reduce((sum, count) => sum + count, 0),
      tools: [...tools.keys()].sort(),
      exchanges: exchanges.slice(-EXCHANGES_MAX),
    });
  }
  return { runs: digests, unread };
}

const refused = (message: string) => Object.assign(new Error(message), { code: "refused" });

/** The provider the routine engine's host registers (`providerSources`); remote runs reach only ROUTINE_EMBEDDER_TOOLS of it. */
export function createRoutineHostCapabilities(deps: RoutineHostCapabilityDeps) {
  const descriptors = CAPABILITIES.map((capability) => ({
    protocolVersion: PROTOCOL_VERSION,
    version: VERSION,
    name: capability.name,
    title: capability.title,
    description: capability.description,
    tags: ["marley", "routine", "extension"],
    inputSchema: capability.inputSchema,
    outputSchema: RESULT,
    permissions: [{ permission: capability.name, risk: "low" }],
  }));
  const byName = new Map<string, (typeof descriptors)[number]>(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    id: "marley.routine-host",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context?: { scope?: { sessionId?: string } }) => {
      const brand = deps.brandOf(context?.scope?.sessionId);
      if (!brand || !BRAND.test(brand)) throw refused(`${name} answers only inside a brand's routine run`);
      const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      if (name === "marley.runs.today") {
        const day = input.day === undefined ? (deps.now?.() ?? new Date()).toISOString().slice(0, 10) : input.day;
        if (typeof day !== "string" || !DAY.test(day)) throw refused("day must be YYYY-MM-DD");
        const limit = input.limit === undefined ? RUNS_DEFAULT : input.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > RUNS_MAX) throw refused(`limit must be an integer from 1 to ${RUNS_MAX}`);
        // No runs because nothing could be read is not "no runs today": say which.
        if (!deps.org) return { output: { result: { runs: [], day, unavailable: "the org store is off on this server (ORG_STORE_SINK)" } } };
        const { runs, unread } = await runsOfDay({ objects: deps.org.objects as ObjectsLike, env: deps.org.env }, brand, day, limit, deps.exchanges);
        const gaps = [
          ...(unread.rows ? [`${unread.rows} run rows could not be read`] : []),
          ...(unread.transcripts ? [`${unread.transcripts} transcripts were missing or too large, so their tools are not counted`] : []),
          ...(unread.transcriptLines ? [`${unread.transcriptLines} transcript lines could not be read`] : []),
          ...(deps.exchanges ? [] : ["the conversations' messages are not readable on this server, so runs carry no exchanges"]),
        ];
        return { output: { result: { runs, day, ...(gaps.length ? { unavailable: gaps.join("; ") } : {}) } } };
      }
      if (name === "marley.extension.list") {
        if (!deps.extensionList) return { output: { result: { extensions: [], bindings: [], unavailable: "no extension registry on this server" } } };
        return { output: { result: await deps.extensionList(brand) } };
      }
      if (name === "marley.fork.run" || name === "marley.lane.start" || name === "marley.lane.list") {
        if (!deps.delegate) throw refused(`${name} is not available on this server`);
        const caller = context?.scope?.sessionId;
        if (name === "marley.fork.run") return { output: { result: await deps.delegate.fork(caller, brand, input) } };
        if (name === "marley.lane.start") return { output: { result: deps.delegate.lane(caller, brand, input) } };
        return { output: { result: deps.delegate.lanes(brand) } };
      }
      throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not_found" });
    },
  };
}
