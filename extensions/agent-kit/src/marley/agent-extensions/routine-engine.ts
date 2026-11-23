import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";
import type { Options, SDKMessage } from "@zygstinct/marshal-sdk-port/agent-sdk";
import {
  HostAutomations,
  resolveAgent,
  TURN_EXTRAS,
  type AgentLaunchRequest,
  type Automation,
  type ClaudeAgentPort,
  type PromptLayer,
  type SessionStore,
  type AutomationStore,
  type FireDecision,
  type FireRequest,
  type JobHandler,
  type TurnExtras,
} from "@zygstinct/marshal-sdk-port";
import { ANTIGRAVITY_DISABLED_BUILTIN_TOOLS, antigravityDescriptor, MARLEY_PROVIDER_FOR, MARLEY_SESSION_SCOPE, runsOnAntigravity, type VmAntigravityBridge } from "../engine/marshal-engine.js";
import { createRoutineHostCapabilities, ROUTINE_EMBEDDER_TOOLS, type RunExchange } from "./routine-host-capabilities.js";
import { createBrandHostCapabilities, STACK_DETECTED, STACK_SCAN, TICKET_FILE, type BrandHostTool } from "./brand-host-capabilities.js";
import type { BrandStack } from "../brand-stack.js";
import type { MarleyTickets } from "../tickets.js";
import { DELEGATION_LABEL, RoutineDelegations, type SessionOutcome } from "./routine-delegation.js";

/**
 * The host tools a routine run on a brand VM reaches (marshal-sdk `remoteHostTools`): memory (remember, recall, linkMemory, updateMemory, forget) and the
 * day's sessions (searchSessions, getSessionTranscript), all bounded to the run's brand (sessionScopeLabel MARLEY_SESSION_SCOPE; memory by the session's
 * scopes, brain-memory/). Not the SDK's fork tools: a host fork reports as a new turn of its parent when it goes idle, which a routine run's session never
 * takes. A run forks and starts lanes with `marley.fork.run` / `marley.lane.start` instead (routine-delegation.ts), whose forks it waits for in the call.
 */
export const ROUTINE_REMOTE_HOST_TOOLS = [
  "marshal.tool.searchSessions", "marshal.tool.getSessionTranscript",
  "marshal.tool.remember", "marshal.tool.recall", "marshal.tool.linkMemory", "marshal.tool.updateMemory", "marshal.tool.forget",
] as const;
import { createMarshalHost, type AntigravityRemoteBridge, type MarshalHost, type MemoryOptions, type RemoteRuntime } from "@zygstinct/marshal-sdk-port/host";
import { OWNER_REPORT_DAILY, UA_CBO } from "@zygstinct/routines-public";

/**
 * The brand's onboarding audits in one run (onboarding-run.ts): the first look and the tracking check of the store, fired once by the server's gate when the
 * brand's first data sync finishes. No routine record.
 */
export const ONBOARDING = "onboarding";
/** The pixel check (pixel-watch.ts): fired by the server's gate when the owner asks (no schedule, R148), no routine record. */
export const PIXEL_CHECK = "pixel-check";

import type { BrandDirectory } from "../directory.js";
import type { Logger } from "../logger.js";
import { metaAnalysisLive, type RoutineRecord, type RoutineRegistry } from "../routines/registry.js";
import { releaseTriggers, type RoutineTriggers } from "./triggers.js";
import { ownerReportCoverage, type ShopClock } from "../routines/owner-reports.js";
import { BRIEF_SEND } from "../routines/graph.js";
import { STORE_WATCH_ROUTINE } from "../routines/events.js";
import { BRAND_RUN_MEMBER, isBrandRunConversation } from "../routines/brand-run.js";
import { withWakeReason } from "../sandbox/wake-reason.js";
import { marleyHostPrompt, profilePromptLayer } from "../engine/marshal-prompt.js";
import { NATIVE_DELEGATION_TOOLS } from "../tasks/tool-gate.js";
import type { FeatureAnswer } from "../tasks/runtime-features.js";
import { REPLY_TOOLS_RUNTIME_FEATURE } from "../reply-protocol.js";
import { SHEET_CURATOR } from "../state/living-state.js";
import { NO_REPORT, parseRoutineReport, parseStateWrites, ROUTINE_REPORT_MAX_BYTES, routineReportFile, routineReportInstruction, stateWritesFile, stateWritesInstruction, type RoutineReport, type RoutineStateWrite } from "../routines/routine-report.js";
import type { ConversationKey } from "../store.js";
import { parseLiveSends, type LiveMessage, type LiveSendFile } from "../live-sends.js";
import type { RunSendsTurn } from "../outbox/run-sends.js";
import type { ServerExtensionRegistry } from "../extension-registry/server-registry.js";

/** The registry's side the engine uses: which package a brand's routine runs now (a fork or the release), the pin a run records, and the brand's own bindings. */
export type RoutinePackageRegistry = Pick<ServerExtensionRegistry, "resolveRoutine" | "recordRunPin" | "listBindings">;

/**
 * One system routine the extension engine runs: the agent extension package that carries it. `server`: the server's own gate decides when it runs (a first sync,
 * a daily window, a due owner) and starts it with `fire`; such a routine has no routine record and no schedule of its own in the engine.
 */
export interface EngineRoutine { agent: string; extension: string; server?: true }

/**
 * The system routines the extension engine fires: the server routine id, and the agent extension package that carries it.
 * Record-driven ones (the Meta analysis, the owner reports) are scheduled from their routine record; server-fired ones (`server: true`) run when the server's gate
 * fires them, with `fire` (the outcome goes to `onOutcome`) or `runGated` (the caller waits for the run's answer; no run report, no outcome).
 * The silent ones send nothing from the run; the server acts afterwards on what the run left. A routine that talks to the owner (the daily
 * brief as text) reaches them only through the reply port: its reply tools queue during the run and the server delivers the queue after it, re-checked,
 * through the router's fenced send path (`serverDelivered` + `onOutcome`).
 */
export const ENGINE_ROUTINES: Readonly<Record<string, EngineRoutine>> = {
  [OWNER_REPORT_DAILY]: { agent: "daily-brief", extension: "@marley/daily-brief" },
  [ONBOARDING]: { agent: "onboarding", extension: "@marley/onboarding", server: true },
  [PIXEL_CHECK]: { agent: "pixel-check", extension: "@marley/pixel-check", server: true },
  // Fired once per brand by brand-stack.ts (its onboarding week's start or its first turn): reads the brand's own website and reports the tools it shows.
  [STACK_SCAN]: { agent: "stack-scan", extension: "@marley/stack-scan", server: true },
  // Fired by proactive/messages.ts for an in-window brief once its slot is claimed; the server delivers its queued sends after it (`briefRunFinished`).
  // Omer R148: the send is the second agent of @marley/daily-brief (one extension builds the brief and delivers it).
  [BRIEF_SEND]: { agent: "brief-send", extension: "@marley/daily-brief", server: true },
  // Gated by free-time.ts and agent-extensions/consolidate-gate.ts (the dream), which wait for the answer (runGated).
  "free-time": { agent: "free-time", extension: "@marley/free-time", server: true },
  dream: { agent: "dream", extension: "@marley/free-time", server: true },
  // Free time's jobs (Omer R13): gated by free-time-jobs.ts, run through free time (the book, the ask), awaited like the hunt.
  "free-time-watch": { agent: "free-time-watch", extension: "@marley/free-time", server: true },
  "free-time-follow": { agent: "free-time-follow", extension: "@marley/free-time", server: true },
  "free-time-scout": { agent: "free-time-scout", extension: "@marley/free-time", server: true },
  "free-time-unlock": { agent: "free-time-unlock", extension: "@marley/free-time", server: true },
  // The store watch (routines/store-watch.ts): its gate decides when a brand is due and runs the recipe inside this extension's run (runGated).
  [STORE_WATCH_ROUTINE]: { agent: "store-watch", extension: "@marley/store-watch", server: true },
  // Onboarding notices (source-notice.ts, onboarding-intake.ts): their gate fires them in the owner's DM; the server delivers what the run queued (onOutcome).
  "source-notice": { agent: "source-notice", extension: "@marley/source-notice", server: true },
  "intake-reveal": { agent: "intake-reveal", extension: "@marley/intake-reveal", server: true },
};

/** The brand-host tools a routine session reaches (remoteEmbedderTools): filing a ticket, and the stack scan's report (answered only for that run). */
const brandHostTools = (deps: Pick<RoutineEngineDeps, "tickets" | "brandStack">): BrandHostTool[] => [...(deps.tickets ? [TICKET_FILE as BrandHostTool] : []), ...(deps.brandStack ? [STACK_DETECTED as BrandHostTool] : [])];

/** How long a test slot waits for its run to start (a test downstream's `after` fire is due at once; the clock ticks every minute). */
const TEST_SLOT_TTL_MS = 15 * 60_000;
/**
 * The send tools of a runtime that predates the outbox (no `outbox_put@1`): they queue plain replies into the same send folder, with no material of their own.
 * An engine session never lists them (Omer R151: routines speak only through marley.outbox.*); a run on such a runtime is refused before it starts
 * (`outboxRuntime`, RuntimeWithoutOutboxError) rather than left to improvise with them (run 55c615c8 on dev, 2026-11-18).
 */
export const LEGACY_REPLY_TOOLS = [
  "mcp__marshal__reply_send_text", "mcp__marshal__reply_send_voice", "mcp__marshal__reply_send_image", "mcp__marshal__reply_send_file",
  "mcp__marshal__reply_send_artifact", "mcp__marshal__reply_send_connect_link", "mcp__marshal__reply_react",
] as const;

/** A run, rework turn or awaited run whose brand runtime does not list the outbox tools: refused before the session opens, never run on the old reply tools. */
export class RuntimeWithoutOutboxError extends Error {
  constructor(readonly brandId: string, readonly routineId: string, readonly outcome: FeatureAnswer["outcome"]) {
    super(`routine engine: brand ${brandId}'s runtime does not list ${REPLY_TOOLS_RUNTIME_FEATURE} (${outcome}); ${routineId} speaks only through the outbox, so it does not run there`);
    this.name = "RuntimeWithoutOutboxError";
  }
}

/** How a session settled, as the port tells it (`onSettled`) or as a restart closes it (`settleInterrupted`, no error text). */
type SettledOutcome = { state: "idle"; reply?: string } | { state: "failed"; error?: string };

/** How often a running session's send folder is read: its outbox parts become material while it works, as a worker's do (claude.ts WORKER_SENDS_POLL_MS). */
export const RUN_SENDS_POLL_MS = 5_000;

/**
 * The trigger of the daily build while the brand's Meta analysis is live: an event nothing emits, so the build has no clock of its own and starts only from the
 * routine graph's fire after the analysis finished (runFromGraph). The analysis runs on the agent server (routines/ua-server), not as an automation, so an SDK
 * `after` trigger on it would never come.
 */
export const GRAPH_ONLY_EVENT = "routine-graph.fire";

/** A routine the engine schedules from its routine record: the server's own schedule for it is not created (routines/vm-schedules.ts). */
export const engineOwns = (routineId: string): boolean => Object.hasOwn(ENGINE_ROUTINES, routineId) && ENGINE_ROUTINES[routineId]!.server !== true;
/** A routine the server's gate starts through `ExtensionRoutineEngine.fire` or `runGated` (no record). */
export const serverFired = (routineId: string): boolean => ENGINE_ROUTINES[routineId]?.server === true;
/** The label of an automation the server's gate fires (kept by `start` though no record names it). */
export const FIRED_BY = "firedBy";

/** One server-fired run: its input, the conversation whose home it runs in (default: the brand-run conversation), and the server's own task text when it replaces the package's. */
export interface ServerFire { input?: Record<string, unknown>; home?: ConversationKey; prompt?: string; testSlot?: string; pixelWalk?: PixelWalk; runMember?: string }
/** The run may walk the brand's own site: `daily` is the daily re-check, which the PIXEL_AUDIT_DAILY kill switch also stops; the onboarding audit needs only the owner's consent. */
export interface PixelWalk { websiteUrl: string; daily?: true }

