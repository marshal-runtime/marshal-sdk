import type Database from "better-sqlite3";
import type { Automation, AutomationInput, JobRequest } from "@zygstinct/marshal-sdk-port";

import type { Logger } from "../logger.js";
import { failureFields } from "../operation-error.js";
import { ENGINE_ROUTINES, type ExtensionRoutineEngine, type GatedRunRequest, type GatedRunResult, type ServerFire } from "./routine-engine.js";
import { matchesFilter } from "./schedules/event-triggers.js";
import { afterRoutines, eventTriggers, triggerZone, type RoutineTriggers } from "./triggers.js";
import { ROUTINE_EVENTS } from "./routine-events.js";

/** The SDK job every declared schedule and `after` trigger of a server-started routine runs: it asks that routine's gate for the facts and starts the run. */
export const ROUTINE_TRIGGER_JOB = "routine-trigger";
/** The job that re-reads every brand's declared triggers (a new brand, an owner's fork) and fixes the automations to match. */
export const ROUTINE_TRIGGER_RECONCILE_JOB = "routine-trigger-reconcile";
/** The automation label naming the routine a trigger automation starts. */
export const TRIGGER_FOR = "triggerFor";
const SIGNATURE = "triggerSignature";

/** What fired a routine's declared trigger. */
export interface TriggerFire {
  brandId: string;
  routineId: string;
  trigger: "schedule" | "after" | "event";
  at: Date;
  /** For an event trigger: the event's name and its facts (the emitter's input). */
  event?: { name: string; facts: Record<string, unknown> };
}

/**
 * A routine's gate: the server's facts for one fire of the routine's declared trigger (who is due, the run's input, the slot claim) and the start itself
 * (`TriggerDispatcher.start` / `startAwaited`). The gate never decides WHEN: the routine's own file does. It decides only whether this fire has anything to run.
 */
export type TriggerGate = (fire: TriggerFire) => void | Promise<void>;

export interface TriggerDispatcherDeps {
  engine: Pick<ExtensionRoutineEngine, "automations" | "fire" | "runGated">;
  /**
   * The brand's own routines (an approved `@brand/<slug>` package bound to a routine id that is not a release routine) with the triggers their routine file
   * declares. Absent: only the release routines are dispatched.
   */
  brandRoutines?(brandId: string): Promise<{ routineId: string; triggers: RoutineTriggers }[]>;
  /** Starts a brand-made routine whose declared trigger fired, with the trigger's facts as its input (the server picks its home). Returns the run's session id. */
  startBrand?(brandId: string, routineId: string, input: Record<string, unknown>): Promise<string>;
  /** The triggers the brand's resolved package declares for the routine (its fork, else the release package); null when the routine is off for the brand. */
  resolve(brandId: string, routineId: string): Promise<RoutineTriggers | null>;
  /** Every brand the server knows (each gate filters its own). */
  brands(): string[];
  /** The brand's own zone (BRAND_TIMEZONES); a "brand" clock without one runs in UTC. */
  zoneOf(brandId: string): string | undefined;
  database: Database.Database;
  logger: Logger;
  now?: () => number;
}

/** The routines whose start is the server's (no routine record): their declared triggers are run here. Record routines (Meta analysis, owner reports) keep the record's schedule. */
export const DISPATCHED_ROUTINES: readonly string[] = Object.entries(ENGINE_ROUTINES).filter(([, entry]) => entry.server === true).map(([routineId]) => routineId);

type Wanted = { routineId: string; signature: string; input: AutomationInput };

/**
 * The one trigger dispatcher (Omer R148, R26.3). Every server-started routine's start conditions come from its extension package's `routines/<agent>.yaml`:
 * - `schedules`: per-brand SDK job automations at that cron in the brand's zone; a fire asks the routine's gate for its facts and the gate starts the run.
 * - `events`: the server only emits facts on this bus (`emit`, `request` for an awaited run); every routine of the brand that declares the event is started with them.
 * - `after`: an SDK `after` automation following the named routine of the brand; it fires when that run finished well (the SDK's own chain) and asks the gate.
 * A brand's fork that changes or drops a trigger changes what fires for that brand only, at the next reconcile.
 */
