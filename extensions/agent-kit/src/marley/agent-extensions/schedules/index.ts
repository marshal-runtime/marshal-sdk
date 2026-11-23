import type { SecretProvider } from "../../gcp.js";
import type { Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import type { ConversationKey, Store } from "../../store.js";
import { BRAND_GRAPH_HANDLER, brandGraphHandler, retryDueBrandGraphs, type BrandGraphIngest } from "./brand-graph.js";
import { BrandGraphStates } from "./brand-graph-state.js";
import { EventBus } from "./events.js";
import { EventSubscriptionTriggers } from "./event-triggers.js";
import { replyGate, type ReplyGate } from "./gate.js";
import { EventsIngress, type IngressDeps } from "./ingress.js";
import { ScheduleRepo } from "./repo.js";
import { Scheduler, type FollowUpHandoff, type SchedulerDeps } from "./scheduler.js";
import { BrandEventPayload, isBrandEventName, type BrandEventCatalog } from "../brand-events-contract.js";
import { BrandEventDirectory, eventsListValue, scheduleToolSpecs, type ScheduleToolSpec } from "./tools.js";
import { DEFAULT_SCHEDULE_CONFIG, type BrandEventName, type ScheduleConfig, type ScheduleRecord, type ToolContext } from "./types.js";

export { migrateSchedules } from "./schema.js";
export { loadScheduleConfig, type ScheduleConfig, type ToolContext } from "./types.js";
export type { EventHandler, EventHandlerContext } from "./events.js";
export type { BrandGraphIngest } from "./brand-graph.js";
export type { ReplyGate } from "./gate.js";
export type { ScheduleToolSpec } from "./tools.js";
export { SCHEDULE_PROMPT } from "./prompt.js";

export interface SchedulesDeps {
  store: Store;
  secrets: SecretProvider;
  logger: Logger;
  /** Starts a turn for a conversation that holds a new pending message (Router.wake). */
  wake(key: ConversationKey): void;
  config?: Partial<ScheduleConfig>;
  now?: () => number;
  personaRoutes?: IngressDeps["personaRoutes"];
  brandKnown?: IngressDeps["brandKnown"];
  schedulePrompt?: (schedule: ScheduleRecord, scheduledFor: number) => string;
  suppressScheduleFired?: (brandId: string, scheduleId: string) => boolean;
  /** Per-brand hold (brand-holds.ts): no schedule fires, no event runs and no graph retry for a held brand. */
  brandHeld?: (brandId: string) => boolean;
  heldBrands?: () => string[];
  holdOverlapMs?: (brandId: string, from: number, to: number) => number;
  /** Rereads the nudge behind an `origin = 'operator'` schedule just before it fires (nudges/): false skips the fire. Unset, operator schedules never fire. */
  operatorNudgeApplied?: (schedule: ScheduleRecord) => Promise<boolean | "pending">;
}

const BRAND_GRAPH_RETRY_TICK_MS = 30_000;

export interface ScheduleClock {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
}

/** Schedules, event subscriptions, the scheduler loop and the event ingest endpoint of the agent server. */
export class Schedules {
  readonly config: ScheduleConfig;
  readonly repo: ScheduleRepo;
  readonly events: EventBus;
  /** The subscriptions as the Marshal SDK's event triggers (event-triggers.ts). */
  readonly eventTriggers: EventSubscriptionTriggers;
  readonly scheduler: Scheduler;
  private gateFn: SchedulerDeps["gate"] | null = null;
  /** The routine graph's gate over due slots (set once at startup, after the engine exists). */
  setGate(gate: SchedulerDeps["gate"]): void { this.gateFn = gate ?? null; }
  private followUpFn: FollowUpHandoff | null = null;
  /** The proactive engine's follow-up handoff for a closed-window fire (set once at startup, after the engine exists). */
  setFollowUp(handoff: FollowUpHandoff | null): void { this.followUpFn = handoff; }
  private clock: ScheduleClock | null = null;
  /** The clock that fires due schedules (the Marshal SDK's automations, owner-schedules.ts): started, paused and resumed with the schedules. Without one nothing fires by time. */
  setClock(clock: ScheduleClock | null): void { this.clock = clock; }
  private reminderFn: SchedulerDeps["reminder"] | null = null;
  /** Which schedules are one-off reminders set in a conversation (set once at startup, after the server-owned wakeup owners exist). Unset, none is. */
  setReminder(reminder: SchedulerDeps["reminder"] | null): void { this.reminderFn = reminder ?? null; }
  readonly gate: ReplyGate;
  readonly ingress: EventsIngress | null;
  /** Where each brand's graph stands (published, no data yet, failing and retrying). */
  readonly graphStates: BrandGraphStates;
  private readonly now: () => number;
  private pauseEpoch = 0;
  private graphRetry: NodeJS.Timeout | null = null;
  private graphRetryRunning = false;
  private readonly graphRunning = new Set<string>();
  private graphIngest: BrandGraphIngest | null = null;
  private graphSandboxRunning: ((brandId: string) => Promise<boolean>) | undefined;

  constructor(private readonly deps: SchedulesDeps) {
    this.config = { ...DEFAULT_SCHEDULE_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.repo = new ScheduleRepo(deps.store.database);
    this.graphStates = new BrandGraphStates(deps.store.database, deps.logger, this.now);
    const { store, logger, wake } = deps;
    this.events = new EventBus({ repo: this.repo, config: this.config, logger, now: this.now, suppressScheduleFired: deps.suppressScheduleFired, brandHeld: deps.brandHeld });
    this.eventTriggers = new EventSubscriptionTriggers({ repo: this.repo, store, config: this.config, logger, wake, now: this.now });
    this.events.setDelivery(this.eventTriggers);
    this.brandEvents = new BrandEventDirectory(logger);
    this.scheduler = new Scheduler({
      repo: this.repo,
      store,
      config: this.config,
      logger,
      wake,
      onFired: (schedule, scheduledFor, firedAt) => this.events.scheduleFired(schedule, scheduledFor, firedAt),
      now: this.now,
      prompt: deps.schedulePrompt,
      brandHeld: deps.brandHeld,
      heldBrands: deps.heldBrands,
      holdOverlapMs: deps.holdOverlapMs,
      operatorNudgeApplied: deps.operatorNudgeApplied,
      gate: (job, slot, now) => this.gateFn?.(job, slot, now) ?? { fire: true },
      followUp: () => this.followUpFn,
      reminder: (job) => this.reminderFn?.(job) ?? false,
    });
    this.gate = replyGate(this.repo, this.config);
    this.ingress =
      this.config.eventsPort === null
        ? null
        : new EventsIngress({ bus: this.events, secrets: deps.secrets, tokenSecret: this.config.eventsTokenSecret, host: this.config.eventsHost, port: this.config.eventsPort, logger, now: this.now, personaRoutes: deps.personaRoutes, brandKnown: deps.brandKnown });
  }

  /** The brand's own events (`brand.<slug>`, defined by its active extensions): what a subscription may name besides the server's events. */
  readonly brandEvents: BrandEventDirectory;

  /** Where the brand's defined events are read (set once at startup, after the extension registry exists). Unset, every brand event is unknown. */
  setBrandEvents(catalog: BrandEventCatalog | null): void {
    this.brandEvents.setCatalog(catalog);
  }

  /**
   * A brand event happened: its detector (brand code, run on the brand's sandbox) returned this payload. Checked here again (a well-formed name the brand
   * defines on a fresh read, a payload within BrandEventPayload), then recorded and handed to the matching subscriptions on the one event bus, like any
   * received event: the event id dedupes a repeat, the hourly cap and the once-per-event fire record hold, a held brand's event waits for its release.
   * Throws when the name, the definition or the payload is refused (nothing is recorded then).
   */
  async deliverBrandEvent(brandId: string, event: string, eventId: string, payload: Record<string, unknown>): Promise<{ matched: number; fired: number }> {
    if (!isBrandEventName(event)) throw new Error(`"${event}" is not a brand event name (brand.<slug>)`);
    const defs = await this.brandEvents.refresh(brandId);
    if (!defs.some((def) => def.id === event)) throw new Error(`the brand does not define ${event}`);
    const checked = BrandEventPayload.safeParse(payload);
    if (!checked.success) throw new Error(`${event} payload refused: ${checked.error.issues[0]?.message ?? "invalid"}`);
    const result = await this.events.publish(brandId, event as BrandEventName, eventId, checked.data);
    return { matched: result.matched, fired: result.fired };
  }

  /** The tools one model session may call, bound to its brand and conversation. */
  toolSpecs(context: ToolContext): ScheduleToolSpec[] {
    return scheduleToolSpecs({ repo: this.repo, config: this.config, now: this.now, brandEvents: this.brandEvents }, context);
  }

  /**
   * The turn's list reads. The brand's events come from the last read of its catalog; a fresh read starts here, so the intents this turn queues are
   * checked (ControlIntents, after the turn) against a read made when the turn began.
   */
  snapshot(context: ToolContext): Record<string, unknown> {
    const own = (target: { channel: string; conversationId: string }) => target.channel === context.key.channel && target.conversationId === context.key.conversationId;
    void this.brandEvents.refresh(context.brandId).catch(() => undefined);
    return {
      "zs.schedule.list": this.repo.listSchedules(context.brandId).filter(job => own(job.target) && job.origin !== "operator").map(job => ({ id: job.id, kind: job.kind, cron: job.cron, at: job.atMs === null ? null : new Date(job.atMs).toISOString(), timezone: job.timezone, prompt: job.prompt, nextRunAt: job.nextRunAt === null ? null : new Date(job.nextRunAt).toISOString(), lastRunAt: job.lastRunAt === null ? null : new Date(job.lastRunAt).toISOString(), fireCount: job.fireCount })),
      "zs.events.list": eventsListValue(this.repo, context, this.brandEvents.known(context.brandId)),
    };
  }

  /** An event handler (graph ingest included) or a graph retry of this brand is running. */
  busyFor(brandId: string): boolean {
    return this.events.busyFor(brandId) || this.graphRunning.has(brandId);
  }

  /** Starts a brand graph ingest when airflow data lands (data.sync.completed with source "airflow"), before subscribed turns run. */
  registerBrandGraph(ingest: BrandGraphIngest, sources?: readonly string[], options: { sandboxRunning?: (brandId: string) => Promise<boolean> } = {}): void {
    this.graphIngest = ingest;
    this.graphSandboxRunning = options.sandboxRunning;
    this.events.registerHandler("data.sync.completed", BRAND_GRAPH_HANDLER, brandGraphHandler({ ingest, logger: this.deps.logger, sources, states: this.graphStates, running: this.graphRunning }));
  }

  /** Whether this server writes brand graph state (its graph handler is registered); staging reads production's shared graph and keeps none. */
  keepsGraphState(): boolean {
    return this.graphIngest !== null;
  }

  /** Runs the graph attempts that are due (failed ingests, first syncs still pending). Returns how many ran. */
  async retryBrandGraphs(): Promise<number> {
    if (!this.graphIngest || this.graphRetryRunning) return 0;
    this.graphRetryRunning = true;
    try {
      return await retryDueBrandGraphs({ ingest: this.graphIngest, logger: this.deps.logger, states: this.graphStates, running: this.graphRunning, timeoutMs: this.config.handlerTimeoutMs, brandHeld: this.deps.brandHeld, sandboxRunning: this.graphSandboxRunning });
    } catch (error) {
      this.deps.logger.error("brand_graph.retry_failed", { ...failureFields(error) });
      return 0;
    } finally {
      this.graphRetryRunning = false;
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.deps.logger.warn("schedules.disabled");
      return;
    }
    this.repo.pruneEvents(this.now() - 30 * 86_400_000);
    if (this.ingress) {
      try {
        const port = await this.ingress.listen();
        this.deps.logger.info("events_ingress.listening", { host: this.config.eventsHost, port });
      } catch (error) {
        this.deps.logger.error("events_ingress.listen_failed", { ...failureFields(error) });
      }
    }
    await this.eventTriggers.start();
    this.events.recover(this.now() - 3_600_000);
    await this.clock?.start();
    this.startGraphRetry();
  }

  private startGraphRetry(): void {
    if (this.graphRetry) return;
    this.graphRetry = setInterval(() => void this.retryBrandGraphs(), BRAND_GRAPH_RETRY_TICK_MS);
    this.graphRetry.unref();
  }

  async stop(): Promise<void> {
    this.pause();
    await this.ingress?.close();
  }

  pause(): void {
    if (this.graphRetry) { clearInterval(this.graphRetry); this.graphRetry = null; }
    this.pauseEpoch += 1;
    this.events.pause();
    this.clock?.pause();
    this.ingress?.pause(true);
  }

  resume(): void {
    if (!this.config.enabled) return;
    this.ingress?.pause(false);
    const epoch = ++this.pauseEpoch;
    void this.events.whenIdle().then(() => { if (epoch === this.pauseEpoch) this.events.resume(); });
    this.clock?.resume();
    this.startGraphRetry();
  }
}
