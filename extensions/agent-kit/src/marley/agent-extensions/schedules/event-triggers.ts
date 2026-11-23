import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FileSessionStore,
  HostAutomations,
  type Automation,
  type ClaudeAgentPort,
  type AutomationStore,
  type FireDecision,
  type FireRequest,
} from "@zygstinct/marshal-sdk-port";

import type { Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import type { ConversationKey, Store } from "../../store.js";
import { isBrandEventName } from "../brand-events-contract.js";
import { eventText, storeSystemMessage } from "./deliver.js";
import type { ScheduleRepo } from "./repo.js";
import { EVENT_ORIGIN, FILTER_FIELDS, targetKey, type EventFilter, type EventName, type FilterValue, type ScheduleConfig, type SubscriptionRecord } from "./types.js";

/** The label that marks a HostAutomations entry as an event subscription of the server (its fire is a system message into a conversation, never an agent run). */
export const EVENT_SUBSCRIPTION_KIND = "event-subscription";
const LABEL_KIND = "kind";
const LABEL_SUBSCRIPTION = "subscription";

const asArray = (value: FilterValue | FilterValue[] | unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * True when every filter field matches the payload; a list on either side matches when the two lists share a value. A field the event no longer offers as a filter
 * (data.sync.completed's `source`, dropped because Airflow always sends "airflow") is ignored, so a subscription saved before the change is not silently dead.
 */
export function matchesFilter(event: EventName | string, filter: EventFilter, payload: Record<string, unknown>): boolean {
  // A brand event's (or a routine trigger's) filter may name any of its payload fields; only a server event subscription has a fixed list.
  const offered = (FILTER_FIELDS as Record<string, readonly string[] | undefined>)[event];
  return Object.entries(filter).filter(([field]) => isBrandEventName(event) || !offered || offered.includes(field)).every(([field, wanted]) => {
    const have = asArray(payload[field]);
    return asArray(wanted).some((value) => have.includes(value));
  });
}

/** Brand-written text made inert for the event line (PI01): no tag, bracket or line break of its own, so it cannot close the "[Event ...]" header or open a block. */
const inertField = (text: string): string => text.replace(/[<>[\]{}`]/g, " ").replace(/[\r\n\u2028\u2029\u0085]+/g, " ").replace(/\s+/g, " ").trim();
const BRAND_SUMMARY_MAX = 300;

/** A brand event's line: `<event>: field=value, ...` from its payload (the brand's detector wrote it), inert and capped. */
function summarizeBrandEvent(event: string, payload: Record<string, unknown>): string {
  const fields = Object.entries(payload)
    .filter(([field]) => field !== "brandId")
    .map(([field, value]) => `${inertField(field)}=${inertField(Array.isArray(value) ? value.map((item) => String(item)).join("|") : String(value))}`);
  const text = `${event}: ${fields.join(", ") || "no fields"}`;
  return text.length > BRAND_SUMMARY_MAX ? `${text.slice(0, BRAND_SUMMARY_MAX - 3)}...` : text;
}

export function summarize(event: EventName, payload: Record<string, unknown>): string {
  if (isBrandEventName(event)) return summarizeBrandEvent(event, payload);
  if (event === "data.sync.completed") {
    const tables = Array.isArray(payload.tables) && payload.tables.length ? `, tables ${payload.tables.slice(0, 10).join(", ")}${payload.tables.length > 10 ? ", ..." : ""}` : "";
    return `${String(payload.source)} sync finished at ${String(payload.finishedAt)}${tables}`;
  }
  if (event === "data.source.ready") {
    const range = typeof payload.firstDate === "string" && typeof payload.lastDate === "string" ? `, data from ${payload.firstDate} to ${payload.lastDate}` : "";
    return `${inertField(String(payload.dataSource))} data is in the warehouse (built at ${String(payload.finishedAt)}${range})`;
  }
  return `schedule ${String(payload.scheduleId)} fired at ${String(payload.firedAt)}`;
}

/** Automation definitions kept in memory: the subscriptions in the schedules database are the record, the automations follow them. */
class MemoryAutomationStore implements AutomationStore {
  private rows: Automation[] = [];
  load(): Automation[] { return structuredClone(this.rows); }
  save(automations: readonly Automation[]): void { this.rows = structuredClone([...automations]); }
}

export interface EventTriggersDeps {
  repo: ScheduleRepo;
  store: Store;
  config: ScheduleConfig;
  logger: Logger;
  wake(key: ConversationKey): void;
  now?: () => number;
  /** The automations to register on (the server's routine engine shares its own). Without them the triggers keep a private instance, never started, since an event fires only through `emit`. */
  automations?: HostAutomations;
}

/**
 * Event subscriptions as the Marshal SDK's event triggers. Each active subscription is an automation of its brand (tenant) with an `event` trigger, so the SDK
 * keeps the registry, the tenant fence and the match on the event type; an ingested event reaches them through `automations.emit`. The fire is Marley's own
 * delivery: the fire policy (asked once per matching automation, before any session would start) checks the subscription's own filter and target, the hourly
 * cap and the once-per-event record, writes the system message into the conversation, and answers "skip" so the SDK starts no agent. Nothing here runs a model.
 */
export class EventSubscriptionTriggers {
  readonly automations: HostAutomations;
  private chain: Promise<void> = Promise.resolve();
  private emitting: Promise<unknown> = Promise.resolve();
  private current: { brandId: string; event: EventName; eventId: string; payload: Record<string, unknown>; fired: number; woken: Map<string, ConversationKey> } | null = null;

  constructor(private readonly deps: EventTriggersDeps) {
    this.automations = deps.automations ?? this.privateAutomations();
    deps.repo.onSubscriptionChange = (brandId, subscriptionId) => this.changed(brandId, subscriptionId);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private privateAutomations(): HostAutomations {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zs-event-triggers-"));
    const sessions = new FileSessionStore(path.join(root, "sessions"), { runId: "event-triggers", host: { id: "event-triggers", kind: "marley-agent-server" } });
    // Subscriptions keep their clock and filters here and never start an agent: no agent port runs behind them. The automations read their port's host
    // id; a fire that would launch, send or deliver to a session is refused.
    const refuse = (): never => {
      throw new Error("event subscriptions never start an agent");
    };
    const port = { hostId: "event-triggers", launch: refuse, send: refuse, deliver: refuse, get: () => null, cancel: () => undefined } as unknown as ClaudeAgentPort;
    return new HostAutomations({
      root,
      port,
      sessions,
      store: new MemoryAutomationStore(),
      firePolicy: (request) => this.decide(request),
      tenantLabel: "brand",
    });
  }

  /** The policy a host that shares its automations calls first for an event-subscription entry (see `owns`). */
  owns(automation: Automation): boolean {
    return automation.labels?.[LABEL_KIND] === EVENT_SUBSCRIPTION_KIND;
  }

  /** Registers every active subscription and drops automations of subscriptions that ended. */
  async start(): Promise<void> {
    const rows = this.deps.repo.db.prepare("SELECT brand_id, id FROM event_subscriptions WHERE status = 'active'").all() as { brand_id: string; id: string }[];
    const live = new Set(rows.map((row) => row.id));
    for (const automation of this.automations.list()) {
      if (this.owns(automation) && !live.has(automation.labels?.[LABEL_SUBSCRIPTION] ?? "")) await this.automations.delete(automation.id).catch(() => undefined);
    }
    for (const row of rows) await this.sync(row.brand_id, row.id);
  }

  /** Waits until every registration so far has been applied. */
  async idle(): Promise<void> {
    await this.chain;
  }

  private changed(brandId: string, subscriptionId: string): void {
    this.chain = this.chain.then(() => this.sync(brandId, subscriptionId)).catch((error) => this.deps.logger.warn("event_triggers.sync_failed", { brandId, subscriptionId, ...failureFields(error) }));
  }

  private find(subscriptionId: string): Automation | undefined {
    return this.automations.list().find((automation) => this.owns(automation) && automation.labels?.[LABEL_SUBSCRIPTION] === subscriptionId);
  }

  private async sync(brandId: string, subscriptionId: string): Promise<void> {
    const sub = this.deps.repo.getSubscription(brandId, subscriptionId);
    const existing = this.find(subscriptionId);
    if (!sub || sub.status !== "active") {
      if (existing) await this.automations.delete(existing.id);
      return;
    }
    if (existing) return;
    await this.automations.create({
      name: `Event subscription ${sub.id}`,
      description: "A subscription to an event: its fire is a system message into the conversation it was made in.",
      prompt: `Event subscription ${sub.id}`,
      tenant: brandId,
      labels: { [LABEL_KIND]: EVENT_SUBSCRIPTION_KIND, [LABEL_SUBSCRIPTION]: sub.id },
      triggerType: "event",
      event: sub.event,
    }, "event-subscriptions");
  }

  /** The subscriptions an event reaches: schedule.fired reaches only subscriptions of the conversation that owns the schedule. */
  matching(brandId: string, event: EventName, payload: Record<string, unknown>): SubscriptionRecord[] {
    return this.deps.repo
      .subscriptionsFor(brandId, event)
      .filter((sub) => event !== "schedule.fired" || (sub.target.channel === payload.channel && sub.target.conversationId === payload.conversationId))
      .filter((sub) => matchesFilter(event, sub.filter, payload));
  }

  /**
   * Hands one event to the SDK's event triggers (`automations.emit`) and waits until every matching subscription was delivered.
   * Events go one at a time: the policy below reads the event being emitted.
   */
  async deliver(brandId: string, event: EventName, eventId: string, payload: Record<string, unknown>): Promise<{ matched: number; fired: number }> {
    const run = this.emitting.then(async () => {
      await this.chain;
      const matched = this.matching(brandId, event, payload).length;
      const current = { brandId, event, eventId, payload, fired: 0, woken: new Map<string, ConversationKey>() };
      this.current = current;
      try {
        await this.automations.emit(event, payload, brandId);
      } finally {
        this.current = null;
      }
      for (const key of current.woken.values()) this.deps.wake(key);
      return { matched, fired: current.fired };
    });
    this.emitting = run.catch(() => undefined);
    return run;
  }

  /** The fire policy: delivers for an event-subscription entry and answers "skip" (nothing is started); another entry is not asked about here. */
  decide(request: FireRequest): FireDecision {
    const current = this.current;
    const subscriptionId = request.automation.labels?.[LABEL_SUBSCRIPTION];
    if (!this.owns(request.automation) || !current || !subscriptionId) return "skip";
    const { repo, store, config, logger } = this.deps;
    const sub = repo.getSubscription(current.brandId, subscriptionId);
    if (!sub || sub.status !== "active" || sub.event !== current.event) return "skip";
    if (!this.matching(current.brandId, current.event, current.payload).some((candidate) => candidate.id === sub.id)) return "skip";
    const now = this.now();
    repo.transaction(() => {
      if (repo.eventFiresSince(current.brandId, now - 3_600_000) >= config.maxEventFiresPerHour) {
        logger.warn("event.rate_limited", { brandId: current.brandId, event: current.event, subscriptionId: sub.id, limit: config.maxEventFiresPerHour });
        return;
      }
      const messageId = `evt-${sub.id}-${current.eventId}`;
      if (!repo.recordSubscriptionFire(sub.id, current.eventId, current.brandId, now, messageId)) return;
      storeSystemMessage(store, {
        id: messageId,
        brandId: current.brandId,
        target: sub.target,
        origin: EVENT_ORIGIN,
        memberId: sub.createdByMember,
        text: eventText({ subscriptionId: sub.id, event: current.event, summary: summarize(current.event, current.payload), prompt: sub.prompt }),
        now,
      });
      current.woken.set(`${sub.target.channel}|${sub.target.conversationId}`, targetKey(current.brandId, sub.target));
      current.fired += 1;
      // A one-shot wait ends with the fire that answers it, in the same transaction, so a second event can never fire it again.
      if (sub.once) repo.deleteSubscription(current.brandId, sub.id);
    });
    return "skip";
  }
}
