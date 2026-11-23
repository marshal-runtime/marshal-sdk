import { z } from "zod";

import { fail, ok, type DataToolSpec } from "../../data-tools.js";
import type { Logger } from "../../logger.js";
import { failureFields } from "../../operation-error.js";
import { BRAND_EVENT_NAME, isBrandEventName, type BrandEventCatalog, type BrandEventDef } from "../brand-events-contract.js";
import { CronError, nextFire, parseCron } from "./cron.js";
import { isEventName, validateFilter } from "./events.js";
import type { ScheduleRepo } from "./repo.js";
import { CONTROL_CONVERSATION_ID, EVENT_NAMES, FILTER_FIELDS, type EventFilter, type ScheduleConfig, type ScheduleRecord, type SubscriptionRecord, type Target, type ToolContext } from "./types.js";
import { describeInstant, instantOfNaive, isValidTimeZone } from "./zone.js";

/** A tool the tools API serves to the VM: `capability` is the runtime capability id the extension registers. */
export type ScheduleToolSpec = DataToolSpec & { capability: string };

/**
 * The brand's own events as the subscription side sees them: a fresh read of the catalog (`refresh`), and the last read kept per brand (`known`) for the
 * synchronous intent reducer and the turn snapshot. Without a catalog, or when a read fails, the brand defines nothing new (a failed read keeps the last one).
 */
export class BrandEventDirectory {
  private catalog: BrandEventCatalog | null = null;
  private readonly last = new Map<string, BrandEventDef[]>();

  constructor(private readonly logger?: Logger) {}

  setCatalog(catalog: BrandEventCatalog | null): void {
    this.catalog = catalog;
    this.last.clear();
  }

  /** Reads the brand's defined events now (only well-formed `brand.<slug>` names) and keeps them as the brand's last read. */
  async refresh(brandId: string): Promise<BrandEventDef[]> {
    if (!this.catalog) return [];
    try {
      const defs = (await this.catalog.list(brandId)).filter((def) => BRAND_EVENT_NAME.test(def.id));
      this.last.set(brandId, defs);
      return defs;
    } catch (error) {
      this.logger?.warn("brand_events.catalog_read_failed", { brandId, ...failureFields(error) });
      return this.known(brandId);
    }
  }

  /** The brand's events from its last read (none before the first). */
  known(brandId: string): BrandEventDef[] {
    return this.last.get(brandId) ?? [];
  }

  /** Whether the brand defined the event at its last read. */
  defines(brandId: string, event: string): boolean {
    return isBrandEventName(event) && this.known(brandId).some((def) => def.id === event);
  }
}

/** What zs.events.list answers: this conversation's subscriptions, and the events the brand defined that a subscription may name. */
/** A filter's identity regardless of key order or of the order of a list's values. */
export function filterKey(filter: EventFilter): string {
  return JSON.stringify(Object.keys(filter).sort().map((key) => {
    const value = (filter as Record<string, unknown>)[key];
    return [key, Array.isArray(value) ? [...value].map(String).sort() : value];
  }));
}

export function eventsListValue(repo: ScheduleRepo, context: ToolContext, brandEvents: readonly BrandEventDef[]): Record<string, unknown> {
  const own = (target: { channel: string; conversationId: string }) => target.channel === context.key.channel && target.conversationId === context.key.conversationId;
  return {
    subscriptions: repo.listSubscriptions(context.brandId).filter((sub) => own(sub.target)).map((sub) => ({ id: sub.id, event: sub.event, filter: sub.filter, prompt: sub.prompt, fireCount: sub.fireCount })),
    brandEvents: brandEvents.map((def) => ({ id: def.id, description: def.description, fields: def.fields, extensionId: def.extensionId })),
  };
}

export interface ScheduleToolDeps {
  repo: ScheduleRepo;
  config: ScheduleConfig;
  now: () => number;
  /** The brand's own events; absent, a brand event is unknown. */
  brandEvents?: BrandEventDirectory;
}