/** One awaited server-fired run (`runGated`): the conversation that is its home on the sandbox, its input, and an optional JSON Schema the final answer must follow. */
export interface GatedRunRequest {
  brandId: string;
  key: ConversationKey;
  input: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * The routine host's own Antigravity bridge for a Gemini session (antigravityBridgeFor): never one that starts anything. Its only use is the session's
 * prompt, which then names the brand VM's Antigravity built-ins the run has there. Every run replaces it on its turn with the bridge of the sandbox it
 * opened (modelQuery); a turn that reached the provider with this one fails when the provider tries to start it, so no bridge ever starts on this server.
 */
export const UNSET_RUN_BRIDGE: AntigravityRemoteBridge = {
  key: "marley-routine:unset",
  endpoint: { kind: "proxy", api: "vertex", baseUrl: "http://127.0.0.1:9/vertex" },
  spawnBridge: () => {
    throw new Error("routine engine: a Gemini run's bridge comes from its brand VM sandbox, and this turn has none; nothing started");
  },
  disabledBuiltinTools: [...ANTIGRAVITY_DISABLED_BUILTIN_TOOLS],
};

/** What an awaited run ended with: its Marshal session, the final text, and the structured answer when a schema was asked for. */
export interface GatedRunResult {
  sessionId: string;
  ok: boolean;
  result: string | null;
  structured: unknown;
  subtype: string | null;
}

/** A fire waiting for its session to start: `fire`'s (outcome through onOutcome) or `runGated`'s (`waiter` set: the caller waits for the answer). */
interface PendingFire {
  fire: ServerFire;
  waiter?: { request: GatedRunRequest; resolve: (result: GatedRunResult) => void; reject: (error: unknown) => void };
}

/** The brand's sandbox for one run: the remote spawner and working folder of a turn (ClaudeTurnRunner.openRoutineSandbox). */
export interface RoutineSandbox {
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
  cwd: string;
  claudeBin: string;
  /** The run's own runtime server on the brand VM (VM feature `remote_runtime@1`, ssh.runtimeConnection), as a chat turn gets it; absent on a VM without it. */
  remote?: RemoteRuntime;
  /** The run's Antigravity bridge on the same VM and chat, with its own capped `vertex` proxy session (ClaudeTurnRunner.openSession); only on a server with the Vertex route. */
  antigravity?: () => VmAntigravityBridge;
  finish(sessionId: string | null): Promise<void>;
  /** A file in the run's home folder (the run report), bounded; null when it is not there or cannot be read. */
  readHomeFile(file: string, maxBytes: number): Promise<Buffer | null>;
  /** The turn's own send folder ($HOME/.zs/sends/<runId>): what its marley.outbox.* calls queued, in call order. Absent: nothing the session writes reaches anyone. */
  readSends?(): Promise<LiveSendFile[]>;
}

/**
 * `pixelWalk`: the run may walk the brand's own site (the onboarding audit, the pixel check); the host re-reads the owner's consent (and, for the pixel check, the kill switch) when it opens the sandbox.
 * `runMember`: the routine record's member (or the brand-run member). The host binds the run's data grant for it from a fresh read before the run starts
 * (ClaudeTurnRunner.bindRoutineRunGrant). An awaited run (free time, dream) passes none and binds nothing.
 */
export type OpenRoutineSandbox = (input: { key: ConversationKey; hostId: string; runId: string; signal: AbortSignal; pixelWalk?: PixelWalk; runMember?: string }) => Promise<RoutineSandbox>;

/** The Agent SDK's query (a scripted one in tests). */
export type RoutineQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/** What a finished run tells the rest of the server (the routine graph's completion, the run log). */
export interface RoutineRunOutcome {
  brandId: string;
  routineId: string;
  kind: "success" | "failed";
  /** The shop day the run covered (fire field `yesterday`). */
  covers: string;
  /** The Marshal session of the run. */
  sessionId: string;
  slot: number;
  reason: string | null;
  /** The run's own report (routine-report/1), which decides the outcome as on the server; null when it left none. */
  report: RoutineReport | null;
  /** Set when the server delivers this run's queued sends after it (see `serverDelivered`): the record as the run started, for the re-check before delivery. */
  delivery?: { revision: number; memberId: string };
  /** Set for a run the inspector fired for a test chain (`runNow` with a slot): the graph completes the node under that slot only, and nothing is delivered or logged as a real run. */
  testSlot?: string;
  /** How the session ended, whatever its report says (a server-fired routine judges its own files). */
  ended: "idle" | "failed";
  /** The run's final text (the result message), for a routine whose record is that text (the first look). */
  finalText: string | null;
  costUsd: number;
  /** The conversation whose home the run used. */
  home: ConversationKey;
  /** How many outbox parts the run wrote and the server read while it ran (`runSends`, delivered or withheld there); 0 when it put nothing to the outbox. */
  outboxed: number;
}

export interface RoutineEngineDeps {
  /** The team's tickets (tickets.ts): a run files what blocks it with `marley.ticket.file` (brand-host-capabilities.ts). Absent: not offered. */
  tickets?: MarleyTickets;
  /** The brand's stack (brand-stack.ts): the stack-scan run reports what the site shows with `marley.stack.detected`. Absent: not offered. */
  brandStack?: BrandStack;
  /** The host's memory: Marley's brand Brain store (the chat engine's own, brain-memory/). Absent: runs have no memory. */
  memory?: MemoryOptions;
  /**
   * Search-only access to the org store (org-store/ `marleyOrgSearch`): a run's searchSessions and getSessionTranscript also read the brand's chats, which the
   * chat engine publishes there (this host's own store holds routine runs only). Absent: routine runs only.
   */
  orgSearch?: { objects: unknown; workspace: string; env?: string };
  /** The brand's extensions from the registry of record (extension-tools.ts `brandExtensionList`), for a run's `marley.extension.list`. */
  extensionList?: (brandId: string) => Promise<Record<string, unknown>>;
  /** The shop's clock of a routine (its zone and the day of the latest `shop-day.ready`), when the server knows it: an owner report covers that shop day (MLY-687). */
  shopClock?: (routine: RoutineRecord["routine"]) => ShopClock | undefined;
  /** A run conversation's exchanges from the server's typed message rows (run-exchanges.ts `storeExchanges`), for `marley.runs.today`. */
  exchanges?: (brand: string, conversation: string, from: string, to: string) => RunExchange[];
  /**
   * ROUTINE_MODEL (config.ts; model experiments only, unset in production): the model every run, fork, lane and rework turn uses in place of an
   * Opus model its package profile names (routineModelFor). Sonnet and Haiku profiles keep their own model.
   */
  routineModel?: string | null;
  /**
   * Whether this server has the Vertex route (VERTEX_PROJECT, ModelProxy's capped `vertex` provider): a Gemini run needs it, and its sandbox's bridge on the
   * brand VM. Without it a Gemini run fails before its sandbox opens.
   */
  antigravity?: boolean;
  /** The agent-server's own state folder; sessions and automations live under `<state>/marshal-routines`. */
  root: string;
  hostId: string;
  /** The agent's name in the Marshal base's identity. Default "Marley". */
  agentName?: string;
  /** Absolute folders of the release's agent extension packages (extensions/agents/*). */
  packages: readonly string[];
  database: Database.Database;
  /** The extension registry of record: when set, a brand's routine runs the package the registry resolves for it (its fork or pin), and every run records its pin. Unset: the release packages only. */
  extensions?: RoutinePackageRegistry;
  registry: Pick<RoutineRegistry, "get" | "available" | "db">;
  directory: Pick<BrandDirectory, "get" | "assignedHost">;
  /** The server's global scheduling switch (SCHEDULES_ENABLED): while it is off a due fire stays owed, as the server's own schedules did. Default on. */
  enabled?: () => boolean;
  /**
   * The brand's living sheet as a routine run reads it (LivingState.routineBlock), or null: appended to every run, scheduled or awaited, with the note on how to
   * write it (R48, 2026-11-20: every routine reads and writes the sheet, so chat never contradicts what a routine found or advised).
   */
  livingSheet?: (key: ConversationKey) => { block: string; folder: string | null } | null;
  /** Applies a run's typed stateWrites (its report's, or an awaited run's file) to the sheet as scheduled work, from the run's home and member (null when it has none). */
  applyState?: (input: { brandId: string; routineId: string; sessionId: string; key: ConversationKey; memberId: string | null; writes: RoutineStateWrite[] }) => Promise<void>;
  /**
   * Makes the sheet's file folder (`state/` of the brand repo) before a run, writable by every chat of the brand as the repo is (R49): a chat's own umask would
   * otherwise decide it for every routine after it. Best effort: a failure is logged and the run goes on.
   */
  prepareSheetFolder?: (brandId: string) => Promise<void>;
  /** Per-brand hold (snapshot upgrade, admin): a fire that falls due while held stays owed and runs after release. */
  held: (brandId: string) => boolean;
  /** Server jobs the engine's automations may run instead of an agent session (the graph watch, the reindex after a graph publish). Each handler gates itself. */
  jobs?: Readonly<Record<string, JobHandler>>;
  query: RoutineQuery;
  openSandbox: OpenRoutineSandbox;
  /** The server's own `<host_context>` block for a routine turn of the brand (brand profile, people with zones, connected sources, memory, speaker, capabilities). */
  hostContext: (input: { brandId: string; hostId: string; routineId: string }) => Promise<string | null>;
  /** Told when a run begins on the sandbox, with the slot its outcome will carry (the run log's `running` row, the funnel's `triggered` line). Never throws into the engine. */
  onStart?: (run: { brandId: string; routineId: string; slot: number; sessionId: string; testSlot?: string }) => void;
  /**
   * Context the server adds to a routine's task, as it did to the prompt it built itself: the owner's saved instructions for the routine and, for the daily brief, the
   * brief's earlier questions as dated facts. Server-made blocks (their own text is made inert where they are built); appended after the task and before the report contract.
   */
  hostPrompt?: (input: { brandId: string; routineId: string; slot: number }) => string;
  /**
   * The routine graph's say on an automatic fire of a brand routine (GraphEngine.gateNode): `fire: false` skips it (an `&& schedule` hold, a node that runs on its
   * upstreams); `upstreamState` is the server's <upstream_state> block the run is told. Absent: every fire goes.
   */
  graphGate?: (input: { brandId: string; routineId: string; at: number }) => { fire: boolean; upstreamState?: string };
  /**
   * A run whose queued sends the server delivers after it ends (the daily brief when it is sent as text, or when proactive offers are off): its task is the server's own
   * prompt, and the reply tools are listed to it but only queue (nothing is sent while it runs; the server reads the queue, re-checks and delivers through the router's
   * fenced send path). Null for every other run: the silent build, whose video the server offers later.
   */
  serverDelivered?: (input: { brandId: string; routineId: string; slot: number }) => { prompt?: string } | null;
  /** The server's say on a finished run (the run log, the graph, the proactive offer's preparation check). Awaited, so a slow check keeps the run's state. */
  onOutcome: (outcome: RoutineRunOutcome) => void | Promise<void>;
  /**
   * A rework turn of a finished run ended (`reworkRun`): what it put to the outbox is in its own send folder (`turnId`) on the run's home. The server reads it
   * and puts it to the outbox in place of the piece the outbox sent back. A rework turn is never a run of its own: no run log, graph, delivery or chain.
   */
  onReworked?: (turn: { brandId: string; routineId: string; sessionId: string; turnId: string; home: ConversationKey; ended: "idle" | "failed" }) => void | Promise<void>;
  /**
   * What a session put to the outbox (Omer R151: routines go through the outbox, no exception): every run, rework turn and awaited run of the engine has its send
   * folder read while it works and once when its turn ends, and each new batch is handed here with the turn's typed identity (outbox/run-sends.ts `runSendsTo`
   * makes it outbox material carrying `runId`). Returns how many parts were handed over. A batch that throws is read again at the next poll. Absent: nothing a
   * session writes reaches anyone.
   */
  runSends?: (turn: RunSendsTurn, messages: readonly LiveMessage[]) => Promise<number>;
  /**
   * Whether the brand's installed runtime lists the outbox tools (`outbox_put@1`, the reply-tools probe the chat reads). Asked before every run, rework turn and
   * awaited run opens its sandbox: a runtime without them is refused (RuntimeWithoutOutboxError, ERROR routine_engine.runtime_without_outbox), never run on the old
   * reply tools. Absent: the engine assumes the runtime it ships with (tests).
   */
  outboxRuntime?: (brandId: string, hostId: string) => Promise<FeatureAnswer>;
  /** The Marshal session's idle or failed event: where Marley's run records are published from. */
  onSessionEvent?: (type: "session.idle" | "session.failed", payload: Record<string, unknown>) => void;
  logger: Logger;
  now?: () => Date;
  tickMs?: number;
}

const SESSION_BRAND = "brand";
/** The label naming a routine session's Marley prompt layer (kept in memory by the engine, like the launch prompt it replaces). */
const SESSION_PROMPT = "marleyPrompt";
const SESSION_ROUTINE = "routine";
/** The session/automation label that marks an owner's schedule (not a routine): its fire delivers into a conversation instead of running an agent. */
export const OWNER_SCHEDULE_KIND = "owner-schedule";
export const SESSION_KIND = "kind";
export const SESSION_SCHEDULE = "schedule";

/** What the engine asks of the owner-schedule side: whether a due schedule may fire, and the fire itself (delivery into the conversation). */
export interface OwnerScheduleHooks {
  decide(brandId: string, scheduleId: string): FireDecision | Promise<FireDecision>;
  fire(brandId: string, scheduleId: string): void | Promise<void>;
}

/** automations.json's rows in the server's SQLite, next to the routine registry. A write replaces the whole set in one transaction. */
export class SqliteAutomationStore implements AutomationStore {
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS routine_automations (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  }

  load(): Automation[] {
    return (this.db.prepare("SELECT json FROM routine_automations").all() as { json: string }[]).map((row) => JSON.parse(row.json) as Automation);
  }

  save(automations: readonly Automation[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM routine_automations").run();
      const insert = this.db.prepare("INSERT INTO routine_automations (id, json) VALUES (?, ?)");
      for (const automation of automations) insert.run(automation.id, JSON.stringify(automation));
    })();
  }
}

/**
 * An object whose members are read from `resolve()` on each access, for a host part that exists only once the host opened. `early` answers
 * the members a holder reads at construction (HostAutomations reads its port's hostId).
 */