export class TriggerDispatcher {
  private readonly gates = new Map<string, TriggerGate>();
  /** Routines whose declared events go to their gate too (`setGate(..., {events: true})`); every other event routine is started bare by `emit`. */
  private readonly eventGated = new Set<string>();
  /** The triggers each brand's routines declared at their latest reconcile: what `armed` reads synchronously. */
  private readonly declared = new Map<string, RoutineTriggers | null>();
  /** `brand:routine` of every brand-made routine seen at the latest read: its schedule and after fires start it through `startBrand`. */
  private readonly brandDeclared = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TriggerDispatcherDeps) {
    deps.database.exec(`CREATE TABLE IF NOT EXISTS routine_trigger_fires (brand_id TEXT NOT NULL, routine_id TEXT NOT NULL, trigger TEXT NOT NULL, fired_at INTEGER NOT NULL,
      PRIMARY KEY (brand_id, routine_id, trigger))`);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Registers a routine's gate (the server's facts for one fire of its declared schedule or after trigger; with `events`, of its declared events too). */
  setGate(routineId: string, gate: TriggerGate, options: { events?: boolean } = {}): void {
    this.gates.set(routineId, gate);
    if (options.events) this.eventGated.add(routineId); else this.eventGated.delete(routineId);
  }

  /** The SDK job of every trigger automation (engine `jobs[ROUTINE_TRIGGER_JOB]`). */
  async onJob(request: JobRequest): Promise<void> {
    const routineId = request.automation.labels?.[TRIGGER_FOR];
    const brandId = request.tenant ?? request.automation.tenant;
    if (!routineId || !brandId) return;
    const trigger = request.trigger === "after" ? "after" : "schedule";
    if (trigger === "after") {
      this.deps.database.prepare("INSERT INTO routine_trigger_fires (brand_id, routine_id, trigger, fired_at) VALUES (?,?,?,?) ON CONFLICT(brand_id, routine_id, trigger) DO UPDATE SET fired_at=excluded.fired_at")
        .run(brandId, routineId, trigger, request.at.getTime());
    }
    const gate = this.gates.get(routineId) ?? (this.isBrand(brandId, routineId) && this.deps.startBrand ? this.brandGate() : undefined);
    this.deps.logger.info("routine_trigger.fired", { brandId, routineId, trigger, gate: gate ? "yes" : "none" });
    if (!gate) return;
    try {
      await gate({ brandId, routineId, trigger, at: request.at });
    } catch (error) {
      this.deps.logger.warn("routine_trigger.gate_failed", { brandId, routineId, trigger, ...failureFields(error) });
    }
  }

  /**
   * Whether the routine's declared `after` trigger fired for the brand at or after `sinceMs` (the brief-send's day). A routine that declares no `after` is not held by
   * one (true); a routine that is off for the brand is never armed. A brand not reconciled yet answers from a fresh read on the next reconcile; until then, true.
   */
  armed(brandId: string, routineId: string, sinceMs: number): boolean {
    const key = `${brandId}:${routineId}`;
    if (!this.declared.has(key)) return true;
    const triggers = this.declared.get(key);
    if (!triggers) return false;
    if (!triggers.after) return true;
    const row = this.deps.database.prepare("SELECT fired_at FROM routine_trigger_fires WHERE brand_id=? AND routine_id=? AND trigger='after'").get(brandId, routineId) as { fired_at: number } | undefined;
    return row !== undefined && row.fired_at >= sinceMs;
  }

  /** A brand-made routine's gate: its schedule or after trigger fired, so it starts with the trigger's facts. */
  private brandGate(): TriggerGate {
    return async (fire) => {
      await this.deps.startBrand!(fire.brandId, fire.routineId, { trigger: fire.trigger, at: fire.at.toISOString() });
    };
  }

  private isBrand(brandId: string, routineId: string): boolean {
    return this.brandDeclared.has(`${brandId}:${routineId}`);
  }

  /**
   * An event happened for a brand (the server's only part): every routine of the brand whose package declares it (its payload filter matching `fire.input`)
   * starts with these facts. Returns the started runs' session ids (empty: nothing of the brand subscribes). A start that fails is logged and the others still start.
   */
  async emit(event: string, brandId: string, fire: ServerFire = {}): Promise<string[]> {
    const started: string[] = [];
    let failure: unknown = null;
    for (const { routineId, brand } of await this.subscribers(event, brandId, fire.input ?? {})) {
      // A server routine with a gate (free time's watch) is asked like a schedule fire: the gate decides whether anything runs and starts it itself. It
      // runs in the background, so the emitter never waits for a gated run, and it is not counted as a started session here.
      const gate = brand || !this.eventGated.has(routineId) ? undefined : this.gates.get(routineId);
      if (gate) {
        this.deps.logger.info("routine_trigger.fired", { brandId, routineId, trigger: "event", event, gate: "yes" });
        void Promise.resolve().then(() => gate({ brandId, routineId, trigger: "event", at: new Date(this.now()), event: { name: event, facts: fire.input ?? {} } }))
          .catch((error: unknown) => this.deps.logger.warn("routine_trigger.gate_failed", { brandId, routineId, trigger: "event", event, ...failureFields(error) }));
        continue;
      }
      try {
        started.push(brand ? await this.deps.startBrand!(brandId, routineId, { trigger: "event", event, ...(fire.input ?? {}) }) : await this.deps.engine.fire(brandId, routineId, fire));
      } catch (error) {
        failure = error;
        this.deps.logger.warn("routine_trigger.event_start_failed", { brandId, routineId, event, ...failureFields(error) });
      }
    }
    this.deps.logger.info("routine_trigger.event", { brandId, event, started: started.length });
    // Every subscriber refused: the emitter's claim is given back as for a refused start (nothing ran).
    if (started.length === 0 && failure !== null) throw failure;
    return started;
  }

  /**
   * A brand event (brand-events.ts) happened: every routine of the brand that lists it in `triggers.events` (its `match` filter on the payload) starts with
   * {event, eventId, ...payload}. Returns the number of runs started; a failed start is logged, never thrown (the detector's event stays recorded).
   */
  async emitBrandEvent(brandId: string, event: string, eventId: string, payload: Record<string, unknown>): Promise<number> {
    try {
      return (await this.emit(event, brandId, { input: { ...payload, event, eventId } })).length;
    } catch (error) {
      this.deps.logger.warn("routine_trigger.brand_event_failed", { brandId, event, eventId, ...failureFields(error) });
      return 0;
    }
  }

  /** An event whose emitter waits for the run's answer (none today): the brand's one subscribing routine runs it awaited. Null when nothing of the brand subscribes. */
  async request(event: string, request: GatedRunRequest): Promise<GatedRunResult | null> {
    const [routineId] = (await this.subscribers(event, request.brandId, request.input ?? {})).filter((subscriber) => !subscriber.brand).map((subscriber) => subscriber.routineId);
    if (!routineId) {
      this.deps.logger.info("routine_trigger.event", { brandId: request.brandId, event, started: 0 });
      return null;
    }
    this.deps.logger.info("routine_trigger.event", { brandId: request.brandId, event, routineId, started: 1 });
    return this.deps.engine.runGated(routineId, request);
  }

  /** A gate's start of a routine whose declared trigger fired (fire-and-forget; the outcome goes through the engine's onOutcome). */
  start(routineId: string, brandId: string, fire: ServerFire = {}): Promise<string> {
    return this.deps.engine.fire(brandId, routineId, fire);
  }

  /** A gate's awaited start (free time, the dream, the store check). */
  startAwaited(routineId: string, request: GatedRunRequest): Promise<GatedRunResult> {
    return this.deps.engine.runGated(routineId, request);
  }

  private async subscribers(event: string, brandId: string, payload: Record<string, unknown>): Promise<{ routineId: string; brand: boolean }[]> {
    const listens = (triggers: RoutineTriggers | null | undefined): boolean => eventTriggers(triggers ?? {}).some((entry) => entry.event === event && matchesFilter(event, entry.match, payload));
    const routines: { routineId: string; brand: boolean }[] = [];
    for (const routineId of DISPATCHED_ROUTINES) {
      if (listens(await this.read(brandId, routineId))) routines.push({ routineId, brand: false });
    }
    // A server event only its own routine may answer (brandRoutines false) never starts a brand's routine.
    if (ROUTINE_EVENTS.find((spec) => spec.event === event)?.brandRoutines === false) return routines;
    for (const { routineId, triggers } of await this.readBrand(brandId)) {
      if (listens(triggers)) routines.push({ routineId, brand: true });
    }
    return routines;
  }

  /** The brand's own routines and their declared triggers (none when the server gives no brand routines or they cannot be read). */
  private async readBrand(brandId: string): Promise<{ routineId: string; triggers: RoutineTriggers }[]> {
    if (!this.deps.brandRoutines || !this.deps.startBrand) return [];
    const routines = await this.deps.brandRoutines(brandId).catch((error: unknown) => {
      this.deps.logger.warn("routine_trigger.brand_routines_failed", { brandId, ...failureFields(error) });
      return [];
    });
    for (const key of [...this.brandDeclared]) if (key.startsWith(`${brandId}:`)) this.brandDeclared.delete(key);
    for (const { routineId } of routines) this.brandDeclared.add(`${brandId}:${routineId}`);
    return routines;
  }

  private async read(brandId: string, routineId: string): Promise<RoutineTriggers | null> {
    const triggers = await this.deps.resolve(brandId, routineId);
    this.declared.set(`${brandId}:${routineId}`, triggers);
    return triggers;
  }

  /** Re-reads every brand's declared triggers and makes the SDK automations match (serialized; a brand that cannot be read keeps what it had). */
  reconcile(brandIds: readonly string[] = this.deps.brands()): Promise<void> {
    const run = this.chain.then(async () => {
      for (const brandId of new Set(brandIds)) {
        await this.reconcileBrand(brandId).catch((error: unknown) => this.deps.logger.warn("routine_trigger.reconcile_failed", { brandId, ...failureFields(error) }));
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async reconcileBrand(brandId: string): Promise<void> {
    const wanted: Wanted[] = [];
    const routines: { routineId: string; triggers: RoutineTriggers | null }[] = [];
    for (const routineId of DISPATCHED_ROUTINES) routines.push({ routineId, triggers: await this.read(brandId, routineId) });
    routines.push(...(await this.readBrand(brandId)));
    for (const { routineId, triggers } of routines) {
      if (!triggers) continue;
      const timezone = triggerZone(triggers, this.deps.zoneOf(brandId));
      const base = { name: `${routineId} trigger`, description: `Starts ${routineId} when its package's routine file says (${ROUTINE_TRIGGER_JOB})`, tenant: brandId, job: { id: ROUTINE_TRIGGER_JOB, input: { routineId } } };
      for (const schedule of triggers.schedules ?? []) {
        const signature = JSON.stringify([routineId, "schedule", schedule, timezone]);
        wanted.push({ routineId, signature, input: { ...base, labels: { [TRIGGER_FOR]: routineId, [SIGNATURE]: signature }, schedule, timezone } });
      }
      if (triggers.after) {
        const { notBefore, within, mode } = triggers.after;
        const after = { routine: afterRoutines(triggers), ...(mode ? { mode } : {}), ...(notBefore ? { notBefore } : {}), ...(within ? { within } : {}), timezone };
        const signature = JSON.stringify([routineId, "after", after]);
        wanted.push({ routineId, signature, input: { ...base, labels: { [TRIGGER_FOR]: routineId, [SIGNATURE]: signature }, triggerType: "after", after } });
      }
    }
    const existing = this.deps.engine.automations.list(brandId).filter((automation: Automation) => automation.job?.id === ROUTINE_TRIGGER_JOB);
    const keep = new Set(wanted.map((entry) => entry.signature));
    for (const automation of existing) {
      if (!keep.has(automation.labels?.[SIGNATURE] ?? "")) {
        await this.deps.engine.automations.delete(automation.id);
        this.deps.logger.info("routine_trigger.removed", { brandId, routineId: automation.labels?.[TRIGGER_FOR] ?? null });
      }
    }
    const have = new Set(existing.map((automation) => automation.labels?.[SIGNATURE]));
    for (const entry of wanted) {
      if (have.has(entry.signature)) continue;
      const created = await this.deps.engine.automations.create(entry.input, "routine-trigger");
      this.deps.logger.info("routine_trigger.registered", { brandId, routineId: entry.routineId, automation: created.id, trigger: entry.input.triggerType ?? "schedule" });
    }
  }
}