/** A job always belongs to the conversation of the session that creates it. No tool input names another one. */
const conversationOf = (context: ToolContext): Target => ({ channel: context.key.channel, conversationId: context.key.conversationId, kind: "dm", title: context.title });

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/;
const OFFSET = /^(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** Parses an ISO 8601 time. Without an offset it reads as local time in `timeZone`. Returns null when it is not a valid time. */
export function parseAt(value: string, timeZone: string): number | null {
  const text = value.trim();
  const parts = LOCAL_TIME.exec(text);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map((p) => Number(p ?? 0)) as [number, number, number, number, number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(naive);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const rest = text.slice(parts[0].length);
  if (rest === "") return instantOfNaive(naive, timeZone);
  if (!OFFSET.test(rest)) return null;
  if (/^z$/i.test(rest)) return naive;
  const digits = rest.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0);
  return naive - (rest.startsWith("-") ? -minutes : minutes) * 60_000;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const FilterValue = z.union([z.string().max(128), z.number(), z.boolean()]);
const FilterShape = z.record(z.string(), z.union([FilterValue, z.array(FilterValue).max(50)])).optional();

/** The six tools for one session. The brand and the conversation come from `context`; no argument names either. */
export function scheduleToolSpecs(deps: ScheduleToolDeps, context: ToolContext): ScheduleToolSpec[] {
  const { repo, config } = deps;
  const brandId = context.brandId;
  const isControl = context.key.conversationId === CONTROL_CONVERSATION_ID;
  const NO_CONTROL = "the brand control session cannot schedule or subscribe: a job belongs to the conversation that creates it, and the control session has none";
  /** A session sees and changes only the jobs of its own conversation. */
  const visible = (job: ScheduleRecord | SubscriptionRecord): boolean => job.target.channel === context.key.channel && job.target.conversationId === context.key.conversationId;

  return [
    {
      name: "schedule_create",
      capability: "zs.schedule.create",
      scope: "session",
      description: `Schedule a future wakeup for yourself. Give exactly one of "cron" (five fields: minute hour day-of-month month day-of-week; never more often than every 15 minutes) or "at" (ISO 8601 time; without an offset it is read in "timezone"). "timezone" is an IANA name such as "Asia/Jerusalem" (the zone of the clock the person's time was given on: normally the speaker's own, not the shop's); daylight saving is handled. Use the exact minute asked; keep the requested metric verbatim in "prompt". When it fires, you get a turn in this conversation with "prompt" as a system message, and your final reply goes to this conversation. A brand may have at most ${config.maxSchedulesPerBrand} active schedules. Returns {id, nextRunAt, nextRunLocal, timezone, howToStop}: tell the person the local time with its zone and the howToStop line.`,
      shape: {
        cron: z.string().min(1).max(120).optional(),
        at: z.string().min(1).max(40).optional(),
        timezone: z.string().min(1).max(64),
        prompt: z.string().min(1).max(2000).describe("What you will be told when it fires. Write it so you can act on it without this conversation."),
      },
      async handler(args) {
        if (isControl) return fail(NO_CONTROL);
        const { cron, at, timezone, prompt } = args as { cron?: string; at?: string; timezone: string; prompt: string };
        if ((cron === undefined) === (at === undefined)) return fail('give exactly one of "cron" or "at"');
        if (!isValidTimeZone(timezone)) return fail(`unknown timezone "${timezone}"; use an IANA name such as Europe/London`);
        const now = deps.now();
        let nextRunAt: number | null;
        try {
          if (cron !== undefined) {
            nextRunAt = nextFire(parseCron(cron), now, timezone);
            if (nextRunAt === null) return fail("this cron expression never fires");
          } else {
            nextRunAt = parseAt(at!, timezone);
            if (nextRunAt === null) return fail('"at" must be an ISO 8601 time such as 2026-11-03T09:00:00+02:00 or 2026-11-03T09:00:00');
            if (nextRunAt <= now) return fail(`"at" is in the past (it is ${describeInstant(now, timezone)} now)`);
          }
        } catch (error) {
          if (error instanceof CronError) return fail(error.message);
          throw error;
        }
        const target = conversationOf(context);
        const created = repo.transaction(() => {
          if (repo.activeScheduleCount(brandId) >= config.maxSchedulesPerBrand) return null;
          return repo.insertSchedule({
            brandId,
            kind: cron !== undefined ? "cron" : "at",
            cron: cron?.trim() ?? null,
            atMs: cron === undefined ? nextRunAt : null,
            timezone,
            prompt,
            target,
            createdByMember: context.memberId,
            createdAt: now,
            nextRunAt,
          });
        });
        if (!created) return fail(`this brand already has ${config.maxSchedulesPerBrand} active schedules; delete one first`);
        return ok({ id: created.id, nextRunAt: iso(nextRunAt), nextRunLocal: describeInstant(nextRunAt!, timezone), timezone,
          howToStop: `Tell the person: to stop this, say so in this chat and you will delete schedule ${created.id} (zs.schedule.delete).` });
      },
    },
    {
      name: "schedule_list",
      capability: "zs.schedule.list",
      scope: "session",
      description: "List the active schedules of this conversation: id, cron or one-time at, timezone, prompt, next run and how often it has fired.",
      shape: {},
      async handler() {
        if (isControl) return fail(NO_CONTROL);
        return ok(
          repo.listSchedules(brandId).filter(visible).filter((job) => job.origin !== "operator").map((job) => ({
            id: job.id,
            kind: job.kind,
            cron: job.cron,
            at: job.kind === "at" ? iso(job.atMs) : null,
            timezone: job.timezone,
            prompt: job.prompt,
            nextRunAt: iso(job.nextRunAt),
            lastRunAt: iso(job.lastRunAt),
            fireCount: job.fireCount,
          })),
        );
      },
    },
    {
      name: "schedule_delete",
      capability: "zs.schedule.delete",
      scope: "session",
      description: "Delete one of this conversation's schedules by id.",
      shape: { id: z.string().min(1).max(64) },
      async handler({ id }) {
        if (isControl) return fail(NO_CONTROL);
        const job = repo.getSchedule(brandId, String(id));
        return job && visible(job) && repo.deleteSchedule(brandId, job.id) ? ok({ deleted: String(id) }) : fail("no active schedule with that id in this conversation");
      },
    },
    {
      name: "events_subscribe",
      capability: "zs.events.subscribe",
      scope: "session",
      description: `Get a turn whenever an event happens for this brand. Events: ${EVENT_NAMES.map((e) => `${e} (filter fields: ${FILTER_FIELDS[e].join(", ")})`).join("; ")}; and the brand's own events, brand.<slug>, that its extensions define (zs.events.list shows them; filter on any of their payload fields). "filter" keeps only events whose fields equal the given values (a list matches any of its values). The prompt arrives as a system message in this conversation, and your final reply goes here. "once": true ends it with its first fire (a wait for one thing to happen, such as a source's data landing). A brand may have at most ${config.maxSubscriptionsPerBrand} active subscriptions. Returns {id}.`,
      shape: {
        event: z.union([z.enum(EVENT_NAMES), z.string().regex(BRAND_EVENT_NAME)]),
        prompt: z.string().min(1).max(2000),
        filter: FilterShape,
        once: z.boolean().optional(),
      },
      async handler(args) {
        if (isControl) return fail(NO_CONTROL);
        const { event, prompt, filter, once } = args as { event: string; prompt: string; filter?: EventFilter; once?: boolean };
        if (!isEventName(event)) return fail(`unknown event "${event}"`);
        if (isBrandEventName(event) && !(await deps.brandEvents?.refresh(brandId))?.some((def) => def.id === event)) return fail(`this brand defines no event "${event}"; zs.events.list shows the ones it has`);
        const problem = validateFilter(event, filter ?? {});
        if (problem) return fail(problem);
        const target = conversationOf(context);
        // One wait per thing in a conversation (2026-11-23, R2 sims: the front and then its worker each subscribed to the same data.source.ready filter, and each
        // fired its own turn). An identical active subscription of this conversation is returned, not doubled; the model decides whether its prompt covers the job.
        // Inside the insert's transaction, since the front and its worker can call at the same moment.
        const made = repo.transaction(() => {
          const same = repo.listSubscriptions(brandId).find((sub) => visible(sub) && sub.event === event && sub.once === (once === true) && filterKey(sub.filter) === filterKey(filter ?? {}));
          if (same) return { same };
          if (repo.activeSubscriptionCount(brandId) >= config.maxSubscriptionsPerBrand) return null;
          return { created: repo.insertSubscription({ brandId, event, prompt, filter: filter ?? {}, target, createdByMember: context.memberId, createdAt: deps.now(), once: once === true }) };
        });
        if (!made) return fail(`this brand already has ${config.maxSubscriptionsPerBrand} active subscriptions; unsubscribe one first`);
        if (made.same) return ok({ id: made.same.id, event, filter: made.same.filter, once: made.same.once, alreadySubscribed: true, prompt: made.same.prompt, note: "This conversation already waits on this event with this filter; nothing new was created. If its prompt misses the job you meant, zs.events.unsubscribe it and subscribe once with both jobs in one prompt." });
        const created = made.created!;
        return ok({ id: created.id, event, filter: created.filter, once: created.once });
      },
    },
    {
      name: "events_list",
      capability: "zs.events.list",
      scope: "session",
      description: "List this conversation's active event subscriptions ({subscriptions}) and the events this brand defined itself ({brandEvents}: brand.<slug> with its payload fields), which you can subscribe to.",
      shape: {},
      async handler() {
        if (isControl) return fail(NO_CONTROL);
        return ok(eventsListValue(repo, context, (await deps.brandEvents?.refresh(brandId)) ?? []));
      },
    },
    {
      name: "events_unsubscribe",
      capability: "zs.events.unsubscribe",
      scope: "session",
      description: "Remove one of this conversation's event subscriptions by id.",
      shape: { id: z.string().min(1).max(64) },
      async handler({ id }) {
        if (isControl) return fail(NO_CONTROL);
        const sub = repo.getSubscription(brandId, String(id));
        return sub && visible(sub) && repo.deleteSubscription(brandId, sub.id) ? ok({ unsubscribed: String(id) }) : fail("no active subscription with that id in this conversation");
      },
    },
  ];
}