function lazyObject<T extends object>(resolve: () => T, early: Record<string, unknown> = {}): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      if (typeof key === "string" && Object.hasOwn(early, key)) return early[key];
      const target = resolve();
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set: (_target, key, value) => Reflect.set(resolve(), key, value),
    has: (_target, key) => Reflect.has(resolve(), key),
  });
}

/** Data inside the run's task cannot close a block or open another one (PI01): angle brackets and line separators are made inert, as the server does for message text. */
export const inertText = (text: string): string => text.replace(/[<>]/g, (char) => (char === "<" ? "‹" : "›")).replace(/[\u2028\u2029]/g, " ");

/** What identifies a routine's automation: changing any of it re-registers. */
const signatureOf = (record: RoutineRecord, upstream: boolean): string =>
  JSON.stringify([record.routine.revision, record.routine.enabled, record.routine.cadence, record.routine.timezone, record.routine.currency, upstream ? GRAPH_ONLY_EVENT : false]);

/**
 * Fires the system routines as the Marshal SDK's agent extensions, per brand. The SDK's `HostAutomations` keeps the clock, the `after` chain (daily brief
 * after the Meta analysis) and owed fires; this class is Marley's side of it: the registry's records become automations, a fire policy applies the
 * brand hold and the routine's own enabled switch, the run's facts come from the record, and a run's session is launched on the brand's sandbox through the
 * same spawner, proxy session and working folder a turn gets. Nothing a run does reaches a person: the engine's runs may send nothing.
 */
export class ExtensionRoutineEngine {
  readonly automations: HostAutomations;
  /** The host's session store (usable once `start` opened the host). */
  readonly store: SessionStore;
  /** The host's agent port (usable once `start` opened the host). */
  private readonly port: ClaudeAgentPort;
  private host: MarshalHost | null = null;
  private readonly signatures = new Map<string, string>();
  private readonly packages = new Map<string, string>();
  /** The registry's resolved package of a brand's routine, materialized on this host: `<brand>:<extension id>` to its folder. */
  private readonly tenantPackages = new Map<string, string>();
  /** Each launched run's profile as a Marley prompt layer, by its SESSION_PROMPT label. */
  private readonly runLayers = new Map<string, PromptLayer>();
  /** What the registry resolved for each brand routine at its latest check, for the run's pin. */
  private readonly pins = new Map<string, { extensionId: string; agentId: string; version: number; contentHash: string; copyTenant: string }>();
  /** Serializes registrations: a record edited twice quickly registers in order. */
  private chain: Promise<void> = Promise.resolve();
  private readonly aborts = new Map<string, AbortController>();
  /** Each routine session's runtime server for the host (remoteOf), filled when its run opens the sandbox. */
  private readonly remoteHolders = new Map<string, RemoteRuntime>();
  /** The shop day each automation's latest fire covers (the fire field `yesterday`), for the outcome told to the server. */
  private readonly covered = new Map<string, string>();
  /** The slot (epoch ms of the fire's scheduled time) each automation last fired for: the run log, the report file and the graph key on it, as they did on the server. */
  private readonly slots = new Map<string, number>();
  /** Runs that started and have not settled, for the watchdog (a fire that records no outcome is an incident). */
  private readonly running = new Map<string, { brandId: string; routineId: string; slot: number; testSlot?: string; delivery?: { revision: number; memberId: string } }>();
  /**
   * The test slot the next run of `brand:routine` belongs to: set by `runNow`/`fire` for a test, and by the fire policy for a test chain's own `after` fire
   * (`claimTestFire`), taken when that run starts. It lapses after TEST_SLOT_TTL_MS, so a fire that never started never turns a later real run into a test.
   */
  private readonly nextTestSlot = new Map<string, { slot: string; until: number }>();
  /** The test slot of each running test-chain session: its end passes the slot on to the routines that follow it, so the SDK's `after` fire runs them as the same test. */
  private readonly testSessions = new Map<string, string>();
  /** The run report each finished run left, kept until the session's settled event tells the server. */
  private readonly reports = new Map<string, { slot: number; report: RoutineReport | null }>();
  private ownerSchedules: OwnerScheduleHooks | null = null;
  /** A rework the outbox asked of a finished run (`reworkRun`), waiting for the run's session to take the message: its home and the turn's own send folder. */
  private readonly reworkNext = new Map<string, { home: ConversationKey; turnId: string }>();
  /** How many rework turns each session has had (the next turn's send folder is `<session>-rw<n>`). */
  private readonly reworkRounds = new Map<string, number>();
  /** Rework turns that started on the sandbox and whose end the host has not told yet: the session event (`ended`) and the settled call (`settled`) of each are theirs, not a run's. */
  private readonly reworkEnds = new Map<string, number>();
  private readonly reworkSettles = new Map<string, { home: ConversationKey; turnId: string }[]>();
  /** Outbox parts each running session wrote (read and handed to runSends), told with its outcome. */
  private readonly outboxedParts = new Map<string, number>();
  /** A rework the outbox asked for while its session was still working (reworkRun): started when that turn settles. */
  private readonly reworkWaiting = new Map<string, { brandId: string; sessionId: string; home: ConversationKey; text: string }>();
  /**
   * Server fires waiting for their session to start, in fire order per automation: the SDK starts an automation's manual fires in the order they were made, so
   * two members' fires of one brand never swap their input or home. `inputFor` reads the head; the run takes it when its session starts on the sandbox.
   */
  private readonly pendingFires = new Map<string, PendingFire[]>();
  /** The routine graph's <upstream_state> block for the next run of a brand routine (`brand:routine`), set by the gate or a graph fire and taken when that run starts. */
  private readonly upstream = new Map<string, string>();
  /**
   * The graph's block for a test chain's run (`brand:routine@slot`), taken once by the run of that test slot, never by a real run; it lapses with the slot
   * (TEST_SLOT_TTL_MS) and is dropped when the test fire is refused.
   */
  private readonly testUpstreams = new Map<string, { state: string; until: number }>();
  /**
   * A test run's end being announced: the SDK's `after` fires it starts then, one per routine that follows the upstream, are that test chain's fires. Only
   * those carry the test slot past the fire policy; any other fire of the same routine is a real one and is gated.
   */
  private readonly testEmits = new Set<{ tenant: string; slot: string; followers: Set<string> }>();
  /** Sessions of awaited runs (`runGated`): their caller has the answer, so the settled event tells the server nothing. */
  private readonly awaitedSessions = new Set<string>();
  /** What each finished run said last (final text, cost), kept until its settled event. */
  private readonly results = new Map<string, { text: string | null; costUsd: number; home: ConversationKey }>();
  /** Each routine's release triggers (`declaredTriggers`), read once per process. */
  private readonly releaseDeclared = new Map<string, RoutineTriggers | null>();
  /** The forks and lanes of running sessions (`marley.fork.run`, `marley.lane.start`; Omer R9). */
  private readonly delegations: RoutineDelegations;

  /** The breaker forks' verdicts of a run (by its session id), taken once: free time reads them when the run ends (routine-delegation.ts). */
  breakerVerdicts(runSessionId: string): ReturnType<RoutineDelegations["takeVerdicts"]> {
    return this.delegations.takeVerdicts(runSessionId);
  }

  /** A breaker free time starts after a run that asked about a move no breaker of it looked at (routine-delegation.ts `breakAfter`). */
  breakAfterRun(runSessionId: string, brandId: string, move: string, brief: string): ReturnType<RoutineDelegations["breakAfter"]> {
    return this.delegations.breakAfter(runSessionId, brandId, move, brief);
  }

