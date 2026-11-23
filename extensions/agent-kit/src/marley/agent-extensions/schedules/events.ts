import { createHash } from "node:crypto";

import { z } from "zod";

import { errorMessage, type Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import type { ScheduleRepo } from "./repo.js";
import { isBrandEventName } from "../brand-events-contract.js";
import { EVENT_NAMES, FILTER_FIELDS, type BrandEventName, type EventFilter, type EventName, type ScheduleConfig, type ScheduleRecord, type ServerEventName } from "./types.js";
import { describeInstant } from "./zone.js";

const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Iso = z.string().datetime({ offset: true });

/** The body of POST /zs/events/v1. */
export const EventBody = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("data.sync.completed"),
    brandId: z.string().regex(BRAND_ID),
    source: z.string().min(1).max(64),
    tables: z.array(z.string().min(1).max(128)).max(200).optional(),
    finishedAt: Iso,
    id: z.string().min(1).max(128).optional(),
    dataSource: z.enum(["shopify", "meta_ads"]).optional(),
    generation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    readinessTable: z.string().optional(),
    /** The newest Shopify order update in the normalized orders table, shop time, ISO 8601 without zone; with the newest order's date and the shop's IANA zone. Airflow reads them after dbt and the mirror (day-complete). */
    ordersSeenThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).optional(),
    newestOrderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    shopTimezone: z.string().min(1).max(64).optional(),
  }).superRefine((value, context) => {
    if ([value.dataSource, value.generation, value.readinessTable].some((field) => field !== undefined) &&
        (!value.dataSource || !value.generation || value.source !== "airflow" ||
         value.readinessTable !== `zyg-ecom-zygstinct.brand_${value.brandId.replaceAll("-", "").toLowerCase()}.source_readiness`)) {
      context.addIssue({ code: "custom", message: "Incomplete or cross-brand source readiness event" });
    }
  }),
  /** One source's marts were built in BigQuery (Airflow's dbt build, before and independent of the Postgres mirror). The id is brand|source|generation. */
  z.object({
    event: z.literal("data.source.ready"),
    brandId: z.string().regex(BRAND_ID),
    dataSource: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    tables: z.array(z.string().min(1).max(128)).max(200).optional(),
    firstDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    lastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    generation: z.string().min(1).max(128).optional(),
    finishedAt: Iso,
    id: z.string().min(1).max(128).optional(),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;

/** Where an event's subscriptions are delivered: the SDK's event triggers (event-triggers.ts). */
export interface SubscriptionDelivery {
  /** How many subscriptions an event reaches. */
  matching(brandId: string, event: EventName, payload: Record<string, unknown>): unknown[];
  /** Emits the event to the SDK's event triggers and settles when every matching subscription was delivered. */
  deliver(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): Promise<{ matched: number; fired: number }>;
}

export interface EventBusDeps {
  repo: ScheduleRepo;
  config: ScheduleConfig;
  logger: Logger;
  now?: () => number;
  /** A server-owned fixed reply must not spawn model turns through subscriptions, even on recovery. */
  suppressScheduleFired?: (brandId: string, scheduleId: string) => boolean;
  /** A held brand's events stay recorded and unprocessed; `recoverBrand` runs them after release. */
  brandHeld?: (brandId: string) => boolean;
}

/** What an internal handler gets. The payload is the validated event body (for data.sync.completed: brandId, source, tables, finishedAt). */
export interface EventHandlerContext {
  brandId: string;
  event: EventName;
  eventId: string;
  payload: Record<string, unknown>;
  /** Aborted when the handler runs past its time limit; the bus stops waiting for it either way. */
  signal: AbortSignal;
  logger: Logger;
}

export type EventHandler = (context: EventHandlerContext) => Promise<void> | void;

export interface HandlerRun {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ProcessResult {
  handlers: HandlerRun[];
  matched: number;
  fired: number;
}

export interface ReceiveResult {
  eventId: string;
  /** False when this event id already arrived (a retry): nothing runs again. */
  accepted: boolean;
  /** Subscriptions that match, counted when the event arrived. */
  matched: number;
  /** Settles when the handlers ran and the subscribed turns were queued. Never rejects. */
  done: Promise<ProcessResult>;
}

const NOTHING: ProcessResult = { handlers: [], matched: 0, fired: 0 };

/**
 * Receives events. For each new event of a brand it first runs the registered internal handlers in registration order
 * (for example the brand graph rebuild after data.sync.completed), one after the other. A handler that throws or runs past
 * the time limit is logged and does not stop the next handler or the subscriptions. Then it starts a turn for every
 * matching subscription. Events of one brand are processed one at a time, in the order they arrived.
 */
export class EventBus {
  private readonly handlers: { event: EventName; name: string; run: EventHandler }[] = [];
  private readonly chains = new Map<string, Promise<unknown>>();
  private inFlight = 0;
  private idleWaiters: (() => void)[] = [];
  private paused = false;
  private delivery: SubscriptionDelivery | null = null;

  /** Where subscriptions are delivered (set once at startup). Without it an event runs its handlers and reaches no subscription. */
  setDelivery(delivery: SubscriptionDelivery | null): void {
    this.delivery = delivery;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.recover(0);
  }

  constructor(private readonly deps: EventBusDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Adds an internal handler for an event. Handlers run in the order they were registered, before any subscription fires. */
  registerHandler(event: EventName, name: string, run: EventHandler): void {
    if (this.handlers.some((h) => h.event === event && h.name === name)) throw new Error(`handler "${name}" is already registered for ${event}`);
    this.handlers.push({ event, name, run });
  }

  /** An event of this brand is being processed. */
  busyFor(brandId: string): boolean {
    return this.chains.has(brandId);
  }

  /** Resolves when no event is being processed. */
  whenIdle(): Promise<void> {
    return this.inFlight === 0 ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Accepts an event from the ingest endpoint and processes it in the background; the answer does not wait for handlers. */
  receiveBody(body: EventBody): ReceiveResult {
    const { event, brandId, id, ...rest } = body;
    const payload: Record<string, unknown> = { brandId, ...rest };
    const eventId = id ?? createHash("sha256").update(JSON.stringify([event, brandId, payload])).digest("hex").slice(0, 32);
    return this.receive(brandId, event, eventId, payload);
  }

  /** Like receiveBody, but waits until the event is fully processed (tests, internal callers). */
  async publishBody(body: EventBody): Promise<ReceiveResult & ProcessResult> {
    const received = this.receiveBody(body);
    return { ...received, ...(await received.done) };
  }

  async publish(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): Promise<ReceiveResult & ProcessResult> {
    const received = this.receive(brandId, event, eventId, payload);
    return { ...received, ...(await received.done) };
  }

  /** Records the event (a repeat of the same event id is ignored) and queues its processing behind earlier events of the brand. */
  receive(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): ReceiveResult {
    const { repo, logger } = this.deps;
    if (this.suppressed(brandId, event, payload)) return { eventId, accepted: false, matched: 0, done: Promise.resolve(NOTHING) };
    if (!repo.recordEvent(brandId, eventId, event, payload, this.now())) return { eventId, accepted: false, matched: 0, done: Promise.resolve(NOTHING) };
    const matched = this.delivery?.matching(brandId, event, payload).length ?? 0;
    logger.info("event.received", { brandId, event, eventId, matched });
    return { eventId, accepted: true, matched, done: this.enqueue(brandId, event, eventId, payload) };
  }

  private suppressed(brandId: string, event: EventName, payload: Record<string, unknown>): boolean {
    return event === "schedule.fired" && typeof payload.scheduleId === "string"
      && this.deps.suppressScheduleFired?.(brandId, payload.scheduleId) === true;
  }

  /** Processes events that were recorded but not finished when the server last stopped (handlers run again; subscription fires dedupe). */
  recover(sinceMs: number): Promise<ProcessResult>[] {
    return this.deps.repo.unprocessedEvents(sinceMs).map((row) => this.enqueue(row.brandId, row.event, row.eventId, row.payload));
  }

  /** Replays a brand's recorded but unprocessed events (after a hold): handlers run again, subscription fires dedupe. */
  recoverBrand(brandId: string): Promise<ProcessResult>[] {
    return this.deps.repo.unprocessedEvents(0).filter((row) => row.brandId === brandId).map((row) => this.enqueue(row.brandId, row.event, row.eventId, row.payload));
  }

  private enqueue(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): Promise<ProcessResult> {
    this.inFlight += 1;
    const previous = this.chains.get(brandId) ?? Promise.resolve();
    const run = previous.then(() => this.process(brandId, event, eventId, payload)).catch((error): ProcessResult => {
      this.deps.logger.error("event.process_failed", { brandId, event, eventId, ...failureFields(error) });
      return NOTHING;
    });
    this.chains.set(brandId, run);
    void run.then(() => {
      if (this.chains.get(brandId) === run) this.chains.delete(brandId);
      this.inFlight -= 1;
      if (this.inFlight === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
    });
    return run;
  }

  private async process(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): Promise<ProcessResult> {
    if (this.paused || this.deps.brandHeld?.(brandId)) return NOTHING;
    const { repo, logger, config } = this.deps;
    if (this.suppressed(brandId, event, payload)) {
      repo.markEventProcessed(brandId, eventId, 0, this.now());
      return NOTHING;
    }
    const handlers: HandlerRun[] = [];
    for (const handler of this.handlers.filter((h) => h.event === event)) {
      const started = Date.now();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => handler.run({ brandId, event, eventId, payload, signal: controller.signal, logger })),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`timed out after ${Math.round(config.handlerTimeoutMs / 1000)}s`));
            }, config.handlerTimeoutMs);
            timer.unref();
          }),
        ]);
        handlers.push({ name: handler.name, ok: true, ms: Date.now() - started });
        logger.info("event.handler_done", { brandId, event, eventId, handler: handler.name, ms: Date.now() - started });
      } catch (error) {
        handlers.push({ name: handler.name, ok: false, ms: Date.now() - started, error: errorMessage(error) });
        logger.error("event.handler_failed", { brandId, event, eventId, handler: handler.name, ...failureFields(error) });
      } finally {
        clearTimeout(timer);
      }
    }
    if (this.paused) return { handlers, matched: 0, fired: 0 };
    const fired = (await this.delivery?.deliver(brandId, event, eventId, payload)) ?? { matched: 0, fired: 0 };
    repo.markEventProcessed(brandId, eventId, fired.matched, this.now());
    logger.info("event.processed", { brandId, event, eventId, handlers: handlers.length, matched: fired.matched, fired: fired.fired });
    return { handlers, ...fired };
  }

  /** Internal event: a schedule started a turn. Processed in the background. */
  scheduleFired(schedule: ScheduleRecord, scheduledFor: number, firedAt: number): void {
    try {
      this.receive(schedule.brandId, "schedule.fired", `schedule-${schedule.id}-${scheduledFor}`, {
        brandId: schedule.brandId,
        scheduleId: schedule.id,
        scheduledFor: new Date(scheduledFor).toISOString(),
        firedAt: new Date(firedAt).toISOString(),
        due: describeInstant(scheduledFor, schedule.timezone),
        channel: schedule.target.channel,
        conversationId: schedule.target.conversationId,
      });
    } catch (error) {
      this.deps.logger.error("event.publish_failed", { brandId: schedule.brandId, publishedEvent: "schedule.fired", ...failureFields(error) });
    }
  }
}

