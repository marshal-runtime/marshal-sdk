import type { Channel, ConversationKind } from "@zygstinct/shared";

import type { ConversationKey } from "../../store.js";

export const CONTROL_CONVERSATION_ID = "__control__";

export const SCHEDULE_ORIGIN = "system:schedule";
export const EVENT_ORIGIN = "system:event";

/** True for a message the scheduler or the event bus wrote into a conversation (no person typed it). */
export const isSystemPhone = (phone: string): boolean => phone.startsWith("system:");

/** The events the server itself emits to subscriptions. */
export const EVENT_NAMES = ["data.sync.completed", "data.source.ready", "schedule.fired"] as const;
export type ServerEventName = (typeof EVENT_NAMES)[number];
/** An event the brand defined in code (brand-events-contract.ts, BRAND_EVENT_NAME): subscribable while one of its active extensions declares it. */
export type BrandEventName = `brand.${string}`;
export type EventName = ServerEventName | BrandEventName;

/** Payload fields a subscription filter may name, per server event. A brand event's filter may name any well-formed payload field (events.ts validateFilter). */
export const FILTER_FIELDS: Record<ServerEventName, readonly string[]> = {
  // Only the Airflow pipeline sends this event, always with source "airflow" (packages/connectors README), so a source filter could only miss: "shopify" never fires.
  "data.sync.completed": ["tables"],
  // One source's marts were built in BigQuery (Airflow, after dbt and before the Postgres mirror): the wait for "when X lands" is a filter on dataSource.
  "data.source.ready": ["dataSource"],
  "schedule.fired": ["scheduleId"],
};

export type FilterValue = string | number | boolean;
export type EventFilter = Record<string, FilterValue | FilterValue[]>;

/** Where a fire is delivered: the conversation it was created in, or the brand's background conversation. */
export interface Target {
  channel: Channel;
  conversationId: string;
  kind: ConversationKind;
  title: string | null;
}

export const targetKey = (brandId: string, target: Target): ConversationKey => ({ brandId, channel: target.channel, conversationId: target.conversationId });

export interface ScheduleRecord {
  id: string;
  brandId: string;
  kind: "cron" | "at";
  cron: string | null;
  atMs: number | null;
  timezone: string;
  prompt: string;
  target: Target;
  createdByMember: string | null;
  createdAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  fireCount: number;
  /** `paused` is the Routines page's off switch for a chat-made schedule: the scheduler only fires `active` rows. */
  status: "active" | "paused" | "done" | "deleted";
  /** The chain generation it was made at (tasks/chain.ts); its fire starts the next. */
  chainGeneration: number;
  /** `operator` for a message an approved maintainer nudge scheduled (nudges/); every other schedule is `member`. Operator rows are not listed to the member. */
  origin: "member" | "operator";
  /** The nudge an `operator` schedule came from; its fire rereads that nudge and skips when it is no longer applied. */
  nudgeId: string | null;
}

export interface SubscriptionRecord {
  id: string;
  brandId: string;
  event: EventName;
  prompt: string;
  filter: EventFilter;
  target: Target;
  createdByMember: string | null;
  createdAt: number;
  fireCount: number;
  status: "active" | "deleted";
  /** The chain generation it was made at (tasks/chain.ts); its fire starts the next. */
  chainGeneration: number;
  /** A one-shot wait ("tell me when it lands"): the subscription ends in the same transaction as its first fire. */
  once: boolean;
}

/** What a tool call knows about the session it runs for. The brand always comes from here, never from the model. */
export interface ToolContext {
  brandId: string;
  /** The conversation the session works in. */
  key: ConversationKey;
  title: string | null;
  /** The person who is talking, when the conversation is a DM with a known member. */
  memberId: string | null;
  /**
   * The chain generation of the turn or task that makes a schedule or subscription (tasks/chain.ts): absent or 0 for a person's own turn. Recorded on
   * the row; a create at MAX_CONTINUATIONS is refused. Never from the model.
   */
  chainGeneration?: number;
}

export interface ScheduleConfig {
  enabled: boolean;
  tickMs: number;
  /** A missed fire later than this is skipped, not run. */
  lateMs: number;
  maxSchedulesPerBrand: number;
  maxSubscriptionsPerBrand: number;
  /** Cap on turns started by events for one brand per hour (guards against an event loop). */
  maxEventFiresPerHour: number;
  /** An internal event handler that runs longer than this is abandoned (the next handler and the subscriptions go on). */
  handlerTimeoutMs: number;
  /** WhatsApp's customer-service window. */
  replyWindowMs: number;
  /** Port of the event ingest endpoint; null leaves it off. */
  eventsPort: number | null;
  eventsHost: string;
  eventsTokenSecret: string;
}

export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  enabled: true,
  tickMs: 15_000,
  lateMs: 3_600_000,
  maxSchedulesPerBrand: 20,
  maxSubscriptionsPerBrand: 20,
  maxEventFiresPerHour: 120,
  handlerTimeoutMs: 15 * 60_000,
  replyWindowMs: 24 * 3_600_000,
  eventsPort: null,
  eventsHost: "0.0.0.0",
  eventsTokenSecret: "zs-events-token",
};

type Env = Record<string, string | undefined>;

export function loadScheduleConfig(env: Env = process.env): ScheduleConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
    return value;
  };
  const port = env.EVENTS_INGRESS_PORT;
  return {
    ...DEFAULT_SCHEDULE_CONFIG,
    enabled: env.SCHEDULES_ENABLED !== "0",
    tickMs: number("SCHEDULER_TICK_SECONDS", DEFAULT_SCHEDULE_CONFIG.tickMs / 1000) * 1000,
    eventsPort: port === undefined || port === "" ? null : Math.floor(number("EVENTS_INGRESS_PORT", 0)),
    eventsHost: env.EVENTS_INGRESS_HOST || DEFAULT_SCHEDULE_CONFIG.eventsHost,
    eventsTokenSecret: env.SECRET_EVENTS_TOKEN || DEFAULT_SCHEDULE_CONFIG.eventsTokenSecret,
  };
}