  constructor(private readonly deps: RoutineEngineDeps) {
    this.delegations = new RoutineDelegations({
      // Straight to the port, not composingPort: a child names its parent's prompt label, so it gets the run's Marley layer as it is.
      launch: (request) => { this.port.launch(request); },
      session: (sessionId) => this.host?.sessions.get(sessionId),
      store: () => this.store,
      abort: (sessionId) => this.aborts.get(sessionId)?.abort(),
      logger: deps.logger,
    });
    for (const folder of deps.packages) {
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, "runtime-extension.json"), "utf8")) as { identity: string };
      this.packages.set(manifest.identity, folder);
    }
    for (const [routineId, entry] of Object.entries(ENGINE_ROUTINES)) {
      if (!this.packages.has(entry.extension)) throw new Error(`routine engine: the package ${entry.extension} for ${routineId} is not among the release packages`);
    }
    const root = path.join(deps.root, "marshal-routines");
    // The host opens in `start` (createMarshalHost is async); the automations and the run records hold these two until then and use them only after it.
    this.store = lazyObject(() => this.started.sessions);
    this.port = lazyObject(() => this.started.agents, { hostId: deps.hostId });
    this.automations = new HostAutomations({
      root,
      port: this.composingPort(),
      sessions: this.store,
      store: new SqliteAutomationStore(deps.database),
      extensions: { resolve: (id, tenant) => { const root = (tenant ? this.tenantPackages.get(`${tenant}:${id}`) : undefined) ?? this.packages.get(id); return root ? { packageRoot: root } : undefined; } },
      ...(deps.jobs ? { jobs: deps.jobs } : {}),
      firePolicy: (request) => this.policy(request),
      contextFor: (request) => this.context(request),
      inputFor: (request) => this.inputs(request),
      tenantLabel: SESSION_BRAND,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
      log: (line) => deps.logger.debug("routine_engine.automations", { line }),
    });
  }

  private get started(): MarshalHost {
    if (!this.host) throw new Error("routine engine: the host has not started (await start())");
    return this.host;
  }

  /**
   * The routines' Marshal SDK host: every run is a session of its port, its prompt is the host's (Marshal agent prompt v2 with the host's memory,
   * forks, decisions and session tools, Marley's host layer) with the run's profile as the session's layer. Sessions run on the brand's sandbox
   * (runOnSandbox); the host's MCP servers never attach (SB01), it gets no environment of this process, no browser, no repository rules and no
   * native-subagent hook. The automations stay Marley's own (SQLite store, fire policy); the host's own scheduler does not start.
   */
  private async openHost(): Promise<MarshalHost> {
    if (this.host) return this.host;
    const deps = this.deps;
    const root = path.join(deps.root, "marshal-routines");
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const host = await createMarshalHost({
      // One host for every brand's routine runs: the session tools see only the caller's brand (marshal-sdk #117).
      sessionScopeLabel: MARLEY_SESSION_SCOPE,
      workspacePath,
      stateRoot: root,
      runId: deps.hostId,
      host: { id: deps.hostId, kind: "marley-agent-server" },
      env: {},
      model: "sonnet",
      browser: false,
      repoRules: false,
      nativeSubagentGuard: false,
      automations: { start: false },
      query: (params) => this.runOnSandbox(params as { prompt: unknown; options: Record<string | symbol, unknown> }),
      // A Gemini model (a profile's, or ROUTINE_MODEL in place of an Opus one, routineModelFor) runs on Antigravity, its bridge on the run's brand VM, through
      // the capped Vertex route. Its turns still run through runOnSandbox (wrapRoutedTurns), so the sandbox, outbox, report, sheet and gated answer hold on
      // either provider; the turn's extras carry the provider's query, which modelQuery runs in place of Claude Code with the sandbox's own bridge.
      providerFor: (session) => MARLEY_PROVIDER_FOR(routineModelSession(session.model, deps.routineModel ?? null)),
      wrapRoutedTurns: true,
      antigravityBridgeFor: () => UNSET_RUN_BRIDGE,
      prompt: { ...marleyHostPrompt(deps.agentName ?? "Marley"), session: (session) => this.runLayers.get(session.labels?.[SESSION_PROMPT] ?? "") },
      // The same Brain memory as the chat's host: one brand's memory, whichever host ran the session.
      ...(deps.memory ? { memory: deps.memory } : {}),
      // The brand's chats for the dream's and every run's searchSessions (the session scope label bounds them to the run's brand).
      ...(deps.orgSearch ? { orgSearch: { objects: deps.orgSearch.objects, workspace: deps.orgSearch.workspace } } : {}),
      // The dream's `marley.runs.today` and `marley.extension.list`: server state, answered on the host for the calling run's own brand (its session's
      // `brand` label), never forwarded to the VM (marshal-sdk #124 remoteEmbedderTools; routine-host-capabilities.ts).
      providerSources: [
        () =>
          createRoutineHostCapabilities({
            brandOf: (sessionId) => (sessionId ? this.host?.sessions.get(sessionId)?.labels?.[MARLEY_SESSION_SCOPE] : undefined),
            ...(deps.orgSearch?.env ? { org: { objects: deps.orgSearch.objects, env: deps.orgSearch.env } } : {}),
            ...(deps.extensionList ? { extensionList: deps.extensionList } : {}),
            ...(deps.exchanges ? { exchanges: deps.exchanges } : {}),
            delegate: this.delegations,
          }) as never,
        ...(deps.tickets || deps.brandStack
          ? [() => createBrandHostCapabilities({ labelsOf: (sessionId) => (sessionId ? this.host?.sessions.get(sessionId)?.labels : undefined), tools: brandHostTools(deps), ...(deps.tickets ? { tickets: deps.tickets } : {}), ...(deps.brandStack ? { stack: deps.brandStack } : {}), logger: deps.logger }) as never]
          : []),
      ],
      remoteEmbedderTools: [...ROUTINE_EMBEDDER_TOOLS, ...brandHostTools(deps)],
      // Every routine session keeps the host's `marshal` server (strictMcpConfig: the VM's own settings add or shadow nothing), as a chat turn on a
      // remote_runtime@1 VM does: its runtime_* calls go to the run's own runtime on the brand VM (remoteRuntime, SB01) and the host answers only
      // ROUTINE_REMOTE_HOST_TOOLS itself, bounded to the session's brand (sessionScopeLabel above, the memory scopes in brain-memory/). A run on a VM
      // without that runtime drops the host's servers again before it starts (withHostTools), so it runs as before.
      launchOptionsFor: () => ({ strictMcpConfig: true }),
      remoteRuntime: (session) => this.remoteOf(session.id),
      remoteHostTools: ROUTINE_REMOTE_HOST_TOOLS,
      log: (line) => deps.logger.debug("routine_engine.host", { line }),
      // The automations learn a run ended from this event (the `after` chain waits for it); the run records publish from it too.
      onSessionEvent: (type, payload) => {
        void this.ended(type, payload).catch((error) => deps.logger.warn("routine_engine.emit_failed", { message: error instanceof Error ? error.message : String(error) }));
        deps.onSessionEvent?.(type, payload);
      },
    });
    host.agents.onSettled((sessionId, outcome) => void this.settled(sessionId, outcome));
    this.host = host;
    return host;
  }

  /**
   * The port as the automations see it: a profile's `promptMode: "replace"` text is not sent as the run's own prompt (it would replace the Marshal
   * prompt). Its layers become the session's Marley layer on the Marshal base instead (profilePromptLayer), found by the session's label when the
   * port renders the prompt. Every other call goes to the port unchanged.
   */
  private composingPort(): ClaudeAgentPort {
    const port = this.port;
    const launch = (request: AgentLaunchRequest) => {
      if (request.systemPrompt === undefined) return port.launch(request);
      const { systemPrompt, ...rest } = request;
      this.runLayers.set(request.idempotencyKey, this.runLayer(request, systemPrompt));
      return port.launch({ ...rest, labels: { ...request.labels, [SESSION_PROMPT]: request.idempotencyKey } });
    };
    return new Proxy(port, {
      get: (target, key) => {
        if (key === "launch") return launch;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** A run's profile (named by its launch labels) as a Marley layer; its whole text as the role text when the profile cannot be split. */
  private runLayer(request: AgentLaunchRequest, composed: string): PromptLayer {
    const labels = request.labels ?? {};
    const tenant = labels[SESSION_BRAND];
    const rootOf = (identity: string) => (tenant ? this.tenantPackages.get(`${tenant}:${identity}`) : undefined) ?? this.packages.get(identity);
    try {
      const extension = labels.extension;
      const agent = labels.agent;
      const packageRoot = extension ? rootOf(extension) : undefined;
      if (!packageRoot || !agent) throw new Error("the run names no extension agent");
      const { profile } = resolveAgent(packageRoot, agent, undefined, rootOf);
      if (!profile.layers?.length) return { role: "worker", roleText: composed };
      return profilePromptLayer({ layers: profile.layers.map((layer) => layer.ref), ...(profile.layerVars ? { layerVars: profile.layerVars } : {}), sources: rootOf, profilePrompt: profile.prompt, composed, role: "worker" });
    } catch (error) {
      this.deps.logger.warn("routine_engine.prompt_unsplit", { extension: labels.extension, agent: labels.agent, message: error instanceof Error ? error.message : String(error) });
      return { role: "worker", roleText: composed };
    }
  }

  /**
   * A session went idle or failed: the automations record the run's end and owe the `after` chain its downstream. The SDK's `after` fire is the only
   * way a chain moves on, test or real. A test chain's run first hands its test slot to every routine that follows it, so the downstream the SDK fires
   * is the same test (nothing delivered, completion under the test slot), never a real run that could reach the owner.
   */
  private async ended(type: "session.idle" | "session.failed", payload: Record<string, unknown>): Promise<void> {
    const sessionId = String(payload.sessionId ?? "");
    // A rework turn's end is not a run's end: the automations never see it, so no `after` chain moves on twice.
    const owedEnds = this.reworkEnds.get(sessionId) ?? 0;
    if (owedEnds > 0) {
      if (owedEnds === 1) this.reworkEnds.delete(sessionId); else this.reworkEnds.set(sessionId, owedEnds - 1);
      return;
    }
    const testSlot = this.testSessions.get(sessionId);
    this.testSessions.delete(sessionId);
    const automationId = (payload.labels as Record<string, string> | undefined)?.automation;
    let emit: { tenant: string; slot: string; followers: Set<string> } | undefined;
    if (testSlot && automationId && type === "session.idle") {
      const upstream = this.automations.list().find((candidate) => candidate.id === automationId);
      if (upstream?.tenant) emit = { tenant: upstream.tenant, slot: testSlot, followers: new Set(this.followers(upstream).map((follower) => follower.id)) };
    }
    if (emit) this.testEmits.add(emit);
    try {
      await this.automations.emit(type, payload);
    } finally {
      if (emit) this.testEmits.delete(emit);
    }
  }

  /** The test slot of an `after` fire a test run's end started (see `testEmits`), claimed once per following routine; undefined for every other fire. */
  private claimTestFire(automation: Automation): string | undefined {
    for (const emit of this.testEmits) {
      if (emit.tenant !== automation.tenant || !emit.followers.delete(automation.id)) continue;
      return emit.slot;
    }
    return undefined;
  }

  /** The brand's automations whose `after` trigger names this one (by id or by its agent). */
  private followers(upstream: Automation): Automation[] {
    return this.automations.list(upstream.tenant).filter((candidate) => {
      const trigger = (candidate as { trigger?: { type?: string; routine?: string | string[] } }).trigger;
      if (trigger?.type !== "after" || trigger.routine === undefined) return false;
      const names = Array.isArray(trigger.routine) ? trigger.routine : [trigger.routine];
      return names.includes(upstream.id) || (upstream.routineId !== undefined && names.includes(upstream.routineId));
    });
  }

  /** Whether the brand's routine runs after another one (an SDK `after` trigger): a test chain then reaches it through that trigger, never through a second fire. */
  followsAnother(brandId: string, routineId: string): boolean {
    const automation = this.find(brandId, routineId);
    return (automation as { trigger?: { type?: string } } | undefined)?.trigger?.type === "after";
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now().getTime() : Date.now();
  }

  /** The owner-schedule side (late-bound: it needs this engine's automations). Without it an owner-schedule fire is skipped. */
  setOwnerSchedules(hooks: OwnerScheduleHooks): void {
    this.ownerSchedules = hooks;
  }

  /** Registers every stored record of an engine routine, then starts the clock (its first tick fires what fell due while the server was down). */
  async start(): Promise<void> {
    await this.openHost();
    const registered = new Set<string>();
    const rows = this.deps.registry.db.prepare("SELECT brand_id, routine_id FROM routine_registry").all() as { brand_id: string; routine_id: string }[];
    for (const row of rows) {
      if (!engineOwns(row.routine_id)) continue;
      const record = this.deps.registry.get(row.brand_id, row.routine_id);
      if (!record) continue;
      registered.add(`${record.routine.brandId}:${record.routine.routineId}`);
      await this.sync(record);
    }
    // An automation whose record is gone (a brand removed while the server was down) is dropped.
    for (const automation of this.automations.list()) {
      if (automation.job) continue;
      if (automation.labels?.[SESSION_KIND] === OWNER_SCHEDULE_KIND) continue;
      if (automation.labels?.[FIRED_BY] === "server") continue;
      const key = `${automation.tenant}:${this.routineOf(automation)}`;
      if (!registered.has(key)) await this.automations.delete(automation.id).catch(() => undefined);
    }
    if (this.deps.extensions) await this.pinAll(registered);
    this.automations.start();
  }

  /** Materializes what the registry resolves for each registered brand routine and for every brand-owned binding, so a fork resolves before its first fire. */
  private async pinAll(registered: ReadonlySet<string>): Promise<void> {
    const brands = new Set<string>();
    for (const key of registered) brands.add(key.slice(0, key.indexOf(":")));
    for (const brandId of brands) {
      const bindings = await this.deps.extensions!.listBindings(brandId).catch((error: unknown) => { this.deps.logger.warn("routine_engine.bindings_failed", { brandId, message: error instanceof Error ? error.message : String(error) }); return []; });
      const routines = new Set<string>([...bindings.map((binding) => binding.routineId), ...Object.keys(ENGINE_ROUTINES)]);
      for (const routineId of routines) await this.pin(brandId, routineId);
    }
  }

  /** Asks the registry which package the brand's routine runs now and keeps it on this host (a fork is materialized once per content hash). */
  private async pin(brandId: string, routineId: string): Promise<void> {
    if (!this.deps.extensions) return;
    try {
      const resolved = await this.deps.extensions.resolveRoutine(brandId, routineId);
      const key = `${brandId}:${routineId}`;
      if (!resolved) { this.pins.delete(key); return; }
      fs.mkdirSync(path.join(this.deps.root, "marshal-routines", "registry", brandId), { recursive: true });
      const folder = path.join(this.deps.root, "marshal-routines", "registry", brandId, `${resolved.extensionId.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${resolved.contentHash.slice(0, 16)}`);
      if (!fs.existsSync(path.join(folder, "runtime-extension.json"))) {
        fs.rmSync(folder, { recursive: true, force: true });
        await resolved.materialize(folder);
      }
      this.tenantPackages.set(`${brandId}:${resolved.extensionId}`, folder);
      this.pins.set(key, { extensionId: resolved.extensionId, agentId: resolved.agentId, version: resolved.version, contentHash: resolved.contentHash, copyTenant: resolved.copyTenant });
    } catch (error) {
      this.deps.logger.warn("routine_engine.pin_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async stop(): Promise<void> {
    for (const controller of this.aborts.values()) controller.abort();
    await this.automations.stop();
    await this.host?.dispose();
  }

  /** A routine record was saved: registers, re-registers or removes its automation. Safe to call from the registry's synchronous callback. */
  configured(record: RoutineRecord): void {
    // The Meta analysis is not an engine routine: the agent server runs it itself (routines/ua-server). Its record still decides how the daily build starts.
    if (!engineOwns(record.routine.routineId) && record.routine.routineId !== UA_CBO) return;
    this.chain = this.chain.then(async () => {
      if (record.routine.routineId !== UA_CBO) await this.sync(record);
      // The daily build follows the Meta analysis only while that one is live, so a change to the analysis re-decides the daily build.
      if (record.routine.routineId === UA_CBO) {
        const daily = this.deps.registry.get(record.routine.brandId, OWNER_REPORT_DAILY);
        if (daily) await this.sync(daily);
      }
    }).catch((error) => this.deps.logger.warn("routine_engine.sync_failed", { brandId: record.routine.brandId, routineId: record.routine.routineId, message: error instanceof Error ? error.message : String(error) }));
  }

  /** Throws `routine engine: X is not registered for the brand` unless the engine holds an automation for the routine: the one gate every manual and test run passes. */
  assertRegistered(brandId: string, routineId: string): void {
    if (!this.find(brandId, routineId)) throw new Error(`routine engine: ${routineId} is not registered for the brand`);
  }

  /** Runs a routine now (the inspector's and the harness's "run now"), as a manual fire: the policy is not asked. Returns the Marshal session id. */
  async runNow(brandId: string, routineId: string, testSlot?: string): Promise<string> {
    const automation = this.find(brandId, routineId);
    if (!automation) throw new Error(`routine engine: ${routineId} is not registered for the brand`);
    await this.pin(brandId, routineId);
    if (testSlot) this.nextTestSlot.set(`${brandId}:${routineId}`, { slot: testSlot, until: this.nowMs() + TEST_SLOT_TTL_MS });
    return this.automations.runNow(automation.id);
  }

  /** A fire the routine graph decided (its upstreams finished, an owed fire, the build's retry): a manual fire of the routine whose run is told the graph's block. */
  async runFromGraph(brandId: string, routineId: string, upstreamState: string): Promise<string> {
    this.assertRegistered(brandId, routineId);
    this.upstream.set(`${brandId}:${routineId}`, upstreamState);
    return this.runNow(brandId, routineId);
  }

  /** The routine graph's block for a test chain's run of this routine (the inspector's test slot): told to that test run only, never to a real one. */
  testUpstream(brandId: string, routineId: string, testSlot: string, upstreamState: string): void {
    const now = this.nowMs();
    for (const [key, entry] of this.testUpstreams) if (entry.until < now) this.testUpstreams.delete(key);
    this.testUpstreams.set(`${brandId}:${routineId}@${testSlot}`, { state: upstreamState, until: now + TEST_SLOT_TTL_MS });
  }

  /**
   * Starts a server-fired routine now for a brand: the server's gate already decided (window, consent, claim), so the fire policy is not asked. The brand's automation is made
   * on first use and kept. Returns the Marshal session id; the run's end reaches the server through `onOutcome`. Throws for a routine that is not server-fired.
   */
  async fire(brandId: string, routineId: string, run: ServerFire = {}): Promise<string> {
    const automation = await this.serverAutomation(brandId, routineId);
    return this.fireQueued(automation.id, { fire: run });
  }

  /**
   * Runs a server-fired routine for one brand now and waits for its end (free time, the dream): the caller is the gate, and it gets the run's answer
   * itself. The run's home is `request.key`; it is listed no reply tool, writes no run report and tells `onOutcome` nothing.
   */
  async runGated(routineId: string, request: GatedRunRequest): Promise<GatedRunResult> {
    const automation = await this.serverAutomation(request.brandId, routineId);
    return new Promise<GatedRunResult>((resolve, reject) => {
      this.fireQueued(automation.id, { fire: { input: request.input, home: request.key }, waiter: { request, resolve, reject } }).catch(reject);
    });
  }

  /**
   * The outbox agent's rework of what a finished run wrote (the composer's `rework` of a piece whose `runId` is this session): the run's own session takes `text`
   * (the note and its old words) as its next message, in the same home, and what it puts to the outbox then goes to `onReworked`. Refused for a session this
   * engine does not know, of another brand, of an owner's schedule or an awaited run, and while the session is running or already has a rework waiting.
   */
  async reworkRun(input: { brandId: string; sessionId: string; home: ConversationKey; text: string }): Promise<"started" | "refused"> {
    const host = this.host;
    const record = host?.sessions.get(input.sessionId);
    const labels = record?.labels;
    if (!host || !labels || labels[SESSION_BRAND] !== input.brandId || !labels[SESSION_ROUTINE] || labels[SESSION_KIND] === OWNER_SCHEDULE_KIND) return "refused";
    // A lane speaks like an awaited run, which takes no rework either.
    if (input.home.brandId !== input.brandId || this.awaitedSessions.has(input.sessionId) || labels[DELEGATION_LABEL]) return "refused";
    // One rework at a time per session; the outbox offers the piece again when its wait ends.
    if (this.reworkNext.has(input.sessionId) || this.reworkWaiting.has(input.sessionId)) return "refused";
    // The run (or an earlier rework turn) is still working: its words reach the outbox while it works, so the outbox can send them back before it ends. The
    // rework is its next turn, started when this one settles (settled).
    if (this.running.has(input.sessionId) || this.aborts.has(input.sessionId) || host.agents.isRunning(input.sessionId)) {
      this.reworkWaiting.set(input.sessionId, input);
      this.deps.logger.info("routine_engine.rework_queued", { brandId: input.brandId, routineId: labels[SESSION_ROUTINE], sessionId: input.sessionId });
      return "started";
    }
    return this.startRework(host, input, labels[SESSION_ROUTINE]);
  }

  /** Starts the rework turn of a settled session (`reworkRun`): the port resumes the session with the outbox's message as its prompt (runOnSandbox takes it). */
  private startRework(host: MarshalHost, input: { brandId: string; sessionId: string; home: ConversationKey; text: string }, routineId: string): "started" | "refused" {
    const round = (this.reworkRounds.get(input.sessionId) ?? 0) + 1;
    const turnId = `${input.sessionId}-rw${round}`;
    this.reworkNext.set(input.sessionId, { home: input.home, turnId });
    try {
      host.agents.send(input.sessionId, input.text);
    } catch (error) {
      this.reworkNext.delete(input.sessionId);
      this.deps.logger.warn("routine_engine.rework_refused", { brandId: input.brandId, routineId, message: error instanceof Error ? error.message : String(error) });
      return "refused";
    }
    this.reworkRounds.set(input.sessionId, round);
    this.deps.logger.info("routine_engine.rework_started", { brandId: input.brandId, routineId, sessionId: input.sessionId, round });
    return "started";
  }

  /** Queues the fire and starts it as a manual fire (`emit` would build the task from the event text and drop the agent's task template). */
  private async fireQueued(automationId: string, pending: PendingFire): Promise<string> {
    const queue = this.pendingFires.get(automationId) ?? [];
    queue.push(pending);
    this.pendingFires.set(automationId, queue);
    try {
      return await this.automations.runNow(automationId);
    } catch (error) {
      const left = this.pendingFires.get(automationId);
      const at = left?.indexOf(pending) ?? -1;
      if (left && at >= 0) left.splice(at, 1);
      throw error;
    }
  }

  /** The brand's automation of a server-fired routine, made on first use. Its event trigger is never emitted: only `fire` and `runGated` start it. */
  private async serverAutomation(brandId: string, routineId: string): Promise<Automation> {
    const entry = ENGINE_ROUTINES[routineId];
    if (!entry?.server) throw new Error(`routine engine: ${routineId} is not a server-fired routine`);
    let existing = this.find(brandId, routineId);
    // A routine that moved to another package (Omer R148: brief-send into @marley/daily-brief) keeps no automation naming the old one: it would launch a package the release no longer ships.
    if (existing && (existing.extension?.id !== entry.extension || existing.extension?.agent !== entry.agent)) {
      this.deps.logger.info("routine_engine.server_automation_moved", { brandId, routineId, from: existing.extension?.id ?? null, to: entry.extension });
      await this.automations.delete(existing.id);
      existing = undefined;
    }
    const automation = existing ?? await this.automations.create({
      name: entry.agent,
      description: `${routineId}, started by the server's gate`,
      tenant: brandId,
      routineId: entry.agent,
      extension: { id: entry.extension, agent: entry.agent },
      labels: { [SESSION_ROUTINE]: routineId, [FIRED_BY]: "server" },
      triggerType: "event",
      event: `marley.fire.${routineId}`,
    }, "routine-engine:server");
    await this.pin(brandId, routineId);
    return automation;
  }

  /** What the watchdog looks at: fires held or waiting for their time (owed), and runs that started and have not ended. */
  watch(): { owed: { brandId: string; routineId: string; slot: number }[]; running: { brandId: string; routineId: string; slot: number }[] } {
    const owed = this.automations.list().filter((automation) => automation.labels?.[SESSION_KIND] !== OWNER_SCHEDULE_KIND).flatMap((automation) => {
      const brandId = automation.tenant;
      if (!brandId) return [];
      const routineId = this.routineOf(automation);
      return (automation.owed ?? []).flatMap((fire) => { const slot = Date.parse(fire.scheduledFor ?? fire.dueAt); return Number.isFinite(slot) ? [{ brandId, routineId, slot }] : []; });
    });
    return { owed, running: [...this.running.values()] };
  }

  /** Waits until every registration so far has been applied (tests). */
  async idle(): Promise<void> {
    await this.chain;
  }

  private find(brandId: string, routineId: string): Automation | undefined {
    return this.automations.list(brandId).find((candidate) => this.routineOf(candidate) === routineId);
  }

  private routineOf(automation: Automation): string {
    // The routine label first: a brand-made routine's agent may share a release agent's name.
    const labelled = automation.labels?.[SESSION_ROUTINE];
    if (labelled) return labelled;
    const agent = automation.extension?.agent;
    return Object.entries(ENGINE_ROUTINES).find(([, entry]) => entry.agent === agent)?.[0] ?? automation.routineId ?? automation.id;
  }

  /** A run the server's own start queued (a server-fired routine, or a brand-made routine its declared trigger started): it takes its fire's input and home. */
  private firedByServer(routineId: string, automation: Automation | undefined): boolean {
    return serverFired(routineId) || automation?.labels?.[FIRED_BY] === "server";
  }

  /**
   * Starts a brand-made routine (an approved `@brand/<slug>` package bound to the routine id) now, because its declared trigger fired (trigger-dispatcher.ts): the
   * brand's pinned package runs as a server fire, with `run` as its input and home. Returns the Marshal session id; its end reaches the server through onOutcome.
   */
  async fireBrand(brandId: string, routineId: string, run: ServerFire = {}): Promise<string> {
    if (Object.hasOwn(ENGINE_ROUTINES, routineId)) throw new Error(`routine engine: ${routineId} is a release routine, not a brand-made one`);
    await this.pin(brandId, routineId);
    const pinned = this.pins.get(`${brandId}:${routineId}`);
    if (!pinned) throw new Error(`routine engine: ${routineId} resolves to no package for the brand`);
    let automation = this.find(brandId, routineId);
    if (automation && (automation.extension?.id !== pinned.extensionId || automation.extension?.agent !== pinned.agentId)) {
      await this.automations.delete(automation.id);
      automation = undefined;
    }
    automation ??= await this.automations.create({
      name: routineId,
      description: `${routineId}, the brand's own routine, started by its declared trigger`,
      tenant: brandId,
      routineId,
      extension: { id: pinned.extensionId, agent: pinned.agentId },
      labels: { [SESSION_ROUTINE]: routineId, [FIRED_BY]: "server" },
      triggerType: "event",
      event: `marley.fire.${routineId}`,
    }, "routine-engine:brand");
    return this.fireQueued(automation.id, { fire: run });
  }

  /** The triggers a routine's release package declares (`routines/<agent>.yaml`), read once; null when it ships none. */
  declaredTriggers(routineId: string): RoutineTriggers | null {
    if (this.releaseDeclared.has(routineId)) return this.releaseDeclared.get(routineId)!;
    const entry = ENGINE_ROUTINES[routineId];
    const root = entry ? this.packages.get(entry.extension) : undefined;
    let triggers: RoutineTriggers | null = null;
    try { triggers = root && entry ? releaseTriggers(root, entry.agent) : null; } catch (error) {
      this.deps.logger.warn("routine_engine.triggers_unreadable", { routineId, message: error instanceof Error ? error.message : String(error) });
    }
    this.releaseDeclared.set(routineId, triggers);
    return triggers;
  }

  private async sync(record: RoutineRecord): Promise<void> {
    const { routine } = record;
    const entry = ENGINE_ROUTINES[routine.routineId]!;
    const id = `${routine.brandId}:${routine.routineId}`;
    await this.pin(routine.brandId, routine.routineId);
    const existing = this.find(routine.brandId, routine.routineId);
    const live = routine.enabled && this.deps.registry.available(routine, record.memberId);
    if (!live) {
      if (existing) await this.automations.delete(existing.id);
      this.signatures.delete(id);
      return;
    }
    // The daily build follows the brand's Meta analysis when the brand has one switched on; otherwise it keeps its own schedule.
    const follows = routine.routineId === OWNER_REPORT_DAILY && metaAnalysisLive(this.deps.registry, routine.brandId);
    const signature = signatureOf(record, follows);
    if (existing && this.signatures.get(id) === signature) return;
    if (existing && !this.signatures.has(id) && existing.enabled && existing.labels?.signature === signature) {
      this.signatures.set(id, signature);
      return;
    }
    if (existing) await this.automations.delete(existing.id);
    const created = await this.automations.create({
      name: routine.name,
      description: routine.description,
      tenant: routine.brandId,
      routineId: entry.agent,
      extension: { id: entry.extension, agent: entry.agent },
      labels: { [SESSION_ROUTINE]: routine.routineId, signature },
      ...(follows
        ? { triggerType: "event" as const, event: GRAPH_ONLY_EVENT }
        : { schedule: routine.cadence, timezone: routine.timezone }),
    }, `routine-registry:${routine.revision}`);
    this.signatures.set(id, signature);
    this.deps.logger.info("routine_engine.registered", { brandId: routine.brandId, routineId: routine.routineId, automation: created.id, trigger: follows ? "graph" : "schedule" });
  }

  /** Asked before every automatic fire. The record decides on a fresh read: a routine switched off or no longer available since registration is dropped. */
  private async policy(request: FireRequest): Promise<FireDecision> {
    // A server job is not a routine: it has no record, and its handler decides whether the server admits it now. A trigger job that follows a test chain's run
    // is that test's (trigger-dispatcher.ts): it never asks a gate to start the real routine.
    if (request.automation.job) return request.trigger === "after" && this.claimTestFire(request.automation) !== undefined ? "skip" : "go";
    const brandId = request.tenant ?? request.automation.tenant;
    if (request.automation.labels?.[SESSION_KIND] === OWNER_SCHEDULE_KIND) {
      const scheduleId = request.automation.labels[SESSION_SCHEDULE];
      return brandId && scheduleId && this.ownerSchedules ? this.ownerSchedules.decide(brandId, scheduleId) : "skip";
    }
    const routineId = this.routineOf(request.automation);
    if (!brandId) return "skip";
    // A test chain's own `after` fire (started by its test upstream's end): the graph already decided it under the test slot (fireTest), so the real day's
    // gate is not asked. A refused test fire is dropped, never owed: a held fire would come back later as a real run.
    const testSlot = request.trigger === "after" ? this.claimTestFire(request.automation) : undefined;
    // A brand-made routine (fireBrand) has no routine record: its declared trigger and the dispatcher decided the start. The brand's hold and the engine switch
    // still apply, and its binding is read again: a routine the owner switched off since resolves to nothing and is skipped.
    if (!testSlot && request.automation.labels?.[FIRED_BY] === "server" && !Object.hasOwn(ENGINE_ROUTINES, routineId) && routineId !== UA_CBO) {
      if (this.deps.enabled?.() === false || this.deps.held(brandId)) return "hold";
      await this.pin(brandId, routineId);
      return this.pins.has(`${brandId}:${routineId}`) ? "go" : "skip";
    }
    const record = this.deps.registry.get(brandId, routineId);
    const refused = !record || !record.routine.enabled || !this.deps.registry.available(record.routine, record.memberId) ? "skip" : this.deps.enabled?.() === false || this.deps.held(brandId) ? "hold" : null;
    if (testSlot) {
      if (refused) {
        this.testUpstreams.delete(`${brandId}:${routineId}@${testSlot}`);
        this.deps.logger.warn("routine_engine.test_fire_dropped", { brandId, routineId, testSlot, decision: refused });
        return "skip";
      }
      this.nextTestSlot.set(`${brandId}:${routineId}`, { slot: testSlot, until: this.nowMs() + TEST_SLOT_TTL_MS });
      await this.pin(brandId, routineId);
      return "go";
    }
    if (refused) return refused;
    const verdict = this.deps.graphGate?.({ brandId, routineId, at: this.nowMs() });
    if (verdict && !verdict.fire) return "skip";
    if (verdict?.upstreamState) this.upstream.set(`${brandId}:${routineId}`, verdict.upstreamState);
    await this.pin(brandId, routineId);
    return "go";
  }

  /**
   * The context slots a profile names, filled with the server's own `<host_context>` block (the one a routine turn gets), not a stand-in. The block carries the
   * clock, the people with their zones and the connected sources itself, so it fills the first slot and the others stay empty rather than repeating it.
   * A block that cannot be built is said in one line: a run never starts on a guessed brand.
   */
  private async context(request: { tenant?: string; slots: readonly string[]; automation: Automation }): Promise<Record<string, string>> {
    const brandId = request.tenant;
    const values: Record<string, string> = {};
    if (!brandId || request.slots.length === 0) return values;
    const hostId = await this.deps.directory.assignedHost?.(brandId, "owner_reports").catch(() => null);
    const block = hostId ? await this.deps.hostContext({ brandId, hostId, routineId: this.routineOf(request.automation) }).catch((error) => {
      this.deps.logger.warn("routine_engine.host_context_failed", { brandId, message: error instanceof Error ? error.message : String(error) });
      return null;
    }) : null;
    request.slots.forEach((slot, index) => { values[slot] = index === 0 ? (block ?? "The brand's context could not be read for this run.") : ""; });
    return values;
  }

  /** The brand facts a routine's input names: the record's currency and revision. */
  private inputs(request: { automation: Automation; tenant?: string; fields: { yesterday: string; scheduledFor?: string } }): Record<string, unknown> | undefined {
    this.covered.set(request.automation.id, request.fields.yesterday);
    const scheduled = Date.parse((request.fields as { scheduledFor?: string }).scheduledFor ?? "");
    if (Number.isFinite(scheduled)) this.slots.set(request.automation.id, scheduled);
    const brandId = request.tenant ?? request.automation.tenant;
    if (!brandId) return undefined;
    const routineId = this.routineOf(request.automation);
    // A server fire's input is the head of its automation's queue: the fire this input call belongs to (its session takes it when it starts).
    if (this.firedByServer(routineId, request.automation)) return this.pendingFires.get(request.automation.id)?.[0]?.fire.input;
    const record = this.deps.registry.get(brandId, routineId);
    if (!record) return undefined;
    // MLY-687: an owner report covers the shop's day (its zone; the day a `shop-day.ready` named wins over the clock), never the owner's. Unknown shop zone: the fire's own fields.
    const shop = routineId === OWNER_REPORT_DAILY ? this.deps.shopClock?.(record.routine) : undefined;
    const coverage = shop ? ownerReportCoverage(record.routine, Number.isFinite(scheduled) ? scheduled : this.nowMs(), shop) : null;
    if (coverage) this.covered.set(request.automation.id, coverage.date);
    const today = coverage?.today ?? (request.fields as { today?: string }).today ?? "";
    return { currency: record.routine.currency, revision: String(record.routine.revision), ...(coverage ? { today: coverage.today, yesterday: coverage.date } : {}) };
  }

  /**
   * The port's backend for a run: the Agent SDK called with the options the profile built, on the brand's sandbox. The sandbox opens when the
   * session's turn starts and closes with it. The run's tools are the sandbox runtime's own (zs.* on the VM), as in a turn; the packages' pack
   * scope (`extensions`) names desktop packs and has no effect here.
   */
  /**
   * The session's runtime server for the host (marshal-sdk `remoteRuntime`). The port builds a turn's MCP servers before the run opens its sandbox,
   * so each session gets a holder now and the run fills it (withHostTools); the SDK reads it only when the first runtime call connects, after that.
   * An unfilled holder runs nothing: `/bin/false` fails the connection, so a runtime call can never run on this server.
   */
  private remoteOf(sessionId: string): RemoteRuntime {
    let holder = this.remoteHolders.get(sessionId);
    if (!holder) {
      holder = { command: "/bin/false", args: [], env: {} };
      this.remoteHolders.set(sessionId, holder);
    }
    return holder;
  }

  /**
   * Before a session's sandbox opens: a turn the host routed to another provider (TurnExtras.routedProvider) runs only on Antigravity, and only on a server
   * with the Vertex route; a Gemini model the host did not route never runs (it would reach Claude Code). Thrown after the run took its fire, so an awaited
   * run's caller gets the failure.
   */
  private routedCheck(options: Record<string | symbol, unknown>): void {
    const routed = (options[TURN_EXTRAS] as TurnExtras | undefined)?.routedProvider;
    const model = String(options.model ?? "(default)");
    if (!routed) {
      if (runsOnAntigravity(options.model)) throw new Error(`routine engine: ${model} runs on Antigravity, and this turn was not routed there; nothing started`);
      return;
    }
    if (routed.runtime !== "antigravity") throw new Error(`routine engine: ${model} runs on ${routed.runtime}, which routine runs do not support`);
    if (!this.deps.antigravity) throw new Error(`routine engine: ${model} runs on Antigravity, and this server has no Vertex route (VERTEX_PROJECT unset); a Gemini run never runs here`);
  }

  /**
   * The model query of a session's turn, once its sandbox is open: Claude Code (deps.query), or for a routed turn the provider's own query with the
   * sandbox's bridge on the brand VM set on the turn (the host's unset one is replaced). A Gemini run needs the VM's runtime server for its tools and its
   * bridge there; without either it fails, never runs a bridge on this server (SB01).
   */
  private modelQuery(options: Options, sandbox: RoutineSandbox): RoutineQuery {
    const extras = (options as Record<symbol, unknown>)[TURN_EXTRAS] as TurnExtras | undefined;
    const routed = extras?.routedProvider;
    if (!routed) return this.deps.query;
    const model = String(options.model ?? "(default)");
    if (!sandbox.remote) throw new Error(`routine engine: ${model} runs on Antigravity, and the brand VM has no runtime server (remote_runtime@1) for its tools`);
    if (!sandbox.antigravity) throw new Error(`routine engine: ${model} runs on Antigravity, and its sandbox has no Antigravity bridge on the brand VM; a Gemini run never runs on this server`);
    (options as Record<symbol, unknown>)[TURN_EXTRAS] = { ...extras, antigravityBridge: antigravityDescriptor(sandbox.antigravity()) };
    return routed.query as unknown as RoutineQuery;
  }

  /**
   * A run's MCP options: on a brand VM with the run's own runtime server (`sandbox.remote`), the host's `marshal` server stays and carries the
   * runtime calls there, and the host's memory and session tools answer (ROUTINE_REMOTE_HOST_TOOLS); otherwise the host's servers are dropped and the
   * VM's own runtime server (its user settings) is the run's, with no host tools, as before.
   */
  private withHostTools(sessionId: string, sandbox: RoutineSandbox, base: Options): Pick<Options, "mcpServers" | "strictMcpConfig"> {
    const holder = this.remoteOf(sessionId);
    if (sandbox.remote) {
      holder.command = sandbox.remote.command;
      holder.args = sandbox.remote.args ?? [];
      holder.env = sandbox.remote.env ?? {};
      if (sandbox.remote.cwd) holder.cwd = sandbox.remote.cwd;
      else delete holder.cwd;
      return { mcpServers: base.mcpServers ?? {}, strictMcpConfig: true };
    }
    return { mcpServers: {}, strictMcpConfig: false };
  }

  /**
   * Reads one session turn's send folder every RUN_SENDS_POLL_MS and on `flush`, and hands each new part to `runSends` once (a part is marked seen only after its
   * hand-over, so a failed one is offered again; the hand-over keys material by the part's id). Reads are chained, never overlapping.
   */
  private sendsOf(sandbox: RoutineSandbox, turn: RunSendsTurn): { flush(): Promise<void>; stop(): void } {
    const deliver = this.deps.runSends;
    const read = sandbox.readSends?.bind(sandbox);
    if (!deliver || !read) return { flush: () => Promise.resolve(), stop: () => undefined };
    const seen = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => (chain = chain.then(async () => {
      const fresh = parseLiveSends(await read(), turn.turnId).filter((entry) => !seen.has(entry.id));
      if (fresh.length === 0) return;
      await deliver(turn, fresh.map((entry) => entry.message));
      for (const entry of fresh) seen.add(entry.id);
      if (turn.kind === "run") this.outboxedParts.set(turn.sessionId, (this.outboxedParts.get(turn.sessionId) ?? 0) + fresh.length);
    }).catch((error: unknown) => this.deps.logger.warn("routine_engine.sends_failed", { brandId: turn.brandId, routineId: turn.routineId, runId: turn.sessionId, turnId: turn.turnId, message: error instanceof Error ? error.message : String(error) })));
    const timer = setInterval(() => { void flush(); }, RUN_SENDS_POLL_MS);
    timer.unref?.();
    return { flush, stop: () => clearInterval(timer) };
  }

  /** Refuses a session whose brand runtime does not list the outbox tools (`outboxRuntime`): it would find no marley.outbox.* and nothing it says may go out another way. */
  private async requireOutboxRuntime(turn: { brandId: string; routineId: string; sessionId: string; hostId: string; turnId?: string }): Promise<void> {
    const probe = this.deps.outboxRuntime;
    if (!probe) return;
    const answer = await probe(turn.brandId, turn.hostId);
    if (answer.supported) return;
    this.deps.logger.error("routine_engine.runtime_without_outbox", { brandId: turn.brandId, routineId: turn.routineId, runId: turn.sessionId, ...(turn.turnId ? { turnId: turn.turnId } : {}), hostId: turn.hostId, outcome: answer.outcome });
    throw new RuntimeWithoutOutboxError(turn.brandId, turn.routineId, answer.outcome);
  }

  private async *runOnSandbox(params: { prompt: unknown; options: Record<string | symbol, unknown> }): AsyncGenerator<SDKMessage> {
    // Every session of this host starts here (runs, awaited runs, forks, lanes, rework turns), so one swap covers them all; forks launched with
    // their parent's recorded (profile) model are swapped again when they start.
    const swapped = routineModelFor(params.options.model, this.deps.routineModel ?? null);
    if (swapped !== params.options.model) params.options.model = swapped;
    const extras = params.options[TURN_EXTRAS] as TurnExtras | undefined;
    const sessionId = extras?.sessionId;
    const record = sessionId ? this.store.get(sessionId) : undefined;
    const brandId = record?.labels?.[SESSION_BRAND];
    const routineId = record?.labels?.[SESSION_ROUTINE];
    // A fork or lane of a run (marley.fork.run, marley.lane.start): its own path, never a fire of the routine whose labels it carries.
    if (sessionId && record?.labels?.[DELEGATION_LABEL]) {
      yield* this.runDelegatedOnSandbox(params.prompt, params.options, sessionId);
      return;
    }
    if (sessionId && brandId && record?.labels?.[SESSION_KIND] === OWNER_SCHEDULE_KIND) {
      // An owner's schedule is not an agent run: its fire is the delivery into the conversation (the old scheduler's fire), and the session only records that it happened.
      const scheduleId = record.labels[SESSION_SCHEDULE];
      if (!scheduleId || !this.ownerSchedules) throw new Error("routine engine: an owner schedule fired with no schedule side");
      await this.ownerSchedules.fire(brandId, scheduleId);
      yield { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: "delivered", total_cost_usd: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKMessage;
      return;
    }
    if (!sessionId || !brandId || !routineId) throw new Error("routine engine: a run without its brand and routine");
    if (typeof params.prompt !== "string") throw new Error("routine engine: a run's prompt is one message");
    // A rework the outbox asked of this finished run: the session's next turn, never a new run (no fire is taken, no report, no outcome).
    const rework = this.reworkNext.get(sessionId);
    if (rework) {
      this.reworkNext.delete(sessionId);
      yield* this.runReworkOnSandbox(params.prompt, params.options, { sessionId, brandId, routineId, ...rework });
      return;
    }
    // A server fire takes its queued fire when its session starts; an awaited one (runGated) runs on its own path.
    const firedAutomation = this.automations.list().find((candidate) => candidate.id === record?.labels?.automation);
    const byServer = this.firedByServer(routineId, firedAutomation);
    const pending = byServer ? this.pendingFires.get(record?.labels?.automation ?? "")?.shift() : undefined;
    if (byServer && !pending) throw new Error(`routine engine: a ${routineId} run started with no fire queued for it`);
    if (pending?.waiter) {
      yield* this.runGatedOnSandbox(params.prompt, params.options, { sessionId, brandId, routineId, waiter: pending.waiter });
      return;
    }
    const hostId = await this.deps.directory.assignedHost?.(brandId, "owner_reports");
    if (!hostId) throw new Error(`no sandbox host is assigned to brand ${brandId}`);
    this.routedCheck(params.options);
    await this.requireOutboxRuntime({ brandId, routineId, sessionId, hostId });
    const controller = new AbortController();
    const callerAbort = params.options.abortController as AbortController | undefined;
    callerAbort?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.aborts.set(sessionId, controller);
    // The run's home is the record's own conversation (the signup owner's DM for a brand that has one, MLY-576): the built brief video is looked for
    // in that conversation's outbox. A routine with no record falls back to the brand-run conversation.
    const fire = pending?.fire;
    const routineRecord = this.deps.registry.get(brandId, routineId);
    const key: ConversationKey = fire?.home ?? routineRecord?.target ?? { brandId, channel: "inspector", conversationId: `brand-run-${brandId}` };
    // Whose data grant the run holds: the record's member, or the brand-run member in the brand-run conversation (MLY-543, as a routine turn bound it).
    // A brand-made routine's fire names its member (the approver, whose DM is its home); the host binds the grant from a fresh read.
    const runMember = fire?.runMember ?? routineRecord?.memberId ?? (isBrandRunConversation(brandId, key.conversationId) ? BRAND_RUN_MEMBER : undefined);
    let native: string | null = null;
    let sandbox: RoutineSandbox | null = null;
    let sends: { flush(): Promise<void>; stop(): void } | null = null;
    try {
      sandbox = await withWakeReason("owner_reports", () => this.deps.openSandbox({ key, hostId, runId: sessionId, signal: controller.signal, ...(fire?.pixelWalk ? { pixelWalk: fire.pixelWalk } : {}), ...(runMember !== undefined ? { runMember } : {}) }));
      this.delegations.enter(sessionId, { brandId, routineId, home: key, ...(runMember !== undefined ? { runMember } : {}), kind: "run" });
      const slot = this.slots.get(record?.labels?.automation ?? "") ?? (this.deps.now ? this.deps.now().getTime() : Date.now());
      // A run the server delivers runs the server's own task; the record as it started is kept for the authority re-check of each batch it puts to the outbox (runSends).
      // A test slot comes with a server fire, or was left for this routine by a manual test run or a test upstream's end (`ended`).
      const waiting = this.nextTestSlot.get(`${brandId}:${routineId}`);
      this.nextTestSlot.delete(`${brandId}:${routineId}`);
      const testSlot = fire?.testSlot ?? (waiting && waiting.until >= this.nowMs() ? waiting.slot : undefined);
      if (testSlot) this.testSessions.set(sessionId, testSlot);
      // A test brief-send run keeps its reply tools (they only queue; a test slot never reaches the delivery), so its extension task can run end to end.
      const delivered = testSlot ? null : this.deps.serverDelivered?.({ brandId, routineId, slot }) ?? null;
      const started = this.deps.registry.get(brandId, routineId);
      const pinned = this.pins.get(`${brandId}:${routineId}`);
      if (this.deps.extensions && pinned) {
        await this.deps.extensions.recordRunPin({ brandId, runId: sessionId, routineId, ...pinned }).catch((error: unknown) => this.deps.logger.warn("routine_engine.run_pin_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }));
      }
      const base = params.options as unknown as Options;
      const options: Options = {
        ...base,
        abortController: controller,
        cwd: sandbox.cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user"],
        // A run reaches a person only through the outbox: what it puts there is read from its send folder while it works (sendsOf, runSends).
        disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...NATIVE_DELEGATION_TOOLS, ...LEGACY_REPLY_TOOLS])],
        spawnClaudeCodeProcess: sandbox.spawn,
        pathToClaudeCodeExecutable: sandbox.claudeBin,
        env: { ...(base.env ?? {}), DISABLE_AUTOUPDATER: "1", MCP_TIMEOUT: process.env.MCP_TIMEOUT || "120000" },
        ...this.withHostTools(sessionId, sandbox, base),
      };
      // Every routine fire is told to leave a run report (as the server tells it): the task is data with its angle brackets made inert, then the
      // server's own report contract is appended, so the run log, the chain and the brief hold read what they read today.
      this.running.set(sessionId, { brandId, routineId, slot, ...(testSlot ? { testSlot } : {}), ...(delivered && started ? { delivery: { revision: started.routine.revision, memberId: started.memberId } } : {}) });
      // The run speaks only through the outbox: its parts become material of its home while it works (runSends), never a queue read after it.
      sends = this.sendsOf(sandbox, { brandId, routineId, sessionId, turnId: sessionId, home: key, kind: "run", ...(testSlot ? { testSlot } : {}), ...(delivered && started ? { delivery: { revision: started.routine.revision, memberId: started.memberId } } : {}) });
      try { this.deps.onStart?.({ brandId, routineId, slot, sessionId, ...(testSlot ? { testSlot } : {}) }); } catch (error) { this.deps.logger.warn("routine_engine.start_hook_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }); }
      const added = this.deps.hostPrompt?.({ brandId, routineId, slot }) ?? "";
      // The graph's block for this run (server-built, its own text made inert where it is built), taken once.
      // A test run takes only its own slot's block; a real run only the real one.
      let upstream: string | undefined;
      if (testSlot) {
        const entry = this.testUpstreams.get(`${brandId}:${routineId}@${testSlot}`);
        this.testUpstreams.delete(`${brandId}:${routineId}@${testSlot}`);
        upstream = entry && entry.until >= this.nowMs() ? entry.state : undefined;
      } else {
        upstream = this.upstream.get(`${brandId}:${routineId}`);
        this.upstream.delete(`${brandId}:${routineId}`);
      }
      const file = routineReportFile(routineId, slot);
      const task = fire?.prompt ?? delivered?.prompt;
      // Every run reads the brand's sheet and writes it through its typed stateWrites (R48): in its report, or its own file when it has no report.
      const sheet = this.sheetNote(key, sessionId, sandbox, file, routineId);
      if (sheet) await this.sheetFolder(brandId, routineId);
      const prompt = `${task !== undefined ? task : `${inertText(params.prompt)}${added}`}${upstream ? `\n${upstream}` : ""}${file ? routineReportInstruction(`${path.posix.dirname(sandbox.cwd)}/${file}`, Boolean(sheet)) : ""}${sheet?.note ?? ""}`;
      for await (const message of this.modelQuery(options, sandbox)({ prompt, options })) {
        if (message.type === "system" && message.subtype === "init") native = message.session_id;
        // The report is read before the run's end is announced: the port stops reading at the result, and the settled event decides the outcome from it.
        if (message.type === "result") {
          const result = message as { result?: unknown; total_cost_usd?: unknown };
          this.results.set(sessionId, { text: typeof result.result === "string" ? result.result : null, costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0, home: key });
          const report = file ? await this.readReport(sandbox, file, { brandId, routineId }) : null;
          this.reports.set(sessionId, { slot, report });
          // Every run writes the sheet, whatever its outcome (R49 with R15.2: a blocked brief's "no brief today: the day's data has not landed" is what a chat
          // must know): its report's writes, or its own file's when it has no report.
          if (sheet) {
            const writes = file ? (report?.stateWrites ?? []) : sheet.file ? await this.readStateWrites(sandbox, sheet.file, { brandId, routineId }) : [];
            await this.keepState({ brandId, routineId, sessionId, key, memberId: runMember && runMember !== BRAND_RUN_MEMBER ? runMember : null, writes });
          }
          // Its last parts are handed over before the run's end is announced (the outcome and the chain read the outbox as it is now).
          await sends?.flush();
        }
        yield message;
      }
    } finally {
      this.delegations.leave(sessionId);
      sends?.stop();
      await sends?.flush();
      this.aborts.delete(sessionId);
      this.remoteHolders.delete(sessionId);
      await sandbox?.finish(native).catch((error) => this.deps.logger.warn("routine_engine.sandbox_finish_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * A fork or lane of a running session (routine-delegation.ts) on the brand's sandbox: the home, host and data grant of the run that started it, the run's
   * profile, its own runtime server and proxy session. A fork's send folder is never read, so nothing it writes reaches anyone; its final message is its
   * parent's answer. A lane's outbox parts go to the outbox like an awaited run's (`gated`: the home DM's own person, each batch re-checked). No run report,
   * no outcome, no graph node: it is not a fire of the routine whose labels it carries.
   */
  private async *runDelegatedOnSandbox(prompt: unknown, raw: Record<string | symbol, unknown>, sessionId: string): AsyncGenerator<SDKMessage> {
    const child = this.delegations.of(sessionId);
    if (!child) throw new Error(`routine engine: the fork or lane ${sessionId} is not known to this server (it may have restarted)`);
    if (typeof prompt !== "string") throw new Error("routine engine: a fork's or lane's prompt is one message");
    const { brandId, routineId, home, runMember, kind, origin } = child;
    const controller = new AbortController();
    (raw.abortController as AbortController | undefined)?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.aborts.set(sessionId, controller);
    let native: string | null = null;
    let sandbox: RoutineSandbox | null = null;
    let sends: { flush(): Promise<void>; stop(): void } | null = null;
    try {
      const hostId = await this.deps.directory.assignedHost?.(brandId, "owner_reports");
      if (!hostId) throw new Error(`no sandbox host is assigned to brand ${brandId}`);
      this.routedCheck(raw);
      await this.requireOutboxRuntime({ brandId, routineId, sessionId, hostId });
      sandbox = await withWakeReason("owner_reports", () => this.deps.openSandbox({ key: home, hostId, runId: sessionId, signal: controller.signal, ...(runMember !== undefined ? { runMember } : {}) }));
      if (kind === "lane") sends = this.sendsOf(sandbox, { brandId, routineId, sessionId, turnId: sessionId, home, kind: "gated" });
      this.delegations.enter(sessionId, { brandId, routineId, home, ...(runMember !== undefined ? { runMember } : {}), kind, origin });
      const base = raw as unknown as Options;
      const options: Options = {
        ...base,
        abortController: controller,
        cwd: sandbox.cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user"],
        disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...NATIVE_DELEGATION_TOOLS, ...LEGACY_REPLY_TOOLS])],
        spawnClaudeCodeProcess: sandbox.spawn,
        pathToClaudeCodeExecutable: sandbox.claudeBin,
        env: { ...(base.env ?? {}), DISABLE_AUTOUPDATER: "1", MCP_TIMEOUT: process.env.MCP_TIMEOUT || "120000" },
        ...this.withHostTools(sessionId, sandbox, base),
      };
      for await (const message of this.modelQuery(options, sandbox)({ prompt: inertText(prompt), options })) {
        if (message.type === "system" && message.subtype === "init") native = message.session_id;
        if (message.type === "result") await sends?.flush();
        yield message;
      }
    } finally {
      this.delegations.leave(sessionId);
      sends?.stop();
      await sends?.flush();
      this.aborts.delete(sessionId);
      this.remoteHolders.delete(sessionId);
      await sandbox?.finish(native).catch((error) => this.deps.logger.warn("routine_engine.sandbox_finish_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * A rework turn of a finished run on the brand's sandbox: the same home and data grant as the run, its own send folder (`turnId`), the session resumed by the
   * port with the outbox's message as the prompt. Its end is counted here so `ended` and `settled` hand it to `onReworked` and never to the run's own bookkeeping.
   */
  private async *runReworkOnSandbox(prompt: string, raw: Record<string | symbol, unknown>, turn: { sessionId: string; brandId: string; routineId: string; home: ConversationKey; turnId: string }): AsyncGenerator<SDKMessage> {
    const { sessionId, brandId, routineId, home, turnId } = turn;
    this.reworkEnds.set(sessionId, (this.reworkEnds.get(sessionId) ?? 0) + 1);
    this.reworkSettles.set(sessionId, [...(this.reworkSettles.get(sessionId) ?? []), { home, turnId }]);
    const hostId = await this.deps.directory.assignedHost?.(brandId, "owner_reports");
    if (!hostId) throw new Error(`no sandbox host is assigned to brand ${brandId}`);
    this.routedCheck(raw);
    await this.requireOutboxRuntime({ brandId, routineId, sessionId, hostId, turnId });
    const controller = new AbortController();
    (raw.abortController as AbortController | undefined)?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.aborts.set(sessionId, controller);
    const routineRecord = this.deps.registry.get(brandId, routineId);
    const runMember = routineRecord?.memberId ?? (isBrandRunConversation(brandId, home.conversationId) ? BRAND_RUN_MEMBER : undefined);
    let native: string | null = null;
    let sandbox: RoutineSandbox | null = null;
    let sends: { flush(): Promise<void>; stop(): void } | null = null;
    try {
      sandbox = await withWakeReason("owner_reports", () => this.deps.openSandbox({ key: home, hostId, runId: turnId, signal: controller.signal, ...(runMember !== undefined ? { runMember } : {}) }));
      sends = this.sendsOf(sandbox, { brandId, routineId, sessionId, turnId, home, kind: "rework" });
      const base = raw as unknown as Options;
      const options: Options = {
        ...base,
        abortController: controller,
        cwd: sandbox.cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user"],
        disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...NATIVE_DELEGATION_TOOLS, ...LEGACY_REPLY_TOOLS])],
        spawnClaudeCodeProcess: sandbox.spawn,
        pathToClaudeCodeExecutable: sandbox.claudeBin,
        env: { ...(base.env ?? {}), DISABLE_AUTOUPDATER: "1", MCP_TIMEOUT: process.env.MCP_TIMEOUT || "120000" },
        ...this.withHostTools(sessionId, sandbox, base),
      };
      for await (const message of this.modelQuery(options, sandbox)({ prompt, options })) {
        if (message.type === "system" && message.subtype === "init") native = message.session_id;
        if (message.type === "result") await sends.flush();
        yield message;
      }
    } finally {
      sends?.stop();
      await sends?.flush();
      this.aborts.delete(sessionId);
      this.remoteHolders.delete(sessionId);
      await sandbox?.finish(native).catch((error) => this.deps.logger.warn("routine_engine.sandbox_finish_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * A gated run on the brand's sandbox: its home is the conversation the gate named (a member's DM for free time), it sends nothing (the reply
   * tools are not listed), writes no run report, and resolves the gate's waiting call with the final answer (structured when the gate asked for a schema).
   */
  private async *runGatedOnSandbox(prompt: string, raw: Record<string | symbol, unknown>, run: { sessionId: string; brandId: string; routineId: string; waiter: NonNullable<PendingFire["waiter"]> }): AsyncGenerator<SDKMessage> {
    const waiting = run.waiter;
    this.awaitedSessions.add(run.sessionId);
    const { request } = waiting;
    let settled = false;
    const finish = (result: GatedRunResult): void => { if (!settled) { settled = true; waiting.resolve(result); } };
    const controller = new AbortController();
    const callerAbort = raw.abortController as AbortController | undefined;
    callerAbort?.signal.addEventListener("abort", () => controller.abort(), { once: true });
    request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.aborts.set(run.sessionId, controller);
    let native: string | null = null;
    let sandbox: RoutineSandbox | null = null;
    let sends: { flush(): Promise<void>; stop(): void } | null = null;
    try {
      const hostId = await this.deps.directory.assignedHost?.(run.brandId, "owner_reports");
      if (!hostId) throw new Error(`no sandbox host is assigned to brand ${run.brandId}`);
      this.routedCheck(raw);
      await this.requireOutboxRuntime({ brandId: run.brandId, routineId: run.routineId, sessionId: run.sessionId, hostId });
      sandbox = await withWakeReason("owner_reports", () => this.deps.openSandbox({ key: request.key, hostId, runId: run.sessionId, signal: controller.signal }));
      this.delegations.enter(run.sessionId, { brandId: run.brandId, routineId: run.routineId, home: request.key, kind: "gated" });
      // An awaited run answers its gate, and anything it puts to the outbox is material of the gate's conversation like any run's.
      sends = this.sendsOf(sandbox, { brandId: run.brandId, routineId: run.routineId, sessionId: run.sessionId, turnId: run.sessionId, home: request.key, kind: "gated" });
      const pinned = this.pins.get(`${run.brandId}:${run.routineId}`);
      if (this.deps.extensions && pinned) {
        await this.deps.extensions.recordRunPin({ brandId: run.brandId, runId: run.sessionId, routineId: run.routineId, ...pinned }).catch((error: unknown) => this.deps.logger.warn("routine_engine.run_pin_failed", { brandId: run.brandId, routineId: run.routineId, message: error instanceof Error ? error.message : String(error) }));
      }
      const base = raw as unknown as Options;
      const options: Options = {
        ...base,
        abortController: controller,
        cwd: sandbox.cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["user"],
        disallowedTools: [...new Set([...(base.disallowedTools ?? []), ...NATIVE_DELEGATION_TOOLS, ...LEGACY_REPLY_TOOLS])],
        spawnClaudeCodeProcess: sandbox.spawn,
        pathToClaudeCodeExecutable: sandbox.claudeBin,
        env: { ...(base.env ?? {}), DISABLE_AUTOUPDATER: "1", MCP_TIMEOUT: process.env.MCP_TIMEOUT || "120000" },
        ...(request.outputSchema ? { outputFormat: { type: "json_schema", schema: request.outputSchema } } : {}),
        ...this.withHostTools(run.sessionId, sandbox, base),
      };
      // An awaited run reads and writes the sheet too (R48), through its own file: it has no report. Appended after the task, so the host's cut of a long task never drops it.
      const sheet = this.sheetNote(request.key, run.sessionId, sandbox, null, run.routineId);
      if (sheet) await this.sheetFolder(run.brandId, run.routineId);
      for await (const message of this.modelQuery(options, sandbox)({ prompt: `${inertText(prompt)}${sheet?.note ?? ""}`, options })) {
        if (message.type === "system" && message.subtype === "init") native = message.session_id;
        if (message.type === "result") {
          await sends.flush();
          const ok = message.subtype === "success" && !message.is_error;
          if (sheet?.file) await this.keepState({ brandId: run.brandId, routineId: run.routineId, sessionId: run.sessionId, key: request.key, memberId: null, writes: await this.readStateWrites(sandbox, sheet.file, run) });
          finish({ sessionId: run.sessionId, ok, result: "result" in message && typeof message.result === "string" ? message.result : null, structured: (message as { structured_output?: unknown }).structured_output, subtype: message.subtype });
        }
        yield message;
      }
    } catch (error) {
      if (!settled) { settled = true; waiting.reject(error); }
      throw error;
    } finally {
      this.delegations.leave(run.sessionId);
      sends?.stop();
      await sends?.flush();
      this.aborts.delete(run.sessionId);
      this.remoteHolders.delete(run.sessionId);
      finish({ sessionId: run.sessionId, ok: false, result: null, structured: undefined, subtype: "no_result" });
      await sandbox?.finish(native).catch((error) => this.deps.logger.warn("routine_engine.sandbox_finish_failed", { brandId: run.brandId, routineId: run.routineId, message: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** The sheet's block and the note on writing it for one run, or null when the brand reads no sheet; `file` is the run's own state file when it has no report. */
  private sheetNote(key: ConversationKey, sessionId: string, sandbox: RoutineSandbox, report: string | null, routineId: string): { note: string; file: string | null } | null {
    let sheet: { block: string; folder: string | null } | null = null;
    try { sheet = this.deps.livingSheet?.(key) ?? null; } catch (error) { this.deps.logger.warn("routine_engine.sheet_unreadable", { brandId: key.brandId, message: error instanceof Error ? error.message : String(error) }); }
    if (!sheet || !this.deps.applyState) return null;
    const file = report ? null : stateWritesFile(sessionId);
    if (!report && !file) return null;
    const routine = { id: routineId, curator: routineId === SHEET_CURATOR, folder: sheet.folder };
    return { note: `\n${sheet.block}${stateWritesInstruction(report ? { report: true } : { file: `${path.posix.dirname(sandbox.cwd)}/${file}` }, routine)}`, file };
  }

  private async sheetFolder(brandId: string, routineId: string): Promise<void> {
    await this.deps.prepareSheetFolder?.(brandId).catch((error: unknown) => this.deps.logger.warn("routine_engine.sheet_folder_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) }));
  }

  /** An awaited run's sheet writes, read from its home with the report's bound; none when it left no file or it is unreadable. */
  private async readStateWrites(sandbox: RoutineSandbox, file: string, who: { brandId: string; routineId: string }): Promise<RoutineStateWrite[]> {
    try {
      const data = await sandbox.readHomeFile(file, ROUTINE_REPORT_MAX_BYTES);
      return data ? parseStateWrites(data) : [];
    } catch (error) {
      this.deps.logger.warn("routine_engine.state_read_failed", { ...who, message: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private async keepState(input: { brandId: string; routineId: string; sessionId: string; key: ConversationKey; memberId: string | null; writes: RoutineStateWrite[] }): Promise<void> {
    if (!input.writes.length || !this.deps.applyState) return;
    await this.deps.applyState(input).catch((error: unknown) => this.deps.logger.warn("routine_engine.state_not_kept", { brandId: input.brandId, routineId: input.routineId, sessionId: input.sessionId, message: error instanceof Error ? error.message : String(error) }));
  }

  /** The report the run wrote, read from its home with the server's bound; null when it left none or it is unreadable. */
  private async readReport(sandbox: RoutineSandbox, file: string, who: { brandId: string; routineId: string }): Promise<RoutineReport | null> {
    try {
      const data = await sandbox.readHomeFile(file, ROUTINE_REPORT_MAX_BYTES);
      return data ? parseRoutineReport(data) : null;
    } catch (error) {
      this.deps.logger.warn("routine_engine.report_read_failed", { ...who, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Runs a restart cut before their session settled: no settled event ever comes for them (the host's dispose leaves the session idle, a kill leaves it
   * `running` on disk), so the run log stayed `running` and the graph never retried (1f54494f's daily brief, cut mid-render at 23:17Z on 2026-11-17, was lost
   * for the day). Each is told to the server once as a failed run. Only a run this process started is live; one the store no longer knows is returned in
   * `unknown` for the caller to close.
   */
  async settleInterrupted(sessionIds: readonly string[]): Promise<{ settled: string[]; unknown: string[] }> {
    const settled: string[] = [];
    const unknown: string[] = [];
    for (const sessionId of sessionIds) {
      if (this.running.has(sessionId) || this.aborts.has(sessionId)) continue;
      const record = this.store.get(sessionId);
      if (!record) { unknown.push(sessionId); continue; }
      await this.settled(sessionId, { state: "failed" });
      settled.push(sessionId);
    }
    return { settled, unknown };
  }

  /** A run's session went idle or failed: tell the server (the graph's completion for the routine, with the day it covered). */
  private async settled(sessionId: string, outcome: SettledOutcome): Promise<void> {
    try {
      await this.settledTurn(sessionId, outcome);
    } finally {
      // A rework the outbox asked for while this turn worked starts now, as the session's next turn.
      const waiting = this.reworkWaiting.get(sessionId);
      this.reworkWaiting.delete(sessionId);
      const routineId = this.store.get(sessionId)?.labels?.[SESSION_ROUTINE];
      if (waiting && this.host && routineId) this.startRework(this.host, waiting, routineId);
    }
  }

  private async settledTurn(sessionId: string, outcome: SettledOutcome): Promise<void> {
    // A fork or lane is no run of the routine whose labels it carries: its waiter (a fork's parent) gets the outcome, and the server is told nothing.
    const told: SessionOutcome = outcome.state === "failed" ? { state: "failed", error: outcome.error ?? "the session failed" } : { state: "idle", ...(outcome.reply !== undefined ? { reply: outcome.reply } : {}) };
    if (this.delegations.settled(sessionId, told)) return;
    const record = this.store.get(sessionId);
    if (record?.labels?.[DELEGATION_LABEL]) return;
    const brandId = record?.labels?.[SESSION_BRAND];
    const routineId = record?.labels?.[SESSION_ROUTINE];
    if (!record || !brandId || !routineId) return;
    const rework = this.reworkSettles.get(sessionId)?.shift();
    if (rework) {
      if (this.reworkSettles.get(sessionId)?.length === 0) this.reworkSettles.delete(sessionId);
      try {
        await this.deps.onReworked?.({ brandId, routineId, sessionId, turnId: rework.turnId, home: rework.home, ended: outcome.state });
      } catch (error) {
        this.deps.logger.warn("routine_engine.rework_outcome_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // An awaited run has no graph node, run log row or report: its gate already has the answer.
    if (this.awaitedSessions.delete(sessionId)) return;
    const automation = this.automations.list(brandId).find((candidate) => candidate.runs.some((run) => run.sessionId === sessionId));
    const run = automation?.runs.find((candidate) => candidate.sessionId === sessionId);
    const left = this.reports.get(sessionId);
    const started = this.running.get(sessionId);
    const delivery = started?.delivery;
    const said = this.results.get(sessionId);
    this.reports.delete(sessionId);
    this.running.delete(sessionId);
    this.results.delete(sessionId);
    const report = left?.report ?? null;
    // The agent's run report decides the outcome, as on the server: a run that ended without one, or one that says failed or blocked, is a failed run.
    const success = outcome.state === "idle" && report?.outcome === "done";
    const reason = success ? null : outcome.state === "failed" ? (report ? report.outcome : `the run failed; ${NO_REPORT}`) : report ? report.outcome : NO_REPORT;
    const covers = report?.dataThrough ?? (automation && this.covered.get(automation.id)) ?? "";
    try {
      const outboxed = this.outboxedParts.get(sessionId) ?? 0;
      this.outboxedParts.delete(sessionId);
      await this.deps.onOutcome({ brandId, routineId, kind: success ? "success" : "failed", covers, sessionId, slot: left?.slot ?? started?.slot ?? (run ? Date.parse(run.at) : Date.now()), reason, report, ended: outcome.state, finalText: said?.text ?? null, costUsd: said?.costUsd ?? 0, home: said?.home ?? { brandId, channel: "inspector", conversationId: `brand-run-${brandId}` }, outboxed, ...(delivery ? { delivery } : {}), ...(started?.testSlot ? { testSlot: started.testSlot } : {}) });
    } catch (error) {
      this.deps.logger.warn("routine_engine.outcome_failed", { brandId, routineId, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** The session the routine host's providerFor routes: its recorded (profile) model, swapped as its turns are (ROUTINE_MODEL in place of an Opus model). */
function routineModelSession(model: string | undefined, override: string | null): { model?: string } {
  const swapped = routineModelFor(model, override);
  return typeof swapped === "string" ? { model: swapped } : {};
}

/**
 * The model a routine session runs on: ROUTINE_MODEL in place of an Opus model (an alias `opus` or any `claude-opus-*` id), the profile's model
 * otherwise. Model ids are a fixed format (config.ts parseModelId), so this reads the id, not text.
 */
export function routineModelFor(model: unknown, override: string | null): unknown {
  if (!override || typeof model !== "string") return model;
  return model === "opus" || /^claude-opus-[a-z0-9.-]+$/.test(model) ? override : model;
}