/** One of the server's own events (never a brand event: no server event starts with `brand.`). */
export const isServerEventName = (value: string): value is ServerEventName => (EVENT_NAMES as readonly string[]).includes(value);
/** A well-formed brand event name (`brand.<slug>`); whether the brand defines it is the catalog's answer, not this one. */
export const isBrandEvent = (value: string): value is BrandEventName => isBrandEventName(value);
/** A server event or a well-formed brand event name. */
export const isEventName = (value: string): value is EventName => isServerEventName(value) || isBrandEvent(value);

/** A field name a brand event's payload may carry (the contract's BrandEventPayload keys). */
const BRAND_FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * Checks a subscription filter against the fields its event carries; returns the problem or null. A server event names only its listed fields. A brand
 * event may filter on any well-formed payload field: the brand's detector decides the payload, so a field it never sends simply never matches.
 */
export function validateFilter(event: EventName, filter: EventFilter): string | null {
  if (isBrandEvent(event)) {
    for (const field of Object.keys(filter)) {
      if (!BRAND_FIELD.test(field)) return `filter field "${field}" is not a payload field name (letters, digits and _, starting with a letter)`;
    }
    return null;
  }
  const allowed = FILTER_FIELDS[event];
  for (const field of Object.keys(filter)) {
    if (!allowed.includes(field)) return `filter field "${field}" is not available for ${event}; use: ${allowed.join(", ")}`;
  }
  return null;
}

